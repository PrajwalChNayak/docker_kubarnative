# Production-readiness checklist

Mirror of the checklist in `content/production/production-readiness-checklist.md`.
Keep the two in sync. Each item is a gate, not a suggestion: a cluster that
fails an item is not production-ready, it is a cluster that has not failed yet.

Legend: **[P]** platform/cluster owner, **[A]** application team. On a managed
control plane (EKS/GKE/AKS) the provider owns the control-plane rows marked
**[M]**; on kubeadm or k3s you own them.

## Control plane and etcd

- [ ] **[M]** Control plane is highly available: 3 (or 5) API servers behind a load balancer, spread across failure domains.
- [ ] **[M]** etcd is an odd-sized quorum (3 or 5), on its own disk, with fsync latency monitored.
- [ ] **[M]** etcd is backed up on a schedule, backups are stored off-cluster, and **a restore has actually been performed** in a drill.
- [ ] **[M]** etcd encryption at rest is enabled (`EncryptionConfiguration`, a KMS provider, not `identity`).
- [ ] **[P]** Control-plane and node certificates have a rotation runbook; expiry is monitored (kubeadm certs default to 1 year).
- [ ] **[P]** An upgrade runbook exists and has been rehearsed; version skew stays within policy (kubelet at most 3 minors behind the API server).

## Identity, access and policy

- [ ] **[P]** RBAC is least-privilege: no wildcard `cluster-admin` bindings for humans or CI; default ServiceAccount tokens are not auto-mounted.
- [ ] **[A]** Every workload has a dedicated ServiceAccount with `automountServiceAccountToken: false` unless it calls the API.
- [ ] **[P]** Pod Security Admission enforces **restricted** on application namespaces (`enforce`, plus `warn`/`audit`).
- [ ] **[P]** An admission policy layer (ValidatingAdmissionPolicy/CEL, Kyverno or Gatekeeper) blocks unpinned images, missing limits, host mounts.
- [ ] **[P]** Audit logging is on, shipped off-cluster, and retained per policy.

## Networking

- [ ] **[P]** A **default-deny** NetworkPolicy (ingress and egress) exists in every application namespace, with explicit allows.
- [ ] **[P]** The CNI enforces NetworkPolicy (Calico, Cilium, Dataplane V2); confirm — flannel alone does not.
- [ ] **[A]** Ingress is a maintained controller or Gateway API implementation, terminating TLS with automatically rotated certificates.

## Workloads

- [ ] **[A]** Every container sets CPU/memory **requests**; memory **limits** are set; CPU limits are a deliberate choice.
- [ ] **[A]** Liveness, readiness and (where startup is slow) startup probes are set and distinct; liveness does not touch dependencies.
- [ ] **[A]** Every Deployment has a **PodDisruptionBudget** so voluntary disruptions (drains, upgrades) cannot take it fully down.
- [ ] **[A]** Replicas ≥ 2, anti-affinity or topology spread across zones/nodes, `maxUnavailable: 0` on critical rollouts.
- [ ] **[A]** Graceful shutdown: `terminationGracePeriodSeconds` matches real drain time; SIGTERM fails readiness first.
- [ ] **[A]** Autoscaling: HPA on a meaningful signal; Cluster Autoscaler or Karpenter/NAP for nodes; headroom for a zone failure.

## Supply chain

- [ ] **[A]** Images are pinned by **digest**, built from a minimal/distroless base, and run as non-root with a read-only root filesystem.
- [ ] **[A]** Images are scanned (Trivy/Grype) and **signed** (cosign) in CI; admission verifies signatures and provenance.
- [ ] **[A]** An SBOM is produced and stored per release.

## Data and secrets

- [ ] **[P]** Secrets are encrypted at rest (KMS), sourced from an external manager (ESO, Sealed Secrets, cloud KV), not committed to Git in plaintext.
- [ ] **[A]** Stateful data (databases) is backed up with a tested restore; PV reclaim policy is deliberate (`Retain` for anything precious).

## Observability and operations

- [ ] **[P]** Metrics (Prometheus/managed), logs (with retention) and traces are collected and queryable.
- [ ] **[P]** Alerts are actionable and tied to **SLOs/error budgets**, not raw resource thresholds.
- [ ] **[P]** A disaster-recovery plan exists, names an RTO/RPO, and has been tested (Velero or provider backup).
- [ ] **[P]** Cost controls: requests are right-sized, idle capacity is bounded, cross-AZ traffic is understood, budgets/alerts exist.
- [ ] **[P]** Delivery is GitOps (Argo CD/Flux): the cluster's desired state is in Git, drift is detected, changes are reviewed.
