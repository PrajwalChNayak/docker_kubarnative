---
title: Progressive delivery
description: Canary and blue/green releases driven by real metrics - Argo Rollouts, Flagger and Gateway API weighted traffic splitting for the Tasklane API.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37, Argo Rollouts 1.10
prerequisites:
  - k8s-intermediate/gateway-api
  - k8s-beginner/rolling-updates-and-rollbacks
---

## Overview

Progressive delivery is a rolling update that stops when the data says stop.
A canary sends a small fraction of real traffic to the new version, measures
something that matters — error rate, latency, a business metric — and either
proceeds to the next fraction or rolls back automatically.

Kubernetes has no native concept of this. A `Deployment` knows how to replace
pods one batch at a time; it has no idea what a successful request looks
like. Progressive delivery is therefore always a controller you add: **Argo
Rollouts** (v1.10.0) or **Flagger** (v1.45.0), plus something that can split
traffic by weight, which in this handbook is the
[Gateway API](../k8s-intermediate/gateway-api.md).

This page canaries `tasklane-api` from 0.1.0 to 0.2.0, measuring 5xx rate
from the API's own `tasklane_http_requests_total` counter.

## Why it exists and when to use it

A rolling update already protects you from a version that will not start: the
readiness probe fails, `maxUnavailable: 0` holds the old pods, and the
rollout stalls with the old version still serving. That covers a large share
of bad releases, for free.

What it does not cover is a version that starts perfectly and is wrong. It
passes `/readyz`, it serves 500s on one endpoint, or it doubles p99 latency,
or it silently writes bad rows. A rolling update will happily replace every
pod with it, because every pod is ready.

Progressive delivery closes that gap by making the health signal something
external and quantitative: a Prometheus query over the traffic the new
version is actually serving. That is the whole value proposition, and it
implies the prerequisite that people skip — **you must already have a metric
that goes bad when the release is bad.** Without one, a canary is a slow
rolling update with extra CRDs and a new controller to operate.

Use it when the blast radius justifies it: a user-facing API, a payment path,
anything where ten minutes of 5% errors is materially better than ten minutes
of 100% errors. Skip it for internal tools, batch jobs, and anything whose
failure is obvious and cheap to revert.

## How it works underneath

Three pieces cooperate.

**The workload controller** keeps two versions alive at once. Argo Rollouts
replaces the `Deployment` with a `Rollout` object that owns ReplicaSets
directly; Flagger keeps your `Deployment`, copies it to
`<name>-primary`, and scales the original down to zero, promoting into the
primary when the analysis passes.

**The traffic router** decides what fraction of requests reach each version.
With Gateway API this is one `HTTPRoute` rule with two `backendRefs` and a
`weight` on each. The controller patches those weights; Envoy Gateway (or
whichever implementation) reprograms its data plane. Weights are relative,
not percentages: `weight: 95` and `weight: 5` means 95/100 of requests.

**The analysis engine** runs queries on a schedule and returns pass or fail.
Argo Rollouts uses `AnalysisTemplate`/`AnalysisRun` objects with providers
for Prometheus, Datadog, a Job, a web request and others; Flagger uses
`MetricTemplate` objects plus built-in metrics and webhooks.

A canary step therefore looks like: patch the HTTPRoute weights → wait →
query Prometheus n times → if every query passes, go to the next step; if
`failureLimit` is exceeded, patch the weights back to 100/0 and scale the
canary ReplicaSet to zero.

Two Services are needed because each must resolve to exactly one version.
Argo Rollouts achieves that by injecting a `rollouts-pod-template-hash` label
into each Service's selector at runtime, so the canary Service selects only
canary pods. Those selectors are runtime state: do not try to keep them in
Git.

## Basic example

The Rollout, with steps at 5%, 20% and 50% and analysis between them:

```yaml include="examples/progressive-delivery/rollout.yaml"
```

The canary Service and the weighted route it manipulates:

```yaml include="examples/progressive-delivery/services-and-route.yaml"
```

The analysis:

```yaml include="examples/progressive-delivery/analysistemplate.yaml"
```

The Gateway API traffic router is a plugin, not built in. It must be
registered before the Rollout will work:

```yaml include="examples/progressive-delivery/argo-rollouts-config.yaml"
```

## Explanation

**Steps are a program.** `setWeight` changes traffic, `pause` waits (with a
`duration` or, when empty, forever until a human runs
`kubectl argo rollouts promote`), and `analysis` blocks until an `AnalysisRun`
finishes. The first step being 5% for two minutes is deliberate: it is the
cheapest possible test of "does this image start and serve anything at all",
and it fails fast without burning a full analysis cycle.

**Analysis arguments.** `podTemplateHashValue: Latest` passes the canary
ReplicaSet's pod-template hash into the template, which is how the query
isolates canary traffic. `Stable` passes the other one, which is useful for
comparative queries ("canary error rate must not exceed stable's by more than
x").

**The query is the hard part.** `tasklane_http_requests_total` is exported by
the Tasklane API with exactly two labels, `method` and `code`
(see [`main.go`](../../examples/app/cmd/api/main.go)). Everything else in the
query — `namespace`, `rollouts_pod_template_hash` — comes from the scrape
configuration. If Prometheus is not relabelling the pod label
`rollouts-pod-template-hash` into the series, the query silently measures
both versions together, the canary always looks exactly as healthy as the
stable version, and the analysis is worse than no analysis.

**`failureCondition: len(result) == 0`** matters more than it looks. A canary
receiving no traffic returns an empty vector. Treated as a pass, an unrouted
canary sails through every gate; treated as a failure, you find the routing
bug instead.

**`failureLimit: 2` with `count: 5`** means: take five measurements a minute
apart, tolerate two bad ones, fail on the third. One bad sample is noise —
a scrape gap, a pod restarting — and treating it as a rollback makes the
system flap.

:::warning Two controllers, one workload
A `Deployment` and a `Rollout` with the same pod selector both create
ReplicaSets and will fight. Delete the Deployment before applying the
Rollout, or use `spec.workloadRef` to have the Rollout reference an existing
Deployment. The same applies to Flagger, which needs you *not* to keep
applying the original Deployment's replica count from Git.
:::

## Common patterns

### Choosing the mechanism

| | Plain Deployment | Argo Rollouts 1.10 | Flagger 1.45 |
|---|---|---|---|
| Object you write | `Deployment` | `Rollout` (or `Rollout` + `workloadRef`) | Your `Deployment` + a `Canary` |
| Traffic control | Replica ratio only | Weighted routing, header/mirror routing | Weighted routing, A/B by header |
| Automatic rollback | Only if pods fail readiness | On failed analysis | On failed analysis |
| Manual gate | No | `pause: {}` + `promote` | No; `skipAnalysis`/`suspend` only |
| Blue/green | No | `blueGreen` strategy with preview Service | `iterations` without traffic shifting |
| Extra components | None | Controller + CRDs + traffic plugin | Controller + CRDs |
| Good for | Most workloads | Explicit, scripted releases, manual gates | Hands-off, fixed-schedule canaries |

The Flagger form of the same release:

```yaml include="examples/progressive-delivery/flagger-canary.yaml"
```

Flagger's `stepWeight: 10`, `maxWeight: 50` and `interval: 1m` replace the
step list: it advances 10% per minute up to 50%, then promotes. Fewer knobs,
less to get wrong, no way to insert a human.

### Blue/green

Both versions run at full scale; traffic switches in one step once a preview
check passes. It costs double the capacity for the duration and gives you an
instant, complete rollback. Use it when partial exposure is unacceptable —
a schema cut-over, a change that cannot be half-applied — and canary
otherwise.

### Header and mirror routing

`setHeaderRoute` sends requests carrying a specific header to the canary, so
QA can test the new version in production before any real user sees it.
Mirroring (`setMirrorRoute`) copies traffic to the canary and discards the
response, which exercises the new code path with zero user risk — and
duplicates every side effect, so it is only safe for read paths.

### Database changes

Progressive delivery assumes both versions can run at once against the same
data. That is a constraint on your migrations, not on your rollout
controller: expand the schema in one release, deploy code that uses the new
shape in the next, contract in a third. A canary in front of a destructive
migration gives you a fast rollback of the pods and no rollback of the data.

## Production considerations

**The metric must be yours.** Built-in success-rate metrics in Flagger and
the common Argo Rollouts examples are Istio or Envoy telemetry. If you are
not running a mesh, you need your own counter and your own query. Tasklane
exports one; most real services will need to add one.

**Analysis duration sets the release duration.** Five one-minute samples at
each of two gates is at least twelve minutes per release, before pauses. If
you deploy twenty times a day, that is a queue. Shorter intervals need more
traffic to be statistically meaningful; low-traffic services often cannot
canary usefully at all, and should use blue/green or a plain rollout.

**Traffic-provider support is the real constraint.** The Gateway API router
for Argo Rollouts is an out-of-tree plugin (`argoproj-labs/gatewayAPI`,
v0.17.0), downloaded by the controller at start-up from the
`argo-rollouts-config` ConfigMap. That means an extra moving part, an egress
dependency at controller start, and a version to track separately from the
controller. Mirror the binary internally for air-gapped clusters.

**Capacity.** `maxSurge` plus canary replicas means you run above the steady
state for the whole release. With a [HorizontalPodAutoscaler](horizontal-pod-autoscaler.md)
in the picture, point it at the Rollout (Argo Rollouts supports
`scaleTargetRef` to a Rollout) rather than at a ReplicaSet, and expect the
interaction to need testing.

**Observability of the rollout itself.** Alert on rollouts that abort, and on
rollouts stuck at a `pause: {}` for longer than a working day — an abandoned
canary at 50% is a permanent split-brain nobody notices.

**Cost.** A controller, a CRD set, a plugin, a Prometheus that must be
reliable enough to gate releases, and the engineering time to build a metric
that is actually predictive. It is worth it for a handful of critical
services and not for fifty.

## Security considerations

**Threat: the rollout controller can rewrite routing cluster-wide.** The
Gateway API plugin needs `get`, `patch` and `update` on `httproutes`. Granted
as a `ClusterRole`, that is the ability to redirect any HTTP traffic in the
cluster to any backend.

*Exploit:* anyone who can create a `Rollout` naming another team's
`HTTPRoute` in `trafficRouting.plugins` causes the controller — which does
have the permission — to rewrite that route's weights.

*Fix:* scope the controller with `Role`/`RoleBinding` per namespace where you
can, and restrict who may create `Rollout` objects. Gateway API's own
`ReferenceGrant` limits cross-namespace backend references, but it does not
constrain which route a Rollout names.

*Verify:* create a `Rollout` in a test namespace pointing at an `HTTPRoute`
in another, and confirm the controller cannot patch it.

**Threat: the analysis provider is a credentialled outbound call.** An
`AnalysisTemplate` can carry a `secretKeyRef` and call an arbitrary address —
including a `web` provider pointed anywhere.

*Fix:* restrict who can create `AnalysisTemplate` and `ClusterAnalysisTemplate`
objects; prefer namespaced templates; apply egress
[NetworkPolicy](../k8s-intermediate/network-policy.md) to the controller.

*Verify:* `kubectl auth can-i create clusteranalysistemplates --as=<tenant>`
and expect `no`.

**Threat: a canary bypasses the guarantees of the stable version.** The
canary pod template is a separate template. If it drops
`readOnlyRootFilesystem` or runs as root, the namespace's Pod Security
Admission profile is the only thing stopping it.

*Fix:* the Rollout's pod template is subject to the same PSA enforcement as
any pod — keep the namespace `restricted`, as
[`examples/k8s/01-namespace/namespace.yaml`](../../examples/k8s/01-namespace/namespace.yaml)
does, and the canary cannot be more privileged than the stable version.

*Verify:* apply a canary template with `privileged: true` and confirm the
ReplicaSet reports a PSA rejection.

## Troubleshooting

```bash
kubectl argo rollouts get rollout tasklane-api -n tasklane --watch
kubectl -n tasklane describe analysisrun
kubectl -n tasklane get httproute tasklane-api -o yaml
```

**Rollout `Degraded` with a plugin error.** The plugin was never downloaded.
Check the `argo-rollouts-config` ConfigMap and restart the controller —
changes to it are read only at start-up.

**Weights never change on the HTTPRoute.** RBAC. The stock argo-rollouts
ClusterRole does not include `gateway.networking.k8s.io`.

**AnalysisRun fails immediately with an error, not a failure.** `Error`
means the provider could not be reached or the query was invalid;
`Failed` means it ran and the condition was not met. `consecutiveErrorLimit`
controls the first, `failureLimit` the second. Test the query against
Prometheus by hand before trusting it.

**The canary always passes.** Almost always the query is not isolating canary
pods. Run it in Prometheus with the canary's hash substituted and confirm the
series count is what you expect.

**Both Services select all pods.** Argo Rollouts has not reconciled the
selectors yet, or something in Git is overwriting them. Exclude
`/spec/selector` from GitOps drift correction for both Services.

**Stuck at 50% forever.** That is the `pause: {}` step working as designed.
`kubectl argo rollouts promote tasklane-api` continues it;
`promote --full` skips the remaining steps.

## Common mistakes

- Adopting a canary controller before having a metric that fails when the
  release is bad.
- A query that measures all pods, so the canary can never look worse than
  production.
- Treating an empty Prometheus result as a pass.
- `failureLimit: 0`, so one scrape gap rolls back a perfectly good release.
- Leaving the `Deployment` in place alongside the `Rollout`.
- Committing the Services' runtime `rollouts-pod-template-hash` selector to
  Git, then watching GitOps and the rollout controller fight.
- Canarying a service with too little traffic for the analysis window to be
  meaningful.
- Forgetting that a canary does not roll back database migrations.
- Registering the traffic plugin and not restarting the controller.

## Related topics

- [Rolling updates and rollbacks](../k8s-beginner/rolling-updates-and-rollbacks.md)
- [Gateway API](../k8s-intermediate/gateway-api.md)
- [Gateway API TLS and traffic](../k8s-intermediate/gateway-api-tls-and-traffic.md)
- [CI/CD for Kubernetes](cicd-for-kubernetes.md)
- [GitOps with Argo CD](gitops-argo-cd.md)
- [Probes](../k8s-intermediate/probes.md)
- [Horizontal Pod Autoscaler](horizontal-pod-autoscaler.md)
- [Prometheus and kube-prometheus](../operations/prometheus-and-kube-prometheus.md)
- [SLOs and error budgets](../operations/slos-and-error-budgets.md)
