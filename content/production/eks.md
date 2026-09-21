---
title: Amazon EKS
description: What EKS manages and what it leaves you to own — VPC CNI and IP exhaustion, IRSA and Pod Identity, node groups versus Auto Mode, and the 26-month support window.
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

Amazon EKS runs the Kubernetes control plane for you across multiple
Availability Zones, with a financially-backed uptime SLA on the API endpoint and
managed, encrypted etcd. What makes EKS *EKS* — and what you must design around —
is that it is deeply wired into the VPC: pods get real VPC IP addresses,
identity flows through AWS IAM, and nodes are EC2 instances you can own at
several different levels of abstraction. This page covers the parts of EKS that
differ from a generic managed cluster.

Everything here is written against Kubernetes 1.37. EKS follows the upstream API
surface: GA features are available, new beta APIs are off by default.

## Version support and upgrades

EKS gives each minor version **14 months of standard support**, then **12 months
of extended support**, for **26 months total**. Extended support carries a
higher per-cluster-hour charge and is enabled by default; you can disable it,
but then the cluster is auto-upgraded at the end of standard support. At the end
of extended support the **control plane is auto-upgraded** whether you act or
not.

The critical operational fact: **managed node groups are not upgraded with the
control plane.** Upgrading the control plane to 1.37 leaves your nodes on their
old kubelet. You must roll the node groups yourself (or use Auto Mode, which
manages this). Kubernetes tolerates a kubelet up to three minors behind the API
server, but running there persistently is unsupported and unwise.

```bash
# See standard/extended support dates for available versions.
aws eks describe-cluster-versions
```

## Nodes: four models

EKS lets you own compute at four levels, from most to least effort:

- **Self-managed node groups** — you own the Auto Scaling Group, the AMI and the
  bootstrap. Maximum control, maximum toil.
- **Managed node groups** — AWS manages the ASG lifecycle and drains during
  updates, but you still trigger version upgrades.
- **Karpenter** — provisions right-sized EC2 instances directly from pending-pod
  requirements, no node groups. AWS created Karpenter; it is now the de-facto
  autoscaler on EKS.
- **EKS Auto Mode** — AWS runs Karpenter, the VPC CNI, kube-proxy, CoreDNS, the
  EBS CSI driver and the Pod Identity Agent as managed components, and provisions
  and upgrades nodes for you. This is the closest EKS gets to "hands-off nodes".

Fargate (serverless pods, no nodes to manage) also exists but is a different
compute model; Fargate pods must be restarted to pick up a control-plane upgrade.

## Networking: VPC CNI and the IP-exhaustion tax

By default EKS uses the **Amazon VPC CNI**, which assigns each pod a real IP
address from your VPC subnets via ENIs on the node. The upside is native VPC
routing, VPC flow logs that see pod traffic, and **security groups for pods**
(the `SecurityGroupPolicy` CRD, using trunk/branch ENIs) so a pod can be firewalled
at the AWS-resource level, not just by NetworkPolicy.

The downside is unique to EKS: **VPC IP exhaustion.** Every pod burns a VPC
address, and a node is capped by how many IPs its instance type's ENIs can hold.
At scale you run out of subnet addresses or hit per-node pod limits. The
standard mitigations:

- **Prefix delegation** — the CNI hands each ENI a /28 prefix instead of single
  IPs, roughly 16× the pod density per ENI slot. The simplest fix when subnets
  are sized but nodes cap out.
- **Custom networking** — pods draw from a *secondary* VPC CIDR via `ENIConfig`,
  freeing the primary subnet.
- **IPv6** — removes address scarcity entirely, at the cost of a dual-stack or
  IPv6 design.

Do not enable security groups for pods by default: the trunk-ENI overhead
reduces node pod capacity and needs instance-type planning. Use it where a pod
genuinely needs an AWS security-group boundary, and use NetworkPolicy for
east-west traffic.

## Identity: IRSA and EKS Pod Identity

EKS offers two ways to give a pod an AWS IAM role through its ServiceAccount:

- **IRSA (IAM Roles for Service Accounts)** — the original. Each cluster exposes
  an OIDC provider; you create an IAM role whose trust policy federates that
  provider and a specific ServiceAccount, then annotate the SA. Powerful, but
  the per-cluster OIDC-provider and trust-policy wiring is fiddly at fleet scale.
- **EKS Pod Identity** — the newer model. A managed Pod Identity Agent runs on
  the node, and you create *associations* between a ServiceAccount and an IAM
  role through an EKS API, with no per-cluster OIDC provider and reusable roles
  across clusters. This is the recommended path for new clusters.

Both deliver the same thing: short-lived, auditable AWS credentials with no
static keys in the pod. See [service accounts and
tokens](../k8s-security/service-accounts-and-tokens.md).

## Storage, add-ons and ingress

- **Storage.** The EBS CSI driver is the default block-storage class (and the
  default in Auto Mode); EFS CSI provides shared filesystems.
- **Add-ons.** VPC CNI, CoreDNS, kube-proxy, EBS CSI and the Pod Identity Agent
  are delivered as **EKS add-ons** — versioned artifacts EKS keeps patched,
  including for extended-support versions.
- **Ingress / Gateway.** The AWS Load Balancer Controller provisions ALBs and
  NLBs from Ingress and Service objects; AWS is a *partially* conformant Gateway
  API implementation. For the handbook's Gateway-first approach, run a
  conformant implementation (for example Envoy Gateway) on EKS nodes.
- **Observability.** CloudWatch Container Insights integrates logs and metrics;
  many teams still run Prometheus/Grafana on top.

## Common mistakes

- **Upgrading the control plane and forgetting the nodes.** Managed node groups
  do not follow the control plane; roll them, or adopt Auto Mode.
- **Designing the VPC without an IP-exhaustion plan.** Enable prefix delegation
  or custom networking *before* a scale-up fails to schedule.
- **Turning on security groups for pods cluster-wide.** It cuts node pod
  capacity; scope it to the workloads that need an AWS boundary.
- **Building new clusters on IRSA out of habit** when EKS Pod Identity removes
  the per-cluster OIDC toil.
- **Leaving extended support enabled and drifting for years** because the
  cluster keeps working — you are paying the surcharge and stockpiling upgrade
  risk.

## Related topics

- [Managed Kubernetes compared](managed-kubernetes-compared.md)
- [Google GKE](gke.md)
- [Azure AKS](aks.md)
- [Cluster autoscaler and Karpenter](../k8s-advanced/cluster-autoscaler-and-karpenter.md)
- [Network model and CNI](../k8s-intermediate/network-model-and-cni.md)
- [Service accounts and tokens](../k8s-security/service-accounts-and-tokens.md)
- [Cluster upgrades](../operations/cluster-upgrades.md)
