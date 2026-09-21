# Stage 7: disruption budgets, a maintenance CronJob, and snapshots

Kubernetes 1.37.

| File | Runs in the lab? |
|---|---|
| `10-pdb.yaml` | yes |
| `20-cronjob.yaml` | yes |
| `30-volume-snapshot.yaml` | **no — needs a CSI driver with snapshot support** |
| `40-volume-group-snapshot.yaml` | **no — needs a CSI driver with GROUP_CONTROLLER support** |

## PodDisruptionBudgets

```bash
kubectl apply -f examples/k8s/07-reliability/10-pdb.yaml
kubectl -n tasklane get poddisruptionbudget
```

`ALLOWED DISRUPTIONS` is the number the eviction API will currently grant. It
is `0` whenever the workload is already at its floor, and that is the whole
point: `kubectl drain` blocks instead of taking the last healthy replica.

See it work — this drains a real node, so only do it in the lab:

```bash
kubectl get nodes
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data --timeout=120s
kubectl uncordon <node>
```

(kind names the nodes `tasklane-control-plane`, `tasklane-worker` and
`tasklane-worker2`. The node `tasklane-worker` is not the Tasklane worker
Deployment; pick a node that actually runs API pods, from
`kubectl -n tasklane get pods -o wide`.)

Watch the API pods reappear on the other node while the budget keeps one
serving throughout. `kubectl drain` evicts through the eviction subresource,
which is what consults the PDB; `kubectl delete pod` bypasses it entirely.

## The cleanup CronJob

```bash
kubectl apply -f examples/k8s/07-reliability/20-cronjob.yaml
kubectl -n tasklane get cronjob tasklane-cleanup
```

Do not wait until 02:30 to find out whether it works. Trigger it by hand:

```bash
kubectl -n tasklane create job --from=cronjob/tasklane-cleanup cleanup-manual
kubectl -n tasklane wait --for=condition=Complete job/cleanup-manual --timeout=120s
kubectl -n tasklane logs job/cleanup-manual
```

`psql` prints the row count it deleted (`DELETE 0` on a fresh database). The
Job is deleted automatically 24 hours after it finishes
(`ttlSecondsAfterFinished`); the manual one above is not on that schedule
unless you copied the field, so remove it yourself:

```bash
kubectl -n tasklane delete job cleanup-manual
```

If stage 6 is applied, this pod is allowed through to PostgreSQL by
`50-maintenance.yaml`, which matches its
`app.kubernetes.io/component: maintenance` label. Remove that label and the
pod hangs on connect — a good way to prove the policy is live.

## Snapshots

These need three things the lab does not have:

1. the external-snapshotter CRDs (`snapshot.storage.k8s.io` and
   `groupsnapshot.storage.k8s.io`),
2. the snapshot-controller Deployment,
3. a CSI driver that implements `CREATE_DELETE_SNAPSHOT` (and, for group
   snapshots, the `GROUP_CONTROLLER` service).

kind's default StorageClass is `standard`, backed by the local-path provisioner:
it hands out directories on the node's filesystem and has no snapshot support at
all. `kubectl get storageclass` and `kubectl get volumesnapshotclass` tell you
where you stand — the second command fails outright when the CRDs are missing,
which is the expected result here.

To try it for real, install the external-snapshotter CRDs and controller, then
the CSI hostpath driver, and change `driver:` in both files if you use
something else. On a managed cluster, use that cloud's driver name
(`ebs.csi.aws.com`, `pd.csi.storage.gke.io`, `disk.csi.azure.com`).

Group membership is by PVC label, so a volume joins the group like this:

```bash
kubectl -n tasklane label pvc data-postgres-0 tasklane.example.com/backup-group=postgres
```

A snapshot is not a backup. It lives in the same storage system as the volume,
it is usually crash-consistent rather than application-consistent, and deleting
the namespace can delete it with `deletionPolicy: Delete`. For PostgreSQL, take
a logical dump or use continuous archiving as well; see Part J for Velero and
backup strategy.
