---
title: Linux namespaces
description: The eight namespace types, the syscalls that create and join them, and how to see them on a running node.
level: foundations
type: concept
status: current
versions: Linux kernel 6.x, Docker Engine 29, containerd 2.x, Kubernetes 1.37
prerequisites:
  - foundations/what-containers-solve
---

## Overview

A namespace takes one global kernel resource and gives the processes inside it
their own private instance of it, while the rest of the system keeps the
original. There are eight types, each isolating one kind of resource, each
created with a `CLONE_NEW*` flag, and each visible as a symbolic link under
`/proc/<pid>/ns/`.

Containers are not built from namespaces alone — limits come from
[cgroups](cgroups-v2.md) and privilege reduction from
[capabilities](capabilities.md), [seccomp](seccomp.md) and
[LSMs](apparmor-and-selinux.md) — but namespaces are what makes a process
*look* like it has a machine to itself.

## Why it exists and when to use it

Namespaces exist because the alternatives were worse. Isolating workloads by
running separate machines is expensive; isolating them with permissions alone
does not work, because many global resources (the PID space, the hostname, the
routing table) have no per-process permission model at all. Namespaces make
those resources per-process state instead.

You use them directly more often than you expect: debugging a container with
`nsenter`, running a network test in a pod's network namespace, or
understanding why `hostPID: true` is a red flag in a manifest.

## How it works underneath

### The eight types

| Namespace | Flag | Isolates | Available since |
|---|---|---|---|
| Mount | `CLONE_NEWNS` | mount points, the filesystem tree | Linux 2.4.19 |
| UTS | `CLONE_NEWUTS` | hostname and NIS domain name | Linux 2.6.19 |
| IPC | `CLONE_NEWIPC` | System V IPC objects, POSIX message queues | Linux 2.6.19 |
| PID | `CLONE_NEWPID` | process ID number space | Linux 2.6.24 |
| Network | `CLONE_NEWNET` | network devices, stacks, ports, routing, netfilter | Linux 2.6.24 to 2.6.29 |
| User | `CLONE_NEWUSER` | user and group IDs, and therefore capabilities | Linux 3.8 |
| Cgroup | `CLONE_NEWCGROUP` | the cgroup root directory a process sees | Linux 4.6 |
| Time | `CLONE_NEWTIME` | boot and monotonic clocks | Linux 5.6 |

**Mount.** A copy of the mount table. New mounts and unmounts are private,
subject to *propagation* settings (`private`, `shared`, `slave`). A container
runtime creates this namespace, mounts the image's overlay, mounts `/proc`,
`/sys`, `/dev`, the volumes and the Secrets, then `pivot_root`s into the new
tree.

**UTS.** Holds the hostname, which is why a container's hostname can be the
pod name while the node's hostname stays the node's.

**IPC.** Separates System V semaphores, shared memory segments and POSIX
message queues. Two pods cannot accidentally collide on an IPC key. Sharing it
(`hostIPC: true`, or `shareProcessNamespace` siblings) is how processes in one
pod can use shared memory.

**PID.** Gives a fresh PID number space. The first process created becomes PID
1 *inside* it, and inherits PID 1's duties: reaping orphans, and the kernel's
refusal to deliver unhandled signals to it. Killing PID 1 in a namespace kills
every process in it. A process has one PID per namespace in its ancestry, all
listed in `/proc/<pid>/status` as `NSpid`.

**Network.** A complete, independent network stack: interfaces, addresses,
routes, iptables/nftables rules, sockets, port space. Pods get one network
namespace shared by every container in the pod, which is why containers in a
pod reach each other on `localhost`. The namespace is plumbed to the node by
a veth pair or another CNI mechanism; see
[the Kubernetes network model](../k8s-intermediate/network-model-and-cni.md).

**User.** The one namespace that grants privilege rather than only hiding
things. It maps a UID range inside to a different range outside, so UID 0
inside can be an unprivileged UID outside, and the process can hold full
capabilities *within the namespace* while having none on the host. This is what
rootless containers and Kubernetes' `hostUsers: false` (**GA in 1.36**) are
built on.

**Cgroup.** Changes which cgroup directory a process sees as its root, so
`/proc/self/cgroup` shows a path relative to the container rather than the
node's full path. It hides node topology and makes a container-local
`/sys/fs/cgroup` mount meaningful.

**Time.** Offsets `CLOCK_MONOTONIC` and `CLOCK_BOOTTIME` per namespace;
`CLOCK_REALTIME` is deliberately **not** virtualised. It exists mainly for
checkpoint/restore. Note the unusual semantics: `unshare(CLONE_NEWTIME)` creates
the namespace but leaves the caller where it is, placing only its later children
inside, which is why `/proc/<pid>/ns/` has both `time` and `time_for_children`,
and why the clock offsets in `/proc/<pid>/timens_offsets` can be set before the
first process enters. Docker Engine gives rootless containers a
private time namespace by default since 29.5.0.

### The three syscalls

- **`clone()`** creates a new process and, with `CLONE_NEW*` flags, new
  namespaces for it in one step. This is what a runtime uses.
- **`unshare()`** moves the *calling* process into new namespaces. The
  `unshare(1)` command wraps it; `--fork` is needed for PID namespaces because
  the calling process itself cannot change its PID namespace, only its children
  can be born in the new one.
- **`setns()`** joins an existing namespace through a file descriptor, normally
  opened from `/proc/<pid>/ns/<type>`. `nsenter(1)` and `kubectl debug` work
  this way.

A namespace lives as long as it has a member process, an open file descriptor,
or a bind mount of its `/proc/<pid>/ns/` link. That is how a pod's network
namespace survives the restart of every container in it: something keeps a
reference — classically the pod's `pause` container.

## Basic example

On a kind node, list the PID namespaces the kernel knows about:

```bash
docker exec tasklane-control-plane lsns -t pid
```

```console include="captures/foundations/lsns-pid.txt"
```

The same listing per type shows how the node is partitioned. Network
namespaces map one-to-one onto pod sandboxes; UTS and IPC namespaces show the
same grouping, because every container in a pod shares them:

```console include="captures/foundations/lsns-net.txt"
```

```console include="captures/foundations/lsns-uts-ipc.txt"
```

Time namespaces are the exception. Most containers do not get one, and the
kernel exposes the unusual `time_for_children` handle next to `time`:

```console include="captures/foundations/time-ns.txt"
```

Then look at one container's namespace handles next to the node's init
process:

```bash
ls -l /proc/<container-pid>/ns/
ls -l /proc/1/ns/
```

```console include="captures/foundations/api-ns-links.txt"
```

Each link resolves to `type:[inode]`. **Equal inode numbers mean the same
namespace.** That single comparison is how you answer "is this container
actually isolated from the host?" for every type at once.

## Explanation

The capture shows the shape of real isolation. The Tasklane API container has
its own PID, network, mount, UTS and IPC namespaces, but shares the user
namespace and (unless user namespaces are enabled) the cgroup namespace
arrangement with the node. That is the normal Kubernetes default: pods do not
get user namespaces unless `hostUsers: false` is set.

`NSpid` makes the dual identity explicit:

```bash
grep -E '^Name|^NSpid' /proc/<container-pid>/status
```

```console include="captures/foundations/api-nspid.txt"
```

One process, two numbers: the node's PID and the in-container PID (usually 1).
`kubectl exec` and `crictl exec` work by `setns()`-ing into that container's
namespaces and executing a program there; that program is a child of the
runtime's shim, not of your PID 1.

And the user namespace mapping, or the absence of one:

```console include="captures/foundations/api-uid-map.txt"
```

An identity map covering the whole UID range means "no user namespace": UID
65532 inside is UID 65532 on the node, and UID 0 inside would be real root.

## Common patterns

**Pods share namespaces on purpose.** All containers in a Kubernetes pod share
the network, IPC and UTS namespaces; they keep separate mount and PID
namespaces unless `shareProcessNamespace: true` is set. This is why a sidecar
can talk to the app on `127.0.0.1` but cannot see its files.

**Debugging by joining a namespace.** `kubectl debug` with
`--target=<container>` attaches an ephemeral container into the target's
namespaces, giving you tools the distroless image does not contain.

**Host namespaces as an escape hatch.** Node agents (CNI plugins, log
shippers, monitoring) legitimately need `hostNetwork` or `hostPID`. Application
workloads do not, and Pod Security Admission's Baseline level forbids them.

**Network namespaces without containers.** `ip netns` creates network
namespaces for routing and testing. The same kernel feature, no image
involved.

## Production considerations

- **Namespace leaks are real.** A dangling mount or an open file descriptor
  keeps a namespace alive after its processes exit. Symptoms include network
  namespaces that never disappear and `lsns` output that keeps growing.
- **`/proc` must match the PID namespace.** Mounting `/proc` without a new PID
  namespace makes tools inside the container report host processes; this is the
  classic `unshare --pid` mistake that `--mount-proc` exists to prevent.
- **PID 1 semantics bite.** In a PID namespace, the kernel does not apply
  default signal actions to PID 1, so a process that ignores `SIGTERM` will not
  die from it. See
  [PID 1, signals and graceful shutdown](../docker-intermediate/pid1-signals-graceful-shutdown.md).
- **Namespaces cost a little memory and a lot of teardown.** Thousands of very
  short-lived containers spend measurable time creating and destroying network
  namespaces.

## Security considerations

Namespaces hide things; they do not, on their own, take privilege away. A root
process with `CAP_SYS_ADMIN` in the host user namespace can create new
namespaces, mount filesystems inside them, and use that to reach host state.
The three rules that follow:

1. **Never set `hostPID`, `hostIPC` or `hostNetwork` on application
   workloads.** `hostPID` in particular exposes every host process, including
   their `/proc/<pid>/root` and their environments, which often contain
   credentials.
2. **Prefer user namespaces where you can.** With `hostUsers: false` (**GA in
   Kubernetes 1.36**) root inside a pod is an unprivileged UID on the node, so
   a container breakout starts from nothing instead of from UID 0.
3. **Remember `CLONE_NEWUSER` is itself a privilege escalation vector.**
   Unprivileged user namespace creation has been the entry point for multiple
   kernel CVEs, which is why Docker's default seccomp profile restricts
   namespace-creating `clone()` and `unshare()` calls.

:::warning
Sharing a namespace is transitive trust. A pod with `shareProcessNamespace:
true` lets any container read `/proc/<pid>/environ` of the others, and a pod
with `hostPID: true` extends that to the node.
:::

## Troubleshooting

| Symptom | Diagnosis |
|---|---|
| `ps` inside a container shows host processes | `/proc` mounted without a new PID namespace |
| Two containers in a pod fight over a port | expected: they share one network namespace |
| `nsenter` fails with "no such file or directory" | the PID is gone, or you are looking at the wrong node |
| A network namespace persists after the pod is gone | a leaked mount or file descriptor holds a reference |
| `unshare --pid` leaves you as PID 1 with no children reaped | you forgot `--fork`, so the *shell* is not in the new namespace |

Use `lsns` to list namespaces with their owners, and
`readlink /proc/<pid>/ns/<type>` to compare two processes exactly.

## Common mistakes

- **Reading namespace inode numbers as meaningful values.** Only equality
  matters; the numbers are arbitrary and change per boot.
- **Assuming a container has all eight namespaces.** By default it usually has
  five or six; user and time namespaces are typically shared with the host.
- **Using `hostNetwork` to "fix" networking.** It removes the isolation and
  reintroduces port conflicts; the real fix is nearly always a Service or a CNI
  configuration change.
- **Believing a PID namespace hides processes from the node.** It hides the
  *node's* processes from the container. The node sees everything.
- **Forgetting mount propagation.** A bind mount made in a container with
  shared propagation can appear on the host.

## Related topics

- [cgroups v2](cgroups-v2.md)
- [Capabilities](capabilities.md)
- [Build a container from scratch](container-from-scratch.md)
- [The container runtime stack](runtime-stack.md)
- [Containers vs virtual machines](containers-vs-vms.md)
- [Docker networking](../docker-intermediate/docker-networking.md)
- [The Kubernetes network model and CNI](../k8s-intermediate/network-model-and-cni.md)
- [User namespaces in Kubernetes](../k8s-security/user-namespaces.md)
- [User namespaces with Docker](../docker-security/user-namespaces-docker.md)
