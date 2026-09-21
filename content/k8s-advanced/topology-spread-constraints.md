---
title: Topology spread constraints
description: Spreading pods evenly across zones and nodes with maxSkew, minDomains and the node inclusion policies, including cluster-wide defaults.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-advanced/pod-affinity-and-anti-affinity
  - k8s-intermediate/pod-disruption-budgets
---

## Overview

`spec.topologySpreadConstraints` tells kube-scheduler to keep the number of
matching pods roughly equal across topology domains — zones, nodes, racks,
whatever a node label describes. It replaces most uses of pod anti-affinity
because it expresses a *degree* of spreading rather than an absolute ban,
and because the soft variant never leaves a pod pending.

One constraint has these fields:

| Field | Meaning | Default |
|---|---|---|
| `maxSkew` | Permitted difference between the busiest eligible domain and the global minimum | required, > 0 |
| `topologyKey` | Node label that defines a domain | required |
| `whenUnsatisfiable` | `DoNotSchedule` (filter) or `ScheduleAnyway` (score) | `DoNotSchedule` |
| `labelSelector` | Which pods are counted | required in practice |
| `minDomains` | Treat the global minimum as 0 while fewer domains than this exist | unset, behaves as 1 |
| `matchLabelKeys` | Pod label keys merged into the selector at creation | unset |
| `nodeAffinityPolicy` | `Honor` or `Ignore` the pod's own node affinity when picking eligible domains | `Honor` |
| `nodeTaintsPolicy` | `Honor` or `Ignore` node taints when picking eligible domains | `Ignore` |

`maxSkew`, `topologyKey`, `whenUnsatisfiable` and `labelSelector` have been
GA since 1.19. `minDomains` is **GA in 1.30** and may only be used with
`DoNotSchedule`. `nodeAffinityPolicy` and `nodeTaintsPolicy` are **GA in
1.33**. `matchLabelKeys` is **Beta since 1.27 and on by default**; since
1.34 kube-apiserver merges the resolved key/value pairs into
`labelSelector` explicitly, controlled by the
`MatchLabelKeysInPodTopologySpreadSelectorMerge` gate (Beta, on by
default).

## Why it exists and when to use it

Anti-affinity is binary: one pod per domain, or nothing. Real availability
requirements are quantitative — "no more than one extra replica in any
zone", "never all of them on one node". Topology spread says exactly that,
and keeps saying it as the replica count changes.

Use it for:

- **Zone-level availability** of a stateless service, so losing a zone
  costs you a predictable fraction of capacity;
- **Node-level spreading** to survive a node failure or a rolling node
  upgrade;
- **Cluster-wide defaults** that give every workload sane spreading without
  each team writing the same YAML.

Use a [PodDisruptionBudget](../k8s-intermediate/pod-disruption-budgets.md)
alongside it: spreading decides placement, a PDB protects the placement
during voluntary disruption. Neither rebalances a running workload.

## How it works underneath

The `PodTopologySpread` plugin registers at `preFilter`, `filter`,
`preScore` and `score`.

1. **PreFilter** finds the *eligible domains*: distinct values of
   `topologyKey` among nodes that pass the pod's node affinity (unless
   `nodeAffinityPolicy: Ignore`) and whose taints the pod tolerates (only
   if `nodeTaintsPolicy: Honor`). It then counts the matching pods —
   restricted to the pod's own namespace — per domain.
2. **Filter** computes, for a candidate node, the skew that placing the pod
   there would produce: `count(domain) + 1 - globalMinimum`. If
   `whenUnsatisfiable: DoNotSchedule` and the result exceeds `maxSkew`, the
   node is infeasible.
3. **Score** (for `ScheduleAnyway`, and for scoring among feasible nodes)
   favours the domains that minimise skew, blended with every other score
   plugin.

The global minimum is the smallest per-domain count across eligible
domains — or **zero** when the number of eligible domains is below
`minDomains`. That is the entire purpose of `minDomains`: in a cluster
where one zone is unavailable, it prevents "one zone, one pod, skew 0" from
looking balanced when it is not.

Nodes that lack the `topologyKey` label are bypassed completely: pods on
them are not counted, and the pod cannot be scheduled there.

## Basic example

```yaml include="examples/scheduling/topology-spread.yaml"
```

```bash
kubectl apply -f examples/scheduling/topology-spread.yaml
kubectl -n tasklane get pods -o wide -l app.kubernetes.io/name=sched-spread
```

```console include="captures/k8s-advanced/topology-spread-pods.txt"
```

## Explanation

The first constraint is hard: four replicas across two zones with
`maxSkew: 1` can only be 2 and 2. Adding a fifth replica is still legal
(3 and 2, skew 1); a sixth must be 3 and 3. If one worker is cordoned,
`nodeTaintsPolicy: Honor` removes it from the eligible domains, so the
remaining zone is the only domain, `minDomains: 2` forces the global
minimum to 0, and any replica beyond the first breaks the skew and stays
`Pending`. Change the constraint to `ScheduleAnyway` and the same replicas
schedule, unevenly, with an event-free outcome you have to notice yourself.

The second constraint is soft and spreads across nodes within whatever the
zone constraint allows. Multiple constraints are ANDed; there may be only
one constraint per `topologyKey` + `whenUnsatisfiable` pair, which is why
this pattern uses a different key for the soft rule.

`matchLabelKeys: [pod-template-hash]` scopes the count to the current
Deployment revision. Without it, a rolling update counts the outgoing pods
and the new ones cannot find a balanced domain; with `maxUnavailable: 0`
that deadlocks the rollout. The merge happens in kube-apiserver at pod
creation, so editing a pod's labels afterwards does not update the
selector.

The two inclusion policies deserve attention because **their defaults
differ**. `nodeAffinityPolicy` defaults to `Honor`, so the eligible domains
already respect your node affinity. `nodeTaintsPolicy` defaults to
`Ignore`, which means cordoned and tainted nodes count as eligible domains
by default — a common reason for "pending pods during a node upgrade".
Setting `Honor` is usually what you want during maintenance.

## Common patterns

**Zone hard, node soft.** The example above: guarantee zone balance, prefer
node balance. This is the standard shape for a stateless service in a
multi-zone cluster.

**Cluster-wide defaults.** Rather than repeat constraints in every
workload, configure the plugin once. Defaults apply only to pods that
define no constraints of their own and that belong to a Service,
ReplicaSet, StatefulSet or ReplicationController, and the `labelSelector`
must be empty because it is derived from that owner:

```yaml title="kube-scheduler-config.yaml" fragment
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
profiles:
  - schedulerName: default-scheduler
    pluginConfig:
      - name: PodTopologySpread
        args:
          defaultConstraints:
            - maxSkew: 1
              topologyKey: topology.kubernetes.io/zone
              whenUnsatisfiable: ScheduleAnyway
          defaultingType: List
```

With no configuration at all, kube-scheduler behaves as if these built-in
defaults were set (**stable since 1.24**):

```yaml title="built-in-defaults.yaml" fragment
defaultConstraints:
  - maxSkew: 3
    topologyKey: "kubernetes.io/hostname"
    whenUnsatisfiable: ScheduleAnyway
  - maxSkew: 5
    topologyKey: "topology.kubernetes.io/zone"
    whenUnsatisfiable: ScheduleAnyway
```

Set `defaultingType: List` with an empty `defaultConstraints` list to turn
them off. The legacy `SelectorSpread` plugin that provided similar
behaviour is disabled by default.

**Spreading per revision or per shard.** `matchLabelKeys` can name any pod
label, not just `pod-template-hash`: a shard ID, a model version, a
customer identifier. The controller sets a different value per group and
one constraint spreads each group independently.

**Combining with node affinity.** The scheduler skips non-matching nodes in
the skew calculation when the pod has `nodeSelector` or node affinity, so
"spread across the zones I am allowed into" needs no extra configuration.

:::best-practice Match your own labels
A constraint whose `labelSelector` does not match the pod's own labels
creates "ghost pods": the pod does not count itself, so several such pods
pile into one domain without ever changing the skew. Copy the workload's
identifying label into both the pod template and the selector.
:::

## Production considerations

- **No rebalancing.** Constraints are evaluated at scheduling time only.
  Scale down, and the distribution can end up lopsided; a node that returns
  from maintenance stays empty. The optional
  [descheduler](https://github.com/kubernetes-sigs/descheduler) can evict
  pods to restore balance, at the cost of extra churn.
- **Empty domains are invisible.** The scheduler learns about zones from
  existing nodes. A node pool scaled to zero is not a domain, so
  `minDomains` and autoscaling need to agree; otherwise pods stay pending
  because a zone the autoscaler could create does not exist yet.
- **`DoNotSchedule` is a capacity decision.** It converts imbalance into
  pending pods. Before making a constraint hard, decide whether "fewer
  replicas running" is genuinely better than "unbalanced replicas".
- **Scheduling cost.** Cheaper than inter-pod affinity, because the
  per-domain counters are computed once per scheduling cycle, but not free:
  each constraint adds work proportional to the number of matching pods.
- **Interaction with HPA.** An HPA that scales up into a hard constraint
  gets pending pods, which is invisible in replica counts. Alert on
  `kube_pod_status_unschedulable` or the scheduler's
  `scheduler_pending_pods` metric, not just on replicas.
- **Consistent labelling.** Nodes without the `topologyKey` label are
  ignored. Verify with `kubectl get nodes -L topology.kubernetes.io/zone`
  after every node-pool change.

## Security considerations

**Threat.** Topology spread is an availability control, and the failure
mode is denial of service by exhaustion. Because counting is restricted to
the pod's own namespace, the risk is not cross-tenant snooping but
self-inflicted outage: a hard constraint plus a shrinking set of eligible
domains means new pods cannot be placed at all. An attacker who can cordon
or taint nodes (node-level access, or RBAC on `nodes`) can shrink the
eligible domains and stop a workload from scaling — without touching the
workload itself.

**Exploit.** In the lab, cordon one worker
(`kubectl cordon tasklane-worker`) while `sched-spread` uses
`minDomains: 2`, `nodeTaintsPolicy: Honor` and `DoNotSchedule`, then scale
the Deployment up. The new replicas stay `Pending` although half the
cluster is idle.

**Fix.** Restrict `patch`/`update` on `nodes` to cluster administrators;
use `ScheduleAnyway` for workloads where degraded balance beats degraded
capacity; keep a PodDisruptionBudget so voluntary disruption cannot empty a
domain faster than pods can be replaced; and alert on pending pods so the
condition is visible in minutes, not on the next incident.

**Verify.** `kubectl auth can-i patch nodes --as=system:serviceaccount:...`
should say no for workload service accounts; then uncordon and confirm the
pending replicas schedule.

## Troubleshooting

```bash
kubectl -n tasklane describe pod <pending-pod>
kubectl get nodes -L topology.kubernetes.io/zone
kubectl -n tasklane get pods -o wide --sort-by=.spec.nodeName
```

| Message or symptom | Likely cause |
|---|---|
| `node(s) didn't match pod topology spread constraints` | Placing the pod there would exceed `maxSkew` |
| `...(missing required label)` | Nodes lack the `topologyKey` label |
| Pending pods during a node upgrade | `nodeTaintsPolicy` left at `Ignore`, so cordoned nodes still count as domains |
| Rollout stuck at the first new pod | `matchLabelKeys` missing, so old pods are counted |
| Distribution drifts after scale-down | Expected; nothing rebalances |

## Common mistakes

- Setting `minDomains` with `ScheduleAnyway`; the API rejects it, because
  the field only has meaning for a hard constraint.
- Leaving `nodeTaintsPolicy` at its `Ignore` default and being surprised
  that cordoned nodes count as eligible domains.
- Omitting `matchLabelKeys`, then deadlocking rolling updates.
- Defining two constraints with the same `topologyKey` and the same
  `whenUnsatisfiable` value, which is invalid.
- Using a `labelSelector` that does not match the pod's own labels, so pods
  never count themselves.
- Making every constraint hard, turning a partial zone outage into a total
  scaling freeze.
- Expecting the constraints to hold as the cluster changes. They are
  evaluated once, at scheduling time.

## Related topics

- [Pod affinity and anti-affinity](pod-affinity-and-anti-affinity.md)
- [Node selection and node affinity](node-selection-and-affinity.md)
- [Taints and tolerations](taints-and-tolerations.md)
- [Scheduler internals](scheduler-internals.md)
- [Horizontal Pod Autoscaler](horizontal-pod-autoscaler.md)
- [Pod disruption budgets](../k8s-intermediate/pod-disruption-budgets.md)
- [Part H labs](labs.md)
