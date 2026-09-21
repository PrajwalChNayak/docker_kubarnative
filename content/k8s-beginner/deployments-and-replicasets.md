---
title: Deployments and ReplicaSets
description: The controller pair that keeps N copies of a pod template running, and how pod-template-hash keeps two generations of pods apart.
level: beginner
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/pods
  - k8s-beginner/declarative-model-and-reconciliation
---

## Overview

A **ReplicaSet** keeps a fixed number of pods matching one pod template
running. A **Deployment** owns ReplicaSets and manages transitions between
them, which is what makes a release a rollout rather than an outage.

You write Deployments. You read ReplicaSets when something goes wrong.

## Why it exists and when to use it

A ReplicaSet alone answers "always three of these". It cannot answer "replace
these three with a new version without dropping traffic", because changing
the pod template of a ReplicaSet does not touch existing pods — it only
affects pods created afterwards.

The Deployment adds exactly that: for each distinct pod template it creates a
ReplicaSet, then scales the new one up and the old one down according to a
strategy, while recording revision history so the move can be reversed.

Use a Deployment for **stateless** workloads: HTTP services, workers,
anything where pods are interchangeable. Use something else when they are
not:

| Need | Controller |
|---|---|
| Stable network identity, ordered start-up, per-pod storage | [StatefulSet](../k8s-intermediate/statefulsets.md) |
| One pod per node | [DaemonSet](../k8s-intermediate/daemonsets.md) |
| Run to completion, once or on a schedule | [Job and CronJob](../k8s-intermediate/jobs-and-cronjobs.md) |
| Interchangeable, long-running replicas | **Deployment** |

## How it works underneath

### The ownership chain

```text title="what owns what"
Deployment  hello-api
  └── ReplicaSet  hello-api-7d9f8c6b54     (pod-template-hash=7d9f8c6b54)
        ├── Pod  hello-api-7d9f8c6b54-2xk9p
        ├── Pod  hello-api-7d9f8c6b54-h4lqz
        └── Pod  hello-api-7d9f8c6b54-p8n7w
```

Each level sets `ownerReferences` on the level below, so deleting the
Deployment garbage-collects everything under it.

The Deployment controller computes a hash of the pod template and adds it as
the label **`pod-template-hash`** to the ReplicaSet, to its selector, and to
every pod it creates. Without it, two ReplicaSets of the same Deployment
would have identical selectors and would adopt each other's pods. With it,
each generation of pods is unambiguous — and you can watch a rollout by
watching the hash change.

### Reconciliation, twice

Two loops run:

1. The **ReplicaSet controller** compares `spec.replicas` against the number
   of matching, non-terminating pods and creates or deletes the difference.
   When deleting, it ranks candidates: unscheduled before scheduled, pending
   before running, not-ready before ready, younger before older.
2. The **Deployment controller** compares the desired pod template against
   the ReplicaSets that exist. If the template is new, it creates a
   ReplicaSet; then it scales the new and old ReplicaSets according to
   `spec.strategy`.

Both are level-triggered: kill a pod and a replacement appears, because the
count is what is compared, not the event.

### Status fields worth knowing

| Field | Meaning |
|---|---|
| `status.replicas` | Pods the selector currently matches |
| `status.updatedReplicas` | Pods created from the **current** template |
| `status.readyReplicas` | Pods passing readiness |
| `status.availableReplicas` | Ready pods that have stayed ready for `minReadySeconds` |
| `status.unavailableReplicas` | Desired minus available |
| `status.observedGeneration` | The `metadata.generation` the controller has processed |

And two conditions: **`Available`** (enough available replicas) and
**`Progressing`** (the rollout is moving; reason `NewReplicaSetAvailable`
when it finished, `ProgressDeadlineExceeded` when it gave up). A third,
`ReplicaFailure`, appears when the ReplicaSet cannot create pods at all — for
example when admission rejects them.

### Scaling

`spec.replicas` is a plain number you can change with `kubectl scale`, a
manifest edit, or an autoscaler. Scaling does not create a new revision,
because the pod template did not change. Scaling to zero is legal and keeps
the object, the Service and the history.

If a [HorizontalPodAutoscaler](../k8s-advanced/horizontal-pod-autoscaler.md)
owns the replica count, remove `replicas` from your manifest, or the two will
fight on every apply.

## Basic example

```yaml include="examples/k8s/basics/20-deployment.yaml"
```

```bash
kubectl apply -f examples/k8s/basics/
kubectl -n tasklane-basics rollout status deploy/hello-api
kubectl -n tasklane-basics get pods,rs,deploy -o wide
kubectl -n tasklane-basics get rs,pods -l app.kubernetes.io/name=hello-api --show-labels
```

```console include="captures/k8s-beginner/basics-rollout-status.txt"
```

```console include="captures/k8s-beginner/basics-get-all.txt"
```

```console include="captures/k8s-beginner/basics-rs-hash.txt"
```

## Explanation

The `--show-labels` output is the point of this page: the ReplicaSet's name
ends with the same `pod-template-hash` value that appears as a label on both
the ReplicaSet and its pods. Pod names are
`<deployment>-<template hash>-<random suffix>`, so you can read a pod's
lineage from its name alone.

`kubectl rollout status` blocks until the Deployment reports that the current
generation is fully rolled out, then exits 0 — which makes it the right
command for a pipeline, unlike `sleep`.

In the running example the same structure holds for the real application:

```bash
kubectl -n tasklane get deploy,rs,pods -o wide
kubectl -n tasklane describe deployment tasklane-api
```

```console include="captures/k8s-beginner/tasklane-get-all.txt"
```

```console include="captures/k8s-beginner/tasklane-describe-deployment.txt"
```

`describe deployment` prints the strategy, the pod template, the conditions,
and — usefully — `OldReplicaSets` and `NewReplicaSet`, which is the quickest
way to see whether a rollout is in progress.

## Common patterns

- **Three replicas as a default for anything that matters.** Two survives one
  node loss; three survives one node loss during a rollout.
- **`revisionHistoryLimit: 5`.** Enough to roll back, not enough to fill etcd
  with dead ReplicaSets. The default is 10; zero disables rollback entirely.
- **Immutable image tags.** `tasklane-api:0.1.0`, never `:latest`: a mutable
  tag makes the pod template stable while the running code changes, which
  breaks both rollouts and rollbacks.
- **`kubectl rollout restart deploy/x`** to recycle pods (to pick up a
  rotated Secret, for example). It stamps
  `kubectl.kubernetes.io/restartedAt` on the template, producing a normal,
  observable rollout.
- **Anti-affinity or topology spread** so the replicas do not share a node;
  the Tasklane API spreads across the lab's two zones.
- **A PodDisruptionBudget** so voluntary disruptions (node drains) cannot
  take all replicas at once. See
  [pod disruption budgets](../k8s-intermediate/pod-disruption-budgets.md).

## Production considerations

- **`spec.selector` is immutable.** Changing it means deleting and
  recreating the Deployment, which is a real outage. Decide the label scheme
  once.
- **Orphaned ReplicaSets adopt pods.** If you delete a Deployment with
  `--cascade=orphan`, the ReplicaSets and pods keep running with no owner;
  recreating the Deployment adopts them again, which is occasionally useful
  and usually a trap.
- **Replica count is not capacity.** Without resource requests the scheduler
  packs replicas onto whatever node looks free.
- **Deployments do not order themselves.** If the API needs a database, the
  API pods will crash-loop or fail readiness until the database exists. That
  is acceptable and self-correcting; encoding ordering is not the platform's
  job.
- **Every change to the pod template is a rollout.** Including annotations
  you add for other reasons — so keep volatile metadata out of
  `spec.template.metadata`.

## Security considerations

- **A Deployment is a pod factory.** Whoever can `create` or `patch`
  Deployments in a namespace can run arbitrary images with the ServiceAccount
  of that namespace's pods. RBAC on `deployments` is effectively RBAC on
  compute.
- **Pod Security Admission evaluates pods, not Deployments.** A Deployment
  with a violating template is accepted; the ReplicaSet then fails to create
  pods and reports `ReplicaFailure`. Set the `warn` label on the namespace so
  `kubectl apply` tells you immediately.
- **Set the ServiceAccount explicitly**, and disable token automounting for
  workloads that never call the API.
- **Old ReplicaSets keep the old image reference.** A rollback re-runs an
  image you may have deliberately withdrawn for a CVE; prune history when you
  patch.

## Troubleshooting

- **Deployment exists, no pods.** Look at the ReplicaSet:
  `kubectl describe rs -l app.kubernetes.io/name=x`. Admission rejections,
  quota denials and missing ServiceAccounts appear there, not on the
  Deployment.
- **Pods created and immediately deleted.** Two controllers with overlapping
  selectors, or a mutating webhook rejecting the pods.
- **`observedGeneration` behind `generation`.** The controller is not
  processing it: check kube-controller-manager, or a stuck finalizer.
- **Scaled up but nothing schedules.** Insufficient resources or unschedulable
  nodes: `kubectl describe pod` on a `Pending` pod.
- **Rollout never completes.** See
  [rolling updates and rollbacks](rolling-updates-and-rollbacks.md).

## Common mistakes

- **Editing a ReplicaSet directly.** The Deployment controller reverts it.
- **Deleting pods to force a new version.** The ReplicaSet recreates them
  from the *old* template.
- **Selector labels that include the version**, making every release a
  selector change.
- **Leaving `replicas` in a manifest that an HPA also manages.**
- **`revisionHistoryLimit: 0`** in the name of tidiness, discovering at 03:00
  that `rollout undo` has nothing to go back to.
- **Assuming `kubectl apply` waited for the rollout.** It did not; add
  `kubectl rollout status`.

## Related topics

- [Rolling updates and rollbacks](rolling-updates-and-rollbacks.md)
- [Pods](pods.md)
- [Services](services.md)
- [StatefulSets](../k8s-intermediate/statefulsets.md)
- [Horizontal Pod Autoscaler](../k8s-advanced/horizontal-pod-autoscaler.md)
- [Pod disruption budgets](../k8s-intermediate/pod-disruption-budgets.md)
