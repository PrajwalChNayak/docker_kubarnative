# Progressive delivery for the Tasklane API

Two ways to roll out `tasklane-api:0.1.0` → `tasklane-api:0.2.0` a few per
cent of traffic at a time, aborting automatically when the API's own
`tasklane_http_requests_total` counter says the new version is serving 5xx.

Neither Argo Rollouts (v1.10.0) nor Flagger (v1.45.0) is installed on the
kind lab, so nothing here is applied by the lab. All of it is validated
against the upstream CRD schemas with kubeconform.

| File | Contents |
|---|---|
| `rollout.yaml` | `Rollout` replacing the stage-3 Deployment, canary steps 5 → 20 → 50 → manual, Gateway API traffic routing |
| `services-and-route.yaml` | The canary `Service` and the weighted `HTTPRoute` the plugin rewrites |
| `analysistemplate.yaml` | `AnalysisTemplate` with two Prometheus metrics: success ratio and absolute 5xx rate |
| `argo-rollouts-config.yaml` | `argo-rollouts-config` ConfigMap registering the Gateway API plugin, plus the RBAC it needs |
| `flagger-canary.yaml` | The Flagger alternative: `Canary` + `MetricTemplate`, wrapping the Deployment instead of replacing it |

## Order of installation (Argo Rollouts)

1. Install the Argo Rollouts CRDs and controller in namespace `argo-rollouts`.
2. Apply `argo-rollouts-config.yaml`, then restart the controller:
   `kubectl rollout restart deployment -n argo-rollouts argo-rollouts`.
   Without the restart the plugin is never downloaded and the Rollout stays
   `Degraded` with a "plugin not found" error.
3. Apply `services-and-route.yaml` and `analysistemplate.yaml`.
4. Delete `Deployment/tasklane-api`, then apply `rollout.yaml`.

Step 4 is not optional. A Deployment and a Rollout with the same pod
selector both create ReplicaSets and will thrash.

## What the Prometheus queries assume

`tasklane_http_requests_total` is exported by the API itself with exactly two
labels, `method` and `code`. Everything else in the queries —
`namespace`, `pod`, `rollouts_pod_template_hash` — is added by the scrape
configuration, not by the application.

For the Argo Rollouts analysis to distinguish canary pods from stable ones,
Prometheus must carry the pod label `rollouts-pod-template-hash` into the
series as `rollouts_pod_template_hash`. With kube-prometheus that is a
relabeling in the PodMonitor. If that label is missing the query returns the
combined success rate of both versions, the canary always looks healthy, and
the analysis is worse than useless.

The Flagger `MetricTemplate` avoids the extra label by matching on pod name,
which only works because Flagger names the primary Deployment
`<target>-primary`.

## Argo Rollouts vs Flagger

| | Argo Rollouts 1.10 | Flagger 1.45 |
|---|---|---|
| Workload object | Replaces the Deployment with a `Rollout` (or references one with `workloadRef`) | Keeps your Deployment, creates a `-primary` copy and scales yours to zero |
| Control | Imperative steps you author: `setWeight`, `pause`, `analysis` | Declarative: `stepWeight`, `maxWeight`, `interval`, Flagger walks it |
| Manual gates | `pause: {}` holds forever until `kubectl argo rollouts promote` | None; `skipAnalysis` or `suspend` are the only levers |
| UI / CLI | Dashboard plus a `kubectl argo rollouts` plugin | `kubectl describe canary`, events, alerts |
| Traffic providers | Built-in (Istio, SMI, several ingress controllers) plus plugins; Gateway API is a plugin | Built-in providers including `gatewayapi:v1` |
| Blue/green | First-class `blueGreen` strategy | `analysis.iterations` with no traffic shifting |

Pick Argo Rollouts if you want explicit, scriptable steps and a manual gate
before the last hop, and especially if you already run Argo CD. Pick Flagger
if you want to leave your Deployments alone and let a controller walk a fixed
schedule.

Pick **neither** if you do not have a metric that actually fails when the
release is bad. A canary with no working analysis is a slow rolling update
with extra CRDs — a plain Deployment with `maxUnavailable: 0`, a real
readiness probe and `kubectl rollout undo` is better.
