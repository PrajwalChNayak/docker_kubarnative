---
title: Removed API versions and how to find them
description: The complete list of removed Kubernetes API versions, how to detect them before an upgrade, and how to fix them.
level: intermediate
type: migration
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/manifest-anatomy
  - operations/deprecated-api-detection
---

## Overview

Kubernetes graduates APIs from alpha to beta to GA, and eventually removes the
old beta versions. A manifest, chart or controller that still names a removed
`apiVersion` breaks the moment the cluster reaches the release that drops it —
`kubectl apply` returns `no matches for kind ... in version ...`. This page
gives the complete, verified list of removed versions, three ways to detect them
before they bite, how to fix them, and the deprecation policy that lets you
predict the next removal.

The good news for current clusters: **nothing was removed in 1.33, 1.34, 1.35,
1.36 or 1.37.** The most recent API-version removal was **1.32**
(`flowcontrol.apiserver.k8s.io/v1beta3`). So an upgrade within the supported
range removes no APIs — but charts and manifests carried forward from older
clusters may still reference versions removed years ago.

## The complete removed-version table

From the official Deprecated API Migration Guide. Anything in this table is
**not served by 1.37** and must be rewritten.

| Removed in | group/version → Kind | Migrate to |
|---|---|---|
| **1.32** | `flowcontrol.apiserver.k8s.io/v1beta3` → FlowSchema, PriorityLevelConfiguration | `flowcontrol.apiserver.k8s.io/v1` |
| 1.29 | `flowcontrol.apiserver.k8s.io/v1beta2` → FlowSchema, PriorityLevelConfiguration | `…/v1` |
| 1.27 | `storage.k8s.io/v1beta1` → CSIStorageCapacity | `storage.k8s.io/v1` |
| 1.26 | `flowcontrol.apiserver.k8s.io/v1beta1` → FlowSchema, PriorityLevelConfiguration | `…/v1beta2` (also later removed) |
| 1.26 | `autoscaling/v2beta2` → HorizontalPodAutoscaler | `autoscaling/v2` |
| **1.25** | `batch/v1beta1` → CronJob | `batch/v1` |
| 1.25 | `discovery.k8s.io/v1beta1` → EndpointSlice | `discovery.k8s.io/v1` |
| 1.25 | `events.k8s.io/v1beta1` → Event | `events.k8s.io/v1` |
| 1.25 | `autoscaling/v2beta1` → HorizontalPodAutoscaler | `autoscaling/v2` |
| 1.25 | `policy/v1beta1` → PodDisruptionBudget | `policy/v1` |
| 1.25 | `policy/v1beta1` → PodSecurityPolicy | **removed, no replacement** — use Pod Security Admission |
| 1.25 | `node.k8s.io/v1beta1` → RuntimeClass | `node.k8s.io/v1` |
| **1.22** | `extensions/v1beta1`, `networking.k8s.io/v1beta1` → Ingress | `networking.k8s.io/v1` |
| 1.22 | `networking.k8s.io/v1beta1` → IngressClass | `networking.k8s.io/v1` |
| 1.22 | `admissionregistration.k8s.io/v1beta1` → Mutating/ValidatingWebhookConfiguration | `…/v1` |
| 1.22 | `apiextensions.k8s.io/v1beta1` → CustomResourceDefinition | `…/v1` |
| 1.22 | `apiregistration.k8s.io/v1beta1` → APIService | `…/v1` |
| 1.22 | `authentication.k8s.io/v1beta1` → TokenReview | `…/v1` |
| 1.22 | `authorization.k8s.io/v1beta1` → SubjectAccessReview and friends | `…/v1` |
| 1.22 | `certificates.k8s.io/v1beta1` → CertificateSigningRequest | `…/v1` |
| 1.22 | `coordination.k8s.io/v1beta1` → Lease | `…/v1` |
| 1.22 | `rbac.authorization.k8s.io/v1beta1` → Role, RoleBinding, ClusterRole, ClusterRoleBinding | `…/v1` |
| 1.22 | `scheduling.k8s.io/v1beta1` → PriorityClass | `…/v1` |
| 1.22 | `storage.k8s.io/v1beta1` → CSIDriver, CSINode, StorageClass, VolumeAttachment | `storage.k8s.io/v1` |
| **1.16** | `extensions/v1beta1` → NetworkPolicy | `networking.k8s.io/v1` |
| 1.16 | `extensions/v1beta1`, `apps/v1beta2` → DaemonSet | `apps/v1` |
| 1.16 | `extensions/v1beta1`, `apps/v1beta1`, `apps/v1beta2` → Deployment, ReplicaSet | `apps/v1` |
| 1.16 | `apps/v1beta1`, `apps/v1beta2` → StatefulSet | `apps/v1` |

:::note Related but not API-version removals
The gitRepo volume driver (disabled in 1.36) and the static-pod
Secret/ConfigMap opt-out gate (removed in 1.37) are *feature* removals, not
API-version removals, so detectors that scan `apiVersion` will not flag them.
:::

## How to detect

### 1. Pluto — scan files and live objects

Pluto is the recommended detector (kubent is effectively unmaintained; see
below). The worked example is in `examples/migration/removed-apis/`, whose
`legacy-manifests.yaml` deliberately uses removed versions. Because Pluto is not
on the maintainer PATH as a binary, run it from the Fairwinds OSS image:

```bash include="examples/migration/removed-apis/detect.sh"
```

`detect-files` scans static manifests and charts (use it in CI); `detect -` on a
`kubectl get ... -o yaml` pipe scans what is already live. Pluto exits non-zero
on a *removed* version, so it works as a gate.

### 2. The apiserver metric

The API server counts requests to deprecated APIs:

```bash
kubectl get --raw /metrics | grep apiserver_requested_deprecated_apis
```

Each series is labelled with `group`, `version`, `resource` and the
`removed_release`. A non-zero counter means something in the cluster is still
*using* a deprecated version right now — more actionable than a static scan,
because it names live traffic. Wire it into Prometheus and alert on it.

### 3. Audit logs

If audit logging is on, deprecated-API requests carry the annotation
`k8s.io/deprecated: "true"` and a `k8s.io/removed-release` annotation. Audit
logs additionally tell you *who* (which user or controller) made the request, so
you can chase down the offending client, not just the object.

:::warning kubent is unmaintained
`kube-no-trouble` (kubent) was a popular detector, but its last release (0.7.3)
was 2024 and it is effectively unmaintained. Prefer Pluto for anything new.
:::

## How to fix

1. **Find every source**, not just live objects: Git repos, Helm charts,
   Kustomize bases, operators and their CRDs. A removed version often hides in a
   third-party chart.
2. **Rewrite the `apiVersion`** to the target from the table. For most workloads
   the schema is compatible (`apps/v1beta1` → `apps/v1` Deployment needs a
   `selector`, which `apps/v1` requires). HPA `v2beta1`/`v2beta2` → `v2` changes
   the metrics field shape, so re-check those.
3. **Bump chart dependencies** to versions that emit current APIs, rather than
   editing rendered output.
4. **Re-apply and re-scan** with Pluto and the metric until both are clean.
5. **Do it before the upgrade**, on the current cluster, where the old versions
   are still served and `--dry-run=server` can validate the new ones.

## The deprecation policy

Removals are predictable, which is the whole point of the policy:

- **GA (`v1`) APIs must not be removed within a major version.** `v1` is safe;
  that is why the table is entirely `beta`/`alpha` sources.
- **Beta APIs are supported for 3 releases after deprecation** (or 9 months,
  whichever is longer).
- **Alpha APIs may be removed at any time**, with no notice.

So the way to never be surprised is to run GA APIs, watch the deprecation
warnings the API server already prints on apply, and scan before each upgrade.

## Common mistakes

- **Scanning only live objects.** The removed version may sit dormant in a Git
  repo or chart and only reappear on the next apply. Scan files too.
- **Assuming a version bump is schema-free.** HPA and a few others changed
  fields; validate with `--dry-run=server`.
- **Trusting kubent.** It is stale; use Pluto.
- **Editing rendered chart output** instead of upgrading the chart, so the fix
  is lost on the next `helm upgrade`.
- **Waiting until after the upgrade**, when the old API is already gone and you
  cannot `kubectl get` the offending objects to migrate them.

## Related topics

- [Deprecated API detection](../operations/deprecated-api-detection.md)
- [Cluster upgrades](../operations/cluster-upgrades.md)
- [From PodSecurityPolicy to Pod Security Admission](psp-to-pod-security-admission.md)
- [Manifest field reference](../reference/manifest-field-reference.md)
- [Version matrix](../reference/version-matrix.md)
