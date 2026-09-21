---
title: Google GKE
description: What GKE manages — Autopilot versus Standard, Dataplane V2, Workload Identity Federation, node auto-provisioning and release channels.
level: advanced
type: reference
status: current
versions: Kubernetes 1.37
prerequisites:
  - production/managed-kubernetes-compared
  - k8s-security/service-accounts-and-tokens
  - k8s-intermediate/network-policy
---

## Overview

Google Kubernetes Engine is the oldest managed Kubernetes service and the most
opinionated about automation. Google always manages the control plane, and
GKE's defining choice is **Autopilot versus Standard**: two modes of the same
service that draw the shared-responsibility line in very different places.
Understanding that split is most of understanding GKE.

Written against Kubernetes 1.37. GKE's control-plane management fee is a flat
per-cluster hourly charge regardless of size or topology, with a monthly credit
that covers one zonal or Autopilot cluster per billing account; a financially-
backed **99.95% SLA** applies to Autopilot and regional Standard control planes.
Node compute is billed separately in both modes.

## Autopilot versus Standard

| | Autopilot | Standard |
|---|---|---|
| Nodes | Google provisions, sizes, upgrades and repairs them; you never see a node pool | You define and own node pools, machine types and node OS |
| Node upgrades | Managed end to end by GKE | Auto-upgrade on by default, but you own the cadence and can defer |
| Security defaults | Hardened by default (no privileged pods, no host access, restricted-shaped) | You configure Pod Security, node hardening, etc. |
| Billing shape | Per **Pod resource request** (CPU/memory/storage you request) | Per **node** you run, whether or not pods fill it |
| Best for | Teams that want to think in pods, not machines | Teams needing GPUs, specific instance types, DaemonSets, or fine node control |

Autopilot is the closest any provider gets to "Kubernetes without node
operations": Google owns the entire node lifecycle and you pay for the resources
your pods actually request. The trade is control — Autopilot restricts host
access, some DaemonSets, and certain low-level features. Standard gives you the
full node surface and the full node responsibility.

## Networking: Dataplane V2

GKE's modern networking is **Dataplane V2**, an eBPF dataplane built on Cilium.
It is the default on Autopilot and the recommended plugin for all clusters. It
provides NetworkPolicy enforcement natively (no separate CNI add-on) and
integrated flow visibility. GKE also exposes an FQDN-based NetworkPolicy wrapper;
note that Autopilot exposes GKE's policy surface rather than raw Cilium
`CiliumNetworkPolicy`. For the handbook's default-deny approach, standard
`NetworkPolicy` objects work directly on Dataplane V2 — see
[network policy](../k8s-intermediate/network-policy.md).

## Identity: Workload Identity Federation for GKE

The recommended way for a pod to call Google Cloud APIs is **Workload Identity
Federation for GKE**: you bind a Kubernetes ServiceAccount to a Google Cloud
identity, and pods receive short-lived OIDC tokens with **no service-account key
files** on nodes or in pods. This is GKE's equivalent of EKS Pod Identity and
Entra Workload ID, and it is the default expectation for production — static
key files are an anti-pattern. See [service accounts and
tokens](../k8s-security/service-accounts-and-tokens.md).

## Upgrades and release channels

Google upgrades the control plane automatically over time regardless of channel;
what you choose is the **release channel**, which sets cadence and risk:

- **Rapid** — newest Kubernetes soonest, shortest soak.
- **Regular** — the balanced default.
- **Stable** — conservative, later adoption.
- **Extended** — a longer support runway for a version before you must move.

Node auto-upgrade keeps Standard node pools in step with the control plane by
default. Maintenance windows and exclusions let you constrain *when* disruptive
operations happen. On Autopilot, node upgrades are simply Google's problem.

## Nodes and autoscaling (Standard)

On Standard you get the cluster autoscaler for node pools and **node
auto-provisioning (NAP)**, which creates right-sized node pools from pending-pod
requirements — Google's answer to Karpenter. Combined with the horizontal pod
autoscaler, NAP lets a Standard cluster scale nodes to demand without you
pre-defining every machine shape. See [cluster autoscaler and
Karpenter](../k8s-advanced/cluster-autoscaler-and-karpenter.md).

## Storage, ingress and fleets

- **Storage.** The Persistent Disk CSI driver is the default block storage;
  Filestore CSI provides shared NFS.
- **Ingress / Gateway.** GKE integrates Cloud Load Balancing, and GKE is a
  **conformant Gateway API implementation** — the GKE Gateway controller is a
  first-class way to expose HTTP(S), which aligns with the handbook's
  Gateway-first stance.
- **GKE Enterprise.** The Enterprise edition adds multi-cluster fleet
  management, config sync and mesh, with a different pricing model from the
  per-cluster fee.
- **Observability.** Cloud Logging and Cloud Monitoring integrate out of the
  box; Managed Service for Prometheus provides a managed metrics backend.

## Common mistakes

- **Choosing Standard when you wanted Autopilot's hands-off nodes** (or the
  reverse — reaching for Autopilot when you need GPUs, privileged DaemonSets or
  specific machine types it restricts).
- **Reasoning about Autopilot cost per node.** Autopilot bills per pod request,
  so oversized requests waste money directly; right-size requests.
- **Shipping service-account key files** instead of Workload Identity Federation.
- **Assuming a release channel freezes your version.** Google still upgrades the
  control plane over time within the channel; plan for it.
- **Expecting raw Cilium policy on Autopilot** — you get GKE's NetworkPolicy
  surface, not the full `CiliumNetworkPolicy` CRD.

## Related topics

- [Managed Kubernetes compared](managed-kubernetes-compared.md)
- [Amazon EKS](eks.md)
- [Azure AKS](aks.md)
- [Network policy](../k8s-intermediate/network-policy.md)
- [Service accounts and tokens](../k8s-security/service-accounts-and-tokens.md)
- [Cluster autoscaler and Karpenter](../k8s-advanced/cluster-autoscaler-and-karpenter.md)
- [Cluster upgrades](../operations/cluster-upgrades.md)
