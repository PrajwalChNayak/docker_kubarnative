---
title: Multi-cluster and multi-region
description: When to run many clusters, fleet management, Cluster API, service mesh federation, and data locality.
level: expert
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - operations/high-availability-control-plane
  - k8s-advanced/gitops-argo-cd
---

## Overview

One big cluster is simpler than many small ones — until it isn't. Regulatory
boundaries, blast-radius limits, region latency and per-team isolation eventually
push teams to **multiple clusters**. That trades one cluster's complexity for
the harder problem of managing a **fleet**: provisioning clusters consistently,
deploying across them, connecting services between them, and keeping data where
it belongs. This page surveys the why and the main tools.

## Why it exists and when to use it

Reach for multiple clusters when a single cluster genuinely cannot serve the
need:

- **Blast radius** — a bad upgrade or misconfiguration should not take down
  every environment. Separate prod from non-prod, and often region from region.
- **Geography/latency** — users and data in different regions want a cluster
  near them; one stretched cluster suffers etcd write latency (see
  [HA control plane](high-availability-control-plane.md)).
- **Compliance/data residency** — data that must stay in a jurisdiction lives in
  a cluster there.
- **Hard multi-tenancy** — when namespaces and policy are not enough isolation,
  a cluster per tenant is the strong boundary.

Do **not** split into many clusters just to feel modern. Every cluster is
another control plane to patch, monitor, secure and pay for. Prefer namespaces
and policy within one cluster until a real driver above forces a split. See
[multi-tenancy](../k8s-advanced/multi-tenancy.md).

## How it works underneath

Multi-cluster breaks into four problems, each with its own tooling:

**1. Provisioning — make clusters identically.** Clusters must be reproducible,
not hand-built snowflakes. **Cluster API (CAPI)** models clusters *themselves* as
Kubernetes resources (`Cluster`, `MachineDeployment`, etc.) on a **management
cluster**, which reconciles real clusters on a provider (AWS, Azure, vSphere…).
Infrastructure-as-code (Terraform/OpenTofu) is the alternative for the
underlying infra. The goal is the same: a new cluster is a config change, not a
runbook.

**2. Fleet deployment — ship apps to many clusters.** GitOps scales to fleets:
**Argo CD** (ApplicationSets) and **Flux** template one app across many clusters
from Git, with per-cluster overrides. One commit rolls a change across the fleet;
drift is corrected continuously. See
[GitOps with Argo CD](../k8s-advanced/gitops-argo-cd.md).

**3. Connectivity — let services talk across clusters.** A **service mesh**
(Istio, Linkerd, Cilium Cluster Mesh) can federate identity and routing across
clusters so a service in cluster A calls one in cluster B with mTLS and
failover. This is powerful and heavy; adopt it when cross-cluster service calls
are a real requirement, not by default.

**4. Data locality — keep data where it must be.** Compute is easy to replicate;
**data is not**. Latency, consistency and residency rules mean you usually pin
data to a region and route users to it, rather than trying to make one database
span regions synchronously. Design around "which cluster owns this data" first;
the compute follows.

## Basic example

A common fleet shape: a management cluster running Cluster API and Argo CD,
governing regional workload clusters, each HA within its region:

```text title="fleet topology (conceptual)" fragment
        ┌──────────── management cluster ────────────┐
        │  Cluster API (provisions clusters)          │
        │  Argo CD ApplicationSet (deploys to all)    │
        └───────┬───────────────┬───────────────┬─────┘
                │               │               │
          us-east cluster  eu-west cluster  ap-south cluster
          (HA, data local) (HA, data local) (HA, data local)
```

## Explanation

The management cluster is a control point, not a runtime for user workloads: it
provisions and deploys, and its own loss must not take down the workload
clusters (they keep running independently). GitOps makes the fleet **declarative
and auditable** — the desired state of every cluster is in Git, so a new region
is a directory and a new app is a commit. The mesh and data-locality choices are
where most of the genuine difficulty lives.

## Common patterns

- **Management cluster + CAPI + GitOps** as the fleet backbone.
- **Argo CD ApplicationSets / Flux** to fan one config out with per-cluster
  values.
- **Cluster mesh** only where cross-cluster calls are needed; otherwise keep
  clusters independent and route at the edge (global load balancer / DNS).
- **Region-pinned data with global routing** — send users to the region that
  owns their data.
- **Centralised observability** — remote-write metrics and ship logs/traces to a
  central store so you can see the whole fleet at once (see
  [Prometheus](prometheus-and-kube-prometheus.md)).

## Production considerations

- **Consistency is the hard part.** Config, policy, versions and RBAC must be
  uniform across the fleet or you get subtle per-cluster bugs. GitOps + policy
  engines enforce it.
- **Every cluster multiplies ops cost** — patching, cert rotation, upgrades,
  monitoring, and control-plane spend, per cluster. Weigh it honestly.
- **Version skew across the fleet.** Clusters drift to different minors; keep a
  supported spread and a rollout order (canary cluster first).
- **Cross-cluster networking** (mesh, VPNs, peering) adds latency and failure
  modes; test failover explicitly.
- **Central observability and backup** so a fleet is operable and recoverable as
  a whole, not cluster by cluster.

## Security considerations

- The **management cluster is crown-jewel**: it can create and reconfigure every
  workload cluster. Compromise there is fleet-wide. Isolate and lock it down.
- **Cross-cluster identity.** A mesh federates trust between clusters — a
  misissued identity crosses cluster boundaries. Manage the mesh CA and trust
  domains carefully.
- **Data residency is a security/compliance control**, not just performance;
  routing data to the wrong region can be a legal breach.
- **Uniform policy.** A single cluster with weaker RBAC/PSA/NetworkPolicy is the
  fleet's soft spot; enforce policy centrally.

## Troubleshooting

- **Config drift between clusters:** something bypassed GitOps; make Git the only
  writer and let the controller correct drift.
- **Cross-cluster calls failing:** mesh trust/routing misconfigured, or network
  peering down; verify mesh identity and connectivity before app logic.
- **A new cluster behaves differently:** its provisioning diverged (different
  CAPI template or manual tweak); reconcile it to the fleet standard.
- **Central monitoring gaps:** a cluster's remote-write/agent is down; you are
  flying blind on that cluster.

## Common mistakes

- Splitting into many clusters without a real driver, multiplying cost and ops
  for no benefit.
- Hand-building clusters so each is a snowflake; use CAPI/IaC + GitOps.
- Adopting a heavy service mesh before cross-cluster calls are actually needed.
- Trying to stretch one database (or one etcd) synchronously across regions.
- Under-protecting the management cluster, the highest-value target in the fleet.

## Related topics

- [High availability control plane](high-availability-control-plane.md)
- [Multi-tenancy](../k8s-advanced/multi-tenancy.md)
- [GitOps with Argo CD](../k8s-advanced/gitops-argo-cd.md)
- [Cost visibility](cost-visibility.md)
- [Prometheus and kube-prometheus](prometheus-and-kube-prometheus.md)
