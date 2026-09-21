---
title: Init and sidecar containers
description: Ordered setup containers, and the restartPolicy Always init container that finally made sidecars a first-class concept.
level: intermediate
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/pods
  - k8s-intermediate/probes
---

## Overview

A pod's containers come in two lists:

- **`initContainers`** run in order, each to completion, before the next one
  starts and before any regular container starts.
- **`containers`** run concurrently for the life of the pod.

Since **1.33** (stable; the `SidecarContainers` gate is locked on) an init
container may set `restartPolicy: Always`. That makes it a **sidecar**: it
starts in init order, then *keeps running* alongside the regular containers, and
the kubelet moves on to the next init container as soon as it is started rather
than waiting for it to exit.

So "sidecar" is no longer a naming convention. It is a field.

## Why it exists and when to use it

Init containers exist so setup can fail loudly and separately: fetch a config
bundle, wait for a dependency, run a migration, fix permissions on a volume.
Putting that work in an entrypoint script hides it inside the application
container's logs and image.

Sidecars exist because a helper process — a log shipper, a metrics adaptor, a
proxy — has a lifecycle problem. As a regular container it starts at the same
time as the application (races), and it never exits, so a Job with a sidecar
never completes. As a restartable init container it is started *before* the
application, stopped *after* it, and does not keep a Job alive.

Use an init container for work that must finish. Use a sidecar for a helper that
must be there while the app runs. Use neither when the application can do it
itself.

## How it works underneath

The kubelet processes init containers strictly in list order:

1. For a plain init container, the kubelet runs it and waits for exit 0. A
   non-zero exit restarts it according to the pod's `restartPolicy` (with
   `Never`, the whole pod fails), and until it succeeds the pod stays in `Init:`
   status.
2. For an init container with `restartPolicy: Always`, the kubelet waits only
   until it has **started** — or until its `startupProbe` succeeds, if one is
   defined — and then proceeds to the next entry.

Sidecars therefore support `startupProbe`, `livenessProbe` and `readinessProbe`,
while plain init containers support none of them.

Resources are accounted differently too. The pod's effective request is
`max(largest plain init container request, sum of regular containers + sidecars)`,
because plain init containers never overlap with the rest while sidecars do.

**Shutdown ordering** is the other half of the deal. When the pod terminates,
the kubelet delays the TERM signal to sidecars until the last regular container
has fully exited, then stops sidecars in the **reverse** of their definition
order. That is precisely the behaviour people used to fake with `preStop` hooks
and shared files — those hacks can now be deleted.

A sidecar's failure does not fail a Job, and a Job whose regular containers all
succeed completes even though the sidecar is still running: the kubelet stops
it.

## Basic example

Tasklane's API runs its schema migration as a plain init container:

```yaml include="examples/k8s/03-app/api.yaml" lines="56-79"
```

```bash
kubectl -n tasklane get pod -l app.kubernetes.io/name=tasklane-api -o jsonpath='{range .items[*]}{.metadata.name}{"\tinit: "}{.spec.initContainers[*].name}{"\tmain: "}{.spec.containers[*].name}{"\n"}{end}'
```

```console include="captures/k8s-intermediate/init-containers.txt"
```

## Explanation

The migration runs `tasklane-api migrate`, which is idempotent
(`CREATE TABLE IF NOT EXISTS`) and retries while the database is still starting.
Idempotence is not optional here: with two replicas, two init containers run the
same migration concurrently, and a rollout runs it again on every new pod.

It reuses the application image, so there is no second artifact to build, scan
and sign, and it carries the same security context as the main container. It is
a plain init container, not a sidecar, because it must *finish* before the API
serves anything.

Adding a sidecar to the same pod looks like this:

```yaml title="api-with-sidecar.yaml" fragment
initContainers:
  - name: migrate
    image: tasklane-api:0.1.0
    args: ["migrate"]
  - name: log-shipper
    image: registry.example.com/log-shipper:3.1.0
    restartPolicy: Always        # <- this is what makes it a sidecar
    startupProbe:
      httpGet:
        path: /ready
        port: 2020
      periodSeconds: 2
      failureThreshold: 15
```

The order matters: `migrate` must complete, then `log-shipper` starts and the
kubelet waits for its startup probe before running the API container, so no
application log line is emitted before there is something to collect it.

## Common patterns

**Migrations as an init container, but only for small schemas.** Every pod runs
it on every start, which is fine for `IF NOT EXISTS` DDL and wrong for a
30-minute data backfill. Use a Job for the latter, and gate the rollout on it.

**Waiting for a dependency.** A tiny init container that polls until a service
answers turns a `CrashLoopBackOff` into a clear `Init:0/1`. Keep a timeout — an
init container that waits forever is a pod that never reports a problem.

**Permission fixing.** An init container that `chown`s a volume is the classic
workaround for images that insist on a UID, though `fsGroup` usually does the
job without a root container.

**Proxy sidecars and Job completion.** Service-mesh proxies as restartable init
containers is exactly why the feature was built: a Job with an Istio sidecar
used to hang forever.

**Config rendering.** An init container writes rendered config to an `emptyDir`
that the app mounts read-only. It keeps templating out of the application image.

## Production considerations

Init containers extend startup time on *every* pod start, including rescheduling
during a node failure — when the cluster is already unhappy. Measure them.

Each init container is a separate image pull unless it reuses one you already
have. Reusing the application image is usually the cheapest option and halves
your supply-chain surface.

Sidecars count towards the pod's requests and limits at all times. A mesh proxy
at 100m × 400 pods is 40 cores.

Rollouts are gated on sidecar startup probes, so a slow sidecar slows every
deployment in the cluster. Give them startup probes with honest budgets.

Note that sidecar termination is bounded by the pod's
`terminationGracePeriodSeconds` as a whole: a slow main container eats the
budget, and if the grace period expires everything left is killed together with
a short grace period.

## Security considerations

Init containers run with the pod's volumes and ServiceAccount token, so an init
container that fetches secrets is a full-privilege step in your startup path.
Give it the same `securityContext` you give the app — the restricted Pod
Security profile is enforced on init containers too.

A "fix the permissions" init container that runs as root re-opens everything the
restricted profile closed; in a `restricted` namespace it is simply rejected.
Prefer `fsGroup`, or an image built with the right ownership.

Sidecars share the pod's network namespace and can see every connection the
application makes, and with `shareProcessNamespace` they can see its memory
through `/proc`. A sidecar is inside your trust boundary: pin it by digest,
review its RBAC, and do not accept one from a vendor without reading what it
mounts.

## Troubleshooting

A pod stuck at `Init:0/1` is waiting for the first init container:

```bash
kubectl -n tasklane describe pod <pod>
kubectl -n tasklane logs <pod> -c migrate
kubectl -n tasklane logs <pod> -c migrate --previous
```

`Init:Error` or `Init:CrashLoopBackOff` means it exited non-zero — the logs of
the *previous* attempt are usually the interesting ones.

`PodInitializing` for a long time with a sidecar in the list means the sidecar's
startup probe is failing; check it as you would any probe.

To see the boundary between phases, read the pod's status:

```bash
kubectl -n tasklane get pod <pod> -o jsonpath='{.status.initContainerStatuses[*].state}'
```

## Common mistakes

- **Non-idempotent migrations in an init container.** Two replicas, two
  concurrent runs, one corrupted schema.
- **A sidecar declared in `containers`,** so a Job never completes and the
  application starts before the proxy is ready.
- **Probes on a plain init container.** They are not supported; only
  restartable init containers may have them.
- **No timeout on a "wait for dependency" init container**, hiding an outage as
  a pending pod.
- **Forgetting sidecar resources**, then wondering why nodes are full.
- **Root init containers** in a restricted namespace — rejected at admission.
- **Assuming sidecars stop first.** They stop last, in reverse order, on
  purpose.

## Related topics

- [Probes](probes.md)
- [Pod lifecycle and termination](pod-lifecycle-and-termination.md)
- [Jobs and CronJobs](jobs-and-cronjobs.md)
- [Pods](../k8s-beginner/pods.md)
- [Security context](../k8s-security/security-context.md)
- [CrashLoopBackOff](../troubleshooting/crashloopbackoff.md)
