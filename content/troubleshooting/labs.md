---
title: Troubleshooting labs
description: A break-and-fix lab — apply nine deliberately broken manifests, diagnose each with the method, and fix it, with full solutions.
level: intermediate
type: lab
status: current
versions: Kubernetes 1.37
prerequisites:
  - troubleshooting/method
  - troubleshooting/crashloopbackoff
  - troubleshooting/service-no-endpoints
---

## Overview

This lab makes you *do* the method. You apply broken manifests from
`examples/troubleshooting/`, one per common failure, and for each one you name
the symptom, find the cause with `describe`/`events`/`logs`, and apply the fix.
Every reproducer is real: the YAML is valid and the API server accepts it — the
fault is runtime or logical, exactly like production.

Work in the disposable `troubleshoot` namespace, which enforces the restricted
Pod Security Standard just like `tasklane`. Nothing here touches the running
stack.

:::danger Disposable lab only
Run this only in the kind lab. The reproducers deliberately misbehave (crash
loops, a bounded memory hog, a pod that will not delete). Never apply them to a
cluster you care about.
:::

## Setup

You need the lab cluster and the API image loaded:

```bash
kubectl config current-context
kind load docker-image tasklane-api:0.1.0 --name tasklane
kubectl apply -f examples/troubleshooting/00-namespace.yaml
```

Keep three references open: the [method](method.md) decision tree, and the two
commands you will run constantly:

```bash
kubectl -n troubleshoot get pods -o wide
kubectl -n troubleshoot get events --sort-by=.lastTimestamp
```

The reproducers, one file each:

| Exercise | File | `case=` |
|---|---|---|
| 1 CrashLoopBackOff | `crashloopbackoff.yaml` | `crashloop` |
| 2 ImagePullBackOff | `imagepullbackoff.yaml` | `imagepull` |
| 3 Pending | `pending-unschedulable.yaml` | `pending` |
| 4 OOMKilled | `oomkilled.yaml` | `oomkilled` |
| 5 CreateContainerConfigError | `createcontainerconfigerror.yaml` | `cce` |
| 6 Failing readiness probe | `failing-probes.yaml` | `failing-probes` |
| 7 Service with no endpoints | `service-no-endpoints.yaml` | `service-no-endpoints` |
| 8 PVC stuck Pending | `pvc-pending.yaml` | `pvc-pending` |
| 9 Pod stuck Terminating | `stuck-terminating.yaml` | `stuck-terminating` |

## Exercises

For each: **apply it, classify the symptom (schedule / start / run / network /
storage), find the cause, then fix it and confirm the object recovers.** Try
each before reading its solution.

### Exercise 1 — CrashLoopBackOff

```bash
kubectl apply -f examples/troubleshooting/crashloopbackoff.yaml
kubectl -n troubleshoot get pods -l case=crashloop -w
```

Questions: what bucket is this? What is the container's exit code, and where do
you read the *reason* it exits? Why does `kubectl logs` (without `--previous`)
sometimes show nothing useful?

### Exercise 2 — ImagePullBackOff

```bash
kubectl apply -f examples/troubleshooting/imagepullbackoff.yaml
```

Questions: why are there no application logs? What exact registry message does
`describe` show, and what does it tell you about tag vs registry vs auth? What
one command would fix a *local* image that simply was not loaded?

### Exercise 3 — Pending

```bash
kubectl apply -f examples/troubleshooting/pending-unschedulable.yaml
```

Questions: read the `FailedScheduling` message. Is the blocker a request, an
affinity rule, or a taint? Would raising the node count help here, or is the
request itself impossible?

### Exercise 4 — OOMKilled

```bash
kubectl apply -f examples/troubleshooting/oomkilled.yaml
```

Questions: what is the exit code, and what reason does the *last* state show? Is
this a container-limit kill or node pressure? How would you tell the difference?

### Exercise 5 — CreateContainerConfigError

```bash
kubectl apply -f examples/troubleshooting/createcontainerconfigerror.yaml
```

Questions: did any process run? Which object and key does `describe` name? What
are two different ways to make it start (one that provides the value, one that
tolerates its absence)?

### Exercise 6 — Failing readiness probe

```bash
kubectl apply -f examples/troubleshooting/failing-probes.yaml
```

Questions: the pod is `Running` but `0/1 READY` and never restarts — why no
restart? What would change if this were the *liveness* probe instead? Confirm
the container is actually healthy from inside.

### Exercise 7 — Service with no endpoints

```bash
kubectl apply -f examples/troubleshooting/service-no-endpoints.yaml
```

Questions: the pods are Ready but the Service answers nothing. Prove the
endpoint set is empty. What is the mismatch, and why does DNS still resolve the
Service name?

### Exercise 8 — PVC stuck Pending

```bash
kubectl apply -f examples/troubleshooting/pvc-pending.yaml
```

Questions: what does `describe pvc` say? How is this different from a normal
`WaitForFirstConsumer` Pending? Which command lists the classes that *do* exist?

### Exercise 9 — Pod stuck Terminating

```bash
kubectl apply -f examples/troubleshooting/stuck-terminating.yaml
kubectl -n troubleshoot delete pod stuck-terminating --wait=false
```

Questions: why will the pod not delete? Where do you find the blocker? What is
the risk of the "quick fix," and when is it acceptable?

## Solutions

### 1 — CrashLoopBackOff (bucket: run)

The container exits `1` every start, so the kubelet backs off restarts and marks
`CrashLoopBackOff`. Read the reason, not just the code:

```bash
kubectl -n troubleshoot describe pod -l case=crashloop | tail -25
kubectl -n troubleshoot logs -l case=crashloop --previous --tail=20
```

`--previous` reads the container that just died; the current attempt may be too
young to have logged. The fix in real life is whatever the log names (config,
dependency or code). Here the fault is a hard-coded `exit 1`. Clean up:

```bash
kubectl delete -f examples/troubleshooting/crashloopbackoff.yaml
```

Full page: [CrashLoopBackOff](crashloopbackoff.md).

### 2 — ImagePullBackOff (bucket: start)

No process ran, so there are no logs; the story is in Events:

```bash
kubectl -n troubleshoot describe pod -l case=imagepull | tail -20
```

The tag `9.9.9-nope` does not exist, so the pull fails: wrong reference, not
auth or rate limit. For a local image that was merely not loaded, the fix is
`kind load docker-image <ref> --name tasklane`. Clean up:

```bash
kubectl delete -f examples/troubleshooting/imagepullbackoff.yaml
```

Full page: [ImagePullBackOff](imagepullbackoff.md).

### 3 — Pending (bucket: schedule)

```bash
kubectl -n troubleshoot describe pod pending | tail -15
```

The `FailedScheduling` message is `Insufficient memory`: the pod requests 900Gi,
larger than any node. Adding nodes will not help — the *request* is impossible.
The fix is a realistic request. Clean up:

```bash
kubectl delete -f examples/troubleshooting/pending-unschedulable.yaml
```

Full page: [Pending pods](pending-pods.md).

### 4 — OOMKilled (bucket: run)

```bash
kubectl -n troubleshoot get pod oomkilled \
  -o jsonpath='{.status.containerStatuses[0].lastState.terminated.reason}{" "}{.status.containerStatuses[0].lastState.terminated.exitCode}{"\n"}'
```

`OOMKilled 137`. This is a **container-limit** kill (16Mi cap tripped by the
hog), not node pressure — the node shows no `MemoryPressure`. The real fix is a
limit that fits the measured working set, or fixing the leak. Clean up:

```bash
kubectl delete -f examples/troubleshooting/oomkilled.yaml
```

Full page: [OOMKilled](oomkilled.md).

### 5 — CreateContainerConfigError (bucket: start)

```bash
kubectl -n troubleshoot describe pod cce | tail -20
```

No process ran; `describe` names `couldn't find key MISSING_KEY in ConfigMap
cce-config`. Two fixes: add the key (or point the env at `GREETING`, which
exists), or mark the reference `optional: true` so a missing key is tolerated —
acceptable only if the app can run without it. Clean up:

```bash
kubectl delete -f examples/troubleshooting/createcontainerconfigerror.yaml
```

Full page: [CreateContainerConfigError](createcontainerconfigerror.md).

### 6 — Failing readiness probe (bucket: run/network)

The pod is `Running`, `0/1 READY`, zero restarts. Readiness failing removes it
from endpoints but never restarts it; only liveness restarts. Prove the app is
healthy:

```bash
kubectl -n troubleshoot debug -it failing-probes --image=busybox:1.37 --target=api -- \
  wget -qO- http://127.0.0.1:8080/healthz
```

The probe points at `/not-ready` (404). Fixing it to `/readyz` makes the pod
Ready. Were this the *liveness* probe, the container would be killed and
restarted in a loop. Clean up:

```bash
kubectl delete -f examples/troubleshooting/failing-probes.yaml
```

Full page: [Failing probes](failing-probes.md).

### 7 — Service with no endpoints (bucket: network)

```bash
kubectl -n troubleshoot get endpointslices -l kubernetes.io/service-name=sample-app -o wide
kubectl -n troubleshoot get svc sample-app -o jsonpath='{.spec.selector}{"\n"}'
kubectl -n troubleshoot get pods --show-labels
```

The EndpointSlice is empty because the selector `app.kubernetes.io/name:
sample-app-typo` matches no pod (the pods are `sample-app`). DNS resolves the
Service regardless — a ClusterIP exists whether or not anything is behind it. Fix
the selector to match. Clean up:

```bash
kubectl delete -f examples/troubleshooting/service-no-endpoints.yaml
```

Full page: [Service has no endpoints](service-no-endpoints.md).

### 8 — PVC stuck Pending (bucket: storage)

```bash
kubectl -n troubleshoot describe pvc pvc-pending | tail -12
kubectl get storageclass
```

`describe` shows the class `fast-ssd-that-does-not-exist` is not found — a hard
error, unlike a normal `WaitForFirstConsumer` Pending that is simply waiting for
a pod. Fix by naming a class from `kubectl get storageclass` (or leaving it
unset for the default). Clean up:

```bash
kubectl delete -f examples/troubleshooting/pvc-pending.yaml
```

Full page: [PVC stuck Pending](pvc-pending.md).

### 9 — Pod stuck Terminating (bucket: finalizers)

```bash
kubectl -n troubleshoot get pod stuck-terminating
kubectl -n troubleshoot get pod stuck-terminating -o jsonpath='{.metadata.finalizers}{"\n"}'
```

The finalizer `example.com/holdme` has no controller to remove it, so deletion
hangs after setting `deletionTimestamp`. The safe fix is to let the owning
controller finish; here there is none, so remove the finalizer manually — knowing
that in production a finalizer usually guards external cleanup and stripping it
can orphan real resources:

```bash
kubectl -n troubleshoot patch pod stuck-terminating --type=merge -p '{"metadata":{"finalizers":null}}'
```

Full page: [Stuck terminating namespace and finalizers](stuck-terminating-namespace.md).

### Tear down

```bash
kubectl delete namespace troubleshoot
```

If the namespace itself hangs in `Terminating`, that is Exercise 9 at namespace
scope — find the resource still holding a finalizer and clear it.

## Common mistakes

- Reaching for `kubectl logs` on Exercises 2 and 5, where nothing ran — the
  answer is in `describe`.
- Forgetting `--previous` on the crash loop and reading only the restarting
  attempt.
- Treating the Pending PVC (8) like a broken pod instead of a storage-class
  problem, or treating a normal `WaitForFirstConsumer` Pending as a fault.
- Force-removing the finalizer in (9) reflexively — safe in this lab, dangerous
  in production where it can orphan cloud resources.
- Changing several fields at once instead of the one the evidence points at, then
  not knowing which change fixed it.

## Related topics

- [A method for debugging Kubernetes](method.md)
- [CrashLoopBackOff](crashloopbackoff.md)
- [OOMKilled](oomkilled.md)
- [Service has no endpoints](service-no-endpoints.md)
- [PVC stuck Pending](pvc-pending.md)
- [Stuck terminating namespace and finalizers](stuck-terminating-namespace.md)
