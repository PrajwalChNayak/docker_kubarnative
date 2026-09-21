---
title: Velero backup and restore
description: Back up namespaces and volumes with Velero, schedule backups, and run a disaster-recovery restore of Tasklane.
level: expert
type: tutorial
status: current
versions: Kubernetes 1.37, Velero 1.18
prerequisites:
  - operations/etcd-backup-and-restore
  - k8s-intermediate/volume-snapshots
---

## Overview

An etcd snapshot backs up cluster *state*, but not in a portable, selective way —
you cannot restore just one namespace, or move an app to a different cluster,
from an etcd backup. **Velero** does exactly that: it backs up chosen Kubernetes
objects to object storage and backs up **volume data** via CSI snapshots or file
copy, then restores them into the same or a different cluster. This tutorial
schedules a Tasklane backup and walks a full restore.

Written against **Velero v1.18.2** (now a CNCF Sandbox project at
`github.com/velero-io/velero`). Full commands are in the example:

- [examples/operations/velero/README.md](../../examples/operations/velero/README.md)

## What Velero backs up

- **API objects** — Deployments, Services, ConfigMaps, Secrets, PVCs, etc. for
  the selected namespaces/labels, written as a tarball to an object-storage
  bucket (the **BackupStorageLocation**).
- **Volume data** — either a **CSI VolumeSnapshot** (storage-native, fast, needs
  a CSI driver with a `VolumeSnapshotClass`) or a **filesystem copy** via
  **Kopia/restic** through the node agent (works on any volume, slower).

:::warning You need object storage — and not MinIO
Every backup step requires a configured object-storage bucket. **MinIO's
repository was archived in 2026 and ships no maintained binaries**, so do not use
it. Use a cloud store (**AWS S3**, **GCS**, **Azure Blob**) or a maintained
self-hosted S3-compatible store (**SeaweedFS**, **Garage**, **Ceph RGW**).
:::

## Step 1 — Install Velero

Install with the CLI (or the `vmware-tanzu/velero` Helm chart — see the README).
`--use-node-agent` enables Kopia file backup; `--features EnableCSI` enables CSI
snapshots:

```bash
velero install --provider aws \
  --plugins velero/velero-plugin-for-aws:<PIN_PLUGIN_VERSION> \
  --bucket tasklane-backups \
  --backup-location-config region=<REGION>,s3Url=<S3_ENDPOINT> \
  --secret-file ./credentials-velero \
  --use-node-agent --features EnableCSI
```

## Step 2 — Schedule a backup

A `Schedule` creates a `Backup` on a cron. This backs up the `tasklane`
namespace daily with a 14-day TTL:

```yaml include="examples/operations/velero/schedule.yaml"
```

```bash
kubectl apply -f examples/operations/velero/schedule.yaml
```

The schedule interval is your **RPO** for application state: daily means you
could lose up to a day. Tighten it by scheduling more often.

## Step 3 — Disaster-recovery walkthrough

1. **Take a backup** and confirm it completed:

   ```bash
   velero backup create tasklane-manual --include-namespaces tasklane --wait
   velero backup describe tasklane-manual --details
   ```

2. **Simulate loss** — in the disposable lab only:

   ```bash
   kubectl delete namespace tasklane
   ```

3. **Restore** from the backup:

   ```bash
   velero restore create --from-backup tasklane-manual --wait
   velero restore describe <restore-name>
   ```

4. **Verify** the API answers, the pods are Ready, and the worker drains the
   backlog again. Watch [the events](kubernetes-events.md) and
   [the metrics](prometheus-and-kube-prometheus.md) recover.

## CSI snapshot vs file backup

| | CSI VolumeSnapshot | File backup (Kopia/restic) |
|---|---|---|
| Speed | fast (storage-native) | slower (reads files) |
| Requirement | CSI driver + `VolumeSnapshotClass` | node agent only |
| Portability | tied to the storage backend | portable across clusters/storage |
| kind lab | **not available** (local-path has no snapshots) | works (`defaultVolumesToFsBackup: true`) |

Because the lab's local-path provisioner has no snapshot support, enable
file-level backup for volume data (`schedule.yaml` documents the toggle). See
[volume snapshots](../k8s-intermediate/volume-snapshots.md).

## RPO, RTO and DR discipline

- **RPO** = backup interval (how much data you can lose).
- **RTO** = restore time, dominated by volume-restore speed.
- **Test restores regularly.** A backup you have never restored is unproven.
  Restore into a scratch namespace or cluster on a schedule and verify the app.
- **Off-site and encrypted.** The bucket should be in a different failure domain
  from the cluster, encrypted at rest — it contains your Secrets.

## Common mistakes

- Assuming object-object API backup also captures **volume data** — it does not
  unless CSI snapshots or file backup are enabled.
- Trying to use MinIO as the target (archived/unmaintained).
- Backing up a namespace but never testing a restore, so RTO is unknown.
- Restoring over a live namespace and getting conflicts — restore into a clean
  namespace, or understand Velero's existing-resource policy.
- Storing backups in the same failure domain as the cluster they protect.

## Related topics

- [etcd backup and restore](etcd-backup-and-restore.md)
- [Volume snapshots](../k8s-intermediate/volume-snapshots.md)
- [Kubernetes events](kubernetes-events.md)
- [High availability control plane](high-availability-control-plane.md)
