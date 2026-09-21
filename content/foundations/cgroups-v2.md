---
title: cgroups v2
description: How the unified hierarchy accounts for and limits CPU, memory, IO and PIDs, and how Docker and the kubelet write your limits into it.
level: foundations
type: concept
status: current
versions: Linux kernel 6.x, Docker Engine 29, containerd 2.x, Kubernetes 1.37
prerequisites:
  - foundations/what-containers-solve
  - foundations/linux-namespaces
---

## Overview

Namespaces decide what a process can *see*. Control groups decide what it can
*use*. A cgroup is a directory in a virtual filesystem; putting a PID in its
`cgroup.procs` file makes the kernel account for that process's CPU time,
memory, IO and process count against that directory, and enforce whatever
limits its control files contain.

cgroup v2 — the **unified hierarchy**, official since Linux 4.5 — is the
baseline for this handbook. Kubernetes **deprecated cgroup v1 in 1.35**, where
the kubelet's `failCgroupV1` started defaulting to true, so a 1.37 kubelet
refuses to start on a cgroup v1 node unless you explicitly opt out. Docker
Engine 29 also lists cgroup v1 as deprecated.

## Why it exists and when to use it

Without limits, one process can take a machine down: allocate until the kernel
OOM-kills something important, spin every core, or fork until the PID table is
full. Historically the answer was one machine per workload. cgroups let many
workloads share a machine with an enforceable budget each, which is the
economic basis of both container platforms and cloud instances.

You meet cgroups directly whenever you set `--memory` on `docker run`, set
`resources.limits` on a pod, debug an OOMKill, or explain why a container with
a CPU limit is slow while the node is idle.

## How it works underneath

### One tree, controllers switched on per subtree

cgroup v2 mounts once, usually at `/sys/fs/cgroup`, as filesystem type
`cgroup2`. Every cgroup is a directory; creating one is `mkdir`. Two core files
drive everything:

- **`cgroup.controllers`** — which controllers are available *in this cgroup*.
- **`cgroup.subtree_control`** — which of them are enabled *for its children*,
  written as `+cpu +memory` or `-io`.

A controller is only usable in a cgroup if the parent delegated it. This
top-down enabling is the big difference from v1, where each controller had its
own independent hierarchy and a process could sit at unrelated positions in
each one.

The other structural rule is **"no internal processes"**: a non-root cgroup
cannot both contain processes and enable controllers for its children. That is
why runtimes and systemd create leaf cgroups for processes and keep the inner
nodes empty, and why the
[from-scratch script](container-from-scratch.md) has to move existing processes
into an `init` leaf before it can delegate controllers.

```bash
docker exec tasklane-control-plane stat -fc %T /sys/fs/cgroup
docker exec tasklane-control-plane cat /sys/fs/cgroup/cgroup.controllers
```

```console include="captures/foundations/node-cgroup-fs.txt"
```

`cgroup2fs` means v2; `tmpfs` means you are on v1.

### The controllers that matter for containers

| Controller | Key files | Semantics |
|---|---|---|
| `cpu` | `cpu.max`, `cpu.weight`, `cpu.stat`, `cpu.pressure` | `cpu.max` is `$MAX $PERIOD` in microseconds, default `max 100000`: a hard throttle. `cpu.weight` (1 to 10000, default 100) is a *share* used only when the CPU is contended. |
| `memory` | `memory.max`, `memory.high`, `memory.low`, `memory.min`, `memory.current`, `memory.peak`, `memory.events`, `memory.stat` | `memory.max` is the hard limit: exceeding it triggers reclaim, then the cgroup OOM killer. `memory.high` throttles the allocator instead of killing. `memory.min` is unreclaimable protection, `memory.low` best-effort protection. |
| `pids` | `pids.max`, `pids.current`, `pids.events` | `fork()` and `clone()` fail with `EAGAIN` above the limit. The cheapest protection against fork bombs. |
| `io` | `io.max`, `io.weight`, `io.stat`, `io.pressure` | Per-device limits, `$MAJ:$MIN rbps=… wbps=… riops=… wiops=…`. |
| `cpuset` | `cpuset.cpus`, `cpuset.mems` | Pins to CPUs and NUMA nodes; used by the kubelet's CPU manager. |
| `hugetlb`, `misc`, `rdma`, `perf_event` | — | Specialised; `misc` is how DRA-style device accounting is done. |

Two more core files are worth knowing: **`cgroup.kill`** (write `1` to SIGKILL
the whole subtree atomically) and **`cgroup.freeze`**.

### Memory limits kill; CPU limits throttle

This asymmetry causes most container confusion.

- **Memory is not compressible.** When a cgroup hits `memory.max`, the kernel
  reclaims page cache first; if it cannot free enough, the cgroup OOM killer
  picks a process inside that cgroup and sends SIGKILL. The container exits
  with status 137 (128 + 9). `memory.events` counts it as `oom_kill`, and
  `memory.oom.group` can make the kill apply to the whole cgroup.
- **CPU is compressible.** When a cgroup exhausts its `cpu.max` quota in a
  period, its tasks are simply not scheduled until the next period. Nothing is
  killed; latency rises. `cpu.stat` counts `nr_throttled` and
  `throttled_usec`, which is the metric to look at when a service is slow on
  an idle node.

### Pressure Stall Information

Each cgroup exposes `cpu.pressure`, `memory.pressure` and `io.pressure` with
`some` and `full` lines and `avg10`, `avg60`, `avg300` and `total` fields. PSI
answers "how much time did tasks lose waiting for this resource", which is far
more actionable than utilisation. **PSI metrics reached GA in Kubernetes
1.36** (`KubeletPSI`, cgroup v2 only, kernel PSI required), so node, pod and
container pressure is available from the kubelet without opt-in.

```console include="captures/foundations/api-pressure.txt"
```

### How your limits get into these files

**Docker.** `docker run --memory 128m --cpus 0.5 --pids-limit 100` becomes,
via the Engine API and containerd, `linux.resources` in the OCI runtime spec,
which runc writes as `memory.max=134217728`, `cpu.max="50000 100000"` and
`pids.max=100`. `--memory-reservation` maps to `memory.low`, `--cpu-shares` to
`cpu.weight`.

**Kubernetes.** The kubelet builds a cgroup tree per QoS class under a root
(commonly `kubepods.slice` with the systemd driver), one cgroup per pod, and
one per container inside it:

```text
kubepods.slice/
  kubepods-burstable.slice/
    kubepods-burstable-pod<uid>.slice/     <- pod level: sum of container limits
      cri-containerd-<container-id>.scope  <- container level
```

- `resources.limits.memory` → the container's `memory.max`
- `resources.limits.cpu` → the container's `cpu.max`
- `resources.requests.cpu` → the container's `cpu.weight` (the share used under
  contention; this is what makes requests meaningful at run time)
- `resources.requests.memory` → **nothing** by default. It is a scheduling
  input. Only with **Memory QoS** (`MemoryQoS`, **Beta and on by default in
  1.37**) does the kubelet write `memory.min`/`memory.low`, and even then its
  `memoryThrottlingFactor` and `memoryReservationPolicy` default to writing
  nothing unless configured.
- the kubelet's `podPidsLimit` → the pod cgroup's `pids.max`

The tree on a real node:

```bash
docker exec tasklane-worker find /sys/fs/cgroup -maxdepth 2 -name 'kubepods*' -type d
```

```console include="captures/foundations/kubepods-tree.txt"
```

**The cgroup driver** decides *who creates the directories*. With the
`systemd` driver — the recommended and usual setting — the kubelet and the
container runtime ask systemd to create transient slices and scopes, so names
end in `.slice` and `.scope`. With `cgroupfs` they `mkdir` directly. The
kubelet and the container runtime must agree; disagreement produces pods that
start but are accounted in the wrong tree, and unstable eviction behaviour.

## Basic example

The Tasklane API asks for a CPU share and caps memory:

```yaml include="examples/k8s/03-app/api.yaml" lines="117-127"
```

On the node, that becomes plain files:

```bash
cat /proc/<container-pid>/cgroup
cat /sys/fs/cgroup/<that-path>/memory.max
cat /sys/fs/cgroup/<that-path>/cpu.max
cat /sys/fs/cgroup/<that-path>/cpu.weight
```

```console include="captures/foundations/api-cgroup-files.txt"
```

And the same numbers as the runtime recorded them in the OCI spec:

```console include="captures/foundations/api-oci-resources.txt"
```

## Explanation

Note what the capture shows at each level. The **container** cgroup carries
`memory.max` from `limits.memory` and `cpu.weight` derived from
`requests.cpu`; there is no `cpu.max` when no CPU limit is set. The **pod**
cgroup carries the sum for the pod. The QoS-class slice above it carries the
node-level policy that keeps Guaranteed pods from being starved by BestEffort
ones.

`memory.current` is not "your application's memory". It includes page cache
charged to the cgroup, which is why a container that reads a large file can sit
near its limit and still be healthy: that cache is reclaimable. What actually
kills you is unreclaimable memory (anonymous pages, some kernel memory), and
what tells you it happened is `memory.events`:

```console include="captures/foundations/api-memory-events.txt"
```

`oom_kill` counts kernel OOM kills inside the cgroup — the ground truth behind
a pod's `OOMKilled` reason.

## Common patterns

**Always limit memory; think twice about limiting CPU.** Memory limits prevent
a node meltdown. CPU limits prevent bursting and add latency: under a limit, a
process with occasional bursts gets throttled even when the node is idle. The
handbook's examples follow this: memory limits everywhere, CPU requests but no
CPU limits on the latency-sensitive API.

**Set a PID limit.** `podPidsLimit` on the kubelet, `--pids-limit` on Docker.
It is nearly free and stops an entire class of accidents.

**Use PSI, not just utilisation.** `some avg10` on `memory.pressure` rising
before an OOMKill is the earliest reliable warning.

**Let systemd own the tree.** Fighting systemd over cgroup ownership produces
mysterious "cgroup deleted" errors. Use the systemd driver and let it delegate.

## Production considerations

- **cgroup v1 is on the way out.** Deprecated in Kubernetes 1.35 and not
  removed as of 1.37; the `failCgroupV1: false` escape hatch still exists but
  is temporary. Podman 6 has already removed v1 support. Check nodes with
  `stat -fc %T /sys/fs/cgroup`.
- **cgroup v2 needs kernel 5.8+ for Kubernetes**, plus a runtime that supports
  it (containerd 1.4+, CRI-O 1.20+) and the systemd driver.
- **Rootless resource limits need cgroup v2 and systemd.** Under rootless
  Docker, `--cpus`, `--memory` and `--pids-limit` only work with delegation in
  place; see [rootless Docker](../docker-advanced/rootless-docker.md).
- **Accounting overhead is small but not zero**, especially with many cgroups
  and frequent creation. Thousands of short-lived containers per node per
  minute is a real workload for the kernel.
- **In-place resize** changes these files without restarting the container:
  container-level in-place Pod resize is **GA in 1.35**, and pod-level resize
  is **Beta and on by default in 1.36**.

## Security considerations

A writable cgroup filesystem inside a container is a privilege escalation
primitive, not a convenience. Two consequences:

- **Never bind-mount `/sys/fs/cgroup` writable into a container**, and be
  suspicious of anything that needs `CAP_SYS_ADMIN` to "manage cgroups". The
  classic cgroup v1 `release_agent` escape (CVE-2022-0492) worked exactly this
  way: write a host path into a cgroup v1 control file, and the kernel executes
  it as root on the host. cgroup v2 removed `release_agent`, which is one more
  reason to be on v2.
- **Missing limits are a denial-of-service vector.** A workload with no
  `memory.max` competes with the kubelet and the container runtime for node
  memory; when the *node* runs out, the kernel OOM killer chooses by
  `oom_score_adj`, and the kubelet starts evicting. Set limits on everything
  you do not fully trust, which in practice means everything.

The counterpart in Kubernetes is `LimitRange` and `ResourceQuota`, so that a
namespace cannot simply omit limits; see
[LimitRange and ResourceQuota](../k8s-intermediate/limitrange-and-resourcequota.md).

## Troubleshooting

| Symptom | Where to look |
|---|---|
| Container exits with 137, `OOMKilled` | `memory.events` `oom_kill`, `memory.peak`; then [OOMKilled](../troubleshooting/oomkilled.md) |
| Service slow while the node is idle | `cpu.stat` `nr_throttled` / `throttled_usec`: a CPU limit is throttling it |
| "resource temporarily unavailable" on fork | `pids.max` reached; check `pids.events` |
| `memory.current` always near the limit | page cache charged to the cgroup; check `memory.stat` `file` versus `anon` |
| Limits set but not enforced | cgroup v1 node, missing controller in `cgroup.subtree_control`, or a driver mismatch |
| "no internal processes" write error | you tried to enable controllers in a cgroup that holds processes |

Start every cgroup investigation the same way: find the process's cgroup path
in `/proc/<pid>/cgroup`, then read the files under
`/sys/fs/cgroup/<path>` and its parent.

## Common mistakes

- **Reading v1 documentation.** Paths such as `/sys/fs/cgroup/memory/...` and
  files such as `memory.limit_in_bytes` do not exist on v2.
- **Setting CPU limits equal to requests everywhere "for predictability".**
  You get predictable throttling instead.
- **Treating `memory.current` as RSS.** It includes cache.
- **Assuming the container sees the node's CPU count.** Runtimes and language
  runtimes read `/proc/cpuinfo`, which is *not* namespaced; a JVM or Go program
  may size its thread pools for 64 cores inside a 0.5-CPU cgroup. Go's
  `GOMAXPROCS` and the JVM's container awareness exist because of this.
- **Mixing cgroup drivers** between the kubelet and the container runtime.
- **Forgetting that the pod cgroup also has limits**, so a sidecar's
  consumption counts against the pod-level budget.

## Related topics

- [Linux namespaces](linux-namespaces.md)
- [Build a container from scratch](container-from-scratch.md)
- [The container runtime stack](runtime-stack.md)
- [Docker resource limits](../docker-advanced/resource-limits.md)
- [Resources, requests and limits](../k8s-intermediate/resources-requests-limits.md)
- [QoS classes](../k8s-intermediate/qos-classes.md)
- [OOMKilled](../troubleshooting/oomkilled.md)
- [In-place Pod resize](../k8s-advanced/in-place-pod-resize.md)
