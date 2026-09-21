---
title: QoS classes and eviction
description: How Kubernetes derives a pod's quality-of-service class from its requests and limits, and how that class decides who dies when a node runs out of memory.
level: intermediate
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-intermediate/resources-requests-limits
---

## Overview

Every pod is assigned one of three quality-of-service classes. You never set it
directly; the API server derives it from the requests and limits you wrote:

| Class | Condition |
|---|---|
| **Guaranteed** | every container sets both requests and limits for both CPU and memory, and for each resource request equals limit |
| **Burstable** | not Guaranteed, but at least one container sets a CPU or memory request or limit |
| **BestEffort** | no container sets any request or limit |

The class is visible in `.status.qosClass` and it decides two things: the
container's `oom_score_adj`, and where the pod sits in the kubelet's eviction
ranking.

## Why it exists and when to use it

A node can promise more memory than it has, because requests are what the
scheduler counts and limits are what containers may actually use. When the
promise comes due the kubelet has to pick victims. QoS is the policy for that
choice, and it is deliberately aligned with how honest you were about your
requirements: pods that declared exactly what they need are the last to be
touched.

Aim for Guaranteed on stateful and latency-critical workloads, Burstable for
most stateless services, and BestEffort for nothing you care about.

## How it works underneath

**Node-pressure eviction** is a kubelet loop, not a control-plane feature. The
kubelet samples *eviction signals* — `memory.available`, `nodefs.available`,
`nodefs.inodesFree`, `imagefs.available`, `imagefs.inodesFree`, `pid.available`
and the containerfs variants — and compares them with thresholds. The Linux
defaults for hard thresholds are:

```text title="kubelet default hard eviction thresholds (Linux)"
memory.available<100Mi
nodefs.available<10%
imagefs.available<15%
nodefs.inodesFree<5%
imagefs.inodesFree<5%
```

Hard thresholds evict immediately with **no grace period**. Soft thresholds
(`eviction-soft`, with `eviction-soft-grace-period`) wait, and honour the pod's
termination grace period up to `eviction-max-pod-grace-period`.

When a threshold is met the kubelet sets the matching node condition
(`MemoryPressure`, `DiskPressure`, `PIDPressure`), tries to reclaim node-level
resources such as unused images, and then ranks pods and evicts them in this
order:

1. `BestEffort` and `Burstable` pods **whose usage exceeds their requests**,
   ordered by Pod Priority and then by how far above the request they are.
2. `Guaranteed` pods and `Burstable` pods **using less than their requests**,
   ordered by Pod Priority.

So the ranking is not "class first". A Guaranteed pod is evicted before a
Burstable pod that is under its request only if it has lower Priority — and a
Burstable pod that stays inside its request is treated just as well as a
Guaranteed one. Requests you actually respect are what buy you safety.

**Eviction is not the same as an OOM kill.** Eviction is the kubelet gracefully
deleting a pod under node pressure; the pod ends up with phase `Failed` and
reason `Evicted`, and its controller creates a replacement elsewhere. An OOM
kill is the kernel killing one container that hit its own `memory.max`; the pod
stays, the container restarts in place. The kubelet biases *kernel* OOM kills
with `oom_score_adj`:

| Class | `oom_score_adj` |
|---|---|
| Guaranteed | -997 |
| Burstable | between 2 and 999, scaled by `memoryRequest / nodeCapacity` |
| BestEffort | 1000 |

A larger request therefore lowers a Burstable container's OOM score, making the
kernel prefer to kill something else when the *node* runs out of memory.

## Basic example

Tasklane's API sets a memory request of 64Mi and a limit of 128Mi and no CPU
limit, so it is Burstable:

```bash
kubectl -n tasklane get pods -o custom-columns='NAME:.metadata.name,QOS:.status.qosClass,NODE:.spec.nodeName'
```

```console include="captures/k8s-intermediate/qos-classes.txt"
```

Making it Guaranteed means matching every number, for every container, for both
resources:

```yaml title="api-guaranteed.yaml" fragment
resources:
  requests:
    cpu: 200m
    memory: 128Mi
  limits:
    cpu: 200m
    memory: 128Mi
```

## Explanation

That fragment costs something real: a CPU limit equal to the request means the
container is throttled the moment it wants more than 200m, even on an idle node.
Guaranteed is a trade of burst capacity for eviction safety, and for most
stateless services the trade is bad. Where it pays is on pods that hold state or
that must never move: databases, brokers, and anything whose restart is
expensive.

Note the "every container" rule. One forgotten sidecar without limits drops the
whole pod to Burstable, and nothing warns you. Check `.status.qosClass` rather
than assuming.

## Common patterns

**Guaranteed for stateful, Burstable for stateless.** PostgreSQL in the lab is
Burstable for simplicity; a production database should be Guaranteed and should
also carry a high `priorityClassName`.

**Priority as the real dial.** Within the same eviction group, Pod Priority
decides. `PriorityClass` objects (`scheduling.k8s.io/v1`) let you state that the
payment service outranks the batch importer, which QoS alone cannot express.

**Never ship BestEffort.** It is first to be evicted, gets `oom_score_adj: 1000`
so the kernel kills it first, and its scheduling is a lottery. The only
legitimate use is a throwaway debug pod.

**Reserve for the system.** `--kube-reserved` and `--system-reserved` keep the
kubelet and the container runtime out of the fight. Without them the first thing
to suffer from memory pressure can be the kubelet itself, and a node that cannot
run its kubelet goes `NotReady` and takes every pod with it.

## Production considerations

Evictions are silent if you do not look for them. Watch for
`Evicted` pods and for the `MemoryPressure`/`DiskPressure` node conditions, and
alert on both. A steady trickle of evictions is a sizing bug, not weather.

`DiskPressure` is more common than memory pressure in practice, and the usual
cause is images and logs rather than application data. Set
`limits.ephemeral-storage`, keep `emptyDir` volumes bounded with `sizeLimit`,
and let image garbage collection do its job.

Evicted pod objects are not deleted automatically, so a node that flapped
leaves a pile of `Evicted` pods behind. They cost nothing but noise, and they
are useful evidence — read them before you clean them up.

PSI metrics (**GA in 1.36**, cgroup v2 with kernel PSI) expose how long tasks
were stalled on CPU, memory and IO. They are a far better early warning than
utilisation, because pressure rises before anything is evicted.

## Security considerations

Eviction ranking is an availability control, and Pod Priority is the lever that
overrides it. A tenant who can create pods with a high-priority PriorityClass
can make their workloads survive at everyone else's expense, and with preemption
enabled they can also evict other tenants' running pods. Restrict
`priorityClassName` usage with a ResourceQuota `scopeSelector` on
`PriorityClass`, and keep `system-cluster-critical` and `system-node-critical`
for the control plane.

BestEffort pods from an untrusted tenant are a cheap way to occupy a node's
unreserved memory. Enforce minimum requests with a `LimitRange` so that no pod
lands in that class by accident or design.

## Troubleshooting

```bash
kubectl get pods -A --field-selector=status.phase=Failed
kubectl -n tasklane describe pod <evicted-pod>
```

The pod's `Message` names the signal: `The node was low on resource: memory` or
`... ephemeral-storage`. Then look at the node:

```bash
kubectl describe node <node>
```

`Conditions` shows whether the pressure is current, and `Events` shows
`EvictionThresholdMet` and the images the kubelet garbage-collected while trying
to recover.

If a container is being killed but the pod stays put and the restart count
climbs, that is an OOM kill against the container's own limit, not eviction —
see [OOMKilled](../troubleshooting/oomkilled.md).

## Common mistakes

- **Believing QoS alone decides eviction order.** Usage relative to requests
  and Pod Priority both come first within the ranking.
- **Assuming Guaranteed means "never evicted".** It means evicted last under
  pressure — and node-pressure eviction still beats any PodDisruptionBudget,
  which only constrains voluntary disruption.
- **One container without limits** quietly demoting an otherwise Guaranteed pod.
- **Thinking `Evicted` and `OOMKilled` are the same event.** Different actor,
  different scope, different fix.
- **Leaving BestEffort pods in production** and being surprised they vanish.
- **No `--kube-reserved`**, so memory pressure takes out the kubelet.
- **Ignoring ephemeral storage**, then diagnosing "random" evictions on the
  node whose disk is full of logs.

## Related topics

- [Requests and limits](resources-requests-limits.md)
- [LimitRange and ResourceQuota](limitrange-and-resourcequota.md)
- [Pod disruption budgets](pod-disruption-budgets.md)
- [Priority and preemption](../k8s-advanced/priority-and-preemption.md)
- [Evicted pods](../troubleshooting/evicted-pods.md)
- [OOMKilled](../troubleshooting/oomkilled.md)
