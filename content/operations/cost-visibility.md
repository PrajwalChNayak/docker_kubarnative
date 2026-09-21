---
title: Cost visibility
description: Requests vs usage, OpenCost and Kubecost, bin-packing, idle cost, and showback across teams.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - operations/prometheus-and-kube-prometheus
  - operations/capacity-planning
---

## Overview

A Kubernetes bill is opaque: you pay for nodes, but you run pods, and nothing in
a cloud invoice says which team's workload cost what. **Cost visibility** closes
that gap by attributing node cost down to namespaces, workloads and teams. This
page covers the core idea (you pay for **requests**, not **usage**), the
open-source tooling (**OpenCost**, and **Kubecost** built on it), and the
practices that turn numbers into savings: bin-packing, killing idle cost, and
**showback**.

## Why it exists and when to use it

Cloud spend on Kubernetes drifts upward silently because the people who create
workloads rarely see the cost. Cost visibility makes the invisible visible:
each team sees what it consumes, which is the precondition for anyone to
optimise. Without it, "reduce cloud cost" has no owner and no target.

Use it once a cluster hosts more than one team or a non-trivial bill. For a
single small app it is overkill — right-size the requests and move on.

## How it works underneath

**You pay for the node; you schedule by requests.** The scheduler places pods
using their CPU/memory **requests**, and it will not overcommit requested CPU/
memory beyond a node's allocatable. So a node fills up based on *requested*
resources, and you pay for the node whether or not the pods *use* what they
requested. This is the central fact of Kubernetes cost:

> Cost is driven by **requests**, waste is the gap between **requests and
> actual usage**, and **idle** is the gap between requests and node capacity.

**Attribution.** A cost tool joins three data sources:

1. **Resource allocation over time** — each pod's requests × the time it ran,
   from the Kubernetes API and Prometheus (`kube_pod_container_resource_requests`
   from kube-state-metrics, plus real usage from metrics like container CPU).
2. **Node prices** — on-demand/spot/reserved rates per node type, from a cloud
   billing API or a static price list.
3. **Labels** — namespace, `app.kubernetes.io/*`, team labels, to roll costs up
   to owners.

**OpenCost** is the CNCF specification and reference implementation of this
model; **Kubecost** is a commercial product built on OpenCost with a richer UI
and features. Both compute per-namespace/per-workload cost from allocation ×
price.

## Basic example

The raw signals are already in the cluster. Node allocatable capacity is what
you pay for:

```console include="captures/operations/ops-node-capacity.txt"
```

And the gap you are chasing is requests vs what nodes can allocate:

```console include="captures/operations/ops-requests-vs-alloc.txt"
```

A cost tool multiplies each workload's requested resources over time by the node
price and groups by label. Conceptually, per workload:

```text title="cost model (conceptual)" fragment
workload_cost = Σ over time( cpu_request × cpu_price + mem_request × mem_price )
idle_cost     = node_cost − Σ workload_cost   # capacity nobody requested
```

## Explanation

Two gaps drive every optimisation. The **request-vs-usage** gap is
*application* waste: a pod that requests 1 CPU and uses 100m is paying 10× for
scheduling headroom it does not need. Right-sizing requests (guided by the
Vertical Pod Autoscaler's recommendations and Prometheus history) recovers it.
The **request-vs-capacity** gap is *bin-packing* waste: nodes that are half
empty because pods do not tessellate. Better bin-packing, node right-sizing, and
autoscaling recover that.

Because cost tracks requests, the fastest way to cut a Kubernetes bill is almost
always to lower over-generous requests — not to add autoscalers on top of
bloated pods.

## Common patterns

- **Right-size requests from data.** Use VPA recommendations and Prometheus
  percentiles to set requests near real usage plus headroom, not guesses.
- **Bin-pack better.** Fewer, appropriately sized node types; let the
  scheduler pack them; use Cluster Autoscaler / Karpenter to remove empty nodes.
- **Spot / preemptible** for fault-tolerant workloads (like Tasklane workers),
  on-demand for the API. Big savings for interruptible work.
- **Showback, then chargeback.** Start with **showback** — show each team its
  cost, no billing — to drive behaviour. Move to **chargeback** (actually
  billing teams) only once the numbers are trusted.
- **Idle-cost alerts.** Alert when cluster idle (capacity − requests) exceeds a
  threshold; it usually means over-provisioned nodes or a stuck autoscaler.

## Production considerations

- **Labels are the foundation.** Cost attribution is only as good as your
  labelling discipline; enforce owner/team labels via policy so nothing lands in
  an "unallocated" bucket.
- **Spot volatility.** Spot pricing and interruptions complicate both cost and
  reliability; model them, and keep critical workloads off pure spot.
- **Shared costs** (control plane, monitoring, networking, the cost tool itself)
  must be allocated by a fair rule, or one team subsidises everyone.
- **Autoscaler interplay.** Cost, HPA, VPA and Cluster Autoscaler interact:
  right-sizing requests changes bin-packing changes node count. Optimise
  requests first, then let autoscalers converge.

## Security considerations

- Cost data reveals workload scale, tenancy and growth — commercially sensitive.
  Restrict who sees cluster-wide cost, and scope per-team views to that team.
- Cost tools read the full object graph and Prometheus; their ServiceAccount is
  a broad-read credential. Treat it like other cluster-wide readers.
- Cloud billing API credentials the tool uses must be least-privilege and
  stored in Secrets.

## Troubleshooting

- **Large "unallocated" cost:** workloads lack owner labels, or shared costs are
  not being spread; fix labelling and the allocation rule.
- **Costs look too low/high:** the price list is wrong (spot vs on-demand,
  reserved discounts not modelled). Reconcile against the actual invoice.
- **Idle cost high:** nodes over-provisioned or the Cluster Autoscaler is not
  scaling down (PodDisruptionBudgets or non-evictable pods blocking it).
- **Numbers disputed by teams:** usually a labelling or shared-cost
  disagreement; make the allocation rule explicit before chargeback.

## Common mistakes

- Optimising usage (adding autoscalers) while ignoring bloated **requests**,
  which is what you actually pay for.
- No owner labels, so most cost is "unallocated" and nobody acts.
- Jumping to chargeback before the numbers are trusted, breeding disputes.
- Putting everything on spot and taking reliability hits, or nothing on spot and
  overpaying for interruptible work.
- Ignoring idle (request-vs-capacity) cost because dashboards only show usage.

## Related topics

- [Capacity planning](capacity-planning.md)
- [Prometheus and kube-prometheus](prometheus-and-kube-prometheus.md)
- [Vertical Pod Autoscaler](../k8s-advanced/vertical-pod-autoscaler.md)
- [Cluster Autoscaler and Karpenter](../k8s-advanced/cluster-autoscaler-and-karpenter.md)
