# Tasklane observability stack (kube-prometheus-stack)

A lab-scale metrics, alerting and dashboard setup for Tasklane, built on the
`prometheus-community/kube-prometheus-stack` Helm chart. It installs the
Prometheus Operator, a Prometheus, Alertmanager, node-exporter,
kube-state-metrics and Grafana in one release.

Versions this was written against: Prometheus v3.14.0, Grafana v13.2.2,
kube-prometheus (jsonnet) v0.18.0. The chart is versioned independently of its
components (it was in the v91.x range at the time of writing) — always pin the
exact chart version you install with `helm search repo`, do not float it.

## Version-skew warning: read this first

kube-prometheus v0.18.0's compatibility matrix lists Kubernetes **1.33–1.36
only**. The lab runs **1.37**, which is newer than any tested column. The stack
installs and scrapes fine for teaching, but kube-state-metrics or the operator
may log a version-skew warning, and a few newer/renamed kubelet or
apiserver-internal series can be missing or shifted. Do not treat this pairing
as production-blessed; in production match the chart to a supported minor.

## Install

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
# Pick the version helm shows you and pin it with --version.
helm search repo prometheus-community/kube-prometheus-stack

helm install kube-prometheus-stack \
  prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace \
  --version <PINNED_VERSION> \
  --values examples/observability/values.yaml
```

`values.yaml` sets `serviceMonitorSelectorNilUsesHelmValues: false` and the
sibling selectors, so Prometheus adopts the Tasklane ServiceMonitors and rules
even though they live in the `tasklane` namespace. The objects also carry
`release: kube-prometheus-stack` so a stricter label selector would still pick
them up.

## Wire up Tasklane

```bash
kubectl apply -f examples/observability/servicemonitor-tasklane.yaml
kubectl apply -f examples/observability/prometheusrule-tasklane.yaml
```

- `servicemonitor-tasklane.yaml` — ServiceMonitors for `tasklane-api` (port
  `http`, `/metrics`) and `tasklane-worker` (port `metrics` on the
  `tasklane-worker-metrics` Service).
- `podmonitor-worker.yaml` — an alternative that scrapes worker pods directly.
  Apply the PodMonitor **or** the worker ServiceMonitor, never both, or every
  replica is scraped twice.
- `prometheusrule-tasklane.yaml` — recording rules plus the
  `TasklaneTasksBacklogHigh` and `TasklaneWorkerErrors` alerts.

## Grafana dashboard

`dashboards/tasklane.json` has four panels: API request rate, pending backlog,
per-worker processed rate, and worker error rate. Provision it as code by
loading it into a ConfigMap labelled `grafana_dashboard` (the sidecar in
`values.yaml` watches for that label):

```bash
kubectl create configmap tasklane-dashboard \
  --namespace monitoring \
  --from-file=tasklane.json=examples/observability/dashboards/tasklane.json \
  --dry-run=client -o yaml \
  | kubectl label --local -f - grafana_dashboard=1 -o yaml \
  | kubectl apply -f -
```

## Verify

```bash
kubectl -n monitoring get servicemonitors,prometheusrules -A
# Port-forward Prometheus and check Status > Targets for tasklane endpoints:
kubectl -n monitoring port-forward svc/kube-prometheus-stack-prometheus 9090:9090
```

## Validate the manifests locally

```bash
.tools/kubeconform.exe -strict -summary -kubernetes-version 1.37.0 \
  -schema-location default \
  -schema-location "https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json" \
  examples/observability/*.yaml
```
