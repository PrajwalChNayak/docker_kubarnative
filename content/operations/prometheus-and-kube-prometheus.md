---
title: Prometheus and kube-prometheus
description: The pull model, the Prometheus Operator CRDs, and how ServiceMonitors turn Tasklane's /metrics into stored time series.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37, Prometheus 3.14
prerequisites:
  - operations/metrics-server-and-metrics-api
  - k8s-intermediate/dns-and-coredns
---

## Overview

Prometheus is the de-facto metrics engine for Kubernetes: a time-series database
that **pulls** metrics from HTTP `/metrics` endpoints, stores them locally, and
answers PromQL queries. **kube-prometheus** (and the `kube-prometheus-stack`
Helm chart built on it) packages Prometheus, the Prometheus Operator,
Alertmanager, Grafana, node-exporter and kube-state-metrics into one install.

This page covers the pull model, service discovery, the Operator's Custom
Resources (ServiceMonitor, PodMonitor, PrometheusRule, Probe), recording rules,
remote-write, and cardinality — using Tasklane's own metrics as the example.

## Why it exists and when to use it

Kubernetes is dynamic: pods come and go, IPs churn. A monitoring system that
needed a static list of targets would be useless. Prometheus solves this with
**service discovery** — it asks the Kubernetes API which pods exist and scrapes
them automatically — and a dimensional data model where every series is
`name{label="value",...}`, so you can slice by pod, namespace or status code
with PromQL.

Reach for Prometheus whenever you need history, alerting, or custom application
metrics. Use the Operator (via kube-prometheus-stack) rather than a hand-rolled
`prometheus.yml` so that *what to scrape* lives in Kubernetes objects next to
your workloads, versioned and RBAC-controlled.

:::warning Version skew in the lab
kube-prometheus **v0.18.0**'s compatibility matrix lists Kubernetes
**1.33–1.36 only**. The lab runs **1.37**, one minor newer than any tested
column, so the stack may log a version-skew warning and a few
kubelet/apiserver-internal series can shift or go missing. It is fine for
teaching; do not treat this pairing as production-supported.
:::

## How it works underneath

**The pull model.** Prometheus periodically GETs each target's `/metrics` and
parses the text exposition format (Tasklane's exporter serves
`text/plain; version=0.0.4`). Each scrape is a snapshot of counters and gauges;
Prometheus timestamps and stores them. Because the server pulls, it always knows
whether a target is up (the synthetic `up` series), and targets need no
knowledge of where Prometheus is.

**Service discovery.** In Kubernetes, Prometheus uses the `kubernetes_sd`
discovery to list nodes, pods, endpoints and services from the API. Raw
discovery plus relabeling is verbose, so the Operator abstracts it.

**The Operator.** The Prometheus Operator watches its CRDs and *generates*
Prometheus's scrape config and rule files, then triggers a reload. You never
edit `prometheus.yml`. The key CRDs:

| CRD | Purpose |
|---|---|
| `Prometheus` | A Prometheus instance: replicas, retention, resources, which selectors it honours. |
| `ServiceMonitor` | "Scrape the pods behind Services matching these labels, on this port/path." |
| `PodMonitor` | Scrape pods directly, no Service required. |
| `PrometheusRule` | Recording and alerting rules. |
| `Probe` | Blackbox-style probes of static or discovered targets. |
| `Alertmanager` | An Alertmanager instance. |

A crucial detail: the stack installs its `Prometheus` with
`serviceMonitorSelectorNilUsesHelmValues: true`, so by default it only adopts
ServiceMonitors carrying its release label. The lab values relax that; see
below.

## Basic example

Tasklane's API exposes `tasklane_http_requests_total`,
`tasklane_tasks_created_total` and `tasklane_tasks_pending` on its http port;
the worker exposes `tasklane_tasks_processed_total` and
`tasklane_worker_errors_total` on `:9090`. Two ServiceMonitors wire them up:

```yaml include="examples/observability/servicemonitor-tasklane.yaml"
```

Install the stack and apply the monitors (full commands in the example README):

```bash
helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace \
  --version <PINNED_VERSION> \
  --values examples/observability/values.yaml
kubectl apply -f examples/observability/servicemonitor-tasklane.yaml
```

Confirm Tasklane is being scraped by reading its raw metrics through a
port-forward — the same bytes Prometheus parses:

```console include="captures/operations/ops-api-metrics.txt"
```

## Explanation

Each ServiceMonitor's `selector.matchLabels` picks a Service; its `endpoints`
name the port and path. The Operator expands that into a scrape job whose
targets are the Service's EndpointSlices — i.e. every ready pod. The
`relabelings` block copies the pod name into a `pod` label so per-replica series
stay distinguishable.

`tasklane_tasks_pending` is a **gauge** each API replica computes from the same
database, so both replicas report the same number. When you query it, aggregate
with `max(tasklane_tasks_pending)` to collapse the duplicate series — summing
would double-count. The `_total` metrics are **counters**; you almost always
wrap them in `rate(...[5m])` to get a per-second rate, because the raw counter
only ever climbs and resets to zero on restart.

The lab values relax the selectors so Prometheus adopts monitors from any
namespace:

```yaml include="examples/observability/values.yaml" lines="18-22"
```

## Common patterns

- **Recording rules** pre-compute expensive or frequently used queries into new
  series, named `level:metric:operation`. Tasklane's rules file records the
  fleet request, processing and error rates so dashboards and alerts read one
  cheap series:

  ```yaml include="examples/observability/prometheusrule-tasklane.yaml" lines="20-28"
  ```

- **Native histograms (Beta, on by default in 1.37).** Classic histograms use
  one series per bucket; native histograms store exponential buckets in a single
  series, cutting cardinality and giving better resolution. Components expose
  both side by side ("dual exposition") when scraped with the protobuf format.
  Enable ingestion with Prometheus's `native-histograms` feature (set in the lab
  values).
- **remote-write.** Prometheus can stream samples to a long-term/central store
  (Thanos, Mimir, Cortex, a vendor) via `remote_write`, keeping local retention
  short. This is how you get global query and multi-year retention without a
  giant local TSDB.

## Production considerations

- **Storage.** The local TSDB needs a PersistentVolume; size it for
  `ingested samples/s × bytes/sample × retention`. Short local retention plus
  remote-write is the common production shape.
- **HA.** Run two Prometheus replicas (the Operator's `replicas: 2`) scraping
  the same targets; deduplicate at query time with Thanos/Mimir or Alertmanager
  dedup.
- **Cardinality is the number-one operational risk.** Every unique label
  combination is a separate series held in memory. A label like `user_id` or a
  full URL path can create millions of series and OOM Prometheus. Keep labels
  bounded; push high-cardinality detail to logs or traces.
- **Scrape interval vs resolution.** 15–30s is typical. Shorter intervals
  multiply storage and load.

## Security considerations

- Prometheus's ServiceAccount can list pods and endpoints cluster-wide;
  treat it as sensitive. Scope `Prometheus` selectors so a tenant cannot make it
  scrape arbitrary internal endpoints.
- `/metrics` endpoints can leak information (internal hostnames, counts). Do not
  expose them publicly; scrape over the cluster network only.
- Alertmanager and Grafana front ends need authentication — never expose them
  unauthenticated. Grafana is AGPLv3 (see the dashboards page).
- Restrict who can create ServiceMonitors in shared clusters; a malicious one
  can point Prometheus at an internal service to exfiltrate data into metrics.

## Troubleshooting

- **Target missing from Prometheus > Targets:** the ServiceMonitor's labels do
  not match the Service, the port name is wrong, or the `Prometheus` selector
  does not adopt it (release label / namespace). The Operator's own logs say
  which monitors it selected.
- **`up == 0` for a target:** Prometheus reached the endpoint but the scrape
  failed — wrong path, TLS mismatch, or the app not serving `/metrics`.
- **Prometheus OOMs or restarts:** almost always cardinality. Query
  `topk(10, count by (__name__)({__name__=~".+"}))` to find the worst metrics.
- **Rule not firing:** check the rule shows under Status > Rules and that the
  PrometheusRule was adopted (same selector rules as ServiceMonitors).

## Common mistakes

- Summing a per-replica gauge like `tasklane_tasks_pending` instead of taking
  `max`, double-counting the backlog.
- Forgetting the `release` label (or the relaxed selector), so the Operator
  ignores your ServiceMonitor.
- Putting unbounded labels (user id, path, trace id) on metrics and melting
  Prometheus.
- Using Prometheus as a long-term store without remote-write, then losing data
  when the PVC fills.
- Applying both a ServiceMonitor and a PodMonitor for the worker, scraping every
  replica twice.

## Related topics

- [Grafana dashboards](grafana-dashboards.md)
- [Actionable alerting](actionable-alerting.md)
- [SLOs and error budgets](slos-and-error-budgets.md)
- [metrics-server and the Metrics API](metrics-server-and-metrics-api.md)
- [HorizontalPodAutoscaler](../k8s-advanced/horizontal-pod-autoscaler.md)
