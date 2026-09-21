---
title: High availability control plane
description: Stacked vs external etcd, odd-numbered quorum, multi-AZ placement, and load-balanced API servers.
level: expert
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/architecture
  - operations/etcd-backup-and-restore
---

## Overview

A single control-plane node is a single point of failure: lose it and you cannot
schedule, scale or heal anything (running pods keep running, but nothing
reconciles). A **highly available control plane** runs multiple API servers and
an odd-numbered etcd cluster across failure domains, behind a load balancer, so
one node — or one availability zone — can fail without taking the control plane
down. This page covers the two etcd topologies, quorum math, multi-AZ placement,
and API-server load balancing.

## Why it exists and when to use it

The control plane is the brain; the data plane (your pods) can survive its brief
absence, but you lose self-healing, autoscaling, deploys and any operation that
needs the API. For anything beyond a lab or a throwaway cluster, HA is the
baseline. A dev kind cluster (like this handbook's lab) is deliberately
single-node and **not** HA — that is fine for learning, not for production.

## How it works underneath

**The control-plane components.** kube-apiserver is stateless and horizontally
scalable — run several, all reading/writing the same etcd. kube-scheduler and
kube-controller-manager run one **active** instance elected via a Lease
(leader election); the others stand by. So HA means: N apiservers all active, N
schedulers/controllers with one leader each, and an HA etcd behind them.

**Two etcd topologies:**

| Topology | etcd runs | Trade-off |
|---|---|---|
| **Stacked** | as static pods **on** the control-plane nodes | Simpler, fewer machines; a node loss takes an apiserver **and** an etcd member together. kubeadm's default. |
| **External** | on **separate** dedicated hosts | More machines and ops, but etcd failures are isolated from apiserver failures, and each scales independently. Preferred for large/critical clusters. |

**Quorum.** etcd commits a write only when a **majority** of members agree
(Raft). Run an **odd** number so you get the most fault tolerance per member:

| etcd members | Quorum | Tolerated failures |
|---|---|---|
| 3 | 2 | 1 |
| 5 | 3 | 2 |

3 and 4 both tolerate only 1 failure, so 4 is strictly worse than 3 (more
coordination, no extra safety). Lose quorum and etcd goes read-only — the whole
control plane stops accepting writes. See
[etcd backup and restore](etcd-backup-and-restore.md).

**Load-balanced API servers.** A load balancer (or a virtual IP with
keepalived) sits in front of the apiservers; kubelets, controllers and `kubectl`
target the LB address, which spreads connections and drops a failed apiserver
from rotation. The LB itself must be HA, or it becomes the new single point of
failure.

## Basic example

The canonical production shape is **3 control-plane nodes across 3 availability
zones**, stacked etcd (3 members, quorum 2), behind an HA load balancer:

```text title="HA topology (conceptual)" fragment
        ┌─────────── LB (HA vIP / cloud LB) ───────────┐
        │                    │                    │
   AZ-a │ cp-1           AZ-b │ cp-2          AZ-c │ cp-3
   apiserver              apiserver             apiserver
   etcd (member 1)        etcd (member 2)       etcd (member 3)   → quorum = 2
```

With this, any one node **or** one entire AZ can fail and etcd keeps quorum (2 of
3), an apiserver stays reachable through the LB, and leader election re-elects a
scheduler/controller.

## Explanation

The design tolerates **one** failure because quorum of 3 is 2. To tolerate a
whole-region event you need multi-**region**, which is a different and harder
problem (etcd latency across regions hurts write performance) — usually solved
with separate clusters per region rather than one stretched cluster. See
[multi-cluster](multi-cluster.md).

Spreading across **AZs** rather than piling 3 nodes in one AZ is what turns "one
machine can fail" into "one data center can fail". Placing all etcd members in
one AZ defeats the point: an AZ outage takes 3 of 3 members and quorum with them.

## Common patterns

- **3 nodes / 3 AZs / stacked etcd** — the standard HA baseline.
- **External etcd** for large or highly critical clusters, isolating etcd from
  apiserver load and failures.
- **5-member etcd** only when you must tolerate 2 simultaneous member failures;
  more members mean slower writes (more Raft coordination), so do not over-size.
- **Managed control planes** (EKS/GKE/AKS) run and replicate the control plane
  for you across AZs — you consume an HA API endpoint and never touch etcd.

## Production considerations

- **Odd members, spread across AZs.** Never even, never all in one AZ.
- **etcd latency is the performance floor.** etcd wants fast, low-latency disks
  and a low-latency network between members; slow disks throttle the entire
  cluster's write path. Keep members close (same region) even while spanning AZs.
- **The LB must be HA.** A single LB or vIP undoes the whole design.
- **Back up etcd regardless of HA.** Replication protects against node loss, not
  against operator error or corruption — you still need snapshots.
- **Capacity and skew.** Keep the apiservers within a minor of each other during
  upgrades (see [version skew](version-skew-policy.md)); HA upgrades roll one
  node at a time.

## Security considerations

- etcd holds **all Secrets** in the clear unless you enable encryption at rest;
  on an HA cluster that is 3+ copies to protect. Enable
  `EncryptionConfiguration` and restrict etcd peer/client certs.
- The API-server LB is the front door — terminate/validate TLS correctly and do
  not expose the apiserver more broadly than needed.
- etcd peer and client communication must be mutually authenticated with the
  cluster PKI; a rogue etcd member is total compromise.
- Leader-election Leases are in the API; RBAC that lets an attacker write them
  can disrupt controllers.

## Troubleshooting

- **Cluster read-only / writes failing:** etcd lost quorum (too many members
  down). Restore members until a majority is back.
- **`kubectl` intermittently fails:** the LB is routing to a dead apiserver, or
  an apiserver is unhealthy but still in rotation — check LB health checks.
- **Controllers/scheduler idle:** leader election is stuck (Lease contention or
  clock issues); check the Lease objects and component logs.
- **etcd slow / high latency alarms:** disk or network between members; etcd is
  extremely sensitive to fsync latency.

## Common mistakes

- Even-numbered etcd (e.g. 2 or 4), gaining coordination cost without extra
  fault tolerance.
- All control-plane nodes (or all etcd members) in one AZ, so an AZ outage is a
  full outage.
- A non-HA load balancer in front of HA apiservers.
- Relying on etcd replication *instead of* backups.
- Stretching one etcd cluster across regions and suffering write latency;
  prefer per-region clusters.

## Related topics

- [etcd backup and restore](etcd-backup-and-restore.md)
- [Multi-cluster](multi-cluster.md)
- [Version skew policy](version-skew-policy.md)
- [Architecture](../k8s-beginner/architecture.md)
