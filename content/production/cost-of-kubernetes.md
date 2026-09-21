---
title: The cost of Kubernetes
description: Where the money and effort actually go when you run Kubernetes — control plane, node overhead, the platform team, day-2 burden and the hidden line items.
level: expert
type: reference
status: current
versions: Kubernetes 1.37
prerequisites:
  - production/managed-kubernetes-compared
  - operations/cost-visibility
---

## Overview

Kubernetes is often justified as a cost saver — better bin-packing, higher
utilisation, no per-VM waste. Sometimes that is true. But the cluster bill is
the smallest and most visible part of the real cost, and teams that budget only
for it are consistently surprised. This page maps where the money and the effort
actually go, so you can weigh Kubernetes honestly against the
[alternatives](alternatives.md) and against [not using it at
all](when-not-to-use-kubernetes.md).

No specific prices appear here — they change monthly and differ by region and
commitment. What is durable is the *shape* of the cost and, more importantly, the
effort that never appears on any invoice.

## The control plane is the cheapest part

On a managed service the control plane is a modest per-cluster fee (GKE and EKS)
or a tier charge (AKS), and on GKE a credit can cover one small cluster. It is
real, and running many small clusters multiplies it — a reason to consolidate
where multi-tenancy allows. But for any cluster doing real work, the control-
plane fee is rounding error next to the nodes. Optimising it first is optimising
the wrong number.

## Node overhead: you do not get the whole node

The visible node cost is the instance. The hidden node cost is how much of each
node you *cannot* use for your workloads:

- **System overhead.** The kubelet, container runtime, CNI agent, kube-proxy,
  CSI drivers, log and metrics agents and the provider's managed add-ons all
  consume CPU and memory on every node — often 10–20% before your first pod.
- **Reserved allocatable.** The kubelet reserves capacity for the system and for
  eviction thresholds, so a node's *allocatable* is meaningfully less than its
  capacity.
- **Requests, not usage, are what you pay for utilisation on.** The scheduler
  packs by **requests**. Over-requested pods strand capacity: a node can be
  "full" by requests while sitting near-idle by actual usage. This gap is the
  single biggest source of wasted spend on most clusters, and the reason
  right-sizing requests (VPA recommendations, historical data) pays off directly.
- **Fragmentation headroom.** To survive a node or zone failure and to schedule
  the next pod without waiting for a node to boot, you keep spare capacity. That
  headroom is real cost that bin-packing tools cannot remove — it is insurance.

## The platform-team reality

This is the cost that never appears on a cloud bill and dominates the total cost
of ownership. Kubernetes is a platform, and a platform needs a team:

- **Someone owns upgrades** — three minor releases a year, each about 14 months
  of support, across the control plane, nodes and every add-on, under a skew
  policy.
- **Someone owns the add-on sprawl** — ingress/Gateway, cert-manager, the CNI,
  CSI drivers, autoscalers, the observability stack, policy engines, secret
  managers. Each has its own release cadence, CVEs and breaking changes.
- **Someone is on call** for the cluster itself, not just the apps.
- **Someone builds the paved road** — the Helm/Kustomize base, the CI templates,
  the RBAC and policy defaults — so application teams do not each reinvent them.

A rough, honest heuristic: a production Kubernetes platform is not a part-time
responsibility. If you cannot staff people whose job is the platform, a managed
container service that hides Kubernetes ([alternatives](alternatives.md)) will
almost certainly cost less in total, even if its sticker price is higher.

## Day-2 operational burden

Beyond headcount, the ongoing operational load is a cost in time and risk:

- Upgrades and version-skew management.
- Certificate and secret rotation.
- Capacity planning and autoscaler tuning.
- Incident response for a system with many moving parts and emergent behaviour.
- Keeping the security posture current: image patching, policy, CVE response.

Managed control planes remove the control-plane slice of this. They remove none
of the workload slice.

## Hidden line items

The costs that ambush teams because they are not the node bill:

- **Observability storage.** Metrics cardinality, log volume and trace retention
  can rival or exceed compute cost. A high-cardinality Prometheus or an
  unbounded log pipeline is a budget hole. Set retention deliberately.
- **Load balancers.** Every `Service type=LoadBalancer` and many Ingress/Gateway
  setups provision a cloud load balancer with its own hourly and per-rule cost.
  Sprawl here is easy and quietly expensive; share where you can.
- **Cross-AZ and egress traffic.** Spreading pods across zones for availability
  means chatty services cross AZ boundaries, and inter-AZ traffic is billed.
  Egress to the internet and to other regions is billed again. A microservice
  mesh that ignores topology can generate surprising traffic charges.
- **Idle capacity.** The headroom you keep for failover and burst is unused most
  of the time by design. Right-sizing reduces it; eliminating it removes your
  safety margin.
- **NAT gateways, private endpoints, data transfer for backups** — the plumbing
  around the cluster, not the cluster.

See [cost visibility](../operations/cost-visibility.md) for attributing these
back to teams.

## When the economics work — and when they don't

Kubernetes earns its cost when you have **enough scale and enough services** that
consolidation, self-healing, autoscaling and a shared paved road save more than
the platform costs. It loses when a small team runs a handful of services at low
scale: the platform overhead and the day-2 burden dwarf any bin-packing savings,
and the money would be better spent on a managed platform or plain VMs. That
break-even is the subject of [when not to use
Kubernetes](when-not-to-use-kubernetes.md).

## Common mistakes

- **Budgeting for the control-plane fee** and ignoring nodes, the platform team
  and the hidden line items.
- **Reporting utilisation by requests** and never comparing to actual usage,
  hiding the over-request waste that dominates most bills.
- **Letting observability retention grow unbounded** until the monitoring bill
  rivals compute.
- **One load balancer per service** instead of sharing ingress/Gateway.
- **Ignoring topology** so cross-AZ chatter racks up transfer charges.
- **Counting the platform team as free** because their time is not on the cloud
  invoice.

## Related topics

- [Managed Kubernetes compared](managed-kubernetes-compared.md)
- [When not to use Kubernetes](when-not-to-use-kubernetes.md)
- [Alternatives to Kubernetes](alternatives.md)
- [Cost visibility](../operations/cost-visibility.md)
- [Capacity planning](../operations/capacity-planning.md)
