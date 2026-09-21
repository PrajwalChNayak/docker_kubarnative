---
title: Production labs
description: Design and decision exercises for taking Tasklane to production — provider selection, responsibility mapping, readiness gating, cost reasoning and self-managed design.
level: expert
type: lab
status: current
versions: Kubernetes 1.37
prerequisites:
  - production/production-readiness-checklist
  - production/tasklane-in-production
  - production/when-not-to-use-kubernetes
---

## Overview

Part K is mostly judgement, so these labs are mostly **design and decision
exercises**, not cluster commands — you are not meant to `helm install` anything
here, and as a writing environment this repo cannot talk to a managed cloud
anyway. Work each exercise before reading its solution. There is often more than
one defensible answer; the solution explains the reasoning a reviewer would
expect, not the only possible choice.

## Setup

No cluster changes are required. You need:

- The [readiness checklist](production-readiness-checklist.md) open.
- The three provider pages ([EKS](eks.md), [GKE](gke.md), [AKS](aks.md)) and the
  [comparison](managed-kubernetes-compared.md) to hand.
- The example artifacts under
  [`examples/production/`](../../examples/production/README.md) for the kubeadm
  and k3s references.

If you want to check a manifest you write, the local validator is allowed:

```bash
.tools/kubeconform.exe -strict -summary -kubernetes-version 1.37.0 your-file.yaml
```

## Exercises

### 1. Map the responsibility line

For each of these, state who owns it on a managed cluster (provider or you), and
whether that changes on kubeadm: (a) etcd backups, (b) node OS patching, (c)
NetworkPolicy, (d) API-server SLA, (e) certificate rotation, (f) pod resource
requests.

### 2. Choose a provider

A team runs 40 microservices across 4 squads. They are already all-in on one
cloud, need GPUs for two services, want the least node operations they can get
without giving up specific instance types, and cannot always upgrade on the
community cadence. Which managed option and mode would you shortlist, and what is
the one fact that would flip your choice?

### 3. Gate a deployment

You inherit a Tasklane cluster where: images use `:latest`, there is no
NetworkPolicy, the API has one replica and no PDB, Secrets are applied from a
plaintext file, and backups "exist but have never been restored." Rank these
five findings by production risk and give the checklist item each violates.

### 4. Find the real cost

A stakeholder says "Kubernetes will cut our bill — the control plane is cheap."
List four cost drivers that dwarf the control-plane fee, and name the one that is
usually the single biggest source of *waste* (as opposed to necessary spend).

### 5. Should this even be Kubernetes?

A two-person team runs three stateless HTTP services and one managed database, at
steady modest traffic, in one cloud, with no platform engineer. Make the case
for *not* using Kubernetes, and name what would have to change for the answer to
flip.

### 6. Design a self-managed control plane

You must run on-prem, air-gapped, at a size too large for single-node k3s.
Sketch the control-plane topology (control-plane count, etcd, load balancer) and
list the three day-2 responsibilities most likely to bite a team new to
self-managing.

### 7. Write a PodDisruptionBudget

Write a PDB for `tasklane-api` (2 replicas, label
`app.kubernetes.io/name: tasklane-api`, namespace `tasklane`) that keeps at least
one pod up during voluntary disruptions. Validate it with kubeconform.

## Solutions

### 1. Responsibility line

| Item | Managed (EKS/GKE/AKS) | kubeadm |
|---|---|---|
| (a) etcd backups | Provider | **You** |
| (b) node OS patching | You (except GKE Autopilot / fully-managed tiers) | You |
| (c) NetworkPolicy | You (always) | You |
| (d) API-server SLA | Provider (note AKS Free has none) | You (there is no SLA — you *are* the SLA) |
| (e) certificate rotation | Provider for the control plane | You |
| (f) pod resource requests | You (always) | You |

The lesson: a managed control plane moves (a), (d) and (e) off your plate;
(c) and (f) — the application-security and right-sizing work — are yours on every
platform.

### 2. Provider choice

Shortlist the **same cloud they already use** — the identity, load-balancer and
support integrations are the hard part and come pre-wired. For "least node
operations without losing instance-type control," lean toward a **Standard
cluster with node auto-provisioning** (Karpenter/NAP) rather than a fully-managed
pod-only tier, because they need GPUs and specific instance types that Autopilot-
style modes restrict. The fact that would flip the choice: if they did **not**
need specific instance types/GPUs, the fully-managed pod tier (Autopilot / Auto
Mode / AKS Automatic) would be the lower-toil answer. The "cannot always upgrade
on cadence" constraint points at EKS extended support or AKS Premium LTS.

### 3. Deployment gate (ranked by risk)

1. **Secrets from a plaintext file** — credential exposure; violates the
   secrets-management gate. Highest blast radius.
2. **No NetworkPolicy** — a compromised pod moves laterally unimpeded; violates
   default-deny segmentation.
3. **One replica, no PDB** — any drain, node failure or upgrade is a full
   outage; violates the PDB and replica gates.
4. **`:latest` images** — non-reproducible, unpinned, unverifiable supply chain;
   violates digest-pinning/signing.
5. **Untested backups** — a restore may fail when you need it; violates the
   tested-restore gate. Ranked last only because it bites during a *second*
   incident, not the first.

Reasonable people may swap 1 and 2; both are severe.

### 4. Real cost

Four that dwarf the control-plane fee: **node compute** (and the system/reserved
overhead you cannot use), **observability storage** (metrics cardinality + log
retention), **load balancers** (per-service sprawl), and **cross-AZ / egress
traffic**. Plus the off-invoice **platform-team headcount**. The single biggest
*waste* is usually **over-requested pods**: the scheduler packs by requests, so
oversized requests strand capacity while nodes sit near-idle by actual usage.

### 5. Not Kubernetes

With no platform engineer, three stateless services and a managed database at
modest steady traffic in one cloud, a **serverless container platform** (Cloud
Run / Container Apps / Fargate) or even **a VM with Compose** runs this with a
fraction of the operational surface — no cluster, add-ons, upgrades or skew to
manage. Kubernetes's platform tax does not shrink for three services. It would
flip if they grew to many services across multiple teams, needed real autoscaling
across a node fleet, moved on-prem/edge, or hired a platform capability.

### 6. Self-managed design

Topology: **3 (or 5) control-plane nodes** across failure domains, **stacked
etcd** co-located on them (odd count for quorum), behind a **load balancer** that
`--control-plane-endpoint` points at; a **policy-capable CNI** (Calico/Cilium).
The three day-2 responsibilities most likely to bite: **etcd backups with a
rehearsed restore**, **certificate expiry** (kubeadm certs default to one year),
and **upgrades under the version-skew policy** (control plane before kubelets,
one minor at a time). See [`examples/production/kubeadm/README.md`](../../examples/production/kubeadm/README.md).

### 7. PodDisruptionBudget

```yaml title="examples/production/tasklane-api-pdb.yaml"
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: tasklane-api
  namespace: tasklane
  labels:
    app.kubernetes.io/name: tasklane-api
    app.kubernetes.io/part-of: tasklane
spec:
  # With 2 replicas, minAvailable: 1 lets exactly one pod be evicted at a time
  # during a drain, never both — so a node upgrade cannot zero the API.
  minAvailable: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: tasklane-api
```

```bash
.tools/kubeconform.exe -strict -summary -kubernetes-version 1.37.0 \
  examples/production/tasklane-api-pdb.yaml
```

`minAvailable: 1` with 2 replicas is the right expression of "keep at least one
up." `maxUnavailable: 1` would also allow one eviction now, but if the deployment
later scaled down or a pod were already unhealthy, `minAvailable` states the
guarantee you actually want.

## Common mistakes

- **Reaching for cluster commands** on decision exercises — the skill being
  tested is judgement, not `kubectl`.
- **Choosing a provider on the feature matrix** instead of the axis that will
  hurt most (same-cloud integration, node operations, upgrade cadence).
- **Ranking findings by how easy they are to fix** rather than by blast radius.
- **Defending Kubernetes for a three-service team** because it is the industry
  default.
- **Writing a PDB with `maxUnavailable: 0`** on a 2-replica Deployment, which can
  block every voluntary eviction and stall node drains.

## Related topics

- [Production-readiness checklist](production-readiness-checklist.md)
- [Tasklane in production](tasklane-in-production.md)
- [When not to use Kubernetes](when-not-to-use-kubernetes.md)
- [The cost of Kubernetes](cost-of-kubernetes.md)
- [Self-managed with kubeadm](kubeadm.md)
