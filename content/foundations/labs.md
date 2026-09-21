---
title: Foundations labs
description: Hands-on exercises that prove namespaces, cgroups, capabilities, seccomp and overlayfs do what the pages claim.
level: foundations
type: lab
status: current
versions: Linux kernel 6.x, Docker Engine 29, containerd 2.x, Kubernetes 1.37
prerequisites:
  - foundations/linux-namespaces
  - foundations/cgroups-v2
  - foundations/capabilities
  - foundations/seccomp
  - foundations/overlay-filesystems
  - foundations/oci-specifications
  - foundations/runtime-stack
---

## Overview

Eight exercises, roughly ninety minutes. Each one ends with a check you can run
yourself, because the only way to believe the mechanism is to watch the kernel
do it. Solutions follow the exercises; try each one first, including the
failures — several exercises are designed to fail in a specific way.

Nothing here modifies anything outside a disposable container or your local
kind cluster.

## Setup

You need:

- **A Docker host**, for the exercises that run a disposable privileged
  container. On Windows or macOS that is Docker Desktop; the privileged
  container runs inside its Linux VM, which is a real Linux kernel.
- **The lab cluster** from `examples/lab/kind-config.yaml`, with the Tasklane
  stages applied, for the exercises that inspect real pods.
- **The scripts** in
  [`examples/foundations/container-from-scratch/`](../../examples/foundations/container-from-scratch/README.md).

A throwaway Linux shell for the kernel-level exercises:

```bash
docker run --rm -it --privileged \
  -v "$PWD/examples/foundations/container-from-scratch:/work:ro" \
  debian:trixie-slim bash
```

Inside it, `apt-get update -qq && apt-get install -y -qq busybox-static util-linux procps`
gives you `unshare`, `lsns`, `nsenter`, `ps` and a static busybox.

:::danger
Exercises 1, 2, 3 and 8 need `--privileged` or root on a Linux host. That is a
deliberate, temporary grant in a container you throw away. Never carry these
flags into a workload manifest, and never run these on a production node.
:::

For the cluster exercises, these three shell variables find the Tasklane API
container and its host PID; every later command reuses them:

```bash
N=$(kubectl -n tasklane get pod -l app.kubernetes.io/name=tasklane-api -o jsonpath='{.items[0].spec.nodeName}')
C=$(docker exec "$N" crictl ps --name api --state Running -q | head -n 1)
P=$(docker exec "$N" crictl inspect -o go-template --template '{{.info.pid}}' "$C")
```

## Exercises

### 1. Prove a namespace exists

In the disposable container, run a shell in a new UTS and PID namespace, change
its hostname, and show that the outer shell is unaffected. Then prove the two
shells are in different namespaces without trusting the hostname.

### 2. Break the PID namespace on purpose

Run `unshare --pid /bin/sh` *without* `--fork` and `--mount-proc`. Look at
`echo $$`, then at `ps`. Explain both results. Then fix it.

### 3. Make the kernel enforce a memory limit

Create a cgroup with `memory.max` of 32 MiB, put a shell in it, and allocate
more than that. Predict what will happen to which process, then confirm it from
`memory.events`.

### 4. Find the cgroup of a real pod

For the Tasklane API container, find its cgroup path from `/proc`, read
`memory.max`, `cpu.max` and `cpu.weight` at the container level and at the pod
level, and reconcile them with
[`examples/k8s/03-app/api.yaml`](../../examples/k8s/03-app/api.yaml).
Which manifest field produced each file?

### 5. Verify the security context from the node

Do not read the manifest. From the node's `/proc`, determine for the Tasklane
API container: its capability sets, whether `no_new_privs` is set, whether a
seccomp filter is installed, its LSM label, and whether it runs in a user
namespace. Then say which manifest field each answer corresponds to.

### 6. Watch copy-up and a whiteout

In the disposable container, build an overlay mount by hand, modify a file that
exists only in the lower directory, and then delete it. Show what appears in
`upperdir` in each case, and what happens to `lowerdir`.

### 7. Read an image like a registry client

Without pulling the image, inspect a multi-platform image's index, pick the
`linux/amd64` manifest, and find the digest of its config blob and of each
layer. Then answer: how many layers does it have, and what is its entrypoint
and user?

### 8. Build the whole container by hand

Run `from-scratch.sh` with `HOLD=1`, then from another shell list the
namespaces it created and inspect its process with `inspect-process.sh`.
Finally, list three things a real runtime would have configured that the script
did not.

## Solutions

### 1. Prove a namespace exists

```bash
readlink /proc/$$/ns/uts
unshare --uts --pid --fork --mount-proc /bin/sh
hostname lab-demo   # inside the new namespaces
hostname
readlink /proc/$$/ns/uts
exit
hostname          # unchanged outside
```

The proof is the pair of `readlink` results: each is `uts:[<inode>]`, and
**different inode numbers mean different namespaces**. The numbers themselves
are meaningless; only equality matters. `lsns -t uts` lists the same
information for every namespace on the machine.

### 2. Break the PID namespace on purpose

```bash
unshare --pid /bin/sh     # no --fork, no --mount-proc
echo $$                   # not 1
ps                        # shows host processes
```

Two separate lessons:

- `unshare(CLONE_NEWPID)` does not move the caller. The *calling* process keeps
  its PID namespace; only children created afterwards are in the new one. That
  is why `--fork` exists, and why the shell you get without it is in a strange
  half-state where its children are in a namespace it cannot see properly.
- `ps` reads `/proc`, and `/proc` is still the old `procfs` mounted in the old
  PID namespace. Namespaces do not rewrite a mounted filesystem.

The fix is `unshare --pid --fork --mount-proc /bin/sh`; now `echo $$` prints 1
and `ps` shows only the new namespace. This is exactly why the
[from-scratch script](container-from-scratch.md) passes both flags.

### 3. Make the kernel enforce a memory limit

```bash
cd /sys/fs/cgroup
mkdir -p lab && echo "+memory" > cgroup.subtree_control 2>/dev/null || true
echo 33554432 > lab/memory.max
echo 0 > lab/memory.swap.max
sh -c 'echo $$ > /sys/fs/cgroup/lab/cgroup.procs; x=$(head -c 67108864 /dev/zero | tr "\0" x); echo survived'
cat lab/memory.events
```

Expected: the allocating shell is SIGKILLed, the parent sees status 137, and
`memory.events` shows a non-zero `oom_kill`. Nothing else on the machine is
affected, because the OOM kill is scoped to the cgroup.

If the `cgroup.subtree_control` write failed with "Device or resource busy",
that is the **no-internal-processes** rule: move the existing processes into a
leaf cgroup first, as `from-scratch.sh` does.

Status 137 is 128 + 9 (SIGKILL). In Kubernetes this is reported as
`OOMKilled`, and the `memory.events` counter is the ground truth underneath it.

### 4. Find the cgroup of a real pod

```bash
docker exec "$N" cat /proc/$P/cgroup
docker exec "$N" sh -c 'd=/sys/fs/cgroup$(cut -d: -f3 /proc/'"$P"'/cgroup); \
  cat $d/memory.max $d/cpu.max $d/cpu.weight; \
  cat $(dirname $d)/memory.max'
```

The captured version of this is
[`captures/foundations/api-cgroup-files.txt`](cgroups-v2.md#basic-example).

Mapping:

| File | Manifest field |
|---|---|
| container `memory.max` | `resources.limits.memory` |
| container `cpu.max` | `resources.limits.cpu` — Tasklane sets none, so expect `max` |
| container `cpu.weight` | derived from `resources.requests.cpu` |
| pod `memory.max` | the sum over the pod's containers |
| `pids.max` | the kubelet's `podPidsLimit`, not a pod field |

`resources.requests.memory` writes nothing by default: it is a scheduler input,
not a kernel limit, unless Memory QoS is configured.

### 5. Verify the security context from the node

```bash
docker exec "$N" grep -E '^Cap(Prm|Eff|Bnd|Amb)|^NoNewPrivs|^Seccomp' /proc/$P/status
docker exec "$N" cat /proc/$P/attr/current
docker exec "$N" cat /proc/$P/uid_map
```

Expected shape, and the field behind each:

| Observation | Manifest field |
|---|---|
| all capability masks zero | `capabilities.drop: ["ALL"]` (plus a non-root UID) |
| `NoNewPrivs: 1` | `allowPrivilegeEscalation: false` |
| `Seccomp: 2` | `seccompProfile.type: RuntimeDefault` |
| an LSM label, or `unconfined` | the runtime's default AppArmor/SELinux policy, if the node has an LSM |
| an identity `uid_map` over the whole range | no user namespace; `hostUsers` is not `false` |

`inspect-process.sh` answers all of these in one pass, and a captured run
against the Tasklane API container is here:

```console include="captures/foundations/inspect-api.txt"
```

The point of doing this from the node is that a `securityContext` placed at the
wrong level in YAML looks correct in `kubectl get -o yaml` and produces nothing
in `/proc`.

### 6. Watch copy-up and a whiteout

```bash
mkdir -p /tmp/o/{lower,upper,work,merged}
echo hello > /tmp/o/lower/file.txt
mount -t overlay overlay -o lowerdir=/tmp/o/lower,upperdir=/tmp/o/upper,workdir=/tmp/o/work /tmp/o/merged
echo world >> /tmp/o/merged/file.txt
ls -l /tmp/o/upper            # a full copy appeared: copy-up
cat /tmp/o/lower/file.txt     # unchanged
rm /tmp/o/merged/file.txt
stat -c '%n %F' /tmp/o/upper/file.txt   # character device 0:0 = whiteout
umount /tmp/o/merged
```

The captured run is in
[`captures/foundations/overlay-copy-up.txt`](overlay-filesystems.md#seeing-it-work).

Two conclusions for image building: modifying a large file in a container
copies the whole file; and deleting a file in a later layer adds a whiteout
rather than removing bytes, so the secret you deleted is still in the image.

### 7. Read an image like a registry client

```bash
docker buildx imagetools inspect --raw <image>@sha256:<digest>          # the index
docker buildx imagetools inspect <image>@sha256:<digest> --format '{{json .Manifest}}'
docker buildx imagetools inspect <image>@sha256:<digest> --format '{{json .Image}}'
```

The index lists one descriptor per platform. The per-platform manifest lists
one `config` descriptor and the layer descriptors. The config blob holds
`Entrypoint`, `Cmd`, `User`, `Env` and `rootfs.diff_ids` — note that `diff_ids`
are digests of the **uncompressed** layers, while the manifest's layer digests
cover the **compressed** blobs.

Captured examples:
[`captures/foundations/image-index-raw.txt`](oci-specifications.md#image-index)
and `captures/foundations/image-manifest-and-config.txt`.

### 8. Build the whole container by hand

```bash
HOLD=1 bash /work/from-scratch.sh &
sleep 5
lsns
sh /work/inspect-process.sh "$(pgrep -f 'sleep 3600' | head -n 1)"
```

`lsns` shows the new pid, mnt, uts, ipc, net and cgroup namespaces, owned by
the demo process. `inspect-process.sh` shows the cgroup with its limits and —
importantly — a **full capability set**, `NoNewPrivs: 0`, `Seccomp: 0` and no
LSM label.

Three things a real runtime would have done and this script does not:

1. Reduce the capability bounding set and set `no_new_privs`.
2. Install a seccomp filter and an AppArmor/SELinux profile.
3. Mask and mount read-only the sensitive `/proc` and `/sys` paths, restrict
   devices, and set up networking through CNI.

That is the whole lesson of Part A in one sentence: **namespaces and cgroups
give you isolation; the security comes from everything you add on top.**

## Common mistakes

- **Reading the manifest instead of the kernel.** Every verification in this
  lab deliberately goes through `/proc` on the node.
- **Comparing namespace inode numbers across machines or reboots.** They are
  arbitrary; only equality within one running kernel means anything.
- **Running the privileged exercises on a node you care about.** Use a
  disposable container.
- **Expecting exercise 2 to "work".** It is supposed to demonstrate two
  failures; the value is in explaining them.
- **Assuming a missing LSM label is a misconfiguration.** Many developer
  kernels have neither AppArmor nor SELinux enabled. Check
  `/sys/kernel/security/lsm` before concluding anything.
- **Leaving the lab cgroup behind.** `rmdir /sys/fs/cgroup/lab` when you are
  done, or just delete the container.

## Related topics

- [Linux namespaces](linux-namespaces.md)
- [cgroups v2](cgroups-v2.md)
- [Capabilities](capabilities.md)
- [seccomp](seccomp.md)
- [AppArmor and SELinux](apparmor-and-selinux.md)
- [Overlay filesystems](overlay-filesystems.md)
- [OCI specifications](oci-specifications.md)
- [The container runtime stack](runtime-stack.md)
- [Build a container from scratch](container-from-scratch.md)
