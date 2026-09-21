---
title: Probes
description: How the kubelet's prober decides a container is alive, ready or still starting, and which probe mistakes cause outages.
level: intermediate
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/pods
  - k8s-beginner/deployments-and-replicasets
  - k8s-beginner/services
---

## Overview

A probe is a periodic check the kubelet runs against a container. There are
three kinds, and they do completely different things:

| Probe | Failure causes | Runs when |
|---|---|---|
| `startupProbe` | the container is killed and restarted | from container start until its first success |
| `livenessProbe` | the container is killed and restarted | after the startup probe succeeds (or immediately, if there is none) |
| `readinessProbe` | the pod's addresses are marked not-ready, so Services stop sending traffic | for the whole life of the container |

The distinction that matters: **liveness restarts, readiness redirects.** A
restart is a blunt instrument that throws away in-memory state and a running
process. Removing a pod from a Service is cheap and reversible.

## Why it exists and when to use it

Without probes, Kubernetes only knows whether a process exited. A process that
is running but wedged — deadlocked, stuck on an exhausted connection pool,
still loading a 4 GB model — looks perfectly healthy. Probes let the container
tell the truth about itself.

Use a **readiness** probe on anything that receives traffic. Use a **liveness**
probe when you have a concrete failure mode that a restart genuinely fixes, and
only then. Use a **startup** probe when a container is slow or variable to
start, so the liveness probe does not shoot it during boot.

## How it works underneath

Probes are executed by the kubelet on the node, by a component called the
prober. Nothing in the control plane is involved in running them — the API
server never calls your pod.

For each container the kubelet starts one prober worker per configured probe.
A worker sleeps `periodSeconds`, performs the check with a `timeoutSeconds`
deadline, and records the result:

- **`httpGet`** — the kubelet opens a TCP connection to the pod IP and sends an
  HTTP GET. Any status from 200 to 399 is a success. The kubelet connects
  directly to the pod; there is no Service, no DNS and no NetworkPolicy in the
  path, because the traffic originates on the node.
- **`tcpSocket`** — a TCP connection is opened and immediately closed. Success
  means the port accepted the connection, which says nothing about the
  application behind it.
- **`exec`** — a command runs inside the container's namespaces through the CRI.
  Exit code 0 is a success. This is the most expensive kind: it forks a process
  on every period, and a busy node running hundreds of exec probes feels it.
- **`grpc`** — the kubelet calls the standard gRPC Health Checking service
  (**stable since 1.27**). Named ports are not supported here.

Results are consumed differently per probe kind. The prober tracks consecutive
results against `failureThreshold` and `successThreshold`. When a liveness or
startup probe crosses its failure threshold, the kubelet kills the container and
the pod's `restartPolicy` (and the backoff timer) decides what happens next; the
pod object is not recreated and the pod keeps its name, node and IP. When a
readiness probe crosses its threshold, the kubelet patches the pod's
`Ready` condition; the EndpointSlice controller watches pods, rewrites the
`ready` condition on that pod's endpoint, and kube-proxy (or a Gateway data
plane) stops selecting it. That path runs through the API server, so it is not
instantaneous — expect a second or so before traffic actually stops.

Field defaults, from the Pod API:

| Field | Default | Meaning |
|---|---|---|
| `initialDelaySeconds` | 0 | delay before the first check |
| `periodSeconds` | 10 | how often to check |
| `timeoutSeconds` | 1 | per-check deadline |
| `successThreshold` | 1 | consecutive successes to pass (must be 1 for liveness and startup) |
| `failureThreshold` | 3 | consecutive failures to act |

A probe may also set `terminationGracePeriodSeconds` to override the pod's grace
period for a probe-triggered kill (**GA since 1.28**).

## Basic example

Tasklane's API defines all three probes:

```yaml include="examples/k8s/03-app/api.yaml" lines="93-116"
```

The application backs this up: `/healthz` answers from the process and never
touches PostgreSQL, while `/readyz` pings the database.

## Explanation

The startup probe fires every 2 seconds with `failureThreshold: 15`, so the
container gets up to 30 seconds to answer once before anything else runs. That
budget is `periodSeconds × failureThreshold`; a startup probe is the right place
for a generous number, because the budget ends the moment the container answers.

The liveness probe hits `/healthz`. Its only job is to detect a process that is
running but permanently unable to serve. It tolerates three failures at 10
second intervals, so a transient hiccup does not restart a healthy pod.

The readiness probe hits `/readyz`, which pings the database. When PostgreSQL
is down, every API pod fails readiness, the Service loses its endpoints, and
callers get a connection failure instead of a slow 500. The pods stay running
and rejoin automatically when the database returns.

## Common patterns

**Separate endpoints, separate semantics.** `/healthz` must not check
dependencies. `/readyz` may. One handler serving both is the single most common
cause of the outage in the next section.

**Budget the failure window explicitly.** The time to act is
`periodSeconds × failureThreshold` plus up to `timeoutSeconds`. Write the number
you intend in a comment; people tune `failureThreshold` without noticing they
have changed a 30 second window into five minutes.

**Fail readiness on shutdown.** On SIGTERM, fail readiness first and keep
serving for a few seconds while the endpoint removal propagates. Tasklane does
this with `SHUTDOWN_DELAY_SECONDS`; see
[pod lifecycle and termination](pod-lifecycle-and-termination.md).

**Use a startup probe instead of a long `initialDelaySeconds`.** A fixed delay
is dead time on every restart even when the app starts in 200 ms.

## Production considerations

Probe traffic is real traffic. At `periodSeconds: 1` with 200 replicas you have
added 200 requests per second of load that no dashboard attributes to anyone.
Keep probe handlers cheap and allocation-free, and never let one take a lock the
request path needs.

Make probe handlers exempt from request logging and from rate limits, or your
logs become 90% probe noise and a burst of probes can trip your own throttle.

Probe results do not survive the kubelet: if the kubelet restarts, probe state
is rebuilt from scratch, which is why a kubelet restart can produce a short
flurry of readiness transitions.

For jobs and batch pods, probes are usually pointless — there is no Service and
a restart loop hides the real failure. Prefer `restartPolicy: Never` and let the
Job controller count failures.

## Security considerations

`httpGet` probes can carry `httpHeaders`, but anything you put there is visible
to anyone who can read the pod spec. Never put a token in a probe header.

Health endpoints are unauthenticated by definition — the kubelet has no
credentials. Keep them free of diagnostics: version strings, dependency
hostnames, queue depths and stack traces on a `/healthz` that is also routed
through your Gateway are free reconnaissance. Bind them to a separate port that
no Service exposes if you can.

`exec` probes run a real process inside the container with the container's
identity. A probe that shells out to a script in a writable directory is a
persistence mechanism for anyone who can write there; keep
`readOnlyRootFilesystem: true`.

## Troubleshooting

Start with the pod's events and the container's restart count:

```bash
kubectl -n tasklane describe pod -l app.kubernetes.io/name=tasklane-api
```

```console include="captures/k8s-intermediate/api-pod-describe.txt"
```

`Liveness probe failed: ...` and `Readiness probe failed: ...` appear as events
with the exact error — connection refused, timeout, or the HTTP status. A high
`Restart Count` with liveness events is a liveness misconfiguration until
proven otherwise.

To see what the probe sees, run the same request from inside the pod's network
namespace rather than from your laptop:

```bash
kubectl -n tasklane debug -it <pod> --image=<an image with a shell> --target=api -- sh
```

The Tasklane images are distroless and have no shell, so an ephemeral debug
container is the only way in. `--target=api` puts it in the same process
namespace, so `localhost` means the same thing it does to the probe.

A readiness probe that never passes shows up as a Service with no endpoints:

```bash
kubectl -n tasklane get endpointslices -l kubernetes.io/service-name=tasklane-api -o wide
```

```console include="captures/k8s-intermediate/endpointslices.txt"
```

## Common mistakes

- **Liveness probe that checks the database.** When the database blips, every
  replica fails liveness at once, every replica restarts, and the restarts hit
  the recovering database with a thundering herd of reconnects and migrations.
  The application was fine; the probe caused the outage. Dependencies belong in
  readiness.
- **Readiness probe used as a liveness probe.** A pod that is permanently
  unready but never restarted sits there forever with no traffic and no alarm.
- **`timeoutSeconds` left at 1 for an exec probe.** Forking a shell on a loaded
  node regularly takes longer than a second, and the container is killed for
  being busy.
- **No startup probe on a slow starter.** The liveness probe kills the
  container mid-boot, forever, and the symptom is `CrashLoopBackOff` with no
  application error.
- **Probing a different port than the app serves.** A `tcpSocket` probe on a
  port that some sidecar happens to hold is green forever.
- **`successThreshold` above 1 on a liveness probe.** The API server rejects it;
  the value is only meaningful for readiness.
- **Assuming probes stop traffic instantly.** Endpoint removal is eventually
  consistent. A pod can receive requests for a moment after failing readiness.

## Related topics

- [Pod lifecycle and termination](pod-lifecycle-and-termination.md)
- [Init and sidecar containers](init-and-sidecar-containers.md)
- [kube-proxy and EndpointSlices](kube-proxy-and-endpointslices.md)
- [Failing probes](../troubleshooting/failing-probes.md)
- [CrashLoopBackOff](../troubleshooting/crashloopbackoff.md)
- [Service has no endpoints](../troubleshooting/service-no-endpoints.md)
- [Healthchecks in Docker](../docker-intermediate/healthchecks.md)
