---
title: etcd backup and restore
description: Snapshot and restore the cluster's etcd datastore, defragment it, and understand the quorum and Raft basics that make it safe.
level: expert
type: tutorial
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/architecture
  - operations/high-availability-control-plane
---

## Overview

**etcd** is the single source of truth for a Kubernetes cluster: every object —
every Deployment, Secret, and Lease — lives there. Lose etcd without a backup
and you lose the cluster's entire state. This tutorial covers taking and
restoring etcd **snapshots**, keeping the datastore healthy with **defrag**, and
the **quorum/Raft** basics that explain why etcd behaves as it does.

## Why etcd is special

The API server is stateless — kill it and restart it, and it reads state back
from etcd. etcd is the opposite: it *is* the state. A backup of etcd is a backup
of the whole cluster's desired state (though **not** of PersistentVolume data —
that is Velero's and your storage layer's job; see
[Velero backup and restore](velero-backup-and-restore.md)).

## Quorum and Raft in one minute

etcd replicates data across members using the **Raft** consensus algorithm. A
write is committed only when a **majority (quorum)** of members have persisted
it. That is why production runs an **odd** number of members — 3 or 5:

| Members | Quorum | Failures tolerated |
|---|---|---|
| 1 | 1 | 0 |
| 3 | 2 | 1 |
| 5 | 3 | 2 |

An odd count maximises fault tolerance per member: 3 and 4 members both tolerate
only 1 failure, so 4 buys nothing and costs latency. Lose quorum (e.g. 2 of 3
members down) and etcd goes **read-only** — the cluster cannot accept writes
until quorum returns. See
[high availability control plane](high-availability-control-plane.md).

## Inspect the cluster

etcd runs as a **static pod** on each control-plane node. Talk to it via its own
`etcdctl` with the control-plane client certs:

```bash
kubectl -n kube-system exec etcd-tasklane-control-plane -- etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  endpoint status --write-out=table
```

```console include="captures/operations/ops-etcd-endpoint-status.txt"
```

```console include="captures/operations/ops-etcd-member-list.txt"
```

`endpoint status` shows each member's DB size, leader, and Raft term;
`member list` shows membership. Watch DB size against the etcd quota (default
~2 GiB for older etcd, larger on current builds) — a full quota puts etcd into a
maintenance alarm that blocks writes.

## Step 1 — Take a snapshot

```bash
kubectl -n kube-system exec etcd-tasklane-control-plane -- etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  snapshot save /var/lib/etcd/snapshot.db
```

A snapshot is a consistent point-in-time copy of the entire keyspace. Copy it
**off the node** immediately — a snapshot that only exists on the failing node
is not a backup. Automate this on a schedule; the interval is your etcd RPO.

## Step 2 — Restore a snapshot

Restore is an **offline** operation. Stop the control plane (or at least the
apiserver and etcd static pods), restore into a **fresh** data directory, then
point etcd at it:

```bash
# On the control-plane node, with etcd stopped:
etcdctl snapshot restore /var/lib/etcd/snapshot.db \
  --data-dir=/var/lib/etcd-restore
```

Then edit `/etc/kubernetes/manifests/etcd.yaml` so its `hostPath` volume points
at `/var/lib/etcd-restore`, and let the kubelet restart the static pod. For a
multi-member cluster, restore establishes a new single-member cluster from the
snapshot; re-add the other members afterwards so they resync from the restored
leader.

:::danger Restore rewinds the whole cluster
Restoring rolls **all** cluster state back to the snapshot's moment. Objects
created after the snapshot vanish; controllers then reconcile toward the old
desired state. Do it only for genuine disaster recovery, in the disposable lab
first, and expect churn as the cluster reconciles.
:::

## Step 3 — Defragment periodically

etcd keeps historical revisions until **compaction** removes them; compaction
frees logical space but not disk. **Defrag** reclaims the disk space back to the
filesystem:

```bash
etcdctl --endpoints=https://127.0.0.1:2379 <certs...> defrag
```

Defrag briefly blocks the member it runs on, so on an HA cluster defrag members
**one at a time**, never all at once. Combined with a compaction policy
(`--auto-compaction-retention`), this keeps the DB size and latency healthy.

## RPO and RTO for etcd

- **RPO** is your snapshot interval — snapshot every few hours (or continuously
  with a sidecar) so a disaster loses minimal state.
- **RTO** is restore + control-plane rebuild time. Practise it: a restore you
  have never tested is a hope, not a plan.
- Store snapshots encrypted and off-cluster; a snapshot contains **all Secrets**
  (see security).

## Common mistakes

- Leaving the snapshot on the node that failed — copy it off immediately.
- Restoring into a non-empty/old data dir instead of a fresh one.
- Running an **even** number of etcd members, gaining no extra fault tolerance.
- Defragging all members at once and stalling the cluster.
- Forgetting that etcd backup does **not** cover PersistentVolume data.
- Never testing a restore, so RTO is unknown until a real outage.

## Related topics

- [High availability control plane](high-availability-control-plane.md)
- [Velero backup and restore](velero-backup-and-restore.md)
- [Cluster upgrades](cluster-upgrades.md)
- [Certificate rotation](certificate-rotation.md)
- [Architecture](../k8s-beginner/architecture.md)
