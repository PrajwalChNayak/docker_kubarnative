---
title: Volume snapshots
description: CSI snapshots and group snapshots - the objects, the controller, restoring from one, and why a snapshot is not a backup.
level: intermediate
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-intermediate/persistent-volumes-and-claims
  - k8s-intermediate/storage-classes-and-csi
---

## Overview

Volume snapshots let you ask the storage system for a point-in-time copy of a
volume, and later create a new PVC from it. The API mirrors PV/PVC exactly:

| Snapshot object | PV/PVC analogue |
|---|---|
| `VolumeSnapshotClass` | `StorageClass` |
| `VolumeSnapshot` (namespaced) | `PersistentVolumeClaim` |
| `VolumeSnapshotContent` (cluster-scoped) | `PersistentVolume` |

Group snapshots add the same three kinds again for sets of volumes:
`VolumeGroupSnapshotClass`, `VolumeGroupSnapshot` and
`VolumeGroupSnapshotContent`, in the group `groupsnapshot.storage.k8s.io/v1`,
**GA in Kubernetes 1.36**.

None of these are core Kubernetes types. They are CRDs from the CSI
external-snapshotter project, and they only work if that project's CRDs, its
snapshot-controller, and a driver with snapshot support are all installed.

## Why it exists and when to use it

Copying a 500 GB volume by reading every byte takes hours and a lot of IO.
Storage systems can do it in seconds with copy-on-write. Snapshots expose that
capability through the Kubernetes API so that a backup tool — or you — can use
it without credentials for the storage system.

Use snapshots to clone an environment, to take a fast checkpoint before a risky
migration, and as *part of* a backup strategy. Do not use them *as* the backup
strategy.

## How it works underneath

The `snapshot-controller` (a cluster-wide Deployment) watches `VolumeSnapshot`
objects and creates the matching `VolumeSnapshotContent`. The
`external-snapshotter` sidecar, running next to the CSI driver's controller
plugin, sees the content object and calls `CreateSnapshot` on the driver.

Two fields tell you where you are:

- `status.boundVolumeSnapshotContentName` — the content object exists.
- `status.readyToUse` — the driver reports the snapshot is usable. Some drivers
  return ready immediately; others upload in the background for minutes.

`deletionPolicy` on the class (or content) is `Delete` or `Retain`, exactly like
a reclaim policy, and it governs the snapshot inside the storage system.

**Restoring** is a PVC with a `dataSource` pointing at the snapshot. The
provisioner calls `CreateVolume` with the snapshot as its source, so the new
volume is a full, independent volume. It must be at least as large as the
snapshot, and it uses a StorageClass on the same driver.

**Group snapshots** exist because per-volume snapshots taken one after another
are not consistent with each other. A `VolumeGroupSnapshot` selects PVCs by
label and asks the driver — which must implement the `GROUP_CONTROLLER` service
— for one snapshot across all of them at a single point in time. The individual
`VolumeSnapshot` objects are created for you, so restore works exactly as
before.

**Consistency, precisely.** A CSI snapshot is *crash-consistent*: it is what the
volume would look like if you pulled the power cable. A journaling filesystem
recovers; a database recovers using its own WAL, usually. It is not
*application-consistent*, which requires the application to flush and freeze
first. For PostgreSQL that means `pg_start_backup`-style coordination, a logical
dump, or continuous archiving.

## Basic example

```yaml include="examples/k8s/07-reliability/30-volume-snapshot.yaml"
```

And a group snapshot across every PVC carrying one label:

```yaml include="examples/k8s/07-reliability/40-volume-group-snapshot.yaml"
```

:::warning Not runnable in the lab
kind's default StorageClass is backed by the local-path provisioner, which is a
directory on the node and cannot snapshot anything. Without the
external-snapshotter CRDs installed, `kubectl get volumesnapshotclass` fails
outright:

```console include="captures/k8s-intermediate/volumesnapshotclass-missing.txt"
```

That error is the expected result here, and it is the first thing to check on
any cluster where snapshots "do not work".
:::

## Explanation

The `VolumeSnapshotClass` names a driver, and it must be the same driver that
provisioned the PVC being snapshotted — you cannot snapshot an EBS volume with a
Ceph class.

The `VolumeSnapshot` names its source PVC, `data-postgres-0`, the PVC the
StatefulSet created for ordinal 0. Snapshots are namespaced and can only
reference a PVC in their own namespace.

The restore PVC uses `dataSource` with `apiGroup: snapshot.storage.k8s.io`. A
`dataSource` can also reference another PVC directly (a clone), and
`dataSourceRef` extends the same mechanism to arbitrary custom resources, which
is how some backup tools restore from their own objects.

The group snapshot selects by PVC label. Membership is evaluated once, when the
snapshot is taken: labelling a PVC afterwards does not add it to an existing
group snapshot.

## Common patterns

**Snapshot before a schema migration.** Take it, run the migration, and keep the
snapshot until you are confident. This is the use case where crash consistency
is entirely adequate.

**Clone production data into staging.** Snapshot, restore into a new PVC in the
staging namespace, mount it read-only. Remember that you have just copied
production data into a less protected namespace — see below.

**Group snapshots for multi-volume databases.** A database with data and WAL on
separate volumes is exactly why group snapshots exist.

**Schedule them with a controller, not a CronJob of `kubectl` calls.** Velero,
Kanister and cloud-native backup operators handle retention, labelling and
restore testing. A hand-rolled CronJob that creates snapshots without ever
deleting them is a bill, not a backup plan.

**Test restores.** An untested restore is a hypothesis. Restore into a scratch
namespace on a schedule and check the data.

## Production considerations

Snapshots usually live in the same storage system, often the same availability
zone, as the volume. A storage system failure takes both. A real backup leaves
the system: object storage in another account or region, with its own
credentials.

Retention costs. Incremental snapshots are cheap individually and expensive in
aggregate, and deleting the *first* snapshot of a chain can be surprisingly
slow. Set a retention policy and enforce it.

`deletionPolicy: Delete` plus `kubectl delete namespace` removes the snapshots
too. If the snapshot is your only copy of the data, that is a one-command data
loss.

Snapshot operations count against cloud API rate limits. Snapshotting 500
volumes at 02:00 can throttle every other storage operation in the account.

Quiesce the application when you can. For PostgreSQL, a `pg_dump` for logical
backups and WAL archiving for point-in-time recovery are the tools that give
application consistency; the snapshot is the fast, coarse complement.

## Security considerations

A snapshot is a complete copy of the data with none of the access controls that
protected the original. Restoring it into another namespace moves that data
across a tenancy boundary, and `VolumeSnapshotContent` is cluster-scoped, so
anyone who can create content objects (and a matching snapshot with
`volumeSnapshotContentName`) can bind to another tenant's snapshot. Keep
`volumesnapshotcontents` out of tenant roles.

Encryption does not always follow. Whether a snapshot of an encrypted volume is
encrypted, and with which key, is a property of the storage system. Verify it
rather than assuming, especially for cross-region copies.

Restored volumes carry the original's contents, including anything an attacker
left behind. Restoring from a snapshot taken after a compromise restores the
compromise.

Snapshot deletion is a destructive operation available to anyone with RBAC on
`volumesnapshots` in the namespace. Ransomware playbooks target exactly this.
Keep an immutable copy outside the cluster's control plane.

## Troubleshooting

```bash
kubectl -n tasklane get volumesnapshot
kubectl -n tasklane describe volumesnapshot <name>
kubectl get volumesnapshotcontent
```

**`the server doesn't have a resource type "volumesnapshotclass"`** — the CRDs
are not installed. Install external-snapshotter's CRDs and the
snapshot-controller; the sidecar alone is not enough.

**`readyToUse: false` forever** — read `status.error`. Common causes: the driver
does not implement snapshots, the class names a different driver than the PVC's,
or the storage system hit a quota.

**Restore PVC `Pending`** — the requested size is smaller than the snapshot, or
the StorageClass belongs to another driver.

**Snapshot deleted but storage still billed** — `deletionPolicy: Retain` leaves
the `VolumeSnapshotContent` and the underlying snapshot behind.

## Common mistakes

- **Treating snapshots as backups.** Same system, same blast radius.
- **Expecting application consistency** from a crash-consistent copy.
- **Snapshotting with a class whose driver differs from the volume's.**
- **No retention policy**, so snapshots accumulate for years.
- **Never testing a restore.**
- **Forgetting that group membership is by label at snapshot time.**
- **Assuming the lab can demonstrate this.** local-path cannot.

## Related topics

- [Persistent volumes and claims](persistent-volumes-and-claims.md)
- [Storage classes and CSI](storage-classes-and-csi.md)
- [StatefulSets](statefulsets.md)
- [Velero backup and restore](../operations/velero-backup-and-restore.md)
- [etcd backup and restore](../operations/etcd-backup-and-restore.md)
