---
title: CrashLoopBackOff
description: Why a container that keeps exiting lands in CrashLoopBackOff, how to read the exit code and back-off, and how to tell config from code from a missing dependency.
level: intermediate
type: troubleshooting
status: current
versions: Kubernetes 1.37
prerequisites:
  - troubleshooting/method
  - k8s-intermediate/probes
  - k8s-intermediate/pod-lifecycle-and-termination
---

## Overview

`CrashLoopBackOff` is not an error in itself — it is Kubernetes telling you it
has given up restarting a container *quickly* because the container keeps
exiting. The real error is whatever makes the process die. This page shows how
the back-off works, how to read the exit code, and how to sort the three usual
causes: bad configuration, a code bug, and a missing dependency.

## Symptoms

- `kubectl get pods` shows `STATUS: CrashLoopBackOff` and a `RESTARTS` count
  that climbs.
- The pod flickers between `Running`, `Error`/`Completed` and `CrashLoopBackOff`
  as the kubelet retries.
- `describe pod` shows the container `State: Waiting, Reason: CrashLoopBackOff`
  and `Last State: Terminated` with an exit code.

Reproducer (a process that exits 1 on every start):

```yaml include="examples/troubleshooting/crashloopbackoff.yaml"
```

```console include="captures/troubleshooting/crashloop.txt"
```

## How it works underneath

A container's `restartPolicy` (default `Always` for a bare Pod and for
Deployment-managed pods) tells the kubelet to restart a container that exits.
To avoid hammering a container that dies instantly, the kubelet applies an
**exponential back-off**: the delay starts at 10 seconds and doubles on each
failure — 10s, 20s, 40s — capped at **5 minutes**. While the kubelet is waiting
out that delay, the container's state is `Waiting` with reason
`CrashLoopBackOff`. After a container stays up for 10 minutes, the back-off
resets.

So `CrashLoopBackOff` means: the container has exited at least twice and the
kubelet is now spacing out restarts. The **exit code** in `Last State` is the
diagnostic:

| Exit code | Meaning |
|---|---|
| `0` | clean exit — with `restartPolicy: Always` even this restarts; you probably wanted a Job or a long-running process |
| `1`, `2` | generic application error — read the logs |
| `126` / `127` | command not executable / not found — bad `command`/entrypoint or wrong base image |
| `128 + N` | killed by signal N; `137` = 128 + 9 (SIGKILL, usually OOM), `143` = 128 + 15 (SIGTERM) |

`restartPolicy` has three values: `Always`, `OnFailure` (restart only on
non-zero exit) and `Never`. A pod that exits 0 under `OnFailure` will *not*
loop; one under `Always` will. Container-level restart rules (Beta in 1.37)
can refine this per container, but the pod default is what you are usually
fighting.

### Startup timing is a hidden cause

If a container is slow to become healthy and a **liveness probe** starts checking
too early, the kubelet kills it before it is ready, and it crash-loops with no
crash in the application logs. That is a probe problem masquerading as a crash
loop — use a `startupProbe` to hold liveness off until the process is up, rather
than a long `initialDelaySeconds`. See [failing probes](failing-probes.md).

## Diagnosis

1. **Read the exit code and reason.**

   ```bash
   kubectl -n <ns> describe pod <pod>
   ```

   Look at `Last State: Terminated`, its `Exit Code` and `Reason`. `Reason:
   OOMKilled` with code `137` is memory, not a code bug — go to
   [OOMKilled](oomkilled.md).

2. **Read the previous container's logs.** The running attempt may be too young
   to have logged the error; `--previous` reads the one that just died.

   ```bash
   kubectl -n <ns> logs <pod> --previous --tail=50
   ```

3. **Get the exit code without describe**, handy in scripts:

   ```bash
   kubectl -n <ns> get pod <pod> -o jsonpath='{.status.containerStatuses[0].lastState.terminated.exitCode}'
   ```

4. **Classify config vs code vs dependency:**
   - **Config**: the logs name a missing/invalid env var, file or flag. It
     fails identically on every restart, immediately.
   - **Code**: a panic, stack trace or assertion. Also immediate, but the
     message is internal.
   - **Dependency**: the logs show connection timeouts/refused to a database or
     API. Often it starts, runs a while, then dies — and may recover on its own
     when the dependency returns.

## Fixes

- **Config error.** Fix the ConfigMap/Secret/flag the logs point at and let the
  pod restart. If the app needs an env var it is not getting, confirm it is
  actually set: `kubectl exec <pod> -- env` (on a running instance) or check the
  `envFrom`/`env` in the manifest.
- **Code bug.** Fix and rebuild the image, push a new tag (never reuse a tag —
  see [ImagePullBackOff](imagepullbackoff.md)), and roll it out.
- **Missing dependency.** Do not paper over it with a liveness probe. Use an
  init container or a readiness gate to wait for the dependency, and make the
  app retry with backoff instead of exiting. The Tasklane `migrate` init
  container is exactly this pattern: it retries the database before the app
  pods start.
- **Exited 0 but looping.** You wanted a one-shot. Use a `Job`/`CronJob`, or
  `restartPolicy: OnFailure`, instead of a Deployment.

To iterate quickly without a crash loop fighting you, run a throwaway copy that
does not restart:

```bash
kubectl -n <ns> debug <pod> --copy-to=debug-pod --image=busybox:1.37 -- sleep 3600
```

## Prevention

- Make the process **fail loudly and log the reason** before exiting; a bare
  non-zero exit with no log is the hardest crash loop to debug.
- Separate **liveness** (is the process alive?) from **readiness** (should it
  get traffic?) and **startup** (is it up yet?). Liveness must never depend on a
  database, or an outage restarts every pod.
- Set a `startupProbe` for slow starters instead of a big `initialDelaySeconds`.
- Pin dependencies behind init containers or retries, so a slow database is a
  delay, not a crash loop.
- Give the container the resources it needs so it is not OOMKilled at start.

## Common mistakes

- Reading current logs instead of `--previous` and seeing only the newest,
  still-starting attempt.
- Treating `137`/`OOMKilled` as a code bug — it is a memory limit.
- Adding a liveness probe to "fix" a crash loop, turning a dependency wait into
  a permanent restart loop.
- Reusing the same image tag after a fix, so nodes keep the old cached image.
- Using a Deployment for a task that should exit, then being surprised it loops.

## Related topics

- [A method for debugging Kubernetes](method.md)
- [OOMKilled](oomkilled.md)
- [Failing probes](failing-probes.md)
- [ImagePullBackOff and ErrImagePull](imagepullbackoff.md)
- [Probes](../k8s-intermediate/probes.md)
- [Pod lifecycle and termination](../k8s-intermediate/pod-lifecycle-and-termination.md)
