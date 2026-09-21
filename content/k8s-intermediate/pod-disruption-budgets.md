---
title: Pod disruption budgets
description: How PDBs constrain voluntary disruption through the eviction API, what unhealthyPodEvictionPolicy fixes, and the budgets that wedge a cluster.
level: intermediate
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/deployments-and-replicasets
  - k8s-intermediate/pod-lifecycle-and-termination
---

## Overview

A PodDisruptionBudget (`policy/v1`) states how much of a workload may be taken
away **voluntarily** at once: either `minAvailable` or `maxUnavailable`, plus a
selector.

It constrains the eviction API and nothing else. A node that catches fire, a
kubelet that evicts under memory pressure, `kubectl delete pod`, a preempting
scheduler — none of them consult a PDB.

## Why it exists and when to use it

Cluster maintenance is constant: node upgrades, autoscaler scale-down,
descheduler rebalancing, spot instance reclamation. Each of those drains nodes,
and without a budget a drain can take every replica of a service at once because
they happened to share a node.

Put a PDB on anything with more than one replica that users depend on. Do not
put one on a single-replica workload; see below.

## How it works underneath

The eviction API is a subresource: `POST /api/v1/namespaces/<ns>/pods/<pod>/eviction`.
The disruption controller maintains, for each PDB, `status.currentHealthy`,
`status.desiredHealthy`, `status.expectedPods` and `status.disruptionsAllowed`.
When an eviction request arrives, the API server checks every PDB whose selector
matches the pod:

- `disruptionsAllowed > 0` → the eviction is allowed and the counter is
  decremented (the controller replenishes it as replacements become healthy).
- `disruptionsAllowed == 0` → the request is rejected with **429 Too Many
  Requests** and reason `DisruptionBudget`. `kubectl drain` retries until its
  `--timeout`.

`desiredHealthy` is derived from the workload's `.spec.replicas` through the
pod's owner — which is why a PDB with a selector that matches pods from two
different Deployments produces nonsense, and why a PDB on bare pods cannot
compute a percentage.

Crucially, "healthy" means **Ready**. Before 1.26 a pod that was running but not
Ready still counted against the budget and could not be evicted, so a broken
rollout blocked every drain in the namespace. `unhealthyPodEvictionPolicy`
(**GA since 1.31**) fixes that:

| Value | Behaviour |
|---|---|
| `IfHealthyBudget` (default) | unready pods may be evicted only if the budget is currently met |
| `AlwaysAllow` | unready pods may always be evicted |

`AlwaysAllow` is the right default for most services: a pod that is not Ready is
serving nobody, so removing it cannot hurt availability, and refusing to remove
it is how a cluster upgrade stalls at 2 a.m.

## Basic example

```yaml include="examples/k8s/07-reliability/10-pdb.yaml"
```

```bash
kubectl -n tasklane get poddisruptionbudget
```

```console include="captures/k8s-intermediate/pdb.txt"
```

## Explanation

The API budget is expressed as `minAvailable: 1` rather than
`maxUnavailable: 1`. With two replicas the two are equivalent today, but they
diverge under change: if someone scales to 1, `minAvailable: 1` refuses every
eviction (safe, loud), while `maxUnavailable: 1` allows the only replica to go
(silent outage). Percentages behave differently again — `minAvailable: 50%`
rounds up, `maxUnavailable: 50%` rounds down, both deliberately erring towards
availability.

The worker uses `maxUnavailable: 1` because it is a queue consumer: losing one
replica slows the queue, and the budget should scale automatically with the
replica count.

PostgreSQL gets no PDB at all, and the file says why. A `minAvailable: 1` budget
on a single replica sets `disruptionsAllowed: 0` forever: every drain of that
node blocks until its timeout, then someone force-deletes the pod anyway and the
budget has achieved nothing except delay. The real answer for a single-replica
database is replication.

## Common patterns

**`AlwaysAllow` unless you have a specific reason.** Stateful quorum systems are
the exception: evicting an unready etcd member can cost you quorum, so
`IfHealthyBudget` is right there.

**Percentages for autoscaled workloads**, absolute numbers for fixed ones.
`minAvailable: 80%` keeps the promise as replicas change; `minAvailable: 3` does
not.

**One PDB per workload, selector identical to the workload's.** Overlapping PDBs
are evaluated together and the strictest wins, which is almost never what the
second author intended.

**Pair PDBs with spread.** A PDB counts pods, not failure domains. Two replicas
on one node satisfy `minAvailable: 1` right up to the moment that node dies. Use
`topologySpreadConstraints` for the other half of the guarantee.

**Check before an upgrade:**

```bash
kubectl get pdb -A -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,MIN:.spec.minAvailable,MAX:.spec.maxUnavailable,ALLOWED:.status.disruptionsAllowed'
```

Anything with `ALLOWED: 0` will block a drain.

## Production considerations

PDBs are a promise to the *cluster operator*, and a promise that is impossible
to keep is worse than none: it turns routine maintenance into a manual
escalation. Review every PDB with `disruptionsAllowed: 0` as a bug.

Node upgrades interact badly with slow-starting pods. If a replacement takes
three minutes to become Ready, a `minAvailable` budget permits one eviction
every three minutes, and a 60-node rolling upgrade takes hours. Either accept
that, raise the allowance, or make pods start faster.

Cluster Autoscaler and Karpenter both respect PDBs when consolidating nodes.
Workloads with tight budgets and no spare capacity simply prevent scale-down,
which shows up as a cost problem rather than an availability one.

A PDB does not protect against node failure, preemption or node-pressure
eviction. For those you need replicas across failure domains, priority classes,
and honest resource requests.

## Security considerations

The eviction API is what enforces the budget, so the budget is only as good as
the permissions around it. Anyone who can `delete pods` can bypass every PDB in
the namespace; `kubectl delete pod` is not an eviction. Grant `pods/eviction`
create rights to tooling, and keep raw `delete pods` narrow.

The reverse is a denial-of-service: a tenant who can create PDBs in their own
namespace can set `minAvailable: 100%` and make their namespace undrainable,
blocking node upgrades and security patching for the whole cluster. In a
multi-tenant cluster, restrict `poddisruptionbudgets` write access or validate
them with an admission policy (for example: reject any PDB whose settings make
`disruptionsAllowed` structurally zero).

Node drains are part of patching. A budget that blocks them delays CVE
remediation, which makes "who may write a PDB" a security question, not just an
operational one.

## Troubleshooting

**`kubectl drain` hangs with `Cannot evict pod as it would violate the pod's
disruption budget`.** Look at the budget's status:

```bash
kubectl -n tasklane get pdb tasklane-api -o yaml
```

`disruptionsAllowed: 0` plus `currentHealthy < desiredHealthy` means the
workload is already degraded — fix the workload, not the budget. `currentHealthy
== desiredHealthy` with `disruptionsAllowed: 0` means the budget is too tight
for the replica count.

**`status.conditions` with reason `InsufficientPods`** — the selector matches
fewer pods than expected, often a label typo.

**`SyncFailed` / no status at all** — the PDB matches pods whose controller the
disruption controller cannot resolve (bare pods, or two owners), so it cannot
compute `desiredHealthy`.

**Evictions allowed even though the budget says no** — check whether the caller
is actually evicting. The API server logs and audit trail distinguish
`pods/eviction` from `delete pods`.

## Common mistakes

- **`minAvailable: 1` on a single-replica workload.** Permanent
  `disruptionsAllowed: 0`.
- **`minAvailable` equal to `replicas`.** Same result, and it looks reasonable
  in review.
- **Leaving `unhealthyPodEvictionPolicy` at the default** for a service whose
  pods are often unready, then blaming the drain.
- **Believing a PDB protects against node failure.** It covers voluntary
  disruption only.
- **Overlapping PDBs** from a chart and a platform default.
- **A PDB without topology spread**, so the budget is satisfied by two pods on
  one node.
- **Percentages on a workload with 2 replicas**, where rounding decides
  everything.

## Related topics

- [Pod lifecycle and termination](pod-lifecycle-and-termination.md)
- [QoS classes and eviction](qos-classes.md)
- [StatefulSets](statefulsets.md)
- [Topology spread constraints](../k8s-advanced/topology-spread-constraints.md)
- [Cluster autoscaler and Karpenter](../k8s-advanced/cluster-autoscaler-and-karpenter.md)
- [Node maintenance](../operations/node-maintenance.md)
- [Cluster upgrades](../operations/cluster-upgrades.md)
