#!/bin/sh
# Print the kernel-visible isolation of one process: namespaces, cgroup,
# capabilities, seccomp, LSM label, root mount.
#
# Usage (on a Linux host, as root, or inside a kind node container):
#   ./inspect-process.sh <pid>
#   docker exec -i tasklane-worker sh -s -- <pid> < inspect-process.sh
#
# Everything it reads is a normal file under /proc and /sys/fs/cgroup. There
# is no container API involved: a "container" is just a process whose
# namespace links differ from PID 1's.
set -u
PID=${1:?usage: inspect-process.sh <pid>}
REF=${REF:-1}          # process to compare against (default: PID 1 of this view)

[ -d "/proc/$PID" ] || { echo "no such pid: $PID" >&2; exit 1; }

echo "== process $PID"
tr '\0' ' ' < "/proc/$PID/cmdline"; echo
echo "comm: $(cat "/proc/$PID/comm")"

echo
echo "== namespaces (compared with pid $REF)"
for ns in /proc/"$PID"/ns/*; do
  name=$(basename "$ns")
  mine=$(readlink "$ns" 2>/dev/null) || continue
  theirs=$(readlink "/proc/$REF/ns/$name" 2>/dev/null || echo "-")
  if [ "$mine" = "$theirs" ]; then state="shared with $REF"; else state="OWN"; fi
  printf '%-8s %-20s %s\n' "$name" "$mine" "$state"
done

echo
echo "== pid as seen in each pid namespace (outermost first)"
grep -E '^NSpid|^NSpgid' "/proc/$PID/status"

echo
echo "== cgroup"
cgline=$(cat "/proc/$PID/cgroup")
echo "/proc/$PID/cgroup: $cgline"
cgpath=/sys/fs/cgroup$(echo "$cgline" | head -n 1 | cut -d: -f3)
if [ -d "$cgpath" ]; then
  for f in cpu.max cpu.weight memory.max memory.high memory.current memory.peak \
           pids.max pids.current cpu.pressure memory.pressure; do
    [ -f "$cgpath/$f" ] && printf '%-16s %s\n' "$f" "$(head -n 1 "$cgpath/$f")"
  done
  echo "-- parent cgroup ($(dirname "$cgpath"))"
  for f in cpu.max memory.max pids.max; do
    [ -f "$(dirname "$cgpath")/$f" ] && \
      printf '%-16s %s\n' "$f" "$(head -n 1 "$(dirname "$cgpath")/$f")"
  done
else
  echo "cgroup directory $cgpath not visible from here (different cgroup namespace or mount)"
fi

echo
echo "== capabilities, seccomp, no_new_privs"
grep -E '^Cap(Inh|Prm|Eff|Bnd|Amb)|^NoNewPrivs|^Seccomp' "/proc/$PID/status"
command -v capsh >/dev/null 2>&1 && \
  echo "CapEff decoded: $(capsh --decode="$(awk '/^CapEff/{print $2}' "/proc/$PID/status")")"

echo
echo "== LSM label"
cat "/proc/$PID/attr/current" 2>/dev/null || echo "(no label readable)"
echo

echo "== uid/gid maps (user namespace)"
cat "/proc/$PID/uid_map" 2>/dev/null
cat "/proc/$PID/gid_map" 2>/dev/null

echo
echo "== root mount of this process"
awk '$5 == "/" {print}' "/proc/$PID/mountinfo" | head -n 2
echo "root symlink: $(readlink "/proc/$PID/root" 2>/dev/null || echo '(permission denied)')"
