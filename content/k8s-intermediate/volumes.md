---
title: Volumes
description: The volume types a pod can mount, how the kubelet sets them up, and which ones are traps.
level: intermediate
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/pods
  - docker-intermediate/volumes-bind-mounts-tmpfs
---

## Overview

A Kubernetes volume is a directory, backed by something, that is mounted into
one or more containers of a pod. Two properties define every type:

- **Lifetime** — tied to the pod (`emptyDir`), or independent of it
  (`persistentVolumeClaim`).
- **Source** — the node's disk, memory, an API object, or a storage system
  reached through a CSI driver.

Volumes are declared once in `spec.volumes` and mounted per container in
`volumeMounts`, which is what lets two containers share one directory.

## Why it exists and when to use it

A container's filesystem is ephemeral and private. Anything that must survive a
restart, or be shared between containers in a pod, or come from configuration
rather than from the image, needs a volume.

Use `emptyDir` for scratch space and for sharing between containers in a pod.
Use `configMap`, `secret`, `downwardAPI` and `projected` for configuration and
identity. Use a `persistentVolumeClaim` for data. Avoid `hostPath` unless you
are writing a node agent.

## How it works underneath

The kubelet's volume manager reconciles the pod's desired volumes against what
is mounted on the node:

1. **Attach** (for volumes that need it): the attach/detach controller in
   kube-controller-manager creates a `VolumeAttachment`, and the CSI controller
   plugin performs `ControllerPublishVolume` — for a cloud disk, attaching it to
   the VM.
2. **Mount**: the kubelet calls the CSI node plugin's `NodeStageVolume` (once
   per node, the global mount) and then `NodePublishVolume` (once per pod, the
   bind mount into the pod's directory under
   `/var/lib/kubelet/pods/<uid>/volumes/...`).
3. **Bind into the container**: the runtime bind-mounts that path at the
   container's `mountPath`.

`configMap`, `secret`, `downwardAPI` and `projected` volumes need no driver at
all: the kubelet writes them into a **tmpfs** on the node (so they never touch
disk) and refreshes them when the underlying object changes — typically within a
minute, unless the pod uses `subPath`, which pins a single file and never
updates.

Ownership is set through the pod's `securityContext.fsGroup`, which makes the
kubelet chown the volume. On large volumes that recursive chown used to stall
pod startup, hence `fsGroupChangePolicy: OnRootMismatch`. On SELinux systems the
equivalent relabelling is now handled by mount option instead of recursion —
`SELinuxMount` is **GA and on by default in 1.37**, applying when the CSIDriver
sets `seLinuxMount: true`, with `seLinuxChangePolicy: Recursive` as the per-pod
opt-out.

## The types worth knowing

| Type | Lifetime | Notes |
|---|---|---|
| `emptyDir` | pod | a directory on the node; `medium: Memory` makes it tmpfs and it counts against the container's memory limit. `sizeLimit` bounds it |
| `configMap` / `secret` | pod | tmpfs, read-only in practice, auto-updated (except with `subPath`) |
| `downwardAPI` | pod | pod fields and resource limits as files |
| `projected` | pod | combines the four above, plus ServiceAccount tokens with an audience and expiry |
| `persistentVolumeClaim` | independent | the real answer for data; see [PV and PVC](persistent-volumes-and-claims.md) |
| generic ephemeral volume | pod | a PVC created and deleted with the pod: real storage, pod lifetime |
| `csi` (inline) | pod | driver-provided ephemeral volume, e.g. a secrets-store driver |
| `image` | pod | an OCI image mounted read-only (**GA in 1.36**) |
| `hostPath` | node | a path from the node; a privilege escalation vector |
| `nfs`, `iscsi`, `fc`, `cephfs` … | independent | in-tree network volumes; prefer the CSI driver |

`gitRepo` is gone: it was deprecated since 1.11 and **permanently disabled in
1.36**. Clone in an init container instead.

## Basic example

PostgreSQL in the lab mounts four volumes, three of them ephemeral:

```yaml include="examples/k8s/02-database/postgres.yaml" lines="75-84"
```

and declares them here:

```yaml include="examples/k8s/02-database/postgres.yaml" lines="108-120"
```

## Explanation

`data` is the PVC from the StatefulSet's `volumeClaimTemplates` — the only
volume whose contents survive the pod.

`run` and `tmp` are `emptyDir`s that exist purely because
`readOnlyRootFilesystem: true` makes everything else unwritable. That is the
standard pattern: make the root filesystem immutable, then hand back exactly the
directories the process must write. PostgreSQL needs its socket directory
(`/var/run/postgresql`) and `/tmp`, and nothing else.

`db-secret` mounts one key of the `tasklane-db` Secret as a file at
`/etc/tasklane/db/password`, using `items` so the rest of the Secret — if it
ever grows — is not exposed. The application reads the path from
`PGPASSWORD_FILE`. The password is therefore never an environment variable, so
it is not in `kubectl describe`, not in a crash dump and not in the process's
`/proc/self/environ`.

## Common patterns

**Read-only root plus targeted `emptyDir`s.** As above. Start with everything
read-only, add writable directories until the process stops complaining, and
give each one a `sizeLimit`.

**`medium: Memory` for sensitive scratch data**, remembering that it is charged
to the pod's memory limit — a 1Gi tmpfs inside a 512Mi limit is an OOM kill
waiting for a large file.

**Projected ServiceAccount tokens** rather than the legacy Secret-based ones:
bound audience, bound expiry, rotated automatically.

```yaml title="projected-token.yaml" fragment
volumes:
  - name: api-token
    projected:
      sources:
        - serviceAccountToken:
            path: token
            audience: vault
            expirationSeconds: 3600
```

**Generic ephemeral volumes** when a pod needs real, sized, provisioned storage
that should vanish with it — a large build cache, for example. You get a
StorageClass and capacity, without managing a PVC's lifecycle.

**`subPath` sparingly.** Mounting a single file into an existing directory is
useful, but such mounts never receive ConfigMap updates. `subPathExpr` at least
lets you compose the path from the downward API.

## Production considerations

`emptyDir` lives on the node's disk and counts towards ephemeral storage
eviction thresholds. A pod that writes logs to an unbounded `emptyDir` can
trigger `DiskPressure` and evict its neighbours. Always set `sizeLimit`, and set
`limits.ephemeral-storage` as well.

ConfigMap and Secret updates land in the tmpfs, but most applications never
re-read their files. Either watch the file, or roll the Deployment when config
changes — a checksum annotation on the pod template is the usual trick.

Volume mount failures are a common cause of pods stuck in `ContainerCreating`;
the events name the volume and the driver. `subPath` with a missing key, a
Secret that does not exist yet, and a `fsGroup` chown on a huge volume are the
three usual suspects.

Volume mount propagation (`mountPropagation: Bidirectional`) exists for drivers
that mount things for other pods. If you are not writing a CSI driver, you do
not need it, and it requires a privileged container.

## Security considerations

**`hostPath` is the vulnerability.** A writable `hostPath` of `/` gives a
container the node; `/var/run/docker.sock` or the containerd socket gives it
root on the node; `/var/lib/kubelet` gives it every Secret mounted on that node.
The restricted Pod Security profile forbids `hostPath` entirely, which is the
correct default. For node agents that genuinely need it, mount the narrowest
directory possible, read-only, in a dedicated privileged namespace.

Secrets in volumes beat secrets in environment variables: files can be scoped
with `items` and `defaultMode: 0400`, they are not inherited by child processes,
and they do not appear in `kubectl describe pod` or in most crash dumps. Set
`automountServiceAccountToken: false` on pods that never call the API, as every
Tasklane workload does.

An `emptyDir` is shared by every container in the pod, including an ephemeral
debug container someone attaches later. Do not treat it as a secret store.

Image volumes (`image:`) are read-only, which makes them a reasonable way to
ship data — but they are still a supply-chain input. Pin them by digest.

## Troubleshooting

```bash
kubectl -n tasklane describe pod <pod> | sed -n '/Volumes:/,/Events:/p'
kubectl -n tasklane get events --field-selector reason=FailedMount
```

`MountVolume.SetUp failed ... secret "x" not found` — the object does not exist
in that namespace. The pod retries forever; it will start the moment the object
appears.

`FailedAttachVolume` / `Multi-Attach error` — a `ReadWriteOnce` volume is still
attached to another node, usually because the previous pod's node is unhealthy.
The attach/detach controller resolves it after the node is confirmed gone, or
after `node.kubernetes.io/out-of-service` is applied.

Permission denied on write — check `fsGroup`, the container's UID, and whether
`readOnlyRootFilesystem` is the actual cause.

## Common mistakes

- **`hostPath` in an application pod** "just to write a file".
- **No `sizeLimit` on `emptyDir`**, filling the node's disk.
- **`medium: Memory` without accounting for the memory limit.**
- **Expecting a `subPath` mount to pick up ConfigMap changes.** It never will.
- **Secrets as environment variables** where a file would do.
- **Mounting a volume over a directory the image populated**, hiding its
  contents — the "empty data directory" mystery.
- **Assuming ConfigMap updates restart the pod.** They do not.

## Related topics

- [Persistent volumes and claims](persistent-volumes-and-claims.md)
- [Storage classes and CSI](storage-classes-and-csi.md)
- [StatefulSets](statefulsets.md)
- [ConfigMaps](../k8s-beginner/configmaps.md)
- [Secrets](../k8s-beginner/secrets.md)
- [Volumes, bind mounts and tmpfs in Docker](../docker-intermediate/volumes-bind-mounts-tmpfs.md)
- [Security context](../k8s-security/security-context.md)
