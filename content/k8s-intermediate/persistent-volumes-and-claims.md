---
title: Persistent volumes and claims
description: The binding protocol between PVC and PV, access modes, reclaim policies, and what actually happens to your data when you delete things.
level: intermediate
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-intermediate/volumes
---

## Overview

Two objects, deliberately separated:

- **PersistentVolumeClaim** (namespaced) — what a workload asks for: size,
  access mode, StorageClass.
- **PersistentVolume** (cluster-scoped) — a piece of storage that exists, with
  a driver, a volume handle, and a capacity.

A pod mounts a PVC, never a PV. The PVC/PV split exists so that developers can
ask for storage without knowing anything about the storage system, and so that
the storage outlives the pod that used it.

## Why it exists and when to use it

Container filesystems die with the container, and `emptyDir` dies with the pod.
Anything that must survive — a database, an upload directory, a build cache you
care about — needs a PV.

Use a PVC whenever data must outlive a pod. Use a StatefulSet's
`volumeClaimTemplates` when each replica needs its own.

## How it works underneath

**Binding.** The PersistentVolume controller watches unbound PVCs. For each, it
looks for a PV that satisfies the claim: same StorageClass, capacity at least
the request, compatible access modes, and matching selectors or node affinity.
If it finds one, it writes `spec.volumeName` on the PVC and `spec.claimRef` on
the PV, and both become `Bound`. The relationship is **one to one and
exclusive** — a 100Gi PV bound to a 1Gi claim wastes 99Gi, permanently.

**Dynamic provisioning.** If no PV matches and the PVC names a StorageClass with
a provisioner, the CSI `external-provisioner` sidecar calls
`CreateVolume` on the driver, creates a PV object for the result, and the
controller binds it. This is how almost every cluster works today; statically
created PVs are for pre-existing storage.

**`volumeBindingMode`.** With `Immediate`, provisioning happens as soon as the
PVC exists — and on a zonal storage system that decides the zone before the
scheduler has seen the pod, which then cannot be scheduled anywhere else. With
`WaitForFirstConsumer`, the PVC stays `Pending` until a pod that uses it is
scheduled; the scheduler picks a node, and *then* the volume is created in the
right topology. Use `WaitForFirstConsumer` unless you have a reason not to.

**Access modes** describe how many *nodes* may mount the volume, not how many
pods:

| Mode | Short | Meaning |
|---|---|---|
| `ReadWriteOnce` | RWO | one node may mount it read-write; several pods on that node can share it |
| `ReadOnlyMany` | ROX | many nodes, read-only |
| `ReadWriteMany` | RWX | many nodes, read-write (needs a file/network storage backend) |
| `ReadWriteOncePod` | RWOP | exactly one **pod** may use it, cluster-wide (**GA since 1.29**) |

RWOP is the one that gives you the guarantee people assume RWO provides. Use it
for anything where two writers would corrupt data.

**Reclaim policy**, on the PV, decides what happens when its claim is deleted:

- `Delete` — the PV and the backing volume are deleted. This is the default for
  dynamically provisioned volumes, and it is how data disappears.
- `Retain` — the PV survives in `Released` state, data intact, and must be
  cleaned up or re-bound by hand (edit out `claimRef`).
- `Recycle` — deprecated, effectively gone. Ignore it.

Since **1.33** the reclaim policy is honoured regardless of deletion order: a PV
whose policy is `Delete` gets its backing volume deleted even if the PV object
was deleted before the PVC, which used to leak storage silently.

**Protection finalizers.** `kubernetes.io/pvc-protection` keeps a PVC alive
while a pod uses it, and `kubernetes.io/pv-protection` keeps a PV alive while
bound. That is why `kubectl delete pvc` often hangs in `Terminating` — something
is still using it.

## Basic example

The lab's PVC comes from the StatefulSet template:

```yaml include="examples/k8s/02-database/postgres.yaml" lines="119-126"
```

```bash
kubectl -n tasklane get pvc -o wide
kubectl get pv -o wide
```

```console include="captures/k8s-intermediate/pvc.txt"
```

A standalone PVC looks the same without the template wrapper:

```yaml title="uploads-pvc.yaml"
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: tasklane-uploads
  namespace: tasklane
  labels:
    app.kubernetes.io/part-of: tasklane
spec:
  accessModes: ["ReadWriteOncePod"]
  storageClassName: standard
  resources:
    requests:
      storage: 5Gi
```

## Explanation

`accessModes` is a list in the API but is matched as a set of capabilities; a
claim asking for RWO binds to a PV that supports RWO. Writing
`["ReadWriteOnce", "ReadWriteMany"]` does not mean "either", it means the PV
must support both.

`storageClassName` has three meanings: a name (use that class), `""` (bind only
to a PV with no class — static provisioning), and omitted (use the cluster's
default class, if there is one). Omitting it is the usual cause of "it worked in
my cluster": a different default class, or none at all.

`resources.requests.storage` is a request, not a limit. The backing volume may
be larger, and the PV records what was actually created.

Examine what a bound PV really points at:

```bash
kubectl describe pv <name>
```

```console include="captures/k8s-intermediate/pv-describe.txt"
```

`Source` shows the CSI driver and the `volumeHandle` — the storage system's own
identifier, which is what you quote to your storage administrator or search for
in a cloud console.

## Common patterns

**`WaitForFirstConsumer` everywhere**, so topology and scheduling agree.

**`Retain` for anything irreplaceable**, accepting the manual cleanup. A
StorageClass with `reclaimPolicy: Delete` plus a careless `kubectl delete
namespace` is an unrecoverable data loss in one command.

**Expansion instead of migration.** With `allowVolumeExpansion: true` on the
class, edit the PVC's `spec.resources.requests.storage` upwards; the
`external-resizer` grows the volume and, for a filesystem volume, the kubelet
grows the filesystem. Shrinking is never supported.

**Label PVCs** with the app they belong to. PVC names outlive workloads, and a
cluster accumulates claims nobody can identify. Kubernetes 1.37 helps here with
the `PersistentVolumeClaimUnusedSinceTime` condition (Beta, on by default),
which records when a PVC stopped being used by any pod.

**One PVC per writer.** If two Deployments need the same data, ask whether they
really need shared storage or an API between them; RWX is a distributed
filesystem with all the consistency problems that implies.

## Production considerations

Zonal disks pin pods to a zone. A pod with an RWO volume in `zone-a` can only
run in `zone-a`; if that zone is unavailable, the pod is unschedulable, full
stop. Plan for it or use replication at the application level.

Attach/detach is slow and rate-limited by the cloud provider — tens of seconds,
and each node type has a maximum attached-volume count that the scheduler
respects. A node failure means waiting for the old attachment to be released
before the replacement pod can start; the
`node.kubernetes.io/out-of-service` taint is the documented way to tell
Kubernetes a node really is gone so that detachment can proceed.

Quota PVCs (`persistentvolumeclaims`, `requests.storage`, and the per-class
variants) or a single team will fill an account's disk quota.

Back up the *data*, not just the PV object. Restoring a PV that points at a
deleted cloud disk restores nothing.

## Security considerations

A PV is cluster-scoped, so a PV left in `Released` state with `Retain` still
contains the previous tenant's data. Binding it to a new claim hands that data
over — wipe or delete released volumes as part of offboarding.

`ReadWriteMany` volumes are a lateral-movement path: every pod that mounts one
reads and writes the same files, across namespaces if the claims are created in
each. `ReadWriteOncePod` (GA 1.29) is the strongest isolation the API offers.

Encryption is the driver's job, configured through StorageClass parameters (a
KMS key, an encrypted class). Kubernetes itself does not encrypt volumes, and it
will not warn you that a class is unencrypted.

Anyone who can create a PVC can consume storage, and anyone who can create a PV
can point it at an arbitrary volume handle — including one belonging to another
workload. Keep `persistentvolumes` (cluster-scoped) out of tenant roles, and
restrict `hostPath`-backed PVs entirely.

## Troubleshooting

**PVC `Pending`.**

```bash
kubectl -n tasklane describe pvc <name>
kubectl get storageclass
```

`waiting for first consumer to be created before binding` is normal with
`WaitForFirstConsumer` until a pod appears. `no persistent volumes available for
this claim and no storage class is set` means no default class and no matching
PV. `failed to provision volume` names the driver's error — quota, zone, or an
invalid parameter.

**Pod `Pending` with `volume node affinity conflict`.** The PV is in one zone
and the pod cannot be scheduled there, usually because of `Immediate` binding.

**PVC stuck `Terminating`.** A pod still references it; the
`pvc-protection` finalizer is doing its job. Find the pod, delete it, and the
PVC proceeds.

**PV `Released`, not reusable.** Remove `spec.claimRef` to make it `Available`
again — and be certain about whose data is on it first.

## Common mistakes

- **Assuming RWO means one pod.** It means one node. Two pods on the same node
  can both write. Use RWOP.
- **Relying on the default StorageClass** and getting a different one in another
  cluster.
- **`Delete` reclaim policy on production data**, then deleting the namespace.
- **`Immediate` binding on zonal storage**, producing unschedulable pods.
- **Trying to shrink a volume.** Not supported, by anyone.
- **Editing `volumeClaimTemplates`** instead of the PVCs when expanding a
  StatefulSet's storage.
- **Treating a PV as a backup.** It is one copy, in one storage system.

## Related topics

- [Volumes](volumes.md)
- [Storage classes and CSI](storage-classes-and-csi.md)
- [Volume snapshots](volume-snapshots.md)
- [StatefulSets](statefulsets.md)
- [LimitRange and ResourceQuota](limitrange-and-resourcequota.md)
- [PVC pending](../troubleshooting/pvc-pending.md)
- [Velero backup and restore](../operations/velero-backup-and-restore.md)
