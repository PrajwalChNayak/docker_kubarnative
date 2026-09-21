---
title: Node selection and node affinity
description: How nodeSelector, required and preferred node affinity steer pods onto particular nodes, and what each costs the scheduler.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/labels-selectors-annotations
  - k8s-intermediate/resources-requests-limits
---

## Overview

By default kube-scheduler treats every node as a candidate and picks the one
that scores best for a pod. Node selection narrows that candidate set using
**node labels**: `nodeSelector` for a flat equality match, and
`nodeAffinity` for set-based expressions with hard and soft variants.

Three fields do this job, in increasing order of expressiveness:

| Field | Semantics | Failure mode |
|---|---|---|
| `spec.nodeName` | Bypasses the scheduler entirely; the kubelet on that node picks the pod up | Pod fails if the node is full or missing |
| `spec.nodeSelector` | All listed label key/value pairs must match | Pod stays `Pending` |
| `spec.affinity.nodeAffinity` | Set-based terms, required and/or preferred | Required: `Pending`. Preferred: scored, never blocked |

If a pod sets both `nodeSelector` and `nodeAffinity`, **both** must be
satisfied. In the lab the two workers carry
`topology.kubernetes.io/zone=zone-a` and `zone-b`:

```console include="captures/k8s-advanced/nodes-zone-labels.txt"
```

## Why it exists and when to use it

Nodes are not interchangeable once a cluster grows: some have local NVMe,
some are spot instances, some sit in a zone close to a database, some are
licensed for regulated workloads. Node selection is how you express "this
pod needs that kind of machine".

Reach for it when the requirement is a **property of the machine**. Reach
for something else when it is not:

- spreading replicas evenly for availability is
  [topology spread](topology-spread-constraints.md), not affinity;
- keeping unrelated workloads *off* a set of nodes is
  [taints and tolerations](taints-and-tolerations.md), because affinity only
  attracts and cannot repel other people's pods;
- co-locating with or away from other pods is
  [pod affinity](pod-affinity-and-anti-affinity.md).

A common mistake is to use node affinity where a taint is required. Adding
`nodeAffinity` for a GPU label to your own pods does nothing to stop someone
else's pods filling those nodes. Affinity is a statement about where a pod
is willing to go; a taint is a statement the node makes about who may come.

:::best-practice Label the machine, not the workload
Node labels should describe hardware or placement facts (`zone`,
`instance-type`, `disk=nvme`, `gpu=a100`). Labels that encode a team or an
application name turn into a manual allocation table that nobody updates.
:::

## How it works underneath

Node selection is implemented by the `NodeAffinity` plugin of the scheduling
framework, which registers at two extension points:

1. **Filter.** For each node, the plugin evaluates `nodeSelector` and
   `requiredDuringSchedulingIgnoredDuringExecution`. A node that does not
   match is marked infeasible and is never scored. If no node survives
   filtering, the scheduler records a `FailedScheduling` event that counts
   the nodes rejected per predicate, and the pod returns to the queue.
2. **Score.** For each feasible node, the plugin sums the `weight` of every
   `preferredDuringSchedulingIgnoredDuringExecution` term the node matches,
   normalises the sums into the scheduler's 0-100 range and hands them back.
   The final node ranking is the weighted sum over all score plugins, so a
   preference competes with resource balance, image locality and topology
   spread rather than overriding them.

The matching itself is plain label-selector logic evaluated against the
node object in the scheduler's cache. `nodeSelectorTerms` are **ORed**; the
`matchExpressions` inside one term are **ANDed**.

`IgnoredDuringExecution` is the important half of those field names: these
rules are evaluated only when the pod is placed. Relabelling or draining a
node afterwards never moves a running pod — only a `NoExecute`
[taint](taints-and-tolerations.md) or a controller does that. Kubernetes has
never shipped the `RequiredDuringSchedulingRequiredDuringExecution` variant
that the naming hints at.

`matchFields` exists alongside `matchExpressions` for selecting on node
fields rather than labels. The field used in practice is `metadata.name`:
the DaemonSet controller rewrites each of its pods with a `matchFields`
term naming the one node that pod belongs on.

## Basic example

```yaml include="examples/scheduling/node-affinity.yaml"
```

```bash
kubectl apply -f examples/scheduling/node-affinity.yaml
kubectl -n tasklane get pods -o wide -l app.kubernetes.io/name=sched-node-affinity
```

```console include="captures/k8s-advanced/node-affinity-pods.txt"
```

## Explanation

The required term says: the node must be in `zone-a` or `zone-b` **and**
must not carry `node-role.kubernetes.io/control-plane`. Both expressions
live in one term, so they are ANDed. Listing them as two separate terms
under `nodeSelectorTerms` would have ORed them and let control-plane nodes
back in — a frequent and silent mistake.

The preferred terms are scoring hints. A weight of 80 for `zone-a` and 20
for an architecture match means a `zone-a` node starts 100 points ahead in
this plugin's contribution, but a heavily loaded `zone-a` node can still
lose to an empty `zone-b` node once `NodeResourcesFit` and
`NodeResourcesBalancedAllocation` have their say. Weights are integers from
1 to 100; using 1 and 2 rather than 10 and 20 changes nothing, since only
the relative sizes matter within this plugin.

Operators available for `nodeAffinity` are `In`, `NotIn`, `Exists`,
`DoesNotExist`, `Gt` and `Lt`. `NotIn` and `DoesNotExist` give you node
anti-affinity. `Gt` and `Lt` parse both the label value and the supplied
value as integers and are node-affinity-only — they do not exist for pod
affinity, and a non-integer label value makes the pod unschedulable rather
than simply unmatched:

```yaml title="gt-operator.yaml" fragment
affinity:
  nodeAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      nodeSelectorTerms:
        - matchExpressions:
            - key: example.com/cpu-generation
              operator: Gt
              values: ["3"]
```

Note `values` is still a list, and for `Gt` and `Lt` it must contain
exactly one entry.

## Common patterns

**Hard floor, soft preference.** Use one required term for correctness
(architecture, OS, hardware class) and preferred terms for cost or latency
optimisation. This keeps the workload schedulable when the preferred
capacity is exhausted, which matters on the day an availability zone is
degraded.

**Spot with on-demand fallback.** A preferred term on
`karpenter.sh/capacity-type=spot` or your cloud's equivalent label biases
towards cheap capacity without pinning the workload to it. Pair it with a
[PodDisruptionBudget](../k8s-intermediate/pod-disruption-budgets.md), since
spot nodes disappear at short notice.

**Per-profile affinity.** The `NodeAffinity` plugin accepts an
`addedAffinity` argument in a [scheduler
profile](scheduler-internals.md), which the scheduler applies to every pod
that names that profile in `.spec.schedulerName`:

```yaml title="kube-scheduler-config.yaml" fragment
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
profiles:
  - schedulerName: default-scheduler
  - schedulerName: gpu-scheduler
    pluginConfig:
      - name: NodeAffinity
        args:
          addedAffinity:
            requiredDuringSchedulingIgnoredDuringExecution:
              nodeSelectorTerms:
                - matchExpressions:
                    - key: example.com/accelerator
                      operator: Exists
```

Because `addedAffinity` is invisible in the pod spec, it surprises users
who read only their own manifest. Use node label keys that clearly echo the
profile name. The DaemonSet controller does not support profiles.

**Downward API for zone awareness.** Pods inherit
`topology.kubernetes.io/zone` and `.../region` from their node as pod
labels, so an application can read its own zone through the downward API
instead of querying the API server.

## Production considerations

Node affinity is cheap: it is a per-node label evaluation with no
cross-node state, unlike [pod affinity](pod-affinity-and-anti-affinity.md).
The costs are operational, not computational.

- **Cluster autoscaling.** A pending pod's required node affinity has to
  match the labels of a node the autoscaler can actually create. Both
  Cluster Autoscaler and Karpenter simulate scheduling, so an affinity term
  referring to a label no node group carries produces a pod that stays
  `Pending` forever with no scale-up. See
  [cluster autoscaler and Karpenter](cluster-autoscaler-and-karpenter.md).
- **Capacity fragmentation.** Each required term splits the cluster into
  smaller pools. Three teams pinning workloads to three disjoint node sets
  waste more headroom than one shared pool with preferences.
- **Rolling updates.** With `maxUnavailable: 0` and a required affinity
  that already saturates the matching nodes, the new ReplicaSet cannot
  place a single pod and the rollout stalls. Check that the matching pool
  has room for `maxSurge` extra pods.
- **Label drift.** Because the rules are ignored during execution, a
  mislabelled node keeps running pods that no longer belong there. Treat
  node labels as inventory data: set them at node creation (kubelet
  `--node-labels`, node group configuration, or Node Feature Discovery),
  not by hand.

## Security considerations

**Threat.** A compromised kubelet can rewrite its own Node object. If your
isolation model is "regulated workloads only run on nodes labelled
`compliance=pci`", a node that labels itself `compliance=pci` invites those
pods — with their Secrets and service account tokens — onto an attacker's
machine.

**Exploit.** With the node's own credentials an attacker patches the Node:
`kubectl label node evil-node compliance=pci`. The next scheduling cycle
treats it as a valid target for the sensitive workload.

**Fix.** Run the Node authoriser together with the `NodeRestriction`
admission plugin — it is not in the API server's default plugin list, so
check that your distribution passes it in `--enable-admission-plugins` —
and use label keys under the `node-restriction.kubernetes.io/` prefix, which
`NodeRestriction` forbids the kubelet from setting or modifying on itself.
Isolation labels then look like
`example.com.node-restriction.kubernetes.io/pci-dss=true`.

**Verify.** From a node's kubeconfig, attempt the patch and confirm it is
rejected; check that the admission plugin is enabled with
`kubectl -n kube-system describe pod kube-apiserver-<node> | grep enable-admission-plugins`.
Remember that node selection is a scheduling preference, not a security
boundary: pair it with a taint so that untrusted pods cannot opt in to the
sensitive nodes, and with RBAC and
[network policy](../k8s-intermediate/network-policy.md) for the real
boundary.

:::warning `nodeName` bypasses everything
Setting `spec.nodeName` skips the scheduler, so taints, resource checks and
every scheduling plugin are ignored; the kubelet simply tries to run the
pod. A `NoExecute` taint will still evict it afterwards. Anyone who can
create pods with `nodeName` can target the control-plane node directly.
:::

## Troubleshooting

Start from the pod, not the node:

```bash
kubectl -n tasklane describe pod sched-unschedulable
```

```console include="captures/k8s-advanced/unschedulable-describe.txt"
```

The `FailedScheduling` message counts nodes per rejecting predicate, for
example "didn't match Pod's node affinity/selector". Then check reality:

```bash
kubectl get nodes --show-labels
kubectl get nodes -l topology.kubernetes.io/zone=zone-a
kubectl describe node tasklane-worker | head -n 20
```

If the selector looks right but the pod still will not schedule, the
rejection is probably somewhere else in the chain: taints, insufficient
CPU, or a topology spread constraint. The event lists every predicate, so
read all of it rather than the first line.

## Common mistakes

- Splitting ANDed conditions into multiple `nodeSelectorTerms`, which ORs
  them and widens the match instead of narrowing it.
- Expecting node affinity to keep other pods off a node. Use a taint.
- Using `Gt`/`Lt` against a non-integer label value; the pod becomes
  unschedulable rather than falling through to another term.
- Assuming `IgnoredDuringExecution` will be enforced later. Nothing evicts
  a pod when the node labels change.
- Pinning to `kubernetes.io/hostname`. That is `nodeName` with extra steps;
  the pod cannot be rescheduled if that node dies.
- Requiring labels that only exist on nodes the autoscaler cannot create,
  which produces permanently pending pods and no scale-up.
- Putting `nodeSelector` on a DaemonSet expecting it to change the number
  of daemons rather than the set of nodes they run on — it does the latter,
  which is usually what you want, but write it deliberately.

## Related topics

- [Pod affinity and anti-affinity](pod-affinity-and-anti-affinity.md)
- [Taints and tolerations](taints-and-tolerations.md)
- [Topology spread constraints](topology-spread-constraints.md)
- [Scheduler internals](scheduler-internals.md)
- [Cluster Autoscaler and Karpenter](cluster-autoscaler-and-karpenter.md)
- [Labels, selectors and annotations](../k8s-beginner/labels-selectors-annotations.md)
- [Part H labs](labs.md)
