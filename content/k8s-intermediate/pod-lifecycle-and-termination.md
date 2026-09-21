---
title: Pod lifecycle and termination
description: Phases, conditions and the exact sequence of a graceful shutdown - including the endpoint removal race that drops requests during every rollout.
level: intermediate
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/pods
  - k8s-intermediate/probes
---

## Overview

A pod's `status.phase` is a coarse summary — `Pending`, `Running`, `Succeeded`,
`Failed`, `Unknown` — and it is not where the interesting information lives.
Conditions (`PodScheduled`, `Initialized`, `ContainersReady`, `Ready`,
`PodReadyToStartContainers`) and per-container states (`Waiting`, `Running`,
`Terminated`) carry the detail.

Termination is where most production bugs hide, because deletion is
**concurrent**: the kubelet starts stopping the pod at the same moment the
endpoint controllers start removing it from Services. Nothing orders those two.

## Why it exists and when to use it

Every rollout, every scale-down, every node drain and every eviction runs this
sequence. If your application does not cooperate with it, each of those routine
events drops requests — a background error rate that gets blamed on the network
for months.

## How it works underneath

**Startup**, briefly: the scheduler binds the pod, the kubelet pulls images,
sets up the sandbox (network namespace via CNI), runs init containers in order,
then starts regular containers and begins probing.

**Termination**, in order:

1. Something requests deletion. The API server sets `metadata.deletionTimestamp`
   and `deletionGracePeriodSeconds` on the pod object. The pod now shows as
   `Terminating` in `kubectl get pods`; it is still in `Running` phase.
2. **Two independent things happen next, in parallel.**
   - The **kubelet** on that node sees the deletion timestamp and starts the
     local shutdown: it runs any `preStop` hook, then asks the runtime to send
     the stop signal (SIGTERM unless the image sets `STOPSIGNAL`) to PID 1 of
     each container, then waits.
   - The **EndpointSlice controller** sees the same change, marks the endpoint
     `terminating` and not `ready`, and writes the EndpointSlice. Each
     kube-proxy (and every Gateway data plane, and every client-side load
     balancer) then has to notice and reprogram.
3. If a `preStop` hook is still running when the grace period expires, the
   kubelet grants a one-off extension of **2 seconds**, then proceeds.
4. Sidecars (init containers with `restartPolicy: Always`) receive their stop
   signal only after the last regular container has fully terminated, in reverse
   definition order.
5. When `terminationGracePeriodSeconds` expires, anything still alive gets
   SIGKILL.
6. The kubelet tells the API server the pod is gone; the API server removes the
   object once all finalizers are clear.

Step 2 is the race. The endpoint removal path is: kubelet/API server → endpoint
controller → EndpointSlice object → every kube-proxy on every node → iptables or
nftables rules. That is several hops and, in a busy cluster, hundreds of
milliseconds to seconds. Meanwhile the container may already have closed its
listener. Every request routed in that window fails.

The fix is to make the pod *fail readiness first and keep serving* for long
enough that the removal propagates. There are two ways: a `preStop` hook that
sleeps, or an application that handles SIGTERM by failing readiness and delaying
its own shutdown. Tasklane does the second:

```go include="examples/app/cmd/api/main.go" lines="157-168"
```

`SHUTDOWN_DELAY_SECONDS` is set to 5 in the lab's ConfigMap, and the pod's
`terminationGracePeriodSeconds: 30` leaves 25 seconds for in-flight requests
after that.

## Basic example

The pod-level settings that matter:

```yaml include="examples/k8s/03-app/api.yaml" lines="39-41"
```

For an application you cannot change, do the same thing with a hook:

```yaml title="preStop-sleep.yaml" fragment
lifecycle:
  preStop:
    sleep:
      seconds: 5          # the sleep action: GA since 1.34
terminationGracePeriodSeconds: 30
```

The `sleep` action is native (**GA in 1.34**, and zero-second sleeps allowed
since the same release), so it needs no shell in the image — which matters for
distroless images, where the old `exec: ["sh", "-c", "sleep 5"]` trick simply
fails.

## Explanation

The sequence for a Tasklane API pod during a rollout:

| t | Event |
|---|---|
| 0.00s | Deployment scales the old ReplicaSet down; pod gets `deletionTimestamp` |
| 0.00s | kubelet sends SIGTERM; EndpointSlice controller starts removing the endpoint |
| 0.01s | app sets `draining`, `/readyz` starts returning 503, listener stays open |
| ~0.1–2s | EndpointSlice written, kube-proxy rules updated on every node |
| 5.00s | app calls `srv.Shutdown`: no new connections, in-flight requests finish |
| ≤20.0s | shutdown completes, process exits, container `Terminated` |
| 30.0s | SIGKILL, if the process were still alive |

Nothing here required the readiness probe to run again. Failing `/readyz`
matters for clients that poll it, but the endpoint removal was already triggered
by the deletion itself.

## Common patterns

**Delay, then drain.** Five seconds covers most clusters. Measure with a load
generator: send constant traffic, roll the Deployment, count non-200s.

**`terminationGracePeriodSeconds` sized to the work.** A worker holding a task
for up to 2 seconds needs a few seconds; a video encoder may need 600. The
default is 30.

**Hand work back.** Tasklane's worker returns an in-flight task to the queue on
SIGTERM instead of finishing it, which is usually the right trade for a
restartable unit of work.

**`maxUnavailable: 0`** on the rollout so capacity never dips while pods drain,
paired with `maxSurge: 1`.

**PreStop for the un-modifiable.** Third-party images that ignore SIGTERM (many
shells, some servers) need `preStop` plus an honest grace period.

## Production considerations

PID 1 matters: a shell as PID 1 does not forward signals, so `CMD sh -c "app"`
means your application never sees SIGTERM and always dies by SIGKILL. Use the
exec form, as the Tasklane Dockerfile does.

Long-lived connections (WebSockets, gRPC streams, database sessions) are not
covered by the sequence above. They need application-level draining: stop
accepting, send a GOAWAY or close frame, and let clients reconnect elsewhere.

Node shutdown is a different path: Graceful Node Shutdown has the kubelet
terminate pods in priority order when systemd says the node is going down, with
its own two budgets (`shutdownGracePeriod` and
`shutdownGracePeriodCriticalPods`). It is not the same as a drain, and a
non-systemd node does not get it at all.

`kubectl delete pod --force --grace-period=0` removes the object without waiting
for the kubelet. For a StatefulSet pod with an attached volume that risks two
writers on one disk; use it only when you know the node is truly gone.

Watch the sequence live:

```bash
kubectl -n tasklane rollout restart deployment/tasklane-api
kubectl -n tasklane rollout status deployment/tasklane-api
kubectl -n tasklane logs deployment/tasklane-api --tail=20
```

```console include="captures/k8s-intermediate/rollout-restart-logs.txt"
```

## Security considerations

A `preStop` hook runs with the container's identity and can run arbitrary
commands — `exec` hooks are a supply-chain surface like any other entrypoint.
Prefer the `sleep` action, which executes no user code.

Grace periods are a denial-of-service knob: a pod with
`terminationGracePeriodSeconds: 3600` and a preStop hook that never returns
holds a node's resources for an hour and blocks drains. In a multi-tenant
cluster, cap it with an admission policy.

Secrets live in the pod's tmpfs mounts until the kubelet tears the pod down. A
pod that lingers `Terminating` — often because of a finalizer — keeps them
mounted and keeps its ServiceAccount token valid, which is worth knowing when
containing an incident: delete the pod *and* confirm it is gone.

An application that dies by SIGKILL never flushes audit logs. If your compliance
story depends on those logs, it depends on handling SIGTERM.

## Troubleshooting

**Requests fail during every deploy.** The endpoint race. Add a shutdown delay
and confirm `maxUnavailable: 0`.

**Pod stuck `Terminating`.** Check for finalizers
(`kubectl get pod <p> -o jsonpath='{.metadata.finalizers}'`), then for a node
that is `NotReady` — the kubelet must confirm the deletion, and a dead node
never will.

**Container killed after exactly the grace period.** It ignored SIGTERM. Check
PID 1 and the signal handling.

**`preStop` seems not to run.** It does not run when the container has already
exited, and it is skipped entirely for `terminationGracePeriodSeconds: 0`.

## Common mistakes

- **Assuming endpoint removal happens before SIGTERM.** It does not; the two are
  concurrent.
- **A shell as PID 1** swallowing SIGTERM.
- **Grace period shorter than the work.** In-flight requests are killed.
- **`preStop: exec: ["sh", "-c", "sleep 5"]` in a distroless image** — there is
  no shell. Use the `sleep` action.
- **Counting on the readiness probe to remove endpoints on shutdown.** Deletion
  already did; the probe matters for the *non*-deletion cases.
- **Force-deleting StatefulSet pods** as a habit.
- **Ignoring sidecar shutdown order** and writing preStop hooks that are no
  longer needed.

## Related topics

- [Probes](probes.md)
- [Init and sidecar containers](init-and-sidecar-containers.md)
- [kube-proxy and EndpointSlices](kube-proxy-and-endpointslices.md)
- [Pod disruption budgets](pod-disruption-budgets.md)
- [PID 1, signals and graceful shutdown](../docker-intermediate/pid1-signals-graceful-shutdown.md)
- [Rolling updates and rollbacks](../k8s-beginner/rolling-updates-and-rollbacks.md)
- [Stuck terminating namespace](../troubleshooting/stuck-terminating-namespace.md)
