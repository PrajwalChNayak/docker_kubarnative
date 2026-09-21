---
title: Controllers and operators
description: What a controller actually is — informers, work queues and a level-triggered reconcile loop — and how to decide whether to write one at all.
level: expert
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-advanced/custom-resource-definitions
  - k8s-beginner/declarative-model-and-reconciliation
---

## Overview

A controller is a program with one job: make the world match a piece of the
API. It reads objects, compares them to reality, and issues the smallest write
that closes the gap. Then it does it again. Deployments, Jobs, EndpointSlices
and node lifecycle are all controllers; so is your operator.

An **operator** is a controller plus a [custom
resource](custom-resource-definitions.md), usually one that encodes operational
knowledge about a specific piece of software. The pattern is not special: the
operator's reconcile loop obeys exactly the same rules as the built-in
Deployment controller, because it is built from the same client-go primitives.

This page is about those rules, using
`examples/operator`, a TaskQueue controller that keeps the Tasklane worker
Deployment's replica count equal to `spec.workers`.

## Why it exists and when to use it

Write a controller when there is an operational decision that a human currently
makes by reading state and running commands. Do not write one for anything
else.

| Problem | Reach for |
|---|---|
| "Deploy the same YAML with different values" | [Helm](helm.md) or [Kustomize](kustomize.md) |
| "Apply what is in Git, continuously" | [Argo CD](gitops-argo-cd.md) or [Flux](gitops-flux.md) |
| "Scale on a metric" | [HPA](horizontal-pod-autoscaler.md) or [KEDA](keda.md) |
| "Run this once, or on a schedule" | A Job or CronJob |
| "Fail over a primary, reshard a cluster, restore from a backup, do a version-aware upgrade" | An operator |

:::warning Most operators should not have been written
An operator is a privileged, always-on process with broad RBAC, a cache of
cluster state, and a release cycle you now own. Every one of those is a
liability. If a Helm chart plus an HPA does the job, the operator is a worse
solution that costs more. Say this out loud before the project starts, not at
the post-mortem.
:::

## How it works underneath

### The shared informer cache

A controller does not poll and does not read the API server on every
reconcile. At startup it performs one LIST of each kind it cares about, then
opens a WATCH from the returned `resourceVersion`. Events update an in-memory
store, the **cache**, and a **lister** reads from that store. Reads are local
and cheap; the API server pays once per controller for the initial list and
then only streams deltas.

That cache is why controllers are memory-hungry and why scoping matters. A
manager watching all Deployments in a 5,000-Deployment cluster holds all 5,000
in RAM, whether or not it uses them.

The cache is also, by definition, slightly stale. A controller that assumes its
read is current will make wrong decisions; the fix is not to bypass the cache,
it is to write code that is correct when the read is old (see idempotence,
below).

### Work queues and rate limiting

Watch events do not call your code. They push an object **key**
(namespace/name) onto a work queue. The queue deduplicates: ten rapid changes
to one object collapse into one key, so a controller under load does less work
per object, not more.

Workers pop keys and call `Reconcile`. If it returns an error, the key is
re-queued through a **rate limiter**, which by default backs off exponentially
per item. A broken dependency therefore produces a slowing retry, not a hot
loop, and the controller keeps serving every other object.

### Level-triggered, not edge-triggered

`Reconcile` is handed a name, never an event. It is not told what changed, or
whether anything changed. It reads current state and drives towards the desired
state.

This is the single most important property. An edge-triggered controller must
see every event, so a dropped watch, a restart or a re-election is a
correctness bug. A level-triggered controller re-reads the level, so a missed
event costs latency and nothing else.

Two consequences follow, and both are requirements on your code:

- **Idempotence.** Running `Reconcile` twice with the same input must produce
  the same result as running it once. "Create a new backup" is not idempotent;
  "ensure a backup exists for generation N" is.
- **No memory between calls.** Any state you keep in a struct field is state
  that vanishes on restart and diverges after a leader election.

### Optimistic concurrency

Every write carries the `resourceVersion` the object was read at. If somebody
else wrote in between, the API server rejects it with a conflict. That is not a
failure to hide; it is the mechanism that makes concurrent controllers safe.
The correct response is to return the error, let the work queue re-queue with
backoff, and re-read on the next pass.

### ownerReferences and garbage collection

`metadata.ownerReferences` links a dependent object to its owner. When the
owner is deleted, the garbage collector deletes the dependents. Three
propagation policies exist:

| Policy | Behaviour |
|---|---|
| `Background` | The owner is deleted immediately; dependents are removed afterwards. The default for most kinds. |
| `Foreground` | The owner is marked with `foregroundDeletion` in its finalizers and stays visible until every dependent is gone. |
| `Orphan` | The owner is deleted and the ownerReference is stripped from the dependents, which survive. |

Owning is a strong claim. It means "if I go, this goes". Do not set an
ownerReference on something you merely influence.

### Finalizers

A finalizer is a string in `metadata.finalizers`. While it is present, a
DELETE only sets `metadata.deletionTimestamp`; the object is not removed until
the finalizer is taken off. It exists so a controller can clean up state the
garbage collector cannot see: a cloud load balancer, a DNS record, a row in
another system.

The cost is a new outage mode. If the controller that owns the finalizer is
down, or lacks RBAC, or crashes on that object, the object is stuck in
`Terminating` forever, and so is its namespace. Add a finalizer only when there
is external state to clean up, and make the cleanup path tolerate the external
thing already being gone.

### Leader election

Two replicas of a controller reconciling the same object will fight. Leader
election makes only one of them act: replicas race to create and renew a Lease
(`coordination.k8s.io/v1`), and only the holder starts the work queues. The
others run, keep warm caches, and wait. Failover costs a lease timeout, not a
relist.

### Conditions and observedGeneration

Status is how a controller talks back. Two conventions make it legible:

- `status.conditions`, a list of `metav1.Condition` with `type`, `status`,
  `reason`, `message`, `lastTransitionTime` and `observedGeneration`. Declare
  it with `x-kubernetes-list-type: map` keyed on `type` so writers merge by
  condition instead of clobbering by array index.
- `status.observedGeneration`, the `metadata.generation` the controller last
  processed. When it is lower than `metadata.generation`, the status describes
  an older spec. Without it, "Ready: True" is ambiguous: ready for which spec?

## Basic example

The manager owns the cache, the queues, the lease, the metrics endpoint and the
probes:

```go include="examples/operator/cmd/main.go" lines="49-62"
```

The reconcile loop itself. It reads the TaskQueue, reads the Deployment it
names, patches one field, and writes status:

```go include="examples/operator/internal/controller/taskqueue_controller.go" lines="50-87"
```

```go include="examples/operator/internal/controller/taskqueue_controller.go" lines="89-114"
```

Watching a second kind, and mapping it back to the objects that care:

```go include="examples/operator/internal/controller/taskqueue_controller.go" lines="152-190"
```

The RBAC that goes with it — one rule per call the code makes:

```yaml include="examples/operator/config/rbac/manager_cluster_role.yaml"
```

## Explanation

Three decisions in that code are worth defending, because the opposite choice
is more common and usually wrong.

**It patches the Deployment; it does not own it.** There is no ownerReference.
Tasklane's worker Deployment belongs to the platform repo and is applied by
GitOps. An ownerReference would give the garbage collector permission to delete
that Deployment when a TaskQueue is deleted. Reconciling the whole Deployment
spec would start a write war with the GitOps controller over every other field.
A merge patch touches `spec.replicas` and nothing else.

The price is paid honestly: the operator cannot create the Deployment, so a
TaskQueue pointing at a missing one sits at `Ready=False` with reason
`DeploymentNotFound` until somebody makes it.

**There is no finalizer.** The operator creates nothing outside the API server,
so there is nothing to clean up. Adding a finalizer would buy only the
`Terminating` failure mode described above.

**Status is written only when it changed.** `writeStatus` compares against the
status read at the top of the function. Writing an identical status on every
pass bumps `resourceVersion`, which fires the watch, which re-queues the key,
which writes status again. That is a self-sustaining hot loop that shows up as
API server CPU and looks like somebody else's bug.

The Deployment watch matters too. Without it, a human running `kubectl scale`
on the worker Deployment would be silently undone only on the next periodic
resync, minutes later. With it, the map function turns the Deployment event
into TaskQueue keys and the correction is immediate.

## Common patterns

**Capability levels.** The Operator Framework describes five levels, and they
are a useful honesty check on a roadmap: 1 Basic Install, 2 Seamless Upgrades,
3 Full Lifecycle (backup, restore, failover, membership), 4 Deep Insights
(metrics, alerts, events), 5 Auto Pilot (autoscaling, auto-healing, tuning).
Most operators in the wild are level 1 or 2 and describe themselves as level 4.

**Scaffolding.** Two projects dominate, and they are layers of the same stack:

| | Kubebuilder | Operator SDK |
|---|---|---|
| Latest release (2026-09-21) | v4.16.0, 2026-09-10 | v1.42.3, 2026-06-26 |
| Scope | Go controllers with controller-runtime | Go (built on Kubebuilder), plus Ansible and Helm operators |
| Adds | Project scaffolding, `controller-gen` | Operator Lifecycle Manager packaging, bundles, scorecard |

Kubebuilder v4.16.0 ships controller-runtime v0.25.0 and controller-tools
v0.22.0 and states support for Kubernetes 1.37. Choose Operator SDK if you need
OLM packaging or a non-Go operator; otherwise Kubebuilder is the smaller
dependency. Neither is required: the example here is plain controller-runtime
with a hand-written layout.

**Version pinning.** controller-runtime's minor version tracks the Kubernetes
minor. v0.25.x is the line built against the 1.37 `k8s.io/*` v0.37 libraries.
Mixing v0.24 with v0.37 client libraries compiles right up until it does not.

**One controller, one kind.** A reconciler that handles three kinds cannot be
rate-limited, retried or reasoned about per kind. Run three controllers in one
manager instead; they share the cache.

## Production considerations

Run at least two replicas with leader election on. The standby exists for
rolling updates as much as for node failure: during any update both the old and
new pod are alive, and without a lease both would reconcile.

Give the manager a memory limit and no CPU limit. Throttling a controller only
lengthens its work queue; an informer cache that grows without bound should be
killed.

Scope the cache. If the operator only ever manages one namespace, tell the
manager so. Cluster-wide caches are the usual reason an operator with 200 lines
of logic uses 2 GiB of RAM.

Export the work-queue metrics controller-runtime already provides: depth,
adds, latency and `workqueue_retries_total`. A queue depth that never returns
to zero means reconcile is slower than events arrive; rising retries mean
something is failing quietly.

Expect to own upgrades. Your operator is a client of the Kubernetes API, and
Kubernetes moves three times a year. An operator nobody rebuilds becomes the
reason a cluster cannot be upgraded.

## Security considerations

**Threat.** The operator is a confused deputy. It holds RBAC that its users do
not, and it acts on input those users control. A user who may create TaskQueues
but may not create Deployments can still cause Deployments to be written, by
the operator, with the operator's permissions.

**Exploit.** Give the operator `deployments: ["*"]` and a spec field that
becomes part of a pod template, and a user who can only write a custom resource
can cause a pod with a `hostPath` mount of `/` to be created for them. They
never needed pod-create permission. If the ServiceAccount token is also
readable — for instance because somebody set `automountServiceAccountToken:
true` on unrelated pods in the same namespace and shared a node — the operator's
credentials themselves become the prize.

**Fix.**

- Grant exactly the verbs the code calls. The example ClusterRole has
  `get, list, watch, patch` on Deployments and no `create` or `delete`, so the
  worst a compromised operator can do to a workload is change its replica
  count.
- Keep write access narrow in kind, too: `taskqueues` is `get, list, watch`
  only. The operator cannot rewrite the spec it is given.
- Keep leader-election permissions namespaced. A `Role` on Leases in the
  operator's own namespace cannot touch `kube-node-lease`, where node
  heartbeats live.
- Run the operator in its own namespace, under Pod Security Admission
  `restricted`, non-root, read-only root filesystem, all capabilities dropped.
  A privileged process is not made safe by its RBAC being small.
- Mount the ServiceAccount token, because the operator genuinely needs the API,
  and nowhere else. This is the one workload in this handbook where
  `automountServiceAccountToken: true` is correct, and the manifest says so in
  a comment.

**Verify.** Ask the API server what the identity can actually do:

```bash
kubectl auth can-i --list --as=system:serviceaccount:tasklane-system:tasklane-operator
kubectl auth can-i delete deployments --as=system:serviceaccount:tasklane-system:tasklane-operator -n tasklane
```

The second must answer `no`. Then confirm the pod really is unprivileged with
`kubectl -n tasklane-system get pod -o jsonpath='{.items[*].spec.securityContext}'`.

## Troubleshooting

**Nothing happens when I create the custom resource.** Check the controller is
the leader: `kubectl -n tasklane-system get lease`. A non-leader logs that it
is waiting and does nothing, which looks identical to a crash.

**It works, then stops after a while.** Usually a watch that failed to
re-establish, or a reconcile that returns `nil` on an error path so the key is
never re-queued. Never swallow an error and return success.

**Status flaps between two values.** Two writers. Either a second replica is
reconciling (leader election off or lease permissions missing), or your
controller and a user are both writing the same field.

**Reconcile runs constantly for one object.** You are writing on every pass.
Diff what you write against what you read before writing.

**The object will not delete.** `kubectl get -o jsonpath='{.metadata.finalizers}'`
and find out which controller owes it cleanup. Removing a finalizer by hand
deletes the object and abandons whatever it was protecting; do it knowingly.

**Conflicts in the logs.** Expected in small numbers, and handled by backoff. A
storm of them means two controllers are writing the same object.

## Common mistakes

- Writing an operator when a Helm chart and an HPA would have done.
- Edge-triggered thinking: "on create do X, on update do Y". Reconcile is not
  told what happened.
- Non-idempotent actions, such as creating a new external resource on every
  pass because the last one was not recorded in status.
- Caching state in the reconciler struct, then being surprised after a restart.
- Setting an ownerReference on an object the operator does not own, and
  teaching the garbage collector to delete somebody else's workload.
- Adding a finalizer with no external state to clean up.
- `cluster-admin` for the operator's ServiceAccount because working out the
  verbs was tedious.
- Ignoring conflict errors, or retrying them in a tight loop instead of
  returning them.
- Never setting `observedGeneration`, leaving users unable to tell whether the
  status describes their change.
- Letting the operator's dependencies rot until it blocks a cluster upgrade.

## Related topics

- [Custom Resource Definitions](custom-resource-definitions.md)
- [Aggregated APIs](aggregated-apis.md)
- [Admission webhooks](admission-webhooks.md)
- [Horizontal Pod Autoscaler](horizontal-pod-autoscaler.md)
- [KEDA](keda.md)
- [GitOps with Argo CD](gitops-argo-cd.md)
- [Multi-tenancy](multi-tenancy.md)
- [Declarative model and reconciliation](../k8s-beginner/declarative-model-and-reconciliation.md)
