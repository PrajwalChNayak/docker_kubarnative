# container-from-scratch

Three small scripts that build and inspect a container without a container
runtime. They exist to make one point concrete: a container is a normal Linux
process that the kernel has been asked to isolate and limit.

| File | What it does |
|---|---|
| `make-rootfs.sh` | Flattens an image into a plain tarball with `docker create` + `docker export`. Optional. |
| `from-scratch.sh` | Creates a cgroup v2 group with `memory.max` and `pids.max`, `unshare`s pid/mount/uts/ipc/net/cgroup namespaces, `pivot_root`s into the root filesystem, and runs a demo payload that gets OOM-killed and fork-limited on purpose. |
| `inspect-process.sh` | Given a PID, prints its namespace links, cgroup files, capability sets, seccomp mode, LSM label and root mount. Works on any process, containerised or not. |

## Where these run

`from-scratch.sh` needs a **Linux kernel with cgroup v2**, root privileges, and
`util-linux` (`unshare`, `pivot_root`). It is deliberately destructive about
cgroups and mounts, so run it on something disposable.

| Environment | Works? |
|---|---|
| Disposable Linux VM or cloud instance, as root | Yes |
| `docker run --rm -it --privileged debian:trixie-slim …` (any Docker host, including Docker Desktop) | Yes — the privileged container runs on the host's or the VM's Linux kernel |
| A kind node container (`docker exec -it tasklane-control-plane …`) | Yes, but it shares a cgroup tree with a live kubelet. Prefer the throwaway container. |
| WSL 2 distribution, as root | Usually yes. Check `stat -fc %T /sys/fs/cgroup` prints `cgroup2fs`. |
| **PowerShell, Git Bash or CMD on Windows** | **No.** There is no Linux kernel in that shell. |
| **A macOS terminal** | **No.** Same reason; use the privileged container, which runs in the Docker Desktop VM. |

The one-liner used for the handbook's captures:

```bash
docker run --rm --privileged \
  -v "$PWD/examples/foundations/container-from-scratch:/work:ro" \
  debian:trixie-slim \
  bash -c 'apt-get update -qq && apt-get install -y -qq busybox-static >/dev/null && bash /work/from-scratch.sh'
```

`--privileged` is what makes it possible: the demo needs to mount filesystems,
write to `/sys/fs/cgroup`, and call `pivot_root`, all of which need
`CAP_SYS_ADMIN` in a writable cgroup and mount namespace. That is also exactly
why `--privileged` is dangerous for real workloads.

## Walkthrough

```bash
# 1. optional: a real image's filesystem instead of a bare busybox
./make-rootfs.sh                       # -> /tmp/from-scratch/rootfs.tar

# 2. build and run the container
sudo ROOTFS_TAR=/tmp/from-scratch/rootfs.tar ./from-scratch.sh

# 3. keep it alive and look at it from outside
sudo HOLD=1 ./from-scratch.sh &
lsns                                    # the new namespaces appear here
sudo ./inspect-process.sh "$(pgrep -f 'sleep 3600' | head -n 1)"
```

Knobs: `MEM_LIMIT` (default `32M`), `PIDS_LIMIT` (default `32`), `WORKDIR`
(default `/tmp/from-scratch`), `HOLD=1`, `ROOTFS_TAR`.

## What each step maps to in a real runtime

| Step here | runc / containerd equivalent |
|---|---|
| `make-rootfs.sh` | the snapshotter unpacking layers into an overlayfs upper/lower set |
| `demo.sh` written into the rootfs | `process.args` in the OCI runtime `config.json` |
| `mkdir /sys/fs/cgroup/from-scratch-demo`, `memory.max`, `pids.max` | `linux.resources` in `config.json`, written by runc |
| `unshare --pid --fork --mount --uts --ipc --net --cgroup` | `linux.namespaces` in `config.json`, created by `clone()` in `runc init` |
| `pivot_root` | `root.path` in `config.json`; runc also pivots |
| nothing here | capability sets, seccomp filter, AppArmor/SELinux label, masked paths, read-only paths, devices cgroup — a real runtime applies all of these |

That last row is the honest summary of this example: it demonstrates the
isolation primitives, not a secure sandbox.

## Cleanup

`from-scratch.sh` removes its cgroup on a clean exit and recreates `$WORKDIR`
from nothing on the next run. If it dies halfway, run
`rmdir /sys/fs/cgroup/from-scratch-demo` and `rm -rf /tmp/from-scratch`
in the disposable machine, or just throw the container away.
