#!/usr/bin/env bash
# Stand up the whole Tasklane lab on a local kind cluster.
#
#   ./examples/lab/up.sh          # cluster + core add-ons + Tasklane stages 1-4
#   ./examples/lab/up.sh --addons # also install cert-manager, metrics-server
#
# Idempotent: safe to re-run. Requires docker, kind, kubectl, helm on PATH.
# Everything here runs against a DISPOSABLE local cluster. Never point these
# commands at a shared or production cluster.
set -euo pipefail

CLUSTER=tasklane
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

need() { command -v "$1" >/dev/null || { echo "missing required tool: $1" >&2; exit 1; }; }
need docker; need kind; need kubectl

echo "==> Creating kind cluster '$CLUSTER' (Kubernetes 1.37.0)"
if ! kind get clusters | grep -qx "$CLUSTER"; then
  kind create cluster --config examples/lab/kind-config.yaml
else
  echo "    already exists"
fi
kubectl config use-context "kind-$CLUSTER"

echo "==> Building and loading Tasklane images"
docker build --target api    -t tasklane-api:0.1.0    --build-arg VERSION=0.1.0 examples/app
docker build --target worker -t tasklane-worker:0.1.0 --build-arg VERSION=0.1.0 examples/app
kind load docker-image tasklane-api:0.1.0 tasklane-worker:0.1.0 --name "$CLUSTER"

if [[ "${1:-}" == "--addons" ]]; then
  need helm
  echo "==> Installing metrics-server (kind-insecure kubelet TLS)"
  kubectl apply -k examples/lab/metrics-server

  echo "==> Installing cert-manager v1.21.2"
  helm upgrade --install cert-manager oci://quay.io/jetstack/charts/cert-manager \
    --version v1.21.2 -n cert-manager --create-namespace \
    --set crds.enabled=true --wait --timeout 5m
fi

echo "==> Installing Envoy Gateway v1.9.1 (Gateway API implementation)"
helm upgrade --install eg oci://docker.io/envoyproxy/gateway-helm \
  --version v1.9.1 -n envoy-gateway-system --create-namespace --wait --timeout 5m

echo "==> Deploying Tasklane (stages 1-4)"
kubectl apply -f examples/k8s/01-namespace/
if ! kubectl -n tasklane get secret tasklane-db >/dev/null 2>&1; then
  kubectl -n tasklane create secret generic tasklane-db \
    --from-literal=password="$(openssl rand -hex 16)"
fi
kubectl apply -f examples/k8s/02-database/ -f examples/k8s/03-app/ -f examples/k8s/04-gateway/

echo "==> Waiting for rollout"
kubectl -n tasklane rollout status statefulset/postgres --timeout=180s
kubectl -n tasklane rollout status deployment/tasklane-api --timeout=180s
kubectl -n tasklane rollout status deployment/tasklane-worker --timeout=120s
kubectl -n tasklane wait gateway/tasklane --for=condition=Programmed --timeout=120s || true

cat <<'EOF'

Tasklane is up. Try it through the Gateway (kind maps NodePort 30080 to host 8080):

  curl -XPOST localhost:8080/tasks -H 'Content-Type: application/json' -d '{"title":"hello"}'
  curl localhost:8080/tasks

Tear everything down with:  ./examples/lab/down.sh
EOF
