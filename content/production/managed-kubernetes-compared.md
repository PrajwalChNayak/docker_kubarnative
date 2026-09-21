---
title: Managed Kubernetes compared
description: What EKS, GKE and AKS actually manage for you and what they leave you to own, compared on responsibility rather than price.
level: advanced
type: reference
status: current
versions: Kubernetes 1.37
prerequisites:
  - operations/high-availability-control-plane
  - operations/cluster-upgrades
  - k8s-advanced/cluster-autoscaler-and-karpenter
---

## Overview

Every managed Kubernetes service sells the same core promise: the provider runs
the control plane — API server, scheduler, controller manager and etcd — so you
never SSH into a master again. That promise is real and it is the single biggest
reason to use a managed offering. But "managed" is a spectrum, and the
differences between EKS, GKE and AKS are almost entirely in the parts they *do
not* fully manage: nodes, networking, identity, add-ons and upgrades of the
things running on your nodes.

This page compares the three on **responsibility** — who owns what — because that
is what determines your day-2 workload and your blast radius during an incident.
It deliberately avoids price. Pricing changes constantly, differs by region and
commitment, and comparing three complex bills teaches you nothing durable.
Comparing *what each provider operates on your behalf* teaches you the shape of
the platform team you still need. The provider-specific pages
([EKS](eks.md), [GKE](gke.md), [AKS](aks.md)) go deeper on each.

:::note The shared-responsibility line
On all three, the provider owns the control plane's availability and etcd. You
own everything inside your workloads: RBAC, Pod Security, NetworkPolicy,
resource requests, probes, image supply chain, and application data. A managed
control plane removes about a third of the [readiness
checklist](production-readiness-checklist.md); it removes none of the rest.
:::

## Control plane and SLA

| | EKS | GKE | AKS |
|---|---|---|---|
| Control plane managed | Yes | Yes | Yes |
| etcd managed (backup, HA) | Yes | Yes | Yes |
| Cost model shape | Per-cluster hourly fee; surcharge for extended-support versions | Flat per-cluster hourly management fee; credit covers one zonal/Autopilot cluster per billing account | Free tier (no SLA) or Standard/Premium tier per cluster; nodes billed separately on all |
| Financially-backed API SLA | Yes (uptime SLA on the API endpoint) | 99.95% for Autopilot and regional Standard control planes | 99.95% with availability zones, 99.9% without, on Standard/Premium; Free tier is best-effort |
| Multi-zone control plane | Yes (managed) | Regional control plane spans zones | Auto-distributed across zones on Standard+ where the region has them |

The takeaway: all three give you an HA control plane you cannot see or break.
GKE and AKS publish exact SLA percentages; AKS is the only one where the cheapest
tier has *no* financially-backed SLA, which makes tier selection a production
decision, not a billing footnote.

## Upgrades: who moves, and when

| | EKS | GKE | AKS |
|---|---|---|---|
| Control-plane upgrade | You trigger (or auto at end of support); AWS performs | Google performs automatically; release channels control cadence | You trigger; Microsoft performs |
| Node upgrade | **You** (managed node groups are not auto-upgraded with the control plane) | Auto node upgrade on by default (Standard); fully managed on Autopilot | You trigger node-image/version upgrades; auto-upgrade channels available |
| Version support window | 14 months standard + 12 months extended = 26 months per minor | ~14 months standard; longer on the Extended release channel | 12 months community (N, N-1, N-2); +12 months LTS on Premium |
| Skew you must respect | kubelet ≤ 3 minors behind API server (all three) | same | Control plane may lead node pools by up to 3 minors (since 1.28) |

This row is where teams get hurt. On EKS in particular, upgrading the control
plane does **not** upgrade your managed-node-group nodes — you must roll them
yourself, and a control plane three minors ahead of its kubelets is out of skew.
GKE Autopilot is the only option here that upgrades nodes for you end to end.

## Nodes and autoscaling

| | EKS | GKE | AKS |
|---|---|---|---|
| Fully-managed nodes option | EKS Auto Mode (AWS-run Karpenter + core add-ons) | Autopilot (Google owns nodes entirely) | AKS Automatic (production default; managed node experience) |
| Self-managed nodes | Managed node groups, self-managed groups, Fargate | Standard node pools | Node pools (System/User) |
| Node autoprovisioning | Karpenter (or Auto Mode) | Node auto-provisioning (NAP) | Node Autoprovisioning, powered by Karpenter (Azure provider) |
| Classic cluster autoscaler | Yes | Yes | Yes |

All three have converged on the same idea: a controller that provisions
right-sized nodes directly from pending-pod requirements, instead of scaling
fixed node groups. Karpenter (which AWS created) now underpins EKS Auto Mode and
AKS Node Autoprovisioning; GKE's NAP is Google's equivalent. See
[cluster autoscaler and Karpenter](../k8s-advanced/cluster-autoscaler-and-karpenter.md).

## Networking

| | EKS | GKE | AKS |
|---|---|---|---|
| Default CNI | Amazon VPC CNI (pods get real VPC IPs) | GKE Dataplane V2 (eBPF, Cilium-based) | Azure CNI Overlay (pods get overlay IPs) |
| Headline risk | **VPC IP exhaustion** — every pod consumes a VPC address | Fewer IP surprises; Dataplane V2 default on Autopilot | Overlay conserves VNet IPs; legacy kubenet is being retired |
| NetworkPolicy enforcement | Via CNI/add-on | Dataplane V2 (built in) | Azure CNI Overlay powered by Cilium |
| Pod-to-AWS/-cloud firewalling | Security groups for pods (`SecurityGroupPolicy`) | — | — |

EKS's model — real VPC IPs per pod — gives you native VPC routing and security
groups per pod, at the cost of IP-address planning that no other provider forces
on you. GKE and AKS default to overlay/eBPF dataplanes that sidestep that.

## Identity (pod → cloud IAM)

| | EKS | GKE | AKS |
|---|---|---|---|
| Mechanism | IRSA (IAM Roles for Service Accounts, per-cluster OIDC) and the newer **EKS Pod Identity** (agent + association API, no per-cluster OIDC setup) | **Workload Identity Federation for GKE** (KSA → GCP SA, short-lived OIDC tokens, no key files) | **Microsoft Entra Workload ID** (federated credentials on an Entra app/managed identity) |

The pattern is identical everywhere: a Kubernetes ServiceAccount is federated to
a cloud identity so pods get short-lived, auditable cloud credentials with no
long-lived keys on disk. The wiring differs; the principle does not. Never mount
static cloud keys into a pod when the platform offers this.

## Add-ons, storage and ingress

| | EKS | GKE | AKS |
|---|---|---|---|
| Default storage CSI | EBS CSI (+ EFS CSI) | Persistent Disk CSI (+ Filestore) | Azure Disk / File / Blob CSI |
| Managed add-ons | EKS add-ons (VPC CNI, CoreDNS, kube-proxy, EBS CSI, Pod Identity Agent) | Bundled and version-managed by GKE | AKS-managed add-ons (versioned with the cluster) |
| LB / ingress integration | AWS Load Balancer Controller (ALB/NLB); Gateway API partially conformant | Cloud Load Balancing; GKE is a conformant Gateway API implementation | Azure Load Balancer; Application Gateway for Containers; app-routing add-on |
| Logging/monitoring integration | CloudWatch Container Insights | Cloud Logging / Cloud Monitoring | Azure Monitor / Managed Prometheus |

## How to choose

Choose on the axis that will hurt you most, not the feature matrix:

- **Least operational effort** → GKE Autopilot or AKS Automatic or EKS Auto
  Mode: let the provider own nodes, add-ons and (on Autopilot) node upgrades.
- **Deep VPC/network integration and per-pod security groups** → EKS, accepting
  the IP-planning tax.
- **You already live in one cloud** → the same-cloud service almost always wins
  on identity, load balancing and support, because those integrations are the
  hard part and they are pre-wired.
- **Longest version runway** → EKS extended support (26 months) or AKS Premium
  LTS (24 months) if you cannot upgrade on the community cadence.

## Common mistakes

- **Assuming "managed" means "managed nodes".** On EKS and AKS, node upgrades,
  OS patching and node-group lifecycle are yours unless you opt into the
  fully-managed compute tier. Only GKE Autopilot manages nodes end to end.
- **Letting the control plane outrun the kubelets.** A managed control-plane
  upgrade does not touch your nodes; drifting past a 3-minor skew is unsupported.
- **Mounting static cloud keys in pods** instead of using IRSA / Pod Identity /
  Workload Identity Federation / Entra Workload ID.
- **Ignoring VPC IP exhaustion on EKS** until a scale-up fails to schedule pods.
- **Picking the AKS Free tier for production**, then discovering there is no
  financially-backed API SLA.
- **Comparing on sticker price.** Node compute and cross-AZ traffic dwarf the
  control-plane fee; see [the cost of Kubernetes](cost-of-kubernetes.md).

## Related topics

- [Amazon EKS](eks.md)
- [Google GKE](gke.md)
- [Azure AKS](aks.md)
- [Self-managed with kubeadm](kubeadm.md)
- [The cost of Kubernetes](cost-of-kubernetes.md)
- [Production-readiness checklist](production-readiness-checklist.md)
- [Cluster autoscaler and Karpenter](../k8s-advanced/cluster-autoscaler-and-karpenter.md)
- [High-availability control plane](../operations/high-availability-control-plane.md)
