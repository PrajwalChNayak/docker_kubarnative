---
title: Pod affinity and anti-affinity
description: Placing pods relative to other pods with topologyKey, and understanding what inter-pod rules cost the scheduler at scale.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-advanced/node-selection-and-affinity
  - k8s-beginner/labels-selectors-annotations
---

## Overview

Node affinity answers "what kind of machine?". Inter-pod affinity answers
"near which other pods?" — or, for anti-affinity, "away from which other
pods?". Both are expressed as: *this pod should (or should not) run in a
topology domain X that already contains at least one pod matching selector
Y*.

Three parts make up every term:

| Field | Meaning |
|---|---|
| `labelSelector` | Which existing pods count (selector Y) |
| `topologyKey` | The node label whose value defines the domain (X) |
| `namespaces` / `namespaceSelector` | Where to look for those pods; defaults to the pod's own namespace |

Each of `podAffinity` and `podAntiAffinity` has the same two flavours as
node affinity: `requiredDuringSchedulingIgnoredDuringExecution` (a filter)
and `preferredDuringSchedulingIgnoredDuringExecution` (a score, with a
`weight` of 1 to 100 per term). Unlike node affinity, the operators are
limited to `In`, `NotIn`, `Exists` and `DoesNotExist`; `Gt` and `Lt` are
node-affinity only.

## Why it exists and when to use it

Genuine uses are narrower than the feature's popularity suggests.

**Anti-affinity for availability**: keep replicas of one leader-elected
StatefulSet on separate nodes so a single machine failure cannot take a
quorum. This is the classic case, and the one where
[topology spread constraints](topology-spread-constraints.md) are usually
the better modern answer — they degrade gracefully instead of leaving pods
`Pending`.

**Affinity for locality**: pin a cache next to the service that reads it,
in the same zone, to avoid cross-zone traffic charges and latency.

**Anti-affinity for tenancy**: `mismatchLabelKeys` keeps pods from
different tenants off the same node pool without naming the tenants.

When the requirement is really "one pod per node", a
[DaemonSet](../k8s-intermediate/daemonsets.md) expresses it directly. When
it is "spread evenly, but do not block", use topology spread. Reach for
inter-pod rules when the constraint genuinely refers to *other pods*.

## How it works underneath

The `InterPodAffinity` plugin registers at `preFilter`, `filter`,
`preScore` and `score`.

1. **PreFilter** walks the pods in the scheduler's cache that the terms
   could match and builds a map from topology value (for example
   `zone-a`, or a hostname) to the number of matching pods. For
   anti-affinity it must also collect the *existing* pods' own required
   anti-affinity terms, because anti-affinity is symmetric: a running pod
   that refuses to share a node with pods like the incoming one blocks that
   node too.
2. **Filter** takes each candidate node, reads its `topologyKey` label
   value, and consults the map. A required affinity term needs a non-zero
   count in that domain; a required anti-affinity term needs zero.
3. **Score** does the same arithmetic for preferred terms and turns the
   weighted counts into node scores.

Two consequences follow from that design. First, the work is proportional
to the number of pods and the number of terms, not just the number of
nodes; the upstream documentation recommends against inter-pod rules in
clusters larger than **several hundred nodes**. Second, nodes missing the
`topologyKey` label are skipped entirely, so inconsistent node labelling
produces placements that look random.

Two special cases are worth knowing. The first pod of a group that has
affinity to *itself* is allowed to schedule — otherwise no such group could
ever start. And preemption does not help a pod whose affinity points at
lower-priority pods: removing them would break the rule, so the scheduler
looks elsewhere instead of preempting.

## Basic example

```yaml include="examples/scheduling/pod-anti-affinity.yaml"
```

```bash
kubectl apply -f examples/scheduling/pod-anti-affinity.yaml
kubectl -n tasklane get pods -o wide -l app.kubernetes.io/name=sched-anti-affinity
```

```console include="captures/k8s-advanced/anti-affinity-pods.txt"
```

## Explanation

The required anti-affinity term uses `topologyKey: kubernetes.io/hostname`,
so each domain is one node. The lab has two schedulable workers and the
Deployment asks for three replicas, so the third replica has nowhere to go
and stays `Pending` for as long as the rule holds. That is the defining
property of required anti-affinity: **it caps your replica count at the
number of domains**. On a real cluster this is how a Deployment silently
stops scaling.

`matchLabelKeys: [pod-template-hash]` (**GA in 1.33**; the
`MatchLabelKeysInPodAffinity` gate is locked on, although the upstream
concept page's note still describes the fields as beta) fixes the other
classic failure. Without it, during a rolling update the new pods are
anti-affine to the old pods they are replacing, and with
`maxUnavailable: 0` the rollout deadlocks. `pod-template-hash` is added by
the Deployment controller and differs per revision, so kube-apiserver
merges `pod-template-hash=<this revision>` into the selector at pod
creation and the new pods only count each other.

`mismatchLabelKeys` is the inverse: it adds `key notin (my value)` to the
selector. A pod labelled `tenant: tenant-a` with
`mismatchLabelKeys: [tenant]` refuses domains that hold pods of any other
tenant. Keep a `labelSelector` that requires the key to `Exist`, otherwise
the term also matches DaemonSet pods and other infrastructure that has no
tenant label at all.

The preferred `podAffinity` term pulls replicas towards the zone that runs
`tasklane-api`. Preferred terms only score, so they never create pending
pods — which makes them the safe default for locality.

`namespaceSelector` (**GA in 1.24**) widens the search beyond the pod's own
namespace: an empty selector `{}` means *all* namespaces, a null selector
plus an empty `namespaces` list means *this* namespace. The two fields are
unioned, not intersected.

## Common patterns

**Anti-affinity for a StatefulSet quorum.** Required anti-affinity on
`kubernetes.io/hostname` for a three-node etcd, ZooKeeper or Postgres
cluster is legitimate: you would rather have a pending pod than two quorum
members on one machine.

**Soft anti-affinity for stateless replicas.** For an HTTP deployment, use
`preferred` anti-affinity or, better, a topology spread constraint. A
required rule turns a node failure into an outage: the replacement pod
cannot schedule because the remaining nodes each already hold a replica.

**Cache co-location.** Preferred `podAffinity` with
`topologyKey: topology.kubernetes.io/zone` between an API and its cache
keeps traffic inside a zone while still allowing placement anywhere.

**Tenant separation.** `mismatchLabelKeys` with a node-pool topology key
gives soft multi-tenancy in a shared cluster. It is a scheduling nicety,
not isolation — see [multi-tenancy](multi-tenancy.md).

:::warning Required anti-affinity on a zone key
`topologyKey: topology.kubernetes.io/zone` with a required anti-affinity
term limits the workload to one pod per zone. In a three-zone cluster that
is a hard ceiling of three replicas, no matter how many nodes you add. The
optional `LimitPodHardAntiAffinityTopology` admission plugin (disabled by
default) exists exactly to forbid this: it rejects required anti-affinity
with any `topologyKey` other than `kubernetes.io/hostname`.
:::

## Production considerations

- **Scheduling latency.** Every pod that carries inter-pod terms makes the
  scheduling cycle longer for *that* pod, and symmetric anti-affinity makes
  it longer for pods that carry no terms at all. Watch
  `scheduler_pod_scheduling_sli_duration_seconds` and
  `scheduler_framework_extension_point_duration_seconds` when you roll out
  a fleet-wide anti-affinity policy.
- **Cluster autoscaling.** Autoscalers simulate the same plugins, so a
  pending pod blocked by anti-affinity does trigger a scale-up — but only
  if the new node would satisfy the rule. Anti-affinity on a label that
  every new node shares yields pending pods and no growth.
- **Scale-down and rebalancing.** Like all scheduling rules, these are
  evaluated once. Nothing rebalances pods after a node returns; the
  [descheduler](https://github.com/kubernetes-sigs/descheduler) is a
  separate, optional component if you need that.
- **Consistent labels.** Every node must carry the `topologyKey` label. In
  managed clusters `kubernetes.io/hostname` and
  `topology.kubernetes.io/zone` are populated for you; custom keys such as
  `rack` are your responsibility, including on new nodes.
- **Prefer topology spread.** For most stateless workloads, one spread
  constraint expresses the intent better, scales better and fails softer
  than a pair of affinity rules.

## Security considerations

**Threat.** Inter-pod affinity reads the labels of pods in other
namespaces. An attacker who can create pods in any namespace can use
affinity as an oracle and as a placement primitive: by setting
`namespaceSelector: {}` with a selector matching a sensitive workload, they
force their pod onto the same node as that workload. Node co-residency is
the precondition for most container-escape and side-channel attacks, and it
also reveals where a workload runs.

**Exploit.** In the lab: create a pod in a scratch namespace with required
`podAffinity` on `app.kubernetes.io/name=tasklane-api`,
`namespaceSelector: {}` and `topologyKey: kubernetes.io/hostname`. The pod
lands on a node running the API; from there a kernel or runtime
vulnerability, or a shared hostPath, becomes reachable.

**Fix.** Do not rely on affinity for isolation — it is an attraction, not a
wall. Genuine separation comes from dedicated node pools with
[taints](taints-and-tolerations.md) plus RBAC that restricts who may create
pods there, and from
[Pod Security Admission](../k8s-security/pod-security-standards.md) so that
co-residency does not imply escape. Where tenants must not share hardware
at all, give them separate node pools or separate clusters, and consider a
validating [admission policy](admission-policies-cel.md) that rejects
`namespaceSelector: {}` in tenant namespaces.

**Verify.** Try the exploit pod in the lab and confirm it is rejected by
your admission policy, then confirm with
`kubectl -n tasklane get pods -o wide` that tenant pods and Tasklane pods
never share a node.

## Troubleshooting

```bash
kubectl -n tasklane get pods -o wide -l app.kubernetes.io/name=sched-anti-affinity
kubectl -n tasklane describe pod <pending-pod>
```

`FailedScheduling` messages for these rules read "node(s) didn't match pod
affinity rules" or "node(s) didn't satisfy existing pods anti-affinity
rules". The second one is the symmetric case: the incoming pod is fine, but
a pod already on the node refuses it.

Useful checks:

```bash
kubectl get nodes -L kubernetes.io/hostname -L topology.kubernetes.io/zone
kubectl -n tasklane get pods --show-labels
kubectl -n tasklane get replicasets
```

If the pending pod belongs to a new ReplicaSet and the old one still has
pods, you are almost certainly looking at the rolling-update deadlock that
`matchLabelKeys` solves.

## Common mistakes

- Using required anti-affinity for stateless replicas, which turns a lost
  node into pending pods instead of a rescheduled replica.
- Forgetting `matchLabelKeys: [pod-template-hash]` and deadlocking rolling
  updates.
- Setting a `topologyKey` that some nodes do not carry; those nodes are
  silently skipped.
- Writing an anti-affinity `labelSelector` that also matches unrelated
  pods, for example selecting on `app.kubernetes.io/part-of: tasklane`
  rather than the specific workload.
- Assuming anti-affinity is one-directional. It is symmetric for required
  terms, so other people's pods constrain yours.
- Using `mismatchLabelKeys` without an `Exists` selector on the same key,
  which drags every unlabelled infrastructure pod into the calculation.
- Treating affinity as isolation. It attracts; only taints, RBAC and
  policy keep workloads apart.

## Related topics

- [Node selection and node affinity](node-selection-and-affinity.md)
- [Topology spread constraints](topology-spread-constraints.md)
- [Taints and tolerations](taints-and-tolerations.md)
- [Priority and preemption](priority-and-preemption.md)
- [Scheduler internals](scheduler-internals.md)
- [DaemonSets](../k8s-intermediate/daemonsets.md)
- [Part H labs](labs.md)
