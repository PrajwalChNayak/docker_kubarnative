---
title: Manifest field reference
description: The correct apiVersions and key fields for the common Kubernetes kinds on 1.37, verified with kubectl explain.
level: intermediate
type: reference
status: current
versions: Kubernetes 1.37, Gateway API 1.6.2
prerequisites:
  - k8s-beginner/manifest-anatomy
---

## Overview

A quick lookup for the `apiVersion`, `kind` and load-bearing fields of the kinds
you write most. Every `apiVersion` here was confirmed with
`kubectl explain <kind>` against the 1.37 client. For the full schema of any
field, run `kubectl explain <kind>.<path> --recursive`. For removed versions to
avoid, see [removed API versions](../migration/removed-api-versions.md).

## apiVersion quick table (1.37)

| Kind | apiVersion | Namespaced |
|---|---|---|
| Pod | `v1` | yes |
| Service, ConfigMap, Secret, ServiceAccount, PersistentVolumeClaim | `v1` | yes |
| PersistentVolume, Namespace, Node | `v1` | no |
| Deployment, StatefulSet, DaemonSet, ReplicaSet | `apps/v1` | yes |
| Job, CronJob | `batch/v1` | yes |
| HorizontalPodAutoscaler | `autoscaling/v2` | yes |
| Ingress, IngressClass, NetworkPolicy | `networking.k8s.io/v1` | Ingress/NetworkPolicy yes; IngressClass no |
| Gateway, GatewayClass, HTTPRoute, GRPCRoute | `gateway.networking.k8s.io/v1` | GatewayClass no; rest yes |
| Role, RoleBinding | `rbac.authorization.k8s.io/v1` | yes |
| ClusterRole, ClusterRoleBinding | `rbac.authorization.k8s.io/v1` | no |
| PodDisruptionBudget | `policy/v1` | yes |
| StorageClass, CSIDriver, VolumeAttachment | `storage.k8s.io/v1` | no |

Every object needs `metadata.name`; namespaced kinds need `metadata.namespace`
(or a default). Labels follow `app.kubernetes.io/*` conventions in this handbook.

## Workloads

### Pod (`v1`)

Key paths: `spec.containers[]` (`name`, `image`, `ports`, `env`, `envFrom`,
`resources`, `volumeMounts`, `securityContext`, `livenessProbe`,
`readinessProbe`, `startupProbe`), `spec.initContainers[]` (a container with
`restartPolicy: Always` is a sidecar, stable since 1.33),
`spec.volumes[]`, `spec.serviceAccountName`, `spec.securityContext` (pod-level:
`runAsNonRoot`, `runAsUser`, `fsGroup`, `seccompProfile`),
`spec.terminationGracePeriodSeconds`, `spec.nodeSelector`, `spec.affinity`,
`spec.tolerations`, `spec.topologySpreadConstraints`.

### Deployment (`apps/v1`)

`spec.replicas`, `spec.selector.matchLabels` (**required**, immutable),
`spec.template` (a Pod template), `spec.strategy` (`RollingUpdate` with
`maxUnavailable`/`maxSurge`, or `Recreate`), `spec.revisionHistoryLimit`,
`spec.minReadySeconds`, `spec.progressDeadlineSeconds`.

### StatefulSet (`apps/v1`)

As Deployment, plus `spec.serviceName` (headless Service),
`spec.volumeClaimTemplates[]`, `spec.podManagementPolicy`
(`OrderedReady`/`Parallel`), `spec.updateStrategy` (`RollingUpdate` with
`partition`, or `OnDelete`), and `spec.persistentVolumeClaimRetentionPolicy`.

### DaemonSet (`apps/v1`)

`spec.selector`, `spec.template`, `spec.updateStrategy`
(`RollingUpdate`/`OnDelete`). No `replicas` — one Pod per matching node.

### Job (`batch/v1`)

`spec.template` (`restartPolicy` must be `Never` or `OnFailure`),
`spec.completions`, `spec.parallelism`, `spec.backoffLimit`,
`spec.activeDeadlineSeconds`, `spec.ttlSecondsAfterFinished`,
`spec.completionMode` (`NonIndexed`/`Indexed`), `spec.podFailurePolicy`.

### CronJob (`batch/v1`)

`spec.schedule` (cron), `spec.timeZone`, `spec.jobTemplate` (a Job spec),
`spec.concurrencyPolicy` (`Allow`/`Forbid`/`Replace`),
`spec.startingDeadlineSeconds`, `spec.successfulJobsHistoryLimit`,
`spec.failedJobsHistoryLimit`, `spec.suspend`.

## Networking

### Service (`v1`)

`spec.type` (`ClusterIP`/`NodePort`/`LoadBalancer`/`ExternalName`),
`spec.selector`, `spec.ports[]` (`name`, `port`, `targetPort`, `protocol`,
`nodePort`), `spec.clusterIP` (`None` for headless),
`spec.sessionAffinity`, `spec.externalTrafficPolicy`,
`spec.internalTrafficPolicy`, `spec.ipFamilyPolicy`.

### Ingress (`networking.k8s.io/v1`, legacy)

`spec.ingressClassName`, `spec.rules[].host`,
`spec.rules[].http.paths[]` (`path`, `pathType`, `backend.service`),
`spec.tls[]` (`hosts`, `secretName`), `spec.defaultBackend`. Frozen API — prefer
Gateway API. See [ingress-legacy](../k8s-intermediate/ingress-legacy.md).

### Gateway (`gateway.networking.k8s.io/v1`)

`spec.gatewayClassName`, `spec.listeners[]` (`name`, `protocol`, `port`,
`hostname`, `tls.mode`, `tls.certificateRefs[]`, `allowedRoutes`),
`spec.addresses[]`. Read `status.conditions` (`Accepted`, `Programmed`).

### HTTPRoute (`gateway.networking.k8s.io/v1`)

`spec.parentRefs[]` (`name`, `sectionName`), `spec.hostnames[]`,
`spec.rules[]` with `matches[]` (`path`, `headers`, `queryParams`, `method`),
`filters[]` (`RequestRedirect`, `URLRewrite`, `RequestHeaderModifier`,
`ResponseHeaderModifier`, `RequestMirror`), and `backendRefs[]`
(`name`, `port`, `weight`).

### NetworkPolicy (`networking.k8s.io/v1`)

`spec.podSelector`, `spec.policyTypes` (`Ingress`/`Egress`),
`spec.ingress[]`/`spec.egress[]` with `from`/`to`
(`podSelector`, `namespaceSelector`, `ipBlock`) and `ports[]`. An empty
`podSelector: {}` selects all pods; a policy that selects a pod defaults it to
deny for the listed direction.

## Config and storage

### ConfigMap / Secret (`v1`)

ConfigMap: `data` (string), `binaryData`, `immutable`. Secret: `data`
(base64), `stringData` (plaintext in, stored base64), `type` (e.g.
`Opaque`, `kubernetes.io/tls`, `kubernetes.io/dockerconfigjson`), `immutable`.

### PersistentVolumeClaim (`v1`)

`spec.accessModes[]` (`ReadWriteOnce`/`ReadOnlyMany`/`ReadWriteMany`/
`ReadWriteOncePod`), `spec.resources.requests.storage`,
`spec.storageClassName`, `spec.volumeMode` (`Filesystem`/`Block`),
`spec.dataSource`/`spec.dataSourceRef` (clone or snapshot).

## Autoscaling, disruption, RBAC

### HorizontalPodAutoscaler (`autoscaling/v2`)

`spec.scaleTargetRef` (`apiVersion`, `kind`, `name`),
`spec.minReplicas`, `spec.maxReplicas`,
`spec.metrics[]` (`type`: `Resource`/`Pods`/`Object`/`External`, each with a
`target` block: `type` `Utilization`/`AverageValue`/`Value`),
`spec.behavior` (`scaleUp`/`scaleDown` with `stabilizationWindowSeconds`,
`policies[]`). The `v2beta1`/`v2beta2` metrics shape is removed — use the
structured `target` block.

### PodDisruptionBudget (`policy/v1`)

`spec.selector`, and exactly one of `spec.minAvailable` / `spec.maxUnavailable`
(integer or percentage), `spec.unhealthyPodEvictionPolicy`.

### ServiceAccount (`v1`)

`automountServiceAccountToken`, `secrets[]`, `imagePullSecrets[]`. Tasklane sets
`automountServiceAccountToken: false` where the pod never calls the API.

### Role / RoleBinding (`rbac.authorization.k8s.io/v1`)

Role: `rules[]` (`apiGroups`, `resources`, `resourceNames`, `verbs`). RoleBinding:
`roleRef` (`apiGroup`, `kind`, `name` — immutable) and `subjects[]`
(`kind` `User`/`Group`/`ServiceAccount`, `name`, `namespace`). `ClusterRole`
adds `aggregationRule`.

## Common mistakes

- **Using a removed `apiVersion`.** The old `v1beta1`/`v1beta2` workload groups,
  the `v2beta1`/`v2beta2` HPA groups, the beta CronJob, PDB and Ingress groups
  are all gone — see the
  [removed API versions table](../migration/removed-api-versions.md).
- **Omitting `spec.selector` on a Deployment/StatefulSet.** It is required and
  must match the template labels.
- **The old flat HPA metric.** `targetAverageUtilization` became a `target`
  block in `autoscaling/v2`.
- **Setting both `minAvailable` and `maxUnavailable` on a PDB.** Set exactly one.
- **Putting plaintext in Secret `data`.** `data` is base64; use `stringData` for
  plaintext input.
- **Forgetting `metadata.namespace`** on a namespaced object applied outside its
  intended namespace.

## Related topics

- [Manifest anatomy](../k8s-beginner/manifest-anatomy.md)
- [Removed API versions](../migration/removed-api-versions.md)
- [kubectl cheat sheet](kubectl-cheat-sheet.md)
- [Glossary](glossary.md)
