---
title: Taints and tolerations
description: How nodes repel pods, how NoExecute evictions and tolerationSeconds work, and how the built-in node-lifecycle taints drive eviction.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-advanced/node-selection-and-affinity
  - k8s-intermediate/pod-lifecycle-and-termination
---

## Overview

A **taint** is a property of a node that repels pods. A **toleration** is a
property of a pod that lets it ignore a particular taint. Affinity attracts;
taints exclude. They are the only mechanism that keeps *other people's* pods
off a node.

A taint is a triple — key, optional value, effect:

```bash
kubectl taint nodes tasklane-worker maintenance=true:NoSchedule
kubectl taint nodes tasklane-worker maintenance=true:NoSchedule-
```

The trailing `-` removes it. The three effects are:

| Effect | New pods without a matching toleration | Running pods without one |
|---|---|---|
| `NoSchedule` | Not scheduled | Untouched |
| `PreferNoSchedule` | Scheduler tries to avoid the node | Untouched |
| `NoExecute` | Not scheduled | Evicted (after `tolerationSeconds`, if set) |

Evaluation is a filter: start with the node's taints, discard the ones the
pod tolerates, and apply whatever remains. A node with three taints and a
pod tolerating two of them behaves according to the third.

## Why it exists and when to use it

Use taints when the **node** needs to make the decision:

- **Dedicated hardware.** GPU, high-memory or licensed nodes should sit
  idle rather than fill with pods that do not need them. Taint the nodes,
  tolerate in the workloads that do.
- **Specialised node pools.** Windows nodes, Arm nodes, spot pools. A taint
  makes opting in explicit and stops a careless Deployment from spilling
  onto them.
- **Control-plane isolation.** kubeadm taints control-plane nodes
  `node-role.kubernetes.io/control-plane:NoSchedule`; only add-ons that
  tolerate it run there. The kind lab inherits this.
- **Lifecycle signalling.** The control plane taints nodes automatically
  when they become unready, run out of memory or are cordoned. That is how
  eviction on node failure is implemented.

Taints permit; they do not attract. A pod that tolerates
`gpu=true:NoSchedule` may still be scheduled onto an ordinary node. To pin
it, add node affinity or a `nodeSelector` on a matching label. The pairing
"taint + label, toleration + affinity" is the standard dedicated-node
recipe.

## How it works underneath

Three components share the work:

1. **kube-scheduler.** The `TaintToleration` plugin filters out nodes with
   an untolerated `NoSchedule` or `NoExecute` taint, and scores down nodes
   with an untolerated `PreferNoSchedule` taint.
2. **The node controller and kubelet.** With the `TaintNodesByCondition`
   admission plugin (enabled by default), node conditions become taints:
   `node.kubernetes.io/memory-pressure`, `disk-pressure`, `pid-pressure`,
   `network-unavailable`, `unschedulable`, plus
   `node.kubernetes.io/not-ready` (Ready is `False`) and
   `node.kubernetes.io/unreachable` (Ready is `Unknown`). The scheduler
   looks at taints, never at conditions, so scheduling stays uniform.
   `node.cloudprovider.kubernetes.io/uninitialized` holds pods off a node
   until the cloud controller manager has finished initialising it.
3. **The taint-eviction-controller.** Since 1.29 this is a separate
   controller inside kube-controller-manager (disable with
   `--controllers=-taint-eviction-controller`). It watches `NoExecute`
   taints and deletes pods that do not tolerate them, honouring each pod's
   `tolerationSeconds`. The control plane rate-limits how fast new taints
   are added, which is what stops a network partition from evicting an
   entire cluster at once.

`kubectl cordon` does not add a taint by hand: it sets
`.spec.unschedulable`, and the control plane derives the
`node.kubernetes.io/unschedulable:NoSchedule` taint from it. `kubectl
drain` then deletes the pods, respecting
[PodDisruptionBudgets](../k8s-intermediate/pod-disruption-budgets.md) —
that is an API-initiated eviction, not a taint eviction.

### The 300-second default you did not write

The `DefaultTolerationSeconds` admission plugin (enabled by default) adds
these two tolerations to every pod that has not specified them:

```yaml title="default-tolerations.yaml" fragment
tolerations:
  - key: node.kubernetes.io/not-ready
    operator: Exists
    effect: NoExecute
    tolerationSeconds: 300
  - key: node.kubernetes.io/unreachable
    operator: Exists
    effect: NoExecute
    tolerationSeconds: 300
```

So a pod on a node that stops reporting is deleted **five minutes** later,
not immediately. The value comes from the kube-apiserver flags
`--default-not-ready-toleration-seconds` and
`--default-unreachable-toleration-seconds`. Shorten it per workload by
writing the tolerations yourself; the admission plugin leaves existing ones
alone.

DaemonSet pods get stronger defaults from the DaemonSet controller:
`NoExecute` tolerations with no `tolerationSeconds` for `not-ready` and
`unreachable`, plus `NoSchedule` tolerations for the pressure taints and
`unschedulable` (and `network-unavailable` for host-network daemons). That
is why node agents keep running on a node everything else has left.

## Basic example

```yaml include="examples/scheduling/taints-tolerations.yaml"
```

```bash
kubectl taint nodes tasklane-worker maintenance=true:NoSchedule
kubectl apply -f examples/scheduling/taints-tolerations.yaml
kubectl -n tasklane get pods -o wide -l app.kubernetes.io/name=sched-toleration
kubectl taint nodes tasklane-worker maintenance=true:NoSchedule-
```

```console include="captures/k8s-advanced/taint-toleration-pods.txt"
```

## Explanation

The first toleration matches the taint exactly: same key, same value, same
effect, `operator: Equal` (the default). `operator: Exists` with no `value`
matches any value for that key — useful when the value encodes something
variable, such as a maintenance window ID.

Two special cases fall out of the matching rules:

- An **empty `key` with `operator: Exists`** matches *every* taint with
  that effect. Combined with an empty `effect`, it tolerates everything the
  cluster can throw at a node.
- An **empty `effect`** matches all three effects for that key.

The demo's second and third tolerations replace the admission-injected
300-second defaults with 60 seconds, so these pods are deleted a minute
after their node stops reporting rather than after five. Shorter is not
always better: the pod cannot be recreated elsewhere until the old one is
gone, but a node that is merely slow to report will kill the pod
unnecessarily. Sixty seconds suits a stateless replica; a stateful pod with
a large local cache is often better off waiting longer.

`tolerationSeconds` only applies to `NoExecute`. On `NoSchedule` it is
meaningless (and the API rejects it).

:::note Numeric toleration operators are alpha
Kubernetes 1.35 added `Gt` and `Lt` toleration operators behind the
`TaintTolerationComparisonOperators` feature gate. They are **alpha, off by
default, and not for production** in 1.37: both values must parse as signed
64-bit integers, and a non-numeric taint value simply never matches.
:::

## Common patterns

**Dedicated node pool.** Taint and label the nodes, then tolerate and
select in the workload:

```yaml title="dedicated-nodes.yaml" fragment
spec:
  tolerations:
    - key: dedicated
      operator: Equal
      value: payments
      effect: NoSchedule
  nodeSelector:
    dedicated: payments
```

**Draining with intent.** `kubectl taint nodes <node>
maintenance=true:NoExecute` empties a node while leaving DaemonSets in
place, and pods with a long `tolerationSeconds` get a grace window. For
planned work prefer `kubectl drain`, which respects PodDisruptionBudgets;
taint-based eviction does not.

**Extended-resource hardware.** Taint accelerator nodes with the extended
resource name and enable the `ExtendedResourceToleration` admission plugin
(not enabled by default): pods that request the resource get the toleration
added automatically, so no one has to remember it.

**Device-level taints.** With
[dynamic resource allocation](dynamic-resource-allocation.md), individual
devices can be tainted rather than whole nodes, using `DeviceTaintRule`
(**GA in 1.37**, feature gate `DRADeviceTaints`). A failing GPU stops
accepting claims while the node keeps serving everything else.

## Production considerations

- **Bootstrap ordering.** A cluster whose CNI has not started yet has nodes
  tainted `not-ready`; only pods tolerating it (the CNI DaemonSet) can run.
  If you taint aggressively at node creation, make sure the node agents
  tolerate your taint too, or the node never becomes usable.
- **Toleration sprawl.** Once one team adds a blanket
  `operator: Exists` toleration to a base template, every workload inherits
  it and the taints stop meaning anything. Audit for tolerations with an
  empty key.
- **Eviction storms.** Lowering `--default-not-ready-toleration-seconds`
  globally converts brief control-plane hiccups into cluster-wide
  rescheduling. Change it per workload instead.
- **Autoscaling.** Cluster Autoscaler and Karpenter simulate taints, so a
  pending pod scales up a pool only if the new node's taints are tolerated.
  Karpenter node pools declare their taints explicitly for this reason.
- **Capacity accounting.** Tainted nodes still count in cluster-wide
  utilisation dashboards while being unavailable to most workloads. Track
  the dedicated pools separately or the numbers will mislead you.

## Security considerations

**Threat.** Tolerations are a pod-spec field with no default restrictions.
A user who can create a pod in any namespace can tolerate
`node-role.kubernetes.io/control-plane:NoSchedule` and get scheduled onto a
control-plane node, next to etcd and the API server's credentials on disk.
The same trick defeats node pools dedicated to another tenant.

**Exploit.** In the lab, add

```yaml title="tolerate-everything.yaml" fragment
spec:
  tolerations:
    - operator: Exists
```

to a pod, plus a `nodeSelector` of
`node-role.kubernetes.io/control-plane: ""`. The pod schedules onto the
control-plane node; a hostPath mount or a container escape from there
reaches `/etc/kubernetes/pki`.

**Fix.** Taints are not an authorisation control. Restrict who may set
tolerations with a validating
[admission policy](admission-policies-cel.md) (ValidatingAdmissionPolicy is
GA since 1.30) that rejects pods tolerating reserved keys outside
`kube-system`, and keep control-plane nodes out of reach with RBAC on pod
creation in privileged namespaces. The `PodTolerationRestriction` admission
plugin can whitelist tolerations per namespace, but it has been **alpha
since 1.7** and is not enabled by default, so treat it as optional rather
than the primary control. Combine with
[Pod Security Admission](../k8s-security/pod-security-standards.md) so that
landing on a node is not the same as owning it.

**Verify.** Apply the exploit pod in the lab and confirm the policy rejects
it; then run `kubectl get pods -A -o wide` and check that nothing outside
`kube-system` is scheduled on a control-plane node.

## Troubleshooting

```bash
kubectl describe node tasklane-worker | grep -A3 Taints
kubectl get nodes -o custom-columns=NAME:.metadata.name,TAINTS:.spec.taints
kubectl -n tasklane describe pod <pending-pod>
```

Typical messages:

| Symptom | Reading |
|---|---|
| `node(s) had untolerated taint {key: value}` | Missing toleration; add it or remove the taint |
| Pod evicted moments after a node blip | `NoExecute` lifecycle taint plus the default 300 s (or your shorter value) |
| Pods refuse to schedule cluster-wide after a node event | Conditions such as disk pressure taint many nodes at once |
| A cordoned node still runs pods | `unschedulable` is `NoSchedule`, not `NoExecute`; cordon never evicts |

If a taint you removed appears again, a controller is recreating it from a
node condition — fix the condition, not the taint.

## Common mistakes

- Expecting a toleration to *place* a pod on the tainted node. It only
  permits; add affinity or a `nodeSelector` to attract.
- Tolerating with `operator: Exists` and no key "to be safe", which
  tolerates control-plane, pressure and maintenance taints as well.
- Setting `tolerationSeconds` on a `NoSchedule` toleration; the field only
  affects `NoExecute`.
- Using `NoExecute` for planned maintenance instead of `kubectl drain`,
  which skips PodDisruptionBudgets entirely.
- Assuming `kubectl cordon` evicts anything.
- Forgetting that DaemonSets tolerate the node-condition taints, so a "put
  the node into maintenance" taint with a custom key must also be tolerated
  by, or excluded from, your node agents.
- Lowering the cluster-wide toleration defaults instead of setting them on
  the workloads that genuinely need fast failover.

## Related topics

- [Node selection and node affinity](node-selection-and-affinity.md)
- [Topology spread constraints](topology-spread-constraints.md)
- [Priority and preemption](priority-and-preemption.md)
- [Dynamic resource allocation](dynamic-resource-allocation.md)
- [Pod disruption budgets](../k8s-intermediate/pod-disruption-budgets.md)
- [Pod lifecycle and termination](../k8s-intermediate/pod-lifecycle-and-termination.md)
- [Part H labs](labs.md)
