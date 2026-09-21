---
title: Rolling updates and rollbacks
description: How a Deployment replaces one generation of pods with another without dropping traffic, and how to reverse it when the new one is wrong.
level: beginner
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/deployments-and-replicasets
---

## Overview

Changing anything in a Deployment's pod template starts a rollout: a new
ReplicaSet is created and scaled up while the old one is scaled down, within
the bounds you set. If the new pods never become ready, the rollout stops and
says so, and `kubectl rollout undo` puts the previous template back.

Four fields control the whole behaviour: `maxSurge`, `maxUnavailable`,
`minReadySeconds` and `progressDeadlineSeconds`.

## Why it exists and when to use it

A release has to satisfy two conflicting demands: replace every pod, and
never drop below the capacity you promised. A rolling update is the
compromise — replace a few at a time, and use readiness as the gate for
"this one is safe to count".

The alternative strategy, `Recreate`, kills every old pod before creating new
ones. Use it when two versions genuinely cannot coexist: an exclusive lock, a
one-writer database migration, a singleton. Accept that it is an outage.

Anything more sophisticated — canaries by traffic percentage, blue/green with
an instant switch, automatic metric-based aborts — is not built into the
Deployment. It comes from
[progressive delivery](../k8s-advanced/progressive-delivery.md) tools such as
Argo Rollouts or Flagger.

## How it works underneath

### The four knobs

| Field | Default | Effect |
|---|---|---|
| `maxSurge` | 25% | Extra pods allowed above `replicas` during the rollout. Percentages round **up** |
| `maxUnavailable` | 25% | Pods allowed to be unavailable below `replicas`. Percentages round **down** |
| `minReadySeconds` | 0 | How long a pod must stay ready before it counts as available |
| `progressDeadlineSeconds` | 600 | Seconds without progress before `Progressing` becomes `False` with reason `ProgressDeadlineExceeded` |

They cannot both be zero: with `maxSurge: 0` and `maxUnavailable: 0` the
rollout could never move, and the API server rejects it.

The handbook's Deployments use `maxSurge: 1, maxUnavailable: 0`: capacity
never dips, and one extra pod exists at a time. The cost is a slower rollout
and the need for one pod's worth of spare capacity.

### The loop

For a Deployment with three replicas, `maxSurge: 1`, `maxUnavailable: 0`:

1. You change the pod template. `metadata.generation` increments.
2. The Deployment controller hashes the new template, finds no matching
   ReplicaSet, and creates one with `replicas: 1` (the surge allowance).
3. The new pod starts. It counts as available once it has been `Ready` for
   `minReadySeconds`.
4. Now four pods exist and three are available, so the controller may scale
   the old ReplicaSet to 2. A pod is deleted: the kubelet sends SIGTERM, the
   pod's IP is removed from EndpointSlices, and the application drains.
5. Repeat until the new ReplicaSet holds all three replicas and the old one
   holds zero.
6. `Progressing` becomes `True` with reason `NewReplicaSetAvailable`;
   `kubectl rollout status` exits 0.

If new pods never become ready, step 4 never happens: the rollout sits at
"one new pod, three old pods". After `progressDeadlineSeconds` the
`Progressing` condition flips to `False`. **Nothing is rolled back
automatically** — the old pods simply keep serving, which is the behaviour
you want, and the decision is yours.

### Revisions

Each ReplicaSet carries the annotation
`deployment.kubernetes.io/revision`. `kubectl rollout history` lists those
revisions with the `kubernetes.io/change-cause` annotation you set.
`revisionHistoryLimit` (default 10) caps how many zero-replica ReplicaSets
are kept; anything older is deleted and can no longer be rolled back to.

`kubectl rollout undo` copies an old ReplicaSet's template back into the
Deployment. That produces a **new** revision number — history moves forward
even when the code moves back. It restores the pod template only, not
`replicas`, and not anything outside the Deployment such as a database
migration.

## Basic example

A complete rollout, failure and recovery, against the teaching Deployment:

```bash
kubectl -n tasklane-basics rollout history deploy/hello-api
kubectl -n tasklane-basics patch deploy/hello-api --type=strategic \
  -p '{"metadata":{"annotations":{"kubernetes.io/change-cause":"set RELEASE=2"}},"spec":{"template":{"spec":{"containers":[{"name":"api","env":[{"name":"RELEASE","value":"2"}]}]}}}}'
kubectl -n tasklane-basics rollout status deploy/hello-api
kubectl -n tasklane-basics get rs -l app.kubernetes.io/name=hello-api -o wide
kubectl -n tasklane-basics rollout history deploy/hello-api
```

```console include="captures/k8s-beginner/rollout-1-history.txt"
```

```console include="captures/k8s-beginner/rollout-2-update.txt"
```

```console include="captures/k8s-beginner/rollout-3-rs-after-update.txt"
```

```console include="captures/k8s-beginner/rollout-4-history.txt"
```

Inspect what a revision contained:

```bash
kubectl -n tasklane-basics rollout history deploy/hello-api --revision=2
```

```console include="captures/k8s-beginner/rollout-5-history-revision.txt"
```

## Explanation

After the patch, `get rs` shows two ReplicaSets: the old one scaled to 0 and
a new one with a different `pod-template-hash` holding all three replicas.
Old ReplicaSets are kept, not deleted — they *are* the rollback mechanism.

Because the patch set both the annotation and the template in one request,
the `CHANGE-CAUSE` column in `rollout history` is meaningful. Setting the
annotation in a separate command is a common way to end up with the wrong
cause attached to the wrong revision.

### A rollout that fails

```bash
kubectl -n tasklane-basics set image deploy/hello-api api=tasklane-api:0.9.9-does-not-exist
kubectl -n tasklane-basics rollout status deploy/hello-api --timeout=5s
kubectl -n tasklane-basics get rs,pods -l app.kubernetes.io/name=hello-api
kubectl -n tasklane-basics describe deploy hello-api
```

```console include="captures/k8s-beginner/rollout-7-bad-image.txt"
```

```console include="captures/k8s-beginner/rollout-8-stuck-state.txt"
```

```console include="captures/k8s-beginner/rollout-9-progressing-condition.txt"
```

The new pod sits in `ImagePullBackOff`. Because `maxUnavailable: 0`, the
three old pods are untouched and the application never notices. After 60
seconds (this Deployment's `progressDeadlineSeconds`) the `Progressing`
condition reports `ProgressDeadlineExceeded`.

That condition is what a pipeline should check. `kubectl rollout status`
returns a non-zero exit code when the deadline is exceeded, so a CI job can
fail the release instead of declaring victory.

### Undo

```bash
kubectl -n tasklane-basics rollout undo deploy/hello-api
kubectl -n tasklane-basics rollout status deploy/hello-api
kubectl -n tasklane-basics rollout history deploy/hello-api
```

```console include="captures/k8s-beginner/rollout-10-undo.txt"
```

```console include="captures/k8s-beginner/rollout-11-history-after-undo.txt"
```

`undo` without arguments goes back one revision; `--to-revision=N` targets a
specific one. Note in the history output that the rollback appears as a new
revision.

### Pause and resume

```bash
kubectl -n tasklane-basics rollout pause deploy/hello-api
kubectl -n tasklane-basics set env deploy/hello-api RELEASE=3
kubectl -n tasklane-basics get rs -l app.kubernetes.io/name=hello-api
kubectl -n tasklane-basics rollout resume deploy/hello-api
```

```console include="captures/k8s-beginner/rollout-12-pause-resume.txt"
```

While paused, template changes are recorded but no new ReplicaSet is scaled
up. That lets you batch several edits into one rollout — and it is the
mechanism behind a manual canary: pause, scale the new ReplicaSet by hand,
watch, then resume or undo.

## Common patterns

- **`maxSurge: 1, maxUnavailable: 0`** for user-facing services with spare
  capacity; **`maxUnavailable: 1, maxSurge: 0`** when capacity is tight and a
  brief dip is acceptable.
- **A readiness probe that means something.** A rolling update is only safe
  because readiness gates it; a probe that returns 200 unconditionally turns
  it into a fast outage.
- **`minReadySeconds` of a few seconds** to catch pods that pass readiness
  once and then crash.
- **Set `kubernetes.io/change-cause` in the same change** as the template, or
  have your pipeline set it from the commit SHA.
- **`kubectl rollout status --timeout=...` in CI**, and fail the job on a
  non-zero exit.
- **Roll forward, not back, when the schema changed.** A rollback runs old
  code against a migrated database.

## Production considerations

- **Graceful shutdown is what makes a rollout invisible.** The pod must fail
  readiness, let the EndpointSlice update propagate, and only then stop
  accepting connections. Tasklane's `SHUTDOWN_DELAY_SECONDS` exists for that
  gap.
- **Removing an endpoint is not instantaneous.** kube-proxy on every node
  must be programmed; a few hundred milliseconds of in-flight requests to a
  terminating pod is normal, which is why draining matters.
- **PodDisruptionBudgets do not apply to rollouts.** They cover voluntary
  disruptions such as node drains. Rollout safety comes from
  `maxUnavailable`.
- **Rollouts and autoscaling interact.** An HPA may scale during a rollout;
  with `maxSurge` in percentage terms the absolute numbers move underneath
  you.
- **Databases do not roll back.** Make migrations backwards-compatible
  (expand, migrate, contract) so that both versions can run at once — which
  they will, mid-rollout.
- **Keep an eye on total pods during a rollout.** `maxSurge` plus the HPA's
  ceiling is the real peak your quota must accommodate.

## Security considerations

- **Rollback re-runs an old image.** If you rolled forward to patch a CVE,
  rolling back reintroduces it. Prune history after a security release, or
  record which revisions are forbidden.
- **`kubectl set image` bypasses your review process.** It is a legitimate
  emergency tool; if it is your normal release path, the audit log is your
  only record of what shipped.
- **Image tags are mutable by default.** An attacker who can push to a tag
  can change what your "unchanged" Deployment runs on the next pod
  recreation. Deploy by digest, or enforce signatures — see
  [supply chain admission](../k8s-security/supply-chain-admission.md).
- **A paused Deployment hides changes.** Someone can stage a template change
  that only takes effect when a third party resumes it.

## Troubleshooting

| Symptom | Cause | Where to look |
|---|---|---|
| `rollout status` never returns | New pods not becoming ready | `kubectl describe pod` on the new pods |
| `ProgressDeadlineExceeded` | Nothing progressed within the deadline | `kubectl describe deploy`, events |
| New pods `ImagePullBackOff` | Wrong tag, missing image in kind, no pull secret | Pod events |
| Rollout finished but old pods remain | They belong to another selector or were orphaned | `kubectl get pods --show-labels` |
| `undo` says it cannot find a revision | `revisionHistoryLimit` discarded it | `kubectl rollout history` |
| Every apply triggers a rollout | Something mutates the template: a webhook, or a changing annotation | Compare `spec.template` between revisions |
| Traffic errors during rollout | No readiness probe, or no graceful shutdown | Probes and `terminationGracePeriodSeconds` |

## Common mistakes

- **Changing the image tag in place** (`:latest`, or re-pushing a tag)
  instead of changing the tag, so the template never changes and no rollout
  happens.
- **Treating `kubectl apply` as the end of the release.** Watch
  `rollout status`.
- **Deleting pods to speed up a rollout.** The old ReplicaSet just recreates
  them.
- **`maxUnavailable: 0` with `replicas: 1`** and no spare capacity: the
  rollout cannot start until a node has room for a second pod.
- **Assuming a failed rollout rolls itself back.** It does not.
- **Rolling back the code but not the configuration.** ConfigMaps and Secrets
  are separate objects with no revision history of their own.

## Related topics

- [Deployments and ReplicaSets](deployments-and-replicasets.md)
- [Probes](../k8s-intermediate/probes.md)
- [Pod lifecycle and termination](../k8s-intermediate/pod-lifecycle-and-termination.md)
- [Progressive delivery](../k8s-advanced/progressive-delivery.md)
- [Debugging basics](debugging-basics.md)
