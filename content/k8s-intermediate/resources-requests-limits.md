---
title: Requests and limits
description: What the scheduler does with requests, what the kernel does with limits, and why a CPU limit can make an idle service slow.
level: intermediate
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/pods
  - foundations/cgroups-v2
---

## Overview

Every container can declare two numbers per resource:

- **`requests`** — what the **scheduler** reserves on a node. It is an
  accounting number. Nothing enforces it at runtime.
- **`limits`** — what the **kernel** enforces on the running container, through
  cgroup v2 controllers. Nothing about scheduling uses it.

Two different components, two different mechanisms, one YAML block. Almost
every resource surprise in Kubernetes comes from mixing them up.

CPU is *compressible*: exceeding the limit makes the container slower. Memory
is *incompressible*: exceeding the limit kills it.

## Why it exists and when to use it

Without requests, the scheduler has no idea how much of a node is spoken for
and will happily pack a node until it collapses. Without memory limits, one
leaking container can take down every pod on its node.

Set a request on every container. Set a **memory limit** on every container.
Be deliberate about **CPU limits** — see below, they are rarely what people
expect.

## How it works underneath

**Scheduling.** kube-scheduler filters nodes whose *allocatable* capacity minus
the sum of the requests of pods already assigned to them is smaller than the new
pod's requests. Allocatable is node capacity minus kube-reserved,
system-reserved and eviction thresholds; it is always less than the machine's
RAM. Limits are not consulted at all, which is why a cluster can be 100%
*requested* and 10% *used*, or 40% requested and out of memory.

The effective request of a pod is the sum of its regular containers' requests,
compared with the largest init container's request; sidecars (restartable init
containers) count in the sum, because they keep running.

**CPU enforcement.** The kubelet translates the container spec into cgroup v2
files under `/sys/fs/cgroup`:

| Spec | cgroup v2 file | Effect |
|---|---|---|
| `requests.cpu: 100m` | `cpu.weight` | relative share when the CPU is contended; 100m gets a tenth of the shares of 1 CPU |
| `limits.cpu: 500m` | `cpu.max` (quota/period, e.g. `50000 100000`) | hard ceiling per 100 ms period |
| `requests.memory` | (nothing by default) | scheduling and eviction ranking only |
| `limits.memory: 128Mi` | `memory.max` | the cgroup OOM killer fires at this value |

The CPU quota is the part that bites. `cpu.max` is enforced per period
(100 ms by default): a container with `limits.cpu: 500m` may use 50 ms of CPU
time per 100 ms *summed across every thread*. An 8-thread Go or JVM process can
burn that in 6 ms of wall clock and then be **throttled** — frozen — for the
remaining 94 ms of the period. Average utilisation looks like 5%, and p99
latency is terrible. The metric to look at is
`container_cpu_cfs_throttled_periods_total` against
`container_cpu_cfs_periods_total`.

**Memory enforcement.** When a cgroup's usage hits `memory.max`, the kernel
tries to reclaim, then invokes the OOM killer inside that cgroup. The kubelet
reports the container's last state as `OOMKilled` with exit code 137. This is
the kernel acting, not Kubernetes: there is no grace period, no SIGTERM and no
preStop hook. Page cache from files the container reads counts towards the
cgroup, which is why a container that streams large files can be OOM-killed
without its heap growing at all.

**Memory QoS** (**Beta in 1.37, on by default**, cgroup v2 only) lets the
kubelet also set `memory.min`/`memory.low` so reclaim pressure prefers other
cgroups. Its `memoryThrottlingFactor` now defaults to null and
`memoryReservationPolicy` to `None`, so nothing is written unless you configure
the kubelet — the gate being on does not change your cluster by itself.

cgroup v1 is **deprecated since 1.35** (`failCgroupV1` defaults to true) and
this page assumes cgroup v2, which is the baseline everywhere in this handbook.

## Basic example

```yaml include="examples/k8s/03-app/api.yaml" lines="117-122"
```

Note what is *not* there: no `limits.cpu`.

## Explanation

The API requests 100m CPU and 64Mi of memory, and limits memory to 128Mi. The
scheduler reserves 100m and 64Mi. At runtime the container may use as much CPU
as the node has spare, because there is no quota; when CPUs are contended its
`cpu.weight` gives it a tenth of a core's worth of shares relative to other
containers. If it ever allocates past 128Mi it is OOM-killed, which is a loud,
obvious failure rather than a node-wide slow death.

Resource quantities use two suffix families, and mixing them up is a real bug:
`Mi`/`Gi` are powers of 1024, `M`/`G` are powers of 1000. `1000m` CPU is one
core; `0.5` and `500m` are the same thing. The smallest CPU the API accepts is
`1m`.

## Common patterns

**Request what you use, limit memory at the top of what you should ever use.**
A good starting point is `requests.memory` at the steady-state working set and
`limits.memory` 1.5 to 2 times that, then let real data adjust it.

**Skip CPU limits on latency-sensitive services** that you trust, and rely on
requests plus a scheduler that is not overcommitted. Keep CPU limits for
untrusted or batch workloads, where predictability matters more than tail
latency, and for multi-tenant clusters where a `LimitRange` forces them anyway.

**Runtime-aware settings beat CPU limits.** A JVM's `-XX:ActiveProcessorCount`,
Go's `GOMAXPROCS`, Node's thread-pool size and `GOMEMLIMIT` all read the
machine, not the cgroup, in several runtimes and versions. Set them explicitly
from the pod spec rather than hoping the runtime notices the cgroup.

**Pod-level resources** (`spec.resources`, Beta since 1.34) let you budget a
pod as a whole instead of per container, which suits pods with a hungry sidecar.
Pod-level in-place resize is Beta and on by default in 1.36+; container-level
in-place resize is **GA since 1.35**. Pod-level *resource managers* (NUMA
alignment) are Beta in 1.37 but **off by default**.

## Production considerations

Overcommitment is a deliberate policy, not an accident: set requests below
limits and you are betting that not every container peaks at once. Decide the
ratio per cluster and enforce it with a `LimitRange`
([LimitRange and ResourceQuota](limitrange-and-resourcequota.md)).

`kubectl top` shows actual usage from the metrics API, which is what you need to
size requests:

```bash
kubectl -n tasklane top pods
```

```console include="captures/k8s-intermediate/top-pods.txt"
```

Compare it against what each node has already promised:

```bash
kubectl describe node tasklane-worker
```

```console include="captures/k8s-intermediate/node-allocatable.txt"
```

The `Allocated resources` table at the bottom is the scheduler's view: requests
and limits as percentages of allocatable. Requests near 100% means no new pod
fits, whatever `top` says.

Vertical Pod Autoscaler and in-place resize can set these numbers for you; both
are covered in Part H. Neither removes the need to understand what the numbers
mean.

## Security considerations

Resource limits are a denial-of-service control. A container with no memory
limit can exhaust a node and cause the kubelet to evict its neighbours; a
container with no CPU request competes on equal footing with everything else.
In a multi-tenant cluster, treat missing limits as a policy violation and
enforce them with a `LimitRange`, a ResourceQuota that requires them, or an
admission policy.

Ephemeral storage deserves the same treatment:
`limits.ephemeral-storage` bounds the container's writable layer and its
`emptyDir` volumes. Without it, a runaway log file fills the node's disk and
evicts every pod on it.

Remember that limits are a *node* protection, not an isolation boundary. They do
not stop a container from reading `/proc` information about the host or from
using another tenant's page cache indirectly. That is what user namespaces
(GA in 1.36) and node pools are for.

## Troubleshooting

**`OOMKilled`.** `kubectl describe pod` shows `Last State: Terminated,
Reason: OOMKilled, Exit Code: 137`. Either the limit is too low or the process
leaks. Check whether usage grows without bound — a leak — or plateaus just above
the limit — a bad number.

**Throttling.** No event, no log line, nothing in `kubectl describe`. The only
evidence is the throttling counters or the latency graph. If a service is slow
at low CPU utilisation, suspect `limits.cpu` first.

**`Pending` with `FailedScheduling: Insufficient cpu/memory`.** The *requests*
do not fit anywhere. Lower the request, add a node, or look for a node with
`Allocated resources` near 100%.

**Pods evicted with `The node was low on resource: memory`.** Node pressure
eviction, ranked by QoS class — see [QoS classes](qos-classes.md).

## Common mistakes

- **Setting `limits` and expecting the scheduler to honour them.** It never
  looks at limits. A cluster can be scheduled full and idle at the same time.
- **A CPU limit on a latency-sensitive service.** Throttling shows up as p99
  latency, not as CPU usage, so it is usually diagnosed last.
- **Copying `requests: 1` from a tutorial.** A whole core per container is a
  nonsense request for most services, and it packs nodes at 10% utilisation.
- **Memory request far below the limit on a critical pod.** That makes the pod
  Burstable and moves it up the eviction ranking; see
  [QoS classes](qos-classes.md).
- **Confusing `Mi` and `M`.** `512M` is 12 MiB less than `512Mi` — enough to
  turn a tuned JVM heap into an OOM kill.
- **Assuming the runtime sees the limit.** Many runtimes read `/proc/cpuinfo`
  and size their thread pools to the machine, not the cgroup.
- **No `ephemeral-storage` limit on anything that writes files.**

## Related topics

- [QoS classes and eviction](qos-classes.md)
- [LimitRange and ResourceQuota](limitrange-and-resourcequota.md)
- [cgroups v2](../foundations/cgroups-v2.md)
- [Resource limits in Docker](../docker-advanced/resource-limits.md)
- [Vertical Pod Autoscaler](../k8s-advanced/vertical-pod-autoscaler.md)
- [In-place Pod resize](../k8s-advanced/in-place-pod-resize.md)
- [OOMKilled](../troubleshooting/oomkilled.md)
- [Pending pods](../troubleshooting/pending-pods.md)
