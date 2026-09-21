---
title: Horizontal Pod Autoscaler
description: How the HPA controller turns metrics into replica counts, and how to tune its behaviour without making your workload flap.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-intermediate/resources-requests-limits
  - k8s-beginner/deployments-and-replicasets
---

## Overview

A HorizontalPodAutoscaler (HPA) changes the replica count of a scalable
workload so that a measured value stays near a target you choose. It is a
controller in `kube-controller-manager`, not something the kubelet or the
scheduler does, and it works by writing to the `scale` subresource of a
Deployment, StatefulSet or any other resource that implements it.

The current API is `autoscaling/v2`. It supports five metric sources
(Resource, ContainerResource, Pods, Object and External), a `behavior` block
that limits how fast replicas may change in each direction, and — new in
1.37 — a per-direction `tolerance` and Beta support for scaling all the way
to zero.

This page covers the controller's algorithm, the metrics APIs it reads, and
the fields you will actually tune. Event-driven scaling from queues lives in
[KEDA](keda.md), which builds on the HPA rather than replacing it.

## Why it exists and when to use it

Horizontal scaling suits workloads where the unit of work is a request or a
message and any replica can handle any unit: the Tasklane API is a perfect
fit. Adding replicas adds both capacity and redundancy, and every replica can
sit on a different node, which is something a bigger pod cannot do.

Use the HPA when all of the following hold:

- The workload is stateless, or at least shards cleanly.
- Load varies enough that a fixed replica count is either wasteful or too
  small at peak.
- A pod becomes useful quickly — an image pull plus a few seconds of start-up,
  not two minutes of JIT warm-up and cache filling.

It is the wrong tool when the bottleneck is the size of a single pod rather
than the number of pods. A JVM that needs 2Gi of heap does not get better by
having ten replicas of 512Mi; that is a job for
[the Vertical Pod Autoscaler](vertical-pod-autoscaler.md) or
[in-place resize](in-place-pod-resize.md). It is also the wrong tool for a
queue consumer whose backlog lives in a broker the cluster cannot see,
unless you add an adapter that publishes that backlog as an external metric —
which is exactly what [KEDA](keda.md) does.

:::warning One controller per workload
Never point an HPA and a VPA at the same workload for the same resource, and
never let two HPAs (for example, one of yours and one created by KEDA) target
the same Deployment. Each controller writes the replica count or resources
without knowing about the other, and the result oscillates.
:::

## How it works underneath

Every sync period the controller runs the same loop for each HPA object. The
period is set by `--horizontal-pod-autoscaler-sync-period` on
`kube-controller-manager` and defaults to **15 seconds**.

1. Resolve `scaleTargetRef` and read the target's `scale` subresource to get
   the current replica count and the pod label selector.
2. Fetch the metric for every entry in `spec.metrics` from the appropriate
   aggregated API.
3. Compute a desired replica count per metric, and take the **highest** one.
4. Apply tolerance, stabilisation and the `behavior` policies.
5. If the result differs from the current count, write it back through the
   `scale` subresource. The workload controller (for example the Deployment
   controller) does the rest.

### The algorithm

For each metric the controller computes:

```text
desiredReplicas = ceil(currentReplicas * (currentMetricValue / desiredMetricValue))
```

For `AverageValue` targets on Object and External metrics the ratio is taken
against the metric total rather than a per-pod average, so the result does
not depend on the current replica count — that is what makes scaling up from
zero possible.

The ratio is only acted on if it is outside the **tolerance**, which defaults
to 10% cluster-wide (`--horizontal-pod-autoscaler-tolerance`). With the
default, a target of 70% CPU does nothing until measured utilisation leaves
the 63–77% band. Configurable per-direction tolerance is **GA in 1.37**
(KEP-4951): set `behavior.scaleUp.tolerance` or `behavior.scaleDown.tolerance`
to a quantity such as `"0.05"` to override the cluster default for one
direction of one HPA.

### Not-ready pods and missing metrics

The controller is deliberately conservative, because a pod that has just
started reports misleading CPU.

- Pods that are not `Ready`, and pods whose metric is missing, are set aside
  before the ratio is computed.
- They are then added back with the conservative assumption: a missing metric
  counts as 0% of the target if including it would scale **up**, and 100% if
  it would scale **down**. A broken metrics pipeline therefore cannot cause a
  scale-in.
- `--horizontal-pod-autoscaler-initial-readiness-delay` (default 30s) and
  `--horizontal-pod-autoscaler-cpu-initialization-period` (default 5m) control
  how long a young pod's CPU samples are ignored.

### Stabilisation and policies

`behavior` has a `scaleUp` and a `scaleDown` block, each with the same shape:

| Field | Meaning | Default |
|---|---|---|
| `stabilizationWindowSeconds` | Consider the safest recommendation from this window instead of the latest one. Max 3600. | 0 up, 300 down |
| `policies[].type` | `Pods` (absolute) or `Percent` (relative to current replicas) | see below |
| `policies[].value` / `periodSeconds` | How much change is allowed within a rolling window of that many seconds (max 1800) | see below |
| `selectPolicy` | `Max`, `Min`, or `Disabled` to freeze that direction entirely | `Max` |
| `tolerance` | Per-direction tolerance (GA 1.37) | cluster-wide 10% |

The built-in defaults allow scale-up to double the pods or add 4 pods in a
15-second window, whichever is larger, with no stabilisation; and scale-down
to remove all pods in a 15-second window, but only after a 300-second
stabilisation window.

The cluster itself is the authority on which fields your version serves:

```bash
kubectl explain horizontalpodautoscaler.spec.behavior.scaleDown
```

```console include="captures/k8s-advanced/hpa-explain-behavior.txt"
```

### Which metrics APIs

| API group | Served by | Used for |
|---|---|---|
| `metrics.k8s.io` | metrics-server (v0.9.0 in the lab) | `Resource` and `ContainerResource` metrics |
| `custom.metrics.k8s.io` | Prometheus Adapter, KEDA, vendor adapters | `Pods` and `Object` metrics |
| `external.metrics.k8s.io` | the same adapters | `External` metrics |

`metrics.k8s.io/v1` became **stable in 1.37**, but `v1beta1` is still served
and **the HPA controller still uses `v1beta1`**. `kubectl top` prefers `v1`.
None of these APIs is part of the API server: each is an aggregated API
backed by a normal Deployment, so if that Deployment is down, autoscaling
stops.

The `autoscaling` group itself is served by the API server. `api-resources`
prints the preferred version of each kind in the group:

```bash
kubectl api-resources --api-group=autoscaling
```

```console include="captures/k8s-advanced/autoscaling-api-resources.txt"
```

### Scale to zero

`minReplicas: 0` is **Beta in 1.37** (`HPAScaleToZero`, **on by default** in
both the API server and the controller manager). It requires at least one
Object or External metric; an HPA that only has CPU or memory metrics is
rejected, because those can only be measured on pods that exist. When the
workload is parked at zero the HPA carries a `ScaledToZero` condition.

## Basic example

```yaml include="examples/autoscaling/hpa.yaml"
```

Apply it and look at the object:

```bash
kubectl apply -f examples/autoscaling/hpa.yaml
kubectl -n tasklane get hpa
```

```console include="captures/k8s-advanced/hpa-apply.txt"
```

## Explanation

`scaleTargetRef` names the Deployment, and `metrics` says what to keep at
70%. `averageUtilization` is a percentage of the container's CPU **request**,
so the api container's `cpu: 100m` request makes the target 70m of CPU
averaged over ready pods. A workload with no CPU request cannot use
`Utilization` at all — the controller has nothing to divide by, and the HPA
reports a failure instead.

The `behavior` block is where production behaviour is decided. Scaling up
here is immediate and aggressive: no stabilisation window and up to double the
replicas, or four extra pods, per 30 seconds. Scaling down is slow on purpose:
one pod per minute, and only if no higher recommendation appeared in the last
five minutes. That asymmetry is the normal shape — being slow to shrink costs
money, being slow to grow costs availability.

`describe` is the fastest way to see what the controller actually decided,
including its conditions and recent events:

```bash
kubectl -n tasklane describe hpa tasklane-api
```

```console include="captures/k8s-advanced/hpa-describe.txt"
```

The three conditions to read are `AbleToScale` (can it reach the target and
is it outside its backoff), `ScalingActive` (are metrics arriving) and
`ScalingLimited` (is `minReplicas`/`maxReplicas` clamping the recommendation).

## Common patterns

### Several metrics at once

List more than one entry under `metrics`. The controller computes a
recommendation from each and takes the largest, so extra metrics can only
add replicas. A common pair is a request-rate metric with CPU as a safety
floor:

```yaml include="examples/autoscaling/hpa-custom-metric.yaml" lines="17-50"
```

This needs an adapter serving `custom.metrics.k8s.io`; the lab has none, so
the HPA would be accepted and then report `FailedGetPodsMetric`.

### Parking idle workloads at zero

```yaml include="examples/autoscaling/hpa-scale-to-zero.yaml" lines="18-46"
```

The API server accepts this without any adapter installed, which makes it a
cheap way to check that the feature is enabled on your cluster:

```bash
kubectl apply --dry-run=server -f examples/autoscaling/hpa-scale-to-zero.yaml
```

```console include="captures/k8s-advanced/hpa-scale-to-zero-dry-run.txt"
```

### Stop fighting your manifests

Once an HPA owns a workload, leave `spec.replicas` out of the Deployment
manifest. If you keep it and re-apply (or let Argo CD or Flux re-apply it),
the replica count is reset on every sync, undoing the autoscaler. With
server-side apply the two writers also conflict on field ownership.

### Check the metrics pipeline first

```bash
kubectl top pods -n tasklane
```

```console include="captures/k8s-advanced/top-pods.txt"
```

If that works, the same data is one HTTP call away, which is what the
controller does:

```bash
kubectl get --raw /apis/metrics.k8s.io/v1beta1/namespaces/tasklane/pods | head -c 600
```

```console include="captures/k8s-advanced/metrics-api-raw.txt"
```

```bash
kubectl api-versions | grep metrics
```

```console include="captures/k8s-advanced/api-versions-metrics.txt"
```

## Production considerations

**Requests are the scaling unit.** `Utilization` is relative to requests, so
a request that is far too high makes the HPA think the workload is idle, and
one that is far too low makes it scale out constantly. Get requests roughly
right first — with VPA recommendations in `Off` mode, if you like — then
enable the HPA.

**Budget the reaction time.** Worst case, a load spike waits one sync period
(15s), plus scheduling, image pull, start-up and readiness. Sizing
`minReplicas` for the traffic you get during that window is usually cheaper
than trying to make the loop faster.

**maxReplicas must be reachable.** An HPA that wants 40 pods on a cluster
that can fit 12 just creates `Pending` pods. Pair a high `maxReplicas` with
[a node autoscaler](cluster-autoscaler-and-karpenter.md) and with
[PodDisruptionBudgets](../k8s-intermediate/pod-disruption-budgets.md) so that
scale-in of nodes does not take your replicas with it.

**Rollouts and autoscaling interact.** During a rolling update the HPA keeps
scaling the Deployment; new pods are excluded from the average until they are
ready, which is the behaviour you want. Keep `maxUnavailable: 0` so a rollout
never reduces capacity while the HPA is asking for more.

**Watch the flapping.** If the replica count sawtooths, widen
`scaleDown.stabilizationWindowSeconds`, raise `scaleDown.tolerance`, or slow
the policy down to one pod per period. The 1.37 stale-controller mitigation
(KEP-5647, Beta) also covers the HPA, so a controller manager that loses its
lease is less likely to act on stale recommendations.

## Security considerations

**Threat: a workload inflates its own metric to burn cluster capacity.** A
`Pods` or `External` metric usually comes from the application itself, via
Prometheus. Anyone who can make that series go up — including a compromised
replica of the workload, or a tenant who can write to the same Prometheus —
controls the replica count.

**Exploit.** A pod exports `tasklane_http_requests_total` growing at 10,000
per second while doing nothing. The adapter reports it, the HPA multiplies
replicas up to `maxReplicas`, the node autoscaler adds nodes, and the bill
arrives at the end of the month. In a shared cluster the same trick starves
other namespaces of schedulable capacity.

**Fix.** Treat `maxReplicas` as a hard cost ceiling and set it deliberately
per workload. Back it with a
[ResourceQuota](../k8s-intermediate/limitrange-and-resourcequota.md) on the
namespace, so even a runaway HPA cannot consume more CPU and memory than the
tenant is allowed. Keep write access to HPA objects (`autoscaling` group,
`horizontalpodautoscalers`) with the team that owns the workload, and do not
grant it to the workload's own ServiceAccount — the Tasklane pods use
`automountServiceAccountToken: false` and have no API access at all. Prefer
metrics that the application cannot forge, such as broker-side queue depth,
over metrics it reports about itself.

**Verify.**

```bash
kubectl auth can-i update horizontalpodautoscalers --namespace tasklane --as system:serviceaccount:tasklane:tasklane-api
kubectl -n tasklane get resourcequota
kubectl -n tasklane get hpa -o custom-columns=NAME:.metadata.name,MIN:.spec.minReplicas,MAX:.spec.maxReplicas
```

The first must print `no`. The last is worth putting in a CI check: an HPA
whose `maxReplicas` exceeds what the quota can pay for is a misconfiguration.

## Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| `TARGETS` shows `<unknown>/70%` forever | metrics-server missing or not yet warm; container has no CPU request | `kubectl top pods -n tasklane`; `kubectl api-versions \| grep metrics` |
| `ScalingActive: False`, reason `FailedGetResourceMetric` | the aggregated metrics API is failing | `kubectl get apiservices \| grep metrics` |
| `FailedGetPodsMetric` / `FailedGetExternalMetric` | no adapter is serving `custom.metrics.k8s.io` or `external.metrics.k8s.io` | `kubectl api-versions \| grep metrics.k8s.io` |
| `AbleToScale: False`, `FailedGetScale` | `scaleTargetRef` names a workload that does not exist, or a kind with no `scale` subresource | `kubectl -n tasklane get deploy` |
| Never scales down | 5-minute stabilisation window, 10% tolerance, or a second metric still above target | `kubectl -n tasklane describe hpa` and read the events |
| Replica count keeps resetting | `spec.replicas` still in the manifest, or GitOps re-applying it | `kubectl -n tasklane get deploy tasklane-api -o yaml \| grep -A2 managedFields` |
| Scaled to `maxReplicas` but pods are `Pending` | no room in the cluster | [node autoscaling](cluster-autoscaler-and-karpenter.md) |
| API server rejects `minReplicas: 0` | only resource metrics configured, or `HPAScaleToZero` disabled | `kubectl apply --dry-run=server -f ...` |

## Common mistakes

- **Autoscaling on memory.** Most runtimes allocate and never give memory
  back, so a memory-based HPA scales out and never scales in. Scale on CPU or
  on a work-related metric; use memory for [resize](in-place-pod-resize.md).
- **Leaving `spec.replicas` in the manifest.** The single most common cause
  of "my HPA does nothing".
- **Setting `minReplicas: 1` for anything that must stay available.** One
  replica means no redundancy during node drains and rollouts.
- **Copying `autoscaling/v1` examples.** `autoscaling/v1` only supports CPU
  and has no `behavior` block. The old beta versions of the autoscaling API
  were removed in 1.25 and 1.26, so anything on the internet that uses one is
  at least four years out of date. Write `autoscaling/v2`.
- **Expecting instant reaction.** A sync period plus pod start-up is tens of
  seconds at best.
- **Pointing an HPA and a VPA at the same CPU or memory.** They will fight.
- **Forgetting that adapters are ordinary workloads.** If the metrics
  adapter has no PodDisruptionBudget and no redundancy, a node drain stops
  autoscaling cluster-wide.

## Related topics

- [Vertical Pod Autoscaler](vertical-pod-autoscaler.md)
- [In-place Pod resize](in-place-pod-resize.md)
- [KEDA](keda.md)
- [Cluster Autoscaler and Karpenter](cluster-autoscaler-and-karpenter.md)
- [Requests and limits](../k8s-intermediate/resources-requests-limits.md)
- [Pod disruption budgets](../k8s-intermediate/pod-disruption-budgets.md)
- [metrics-server and the metrics API](../operations/metrics-server-and-metrics-api.md)
