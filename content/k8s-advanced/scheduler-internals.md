---
title: Scheduler internals
description: The scheduling queue, the scheduling framework's extension points, KubeSchedulerConfiguration profiles, and how to extend or replace kube-scheduler.
level: expert
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-advanced/priority-and-preemption
  - k8s-advanced/topology-spread-constraints
---

## Overview

kube-scheduler is a control loop that watches for pods with an empty
`spec.nodeName`, decides where each one should run, and writes that
decision through the `Binding` subresource. Everything else — affinity,
taints, spreading, preemption, device allocation — is a **plugin** inside
the scheduling framework (stable since 1.19).

Each attempt at one pod is split into two phases:

| Phase | What happens | Concurrency |
|---|---|---|
| Scheduling cycle | PreFilter → Filter → PostFilter → PreScore → Score → NormalizeScore → Reserve → Permit | One pod at a time, serially |
| Binding cycle | WaitOnPermit → PreBind → Bind → PostBind | Cycles for different pods run concurrently |

Together they are one "scheduling context". A failure in either returns the
pod to the queue and triggers `Unreserve` on every Reserve plugin, in
reverse order.

```console include="captures/k8s-advanced/kube-scheduler-pod.txt"
```

## Why it exists and when to use it

Most clusters never touch this machinery, and that is the correct default:
the built-in plugins cover node selection, spreading, resources, volumes
and preemption. You need the internals when:

- a pod is stuck `Pending` and the event text is not enough — you have to
  know which extension point rejected it;
- placement depends on something Kubernetes cannot see (a licence server, a
  network fabric, a batch queue) and you must write a plugin or run a
  second scheduler;
- scheduling **throughput** is the bottleneck, and `percentageOfNodesToScore`
  or plugin choice has to change;
- you run AI/ML or HPC workloads and need all-or-nothing placement, which
  is what gang scheduling addresses.

Writing a custom scheduler plugin is a real commitment: it is Go code
compiled into a scheduler binary that you then build, sign, deploy and
upgrade in lockstep with Kubernetes. Before that, check whether a
scheduling profile, a plugin argument or an existing project such as
Kueue or the SIG-Scheduling
[scheduler-plugins](https://github.com/kubernetes-sigs/scheduler-plugins)
repository already solves it.

## How it works underneath

### The scheduling queue

Unscheduled pods live in three internal structures:

- **activeQ** — a heap ordered by the `QueueSort` plugin (by default
  priority, then the time the pod became schedulable). The scheduler pops
  from here.
- **backoffQ** — pods whose last attempt failed, held for an exponentially
  growing period. `podInitialBackoffSeconds` defaults to **1** and
  `podMaxBackoffSeconds` to **10**, so a pod that keeps failing is retried
  at most every ten seconds.
- **unschedulablePods** — pods parked because no node could run them.
  They wait for an event that might change the answer, and a background
  flush moves leftovers back every 30 seconds so nothing is stranded.

**Queueing hints** (`SchedulerQueueingHints`, **GA in 1.34**) are what make
that third structure efficient. Instead of requeuing every parked pod on
every cluster event, each plugin declares which events could matter to a
pod it rejected, and only those pods move. `SchedulerPopFromBackoffQ`
(Beta, on by default since 1.33) lets the scheduler take work from the
backoffQ when the activeQ is empty rather than idling. `OpportunisticBatching`
(Beta, on by default since 1.35) caches the filter and score results of one
scheduling cycle and reuses them for equivalent pods that arrive back to
back — the replicas of one Deployment — with the cache expiring after half
a second. It deliberately skips pods that use inter-pod affinity, topology
spread or DRA claims, and it only helps if the cluster-level default
topology spread constraints are set to an empty list.

Before a pod reaches the activeQ at all, `PreEnqueue` plugins must all
return success. This is where `spec.schedulingGates` is enforced (scheduling
readiness, **GA in 1.30**): a gated pod is not "unschedulable", it is not
yet a candidate, and it carries no `Unschedulable` condition. Controllers
use gates to hold pods until quota, a dataset or a licence is ready.

### Extension points

| Point | Purpose | Can reject? |
|---|---|---|
| `PreEnqueue` | Admit a pod into the active queue | Yes, silently parks it |
| `QueueSort` | Order the queue; exactly one plugin may be enabled | No |
| `PreFilter` | Precompute state, check pod-level preconditions | Yes, ends the cycle |
| `Filter` | Per node: can this pod run here? | Yes, marks the node infeasible |
| `PostFilter` | Runs only when no node is feasible; preemption lives here | May make the pod schedulable |
| `PreScore` | Precompute shared state for scoring | Yes, ends the cycle |
| `Score` | Rank each feasible node | No |
| `NormalizeScore` | Rescale one plugin's scores before weighting | Yes, ends the cycle |
| `Reserve` / `Unreserve` | Book in-memory state before binding; roll it back on failure | `Reserve` yes; `Unreserve` must not fail |
| `Permit` | Approve, deny or **wait** with a timeout before binding | Yes |
| `PreBind` | Do work that must precede binding, such as attaching a volume | Yes |
| `Bind` | Write the Binding; the first plugin that handles the pod wins | Yes |
| `PostBind` | Informational cleanup | No |

Kubernetes 1.37 adds extension points that only apply to PodGroup
scheduling: `placementGenerate` and `placementScore` propose and rank whole
placements, `placementFeasible` decides whether a partial placement can
still satisfy the group, and `podGroupPostFilter` is the group-level
equivalent of `PostFilter`.

### Default plugins

Enabled by default, among others: `PrioritySort` (queueSort),
`NodeName`, `NodeUnschedulable`, `NodePorts`, `NodeAffinity`,
`NodeResourcesFit`, `TaintToleration`, `InterPodAffinity`,
`PodTopologySpread`, `VolumeBinding`, `VolumeRestrictions`, `VolumeZone`,
`NodeVolumeLimits`, `EBSLimits`, `GCEPDLimits`, `AzureDiskLimits`,
`ImageLocality`, `NodeResourcesBalancedAllocation`, `DefaultPreemption`
(postFilter) and `DefaultBinder` (bind). `NodeResourcesFit` scores with
`LeastAllocated` by default, and can be switched to `MostAllocated` or
`RequestedToCapacityRatio` for bin-packing.

### Filtering is not exhaustive

`percentageOfNodesToScore` stops the Filter phase once enough feasible
nodes are found. Left unset, Kubernetes scales it linearly from 50% at 100
nodes to 10% at 5000 nodes, with a floor of 5% — and clusters below roughly
100 nodes are always searched fully. The scheduler also remembers where it
stopped and resumes from there next time, so nodes are not starved. Raising
it improves placement quality at the cost of latency; lowering it does the
reverse and does nothing at all in a small cluster.

## Basic example

A second profile in the same scheduler process, selected by a pod's
`spec.schedulerName`:

```yaml title="kube-scheduler-config.yaml" fragment
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
parallelism: 16
podInitialBackoffSeconds: 1
podMaxBackoffSeconds: 10
percentageOfNodesToScore: 0
profiles:
  - schedulerName: default-scheduler
  - schedulerName: binpack-scheduler
    plugins:
      score:
        disabled:
          - name: NodeResourcesBalancedAllocation
    pluginConfig:
      - name: NodeResourcesFit
        args:
          scoringStrategy:
            type: MostAllocated
```

```yaml title="pod-with-scheduler-name.yaml" fragment
spec:
  schedulerName: binpack-scheduler
```

Every profile in one process must use the same `queueSort` plugin, because
there is only one queue. `percentageOfNodesToScore: 0` means "use the
built-in formula", and may also be overridden per profile.

## Explanation

Profiles are the cheapest extension mechanism: one scheduler binary, one
leader election, several behaviours. A pod opts in with `schedulerName`;
kube-apiserver sets it to `default-scheduler` when it is omitted, so a
profile with that name must exist or ordinary pods never get scheduled.

`multiPoint` is the shorthand for enabling a plugin at every extension
point it implements; explicit extension-point entries always take
precedence over `multiPoint` entries, which is how you reorder or reweight
default plugins without listing them all.

Three other ways to change placement, in increasing order of cost:

1. **Plugin arguments.** `NodeResourcesFit`, `PodTopologySpread`,
   `NodeAffinity` (`addedAffinity`), `DynamicResources` and `InterPodAffinity`
   all take arguments; most tuning needs nothing more.
2. **A second scheduler deployment.** Run another kube-scheduler (or a
   third-party one) with its own name and give it the RBAC it needs. Pods
   choose it by `schedulerName`. Two schedulers do not share a cache, so
   they can race for the same node and lose a binding — acceptable for
   batch pools, risky for everything else.
3. **Extenders and custom plugins.** `extenders` in the configuration call
   an HTTP service during filter/score/bind; they are slow and legacy.
   Compiled-in plugins are the supported path.

### Gang scheduling

Workload-level scheduling arrived through the Workload API. A `PodGroup`
(`scheduling.k8s.io/v1beta1`) with a `gang` policy and a `minCount` makes
the scheduler hold its pods at `PreEnqueue` until enough pods exist, then
place them as one atomic decision: either `minCount` pods are bound or none
are. Workload-aware preemption picks victims at group granularity instead
of pod by pod.

Both behaviours are controlled by the `GenericWorkload` feature gate, which
is **Beta in 1.37 and off by default** (the separate `GangScheduling` and
`WorkloadAwarePreemption` gates were removed in 1.37 and folded into it).
The `scheduling.k8s.io/v1beta1` API group must also be enabled. Hierarchical
groups via `CompositePodGroup` are alpha, off by default and not for
production. Until these are on by default, gang scheduling in production
means Kueue, Volcano or the scheduler-plugins coscheduling plugin.

## Common patterns

**Bin-packing pool.** A `MostAllocated` profile for batch workloads packs
nodes tightly so the autoscaler can remove empty ones, while the default
profile keeps latency-sensitive services spread.

**Gated admission.** A controller creates pods with a `schedulingGate` and
removes it when a dataset is staged or a quota is granted. The pods sit
outside the active queue, costing the scheduler nothing.

**Placement-quality debugging.** Raise scheduler verbosity temporarily
(`-v=4`) on a test cluster to log per-plugin scores. Never leave it on: it
is extremely noisy and costs throughput.

**Throughput tuning.** `parallelism` (default 16) controls how many
goroutines evaluate nodes in the Filter and Score phases;
`percentageOfNodesToScore` controls how many nodes are looked at. Change
one at a time and measure.

## Production considerations

- **One scheduler is a single writer.** kube-scheduler runs active/passive
  with leader election. Scheduling throughput does not scale by adding
  replicas; it scales by making cycles cheaper.
- **Watch the queue, not just the pods.** `scheduler_pending_pods` is
  broken down by queue (active, backoff, unschedulable, gated).
  `scheduler_schedule_attempts_total` counts results by outcome, and
  `scheduler_pod_scheduling_sli_duration_seconds` is the end-to-end
  latency. `scheduler_framework_extension_point_duration_seconds` and
  `scheduler_plugin_execution_duration_seconds` show which plugin is slow.
- **Expensive plugins are your choice.** `InterPodAffinity` and, to a
  lesser degree, `PodTopologySpread` dominate cycle time in large clusters.
  The cheapest optimisation is usually removing a cluster-wide
  anti-affinity rule.
- **Version skew.** kube-scheduler may be at most one minor version older
  than kube-apiserver and never newer. `KubeSchedulerConfiguration` has
  been `kubescheduler.config.k8s.io/v1` since 1.25; `v1beta3` was removed
  in 1.29.
- **Binding failures are normal.** With concurrent binding cycles, a node
  can fill between Reserve and Bind. The pod returns to the queue; a flat
  rate of these is expected, a spike is a symptom.
- **Third-party schedulers.** Kueue (queueing and quota), Volcano and Yunikorn
  (batch/HPC) all layer on the framework rather than replacing it. Prefer
  them to a bespoke scheduler.

## Security considerations

**Threat.** Deciding placement means being able to write
`pods/binding`. Anyone holding that permission — a custom scheduler's
ServiceAccount, an over-broad Role, or a workload granted "just enough to
schedule" — can bind any pod to any node, including the control-plane node,
**bypassing every filter plugin**: taints, node affinity, topology spread
and resource fit are all evaluated by the scheduler, not by the API server.
The same applies to `create` on pods with `spec.nodeName` set.

**Exploit.** In the disposable lab: with a token that can create Binding
objects, bind a pod that mounts a `hostPath` onto the control-plane node.
The kubelet there runs it because a binding is authoritative, and
`/etc/kubernetes/pki` becomes readable.

**Fix.** Treat `pods/binding`, `bindings` and pod creation with `nodeName`
as cluster-admin-level permissions. Audit Roles for them; run custom
schedulers under their own ServiceAccount, in their own namespace, with no
other rights; and enforce
[Pod Security Admission](../k8s-security/pod-security-standards.md) plus a
validating [admission policy](admission-policies-cel.md) that rejects pods
setting `spec.nodeName` outside `kube-system`, so placement cannot be
self-assigned.

**Verify.**

```bash
kubectl auth can-i create pods/binding --as=system:serviceaccount:tasklane:tasklane-api
kubectl get clusterroles -o json | grep -c "pods/binding"
```

The first must answer `no`; the second should account for the scheduler's
own role and nothing else.

## Troubleshooting

Start with events, which name the failing predicate and the node counts:

```bash
kubectl -n tasklane get events --field-selector reason=Scheduled --sort-by=.lastTimestamp
```

```console include="captures/k8s-advanced/scheduled-events.txt"
```

Then:

```bash
kubectl -n tasklane describe pod <pending-pod>
kubectl -n kube-system logs -l component=kube-scheduler --tail=100
kubectl -n kube-system get lease kube-scheduler
```

| Symptom | Where to look |
|---|---|
| Pod `Pending`, no events at all | `schedulingGates` set, or `schedulerName` names a profile that does not exist |
| `FailedScheduling` repeating slowly | The pod is in the backoffQ; the retry interval grows to `podMaxBackoffSeconds` |
| Pod scheduled onto a node that should be excluded | Something bypassed the scheduler: `nodeName`, a direct Binding, or a second scheduler |
| Scheduling latency climbing with cluster size | Check per-plugin duration metrics; suspect inter-pod affinity first |
| Nothing is scheduled at all | Leader election lost, scheduler crash-looping, or its kubeconfig/RBAC broken |

## Common mistakes

- Defining a profile without keeping one named `default-scheduler`, which
  strands every pod that does not set `schedulerName`.
- Using different `queueSort` plugins across profiles in one process; only
  one queue exists, so this is rejected.
- Running two schedulers over the same node pool and then debugging the
  binding races that follow.
- Reaching for a custom plugin when a plugin argument, a profile or a
  scheduling gate would do.
- Assuming higher `percentageOfNodesToScore` improves placement in a
  20-node cluster; below about 100 nodes every node is already evaluated.
- Treating `nominatedNodeName` as proof of preemption — since 1.35 it is
  also set when the scheduler expects a slow binding cycle.
- Enabling alpha scheduling gates in production because a blog post used
  them. Check the gate's stage and default for **your** version first.

## Related topics

- [Priority and preemption](priority-and-preemption.md)
- [Topology spread constraints](topology-spread-constraints.md)
- [Pod affinity and anti-affinity](pod-affinity-and-anti-affinity.md)
- [Dynamic resource allocation](dynamic-resource-allocation.md)
- [Cluster Autoscaler and Karpenter](cluster-autoscaler-and-karpenter.md)
- [Admission policies with CEL](admission-policies-cel.md)
- [Part H labs](labs.md)
