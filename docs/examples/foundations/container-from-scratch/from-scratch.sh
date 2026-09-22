#!/usr/bin/env bash
# Build a "container" by hand: namespaces + cgroup v2 + pivot_root, no runtime.
#
# WHERE THIS RUNS (read README.md first):
#   - a disposable Linux VM or Linux host, as root, with cgroup v2
#   - a disposable privileged container, for example:
#       docker run --rm -it --privileged \
#         -v "$PWD/examples/foundations/container-from-scratch:/work:ro" \
#         debian:trixie-slim bash -c \
#         'apt-get update -qq && apt-get install -y -qq busybox-static >/dev/null && bash /work/from-scratch.sh'
#   It does NOT run in PowerShell, Git Bash or a macOS shell: those are not
#   Linux kernels. On Docker Desktop, use the privileged container above; it
#   runs inside Docker Desktop's Linux VM.
#
# This script runs as root and changes cgroups. Use a throwaway machine.
#
# Environment knobs:
#   ROOTFS_TAR=/path/rootfs.tar  use a tarball made by make-rootfs.sh
#                                (otherwise a static busybox on PATH is used)
#   MEM_LIMIT=32M                memory.max for the demo cgroup
#   PIDS_LIMIT=32                pids.max for the demo cgroup
#   HOLD=1                       keep the container alive (sleep) at the end so
#                                you can inspect it from another shell
set -euo pipefail

SELF=$(readlink -f "$0")
WORKDIR=${WORKDIR:-/tmp/from-scratch}
ROOTFS=$WORKDIR/rootfs
MEM_LIMIT=${MEM_LIMIT:-32M}
PIDS_LIMIT=${PIDS_LIMIT:-32}
HOLD=${HOLD:-0}
CG_ROOT=/sys/fs/cgroup
CG=$CG_ROOT/from-scratch-demo

step() { printf '\n==> %s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Stage 2: runs as PID 1 of the new PID namespace, inside the new mount, UTS,
# IPC, network and cgroup namespaces, but still on the host's filesystem.
# ---------------------------------------------------------------------------
if [ "${1:-}" = "__stage2" ]; then
  ROOTFS=$2
  hostname from-scratch                      # only changes the new UTS namespace
  # pivot_root needs the new root to be a mount point: bind-mount it on itself.
  mount --bind "$ROOTFS" "$ROOTFS"
  mkdir -p "$ROOTFS/.oldroot"
  cd "$ROOTFS"
  pivot_root . .oldroot                      # new root at /, old root at /.oldroot
  cd /
  # From here on only files inside the rootfs exist, plus /.oldroot until
  # demo.sh lazily unmounts it.
  exec /bin/busybox sh /demo.sh
fi

# ---------------------------------------------------------------------------
# Stage 1: preflight, root filesystem, cgroup, then unshare.
# ---------------------------------------------------------------------------
[ "$(uname -s)" = "Linux" ] || die "needs a Linux kernel (see README.md)"
[ "$(id -u)" -eq 0 ]        || die "run as root (inside a disposable VM or privileged container)"
command -v unshare    >/dev/null || die "unshare not found (package util-linux)"
command -v pivot_root >/dev/null || die "pivot_root not found (package util-linux)"
[ "$(stat -fc %T "$CG_ROOT")" = "cgroup2fs" ] \
  || die "$CG_ROOT is not cgroup v2 (stat -fc %T $CG_ROOT should print cgroup2fs)"

step "1. Root filesystem in $ROOTFS"
rm -rf "$WORKDIR"
mkdir -p "$ROOTFS"
if [ -n "${ROOTFS_TAR:-}" ]; then
  echo "unpacking $ROOTFS_TAR"
  tar -C "$ROOTFS" -xf "$ROOTFS_TAR"
else
  BB=$(command -v busybox || true)
  [ -n "$BB" ] || die "no ROOTFS_TAR and no busybox on PATH (apt-get install busybox-static)"
  if ldd "$BB" >/dev/null 2>&1; then
    die "$BB is dynamically linked; install a static busybox (busybox-static)"
  fi
  mkdir -p "$ROOTFS/bin"
  cp "$BB" "$ROOTFS/bin/busybox"
  for applet in $("$ROOTFS/bin/busybox" --list); do
    [ -e "$ROOTFS/bin/$applet" ] || ln -s busybox "$ROOTFS/bin/$applet"
  done
  echo "copied static busybox and created $(ls "$ROOTFS/bin" | wc -l) applet links"
fi
mkdir -p "$ROOTFS"/{proc,sys/fs/cgroup,dev,tmp,etc,root}
echo 'root:x:0:0:root:/root:/bin/sh' > "$ROOTFS/etc/passwd"
echo "rootfs top level: $(ls "$ROOTFS" | tr '\n' ' ')"

# The program that runs inside the container. It only uses busybox applets,
# because after pivot_root nothing from the host is visible.
cat > "$ROOTFS/demo.sh" <<EOF
set -u
mount -t proc proc /proc                 # a procfs for the NEW pid namespace
umount -l /.oldroot && rmdir /.oldroot   # drop the last link to the host fs
mount -t cgroup2 none /sys/fs/cgroup     # shows only our cgroup (cgroup ns)
mount -t tmpfs tmpfs /tmp

echo; echo "--- inside: identity"
echo "hostname: \$(hostname)"
echo "my pid:   \$\$"
echo "processes visible:"; ps -o pid,user,args
echo; echo "--- inside: network namespace (only a loopback, down)"
ip link 2>/dev/null || cat /proc/net/dev
echo; echo "--- inside: namespace handles"
for ns in /proc/self/ns/*; do echo "\$ns -> \$(readlink \$ns)"; done
echo; echo "--- inside: cgroup view"
echo "/proc/self/cgroup: \$(cat /proc/self/cgroup)"
echo "memory.max: \$(cat /sys/fs/cgroup/memory.max)"
echo "pids.max:   \$(cat /sys/fs/cgroup/pids.max)"

echo; echo "--- inside: exceeding pids.max ($PIDS_LIMIT)"
# A child shell tries to start more sleeps than pids.max allows. fork()
# starts failing with EAGAIN; the child shell gives up, PID 1 survives.
sh -c 'i=0; while [ \$i -lt $((PIDS_LIMIT + 8)) ]; do i=\$((i + 1)); sleep 30 & done' 2>&1 | tail -n 1
echo "pids.current: \$(cat /sys/fs/cgroup/pids.current)"
echo "pids.events:  \$(cat /sys/fs/cgroup/pids.events)"
killall sleep 2>/dev/null; sleep 1

echo; echo "--- inside: exceeding memory.max ($MEM_LIMIT)"
# A child shell buffers 64 MiB in a variable. The kernel's OOM killer picks
# the biggest process in the cgroup, which is that child, not PID 1.
sh -c 'x=\$(head -c 67108864 /dev/zero | tr "\\\\000" x); echo "allocated \${#x} bytes"'
echo "child exit status: \$?  (137 = 128 + SIGKILL)"
echo "memory.events:"; cat /sys/fs/cgroup/memory.events

if [ "$HOLD" = "1" ]; then
  echo; echo "HOLD=1: sleeping. From another shell on the same machine run: lsns | grep from-scratch"
  exec sleep 3600
fi
EOF

step "2. cgroup v2: create $CG"
grep -qw memory "$CG_ROOT/cgroup.controllers" || die "memory controller not available in $CG_ROOT"
grep -qw pids   "$CG_ROOT/cgroup.controllers" || die "pids controller not available in $CG_ROOT"
if ! echo "+memory +pids" > "$CG_ROOT/cgroup.subtree_control" 2>/dev/null; then
  # "No internal processes": a non-root cgroup that contains processes cannot
  # hand controllers to children. Inside a container, $CG_ROOT is such a
  # cgroup, so move every process into a leaf first.
  echo "moving existing processes to $CG_ROOT/init (no-internal-process rule)"
  mkdir -p "$CG_ROOT/init"
  for p in $(cat "$CG_ROOT/cgroup.procs"); do
    echo "$p" > "$CG_ROOT/init/cgroup.procs" 2>/dev/null || true
  done
  echo "+memory +pids" > "$CG_ROOT/cgroup.subtree_control"
fi
if [ -d "$CG" ]; then rmdir "$CG"; fi
mkdir "$CG"
echo "$MEM_LIMIT"  > "$CG/memory.max"
if [ -f "$CG/memory.swap.max" ]; then echo 0 > "$CG/memory.swap.max"; fi  # no swapping at the limit
echo "$PIDS_LIMIT" > "$CG/pids.max"
echo "memory.max=$(cat "$CG/memory.max") pids.max=$(cat "$CG/pids.max")"

step "3. unshare: new pid, mount, uts, ipc, net and cgroup namespaces"
# The subshell moves itself into the cgroup, then execs unshare, so every
# process of the "container" is born inside the limits.
set +e
(
  echo "$BASHPID" > "$CG/cgroup.procs"
  exec unshare --pid --fork --mount-proc --uts --net --ipc --mount --cgroup \
    bash "$SELF" __stage2 "$ROOTFS"
)
rc=$?
set -e

step "4. Back on the host"
echo "container exited with status $rc"
echo "host hostname is still: $(hostname)"
echo "memory.events of $CG as seen from outside:"
cat "$CG/memory.events"
rmdir "$CG" && echo "removed $CG"
