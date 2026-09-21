---
title: OOMKilled
description: Why a container is killed with exit 137, how cgroup v2 memory.max and the working set interact, and how requests, limits, page cache and language runtimes change the outcome.
level: advanced
type: troubleshooting
status: current
versions: Kubernetes 1.37
prerequisites:
  - troubleshooting/method
  - k8s-intermediate/resources-requests-limits
  - foundations/cgroups-v2
---

## Overview

`OOMKilled` means the Linux kernel's out-of-memory killer terminated a
container because it exceeded its memory limit. The container exits with code
`137` and, if its `restartPolicy` allows, restarts — often into a
`CrashLoopBackOff`. This page separates the two memory failures people conflate:
a **container** hitting its own cgroup limit (OOMKilled) and a **node** running
low on memory and evicting pods (see [Evicted pods](evicted-pods.md)).

## Symptoms

- `describe pod` shows `Last State: Terminated, Reason: OOMKilled, Exit Code: 137`.
- Restarts climb; the pod may end in `CrashLoopBackOff` with no application-level
  error in the logs — it was killed mid-work.
- `kubectl top pod` (if metrics-server is installed) shows memory near the limit
  just before the kill.

Reproducer (a 16Mi limit and a memory hog):

```yaml include="examples/troubleshooting/oomkilled.yaml"
```

```console include="captures/troubleshooting/oomkilled.txt"
```

## How it works underneath

On a **cgroup v2** node (the baseline since Kubernetes 1.35), a container's
memory `limit` becomes the cgroup's `memory.max`. When the cgroup's memory usage
would exceed `memory.max` and cannot be reclaimed, the kernel invokes the OOM
killer for that cgroup and kills a process in it. The container runtime reports
the kill; the kubelet records `OOMKilled` and exit code `137` (128 + signal 9,
SIGKILL).

The number that matters is the **working set**: resident memory minus reclaimable
page cache. The kubelet and metrics compute
`container_memory_working_set_bytes` for this reason. Two consequences:

- **Page cache counts, but is reclaimable.** A process that reads large files
  fills page cache inside its cgroup; under pressure the kernel drops clean
  cache first. You are OOMKilled only when the *non-reclaimable* working set
  exceeds the limit. This is why a container can show high memory yet not be
  killed.
- **`requests` do not prevent OOM; `limits` cause it.** The request is for
  scheduling and QoS. The limit is the hard cap the kernel enforces. A container
  with `requests.memory == limits.memory` is `Guaranteed` QoS and is only ever
  OOMKilled by its own limit, never chosen first under node pressure.

### QoS and who gets killed under node pressure

When the **node** is short on memory (not one container's limit), two different
mechanisms apply. The kubelet **evicts** pods based on eviction thresholds and
QoS class (`BestEffort` first, then `Burstable` over their requests, `Guaranteed`
last) — that produces `Evicted`, not `OOMKilled`. Separately, the kernel can OOM
individual processes. Do not confuse the two: `OOMKilled` is a container exit;
`Evicted` is the pod being deleted from the node. See
[Evicted pods](evicted-pods.md).

### Language runtimes need to be told the limit

A container limit is invisible to a runtime that sizes itself from the host's
total memory:

- **Go**: the garbage collector will happily grow the heap toward host memory.
  Set `GOMEMLIMIT` (a soft limit) to about 90% of the container limit so the GC
  works harder before the kernel kills the process. Also set `GOMAXPROCS` to the
  CPU limit.
- **JVM**: modern JVMs are container-aware (`-XX:+UseContainerSupport`, on by
  default) and size the heap from the cgroup limit via
  `-XX:MaxRAMPercentage`. Older flags like `-Xmx` must match the limit by hand.
- **Node.js**: `--max-old-space-size` must be set below the container limit.

Without this, the runtime targets far more memory than the cgroup allows and is
killed the moment it tries to use it.

## Diagnosis

1. **Confirm it was OOM, not a code exit.**

   ```bash
   kubectl -n <ns> get pod <pod> -o jsonpath='{range .status.containerStatuses[*]}{.name}{" "}{.lastState.terminated.reason}{" "}{.lastState.terminated.exitCode}{"\n"}{end}'
   ```

   `OOMKilled 137` confirms it.

2. **See the limit and the usage.**

   ```bash
   kubectl -n <ns> get pod <pod> -o jsonpath='{.spec.containers[*].resources}'
   kubectl -n <ns> top pod <pod> --containers
   ```

3. **Distinguish node pressure.** If many pods across a node are dying, check
   the node:

   ```bash
   kubectl describe node <node> | grep -A6 Conditions
   ```

   `MemoryPressure: True` points at the node, not one container's limit.

## Fixes

- **Raise the limit to fit the real working set.** Measure the steady-state and
  peak working set, add headroom, and set `limits.memory` accordingly. Guessing
  low just moves the kill.
- **Fix a genuine leak.** If usage grows without bound, no limit is large
  enough; profile and fix the leak. A rising `container_memory_working_set_bytes`
  that never plateaus is the tell.
- **Tell the runtime the limit.** Set `GOMEMLIMIT`/`GOMAXPROCS`,
  `MaxRAMPercentage`, or `--max-old-space-size` from the container limit.
- **Make it Guaranteed** for critical pods (`requests == limits`) so node
  pressure never targets them first.
- **Right-size with data.** The Vertical Pod Autoscaler can recommend
  memory requests/limits from observed usage — see
  [VPA](../k8s-advanced/vertical-pod-autoscaler.md).

## Prevention

- Always set a memory `limit`, and set it from **measured** working set, not a
  round number.
- Prefer `Guaranteed` QoS for latency-critical or stateful pods.
- Make container-limit awareness part of the base image or entrypoint for
  Go/JVM/Node workloads.
- Alert on working set approaching the limit (say, > 90% for N minutes) so you
  resize before the kill.
- Separate memory-hungry batch work from latency-critical services by node pool
  or QoS.

## Common mistakes

- Reading exit `137` as a crash bug rather than a memory kill.
- Confusing container `OOMKilled` with node `Evicted`.
- Setting a memory **request** and expecting it to cap usage — only the
  **limit** caps usage.
- Leaving a JVM/Go/Node process unaware of the cgroup limit, so it targets host
  memory.
- Bumping the limit blindly for a real leak, buying minutes instead of fixing
  it.

## Related topics

- [A method for debugging Kubernetes](method.md)
- [Evicted pods](evicted-pods.md)
- [CrashLoopBackOff](crashloopbackoff.md)
- [Resources: requests and limits](../k8s-intermediate/resources-requests-limits.md)
- [QoS classes](../k8s-intermediate/qos-classes.md)
- [cgroups v2](../foundations/cgroups-v2.md)
- [Vertical Pod Autoscaler](../k8s-advanced/vertical-pod-autoscaler.md)
