---
title: Capacity planning
description: Requests vs limits, scheduling headroom, and how capacity interacts with the HPA, VPA and cluster autoscaler.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-intermediate/resources-requests-limits
  - operations/metrics-server-and-metrics-api
---

## Overview

Capacity planning answers two questions: how much cluster do I need, and how do
I size the pods that run on it? Both hinge on the distinction between
**requests** (what the scheduler reserves) and **limits** (the ceiling the
kubelet enforces), plus enough **headroom** to absorb spikes and node failures.
This page connects sizing to the autoscalers — HPA, VPA and the cluster
autoscaler — that keep capacity matched to load.

## Why it exists and when to use it

Under-provision and pods go `Pending` or get OOM-killed; over-provision and you
pay for idle nodes. Capacity planning is the ongoing discipline that keeps you
off both rocks. You do it continuously — sizing new workloads, reviewing
requests against real usage, and setting the headroom that survives a node loss.

## How it works underneath

**Requests reserve; limits cap.** The scheduler places a pod only on a node
whose **allocatable** minus the sum of existing **requests** can fit the pod's
requests. It never looks at actual usage for placement. So a node fills up by
*requested* resources, and requests are what determine how many pods fit and how
many nodes you need.

**Limits** are enforced at runtime by the kubelet/cgroups: CPU over the limit is
throttled, memory over the limit is **OOM-killed**. Limits do not affect
scheduling.

**QoS follows from the two.** Requests == limits on all resources →
**Guaranteed**; some requests set → **Burstable**; none → **BestEffort**. Under
node memory pressure the kubelet evicts BestEffort first, then Burstable over
their requests, protecting Guaranteed pods. So QoS is a capacity-planning lever,
not just a label. See [QoS classes](../k8s-intermediate/qos-classes.md).

**Allocatable < capacity.** A node's **allocatable** is its capacity minus
reservations for the kubelet, the OS and eviction thresholds (`kube-reserved`,
`system-reserved`). You plan against allocatable, not raw capacity:

```console include="captures/operations/ops-node-capacity.txt"
```

## Basic example

The gap that drives planning is requests-vs-allocatable (bin-packing headroom)
and requests-vs-usage (right-sizing). Read the live numbers:

```console include="captures/operations/ops-requests-vs-alloc.txt"
```

```console include="captures/operations/ops-top-nodes.txt"
```

`top nodes` shows real usage; the allocatable/requests view shows reservations.
Where usage sits far below requests, the pods are over-requested and you are
paying for reservation nobody uses.

## Explanation

Set **requests** near a workload's real steady-state usage (from Prometheus
history or VPA recommendations), plus a margin. Set **memory limits** close to
requests (memory is incompressible — over-limit means OOM), and be cautious with
**CPU limits**: an aggressive CPU limit throttles latency-sensitive services even
when the node has spare CPU. Many teams set CPU **requests** and no CPU **limit**
so pods can burst into idle capacity, while always setting memory requests *and*
limits.

**Headroom** is deliberate spare capacity for three things: short-term spikes,
rolling updates (surge pods need somewhere to land), and **node failure** (lose
a node and its pods must fit elsewhere). A cluster packed to 100% of requests has
no room to reschedule a failed node's pods.

## Common patterns

- **Right-size from data, not guesses.** Use the VPA recommender and Prometheus
  percentiles (p95/p99 of usage) to set requests.
- **HPA for load, VPA for right-sizing.** The HPA adds/removes *replicas* on
  load; the VPA adjusts *requests* to fit usage. Do not run both on CPU/memory
  for the same workload — they fight. See
  [HPA](../k8s-advanced/horizontal-pod-autoscaler.md) and
  [VPA](../k8s-advanced/vertical-pod-autoscaler.md).
- **Cluster autoscaler / Karpenter for nodes.** When pods can't be scheduled for
  lack of capacity, the node autoscaler adds nodes; when nodes sit under-used, it
  removes them. Requests drive both decisions.
- **N+1 headroom** so any single node can fail without pending pods.

## Production considerations

- **The chain interacts.** HPA changes replica count → total requests change →
  cluster autoscaler changes node count → cost changes. Size requests first;
  let the autoscalers converge on top.
- **Cluster Autoscaler has no 1.37 release yet** (latest is 1.36.1). On 1.37 use
  Karpenter, or run the 1.36 Cluster Autoscaler within its skew tolerance and
  test carefully.
- **Reserved vs on-demand vs spot** shape both capacity and cost; interruptible
  workloads (Tasklane workers) tolerate spot, the API should not.
- **Pending pods are the signal** that requests exceed capacity; OOM/eviction is
  the signal that limits or node memory are too tight.

## Security considerations

- **BestEffort and unbounded pods are a denial-of-service risk:** a pod with no
  memory limit can consume a node and evict neighbours. Enforce requests/limits
  with LimitRange and ResourceQuota per namespace. See
  [LimitRange and ResourceQuota](../k8s-intermediate/limitrange-and-resourcequota.md).
- **Noisy-neighbour isolation** depends on correct requests/limits and QoS;
  mis-sized pods let one tenant starve others.
- Capacity metrics reveal tenancy and scale; scope who can read cluster-wide
  usage.

## Troubleshooting

- **Pods `Pending` with `Insufficient cpu/memory`:** requests exceed any node's
  allocatable free space; add capacity or lower requests.
- **Frequent `OOMKilled`:** memory limit (or node memory) too low; raise the
  limit or right-size.
- **CPU throttling / latency spikes with spare node CPU:** an over-tight CPU
  limit; relax or remove it.
- **Autoscaler not adding nodes:** pods are Pending for a reason other than
  capacity (affinity, taints), or the autoscaler's node group is at max.
- **Nodes never scale down:** PDBs or non-evictable pods pin them; check what
  blocks eviction.

## Common mistakes

- Setting requests by guesswork instead of measured usage, wasting money or
  causing evictions.
- Packing to 100% of requests with no failure/rollout headroom.
- Aggressive CPU limits that throttle latency-sensitive services.
- No memory limit, risking node-wide OOM and noisy neighbours.
- Running HPA and VPA on the same resource, so they oscillate.

## Related topics

- [Resource requests and limits](../k8s-intermediate/resources-requests-limits.md)
- [QoS classes](../k8s-intermediate/qos-classes.md)
- [Cost visibility](cost-visibility.md)
- [Cluster Autoscaler and Karpenter](../k8s-advanced/cluster-autoscaler-and-karpenter.md)
- [metrics-server and the Metrics API](metrics-server-and-metrics-api.md)
