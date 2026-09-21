---
title: Storage classes and CSI
description: How a StorageClass turns a claim into a disk, and what the CSI controller and node plugins are actually doing while you wait.
level: intermediate
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-intermediate/persistent-volumes-and-claims
---

## Overview

A **StorageClass** (`storage.k8s.io/v1`) is a named storage offering: which
driver provisions it, with which parameters, what happens on delete, whether it
can be expanded, and when binding happens.

**CSI** — the Container Storage Interface — is the plugin API that every storage
driver now implements. Kubernetes core knows nothing about EBS, Ceph or NFS; it
speaks gRPC to a driver that does.

## Why it exists and when to use it

Without classes, every PV would be created by hand by someone who knows the
storage system. A StorageClass lets a platform team publish "fast", "bulk" and
"encrypted" as self-service options, and lets the same manifest run on a
laptop's kind cluster and on a cloud cluster with different backing storage.

You need to author a StorageClass when you want a non-default set of parameters
— a different disk type, filesystem, encryption key, or binding mode.

## How it works underneath

A CSI driver is deployed as two halves, plus a `CSIDriver` object that describes
its capabilities to the kubelet:

**Controller plugin** — usually a Deployment, one instance per cluster, running
the driver container next to Kubernetes-supplied *sidecars* that translate
Kubernetes objects into CSI calls:

| Sidecar | Watches | Calls |
|---|---|---|
| `external-provisioner` | PVCs | `CreateVolume` / `DeleteVolume` |
| `external-attacher` | VolumeAttachments | `ControllerPublishVolume` / `Unpublish` |
| `external-resizer` | PVC size changes | `ControllerExpandVolume` |
| `external-snapshotter` | VolumeSnapshots | `CreateSnapshot` / `DeleteSnapshot` |

**Node plugin** — a DaemonSet on every node, running the driver plus
`node-driver-registrar`, which registers the driver with the kubelet over a
socket in `/var/lib/kubelet/plugins_registry/`. The kubelet then calls
`NodeStageVolume`, `NodePublishVolume` and their inverses directly.

So a `kubectl apply` of a PVC becomes: PVC → provisioner sidecar →
`CreateVolume` → PV object → binding → scheduler → attach controller →
VolumeAttachment → attacher sidecar → `ControllerPublishVolume` → kubelet →
`NodeStageVolume` → `NodePublishVolume` → bind mount. Every step in that chain
is a place a pod can sit in `ContainerCreating`, and each emits events that name
the step.

**In-tree to CSI migration** is complete for the major cloud providers: the old
`kubernetes.io/aws-ebs`-style plugins were removed and their functionality is
provided by CSI drivers that must be installed separately. On a managed cluster
this is already done for you; on a self-managed one, installing the driver is
your job.

**`CSIDriver`** declares capabilities the rest of Kubernetes needs to know:
`attachRequired`, `podInfoOnMount`, `fsGroupPolicy`, `storageCapacity`, and
`seLinuxMount` — the last of which is what enables the mount-option SELinux
relabelling that is **GA in 1.37**.

## Basic example

```yaml title="fast-ssd-storageclass.yaml"
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-ssd
provisioner: csi.example.com
parameters:
  type: ssd
  csi.storage.k8s.io/fstype: ext4
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
allowedTopologies:
  - matchLabelExpressions:
      - key: topology.kubernetes.io/zone
        values: ["zone-a", "zone-b"]
```

The lab cluster has exactly one class:

```bash
kubectl get storageclass -o wide
```

```console include="captures/k8s-intermediate/storageclass.txt"
```

and you can see which drivers are registered:

```bash
kubectl get csidrivers -o wide
kubectl get csinodes -o wide
```

```console include="captures/k8s-intermediate/csidrivers.txt"
```

## Explanation

`provisioner` is the CSI driver's name, and it must match the driver's
registered name exactly — a typo produces a PVC that waits forever with no
error other than "no volume plugin matched".

`parameters` are passed to the driver verbatim. They are driver-specific:
`type: ssd` means whatever that driver says it means. The
`csi.storage.k8s.io/` prefixed keys are the standard ones, including `fstype`
and the secret references used for provisioning credentials.

`reclaimPolicy` and `allowVolumeExpansion` are copied onto every PV the class
creates, and `reclaimPolicy` on an existing PV can be edited later;
`allowVolumeExpansion` cannot be changed on a PV at all, only on the class for
future volumes.

`allowedTopologies` restricts where volumes may be created, which matters when a
cluster spans zones that your storage does not.

kind's default class, `standard`, is backed by the local-path provisioner: it
creates a directory on the node. That is honest, fast, and has exactly the
properties you would expect — no snapshots, no expansion, no attachment, and the
data is gone if the node is.

## Common patterns

**Mark exactly one default class.** The annotation is
`storageclass.kubernetes.io/is-default-class: "true"`. Two defaults is
undefined behaviour; zero defaults means every PVC must name a class, which is
arguably better discipline.

**A class per intent, not per parameter.** `fast`, `bulk`, `encrypted` — names
that mean something to an application team. They should not have to know the
disk type.

**`WaitForFirstConsumer` by default.** It is the difference between "the
scheduler picks a node" and "the storage picked a zone for you".

**Expansion, end to end.**

```bash
kubectl -n tasklane patch pvc data-postgres-0 --type=merge \
  -p '{"spec":{"resources":{"requests":{"storage":"2Gi"}}}}'
kubectl -n tasklane get pvc data-postgres-0 -o jsonpath='{.status.conditions}'
```

The PVC shows `Resizing`, then `FileSystemResizePending` if the filesystem grows
at the next mount. Failure recovery — reducing a too-large request after a
failed expansion — is **GA since 1.34**.

**`VolumeAttributesClass`** (**GA since 1.34**) changes a volume's QoS (IOPS,
throughput) after creation, without recreating it, by pointing the PVC at a new
class. Driver support varies; check before designing around it.

## Production considerations

Install the CSI driver as part of cluster build, and treat its version as part
of the cluster version — a driver that lags a Kubernetes upgrade is a common
source of mysterious mount failures after an upgrade.

Attached volume limits are per node and per instance type. The scheduler knows
them through `CSINode`, and pods stay `Pending` when a node is full of volumes,
with a message that mentions volume limits rather than CPU or memory. Cluster
Autoscaler learned about these limits in 1.37 (`VolumeLimitScaling`, Beta).

Capacity-aware scheduling (`storageCapacity` on the CSIDriver, plus
`CSIStorageCapacity` objects) stops the scheduler from placing a pod on a node
whose storage pool is full. 1.37 adds storage capacity *scoring* (Beta) to
prefer nodes with more room.

Storage costs money continuously and silently. Dynamically provisioned volumes
outlive the workloads that created them by default. Audit unbound and unused
PVCs regularly — the new `PersistentVolumeClaimUnusedSinceTime` condition
(Beta, on by default in 1.37) makes that query easy.

## Security considerations

A StorageClass can carry credentials by reference:
`csi.storage.k8s.io/provisioner-secret-name` and its node/controller-publish
siblings point at Secrets. Those Secrets are read by the driver's
ServiceAccount, so that ServiceAccount is effectively a storage-system
administrator. Treat the CSI controller Deployment as a high-value target: pin
its images, restrict its namespace, and review its RBAC.

Encryption at rest is a class parameter, not a Kubernetes feature. If you need
it, the class must ask for it and someone must verify the storage system
actually did it. A class named `encrypted` proves nothing.

The node plugin is privileged by necessity — it mounts filesystems in the host
namespace. That is the single most privileged DaemonSet in most clusters. Only
install drivers you trust, from a source you verify.

Anyone who can create a StorageClass can define storage with arbitrary
parameters, including mounting host paths through a permissive driver.
StorageClasses are cluster-scoped; keep them out of tenant roles.

## Troubleshooting

```bash
kubectl -n tasklane describe pvc <name>
kubectl get events -A --field-selector reason=ProvisioningFailed
kubectl -n <driver-ns> logs deploy/<csi-controller> -c csi-provisioner
```

The provisioner sidecar's log is where the storage system's real error appears —
quota exceeded, invalid parameter, permission denied. The PVC event is usually a
truncated version of it.

`ContainerCreating` for minutes with `FailedMount` and a `NodeStageVolume`
error points at the node plugin: check the DaemonSet pod on that specific node.

No `CSINode` entry for a node means the driver's registrar never ran there —
often a DaemonSet that does not tolerate that node's taints.

## Common mistakes

- **Expecting snapshots or expansion from a class that does not support them.**
  kind's local-path supports neither.
- **Two default StorageClasses**, or relying on a default that differs between
  clusters.
- **`Immediate` binding with zonal storage.**
- **Editing `parameters` on an existing class** and expecting existing volumes
  to change. Parameters apply at creation only.
- **Forgetting the driver.** A self-managed cluster with no CSI driver installed
  has no dynamic provisioning at all.
- **Ignoring per-node volume limits** when packing many stateful pods.
- **Assuming a class name implies a property.** Only the parameters do.

## Related topics

- [Persistent volumes and claims](persistent-volumes-and-claims.md)
- [Volume snapshots](volume-snapshots.md)
- [Volumes](volumes.md)
- [StatefulSets](statefulsets.md)
- [PVC pending](../troubleshooting/pvc-pending.md)
- [Cluster upgrades](../operations/cluster-upgrades.md)
