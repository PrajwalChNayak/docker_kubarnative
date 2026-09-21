---
title: Tasklane in production
description: How every piece the handbook built — hardened images, Helm/Kustomize, autoscaling, network policy, PSA, TLS, observability, backups and GitOps — composes into a production deployment of Tasklane.
level: expert
type: tutorial
status: current
versions: Kubernetes 1.37
prerequisites:
  - production/production-readiness-checklist
  - production/managed-kubernetes-compared
  - k8s-advanced/gitops-argo-cd
---

## Overview

Every part of this handbook built one system, Tasklane, one capability at a time:
`docker run`, then Compose, then hardened images and a supply chain, then raw
manifests, probes, storage, Gateway and NetworkPolicy, then Kustomize, Helm,
GitOps and autoscaling, then RBAC, PSA and signing, then observability and
backups. This page is the assembly drawing — it shows how those pieces compose
into a production deployment and what changes between the kind lab and a real
managed cluster. It introduces almost no new artifacts; it wires up existing
ones. The companion map is
[`examples/production/tasklane-in-production/README.md`](../../examples/production/tasklane-in-production/README.md),
which references each part's example directory by relative path rather than
copying it.

Read this as the capstone: if you can explain why each layer below is present and
who owns it, you can take a service to production on Kubernetes.

## The layers, bottom to top

Production Tasklane is the same four processes — API, worker, Postgres (usually
managed), and a migration — wrapped in the following layers. Each maps to a part
of the handbook and a row of the [readiness
checklist](production-readiness-checklist.md).

### 1. A hardened, digest-pinned image

The base is the single [`examples/app/Dockerfile`](../../examples/app/Dockerfile):
distroless `static-debian13:nonroot`, UID 65532, exec-form ENTRYPOINT, a
`healthcheck` subcommand. In production the tag becomes a **digest**, set in the
prod overlay, and admission refuses anything unsigned or unscanned. The image is
built, scanned (Trivy/Grype), given an SBOM, and signed (cosign) in CI — the
[supply-chain admission](../k8s-security/supply-chain-admission.md) layer verifies
the signature at deploy time.

### 2. Workload manifests that are already production-shaped

The Deployment from [`examples/k8s/03-app/api.yaml`](../../examples/k8s/03-app/api.yaml)
already carries the production essentials — this is the pod spec, unchanged from
Part F:

```yaml include="examples/k8s/03-app/api.yaml" lines="39-56"
```

Non-root, dropped capabilities, a read-only root filesystem, a seccomp profile,
distinct startup/liveness/readiness probes, resource requests and limits, and
topology spread across zones. The lab did this from day one precisely so
"production" is a change of parameters, not a rewrite.

### 3. Disruption budgets and autoscaling

A [PodDisruptionBudget](../k8s-intermediate/pod-disruption-budgets.md) ensures a
drain or node upgrade cannot take the API to zero. An
[HPA](../k8s-advanced/horizontal-pod-autoscaler.md) scales replicas on a
meaningful signal, and a node autoscaler
([Cluster Autoscaler/Karpenter/NAP](../k8s-advanced/cluster-autoscaler-and-karpenter.md))
provisions nodes to match, with headroom for a zone loss.

### 4. Segmentation: default-deny NetworkPolicy and PSA restricted

The `tasklane` namespace enforces **PSA restricted** from
[`examples/k8s/01-namespace/namespace.yaml`](../../examples/k8s/01-namespace/namespace.yaml).
On top, a [default-deny NetworkPolicy](../k8s-security/network-segmentation.md)
(ingress and egress) with explicit allows means the API can reach Postgres and
the Gateway can reach the API — and nothing else can reach anything. Confirm the
CNI actually enforces policy (Calico, Cilium, Dataplane V2); the managed-provider
pages say which each cluster uses.

### 5. TLS at the edge via Gateway + cert-manager

The lab's HTTP [Gateway](../../examples/k8s/04-gateway/gateway.yaml) becomes an
HTTPS listener whose certificate is issued and rotated by
[cert-manager](../k8s-intermediate/cert-manager.md), with HTTP redirecting to
HTTPS. Gateway API is the handbook's primary ingress mechanism; ingress-nginx is
retired and must not be used for new work.

### 6. Packaging and delivery: Kustomize/Helm + GitOps

Environment differences (image digests, replica counts, the TLS listener,
pointing `PGHOST` at a managed database) live in a Kustomize overlay or Helm
values, not in the base. The cluster's desired state lives in Git, and
[Argo CD](../k8s-advanced/gitops-argo-cd.md) or
[Flux](../k8s-advanced/gitops-flux.md) reconciles it — drift is detected, every
change is reviewed, and a rollback is a git revert.

### 7. Secrets, data, observability and backup

Secrets are synced from an external manager (never a plaintext file), and the API
server encrypts them at rest. Postgres is usually a managed database with its own
tested backups; if it stays in-cluster it needs a real storage class and a Velero
or snapshot backup. Metrics, logs and traces flow to the
[observability stack](../operations/prometheus-and-kube-prometheus.md), and
alerts are tied to [SLOs](../operations/slos-and-error-budgets.md).

## What changes from the lab

| Concern | Lab (kind) | Production |
|---|---|---|
| Image ref | `tasklane-api:0.1.0`, side-loaded | `registry/…@sha256:…`, pulled, signed, verified |
| Database | in-cluster Postgres StatefulSet | managed database (usually); in-cluster only with tested backups |
| Edge | HTTP Gateway on `localhost:8080` | HTTPS Gateway, cert-manager, real DNS |
| Secrets | Secret from a file | External Secrets / sealed, encrypted at rest |
| Scale | fixed 2 replicas | HPA + node autoscaler, multi-AZ, PDB |
| Delivery | `kubectl apply` | GitOps reconciliation from Git |
| Control plane | kind, one node | managed (EKS/GKE/AKS) or kubeadm HA |

## Verify the running cluster

Whatever the control plane, the same read-only checks confirm it is healthy and
serving the APIs your workloads depend on:

```bash
kubectl version
kubectl cluster-info
kubectl get --raw='/livez?verbose' | head
kubectl get apiservices | grep -v Local | head
```

```console include="captures/production/cluster-info.txt"
```

```console include="captures/production/apiservices.txt"
```

The `apiservices` check matters in production because aggregated APIs
(metrics-server, and any extension APIs) are a common source of partial outages:
an unavailable aggregated API can block autoscaling or `kubectl top` while the
core API server looks fine.

## Gate before shipping

Walk the [readiness checklist](production-readiness-checklist.md) end to end. On a
managed control plane the provider owns the `[M]` rows; you own the rest. The
checklist is the definition of done — not this page, and not "it worked in
staging."

## Common mistakes

- **Putting environment differences in the base** instead of the prod overlay, so
  the lab and prod configs drift.
- **Pinning by tag, not digest**, and skipping signature verification at
  admission.
- **Keeping Postgres in-cluster without a tested restore** because it was
  convenient in the lab.
- **Shipping the HTTP Gateway to production** without TLS and a redirect.
- **Applying with `kubectl` in production** instead of GitOps, losing review,
  audit and drift detection.
- **Declaring done at "staging passed"** instead of walking the readiness
  checklist.

## Related topics

- [Production-readiness checklist](production-readiness-checklist.md)
- [Managed Kubernetes compared](managed-kubernetes-compared.md)
- [GitOps with Argo CD](../k8s-advanced/gitops-argo-cd.md)
- [Supply-chain admission](../k8s-security/supply-chain-admission.md)
- [Network segmentation](../k8s-security/network-segmentation.md)
- [cert-manager](../k8s-intermediate/cert-manager.md)
- [Horizontal Pod Autoscaler](../k8s-advanced/horizontal-pod-autoscaler.md)
