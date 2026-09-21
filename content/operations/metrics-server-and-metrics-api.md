---
title: metrics-server and the Metrics API
description: How the resource metrics pipeline turns kubelet cAdvisor data into the numbers kubectl top and the HPA read.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/architecture
  - k8s-advanced/horizontal-pod-autoscaler
---

## Overview

The **Metrics API** is a small, standardised API that reports the current CPU
and memory usage of pods and nodes. It is what `kubectl top` prints and what the
HorizontalPodAutoscaler reads to decide whether to scale. It is *not* a
monitoring system: it holds only the latest reading, keeps no history, and
covers only CPU and memory. **metrics-server** is the component that populates
it in most clusters.

This page traces the resource metrics pipeline end to end: container runtime →
kubelet → metrics-server → aggregated API → consumer. Understanding the path
explains most "metrics not available" failures.

## Why it exists and when to use it

Before the Metrics API, autoscaling and `kubectl top` had no stable contract for
"how much is this pod using right now". The Metrics API gives one: a versioned,
RBAC-controlled, in-cluster API that any controller can query without knowing
which monitoring stack is installed.

Use metrics-server when you want `kubectl top`, a CPU/memory HPA, or the
Vertical Pod Autoscaler's recommender to work. Do **not** use it as a data
source for dashboards, alerting, or capacity trends — it has no history and no
custom metrics. That is Prometheus's job. The two coexist: metrics-server drives
autoscaling, Prometheus drives observability.

:::note metrics-server needs 1.34+
metrics-server **v0.9.0** supports Kubernetes **1.34 and newer** and serves
`metrics.k8s.io/v1beta1`. Match the metrics-server version to your cluster
minor; an older metrics-server against a newer kubelet Summary API can break.
:::

## How it works underneath

The pipeline has four hops:

1. **Container runtime + cAdvisor.** The kubelet embeds cAdvisor, which reads
   cgroup accounting (cgroup v2 in current clusters) for every container on the
   node — CPU time consumed and memory working set.
2. **kubelet Summary API.** The kubelet aggregates cAdvisor data and exposes it
   at `/stats/summary` on its authenticated port. This is the raw source of
   resource usage for a node and its pods.
3. **metrics-server.** It discovers nodes from the API server, scrapes each
   kubelet's Summary API on a short interval (about every 15s), and holds the
   latest value per pod and node in memory. It stores nothing to disk.
4. **Aggregated API.** metrics-server registers an `APIService`,
   `v1beta1.metrics.k8s.io`, with the kube-apiserver. The apiserver then
   *proxies* requests for that group to the metrics-server pod. To a client it
   looks like a native API under `/apis/metrics.k8s.io/...`.

So `kubectl top pods` is a normal authenticated API call: apiserver → aggregation
layer → metrics-server → its in-memory cache. No component reads cgroups
directly on your behalf.

In **1.37 the Metrics API graduated to Stable as `metrics.k8s.io/v1`** (GA in
1.37). `v1` is byte-for-byte identical to `v1beta1` apart from the version
string, and **v1beta1 is still served**. `kubectl top` prefers `v1`. Note the
**HPA controller still uses `v1beta1` in 1.37**, so do not remove the v1beta1
APIService yet.

## Basic example

metrics-server ships as a Deployment. In the kind lab the kubelets serve
self-signed certificates, so the lab (and only the lab) passes
`--kubelet-insecure-tls`:

```yaml include="examples/lab/metrics-server/kustomization.yaml"
```

Once it is running, read usage:

```bash
kubectl top nodes
kubectl -n tasklane top pods
```

```console include="captures/operations/ops-top-nodes.txt"
```

```console include="captures/operations/ops-top-pods.txt"
```

You can also hit the aggregated API directly, which is exactly what the HPA
does under the hood:

```bash
kubectl get --raw /apis/metrics.k8s.io/v1beta1/namespaces/tasklane/pods
```

```console include="captures/operations/ops-metrics-raw.txt"
```

## Explanation

`kubectl top pods` shows CPU in millicores and memory as the working set. The
value is a point-in-time reading from metrics-server's cache, not an average —
run it twice and it changes. Because there is no history, a pod that just
started may show no metrics for the first scrape interval, and a pod that was
deleted disappears immediately.

The CPU number is a rate (cores used per second), derived from the difference
between two cumulative cgroup CPU counters. That is why a brand-new
metrics-server needs two scrapes before CPU is meaningful. Memory is the working
set — resident memory minus reclaimable cache — which is also what the kubelet
uses for OOM decisions, so it lines up with `OOMKilled` behaviour.

## Common patterns

- **CPU/memory HPA.** The HPA controller queries the Metrics API for pod usage,
  divides by the pods' requests, and compares to the target utilisation. No
  requests set means no CPU/memory HPA — the percentage is undefined. See the
  [HorizontalPodAutoscaler](../k8s-advanced/horizontal-pod-autoscaler.md).
- **VPA recommender.** Reads the same pipeline (and Prometheus history if
  configured) to recommend requests.
- **Custom and external metrics.** For scaling on queue depth or request rate,
  the HPA reads `custom.metrics.k8s.io` / `external.metrics.k8s.io`, served by a
  Prometheus Adapter or KEDA — a *different* aggregated API from
  `metrics.k8s.io`. metrics-server does not provide these.

## Production considerations

- **High availability.** Run at least two replicas with anti-affinity;
  autoscaling stalls if metrics-server is down. It uses leader election only for
  some housekeeping — both replicas serve.
- **Scaling.** Memory and CPU grow with the number of nodes and pods. On large
  clusters raise its resources and consider `--metric-resolution` tuning.
- **kubelet TLS.** In production do **not** use `--kubelet-insecure-tls`. Give
  the kubelets certificates signed by the cluster CA (`serverTLSBootstrap` +
  approving the serving CSRs) so metrics-server can verify them.
- **One provider per API.** Only one thing may back `metrics.k8s.io`. Installing
  metrics-server *and* another provider (for example Prometheus Adapter
  configured for resource metrics) causes the APIService to flap.

## Security considerations

- The Metrics API is RBAC-controlled. `kubectl top` needs `get`/`list` on
  `pods`/`nodes` in the `metrics.k8s.io` group. Usage data is mildly sensitive
  (it can hint at load and tenancy), so do not grant it cluster-wide by default.
- metrics-server talks to every kubelet's authenticated Summary API using its
  ServiceAccount; that token is a real credential — protect the pod like any
  control-plane-adjacent component.
- Verifying kubelet certificates (above) prevents a man-in-the-middle on the
  node from feeding metrics-server forged usage numbers that could drive the
  autoscaler.

## Troubleshooting

- **`metrics not available yet`** right after install: wait one or two scrape
  intervals; CPU needs two samples.
- **`kubectl top` errors with a TLS or x509 message:** metrics-server cannot
  verify kubelet certs. In the lab add `--kubelet-insecure-tls`; in production
  fix kubelet serving certificates.
- **Empty `metrics.k8s.io` / APIService not available:** check the APIService
  is `Available`:

  ```bash
  kubectl get apiservice v1beta1.metrics.k8s.io
  ```

  ```console include="captures/operations/ops-metrics-apiservice.txt"
  ```

  A `False` status usually means metrics-server crashed or the apiserver cannot
  reach its pod (network policy, wrong port).
- **HPA shows `<unknown>` for CPU:** the target pods have no CPU *requests*, or
  metrics-server is down.

## Common mistakes

- Treating `kubectl top` as monitoring. It has no history; use Prometheus for
  trends and alerts.
- Forgetting resource **requests**, then wondering why the CPU HPA never scales.
- Running an old metrics-server against a newer cluster; v0.9.0 needs 1.34+.
- Assuming `metrics.k8s.io/v1` replaced v1beta1 — both are served in 1.37, and
  the HPA still calls v1beta1.
- Using `--kubelet-insecure-tls` in production, which disables a real MITM
  defence.

## Related topics

- [Prometheus and kube-prometheus](prometheus-and-kube-prometheus.md)
- [Capacity planning](capacity-planning.md)
- [HorizontalPodAutoscaler](../k8s-advanced/horizontal-pod-autoscaler.md)
- [Vertical Pod Autoscaler](../k8s-advanced/vertical-pod-autoscaler.md)
- [Probes](../k8s-intermediate/probes.md)
