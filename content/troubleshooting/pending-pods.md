---
title: Pending pods
description: How to read the scheduler's FailedScheduling message and fix the reason a pod cannot be placed — insufficient resources, affinity, taints, topology spread or an unbound PVC.
level: intermediate
type: troubleshooting
status: current
versions: Kubernetes 1.37
prerequisites:
  - troubleshooting/method
  - k8s-advanced/node-selection-and-affinity
  - k8s-advanced/taints-and-tolerations
---

## Overview

A `Pending` pod is one the scheduler has not bound to a node. Either no node
satisfies the pod's constraints, or a resource it needs (a volume) is not ready.
The scheduler is unusually honest about why: it writes a `FailedScheduling`
Event that summarises, per node, exactly which predicate failed. This page
teaches you to read that message and map each reason to a fix.

## Symptoms

- `kubectl get pods` shows `STATUS: Pending` and no `NODE` in `-o wide`.
- `describe pod` shows a `FailedScheduling` Event like
  `0/3 nodes are available: 3 Insufficient memory. preemption: 0/3 nodes are
  available: 3 No preemption victims found.`
- The pod may sit Pending indefinitely, or get scheduled later when capacity or
  a volume appears.

Reproducer (a memory request larger than any node):

```yaml include="examples/troubleshooting/pending-unschedulable.yaml"
```

```console include="captures/troubleshooting/pending.txt"
```

## How it works underneath

The scheduler runs a loop for every unbound pod: **filter** nodes that cannot
run it (predicates), then **score** the survivors and bind the best. If the
filter phase eliminates every node, the pod stays Pending and the scheduler
records why each node was filtered out. The message is a histogram: "0/3 nodes
are available" followed by counts per reason.

Common filter reasons and what they mean:

| Message | Cause |
|---|---|
| `Insufficient cpu` / `Insufficient memory` | the sum of pod **requests** on each node leaves less than this pod requests. Requests, not usage, drive scheduling. |
| `node(s) didn't match Pod's node affinity/selector` | `nodeSelector` or `nodeAffinity` matches no node's labels |
| `node(s) had untolerated taint {key: value}` | every candidate node has a taint this pod does not tolerate |
| `node(s) didn't match pod topology spread constraints` | a `whenUnsatisfiable: DoNotSchedule` spread rule cannot be met |
| `node(s) had volume node affinity conflict` / pod waits on a PVC | the bound volume is on a node the pod cannot use, or the PVC is unbound |
| `0/0 nodes are available` | there are no schedulable nodes at all (all NotReady/cordoned) |

Requests versus limits matters here: the scheduler reserves **requests**. A pod
with a 900Gi memory request cannot be placed even on an idle node with 8Gi,
regardless of how little it would actually use. Limits are enforced later by the
kubelet and cgroups, not by the scheduler.

`preemption: ... No preemption victims found` means the scheduler also
considered evicting lower-priority pods to make room and could not — see
[priority and preemption](../k8s-advanced/priority-and-preemption.md).

## Diagnosis

1. **Read the scheduling message.**

   ```bash
   kubectl -n <ns> describe pod <pod>
   ```

   The `Events` `FailedScheduling` line tells you the reason and the node
   counts. Believe it literally.

2. **Compare requests to node capacity.**

   ```bash
   kubectl describe nodes | grep -A5 "Allocated resources"
   kubectl get nodes -o custom-columns=NAME:.metadata.name,CPU:.status.allocatable.cpu,MEM:.status.allocatable.memory
   ```

3. **For affinity/selector**, check the labels actually on the nodes:

   ```bash
   kubectl get nodes --show-labels
   ```

4. **For taints**, list them and compare with the pod's tolerations:

   ```bash
   kubectl get nodes -o json | jq '.items[].spec.taints'
   ```

5. **For a volume wait**, check the PVC — a Pending PVC keeps its consumer
   Pending. See [PVC stuck Pending](pvc-pending.md).

## Fixes

- **Insufficient cpu/memory.** Lower the pod's requests to what it truly needs,
  or add capacity (more/bigger nodes; a Cluster Autoscaler or Karpenter in a
  real cluster). In the lab, requesting a realistic amount is the fix.
- **Affinity/selector no match.** Correct the `nodeSelector`/`nodeAffinity` to a
  label that exists, or label a node to match.
- **Untolerated taint.** Add the matching `toleration` to the pod, or remove the
  taint from a node if it should be schedulable.
- **Topology spread unsatisfiable.** Relax `whenUnsatisfiable` from
  `DoNotSchedule` to `ScheduleAnyway`, widen `maxSkew`, or add nodes in the
  missing topology domain (zone).
- **No schedulable nodes.** Uncordon nodes (`kubectl uncordon`), fix NotReady
  nodes (see [Node NotReady](node-notready.md)), or add nodes.

## Prevention

- Set **requests** deliberately from measured usage, not guesses; oversized
  requests waste capacity and cause spurious Pending.
- Use `whenUnsatisfiable: ScheduleAnyway` for spread constraints unless hard
  placement is a real requirement — the Tasklane API uses `ScheduleAnyway`
  precisely so a missing zone does not block rollout.
- Reserve taints for nodes that genuinely need isolation, and document the
  tolerations workloads must carry.
- Watch for capacity headroom with metrics and alerts, so Pending from
  exhaustion is caught before it hurts.

## Common mistakes

- Reading the pod's **limits** and concluding it should fit, when it is the
  **request** that is too large.
- Adding a toleration when the real problem is affinity, or vice versa — the
  message names which.
- Assuming Pending is an app problem; a Pending pod's containers have not run.
- Setting `DoNotSchedule` topology spread on a small cluster and blocking
  rollouts when one zone is briefly short.
- Forgetting that an unbound PVC silently keeps its pod Pending.

## Related topics

- [A method for debugging Kubernetes](method.md)
- [PVC stuck Pending](pvc-pending.md)
- [Node NotReady](node-notready.md)
- [Node selection and affinity](../k8s-advanced/node-selection-and-affinity.md)
- [Taints and tolerations](../k8s-advanced/taints-and-tolerations.md)
- [Topology spread constraints](../k8s-advanced/topology-spread-constraints.md)
- [Priority and preemption](../k8s-advanced/priority-and-preemption.md)
