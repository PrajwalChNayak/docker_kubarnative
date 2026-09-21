---
title: In-place Pod resize
description: Change a running container's CPU and memory without recreating the Pod, using the resize subresource, resizePolicy and the kubelet's resize conditions.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-intermediate/resources-requests-limits
  - k8s-intermediate/qos-classes
---

## Overview

For most of Kubernetes' life, `spec.containers[].resources` was immutable:
changing a request or a limit meant a new pod. In-place Pod resize changes
that. A dedicated `resize` subresource on the Pod accepts new CPU and memory
values, and the kubelet reconfigures the running container's cgroups without
recreating it.

Container-level resize (`InPlacePodVerticalScaling`, KEP-1287) is **GA in
1.35** and the feature gate is locked on. Resizing the **pod-level**
`spec.resources` stanza (`InPlacePodLevelResourcesVerticalScaling`) is a
different feature: it is **Beta in 1.36 and on by default**.

This is the mechanism the [Vertical Pod Autoscaler](vertical-pod-autoscaler.md)
uses in its `InPlaceOrRecreate` mode, and it is useful on its own when you
need to give a pod more room right now without losing its state or its place
in the cluster.

## Why it exists and when to use it

Recreating a pod to change a number is expensive in ways that have nothing to
do with the number: you lose the page cache, the JIT-compiled code, the
in-memory queue, the connection pool, and — on a busy cluster — possibly the
node you were happily running on. For a StatefulSet member it also means a
rebalance.

Reach for resize when:

- A workload is being throttled or is close to an OOM kill and you want to
  widen it **now**, during an incident, without a restart.
- You are right-sizing continuously, with the VPA in `InPlaceOrRecreate` mode.
- The pod holds state that is expensive to rebuild — a cache, a database
  buffer pool, a long-running job.

It is the wrong tool when the workload can simply be scaled out (use
[the HPA](horizontal-pod-autoscaler.md)), or when the change you want is not
CPU or memory. Resize covers CPU and memory only; you cannot resize storage,
devices or extended resources this way.

:::note Resize is not free
Increasing a request may not be feasible on the current node. The kubelet
does not move the pod; it records why it cannot grow and waits. Plan for the
request being deferred, not granted.
:::

## How it works underneath

The flow involves three actors — the API server, the kubelet, and the
container runtime through the CRI.

1. A client writes new `resources` to the Pod's **`resize` subresource**.
   The API server validates the change (QoS class must not change) and
   updates `spec.containers[].resources`. This is the only path: patching
   `spec` directly is rejected for a running pod.
2. The kubelet on that node notices the difference between the pod's spec and
   what it has admitted. It decides whether the new values fit within the
   node's allocatable resources given everything else running there.
3. If they fit, the kubelet updates `status.containerStatuses[].allocatedResources`
   and applies the change. Per-resource, the container's `resizePolicy`
   decides whether the change can be applied to the live container
   (`NotRequired`) or whether the container must be restarted
   (`RestartContainer`).
4. The runtime is asked through the CRI to update the container's cgroup
   values. When that succeeds, the kubelet writes the new values into
   `status.containerStatuses[].resources` — the *actual* configuration, as
   opposed to the *desired* spec.

### The three views of a container's resources

| Field | Meaning |
|---|---|
| `spec.containers[].resources` | Desired. Mutable for CPU and memory through the `resize` subresource. |
| `status.containerStatuses[].allocatedResources` | What the kubelet has admitted on this node. |
| `status.containerStatuses[].resources` | What is actually configured for the running container right now. |

When all three agree, the resize is done. Comparing them is the whole
debugging technique.

### Resize conditions

The kubelet reports progress through pod conditions rather than events:

- **`PodResizePending`** — the kubelet cannot grant the request yet.
  `reason: Infeasible` means it never can on this node (the node is not big
  enough); `reason: Deferred` means not right now, and it will retry.
- **`PodResizeInProgress`** — the request was admitted and is being applied.

A `Deferred` resize that has been sitting there for minutes usually means the
node is full and something else has to move first. In 1.37 an **Alpha**
feature gate (`InPlacePodVerticalScalingSchedulerPreemption`, off by default
and not for production) lets the scheduler preempt lower-priority pods to
make room for a pending resize; without it, nothing is preempted.

### Limits, QoS and restarts

- The **QoS class is immutable**. A Burstable pod cannot be resized into a
  Guaranteed one, and the API server rejects the attempt.
- Reducing memory is the awkward direction: pages already in use cannot be
  taken back, so a memory reduction may require a restart. That is exactly
  what `resizePolicy` with `restartPolicy: RestartContainer` is for.
- `NotRequired` is the default for every resource that has no explicit
  policy.

## Basic example

```yaml include="examples/autoscaling/in-place-resize.yaml"
```

Apply it, resize it, and compare desired with actual:

```bash
kubectl -n tasklane apply -f examples/autoscaling/in-place-resize.yaml
kubectl -n tasklane patch pod tasklane-resize-demo --subresource resize -p '{"spec":{"containers":[{"name":"demo","resources":{"requests":{"cpu":"200m"}}}]}}'
kubectl -n tasklane get pod tasklane-resize-demo -o jsonpath='{.spec.containers[0].resources}{"\n"}{.status.containerStatuses[0].resources}{"\n"}'
```

```console include="captures/k8s-advanced/in-place-resize.txt"
```

## Explanation

`--subresource resize` is the important part of that `patch` command. Without
it, kubectl patches the Pod itself and the API server rejects the change to
`resources`. The flag needs kubectl 1.32 or newer; an older client simply
does not have it.

The patch body is an ordinary strategic-merge patch, so `name` identifies the
container (it is the merge key) and only the listed resources change — the
memory request and limit in the example survive untouched.

The `resizePolicy` block in the manifest is a per-resource declaration, not a
mode:

```yaml title="resizePolicy (fragment)" fragment
resizePolicy:
  - resourceName: cpu
    restartPolicy: NotRequired
  - resourceName: memory
    restartPolicy: RestartContainer
```

CPU is safe to change live — cgroup CPU shares and quota are just numbers.
Memory is declared as `RestartContainer` here so that a *shrink* restarts the
container deliberately rather than leaving the runtime to refuse it. If your
workload only ever grows its memory, `NotRequired` for memory is fine and
avoids the restart entirely.

## Common patterns

### Emergency headroom during an incident

Throttling on a single pod, no time for a rollout:

```bash
kubectl -n tasklane patch pod <pod> --subresource resize -p '{"spec":{"containers":[{"name":"api","resources":{"requests":{"cpu":"500m"}}}]}}'
kubectl -n tasklane get pod <pod> -o jsonpath='{.status.conditions[?(@.type=="PodResizePending")]}{"\n"}'
```

Then fix the Deployment manifest. A resize applies to **this pod**; the next
rollout recreates it from the template and the change is gone.

### Let the VPA do it

`updateMode: InPlaceOrRecreate` makes the VPA updater attempt a resize before
it falls back to eviction. This is the combination that makes vertical
autoscaling tolerable for stateful workloads — see
[Vertical Pod Autoscaler](vertical-pod-autoscaler.md).

### Declare the policy everywhere, resize anywhere

Adding a `resizePolicy` to your Deployment templates costs nothing at rest.
It does not trigger a resize; it just means that when something does resize
the pod later — you, or a controller — the restart semantics are already
decided and reviewed, instead of being whatever the default happens to be.

### Pod-level resources

If you set pod-level `spec.resources` (Beta since 1.34) you can resize that
too, **Beta and on by default since 1.36**. Note that `resizePolicy` is a
container-level field only: there is no pod-level resize policy, and the
per-container policies still decide whether a container restarts.

## Production considerations

**A resize is node-local.** The kubelet will not move the pod to a bigger
node. On a full node your request sits in `PodResizePending` with
`reason: Infeasible` until something changes. Cluster autoscalers scale on
*pending pods*, not pending resizes, so a stuck resize does not add a node.

**Requests you grow are requests the scheduler already committed.** Growing
requests in place makes the node's remaining allocatable smaller for
everything else, without the scheduler having a say. Do it too enthusiastically
across a node and you will make future pods unschedulable there.

**Rollouts win.** The pod spec that survives is the one in the workload
template. Treat manual resizes as temporary and follow them with a real
change to the Deployment, ideally the one your VPA recommendations support.

**Not every runtime resizes identically.** The change goes through the CRI's
update-resources call; the lab's containerd handles CPU and memory growth
without a restart. Verify the behaviour of your runtime and kernel (cgroup v2
is the baseline from 1.35 onwards) before designing an operational procedure
around it.

**Observability.** Watch for pods whose `spec` and
`status.containerStatuses[].resources` have disagreed for a long time: that
is a resize the cluster could not satisfy, and it is invisible in
`kubectl get pods`.

## Security considerations

**Threat: resize is a write to a pod subresource, and it changes the node's
resource accounting.** Someone who can resize pods can grow a pod's requests
until the node has no allocatable capacity left for anyone else — a local
denial of service that never shows up as a new pod, never passes a
ResourceQuota admission check for a *new* object, and does not require the
ability to create pods at all.

**Exploit.** A CI ServiceAccount with a broad `patch pods` grant resizes its
own build pod to `cpu: 8, memory: 24Gi` on a shared node. Existing pods keep
running, but nothing new can be scheduled there, and the eviction manager
starts making decisions under memory pressure.

**Fix.** RBAC treats the subresource separately: grant `pods/resize` only
where it is needed, and audit any role that already grants `pods` with
`patch` or `update` — those are the ones to trim. Put a
[ResourceQuota](../k8s-intermediate/limitrange-and-resourcequota.md) with
`requests.cpu` and `requests.memory` on every tenant namespace, and a
`LimitRange` with `max` to bound a single container.

**Verify.**

```bash
kubectl auth can-i patch pods/resize --namespace tasklane --as system:serviceaccount:tasklane:tasklane-api
kubectl -n tasklane describe resourcequota
kubectl get clusterroles -o json | jq -r '.items[] | select(.rules[]?.resources[]? == "pods/resize") | .metadata.name'
```

The first must print `no`. The third lists every role that can resize
anything, anywhere.

## Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| `kubectl patch` rejects the change to `resources` | `--subresource resize` missing, or kubectl older than 1.32 | `kubectl version`; re-run with the flag |
| Condition `PodResizePending`, `reason: Infeasible` | The node cannot fit the new request | `kubectl describe node <node>` and compare allocatable |
| Condition `PodResizePending`, `reason: Deferred` | Temporarily not possible; the kubelet will retry | Free capacity on the node, or recreate the pod elsewhere |
| `PodResizeInProgress` never clears | The runtime has not acknowledged the cgroup change | kubelet logs on that node |
| Container restarted unexpectedly | `resizePolicy` for that resource is `RestartContainer` | `kubectl get pod -o jsonpath='{.spec.containers[*].resizePolicy}'` |
| API server rejects the resize outright | The change would alter the QoS class | Compare requests and limits before and after |
| Pod is back to its old size | A rollout recreated it from the template | Change the Deployment, not the pod |

## Common mistakes

- **Patching `spec` instead of the subresource.** The API server says no, and
  the error is easy to misread as "resize is not supported here".
- **Expecting a resize to schedule elsewhere.** It is the kubelet's decision
  on one node; the scheduler is not involved.
- **Resizing a pod and calling the incident fixed.** The template still has
  the old numbers.
- **Trying to change the QoS class.** Setting `limits` equal to `requests` on
  a Burstable pod to "promote" it to Guaranteed is rejected.
- **Assuming a memory shrink takes effect immediately.** Without
  `RestartContainer` for memory, the runtime may simply refuse to lower the
  limit below what is in use.
- **Confusing the two features.** Container-level resize is GA in 1.35;
  pod-level resources resize is Beta (on by default) in 1.36. They graduate
  on different schedules.

## Related topics

- [Vertical Pod Autoscaler](vertical-pod-autoscaler.md)
- [Horizontal Pod Autoscaler](horizontal-pod-autoscaler.md)
- [Requests and limits](../k8s-intermediate/resources-requests-limits.md)
- [QoS classes](../k8s-intermediate/qos-classes.md)
- [Pod lifecycle and termination](../k8s-intermediate/pod-lifecycle-and-termination.md)
- [Priority and preemption](priority-and-preemption.md)
