---
title: Observability and operations labs
description: Hands-on exercises — scrape Tasklane, alert on backlog, ship logs, trace requests, and run backup, upgrade and node-maintenance drills.
level: expert
type: lab
status: current
versions: Kubernetes 1.37
prerequisites:
  - operations/prometheus-and-kube-prometheus
  - operations/velero-backup-and-restore
  - operations/cluster-upgrades
---

## Overview

These labs exercise the Part J material against the disposable **kind** lab
(`tasklane`, Kubernetes 1.37) with the Tasklane stages 1–4 applied and
metrics-server installed. Prometheus is **not** pre-installed — one lab installs
it. Everything runs on a throwaway cluster; do the destructive drills
(namespace delete, drain, etcd restore) only there.

Each exercise states a goal; the solution shows the commands and manifests. Try
it before reading the solution.

## Setup

Bring up the lab cluster and Tasklane, and confirm the resource metrics pipeline
works:

```bash
kind create cluster --config examples/lab/kind-config.yaml
kubectl apply -f examples/k8s/01-namespace/
kubectl apply -f examples/k8s/02-database/
kubectl apply -f examples/k8s/03-app/
kubectl apply -f examples/k8s/04-gateway/
kubectl apply -k examples/lab/metrics-server/
```

Verify metrics-server:

```bash
kubectl -n tasklane top pods
```

```console include="captures/operations/ops-top-pods.txt"
```

## Exercises

### Exercise 1 — Read Tasklane's metrics by hand

Before any Prometheus, confirm the app exposes the metrics the rest of the labs
rely on. Port-forward the API and read `/metrics`; find
`tasklane_tasks_pending`, `tasklane_http_requests_total` and
`tasklane_tasks_created_total`. Do the same for the worker on `:9090`.

### Exercise 2 — Scrape Tasklane with kube-prometheus-stack

Install the stack, apply the Tasklane ServiceMonitors, and confirm both targets
are `UP` in Prometheus. Note the version-skew warning the stack may print
against Kubernetes 1.37.

### Exercise 3 — Alert on the backlog

Apply the Tasklane PrometheusRule. Then create load so the backlog climbs above
50 for 10 minutes and confirm `TasklaneTasksBacklogHigh` moves to Pending then
Firing. Explain why the rule uses `max(tasklane_tasks_pending)` and not `sum`.

### Exercise 4 — Provision the Grafana dashboard as code

Load `dashboards/tasklane.json` into Grafana via a labelled ConfigMap (no
clicking), and confirm the four panels render.

### Exercise 5 — Ship logs with Alloy

Deploy the Alloy node-agent DaemonSet and confirm Tasklane logs arrive in Loki
with `namespace`, `app`, `container` and `level` labels — and that `pod` is
**not** a label. Explain why.

### Exercise 6 — Find deprecated APIs before an upgrade

Scan the repo's manifests with Pluto and read the apiserver's
`apiserver_requested_deprecated_apis` metric. State what each catches that the
other misses.

### Exercise 7 — Back up and restore Tasklane with Velero

(Needs object storage.) Take a manual backup of the `tasklane` namespace, delete
the namespace to simulate loss, and restore it. Verify the app recovers.

### Exercise 8 — Snapshot etcd

Take an etcd snapshot via the static-pod `etcdctl`, and read `endpoint status`
and `member list`. State how many member failures a 3-member cluster tolerates.

### Exercise 9 — Drain a node safely

Add a PodDisruptionBudget for the API, then drain a worker node and watch the
API stay available. Explain what `--ignore-daemonsets` is for and why drain may
block.

## Solutions

### Solution 1

```bash
kubectl -n tasklane port-forward svc/tasklane-api 18080:80 &
curl -s localhost:18080/metrics | grep -E '^tasklane_'
kill %1
kubectl -n tasklane port-forward svc/tasklane-worker-metrics 19090:9090 &
curl -s localhost:19090/metrics | grep -E '^tasklane_'
kill %1
```

```console include="captures/operations/ops-api-metrics.txt"
```

```console include="captures/operations/ops-worker-metrics.txt"
```

The API exposes `tasklane_http_requests_total` (counter, labelled by `method`
and `code`), `tasklane_tasks_created_total` (counter) and
`tasklane_tasks_pending` (gauge). The worker exposes
`tasklane_tasks_processed_total` and `tasklane_worker_errors_total`.

### Solution 2

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace \
  --version <PINNED_VERSION> \
  --values examples/observability/values.yaml
kubectl apply -f examples/observability/servicemonitor-tasklane.yaml
```

The ServiceMonitors:

```yaml include="examples/observability/servicemonitor-tasklane.yaml"
```

Port-forward Prometheus and open **Status → Targets**; both `tasklane-api` and
`tasklane-worker` should be `UP`. kube-prometheus v0.18 lists Kubernetes
1.33–1.36 only, so the stack may log a skew warning on 1.37 — expected, not an
error.

### Solution 3

```bash
kubectl apply -f examples/observability/prometheusrule-tasklane.yaml
```

The alert:

```yaml include="examples/observability/prometheusrule-tasklane.yaml" lines="31-47"
```

`tasklane_tasks_pending` is a gauge that **each** API replica reports from the
**same** database, so both replicas emit the same value. `max()` collapses the
duplicate series to the true backlog; `sum()` would double it and fire falsely.
The `for: 10m` window ignores brief spikes so only a sustained backlog pages.

### Solution 4

```bash
kubectl create configmap tasklane-dashboard --namespace monitoring \
  --from-file=tasklane.json=examples/observability/dashboards/tasklane.json \
  --dry-run=client -o yaml \
  | kubectl label --local -f - grafana_dashboard=1 -o yaml | kubectl apply -f -
```

The Grafana sidecar (enabled in `values.yaml`) watches for the
`grafana_dashboard` label and imports the JSON. The dashboard uses a
`${datasource}` variable so it binds to whichever Prometheus datasource exists —
never hard-code the datasource UID.

### Solution 5

```bash
kubectl apply -f examples/operations/logging/alloy-daemonset.yaml
```

Query Loki in Grafana Explore: `{app="tasklane-api"} | json`. The labels are
`namespace`, `app`, `container`, `level` — deliberately low-cardinality. `pod`
is **not** a label because Loki creates one stream per unique label set; a
per-pod label multiplies streams and destroys performance. The pod identity
stays queryable in the log line, not the index.

### Solution 6

```bash
pluto detect-files -d examples/
kubectl get deploy,ds,sts,ingress,networkpolicy -A -o yaml | pluto detect -
kubectl get --raw /metrics | grep apiserver_requested_deprecated_apis
```

```console include="captures/operations/ops-pluto-files.txt"
```

Pluto scans **static** manifests (on disk and stored objects). The
`apiserver_requested_deprecated_apis` metric catches **live callers** —
controllers, CI, scripts — hitting deprecated endpoints even when no stored
object uses them. You need both: static scan for what you author, the metric for
who actually calls. (On 1.37 both should be clean; nothing was removed in
1.33–1.37.)

### Solution 7

```bash
velero backup create tasklane-manual --include-namespaces tasklane --wait
velero backup describe tasklane-manual --details
kubectl delete namespace tasklane        # simulate loss (lab only)
velero restore create --from-backup tasklane-manual --wait
kubectl -n tasklane get pods
```

Object-only backups do not include volume data unless CSI snapshots or Kopia
file backup are enabled; kind's local-path provisioner has no snapshots, so use
`defaultVolumesToFsBackup: true` for the PostgreSQL PVC. Do not use MinIO as the
target — it is archived; use a cloud or maintained S3-compatible bucket.

### Solution 8

```bash
kubectl -n kube-system exec etcd-tasklane-control-plane -- etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  snapshot save /var/lib/etcd/snapshot.db
```

```console include="captures/operations/ops-etcd-member-list.txt"
```

A 3-member etcd cluster has quorum 2 and tolerates **1** member failure. Copy the
snapshot off the node — a snapshot on the failing node is not a backup. (The lab
is single-node, so this is a 1-member cluster that tolerates 0 failures; the math
is what matters for production.)

### Solution 9

Add a PDB, then drain:

```yaml title="examples/operations/pdb-api.yaml (illustrative)" fragment
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: tasklane-api
  namespace: tasklane
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: tasklane-api
```

```bash
kubectl -n tasklane get pdb
kubectl drain <worker-node> --ignore-daemonsets --delete-emptydir-data
```

```console include="captures/operations/ops-pdb.txt"
```

`--ignore-daemonsets` is required because DaemonSet pods are recreated on the
node and cannot be drained. With `minAvailable: 1` on a 2-replica API, drain
evicts one replica, waits for a replacement to become Ready on another node, then
takes the second — never dropping below one available. If a PDB set
`maxUnavailable: 0`, drain would block forever, which is the safety mechanism
doing its job.

## Common mistakes

- Summing a per-replica gauge (`tasklane_tasks_pending`) instead of taking
  `max`, so the backlog alert fires falsely.
- Forgetting the ServiceMonitor `release`/namespace so Prometheus never adopts
  it, then blaming the app for "no metrics".
- Putting `pod` (or worse, request/user ids) in Loki labels and melting Loki.
- Running Velero backups but never testing a restore.
- Draining with no PDB (outage) or an impossible PDB (drain hangs), and omitting
  `--ignore-daemonsets`.
- Leaving the etcd snapshot on the node that failed.

## Related topics

- [Prometheus and kube-prometheus](prometheus-and-kube-prometheus.md)
- [Actionable alerting](actionable-alerting.md)
- [Logging architectures](logging-architectures.md)
- [Velero backup and restore](velero-backup-and-restore.md)
- [Node maintenance](node-maintenance.md)
- [etcd backup and restore](etcd-backup-and-restore.md)
