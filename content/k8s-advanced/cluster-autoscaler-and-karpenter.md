---
title: Cluster Autoscaler and Karpenter
description: How nodes appear and disappear — node-group simulation in Cluster Autoscaler, just-in-time provisioning and consolidation in Karpenter, and how to choose.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-advanced/horizontal-pod-autoscaler
  - k8s-intermediate/pod-disruption-budgets
---

## Overview

Pod autoscalers change how many pods you have. Node autoscalers change how
much cluster you are paying for. Without one, an [HPA](horizontal-pod-autoscaler.md)
that wants forty replicas on a cluster with room for twelve simply produces
twenty-eight `Pending` pods.

Two projects dominate:

- **Cluster Autoscaler** (CA), part of `kubernetes/autoscaler`, scales
  pre-defined **node groups** — an AWS Auto Scaling group, a GCP managed
  instance group, an Azure VM scale set — up and down by changing their
  desired size.
- **Karpenter** (**v1.14.1**), a CNCF project whose core lives in
  `kubernetes-sigs/karpenter` with a provider implementation per cloud,
  skips node groups. It looks at pending pods and asks the cloud provider
  directly for an instance that fits them.

Neither runs in a kind cluster: both create real machines through a cloud
API, and kind has none. The manifest on this page is reference material, not
a lab exercise.

:::note Cluster Autoscaler versions track Kubernetes minors
CA is released per Kubernetes minor version, and the latest release is
**1.36.1** — there is **no 1.37 release yet**. Use the newest CA that matches
your cluster's minor version, and check before you upgrade the cluster.
:::

## Why it exists and when to use it

A cluster with fixed capacity is either too big most of the time or too small
at the worst possible moment. Node autoscaling closes that gap, but only if
the rest of the setup cooperates: pods must have accurate requests
(scheduling is driven by requests, not usage), workloads must tolerate being
moved, and anything that must not move needs a
[PodDisruptionBudget](../k8s-intermediate/pod-disruption-budgets.md).

You do not need a node autoscaler when the cluster is small and static, when
you are on bare metal with a fixed fleet (although CA does have providers for
some on-premises systems), or when your workload's peak fits comfortably in
the capacity you already pay for.

You emphatically do need one when an HPA or [KEDA](keda.md) can multiply your
pod count by ten, or when you run bursty batch work that would otherwise idle
on reserved capacity.

## How it works underneath

### Cluster Autoscaler

CA runs a control loop, by default every 10 seconds
(`--scan-interval`).

**Scale-up.** It lists unschedulable pods. For each node group it builds a
*template node* — the group's machine type, labels and taints — and simulates
whether the pending pods would schedule on a new node of that shape. Node
groups must therefore be homogeneous: CA assumes every machine in a group has
identical capacity and the same labels. If several groups could work, an
**expander** chooses:

| Expander | Choice |
|---|---|
| `random` | Any eligible group. |
| `most-pods` | The group that would schedule the most pending pods. |
| `least-waste` | The group leaving the least idle CPU (then memory) after scale-up. This is the default. |
| `least-nodes` | The group needing the fewest new nodes. |
| `price` | The cheapest group whose machines suit the cluster size. Provider-specific. |
| `priority` | The group with the highest user-assigned priority. |

Since CA 1.23 you can pass several, comma-separated, and the later ones break
ties: `--expander=priority,least-waste`.

**Scale-down.** A node becomes a candidate when its CPU and memory *requests*
are below `--scale-down-utilization-threshold` (0.5, that is 50% of
allocatable) and it has stayed that way for `--scale-down-unneeded-time` (10
minutes), and when every pod on it can be placed somewhere else. Pods that
block scale-down include those with restrictive PodDisruptionBudgets, pods in
`kube-system` without a PDB, pods using local storage (`hostPath`, or
`emptyDir` that is not memory-backed), pods annotated
`cluster-autoscaler.kubernetes.io/safe-to-evict: "false"`, and anything on a
node annotated `cluster-autoscaler.kubernetes.io/scale-down-disabled: "true"`.

The mental model that matters: **CA never picks an instance type.** It can
only make an existing group bigger or smaller. The shape of your nodes is
your problem, expressed as node groups.

### Karpenter

Karpenter inverts that. You define a **NodePool** (`karpenter.sh/v1`)
describing the *space* of acceptable nodes — architectures, capacity types,
zones, limits — and a provider-specific **NodeClass** holding the cloud
details (on AWS, an `EC2NodeClass` in `karpenter.k8s.aws/v1` with the IAM
role, AMI, subnets and security groups). When pods are pending, Karpenter
bin-packs them itself, picks an instance type that fits, and launches it —
then registers a `NodeClaim` tracking that machine's lifecycle.

Removing capacity is called **disruption**, and it comes in flavours:

- **Consolidation**, rate-limited by budgets. `consolidationPolicy` is
  `WhenEmpty` (remove nodes with no workload pods), `WhenEmptyOrUnderutilized`
  (also replace or remove underutilised nodes) or `Balanced` (consolidate when
  the saving outweighs the disruption). `consolidateAfter` sets how long a
  node must look consolidatable first.
- **Drift**, when the node no longer matches its NodePool or NodeClass —
  for example after you change the AMI.
- **Expiration** (`expireAfter`), **interruption** handling for spot
  reclamation and provider maintenance events, and node auto-repair. These
  are forceful: budgets do not hold them back.

Termination is orderly: a finalizer on the node blocks deletion, Karpenter
taints it `karpenter.sh/disrupted:NoSchedule`, evicts pods through the
Eviction API so PodDisruptionBudgets are respected, waits for volume
attachments to clear, terminates the machine and only then removes the
finalizer. A pod annotated `karpenter.sh/do-not-disrupt: "true"` (or with a
duration such as `"30m"`) is excluded from voluntary disruption — but not
from the forceful kinds.

### Side by side

| | Cluster Autoscaler | Karpenter |
|---|---|---|
| Unit of capacity | Node group defined outside the cluster | Individual node, chosen per pending pod |
| Instance selection | Yours, per group | Karpenter's, from the NodePool's requirements |
| Scale-up latency | Cloud autoscaling group reaction | Direct instance launch; generally faster |
| Removing capacity | Utilisation threshold plus unneeded time | Consolidation policies plus budgets |
| Configuration surface | Controller flags | CRDs (`NodePool`, `NodeClass`, `NodeClaim`) |
| Providers | Very many, including several on-premises | AWS (reference implementation), plus other provider repositories — check yours |
| Versioning | Matched to the Kubernetes minor (1.36.1 latest) | Independent (v1.14.1) |

## Basic example

```yaml include="examples/autoscaling/karpenter-nodepool.yaml"
```

## Explanation

`spec.template.spec` is a pod-template-like description of the nodes this
pool may create. The `requirements` are ordinary node label selectors:
Karpenter only considers instance types whose labels satisfy them, so
restricting `kubernetes.io/arch` to `amd64` and `arm64` and
`karpenter.sh/capacity-type` to `on-demand` narrows a cloud catalogue of
hundreds of instance types to the ones you are willing to pay for. Adding
`"spot"` to the capacity types lets Karpenter mix in interruptible capacity.

`nodeClassRef` is the provider hand-off: `group`, `kind` and `name` of an
object that Karpenter's provider implementation understands. That object is
deliberately absent from this repository — its contents are cloud-specific,
and inventing plausible-looking AWS fields would be worse than sending you to
the provider's documentation.

`expireAfter: 720h` gives every node a 30-day maximum life, which is how you
get patched AMIs into the fleet without a migration project.
`terminationGracePeriod: 48h` bounds how long draining may block; without it,
a pod that never terminates blocks the node forever.

The `disruption` block is the cost lever. `WhenEmptyOrUnderutilized` with
`consolidateAfter: 1m` is aggressive: Karpenter will actively replace a
half-empty node with a smaller one. The budgets then say "never more than 10%
of this pool's nodes at once, and nothing at all during the working day" —
which is how you get the savings without the pager.

## Common patterns

### One pool per workload class

A default pool for general workloads, a second with GPU or high-memory
requirements and a taint, a third for spot-tolerant batch. Use `weight` to
decide which pool wins when both could take a pod, and taints plus
[tolerations](taints-and-tolerations.md) to keep the expensive pool for the
workloads that need it.

### Pair it with pod autoscaling

The chain is: metric rises → HPA or KEDA adds replicas → pods go `Pending`
because nothing fits → node autoscaler adds a node → pods schedule. Every
link has its own latency, and the node link is the slowest (instance launch,
boot, join, image pull). Keep a little headroom — for example, a low-priority
"balloon" Deployment that is
[preempted](priority-and-preemption.md) when real work arrives — if your
traffic pattern cannot wait for a machine.

### Overprovisioning versus responsiveness

Both autoscalers only act on pods that are already pending, which means the
first burst always waits. The remedies are the same either way: run a small
number of pause pods at negative priority, or set `minReplicas` high enough
that the first minute of a spike lands on capacity you already have.

### Consolidation with guardrails

Turn consolidation on together with PodDisruptionBudgets for every
multi-replica workload, disruption budgets on the NodePool, and
`karpenter.sh/do-not-disrupt` on the handful of pods that genuinely cannot be
moved. Consolidation without PDBs is how a cost-saving change becomes an
availability incident.

## Production considerations

**Requests drive everything.** Both autoscalers simulate scheduling, which
uses requests. Systematically over-requested pods mean you buy nodes you do
not need; under-requested pods mean nodes that are full in reality and
"underutilised" on paper. This is where the
[VPA's recommendations](vertical-pod-autoscaler.md) pay for themselves.

**Zones and volumes.** A pod bound to a PersistentVolume in one zone can only
be scheduled there. With CA, that means one node group per zone; with
Karpenter, a zone requirement derived from the volume. Getting this wrong
produces nodes in the wrong zone and pods that stay `Pending` anyway.

**Spot is not free money.** Interruptible capacity needs workloads that
tolerate a two-minute warning: multiple replicas, PDBs, a
[termination](../k8s-intermediate/pod-lifecycle-and-termination.md) path that
finishes in time, and preferably a mix with on-demand capacity for the
critical fraction.

**Daemons scale with nodes.** Every new node runs your
[DaemonSets](../k8s-intermediate/daemonsets.md) — log shippers, CNI, agents —
and each reserves CPU and memory. Very small instance types can be mostly
daemon; Karpenter accounts for this in its bin-packing, but you should sanity
check the resulting allocatable.

**Scale-down is where the money is, and where the risk is.** Tune
`--scale-down-unneeded-time` or `consolidateAfter` in the direction you can
defend, watch the eviction rate for a week, and only then tighten it.

## Security considerations

**Threat: a node autoscaler holds cloud credentials that can create and
destroy machines.** It is one of the most powerful identities attached to a
cluster. Anything that can make pods pending can make it spend money;
anything that can read its credentials can create instances outside the
cluster entirely.

**Exploit.** A tenant with permission to create pods in their own namespace
submits a Deployment with `replicas: 500` and `requests: {cpu: "4"}`. Nothing
schedules, the autoscaler happily provisions dozens of machines, and the
cluster bill grows until someone notices. No exploit code is involved — it is
the system working as designed, with no ceiling.

**Fix.** Put a ceiling on every layer: `limits` on the NodePool (`cpu`,
`memory`, and `nodes` where supported) or `--max-nodes-total` for CA, a
[ResourceQuota](../k8s-intermediate/limitrange-and-resourcequota.md) per
tenant namespace, and sane `maxReplicas` on every HPA. Run the autoscaler's
credentials as a narrowly scoped cloud role restricted to the instance
profiles, subnets and tags it needs, and prefer workload identity over static
keys. The autoscaler's ServiceAccount also needs broad cluster RBAC (it reads
pods and nodes and deletes nodes) — keep it out of reach: dedicated
namespace, no shared ServiceAccount, and no tenant workloads with
`get secrets` there. Finally, alert on node count and on cloud spend, not
just on pod counts.

**Verify.**

```bash
kubectl -n tasklane describe resourcequota
kubectl get nodepools -o custom-columns=NAME:.metadata.name,LIMITS:.spec.limits
kubectl auth can-i delete nodes --as system:serviceaccount:karpenter:karpenter
```

The last one should return `yes` only for the autoscaler's own
ServiceAccount, and you should be able to name every other identity that can.

## Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| Pods `Pending`, no new nodes | Requests exceed any available machine shape; or node group at max; or NodePool `limits` reached | `kubectl describe pod` events; autoscaler logs |
| Nodes added but pods still `Pending` | Taints, node selectors, topology or volume zone constraints not satisfied | Compare pod constraints with the new node's labels and taints |
| CA adds the wrong node group | Expander choice | `--expander` setting; try `priority` |
| Nothing ever scales down | Pods with local storage, `kube-system` pods without PDBs, `safe-to-evict: "false"`, or a PDB that blocks every eviction | `kubectl get pdb -A`; CA logs name the blocking pod |
| Karpenter replaces nodes constantly | `consolidationPolicy: WhenEmptyOrUnderutilized` with a short `consolidateAfter` | Lengthen it, or move to `WhenEmpty` |
| Node stuck terminating | Finalizer waiting on a pod that will not evict, or on volume detachment | `kubectl get node -o yaml`; check PDBs and `do-not-disrupt` |
| Nodes come back with the old image | Drift not detected because the NodeClass still points at the old AMI | Check the NodeClass and `expireAfter` |

## Common mistakes

- **Scaling pods without scaling nodes.** A high `maxReplicas` on a fixed
  cluster is a queue of `Pending` pods with extra steps.
- **Heterogeneous node groups with CA.** The simulation assumes every machine
  in a group is identical; mixed groups produce wrong decisions.
- **No PodDisruptionBudgets.** Scale-down and consolidation both use the
  Eviction API, and without PDBs there is nothing to say "not all of them at
  once".
- **`emptyDir` on a workload you want to be consolidatable.** It counts as
  local storage and blocks CA scale-down.
- **Expecting instant capacity.** Instance launch plus boot plus image pull
  is minutes, not seconds.
- **Unbounded NodePools.** `limits` is the only thing between a
  misconfigured workload and an unbounded cloud bill.
- **Running Cluster Autoscaler from the wrong branch.** Match its minor
  version to the cluster's; there is no 1.37 release yet.

## Related topics

- [Horizontal Pod Autoscaler](horizontal-pod-autoscaler.md)
- [Vertical Pod Autoscaler](vertical-pod-autoscaler.md)
- [KEDA](keda.md)
- [Taints and tolerations](taints-and-tolerations.md)
- [Priority and preemption](priority-and-preemption.md)
- [Pod disruption budgets](../k8s-intermediate/pod-disruption-budgets.md)
- [Node selection and affinity](node-selection-and-affinity.md)
