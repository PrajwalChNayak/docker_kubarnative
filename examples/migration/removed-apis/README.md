# removed-apis

A corpus of manifests on removed API versions, plus a Pluto detection script.

| File | Role |
|---|---|
| `legacy-manifests.yaml` | Five objects on REMOVED apiVersions. A 1.37 API server rejects all of them. This is the input Pluto scans. Do not apply. |
| `detect.sh` | Runs `pluto detect-files` (and shows the live-cluster form) from the Fairwinds OSS image, since Pluto is not on the maintainer PATH. |

## Old -> new apiVersions in this corpus

| Removed in | Old apiVersion / Kind | Migrate to |
|---|---|---|
| 1.16 | `extensions/v1beta1` Deployment | `apps/v1` |
| 1.22 | `extensions/v1beta1` Ingress | `networking.k8s.io/v1` |
| 1.25 | `batch/v1beta1` CronJob | `batch/v1` |
| 1.25 | `autoscaling/v2beta1` HorizontalPodAutoscaler | `autoscaling/v2` |
| 1.25 | `policy/v1beta1` PodSecurityPolicy | removed with no replacement; use Pod Security Admission or a policy engine |

The full table of every removed apiVersion, and the other detection methods
(the `apiserver_requested_deprecated_apis` metric, audit logs, the unmaintained
kubent), is in `content/migration/removed-api-versions.md`.

## Run the detection

```bash
bash examples/migration/removed-apis/detect.sh
```

Its captured output is requested in `captures/requests/migration.txt`.
