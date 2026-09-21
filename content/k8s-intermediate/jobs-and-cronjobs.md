---
title: Jobs and CronJobs
description: Run-to-completion workloads - completions and parallelism, failure handling with backoffLimit, podFailurePolicy and backoffLimitPerIndex, success policies, and scheduled jobs that behave.
level: intermediate
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/pods
  - k8s-intermediate/pod-lifecycle-and-termination
---

## Overview

A Job (`batch/v1`) runs pods until a specified number of them **succeed**, then
stops. A CronJob (`batch/v1`) creates Jobs on a schedule. Both are the
run-to-completion counterpart to Deployments, and both have far more failure
semantics than people expect.

The core fields:

| Field | Meaning |
|---|---|
| `completions` | how many successful pods make the Job complete (default 1) |
| `parallelism` | how many pods may run at once (default 1) |
| `completionMode` | `NonIndexed` (default) or `Indexed` |
| `backoffLimit` | total pod failures tolerated before the Job fails (default 6) |
| `activeDeadlineSeconds` | wall-clock deadline for the whole Job |
| `ttlSecondsAfterFinished` | delete the finished Job (and its pods) after N seconds |

## Why it exists and when to use it

A Deployment restarts pods forever; a batch task needs the opposite — run once,
record the outcome, and stop. Migrations, imports, report generation, backups
and cleanup all want a Job.

Use a Job for one-off work, an `Indexed` Job for embarrassingly parallel work
where each worker needs to know which shard it owns, and a CronJob for anything
periodic. For work that arrives continuously, a long-running consumer (Tasklane's
worker) is the better shape — a Job per task is expensive and loses ordering.

## How it works underneath

The Job controller creates pods and watches them, tracking each with a finalizer
(`batch.kubernetes.io/job-tracking`, stable since 1.26) so that a controller
restart cannot lose a completed pod's result.

With `completionMode: Indexed` each pod gets an index in
`batch.kubernetes.io/job-completion-index` (annotation and label), exposed in
the pod as `JOB_COMPLETION_INDEX`, and each index must succeed exactly once.

**Failure counting.** A pod that fails counts towards `backoffLimit`, with
exponential backoff between retries (10s, 20s, 40s, capped at 6 minutes). When
the count is exceeded, the controller adds a `FailureTarget` condition,
terminates remaining pods, and then marks the Job `Failed`.

`restartPolicy` decides where the retry happens. With `Never` the kubelet leaves
the failed container alone and the Job controller creates a *new pod*, so each
attempt is visible as a separate object with its own logs. With `OnFailure` the
kubelet restarts the container in place, and you lose that history. Prefer
`Never` for anything you will have to debug.

**`podFailurePolicy`** (**GA since 1.31**) replaces blunt counting with rules
evaluated in order. `onExitCodes` matches container exit codes and
`onPodConditions` matches pod conditions; the actions are:

| Action | Effect |
|---|---|
| `FailJob` | fail the whole Job immediately |
| `FailIndex` | fail just this index (needs `backoffLimitPerIndex`) |
| `Ignore` | do not count this failure towards the limit |
| `Count` | default handling |

It requires `restartPolicy: Never`. The canonical pair of rules is "exit code 42
means a bug, stop now" and "a `DisruptionTarget` condition means the node went
away, do not blame the workload".

**`backoffLimitPerIndex`** (**GA since 1.33**) gives each index its own retry
budget, with `maxFailedIndexes` bounding how many may fail before the Job gives
up. Without it, one poisonous index burns the whole Job's budget.

**`successPolicy`** (**GA since 1.33**) lets an Indexed Job finish early:
`rules` with `succeededIndexes` (an interval list such as `0-2`),
`succeededCount`, or both. A Job meeting it gets the `SuccessCriteriaMet`
condition with reason `SuccessPolicy`, and remaining pods are terminated.

**`podReplacementPolicy`** (**GA since 1.34**) chooses whether a replacement pod
is created as soon as a pod starts terminating (`TerminatingOrFailed`, the
default) or only once it is fully `Failed`. Set it to `Failed` when two copies
must never run at once. When a `podFailurePolicy` is set, `Failed` is the
default.

**`managedBy`** (**GA since 1.35**) tells the built-in controller to keep its
hands off a Job that an external controller — MultiKueue and similar — will
reconcile. Setting it to anything other than the built-in value makes the
cluster's Job controller ignore the object entirely, which is a very effective
way to create a Job that never runs if you set it by accident.

**CronJob.** A controller evaluates every schedule roughly once a minute. For
each missed schedule within `startingDeadlineSeconds` it creates a Job named
`<cronjob>-<timestamp>`. `timeZone` (**GA since 1.27**) interprets the schedule
in a named IANA zone instead of the controller's own. `concurrencyPolicy` is
`Allow` (default), `Forbid` or `Replace`. If more than 100 schedules are missed
without a `startingDeadlineSeconds`, the controller logs an error and schedules
nothing until the next tick — which is how a controller outage turns into a
permanently stuck CronJob.

## Basic example

Tasklane's nightly cleanup:

```yaml include="examples/k8s/07-reliability/20-cronjob.yaml"
```

```bash
kubectl -n tasklane get cronjob -o wide
```

```console include="captures/k8s-intermediate/cronjob.txt"
```

## Explanation

The schedule runs at 02:30 in an explicitly named zone, so it does not move when
the cluster's controller has a different idea of local time.
`concurrencyPolicy: Forbid` means a run that somehow overlaps the previous one
is skipped rather than doubled. `startingDeadlineSeconds: 600` allows a late
start after a brief control-plane outage but not a stampede of catch-up runs.

Inside, `restartPolicy: Never` plus `backoffLimit: 3` gives three visible
attempts. `activeDeadlineSeconds: 900` stops a statement blocked on a lock from
holding a pod all day, and `ttlSecondsAfterFinished: 86400` keeps the namespace
from accumulating a Job object per night.

The container is the PostgreSQL image running one idempotent `DELETE`. The
Tasklane binaries have no cleanup subcommand, and inventing one would be
worse than using the tool that already exists. The shell wrapper exists because
libpq has no `PGPASSWORD_FILE`: Tasklane's own convention is a path, so the
script reads the file and exports `PGPASSWORD` for that single process.

Test it without waiting for 02:30:

```bash
kubectl -n tasklane create job --from=cronjob/tasklane-cleanup cleanup-manual
kubectl -n tasklane wait --for=condition=Complete job/cleanup-manual --timeout=120s
kubectl -n tasklane logs job/cleanup-manual
```

```console include="captures/k8s-intermediate/cronjob-run.txt"
```

## Common patterns

**Parallel sharding with an Indexed Job.**

```yaml title="import-shards.yaml" fragment
spec:
  completions: 12
  parallelism: 4
  completionMode: Indexed
  backoffLimitPerIndex: 2
  maxFailedIndexes: 3
```

Each pod reads `JOB_COMPLETION_INDEX` and processes its twelfth of the input.
Two retries per shard, and the Job gives up after three shards prove hopeless.

**Fail fast on real bugs, ignore infrastructure noise.**

```yaml title="import-failure-policy.yaml" fragment
spec:
  backoffLimit: 6
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: import
          image: registry.example.com/importer:2.3.0
  podFailurePolicy:
    rules:
      - action: FailJob
        onExitCodes:
          containerName: import
          operator: In
          values: [42]
      - action: Ignore
        onPodConditions:
          - type: DisruptionTarget
```

**Always set `ttlSecondsAfterFinished`.** Otherwise finished Jobs accumulate
until someone notices etcd is full of them. CronJobs also have
`successfulJobsHistoryLimit` and `failedJobsHistoryLimit` (default 3 and 1).

**Make the work idempotent.** At-least-once is the only guarantee on offer:
a node can die after the work completed but before the status is recorded.

**Suspend instead of delete.** `spec.suspend: true` pauses a Job (and a CronJob)
without losing it, which is the polite way to stop a runaway import.

## Production considerations

CronJob schedules are cluster-local unless you set `timeZone`, and daylight
saving makes "02:30 local" either run twice or not at all in a named zone —
prefer UTC for anything where a skipped or doubled run matters.

Concurrency is the field people get wrong. `Allow` plus a job that occasionally
runs long equals two copies of your billing run. Decide explicitly.

Batch pods compete with serving pods for node resources. Give them requests and
a low-priority `PriorityClass` so a big import cannot starve the API, and
remember that a Job pod has the same QoS rules as anything else.

For anything bigger than a nightly cleanup — queues, fair sharing, gang
scheduling, quotas per team — look at Kueue rather than hand-rolling it with
`parallelism`.

## Security considerations

A Job that talks to a database needs credentials, and the pod spec is the worst
place to keep them. Mount a Secret as a file, as the cleanup CronJob does, and
give the Job its own ServiceAccount with `automountServiceAccountToken: false`
unless it genuinely calls the Kubernetes API.

`kubectl create job --from=cronjob/...` inherits everything, including the
ServiceAccount — so the RBAC granted to a CronJob is also granted to anyone who
can create Jobs in that namespace. Scope it accordingly.

Batch pods are often the least-reviewed manifests in a repository and the most
likely to run as root "because it is just a script". The restricted Pod Security
profile applies here exactly as it does to the API: non-root, no privilege
escalation, capabilities dropped, seccomp `RuntimeDefault`.

Long-lived finished Jobs keep their pod specs, and with them any environment
variable someone inlined. `ttlSecondsAfterFinished` limits that exposure window.

## Troubleshooting

```bash
kubectl -n tasklane get jobs
kubectl -n tasklane describe job <name>
kubectl -n tasklane logs job/<name> --all-containers
```

**`BackoffLimitExceeded`.** The pods failed more times than allowed; read the
logs of the *failed* pods (they are separate objects with `restartPolicy:
Never`), not the Job.

**`DeadlineExceeded`.** `activeDeadlineSeconds` fired. The Job is marked failed
and its pods are terminated, even if they were making progress.

**CronJob never fires.** Check `spec.suspend`, then `kubectl -n <ns> get events`
for `FailedNeedsStart`, then the schedule syntax, then whether the controller
skipped more than 100 windows.

**Job completed but nothing happened.** Check `managedBy`: if it names an
external controller that is not installed, the built-in controller ignores the
Job.

## Common mistakes

- **`restartPolicy: OnFailure` on anything you need to debug**, losing the
  history of each attempt.
- **Relying on the default `backoffLimit: 6`** for an Indexed Job, where one bad
  index consumes the whole budget. Use `backoffLimitPerIndex`.
- **No `ttlSecondsAfterFinished`**, so Jobs pile up forever.
- **`concurrencyPolicy: Allow`** on a job that must never overlap.
- **Assuming exactly-once.** It is at-least-once; make the work idempotent.
- **A CronJob with no `timeZone`**, scheduled by someone in a different one.
- **`podFailurePolicy` with `restartPolicy: OnFailure`** — the API rejects it.
- **Using Jobs as a work queue** for a high-rate stream: pod startup dominates.

## Related topics

- [Pod lifecycle and termination](pod-lifecycle-and-termination.md)
- [Init and sidecar containers](init-and-sidecar-containers.md)
- [Requests and limits](resources-requests-limits.md)
- [Priority and preemption](../k8s-advanced/priority-and-preemption.md)
- [KEDA](../k8s-advanced/keda.md)
- [Velero backup and restore](../operations/velero-backup-and-restore.md)
