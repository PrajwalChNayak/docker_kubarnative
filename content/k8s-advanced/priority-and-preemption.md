---
title: Priority and preemption
description: How PriorityClasses order the scheduling queue, how preemption chooses victims, and how to stop priority becoming a free-for-all.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-intermediate/resources-requests-limits
  - k8s-intermediate/pod-disruption-budgets
---

## Overview

A pod's **priority** is an integer in `spec.priority`. It does two things:

1. **Queue order.** Pending pods are sorted by priority, so a high-priority
   pod is attempted before lower-priority ones.
2. **Preemption.** If a high-priority pod cannot be placed anywhere, the
   scheduler may evict lower-priority pods on one node to make room.

You do not set the integer directly. You create a **PriorityClass**
(`scheduling.k8s.io/v1`, stable since 1.14) and name it in
`spec.priorityClassName`; the `Priority` admission plugin (enabled by
default) resolves the name to a value and rejects the pod if the class does
not exist.

| Concept | Detail |
|---|---|
| Value range | -2147483648 to 1000000000 for user-defined classes |
| Reserved | `system-cluster-critical` = 2000000000, `system-node-critical` = 2000001000 |
| Name rule | A DNS subdomain that must not start with `system-` |
| Default | Priority 0, unless one PriorityClass sets `globalDefault: true` |
| Non-preempting | `preemptionPolicy: Never` (stable since 1.24) |

## Why it exists and when to use it

Priority exists for clusters where demand exceeds capacity and the
resulting choice has to be deliberate: the payment API should survive, the
nightly report can wait. Without it the scheduler treats a batch job and a
customer-facing service identically, and whichever arrived first wins.

Use it when:

- **Critical add-ons must not be starved.** CNI, CoreDNS, metrics and log
  agents use the built-in `system-node-critical` and
  `system-cluster-critical` classes exactly for this.
- **Tiered workloads share a cluster.** A small number of classes —
  typically "platform", "request path", "batch" — encodes which work is
  shed under pressure.
- **Queue-jumping without disruption.** `preemptionPolicy: Never` gives a
  workload an earlier place in the queue while never evicting anyone.

Do not use it as a general capacity tool. Priority does not create
capacity; it only decides who loses. If the cluster is chronically full,
autoscaling ([Cluster Autoscaler or
Karpenter](cluster-autoscaler-and-karpenter.md)) and honest requests fix
more than a priority ladder does. And if three teams each declare their own
workload critical, you have a number inflation problem, not a scheduling
policy.

## How it works underneath

Queue order comes from the `PrioritySort` plugin at the `queueSort`
extension point — the one extension point where exactly one plugin may be
active. It compares priority, then the timestamp at which the pod became
schedulable.

Preemption is the `DefaultPreemption` plugin at `postFilter`, which runs
only after `filter` has found **no** feasible node:

1. **Find candidates.** For each node, ask: if every pod with lower
   priority than the incoming pod P were removed, could P run here? Nodes
   where the answer is no are discarded — including nodes where P has
   inter-pod affinity to one of those lower-priority pods, since removing
   them would break P's own rule.
2. **Pick victims.** Within a candidate node, choose the smallest set of
   lowest-priority pods that frees enough room. PodDisruptionBudgets are
   consulted: the plugin prefers victim sets that violate none, but if no
   such set exists, **it preempts anyway**. PDBs are best effort here, not
   a guarantee.
3. **Pick a node.** Prefer the node whose victim set is cheapest — fewest
   and lowest-priority victims, PDB violations avoided where possible.
4. **Execute.** Set `status.nominatedNodeName` on P, then delete the
   victims. They get their full `terminationGracePeriodSeconds`.

Between step 4 and P actually running there is a gap as long as the
victims' grace period. The scheduler keeps working on other pods during it,
and P is not guaranteed the nominated node: if a better node frees up, or a
higher-priority pod arrives and takes it, `nominatedNodeName` is cleared
and P tries again. Short grace periods on preemptible workloads shrink that
window.

Two refinements matter in 1.37. Preemption runs **asynchronously**
(`SchedulerAsyncPreemption`, Beta and on by default since 1.33), so the
expensive victim search no longer blocks the scheduling cycle. And
`status.nominatedNodeName` is now also written when the scheduler merely
expects a slow `WaitOnPermit` or `PreBind` phase
(`NominatedNodeNameForExpectation`, Beta and on by default since 1.35), so
the field no longer means "preemption happened" on its own.

The scheduler does **not** perform cross-node preemption: if P could only
fit on node N after a pod on a *different* node were removed (a zone-wide
anti-affinity case), P is simply deemed unschedulable on N.

## Basic example

```yaml include="examples/scheduling/priority-classes.yaml"
```

```bash
kubectl apply -f examples/scheduling/priority-classes.yaml
kubectl get priorityclasses
```

```console include="captures/k8s-advanced/priorityclasses.txt"
```

## Explanation

`tasklane-critical` has value 1000000 and the default
`preemptionPolicy: PreemptLowerPriority`: its pods may evict anything with
a lower value, including `tasklane-batch` pods and every priority-0 pod.

`tasklane-batch` has value 100 and `preemptionPolicy: Never`. Its pods sit
ahead of priority-0 pods in the queue, so they get first refusal on free
capacity, but they never trigger preemption — they simply wait. This is the
right setting for data-science and CI workloads that want to start soon
without destroying someone else's in-flight work. Non-preempting pods are
still subject to scheduler back-off, and they can still be preempted by
higher-priority pods.

Neither class sets `globalDefault: true`. Exactly one PriorityClass in a
cluster may set it, and adding it does not change pods that already exist —
only pods created afterwards. A cluster with no `globalDefault` gives
unlabelled pods priority 0, which is usually what you want: it keeps
"unimportant" as the default rather than something a team opted out of.

The demo sets `terminationGracePeriodSeconds: 10`, because a preemption
victim's grace period is dead time for the preemptor.

:::warning Never use the system classes for applications
`system-cluster-critical` and `system-node-critical` outrank everything and
are exempt from some eviction protections. They belong to control-plane
components and node agents. A misbehaving application at
`system-node-critical` can push the CNI or kubelet's own workloads out of
the way.
:::

## Common patterns

**Three classes, no more.** Platform add-ons (below the system classes),
request path, batch. Every additional tier is a negotiation you will have
to referee later. Write the intent in `description` — it is shown by
`kubectl describe priorityclass`.

**Non-preempting batch.** Value above zero, `preemptionPolicy: Never`. The
combination is what makes "get scheduled promptly but harm nothing" work.

**Spare capacity with balloon pods.** Deploy low-value pods
(`value: -10`, no real work) that hold resources; a real workload preempts
them instantly and starts without waiting for a node to boot. The
autoscaler then replaces the balloon. This buys latency, not capacity.

**Quota per class.** Bind a ResourceQuota to a PriorityClass so that only
namespaces with an explicit quota can use a high class:

```yaml title="priority-quota.yaml"
apiVersion: v1
kind: ResourceQuota
metadata:
  name: pods-tasklane-critical
  namespace: tasklane
spec:
  hard:
    pods: "10"
  scopeSelector:
    matchExpressions:
      - operator: In
        scopeName: PriorityClass
        values: ["tasklane-critical"]
```

**PodGroup priority.** Under the Workload API, a PodGroup carries its own
`priority` field and is interleaved with standalone pods in the queue. This
is part of gang scheduling, gated by `GenericWorkload` — **Beta in 1.37 but
off by default**, so do not plan production on it yet. See
[scheduler internals](scheduler-internals.md).

## Production considerations

- **Priority without requests is meaningless.** Preemption frees the
  *requested* resources of victims. A cluster full of pods with no requests
  has nothing to reclaim, and preemption will not fix an overcommitted
  node. Fix requests first; see
  [requests and limits](../k8s-intermediate/resources-requests-limits.md).
- **Preemption is not eviction.** Victims are deleted, not drained; their
  controllers recreate them elsewhere if there is room. A StatefulSet pod
  that is preempted may not come back until capacity exists.
- **PDBs are advisory during preemption.** If your availability story
  depends on a PDB, also make the workload high enough priority that it is
  not a candidate victim.
- **DRA workloads are not preemptible.** The scheduler does not preempt
  pods that hold [dynamic resource allocation](dynamic-resource-allocation.md)
  claims, so a high-priority GPU pod cannot reclaim a device from a
  low-priority one.
- **Watch the metrics.** `scheduler_preemption_attempts_total` and
  `scheduler_preemption_victims` show whether your cluster is quietly
  running on preemption. Steady non-zero values mean it is permanently
  overcommitted.
- **QoS is a separate axis.** The scheduler's preemption ignores QoS class
  entirely. The kubelet's node-pressure eviction, by contrast, ranks pods
  by whether usage exceeds requests, then by priority, then by how far
  usage exceeds requests. A high-priority `BestEffort` pod is still an
  early victim of memory pressure on the node.

## Security considerations

**Threat.** `priorityClassName` is an unrestricted pod-spec field by
default. Any user who can create a pod can name the highest class in the
cluster, jump the queue and evict other tenants' workloads — a clean
denial-of-service primitive that needs no exploit, only a YAML field.

**Exploit.** In the lab, create a Deployment in a scratch namespace with
`priorityClassName: tasklane-critical` and CPU requests large enough to
fill both workers. The scheduler preempts the Tasklane API and worker pods
to place it; `kubectl -n tasklane get events` shows the `Preempted`
entries.

**Fix.** Gate consumption of high classes with ResourceQuota. Configure the
`ResourceQuota` admission plugin so that pods of the protected classes are
admitted **only** where a matching quota exists, using an admission
configuration file passed to kube-apiserver with
`--admission-control-config-file`:

```yaml title="admission-config.yaml" fragment
apiVersion: apiserver.config.k8s.io/v1
kind: AdmissionConfiguration
plugins:
  - name: "ResourceQuota"
    configuration:
      apiVersion: apiserver.config.k8s.io/v1
      kind: ResourceQuotaConfiguration
      limitedResources:
        - resource: pods
          matchScopes:
            - scopeName: PriorityClass
              operator: In
              values: ["tasklane-critical"]
```

Then create the quota only in the namespaces that are allowed the class.
A namespace without such a quota can no longer create pods in it. Back this
with RBAC (`get`/`list` on `priorityclasses` is harmless; `create` is not)
and, if you need finer rules, a validating
[admission policy](admission-policies-cel.md) that checks the class against
the namespace.

**Verify.** Retry the exploit pod and confirm it is rejected with a
forbidden error naming the quota, then check
`kubectl -n tasklane describe resourcequota pods-tasklane-critical` for the
used/hard counts.

## Troubleshooting

```bash
kubectl get priorityclasses
kubectl -n tasklane get pod <pod> -o jsonpath='{.spec.priority}{"\n"}'
kubectl -n tasklane get pod <pod> -o jsonpath='{.status.nominatedNodeName}{"\n"}'
kubectl -n tasklane get events --field-selector reason=Preempted
```

| Symptom | Cause |
|---|---|
| Pod rejected: "no PriorityClass with name X" | The class does not exist; the `Priority` admission plugin fails closed |
| `nominatedNodeName` set, pod still `Pending` | Waiting for victims to terminate, or the slow-binding expectation case |
| Victims evicted but preemptor never scheduled | A higher-priority pod took the node, or the freed room was consumed |
| Higher-priority pods preempted before lower ones | Expected: the scheduler picks a *node*, and a node holding low-priority pods may not be feasible |
| Preemption never happens under pressure | `preemptionPolicy: Never`, or the pods that would be victims have no resource requests |

## Common mistakes

- Setting `globalDefault: true` on a high-value class, silently promoting
  every pod in the cluster.
- Using a `system-` class for an application workload.
- Expecting PodDisruptionBudgets to block preemption. They are best effort.
- Assuming preemption reclaims *usage*. It reclaims requests; pods without
  requests are invisible to it.
- Long `terminationGracePeriodSeconds` on preemptible batch pods, which
  delays the high-priority pod by exactly that long.
- Building a ten-tier priority ladder. Tiers only mean something if someone
  enforces who may use them.
- Forgetting that a preempted pod is deleted: anything not managed by a
  controller does not come back.

## Related topics

- [Scheduler internals](scheduler-internals.md)
- [Taints and tolerations](taints-and-tolerations.md)
- [Topology spread constraints](topology-spread-constraints.md)
- [Dynamic resource allocation](dynamic-resource-allocation.md)
- [Cluster Autoscaler and Karpenter](cluster-autoscaler-and-karpenter.md)
- [Pod disruption budgets](../k8s-intermediate/pod-disruption-budgets.md)
- [LimitRange and ResourceQuota](../k8s-intermediate/limitrange-and-resourcequota.md)
- [Part H labs](labs.md)
