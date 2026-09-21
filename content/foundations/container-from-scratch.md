---
title: Build a container from scratch
description: Assemble a container by hand with unshare, pivot_root and cgroup v2, then compare it with what runc does.
level: foundations
type: tutorial
status: current
versions: Linux kernel 6.x, util-linux 2.4x, Docker Engine 29, containerd 2.x
prerequisites:
  - foundations/linux-namespaces
  - foundations/cgroups-v2
  - foundations/capabilities
---

## Overview

Everything in Part A comes together here. In about sixty lines of shell you
will create a root filesystem, put a memory and PID limit on a cgroup, unshare
six namespaces, `pivot_root` into the new filesystem, and watch the kernel
enforce the limits. No Docker, no containerd, no runc.

The point is not that you should run containers this way. It is that after
doing it once, `docker run` and a pod spec stop being magic: you will recognise
every field as one of the things you set by hand.

The scripts live in
[`examples/foundations/container-from-scratch/`](../../examples/foundations/container-from-scratch/README.md).

## Where this can run

:::danger Use a disposable machine
The script writes to `/sys/fs/cgroup`, mounts filesystems and calls
`pivot_root`. It needs root and `CAP_SYS_ADMIN`, which is exactly the privilege
level this handbook tells you not to give to real workloads. Run it in a
throwaway Linux VM or a `--rm --privileged` container you delete afterwards,
never on a machine you care about and never on a production node.
:::

| Environment | Works? |
|---|---|
| Disposable Linux VM or cloud instance, as root | yes |
| `docker run --rm --privileged debian:trixie-slim …` on any Docker host, including Docker Desktop | yes — the privileged container runs on the host's (or the Desktop VM's) Linux kernel |
| A kind node container | yes, but it shares a cgroup tree with a live kubelet; prefer the throwaway container |
| WSL 2 distribution as root | usually; confirm `stat -fc %T /sys/fs/cgroup` prints `cgroup2fs` |
| **PowerShell, CMD or Git Bash on Windows** | **no** — no Linux kernel is involved in that shell |
| **A macOS terminal** | **no** — use the privileged container, which runs inside the Docker Desktop VM |

How to get a usable shell, per operating system:

::::tabs
@tab Linux

Run it directly on a disposable VM, or in a container if you would rather not
touch the host's cgroup tree:

```bash
sudo bash examples/foundations/container-from-scratch/from-scratch.sh
```

@tab macOS

There is no Linux kernel in the terminal, so use a privileged container. It
runs inside the Docker Desktop VM:

```bash
docker run --rm -it --privileged \
  -v "$PWD/examples/foundations/container-from-scratch:/work:ro" \
  debian:trixie-slim \
  bash -c 'apt-get update -qq && apt-get install -y -qq busybox-static >/dev/null && bash /work/from-scratch.sh'
```

@tab Windows (WSL 2)

PowerShell and Git Bash cannot run it. Either use the same privileged
container as macOS, from a WSL 2 shell or PowerShell, or run it inside a WSL 2
distribution as root after confirming cgroup v2:

```bash
stat -fc %T /sys/fs/cgroup     # must print cgroup2fs
sudo bash examples/foundations/container-from-scratch/from-scratch.sh
```

::::

The command used for this page's captures, run from the repository root:

```bash
docker run --rm --privileged \
  -v "$PWD/examples/foundations/container-from-scratch:/work:ro" \
  debian:trixie-slim \
  bash -c 'apt-get update -qq && apt-get install -y -qq busybox-static >/dev/null && bash /work/from-scratch.sh'
```

## Step 1: a root filesystem

A container image is, at bottom, a directory tree. There are two honest ways to
get one:

```bash
./make-rootfs.sh                 # docker create + docker export -> rootfs.tar
sudo ROOTFS_TAR=/tmp/from-scratch/rootfs.tar ./from-scratch.sh
```

or let the script build a minimal tree from a **static** busybox binary, which
is what happens when `ROOTFS_TAR` is unset.

`docker export` is deliberate: it flattens a container's filesystem and
**drops the image config**. What you get is `rootfs`, not an image — no
entrypoint, no environment, no user. That gap is exactly what the OCI image
spec fills, and what you are about to fill by hand.

## Step 2: a cgroup with limits

```bash include="examples/foundations/container-from-scratch/from-scratch.sh" lines="132-151"
```

Three things to notice:

- `cgroup.subtree_control` must be written *before* the child cgroup can use
  the controllers. Delegation is top-down.
- If that write fails, it is the **no-internal-processes** rule: a non-root
  cgroup holding processes cannot enable controllers for children. Inside a
  container, `/sys/fs/cgroup` is such a cgroup, so the script moves the
  existing processes into an `init` leaf first — exactly what systemd and the
  kubelet do for the same reason.
- `memory.swap.max = 0` makes the memory demo deterministic. Without it the
  kernel may swap instead of killing.

## Step 3: namespaces

```bash include="examples/foundations/container-from-scratch/from-scratch.sh" lines="153-161"
```

The subshell writes its own PID into `cgroup.procs` *before* `exec`ing
`unshare`, so every process of the container is born inside the limits. Then:

- `--pid --fork` — a new PID namespace. `--fork` is required: the calling
  process cannot change its own PID namespace, only its children can be created
  in the new one. The forked child becomes PID 1 there.
- `--mount` — a new mount namespace, so the mounts that follow are private.
- `--mount-proc` — mounts a fresh `procfs`, so `ps` inside shows only the new
  PID namespace.
- `--uts` — a private hostname.
- `--ipc` — private System V IPC and POSIX message queues.
- `--net` — an empty network stack: loopback only, and it starts down.
- `--cgroup` — the container sees its own cgroup as the root of the hierarchy.

## Step 4: pivot_root

```bash include="examples/foundations/container-from-scratch/from-scratch.sh" lines="42-54"
```

`pivot_root` requires the new root to be a mount point, which is why the script
bind-mounts the directory onto itself. After the call, the old root is
reachable at `/.oldroot`; the payload lazily unmounts it, and from then on the
only files that exist are the ones in the rootfs.

`chroot` would also "work" and is simpler, but it leaves the old root reachable
through the process's cwd and open file descriptors, and escaping a chroot as
root is a known party trick. Real runtimes pivot.

## Step 5: run it and watch the limits bite

```console include="captures/foundations/from-scratch.txt"
```

Read that output against the pages in this part:

- **Identity.** `hostname` is the value set in the new UTS namespace, `$$` is 1
  because the payload is PID 1 in its PID namespace, and `ps` shows only the
  processes in it.
- **Network.** One interface, down. Nothing here plumbed a veth pair; that is
  what a CNI plugin or Docker's bridge driver does.
- **Namespace handles.** The `/proc/self/ns/*` links are the kernel's handles.
  Compare them with the host's to prove isolation.
- **cgroup view.** `/proc/self/cgroup` shows `0::/` because of the cgroup
  namespace, and `/sys/fs/cgroup/memory.max` is the limit that was set from
  outside.
- **PID limit.** Forks fail with `EAGAIN` once `pids.max` is reached;
  `pids.events` counts it.
- **Memory limit.** The allocating child is SIGKILLed by the cgroup OOM
  killer, giving exit status 137, and `memory.events` records `oom_kill`. This
  is precisely what
  [OOMKilled](../troubleshooting/oomkilled.md) means in a pod's status.

## Step 6: look at it from outside

With `HOLD=1` the container sleeps instead of exiting, so you can inspect it
from the host the way you would inspect a real container:

```bash
sudo HOLD=1 ./from-scratch.sh &
lsns
sudo ./inspect-process.sh "$(pgrep -f 'sleep 3600' | head -n 1)"
```

```console include="captures/foundations/from-scratch-lsns.txt"
```

`inspect-process.sh` is the same script this part uses on real Kubernetes
containers: it prints namespace links, the cgroup path and its control files,
the five capability sets, the seccomp mode, the LSM label and the root mount.
Point it at a pod's process and at this demo and the output has the same shape.

## What is still missing

This is a container in the "isolated process" sense, and nothing more. A real
runtime additionally:

| Missing here | Provided by a real runtime |
|---|---|
| Capability bounding set reduction | `process.capabilities` in `config.json` |
| seccomp filter | `linux.seccomp`, compiled to BPF by runc |
| AppArmor/SELinux label | `process.apparmorProfile`, `process.selinuxLabel` |
| Masked and read-only `/proc` paths | `linux.maskedPaths`, `linux.readonlyPaths` |
| Device allowlist | the devices cgroup (eBPF on v2) and `linux.devices` |
| `no_new_privs` | `process.noNewPrivileges` |
| A user namespace | `linux.uidMappings` / `gidMappings` |
| Networking | CNI plugin or the runtime's network driver |
| Image layers | a snapshotter and overlayfs, not a copied directory |
| Lifecycle and supervision | the shim, restart policy, log handling |

That table is the honest summary: **namespaces and cgroups are isolation, not
security.** Everything in the right-hand column is what turns the demo into
something you would let strangers' code run in — and all of it is reachable
from a pod spec.

## Common mistakes

- **Running the script on a machine you care about.** It edits the live cgroup
  tree.
- **Forgetting `--fork` with `--pid`.** Without it the shell stays in the old
  PID namespace and the new one gets an unexpected PID 1.
- **Mounting `/proc` without a new PID namespace**, so the container sees host
  processes. `--mount-proc` exists to make this hard to get wrong.
- **Using `chroot` and calling it isolation.** A privileged process escapes a
  chroot; `pivot_root` plus a private mount namespace is the real mechanism.
- **Expecting resource limits without cgroup v2.** On a cgroup v1 host the
  paths and files in the script do not exist.
- **Concluding that containers are simple.** The demo is simple because it
  leaves out everything that makes containers safe to operate.

## Related topics

- [Linux namespaces](linux-namespaces.md)
- [cgroups v2](cgroups-v2.md)
- [Capabilities](capabilities.md)
- [seccomp](seccomp.md)
- [Overlay filesystems](overlay-filesystems.md)
- [OCI specifications](oci-specifications.md)
- [The container runtime stack](runtime-stack.md)
- [Foundations labs](labs.md)
- [OOMKilled](../troubleshooting/oomkilled.md)
