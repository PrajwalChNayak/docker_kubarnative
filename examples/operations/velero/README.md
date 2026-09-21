# Velero backup and restore for Tasklane

Back up the `tasklane` namespace with Velero, simulate data loss, and restore.

Written against Velero **v1.18.2**. The project moved to
`github.com/velero-io/velero` and is now a CNCF Sandbox project.

## You need object storage

> **Every step below marked [needs object storage] requires a configured
> BackupStorageLocation.** Velero writes backups to an S3-compatible bucket; it
> does not store them in the cluster.

Do **not** use MinIO: its repository was archived on 2026-04-25 and ships no
maintained binaries. For the backup target choose one of:

- A cloud object store: **AWS S3**, **Google Cloud Storage**, or **Azure Blob**
  (each has an official Velero provider plugin).
- A maintained self-hosted S3-compatible store: **SeaweedFS**, **Garage**, or
  **Ceph RGW**.

## Install

Either the CLI:

```bash
# [needs object storage] fill in your bucket, region and credentials file.
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:<PIN_PLUGIN_VERSION> \
  --bucket tasklane-backups \
  --backup-location-config region=<REGION>,s3Url=<S3_ENDPOINT> \
  --secret-file ./credentials-velero \
  --use-node-agent \
  --features EnableCSI
```

or Helm (the chart is still published as `vmware-tanzu/velero`):

```bash
helm repo add vmware-tanzu https://vmware-tanzu.github.io/helm-charts
helm install velero vmware-tanzu/velero \
  --namespace velero --create-namespace \
  --set-file credentials.secretContents.cloud=./credentials-velero \
  --set configuration.backupStorageLocation[0].bucket=tasklane-backups \
  --values <your-provider-values>.yaml
```

`--use-node-agent` runs the Kopia/restic node agent so PVs without CSI
snapshots can still be file-backed. `--features EnableCSI` turns on CSI
VolumeSnapshot backup where a `VolumeSnapshotClass` exists.

## Schedule

```bash
kubectl apply -f examples/operations/velero/schedule.yaml   # [needs object storage]
```

This creates a daily backup of the `tasklane` namespace with a 14-day TTL. The
same thing from the CLI:

```bash
velero schedule create tasklane-daily \
  --schedule="0 1 * * *" --include-namespaces tasklane --ttl 336h
```

## Disaster-recovery walkthrough

1. **Take a backup** [needs object storage]:

   ```bash
   velero backup create tasklane-manual --include-namespaces tasklane --wait
   velero backup describe tasklane-manual --details
   ```

2. **Simulate loss.** In the disposable lab only, delete the namespace:

   ```bash
   kubectl delete namespace tasklane
   ```

3. **Restore** [needs object storage]:

   ```bash
   velero restore create --from-backup tasklane-manual --wait
   velero restore describe <restore-name>
   kubectl -n tasklane get pods
   ```

4. **Verify** the API answers and the worker drains the backlog again.

## Volume data: CSI snapshot vs file backup

- **CSI VolumeSnapshot** — fast, storage-native, needs a CSI driver with a
  `VolumeSnapshotClass`. kind's default local-path provisioner has **no**
  snapshot support, so CSI snapshots do not work in the bare lab.
- **File backup (Kopia/restic)** — the node agent copies file contents into the
  backup bucket. Slower, but works on any volume. Enable it per-schedule with
  `defaultVolumesToFsBackup: true` (already noted in `schedule.yaml`).

## RPO and RTO

- **RPO** (how much data you can lose) is bounded by the schedule interval —
  daily here, so up to ~24h. Tighten it by scheduling more often.
- **RTO** (how long recovery takes) is dominated by volume-restore time. Test
  restores regularly; a backup you have never restored is a guess, not a plan.
