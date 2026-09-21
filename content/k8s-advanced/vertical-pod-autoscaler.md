---
title: Vertical Pod Autoscaler
description: How the VPA recommends and applies CPU and memory requests, its three components, its update modes, and why it must not share a resource with an HPA.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-intermediate/resources-requests-limits
  - k8s-intermediate/qos-classes
---

## Overview

The Vertical Pod Autoscaler (VPA) right-sizes pods: it watches how much CPU
and memory the containers of a workload actually use, computes recommended
requests, and — depending on the update mode — applies them.

It is **not** part of Kubernetes. It lives in
`github.com/kubernetes/autoscaler` (current release **1.7.1**), installs its
own CRDs in the `autoscaling.k8s.io` group, and runs three of its own
controllers. Nothing in the lab cluster serves `VerticalPodAutoscaler`
objects, so the manifest on this page is validated against the CRD schema
rather than applied.

The VPA solves the problem nobody enjoys solving by hand: choosing requests.
Requests decide scheduling, [QoS class](../k8s-intermediate/qos-classes.md)
and eviction order, and most teams either guess high (wasting a cluster) or
guess low (getting OOMKilled and evicted).

## Why it exists and when to use it

Use the VPA when the size of one pod is the problem:

- A workload whose footprint you genuinely do not know yet. Run the VPA in
  `Off` mode and read its recommendations like a report.
- Long-running singletons — a database, a cache, a leader-elected controller —
  that cannot be scaled horizontally.
- Fleets of small services where per-service hand-tuning is not worth anyone's
  afternoon, and a 30% waste margin across hundreds of Deployments is real
  money.

Do not use it when:

- The workload already has an [HPA](horizontal-pod-autoscaler.md) on CPU or
  memory. The two controllers would drive the same signal in different
  directions. An HPA on a **custom or external** metric plus a VPA on CPU and
  memory is supported and is a reasonable combination.
- Restarts are expensive and your cluster cannot do
  [in-place resize](in-place-pod-resize.md). In `Recreate` mode the VPA gets
  its way by evicting pods.
- The pod uses pod-level `resources`. The VPA is documented as incompatible
  with workloads that set that stanza.

:::best-practice Start in Off mode
Run every new VPA with `updateMode: Off` for a week and compare
`status.recommendation` with what the manifest asks for. It costs nothing,
disrupts nothing, and usually reveals that half your requests are wrong in
one direction and half in the other.
:::

## How it works underneath

The VPA is three deployments plus a CRD.

| Component | What it does |
|---|---|
| **Recommender** | Reads historical and live usage (from the metrics API, with history from its own checkpoints), fits a model per container, and writes `status.recommendation` into the VPA object: `target`, `lowerBound`, `upperBound` and `uncappedTarget`. |
| **Updater** | Watches pods whose current requests are outside the recommended range and decides what to do about them: evict them, or (in the in-place modes) ask the kubelet to resize them. It respects PodDisruptionBudgets and `updatePolicy.minReplicas`. |
| **Admission controller** | A mutating webhook on pod creation. This is what actually rewrites `spec.containers[].resources.requests` on the new pod, whether that pod was created by a rollout or by the updater's own eviction. |

The order matters: in `Recreate` mode nothing is edited in place. The updater
evicts a pod, the workload controller creates a replacement, and the
admission webhook mutates the replacement on its way into etcd. If the
webhook is down, pods are created with their original requests and the VPA
silently does nothing.

### Update modes

`spec.updatePolicy.updateMode` takes these values:

| Mode | Behaviour |
|---|---|
| `Off` | Never changes pods. Recommendations only. |
| `Initial` | Applies recommendations at pod creation, never afterwards. |
| `Recreate` | Applies at creation, and evicts running pods to apply new recommendations. |
| `InPlaceOrRecreate` | Tries an in-place resize first and falls back to eviction. Needs a cluster with in-place pod resize (**GA in 1.35**). |
| `Auto` | **Deprecated** in the VPA API; today it behaves like `Recreate`. Say what you mean instead. |

VPA 1.7 also adds an `InPlace` mode that never evicts, as an **Alpha**
feature behind a VPA feature gate — off by default, not for production, and
absent from the CRD schema in the CRD catalogue at the time of writing.

### Resource policy

`spec.resourcePolicy.containerPolicies` constrains the recommender per
container: `mode` (`Auto` or `Off`), `minAllowed`, `maxAllowed`,
`controlledResources` (defaults to CPU and memory) and `controlledValues`
(`RequestsAndLimits`, the default, or `RequestsOnly`).

`controlledValues` is the field people miss. With the default the VPA scales
limits along with requests, preserving the original request-to-limit ratio.
With `RequestsOnly` it leaves your limits exactly where the manifest put
them, which is what you want when the limit is a deliberate blast-radius
control rather than a guess.

## Basic example

```yaml include="examples/autoscaling/vpa.yaml"
```

## Explanation

`targetRef` points at the Deployment — not at pods, and not at a label
selector. One VPA per controller; overlapping VPAs are a configuration error.

`updateMode: InPlaceOrRecreate` is the mode to prefer on 1.35 and later: the
updater asks the kubelet to change the running container's cgroup limits and
only evicts if that fails or is infeasible. `minReplicas: 2` stops the
updater from evicting when that would leave fewer than two workers running.

The container policy bounds the recommender. `minAllowed` stops a quiet
workload from being shrunk to a size where the first burst of traffic
OOMKills it. `maxAllowed` stops a leak from being rewarded with a pod nothing
can schedule — without it, the recommender will happily ask for more memory
than any node has, and the pods go `Pending`. `controlledValues:
RequestsOnly` keeps the worker's `memory: 64Mi` limit as written.

To read recommendations you look at the object's status:

```bash
kubectl -n tasklane get vpa tasklane-worker -o jsonpath='{.status.recommendation.containerRecommendations}'
```

`target` is what the admission controller would apply. `lowerBound` and
`upperBound` describe the range in which the updater will leave a pod alone;
`uncappedTarget` is what the recommender wanted before `minAllowed` and
`maxAllowed` were applied, which is the number to watch when you suspect
your caps are doing the deciding.

## Common patterns

### Recommendation-only, cluster-wide

Create one `updateMode: Off` VPA per Deployment and feed
`status.recommendation` into a dashboard or a weekly report. You get the
cost story with none of the disruption, and it is the only safe way to
introduce the VPA to a cluster whose owners are nervous.

### HPA on a custom metric, VPA on resources

The supported combination: the HPA scales replicas on requests per second or
queue depth, while the VPA keeps each replica's CPU and memory requests
honest. Never overlap the resources — if the HPA uses CPU, the VPA must set
`controlledResources: ["memory"]` at most.

### VPA for the database, HPA for the API

In Tasklane, PostgreSQL is a single-replica StatefulSet: horizontal scaling
is meaningless, so a VPA is the only autoscaler that applies. The API gets an
HPA. The worker can take either, depending on whether you scale it on queue
depth with [KEDA](keda.md) or right-size it with the VPA.

## Production considerations

**The admission webhook is on the critical path for pod creation.** Check its
`failurePolicy` before you trust it in production: fail-closed turns a webhook
outage into a cluster-wide inability to create pods, and even fail-open adds
latency to every pod admission it matches. Give it more than one replica, a
PDB, and resources of its own.

**Recommendations need history.** The recommender uses checkpoints to survive
restarts, but a brand-new VPA on a workload with a monthly traffic peak will
under-recommend until it has seen the peak. `minAllowed` is your insurance.

**Eviction is disruption.** In `Recreate` mode the VPA evicts pods to apply a
new size. With one replica, that is downtime. Always set
`updatePolicy.minReplicas`, always have a
[PodDisruptionBudget](../k8s-intermediate/pod-disruption-budgets.md), and
prefer `InPlaceOrRecreate` where the cluster supports it.

**Memory recommendations lag reality by design.** The recommender favours the
high percentiles of recent usage; a workload that leaks slowly will be given
more and more memory rather than being reported as broken. Watch
`uncappedTarget` climbing as a bug signal, not a capacity signal.

**Cost.** Three more controllers, one more webhook, one more CRD group to
upgrade with the cluster. On a small cluster the VPA can easily cost more
operationally than the requests it saves.

## Security considerations

**Threat: the VPA's admission controller can rewrite the resources of pods it
touches, and its updater can evict them.** Both are cluster-scoped powers. An
attacker who can edit VPA objects, or who compromises the VPA controllers,
can make workloads unschedulable (a denial of service by `maxAllowed`), or
shrink a critical pod until it is OOMKilled in a loop.

**Exploit.** In a shared cluster, a tenant with `edit` in their namespace
creates a VPA with `updateMode: Recreate` and a huge `minAllowed` on their
own workload, parking a pod request of 32 CPUs on every node in the pool and
starving other tenants of schedulable capacity — the pods never even need to
run.

**Fix.** Treat `verticalpodautoscalers` as a resource in your RBAC, not an
afterthought: grant create and update only to the teams that need it. Cap the
damage with a
[ResourceQuota](../k8s-intermediate/limitrange-and-resourcequota.md) and a
`LimitRange` per namespace — the quota is enforced by the API server after
the webhook has mutated the pod, so a VPA cannot mutate its way past it.
Restrict the mutating webhook's `namespaceSelector` so it never touches
`kube-system` or another team's namespaces, and review the RBAC the VPA chart
grants its own ServiceAccounts.

**Verify.**

```bash
kubectl auth can-i create verticalpodautoscalers --namespace tasklane --as system:serviceaccount:tasklane:tasklane-worker
kubectl get mutatingwebhookconfigurations -o custom-columns=NAME:.metadata.name,FAIL:.webhooks[*].failurePolicy
kubectl -n tasklane describe resourcequota
```

The first must print `no`. The second tells you whether a VPA webhook outage
blocks pod creation or is ignored.

## Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| `status.recommendation` is empty | Recommender cannot reach the metrics API, or the workload is too young | `kubectl -n kube-system logs deploy/vpa-recommender`; `kubectl top pods` |
| Recommendations exist but pods never change | Mode is `Off` or `Initial`; or the admission webhook is not being called | `kubectl get vpa -o jsonpath='{.items[*].spec.updatePolicy.updateMode}'` |
| Pods are evicted constantly | Recommendation oscillates around the current request; `minReplicas` unset | Widen `minAllowed`/`maxAllowed`, switch to `InPlaceOrRecreate` |
| New pods keep their old requests | The mutating webhook is down or does not select the namespace | `kubectl get mutatingwebhookconfigurations` |
| Pods go `Pending` after a VPA change | Recommendation exceeds node allocatable | Set `maxAllowed` below the largest node |
| Replica count and pod size both oscillate | An HPA and the VPA share CPU or memory | Remove one of them |
| `InPlaceOrRecreate` still evicts | The cluster or the runtime cannot resize that resource; memory shrink needs a restart | `kubectl get pod -o yaml` and read the resize conditions |

## Common mistakes

- **Pairing a CPU HPA with a VPA on the same workload.** The documented
  incompatibility, and the most expensive mistake on this page.
- **Leaving `maxAllowed` unset.** The recommender has no idea how big your
  nodes are.
- **Assuming the VPA is built in.** It is a separate project with its own
  release cadence and its own compatibility matrix; upgrade it with the
  cluster.
- **Running `Recreate` on a single-replica workload without a PDB.** That is
  not autoscaling, that is a scheduled outage.
- **Using `updateMode: Auto` in new manifests.** It is deprecated in the API
  and means `Recreate` today; write the mode you actually want.
- **Forgetting `controlledValues`.** By default the VPA moves limits too,
  which can quietly raise the memory limit you set for a reason.

## Related topics

- [Horizontal Pod Autoscaler](horizontal-pod-autoscaler.md)
- [In-place Pod resize](in-place-pod-resize.md)
- [KEDA](keda.md)
- [Requests and limits](../k8s-intermediate/resources-requests-limits.md)
- [QoS classes](../k8s-intermediate/qos-classes.md)
- [LimitRange and ResourceQuota](../k8s-intermediate/limitrange-and-resourcequota.md)
- [Admission webhooks](admission-webhooks.md)
