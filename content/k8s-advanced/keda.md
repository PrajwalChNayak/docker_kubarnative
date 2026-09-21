---
title: KEDA
description: How KEDA turns queue depth, database rows and cloud events into HPA metrics, including activation, scale to zero and ScaledJob.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-advanced/horizontal-pod-autoscaler
  - k8s-intermediate/jobs-and-cronjobs
---

## Overview

KEDA (Kubernetes Event-Driven Autoscaling) is a CNCF project — **v2.20.2** at
the time of writing — that lets you scale a workload on the thing that
actually causes load: the number of messages in a queue, the length of a
Kafka consumer lag, the rows waiting in a table, the depth of a cloud
subscription.

It does this without replacing the [HPA](horizontal-pod-autoscaler.md). You
write a `ScaledObject`; KEDA's operator creates and owns an ordinary
`HorizontalPodAutoscaler` for your workload, and KEDA's metrics server feeds
that HPA through `external.metrics.k8s.io`. Everything you know about
stabilisation windows and scaling policies still applies.

The one thing KEDA does *not* delegate is the 0 ↔ 1 transition, which it
handles itself.

## Why it exists and when to use it

CPU is a lagging, lossy proxy for work. A Tasklane worker that is waiting on
PostgreSQL uses almost no CPU while a thousand tasks pile up; a CPU-based HPA
would see an idle fleet. The number of rows with `status = 'pending'` is the
real signal, and it is available long before CPU moves.

Use KEDA when:

- The work arrives as events or queue items, and the backlog is measurable.
- Idle should mean zero replicas, not one — batch jobs, nightly processors,
  per-customer workers.
- You would otherwise write and operate your own metrics adapter. KEDA ships
  dozens of built-in scalers, and the alternative (Prometheus Adapter plus rules
  plus a Prometheus that must never be down) is a lot of moving parts to
  maintain for one number.

Do not use it when:

- CPU or memory really is the signal. A plain HPA needs no extra operator.
- You need sub-second reaction. KEDA polls; the default `pollingInterval` is
  30 seconds and the HPA adds its own sync period on top.
- Your only workload is one Deployment and you already run Prometheus
  Adapter. Two metrics adapters are not better than one.

:::warning KEDA owns the HPA
Do not create your own HPA for a workload that a `ScaledObject` targets.
KEDA's admission webhook rejects the `ScaledObject` if another HPA already
scales that workload, and if you sneak one in afterwards the two controllers
will fight over the replica count.
:::

## How it works underneath

KEDA installs as three deployments plus its CRDs.

| Component | Role |
|---|---|
| `keda-operator` | Reconciles `ScaledObject` and `ScaledJob`. Creates and owns the HPA. Runs each trigger's `IsActive` check and performs the 0 → 1 and 1 → 0 transitions itself. |
| `keda-operator-metrics-apiserver` | An aggregated API server for `external.metrics.k8s.io`. The HPA controller queries it exactly as it would query any other external-metrics adapter. |
| `keda-admission-webhooks` | Validates KEDA resources at admission time — duplicate scale targets, conflicting HPA ownership, malformed triggers. |

### Activation versus scaling

This is the distinction that explains most KEDA behaviour.

- **Activation** is the 0 ↔ 1 decision. It belongs to the operator, because
  the HPA has no useful ratio to compute when there are no pods. Each trigger
  has an *activation threshold* (`activationTargetQueryValue` for the
  PostgreSQL scaler); the scaler is active when the metric is **strictly
  greater than** that value. With the default of `0`, one pending task
  activates the workload.
- **Scaling** is the 1 → N decision. Once there is at least one replica, the
  HPA takes over using the *scaling threshold* (`targetQueryValue`) as the
  metric target.

If `minReplicaCount` is 1 or more, the scaler is always considered active and
the activation value is ignored.

### The loop

1. Every `pollingInterval` the operator asks each trigger's scaler for the
   current value and for whether it is active.
2. If the workload is at zero and a trigger is active, the operator scales the
   Deployment to `minReplicaCount` or 1.
3. From there the HPA reads the same metric through the metrics API server
   and computes replicas with the normal HPA algorithm — the trigger's
   `metricType` (`AverageValue` by default) decides how.
4. When every trigger has been inactive for `cooldownPeriod` seconds, the
   operator scales the workload back to zero (or to `idleReplicaCount`).

`cooldownPeriod` applies only to the final step down to zero; ordinary
scale-in from N to 1 is governed by the HPA's own stabilisation window, which
you can set under `advanced.horizontalPodAutoscalerConfig.behavior`.

### ScaledJob

A `ScaledObject` scales a long-running Deployment. A `ScaledJob` creates
Kubernetes [Jobs](../k8s-intermediate/jobs-and-cronjobs.md) instead: one (or
a batch) per unit of work, each running to completion. Use it when the work
item is long, non-idempotent to interrupt, or needs a clean process per item;
use a `ScaledObject` when a pod can loop over many items.

## Basic example

```yaml include="examples/autoscaling/keda-scaledobject.yaml"
```

This file needs KEDA installed and is not applied in the lab; it is validated
with kubeconform against the KEDA CRD schemas.

## Explanation

The `TriggerAuthentication` is how the scaler gets the database password
without it being an environment variable on your workload. `secretTargetRef`
maps the scaler parameter `password` to the key `password` of the existing
`tasklane-db` Secret. The Secret is read by KEDA's operator, in the
namespace of the `TriggerAuthentication` — a `ClusterTriggerAuthentication`
exists for the cross-namespace case, and is exactly as dangerous as it
sounds.

The trigger itself is the PostgreSQL scaler. `host`, `port`, `userName`,
`dbName` and `sslmode` are assembled into a connection (the alternative is a
single `connectionFromEnv` pointing at a full connection string). `query`
must return a single numeric value; ours is the same count the worker's
own `/metrics` endpoint exposes as `tasklane_tasks_pending`.

The two thresholds do different jobs:

| Field | Decides | Value here |
|---|---|---|
| `activationTargetQueryValue` | 0 → 1, by the operator | `0`: any pending task wakes the fleet |
| `targetQueryValue` | 1 → N, by the HPA | `5`: one worker per five pending tasks |

`restoreToOriginalReplicaCount: true` means that deleting the `ScaledObject`
puts the Deployment back to the replica count it had before KEDA took over,
instead of leaving it wherever the last scaling decision left it — including
at zero, which is a memorable way to cause an outage during a cleanup.

Check what KEDA built for you:

```bash
kubectl -n tasklane get scaledobject,hpa
kubectl -n tasklane describe scaledobject tasklane-worker
kubectl get --raw /apis/external.metrics.k8s.io/v1beta1 | jq '.resources[].name'
```

The HPA will be called `keda-hpa-tasklane-worker` unless you override
`advanced.horizontalPodAutoscalerConfig.name`.

## Common patterns

### Scale to zero, with a safety net

`minReplicaCount: 0` is the point of KEDA for bursty work. Pair it with a
`fallback` block so that a broken scaler (an unreachable database, an expired
credential) parks the workload at a sane replica count instead of at zero:

```yaml title="fallback (fragment)" fragment
fallback:
  failureThreshold: 3
  replicas: 2
```

### Several triggers on one workload

List several entries under `triggers`. Each becomes a metric on the generated
HPA, and the HPA takes the **maximum** recommendation, so triggers can only
add replicas. Queue depth plus CPU is a common pair: the queue drives normal
scaling, CPU catches the case where items are unexpectedly expensive.

### Pause without deleting

Annotate the `ScaledObject` with `autoscaling.keda.sh/paused: "true"` to
freeze it at its current replica count, or
`autoscaling.keda.sh/paused-replicas: "<n>"` to park it at a specific count.
This is the correct move during an incident or a migration; deleting the
object changes ownership and, without `restoreToOriginalReplicaCount`, leaves
the replica count wherever it was.

### KEDA instead of a Prometheus Adapter

Because KEDA serves `external.metrics.k8s.io`, a plain HPA with an `External`
metric can consume KEDA's metrics too — that is how
[scale to zero](horizontal-pod-autoscaler.md#scale-to-zero) with a native HPA
gets its numbers. Most of the time you want the `ScaledObject` instead,
because it brings the activation logic with it.

## Production considerations

**Latency is polling plus syncing.** Worst case is `pollingInterval` (30s by
default) plus the HPA's 15-second sync plus pod start-up. Lower the polling
interval for latency-sensitive queues, but remember that every poll is a real
query against your broker or database — `SELECT count(*)` on a large table
every five seconds is a self-inflicted load problem. Index the predicate, or
use `useCachedMetrics`.

**Cold starts are the price of zero.** Nothing buffers requests while a
Deployment is at zero replicas. For queue consumers this is fine — the work
waits in the queue. For anything serving HTTP, scaling to zero means dropped
or very slow requests unless something in front holds the connection.

**Credentials multiply.** Each `TriggerAuthentication` gives the KEDA
operator access to one more system. The operator becomes an attractive
target precisely because it can read the credentials of every event source in
the cluster.

**Version skew.** KEDA is an operator with CRDs; upgrade it deliberately and
read its release notes for scaler metadata changes. Field names differ
between scalers and do change between major versions — always check the
scaler's own page for the version you run.

**Cost of the abstraction.** Three more deployments, one aggregated API and a
webhook, all on the path to your workload scaling at all. If a single HPA on
CPU would do, use the single HPA.

## Security considerations

**Threat: KEDA's operator is a credential aggregator with cluster-wide scale
rights.** It reads Secrets referenced by `TriggerAuthentication` objects, and
it writes the `scale` subresource of workloads. Compromise it, or convince it
to read a Secret you should not have, and you have both the credentials and
the ability to park production at zero replicas.

**Exploit.** A tenant creates a `ScaledObject` in their namespace whose
`scaleTargetRef` names a Deployment they do not own but which lives in the
same namespace as a shared component, with `minReplicaCount: 0` and a trigger
that never activates. The workload is scaled to zero and stays there: a
denial of service with no pod exec, no image, and nothing in the audit log
that looks like an attack.

**Fix.** Keep `ScaledObject` and `TriggerAuthentication` create/update rights
with the workload owners, namespace by namespace, and avoid
`ClusterTriggerAuthentication` unless you have a specific reason — it lets
one namespace's trigger reference a Secret from elsewhere. Give the event
source a least-privilege credential: the PostgreSQL scaler needs
`SELECT` on one table, not the application's role. Alert on
`ScaledObject` creation and on workloads sitting at zero replicas, and use
KEDA's admission webhooks (installed by default) so conflicting scale
targets are rejected rather than discovered.

**Verify.**

```bash
kubectl auth can-i create scaledobjects --namespace tasklane --as system:serviceaccount:tasklane:tasklane-worker
kubectl get clustertriggerauthentications
kubectl -n tasklane get scaledobject -o custom-columns=NAME:.metadata.name,TARGET:.spec.scaleTargetRef.name,MIN:.spec.minReplicaCount,MAX:.spec.maxReplicaCount
```

The first must print `no`. The third is the list to review in change control:
every workload KEDA can take to zero.

## Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| `ScaledObject` rejected at creation | Another HPA already scales the target | `kubectl -n tasklane get hpa` |
| `READY: False`, `ACTIVE: Unknown` | The scaler cannot reach its source, or the credential is wrong | `kubectl -n keda logs deploy/keda-operator` |
| Stuck at zero despite a backlog | Metric is not above `activationTargetQueryValue` (strictly greater), or the query returns the wrong shape | Run the query by hand against the database |
| Scales to 1 and no further | The HPA has no metric: KEDA's metrics API server is unhealthy | `kubectl get apiservices \| grep external.metrics` |
| Never scales down to zero | `cooldownPeriod` not elapsed, or a trigger is still active, or `minReplicaCount` > 0 | `kubectl -n tasklane describe scaledobject` |
| Scaling ignores your HPA tuning | `behavior` must go under `advanced.horizontalPodAutoscalerConfig` | Read back the generated HPA |
| Deployment stays at zero after cleanup | `ScaledObject` deleted without `restoreToOriginalReplicaCount` | `kubectl -n tasklane scale deploy/tasklane-worker --replicas=2` |

## Common mistakes

- **Creating a second HPA for a KEDA-managed workload.** The webhook stops
  you; if you disable the webhook, nothing does.
- **Editing the generated HPA directly.** The operator reconciles it back.
  Change the `ScaledObject`.
- **Using the application's database credential for the scaler.** Give it a
  read-only role scoped to the query.
- **Forgetting that `activationTargetQueryValue` is strictly greater-than.**
  A value of `5` means the workload stays at zero with exactly five items
  waiting.
- **Scaling an HTTP service to zero without a request buffer.** The queue
  metaphor does not transfer to synchronous traffic.
- **Polling an expensive query every few seconds.** The scaler query runs
  forever; make sure it uses an index.
- **Assuming scaler metadata names are stable across versions.** Check the
  scaler page for your KEDA version before upgrading.

## Related topics

- [Horizontal Pod Autoscaler](horizontal-pod-autoscaler.md)
- [Vertical Pod Autoscaler](vertical-pod-autoscaler.md)
- [Cluster Autoscaler and Karpenter](cluster-autoscaler-and-karpenter.md)
- [Jobs and CronJobs](../k8s-intermediate/jobs-and-cronjobs.md)
- [Secrets](../k8s-beginner/secrets.md)
- [Custom resource definitions](custom-resource-definitions.md)
