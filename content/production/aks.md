---
title: Azure AKS
description: What AKS manages — pricing tiers and SLA, Azure CNI Overlay, Entra Workload ID, node autoprovisioning, and LTS versus community support.
level: advanced
type: reference
status: current
versions: Kubernetes 1.37
prerequisites:
  - production/managed-kubernetes-compared
  - k8s-security/service-accounts-and-tokens
  - k8s-intermediate/network-model-and-cni
---

## Overview

Azure Kubernetes Service manages the control plane and integrates tightly with
Azure identity (Microsoft Entra), Azure networking (VNets) and Azure Monitor.
Two things make AKS distinctive: the **control plane comes in tiers** — and the
cheapest one has no financially-backed SLA — and Microsoft offers a **Long Term
Support** path that stretches a version's life to two years for teams that
cannot upgrade on the community cadence.

Written against Kubernetes 1.37. **AKS Automatic** is Microsoft's recommended
production-ready default: it preconfigures the Standard tier, a managed node
experience, and both a cluster uptime SLA and a pod-readiness SLA.

## Tiers and SLA

AKS control-plane management has three tiers:

| Tier | Control-plane SLA | Notes |
|---|---|---|
| Free | Best-effort, **no financially-backed SLA** | Dev/test, small clusters (up to ~1,000 nodes) |
| Standard | **99.95%** with availability zones, **99.9%** without | Production default; up to 5,000 nodes; SLA on by default |
| Premium | Same SLA as Standard, **plus 24-month LTS** | Regulated/long-lived clusters that upgrade slowly |

When a region supports availability zones, the AKS control plane is
automatically spread across zones on Standard and Premium. The lesson for
production: **do not run production on the Free tier** — you forfeit the API
server SLA to save the control-plane fee, which is a poor trade.

## Version support: community and LTS

AKS supports three GA minors at a time — the latest (N) and the two previous
(N-1, N-2) — under **community support**, roughly a year per minor. After that a
version enters **platform support (N-3)**, where Microsoft supports only
Azure-platform issues, not Kubernetes functionality. To go beyond community
support you enable **Long Term Support** (Premium tier + `AKSLongTermSupport`
plan), which adds a second year of backported security fixes.

A useful AKS-specific skew rule: since 1.28 the **control plane may lead node
pools by up to three minor versions**, so you can upgrade the control plane
first and roll node pools afterward within that window.

## Networking: Azure CNI Overlay

AKS's recommended dataplane is **Azure CNI Overlay**: pods get IPs from a
private overlay CIDR rather than consuming VNet address space, which avoids the
VNet-IP-exhaustion problem that the older flat Azure CNI (real VNet IPs per pod)
and legacy **kubenet** exhibited. Overlay is available plain or **powered by
Cilium** (eBPF dataplane with NetworkPolicy enforcement), which Microsoft
recommends for the best performance and policy features. kubenet is legacy and
Microsoft steers new clusters to overlay; node autoprovisioning in particular
requires Azure CNI (overlay or standard), not kubenet.

For NetworkPolicy enforcement, Azure CNI Overlay powered by Cilium enforces
standard `NetworkPolicy` objects directly. See [network model and
CNI](../k8s-intermediate/network-model-and-cni.md).

## Identity: Entra Workload ID

The recommended pod-to-cloud identity model is **Microsoft Entra Workload ID**:
a Kubernetes ServiceAccount is linked to an Entra application or managed identity
through a **federated credential**, and pods receive short-lived tokens via the
cluster's OIDC issuer — no secrets on disk. AKS also integrates Entra for
cluster authentication and can use **Azure RBAC for Kubernetes authorization** so
that Kubernetes access is governed by Azure role assignments. This is AKS's
counterpart to IRSA/Pod Identity and Workload Identity Federation. See [service
accounts and tokens](../k8s-security/service-accounts-and-tokens.md).

## Nodes and autoscaling

- **Node pools.** System node pools run cluster-critical pods; user node pools
  run your workloads. You upgrade node images and versions (auto-upgrade
  channels are available).
- **Cluster autoscaler** scales existing node pools.
- **Node Autoprovisioning (NAP)** provisions right-sized nodes from pending-pod
  requirements and is **powered by the Karpenter Azure provider** — the same
  Karpenter model AWS pioneered, adapted to Azure. NAP requires Azure CNI
  (overlay recommended).

## Storage, ingress and observability

- **Storage.** Azure Disk CSI (block), Azure File CSI (SMB/NFS shares) and Azure
  Blob CSI are the managed defaults.
- **Ingress / Gateway.** The Azure Load Balancer backs Services; Application
  Gateway for Containers and the application-routing add-on provide L7; the ALB
  controller supports Gateway API.
- **Observability.** Azure Monitor and Azure Monitor managed service for
  Prometheus integrate with the cluster; note that on 1.37 managed Prometheus
  uses namespace-scoped secret access for `ServiceMonitor`/`PodMonitor` — a
  breaking change to configure before upgrading.

## Common mistakes

- **Running production on the Free tier** and losing the API server SLA.
- **Provisioning new clusters on kubenet** when Azure CNI Overlay (optionally
  with Cilium) is the supported, IP-efficient, policy-capable path — and the one
  NAP requires.
- **Assuming community support lasts forever.** After N-2, a version drops to
  platform support (Azure issues only); use Premium LTS if you must stay put.
- **Shipping service-principal secrets in pods** instead of Entra Workload ID.
- **Upgrading to 1.37 without fixing managed-Prometheus secret scoping**, which
  can break metric scraping.

## Related topics

- [Managed Kubernetes compared](managed-kubernetes-compared.md)
- [Amazon EKS](eks.md)
- [Google GKE](gke.md)
- [Network model and CNI](../k8s-intermediate/network-model-and-cni.md)
- [Service accounts and tokens](../k8s-security/service-accounts-and-tokens.md)
- [Cluster autoscaler and Karpenter](../k8s-advanced/cluster-autoscaler-and-karpenter.md)
- [Cluster upgrades](../operations/cluster-upgrades.md)
