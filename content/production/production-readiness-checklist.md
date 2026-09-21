---
title: Production-readiness checklist
description: A gate-by-gate checklist for taking a Kubernetes cluster and its workloads to production, split by who owns each item.
level: advanced
type: reference
status: current
versions: Kubernetes 1.37
prerequisites:
  - production/managed-kubernetes-compared
  - k8s-security/pod-security-standards
  - operations/slos-and-error-budgets
---

## Overview

"Production-ready" is not a feeling; it is a set of gates. This page is the
checklist the rest of Part K refers back to, split by **who owns each item** so
you know what a managed control plane removes and what stays yours no matter what.
Each item is a gate, not a suggestion — a cluster that fails an item is not
production-ready, it is one that has not failed yet.

The same list is mirrored as a copyable document at
[`examples/production/readiness-checklist.md`](../../examples/production/readiness-checklist.md).
Legend: **[M]** the managed provider owns this on EKS/GKE/AKS (you own it on
kubeadm/k3s); **[P]** platform/cluster owner; **[A]** application team.

## Control plane and etcd

- **[M]** Control plane is HA: 3 or 5 API servers behind a load balancer, across
  failure domains.
- **[M]** etcd is an odd-sized quorum on its own fast disk, fsync latency
  monitored.
- **[M]** etcd is backed up on a schedule, off-cluster, and **a restore has been
  rehearsed**.
- **[M]** Secrets are encrypted at rest with a KMS provider, not `identity`.
- **[P]** Certificate expiry is monitored and has a rotation runbook (kubeadm
  certs default to one year).
- **[P]** An upgrade runbook exists and has been rehearsed; version skew stays in
  policy (kubelet at most 3 minors behind the API server).

You can verify basic control-plane health directly. On a managed cluster these
endpoints confirm the provider's plane is healthy; on a self-managed one they are
your first upgrade smoke test:

```bash
kubectl version
kubectl get --raw='/readyz?verbose' | head -40
kubectl get --raw='/livez?verbose' | head
```

```console include="captures/production/readyz.txt"
```

## Identity, access and policy

- **[P]** RBAC is least-privilege: no wildcard `cluster-admin` for humans or CI;
  default ServiceAccount tokens are not auto-mounted.
- **[A]** Every workload has a dedicated ServiceAccount with
  `automountServiceAccountToken: false` unless it calls the API.
- **[P]** Pod Security Admission enforces **restricted** on application
  namespaces (`enforce`, plus `warn`/`audit`).
- **[P]** An admission layer (ValidatingAdmissionPolicy/CEL, Kyverno or
  Gatekeeper) blocks unpinned images, missing limits and host mounts.
- **[P]** Audit logging is on, shipped off-cluster, and retained.

## Networking

- **[P]** A **default-deny** NetworkPolicy (ingress and egress) exists in every
  application namespace, with explicit allows.
- **[P]** The CNI actually enforces NetworkPolicy (Calico, Cilium, Dataplane V2);
  flannel alone does not.
- **[A]** Ingress is a maintained controller or Gateway API implementation,
  terminating TLS with auto-rotated certificates.

## Workloads

- **[A]** Every container sets CPU/memory **requests**; memory **limits** are
  set; CPU limits are a deliberate choice.
- **[A]** Liveness, readiness and (where startup is slow) startup probes are
  distinct; liveness does not touch dependencies.
- **[A]** Every Deployment has a **PodDisruptionBudget** so drains and upgrades
  cannot take it fully down.
- **[A]** Replicas ≥ 2, spread across zones/nodes, `maxUnavailable: 0` on
  critical rollouts.
- **[A]** Graceful shutdown: `terminationGracePeriodSeconds` matches real drain
  time; SIGTERM fails readiness first.
- **[A]** Autoscaling: HPA on a meaningful signal; a node autoscaler
  (Cluster Autoscaler/Karpenter/NAP); headroom for a zone failure.

## Supply chain

- **[A]** Images are pinned by **digest**, built from a minimal/distroless base,
  run non-root with a read-only root filesystem.
- **[A]** Images are scanned and **signed** in CI; admission verifies signatures
  and provenance.
- **[A]** An SBOM is produced and stored per release.

## Data, secrets and DR

- **[P]** Secrets come from an external manager (ESO, Sealed Secrets, cloud KV),
  never committed in plaintext.
- **[A]** Stateful data is backed up with a **tested** restore; PV reclaim policy
  is deliberate (`Retain` for anything precious).
- **[P]** A DR plan names an RTO/RPO and has been tested (Velero or provider
  backup).

## Observability and cost

- **[P]** Metrics, logs (with retention) and traces are collected and queryable.
- **[P]** Alerts are actionable and tied to **SLOs/error budgets**, not raw
  resource thresholds.
- **[P]** Cost controls exist: requests right-sized, idle capacity bounded,
  cross-AZ traffic understood, budgets/alerts set.
- **[P]** Delivery is GitOps: desired state in Git, drift detected, changes
  reviewed.

## How to use this

Run the list top to bottom before a go-live and again after any material change
to the platform. On a managed control plane, tick the `[M]` rows as "the provider
owns this" and spend your effort on `[P]` and `[A]`. On kubeadm or k3s, every
`[M]` row is a project of its own — which is exactly the trade [self-managing
with kubeadm](kubeadm.md) makes explicit. The list is deliberately technology-
neutral: it says *what* must be true, and the rest of the handbook says *how*.

## Common mistakes

- **Treating the checklist as advisory.** The items are gates; a skipped gate is
  an incident scheduled for later.
- **Assuming the provider covers more than the `[M]` rows.** Managed control
  planes do not set your RBAC, NetworkPolicy, probes, or backups.
- **"We have backups" without a rehearsed restore.** Untested backups fail when
  you finally need them.
- **Alerting on CPU and memory** instead of on user-visible SLOs.
- **Running the list once at launch** and never again as the platform drifts.

## Related topics

- [Managed Kubernetes compared](managed-kubernetes-compared.md)
- [Self-managed with kubeadm](kubeadm.md)
- [Tasklane in production](tasklane-in-production.md)
- [Pod Security Standards](../k8s-security/pod-security-standards.md)
- [SLOs and error budgets](../operations/slos-and-error-budgets.md)
- [etcd backup and restore](../operations/etcd-backup-and-restore.md)
- [Velero backup and restore](../operations/velero-backup-and-restore.md)
