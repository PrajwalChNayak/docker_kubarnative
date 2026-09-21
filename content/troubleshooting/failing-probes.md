---
title: Failing probes
description: How liveness, readiness and startup probes fail — restart loops from liveness, endpoint removal from readiness, probe timeouts under load, and the database-in-liveness anti-pattern.
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

Probes are how the kubelet asks a container two different questions: "are you
alive?" (**liveness**) and "should you get traffic?" (**readiness**), with
**startup** gating the first two until the process is up. Each failure mode
looks different: a failing liveness probe **restarts** the container, a failing
readiness probe **removes it from Services**, and a failing startup probe
prevents it from ever being considered started. Getting the wrong probe, or the
wrong dependency in a probe, causes some of the most confusing symptoms in
Kubernetes.

## Symptoms

- **Readiness failing:** pod is `Running` but `READY 0/1`; it is absent from the
  Service's EndpointSlices and gets no traffic. No restarts.
- **Liveness failing:** the container restarts repeatedly, ending in
  `CrashLoopBackOff`, but the application logs show no crash — it was killed by
  the kubelet.
- **Startup failing:** the pod never leaves `Running`/not-ready and is eventually
  restarted when `failureThreshold * periodSeconds` elapses.
- `describe pod` Events: `Readiness probe failed: HTTP probe failed with
  statuscode: 404` or `Liveness probe failed: ... connection refused`.

Reproducer (a readiness probe pointed at a path that returns 404):

```yaml include="examples/troubleshooting/failing-probes.yaml"
```

```console include="captures/troubleshooting/failing-probes.txt"
```

## How it works underneath

The kubelet runs each configured probe on its own schedule and acts on the
result:

- **livenessProbe** — on `failureThreshold` consecutive failures, the kubelet
  **kills the container**; `restartPolicy` then restarts it. Its job is to
  recover a wedged process. Because it restarts, a mistaken liveness probe is a
  restart loop.
- **readinessProbe** — on failure, the kubelet marks the pod **not Ready**,
  which removes it from every Service's EndpointSlices so it stops receiving
  traffic. It does **not** restart. Its job is to route around a temporarily
  unhealthy pod.
- **startupProbe** — while it has not yet succeeded, liveness and readiness are
  suspended. It exists for slow starters, so a slow boot is not mistaken for a
  liveness failure. Once it succeeds once, it never runs again.

Key fields: `initialDelaySeconds` (wait before the first probe),
`periodSeconds` (how often), `timeoutSeconds` (how long to wait for a response),
`failureThreshold` and `successThreshold`. Probe types are `httpGet`, `tcpSocket`,
`exec` and `grpc`.

### initialDelaySeconds vs startupProbe

A large `initialDelaySeconds` on liveness is a blunt instrument: it delays
*every* check for the pod's whole life, and if you guess too low the pod is
killed during a slow boot, too high and a real hang is caught late. A
`startupProbe` is the correct tool: give it a generous
`failureThreshold * periodSeconds` budget for boot, and keep liveness fast and
tight for steady state. The Tasklane API does exactly this — a `startupProbe`
polls `/healthz` up to 15 times at 2s, then a lean liveness takes over.

### The database-in-liveness anti-pattern

The single most damaging probe mistake is checking a **dependency** in a
**liveness** probe. If liveness pings the database and the database blips, the
kubelet kills and restarts every replica simultaneously — turning a brief
dependency outage into a full, self-inflicted outage, and adding restart load
just when the dependency is struggling. Dependency health belongs in
**readiness**: a pod that cannot reach its database should stop taking traffic
(readiness), not kill itself (liveness). The Tasklane API is built around this:
`/healthz` (liveness) never touches the database; `/readyz` (readiness) pings it.

### Timeouts under load

A probe that passes when idle can fail under load if the process is too busy to
answer within `timeoutSeconds`. A 1-second HTTP timeout against a saturated
event loop or a GC pause produces intermittent probe failures — readiness
flapping, or worse, liveness restarts that make the load problem worse. Size
`timeoutSeconds` and `periodSeconds` for the worst case, and keep probe handlers
cheap and off the hot path.

## Diagnosis

1. **Read which probe failed and why.**

   ```bash
   kubectl -n <ns> describe pod <pod>
   ```

   The Events say `Readiness probe failed` or `Liveness probe failed` with the
   HTTP status or connection error.

2. **Restart with no crash in logs ⇒ suspect liveness.**

   ```bash
   kubectl -n <ns> get pod <pod> -o jsonpath='{.status.containerStatuses[0].restartCount}{"\n"}'
   kubectl -n <ns> logs <pod> --previous
   ```

   Restarts climbing but the app logs a clean run each time points at liveness.

3. **0/1 Ready but no restarts ⇒ readiness.** Confirm the probe target actually
   serves what the probe asks. Test from inside with an ephemeral container:

   ```bash
   kubectl -n <ns> debug -it <pod> --image=busybox:1.37 --target=<container> -- \
     wget -qO- http://127.0.0.1:8080/readyz
   ```

4. **Check the numbers.** Compare `timeoutSeconds`/`periodSeconds` against
   observed latency; a probe timing out under load is a tuning problem.

## Fixes

- **Wrong path/port/scheme.** Point the probe at what the app serves (the
  reproducer: `/not-ready` → `/readyz`). Match `httpGet.port` to a real
  container port and `scheme` to HTTP/HTTPS correctly.
- **Slow start restarting the pod.** Add a `startupProbe` and remove the oversized
  `initialDelaySeconds`.
- **Dependency in liveness.** Move the dependency check to readiness; make
  liveness a cheap, dependency-free "process is running" check.
- **Timeouts under load.** Raise `timeoutSeconds`, lower probe frequency, or make
  the probe handler lighter. Ensure the probe endpoint is not behind the same
  saturated code path as real traffic.

## Prevention

- Design three distinct endpoints: startup, liveness (no dependencies),
  readiness (dependencies). Never share one handler across all three.
- Keep liveness conservative — it should only fail for an unrecoverable, wedged
  process, because its remedy is a restart.
- Load-test with probes enabled so timeouts are tuned for the worst case, not the
  idle case.
- Review every liveness probe for hidden dependency calls; a database, cache or
  downstream API in liveness is a latent outage.

## Common mistakes

- Putting a database or downstream check in **liveness**, so a dependency blip
  restarts the whole Deployment.
- Using a big `initialDelaySeconds` instead of a `startupProbe` for slow boots.
- Setting `timeoutSeconds` for the idle case and getting flapping under load.
- Pointing a probe at the wrong path/port and seeing a permanent 0/1 Ready.
- Assuming a restart loop is a code crash when the logs are clean — it is
  liveness.

## Related topics

- [A method for debugging Kubernetes](method.md)
- [CrashLoopBackOff](crashloopbackoff.md)
- [Service has no endpoints](service-no-endpoints.md)
- [Probes](../k8s-intermediate/probes.md)
- [Pod lifecycle and termination](../k8s-intermediate/pod-lifecycle-and-termination.md)
