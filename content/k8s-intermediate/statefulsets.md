---
title: StatefulSets
description: Stable identity, ordered rollout and per-pod storage - what a StatefulSet actually guarantees, and what it does not.
level: intermediate
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/deployments-and-replicasets
  - k8s-beginner/services
  - k8s-intermediate/persistent-volumes-and-claims
---

## Overview

A StatefulSet (`apps/v1`) manages pods that are not interchangeable. Compared
with a Deployment it adds four things:

1. **Stable names.** Pods are `<set>-0`, `<set>-1`, … and a replacement keeps
   the same name.
2. **Stable network identity**, through a headless Service:
   `<pod>.<service>.<namespace>.svc.cluster.local`.
3. **Stable storage.** Each ordinal gets its own PVC from a
   `volumeClaimTemplate`, and a replacement pod re-attaches the same PVC.
4. **Ordering guarantees** for creation, scaling and updates.

What it does not give you is replication, leader election, failover or backups.
Those are the database's job — or an operator's.

## Why it exists and when to use it

Deployments assume replicas are identical and disposable. That assumption breaks
for anything that owns data on disk or that peers identify by name: PostgreSQL,
Kafka, etcd, Elasticsearch, a consensus group of any kind.

Use a StatefulSet when a pod's identity outlives the pod. If your workload just
needs *a* volume, a Deployment with a single PVC is simpler — and if it needs
one volume per replica with no identity, that is still a StatefulSet, because
`volumeClaimTemplates` exists nowhere else.

## How it works underneath

The StatefulSet controller reconciles one ordinal at a time. For each ordinal
`i` in `[startOrdinal, startOrdinal + replicas)` it ensures a pod named
`<set>-<i>` exists, and it also ensures the PVCs named
`<claim>-<set>-<i>` exist first.

With the default `podManagementPolicy: OrderedReady`, pod `i` is only created
once pod `i-1` is **Ready**, and scale-down deletes in reverse ordinal order,
waiting for each terminating pod to disappear. With `podManagementPolicy:
Parallel` the controller acts on all ordinals at once — identity and storage are
unchanged, only the waiting goes away.

Network identity comes from the headless Service named in `serviceName`
(`clusterIP: None`). The EndpointSlice controller publishes one endpoint per
pod with its `hostname`, and CoreDNS answers `<pod>.<service>...` with that
pod's IP. This is why the Service must exist and must be headless: a ClusterIP
Service would load-balance and destroy the identity.

`volumeClaimTemplates` produces a PVC per ordinal at creation time. The
controller **never deletes those PVCs** by default — deleting the StatefulSet or
scaling it down leaves the data, on purpose. Since **1.32** you can change that
with `persistentVolumeClaimRetentionPolicy`, which takes `whenDeleted` and
`whenScaled`, each `Retain` (default) or `Delete`.

Updates are driven by `updateStrategy`:

- `RollingUpdate` (default) replaces pods **from the highest ordinal down**, one
  at a time, waiting for each to be Ready. `partition: N` updates only ordinals
  `>= N`, which is how canary rollouts of stateful sets are done.
  `maxUnavailable` (Beta; **on by default in 1.37**, and off in 1.35.4 through
  1.36) allows more than one at a time.
- `OnDelete` updates nothing; you delete pods yourself and the controller
  recreates them from the new template. That is the right choice when a version
  upgrade needs a human in the loop.

`.spec.ordinals.startOrdinal` (**GA since 1.31**) shifts the numbering, which
exists mainly to migrate a set across clusters without a name collision.

## Basic example

Tasklane's database:

```yaml include="examples/k8s/02-database/postgres.yaml"
```

## Explanation

The headless Service comes first and is referenced by `serviceName: postgres`.
The pod's stable name is `postgres-0` and its stable DNS name is
`postgres-0.postgres.tasklane.svc.cluster.local`. The application connects to
`postgres` (the Service) because there is one replica; a replicated setup would
address the primary by its ordinal name.

`volumeClaimTemplates` creates the PVC `data-postgres-0` — the pattern is
`<template name>-<statefulset name>-<ordinal>`. Delete the StatefulSet and that
PVC survives, with the data in it. Recreate the StatefulSet with the same name
and `postgres-0` binds to it again.

The mount path is `/var/lib/postgresql` rather than the more familiar
`/var/lib/postgresql/data`, because the 18.x image sets
`PGDATA=/var/lib/postgresql/18/docker`. Mounting a volume one directory too
deep, or too shallow, is the classic way to get an empty database that
"mysteriously" resets.

```bash
kubectl -n tasklane describe statefulset postgres
```

```console include="captures/k8s-intermediate/statefulset-describe.txt"
```

## Common patterns

**Headless plus regular Service.** Keep the headless Service for identity, and
add a normal ClusterIP Service for clients that just want "any replica" — or one
Service per role (`-primary`, `-replicas`) selected by a label the application
or operator maintains.

**`podManagementPolicy: Parallel` for shared-nothing sets.** A cache or a shard
group with no bootstrap ordering starts far faster, and a rolling node upgrade
does not serialise behind one slow pod.

**`partition` for staged upgrades.** Set `partition` to `replicas`, update the
image, then lower the partition one ordinal at a time, checking health between
steps.

**PVC retention, chosen deliberately.**

```yaml title="postgres-retention.yaml" fragment
persistentVolumeClaimRetentionPolicy:
  whenDeleted: Retain   # keep the data if someone deletes the StatefulSet
  whenScaled: Delete    # but reclaim disks when scaling down a shard set
```

**Use an operator for real databases.** CloudNativePG, Strimzi, the Zalando
Postgres operator and their peers encode failover, backup and version upgrades.
A StatefulSet gives you a place to run the database, not a database team.

## Production considerations

A single-replica StatefulSet is a single point of failure, and a PVC bound to a
zonal disk pins that pod to one zone. Node drains block on it, and a lost node
means downtime until the volume can be attached elsewhere — which for
`ReadWriteOnce` requires the old attachment to be released first. This is why
`kubectl drain` of a database node can hang: see
[pod disruption budgets](pod-disruption-budgets.md) for why a
`minAvailable: 1` PDB on a single replica makes it worse, not better.

Scale-down is destructive in slow motion: the pods go, the PVCs stay (by
default), and the next scale-up reuses old data that may be far behind. Decide
what `whenScaled` should be before you need it.

Resizing storage means editing the PVC, not the template:
`volumeClaimTemplates` is immutable after creation, so growing a volume is a
per-PVC `kubectl patch` (with a StorageClass that has
`allowVolumeExpansion: true`), and the template stays stale until you recreate
the set. See [storage classes and CSI](storage-classes-and-csi.md).

Back up the data, not the volume. Snapshots are crash-consistent at best; a
database needs a dump or continuous archiving. See
[volume snapshots](volume-snapshots.md).

## Security considerations

Per-pod PVCs mean per-pod data at rest. If one pod is compromised, it has the
data of one ordinal — unless a `ReadWriteMany` volume is shared, which throws
that isolation away. Prefer `ReadWriteOnce`, or `ReadWriteOncePod`
(**GA since 1.29**) when exactly one pod must ever mount a volume.

Stable DNS names are a discovery aid for an attacker as much as for your
application; `postgres-0.postgres` is a very good guess. NetworkPolicy is what
turns "guessable" into "unreachable" — the database in this handbook only
accepts connections from the API, the worker and the maintenance job. See
[NetworkPolicy](network-policy.md).

Database credentials belong in a Secret mounted as a file, never in an image or
a ConfigMap. Tasklane passes a path (`PGPASSWORD_FILE`) rather than the value,
so the password is never in an environment variable that `kubectl describe` or a
crash dump would print.

## Troubleshooting

**Pod stuck `Pending` with no events about resources.** Look at the PVC first:
`kubectl -n tasklane get pvc`. With `WaitForFirstConsumer` binding, the PVC and
the pod wait for each other until a node is chosen — normal briefly, a problem
if it persists. See [PVC pending](../troubleshooting/pvc-pending.md).

**Ordinal 1 never starts.** With `OrderedReady`, ordinal 0 must be *Ready*.
A failing readiness probe on `-0` stalls the entire set, silently.

**`kubectl delete pod postgres-0` and it comes back with no data.** It came back
with the same PVC. If the data is gone, the mount path is wrong or the image
initialised a different directory.

**Stuck terminating on a drain.** A pod with an attached volume cannot move
until the volume is detached; force-deleting it risks two pods writing to one
disk. Use the documented force-delete procedure only when you are certain the
old pod is gone.

## Common mistakes

- **No headless Service, or a ClusterIP one.** Per-pod DNS names stop existing,
  and clustering software that resolves peers by name fails in confusing ways.
- **Expecting a StatefulSet to replicate data.** It runs pods; it does not copy
  bytes between them.
- **Editing `volumeClaimTemplates` on a live set** and wondering why nothing
  changes. It is immutable.
- **Assuming scale-down frees the disks.** It does not, unless
  `whenScaled: Delete`.
- **Mounting the volume at the wrong path** for the image's data directory.
- **Putting a `minAvailable: 1` PDB on a single-replica set**, which blocks
  every voluntary drain forever.
- **`OrderedReady` for a set that has no ordering requirement**, turning a
  20-second rollout into ten minutes.

## Related topics

- [Persistent volumes and claims](persistent-volumes-and-claims.md)
- [Storage classes and CSI](storage-classes-and-csi.md)
- [Volume snapshots](volume-snapshots.md)
- [DNS and CoreDNS](dns-and-coredns.md)
- [Pod disruption budgets](pod-disruption-budgets.md)
- [Deployments and ReplicaSets](../k8s-beginner/deployments-and-replicasets.md)
- [PVC pending](../troubleshooting/pvc-pending.md)
