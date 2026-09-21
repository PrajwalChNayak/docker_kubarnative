---
title: Tasklane on Kubernetes
description: Stage 3 of the running example — the Compose stack becomes namespace, database, API, worker and Gateway manifests on the kind lab cluster.
level: beginner
type: tutorial
status: current
versions: Kubernetes 1.37, Gateway API v1.6.2
prerequisites:
  - k8s-beginner/deployments-and-replicasets
  - k8s-beginner/services
  - k8s-beginner/configmaps
  - k8s-beginner/secrets
---

## Overview

Everything in Part F now applies to one system. Tasklane ran with
`docker run` in Part B and with Compose in Part C; here it becomes four
stages of manifests in `examples/k8s/`, applied to the kind cluster from
[local clusters](local-clusters.md):

| Stage | Directory | Objects |
|---|---|---|
| 1 | `01-namespace/` | Namespace `tasklane`, Pod Security labels |
| 2 | `02-database/` | Headless Service and StatefulSet for PostgreSQL 18 |
| 3 | `03-app/` | ConfigMap, API Deployment and Service, worker Deployment and metrics Service, two ServiceAccounts |
| 4 | `04-gateway/` | EnvoyProxy, GatewayClass, Gateway, HTTPRoute |

The database Secret is created by hand, because credentials do not belong in
git.

## What changes from Compose

| Compose | Kubernetes |
|---|---|
| `services:` in one file | One object per concern, in four directories |
| `depends_on: service_healthy` | Nothing. Probes plus retries; pods start in any order |
| `restart: unless-stopped` | `restartPolicy: Always`, owned by a Deployment |
| Named volume | `volumeClaimTemplates` in a StatefulSet |
| `secrets:` with a file | A Secret object, mounted as a file |
| `ports: 8080:8080` | A Service plus a Gateway and HTTPRoute |
| `deploy.replicas` | `spec.replicas`, with a rollout strategy |
| Service name as hostname | A Service name in cluster DNS |

The application binary does not change at all: the same image, the same
libpq environment variables, the same `PGPASSWORD_FILE` contract.

## Prerequisites

```bash
kind create cluster --config examples/lab/kind-config.yaml
docker build --target api    -t tasklane-api:0.1.0    examples/app
docker build --target worker -t tasklane-worker:0.1.0 examples/app
kind load docker-image tasklane-api:0.1.0 tasklane-worker:0.1.0 --name tasklane
```

The lab also installs metrics-server, the Gateway API standard-channel CRDs,
Envoy Gateway v1.9.1 and cert-manager.

## Stage 1: the namespace

```yaml include="examples/k8s/01-namespace/namespace.yaml"
```

```bash
kubectl apply -f examples/k8s/01-namespace/
```

The namespace enforces the restricted Pod Security Standard from the first
second, pinned to `v1.37`. Every manifest that follows was written to satisfy
it, which is much easier than retrofitting it later — see
[namespaces](namespaces.md).

## Stage 2: the database

```yaml include="examples/k8s/02-database/postgres.yaml"
```

```bash
kubectl -n tasklane create secret generic tasklane-db --from-file=password=./db-password.txt
kubectl apply -f examples/k8s/02-database/
kubectl -n tasklane rollout status statefulset/postgres
```

Three things are worth pausing on:

- The Service is **headless** (`clusterIP: None`), so `postgres` resolves
  straight to the pod IP and the StatefulSet member also gets the stable name
  `postgres-0.postgres.tasklane.svc.cluster.local`.
- The pod runs as UID 999 rather than root. The official image normally
  starts as root and steps down; starting directly as `postgres` satisfies
  the restricted profile, and `fsGroup` makes the mounted volume writable.
- `readOnlyRootFilesystem: true` forces every writable path to be an explicit
  volume: the data directory, `/var/run/postgresql` and `/tmp`.

StatefulSets, volumes and storage classes are Part G material
([StatefulSets](../k8s-intermediate/statefulsets.md)); here the database is
a dependency that has to exist.

:::warning One replica, local disk
This is a lab database on a local-path volume: no replication, no failover,
no backups. Production means a managed service or an operator such as
CloudNativePG.
:::

## Stage 3: configuration, API and worker

```yaml include="examples/k8s/03-app/config.yaml"
```

The ConfigMap holds only non-secret values, including
`PGPASSWORD_FILE: /etc/tasklane/db/password` — the path where the Secret is
mounted. The password itself is never an environment variable.

```yaml include="examples/k8s/03-app/api.yaml"
```

Reading this file top to bottom is a tour of Part F:

- A **ServiceAccount** with `automountServiceAccountToken: false`, because
  the API never calls the Kubernetes API.
- `replicas: 2` with `maxSurge: 1, maxUnavailable: 0`, so capacity never dips
  during a release, and `revisionHistoryLimit: 5` so `rollout undo` works.
- **topologySpreadConstraints** across the lab's two zone-labelled workers.
- An **init container** running `migrate`. It is idempotent, so concurrent
  runs are safe, and the application containers start only after it exits 0.
- Three probes doing three different jobs: `startupProbe` holds the others
  off, `livenessProbe` checks only the process (`/healthz`), and
  `readinessProbe` checks the database (`/readyz`) so a database outage
  removes pods from the Service instead of restarting them.
- The Secret mounted as a file, read-only.
- A ClusterIP Service on port 80 targeting the named port `http`.

```yaml include="examples/k8s/03-app/worker.yaml"
```

The worker takes no traffic. Its Service exists only so Prometheus can
discover every replica's `/metrics` endpoint in Part J. Its liveness probe
uses the metrics port, and its 30-second grace period is long enough for the
worker to hand an in-flight task back to the queue on SIGTERM.

```bash
kubectl apply -f examples/k8s/03-app/
kubectl -n tasklane rollout status deploy/tasklane-api
kubectl -n tasklane get deploy,rs,pods,svc -o wide
```

```console include="captures/k8s-beginner/tasklane-get-all.txt"
```

```console include="captures/k8s-beginner/tasklane-endpointslices.txt"
```

## Stage 4: the Gateway

```yaml include="examples/k8s/04-gateway/gateway.yaml"
```

```bash
kubectl apply -f examples/k8s/04-gateway/
kubectl -n tasklane get gateway,httproute -o wide
```

```console include="captures/k8s-beginner/gateway-status.txt"
```

```console include="captures/k8s-beginner/gateway-describe.txt"
```

Gateway API splits what Ingress conflated: the **GatewayClass** is the
implementation (Envoy Gateway), the **Gateway** is the listener a cluster
operator owns, and the **HTTPRoute** is the routing an application team
owns. In the lab the Envoy data plane is a NodePort Service pinned to 30080,
which `kind-config.yaml` maps to `localhost:8080` on your machine.

:::legacy Not ingress-nginx
ingress-nginx was retired and its repository archived on 2026-03-24, with no
further releases or security fixes. New work uses Gateway API; the Ingress
API still exists, is GA and is frozen. See
[ingress-nginx retirement](../migration/ingress-nginx-retirement.md) and
[Ingress (legacy)](../k8s-intermediate/ingress-legacy.md).
:::

## Verify the whole stack

```bash
curl -s http://localhost:8080/
curl -s -X POST -H 'Content-Type: application/json' -d '{"title":"written from the handbook"}' http://localhost:8080/tasks
curl -s http://localhost:8080/tasks
```

```console include="captures/k8s-beginner/tasklane-curl-root.txt"
```

```console include="captures/k8s-beginner/tasklane-curl-post-task.txt"
```

`GET /` reports the pod's hostname, so repeated calls show the Gateway
spreading requests across the two API replicas. Posting a task and listing
tasks a few seconds later shows the worker claiming it — the same
`FOR UPDATE SKIP LOCKED` queue as in Compose, now with two worker replicas
competing safely.

```bash
kubectl -n tasklane logs deploy/tasklane-worker --tail=15
kubectl -n tasklane get statefulset,pvc,pv -o wide
```

```console include="captures/k8s-beginner/logs-worker.txt"
```

```console include="captures/k8s-beginner/tasklane-statefulset-pvc.txt"
```

## Roll something out

```bash
kubectl -n tasklane rollout restart deploy/tasklane-api
kubectl -n tasklane rollout status deploy/tasklane-api
```

```console include="captures/k8s-beginner/tasklane-rollout-restart.txt"
```

Because `maxUnavailable: 0`, two ready replicas exist throughout; because the
API fails readiness before draining, the Gateway stops sending it requests
before it stops accepting them. Keep `curl http://localhost:8080/` running in
another terminal and you should see no errors.

## What is still missing

Stage 4 is a working application, not a production one. Later parts add:

- [Probes](../k8s-intermediate/probes.md) tuned properly, plus
  [resource requests and limits](../k8s-intermediate/resources-requests-limits.md)
  and [pod disruption budgets](../k8s-intermediate/pod-disruption-budgets.md).
- [NetworkPolicy](../k8s-intermediate/network-policy.md) so the database only
  accepts traffic from the API and worker.
- [TLS at the Gateway](../k8s-intermediate/gateway-api-tls-and-traffic.md)
  with [cert-manager](../k8s-intermediate/cert-manager.md).
- [Kustomize](../k8s-advanced/kustomize.md) or
  [Helm](../k8s-advanced/helm.md) instead of four directories of raw YAML,
  and [GitOps](../k8s-advanced/gitops-argo-cd.md) instead of `kubectl apply`.
- [Autoscaling](../k8s-advanced/horizontal-pod-autoscaler.md),
  [observability](../operations/prometheus-and-kube-prometheus.md) and
  [backups](../operations/velero-backup-and-restore.md).

## Common mistakes

- **Forgetting `kind load docker-image`.** The manifests reference
  `tasklane-api:0.1.0`, which exists only in your local Docker until you load
  it into the nodes.
- **Creating the Secret with the wrong key name.** The volume projects the
  key `password`; a Secret with `PGPASSWORD` mounts nothing useful and the
  pods fail readiness.
- **Applying stage 3 before stage 1.** The namespace must exist first; apply
  the directories in order.
- **Expecting the API pods to be ready before the database is.** They will
  crash-loop on readiness until PostgreSQL answers, then settle. That is the
  design, not a bug.
- **Editing the Deployment in the cluster instead of the file.** The next
  apply reverts it.
- **Publishing the Gateway on another port** and wondering why
  `localhost:8080` stopped working: the mapping is fixed in
  `kind-config.yaml` and only ports listed there reach the host.

## Related topics

- [Deployments and ReplicaSets](deployments-and-replicasets.md)
- [Services](services.md)
- [Secrets](secrets.md)
- [Labs](labs.md)
- [Gateway API](../k8s-intermediate/gateway-api.md)
- [StatefulSets](../k8s-intermediate/statefulsets.md)
- [Tasklane with Compose](../docker-intermediate/tasklane-with-compose.md)
