# Tasklane — the handbook's running example

Every Part of the handbook builds on one small system, **Tasklane**, so you
watch the same application mature from `docker run` to a hardened production
deployment.

## What it is

- **tasklane-api** — a Go HTTP API. Accepts tasks (`POST /tasks`), lists them
  (`GET /tasks`), and exposes `GET /healthz` (liveness), `GET /readyz`
  (readiness, checks the database) and `GET /metrics` (Prometheus).
- **tasklane-worker** — a Go background worker. Claims pending tasks with
  `SELECT ... FOR UPDATE SKIP LOCKED`, processes them, and exposes `/healthz`
  and `/metrics` on port 9090.
- **PostgreSQL 18** — the shared datastore.

Both binaries come from one multi-stage [Dockerfile](app/Dockerfile) with
targets `api` and `worker`: distroless, non-root (UID 65532), static, pinned
base images by digest, and a HEALTHCHECK that runs the binary's own
`healthcheck` subcommand.

## Directory map

| Path | Stage | What it shows |
|---|---|---|
| [`app/`](app) | source | The API + worker Go module and the production Dockerfile |
| [`compose/`](compose) | 2 | Local dev with Compose v5: watch mode, profiles, health-gated `depends_on`, secrets, an internal DB network |
| [`docker-run/`](docker-run) | 1 | The same system with plain `docker run` |
| [`dockerfiles/`](dockerfiles) | — | Focused Dockerfile demos (signals, cache, size) |
| [`build/`](build) | — | Buildx bake, multi-platform, attestations, CI |
| [`supply-chain/`](supply-chain) | — | cosign signing, SBOMs, scanning |
| [`security/`](security) | — | Vulnerable/fixed pairs (run only in a disposable VM/lab) |
| [`lab/`](lab) | — | kind cluster config and the one-command lab (`up.sh`) |
| [`k8s/`](k8s) | 3–4+ | Plain manifests by stage: namespace, database, app, gateway, TLS, NetworkPolicy, reliability, RBAC |
| [`kustomize/`](kustomize) | 5 | base + dev/staging/prod overlays |
| [`helm/tasklane/`](helm/tasklane) | 5 | A Helm 4 chart with values schema and chart tests |
| [`autoscaling/`](autoscaling) | — | HPA, VPA, KEDA |
| [`operator/`](operator) | — | A minimal CRD + controller |
| [`gitops/`](gitops) | 6 | Argo CD and Flux layouts |
| [`observability/`](observability) | — | kube-prometheus, alerts, a Grafana dashboard, OTel |
| [`ingress-legacy/`](ingress-legacy) | — | The legacy Ingress equivalent (for the migration guide) |
| [`migration/`](migration) | — | Before/after migration artifacts |
| [`troubleshooting/`](troubleshooting) | — | Broken manifests that reproduce common failures |

## The one-command lab

```bash
./examples/lab/up.sh --addons   # kind + cert-manager + metrics-server + Envoy Gateway + Tasklane
curl -XPOST localhost:8080/tasks -H 'Content-Type: application/json' -d '{"title":"hello"}'
curl localhost:8080/tasks
./examples/lab/down.sh          # destroy the cluster
```

The cluster is [kind](lab/kind-config.yaml): one control-plane and two worker
nodes (labelled `zone-a` / `zone-b`), pinned to the Kubernetes **1.37.0** node
image by digest. It maps NodePort 30080 to `http://localhost:8080` on your host.

Everything here is meant for a **disposable local cluster**. The security
examples include real misconfigurations and must never be applied to a shared
or production cluster.

## Versions

Written and validated against Kubernetes 1.37, Docker Engine 29, Compose v5 and
Helm 4, verified 2026-09-21. Base images are pinned by digest; re-pin them
before you rely on them, because upstream tags move.
