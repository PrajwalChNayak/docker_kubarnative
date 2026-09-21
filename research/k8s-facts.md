# Kubernetes handbook fact-check (verified 2026-09-21)

The rule for this file is that every fact comes from a primary source fetched on 2026-09-21: kubernetes.io, github.com/kubernetes*, gateway-api.sigs.k8s.io, endoflife.date, github.com/cncf, or training.linuxfoundation.org.
Where two primary sources disagree, both are listed under **CONFLICT**.
**UNVERIFIED** means no primary source confirmed the claim.

Abbreviations: FG = feature gate. Feature-gate table = https://kubernetes.io/docs/reference/command-line-tools-reference/feature-gates/

---

## 1. Kubernetes v1.37 "Garhwal" (released 2026-08-26)

Source: https://kubernetes.io/blog/2026/08/26/kubernetes-v1-37-release/

- The codename **Garhwal** is confirmed. It refers to a Himalayan region of Uttarakhand, India. The release lead was Dipesh Rawat. The release cycle ran 15 weeks, from 2026-05-18 to 2026-08-26.
- Enhancement counts from the blog: 67 total, with 16 graduating to Stable, 23 to Beta, 27 entering Alpha, and 1 deprecation/removal.
  - **Note:** the blog's own "Graduations to Stable" list actually contains 17 entries, although it says 16.
- Sneak peek (deprecations): https://kubernetes.io/blog/2026/07/31/kubernetes-v1-37-sneak-peek/
- Changelog: https://github.com/kubernetes/kubernetes/blob/master/CHANGELOG/CHANGELOG-1.37.md

| Claimed change | Verified maturity in 1.37 | FG | Default | Source |
|---|---|---|---|---|
| Storage Version Migration GA + default-on | **Stable (GA)**, enabled by default. The API is `storagemigration.k8s.io/v1` and there is a built-in StorageVersionMigrator controller (KEP-4192). | `StorageVersionMigrator` | on (per blog and KEP) | https://kubernetes.io/blog/2026/08/31/kubernetes-v1-37-storage-version-migration-ga/ ; KEP kep.yaml (stable: v1.37) https://github.com/kubernetes/enhancements/blob/master/keps/sig-api-machinery/4192-svm-in-tree/kep.yaml . **CONFLICT:** the docs feature-gate table and `StorageVersionMigrator.md` still show only "Beta 1.35, default false". The task page https://kubernetes.io/docs/tasks/manage-kubernetes-objects/storage-version-migration/ says "Beta since v1.35; disabled by default" in its header, but says "enabled by default in all clusters" in its body. The docs are stale. |
| Metrics API stable | **Stable.** `metrics.k8s.io/v1` (NodeMetrics, PodMetrics) is identical to v1beta1 apart from the version, and v1beta1 is still served. No FG is involved; the API is served via aggregation (e.g. metrics-server). `kubectl top` prefers v1. **The HPA controller supports only v1beta1 in 1.37.** (KEP-5207) | none | n/a | https://kubernetes.io/blog/2026/08/27/kubernetes-v1-37-metrics-api-ga/ |
| HPA scale-to-zero Beta | **Beta**, on by default. It needs `minReplicas: 0` plus at least one Object or External metric; an HPA with only resource metrics (CPU/memory) is rejected. It adds a `ScaledToZero` condition (reason `NotScaledToZero` when back up). The FG applies to both kube-apiserver and kube-controller-manager. Alpha 1.16–1.36. KEP-2021. | `HPAScaleToZero` | true | https://kubernetes.io/blog/2026/09/02/kubernetes-v1-37-hpa-scale-to-zero-beta/ ; feature-gate table rows `HPAScaleToZero false Alpha 1.16–1.36` / `true Beta 1.37` ; https://github.com/kubernetes/enhancements/blob/master/keps/sig-autoscaling/2021-scale-from-zero/kep.yaml |
| Kubelet in user namespace (rootless) Beta | **Beta**, FG enabled by default. Enabling the gate does **not** make the kubelet rootless; the user namespace must be created outside Kubernetes (e.g. rootless Docker, kind, minikube, Usernetes, k3s). `NodeSystemInfo.runningInUserNamespace` is new. Alpha since 1.22. KEP-2033. This is **not** the same thing as pod user namespaces (`hostUsers: false`), which went GA in 1.36. **Note:** the main release blog does not mention this feature; only the sneak peek and the feature blog do. | `KubeletInUserNamespace` | true | https://kubernetes.io/blog/2026/09/04/kubernetes-v1-37-rootless-beta/ ; feature-gate table |
| Memory QoS Beta | **Beta**, FG enabled by default, cgroup v2 only. The default `memoryThrottlingFactor` changed to **null** (it was 0.9 in alpha), and `memoryReservationPolicy` defaults to `None`, so nothing is written unless you configure it. `TieredReservation` enables memory.min/memory.low. KEP-2570. | `MemoryQoS` | true | https://kubernetes.io/blog/2026/09/14/kubernetes-v1-37-memory-qos-graduates-to-beta/ |
| Pod-level resource managers Beta | **Beta, but disabled by default.** It lets the Topology, CPU and Memory managers use pod-level `.spec.resources` for NUMA alignment. Alpha was 1.36; the KEP targets GA in 1.39. KEP-5526. | `PodLevelResourceManagers` | **false** | https://kubernetes.io/blog/2026/09/15/kubernetes-v1-37-pod-level-resource-managers-beta/ ; https://github.com/kubernetes/enhancements/blob/master/keps/sig-node/5526-pod-level-resource-managers/kep.yaml |
| Native histograms Beta | **Beta, enabled by default.** Components expose classic and native histograms side by side ("dual exposition") when scraped with PrometheusProto. Alpha was 1.36. KEP-5808. The main release blog only says "When enabled…"; the feature blog and the FG table both say default on. | `NativeHistograms` | true | https://kubernetes.io/blog/2026/09/11/kubernetes-v1-37-native-histograms-beta/ ; feature-gate table |
| Pod certificates + ClusterTrustBundles | **Both Stable (GA) in 1.37.** Both use `certificates.k8s.io/v1`: the PodCertificateRequest kind and the ClusterTrustBundle kind. The `podCertificate` and `clusterTrustBundle` projected volume sources are included. Kubernetes ships no built-in pod-cert signer yet, so you need a third-party signer. Pod certs went Alpha 1.34 → Beta 1.35 → GA 1.37 (KEP-4317). CTB went Alpha 1.27/1.29 → Beta 1.33 → GA 1.37 (KEP-3257). | `PodCertificateRequest`, `ClusterTrustBundle`, `ClusterTrustBundleProjection` | true | https://kubernetes.io/blog/2026/08/28/kubernetes-v1-37-pod-certificates-and-cluster-trust-bundles/ ; https://kubernetes.io/docs/reference/access-authn-authz/certificate-signing-requests/ ("Stable since Kubernetes v1.37; enabled by default") |
| etcd RangeStream | **Beta, on by default. It went straight to Beta with no Alpha.** It applies to kube-apiserver only and requires etcd **v3.7+**. With older etcd it falls back to unary Range automatically. Verify with the metric `etcd_request_duration_seconds_count{operation="listStream"}`. KEP-5966. | `EtcdRangeStream` | true | https://kubernetes.io/blog/2026/09/01/kubernetes-v1-37-etcd-range-stream/ |

**DRA in 1.37.** Sources: https://kubernetes.io/blog/2026/09/03/kubernetes-v1-37-dra-updates/ and the release blog.
- **Stable:**
  - Extended resource requests via DRA (KEP-5004, FG `DRAExtendedResource`)
  - ResourceClaim `.status.devices` with standardized network interface data (KEP-4817, `DRAResourceClaimDeviceStatus`)
  - Device taints and tolerations plus DeviceTaintRule (KEP-5055, `DRADeviceTaints`)
  - Standard `resource.kubernetes.io/numaNode` attribute (KEP-6072; no FG, landed directly as Stable)
- **Beta:**
  - ResourceClaim support for Workloads/PodGroups (KEP-5729, `DRAWorkloadResourceClaims`, **off by default**)
  - DRA Device Attributes Downward API (KEP-5304)
  - Fractional values in consumable capacity (KEP-5075, FG `DRAFractionalCapacityRange` Beta)
- **Alpha:**
  - List-type attributes (KEP-5491, 2nd alpha)
  - Node allocatable resource requests (KEP-5517, 2nd alpha)
  - Resource availability visibility / ResourcePoolStatusRequest (KEP-5677, 2nd alpha)
  - Optional node operations (KEP-5945)
  - Derived attributes via CEL (KEP-6080)
  - Device compatibility groups (KEP-5963, `DRADeviceCompatibilityGroups`)
  - PreQueueingHint extension point (KEP-6132, `SchedulerPreQueueingHints`)

**Other major 1.37 changes** (all from the release blog):
- **Stable:**
  - Resilient watchcache init (`WatchCacheInitializationPostStartHook` locked on, KEP-4568)
  - KYAML (`kubectl get -o kyaml`, KEP-5295)
  - SELinuxMount (KEP-1710): see the 1.36 section. `SELinuxMount` is **Stable and default-on in 1.37**. It only takes effect when the CSIDriver sets `seLinuxMount: true`. Opt out per Pod with `seLinuxChangePolicy: Recursive`. The behaviour is not locked until 1.38.
  - Node declared features (`.status.declaredFeatures`, KEP-5328)
  - Arbitrary FQDN pod hostname (KEP-4762)
  - HPA configurable tolerance (KEP-4951)
  - Relaxed Service name validation (KEP-5311)
  - Resource health status in Pod status (KEP-4680)
  - Sandbox-creation pod condition (KEP-3085)
- **Beta:**
  - Gang scheduling via Workload/PodGroup (KEP-4671)
  - Workload-aware preemption (KEP-5710)
  - Manifest-based admission control config (`staticManifestsDir` in AdmissionConfiguration, KEP-5793)
  - CRI-full container/pod stats (`PodAndContainerStatsFromCRI`, **off by default**)
  - Watch-based route controller reconciliation (`CloudControllerManagerWatchBasedRoutesReconciliation`, off)
  - Storage capacity scoring (`StorageCapacityScoring`)
  - CSI attach limits in Cluster Autoscaler (`VolumeLimitScaling`)
  - PVC Unused condition (`PersistentVolumeClaimUnusedSinceTime`, default on)
  - Undecryptable-resource deletion (KEP-3926)
  - Stale controller mitigation, extended to HPA (KEP-5647)
  - `ConcurrentWatchObjectDecode` flipped to default on
- **Alpha:**
  - Pod-level checkpoint/restore (KEP-5823)
  - StatefulSet `Recreate` strategy (`StatefulSetRecreateStrategy`)
  - Scheduler preemption for in-place resize (`InPlacePodVerticalScalingSchedulerPreemption`)
  - In-place resize of memory-backed emptyDir (`InPlacePodVerticalScalingMemoryBackedVolumes`)
  - Node lifecycle conditions (DrainInProgress, Drained, MaintenancePlanned, MaintenanceInProgress, GracefulNodeShutdownInProgress)
  - CompositePodGroup API
  - WAS controller APIs
  - Job `spec.scheduling`
  - nftables localhost NodePort proxy
- **Other:**
  - StatefulSet `maxUnavailable` is back on by default after the 1.36 bug (kubernetes#137409).
  - kube-proxy nftables now uses netlink.

**1.37 deprecations and removals:**
- **kube-dns deprecated.** No new kube-dns packages are expected after v1.40; migrate to CoreDNS.
- **kube-proxy ipvs mode deprecated.** It logs a startup warning. It is expected to be disabled by default by v1.40 and removed by v1.43 (KEP-5495).
  - Note: the 1.35 blog had already announced the ipvs deprecation.
- **`kubectl run --filename/-f`** is being deprecated (kubernetes#138671).
- **Static Pods can no longer reference Secrets or ConfigMaps.** The `PreventStaticPodAPIReferences` opt-out gate was removed (kubernetes#140226).
- **cgroup v1 (ongoing).** `failCgroupV1` has defaulted to true since 1.35. The `failCgroupV1: false` override still works in 1.37, and removal is planned for a "future release" (KEP-5573).

---

## 2. Kubernetes v1.36 "ハル (Haru)" (released 2026-04-22)

Source: https://kubernetes.io/blog/2026/04/22/kubernetes-v1-36-release/
- 70 enhancements: 18 Stable, 25 Beta, 25 Alpha. The release lead was Ryota Sawada.

| Claim | Verified | Source |
|---|---|---|
| User Namespaces GA | **TRUE.** `UserNamespacesSupport` is Stable in 1.36 (KEP-127) and is used via `hostUsers: false`. | https://kubernetes.io/blog/2026/04/23/kubernetes-v1-36-userns-ga/ ; FG table |
| "In-Place Vertical Scaling Beta" | **Needs precise wording.** Container-level in-place Pod resize (`InPlacePodVerticalScaling`, KEP-1287) went **GA in 1.35**. What went **Beta in 1.36** is **In-Place Pod-Level Resources Vertical Scaling** (`InPlacePodLevelResourcesVerticalScaling`, default **on**; Alpha 1.35). That feature resizes the aggregate pod-level `.spec.resources` through the `resize` subresource. It needs cgroup v2 and a CRI that supports UpdateContainerResources. `resizePolicy` is **not** supported at pod level; the per-container resizePolicy decides whether a container restarts. **There is no contradiction: GA is container-level, Beta is pod-level.** (Pod-Level Resources itself, `PodLevelResources`, has been Beta since 1.34.) | https://kubernetes.io/blog/2026/04/30/kubernetes-v1-36-inplace-pod-level-resources-beta/ ; FG table |
| PSI metrics GA | **TRUE.** `KubeletPSI` is Stable in 1.36 (Alpha 1.33, Beta 1.34) and needs no opt-in. It exposes node, pod and container CPU/memory/IO pressure and requires cgroup v2 with kernel PSI enabled. KEP-4205. | https://kubernetes.io/blog/2026/05/12/kubernetes-v1-36-psi-metrics-ga/ |
| Volume Group Snapshots GA | **TRUE.** The API is `groupsnapshot.storage.k8s.io/v1` (VolumeGroupSnapshot, VolumeGroupSnapshotContent, VolumeGroupSnapshotClass). These are CRDs from the CSI snapshotter, not core. KEP-3476. | https://kubernetes.io/blog/2026/05/08/kubernetes-v1-36-volume-group-snapshot-ga/ |
| Declarative Validation GA | **TRUE.** `DeclarativeValidation` is Stable in 1.36 (KEP-5073). The new `DeclarativeValidationBeta` gate (Beta 1.36, default true) controls enforcement of `+k8s:beta` rules. `DeclarativeValidationTakeover` is deprecated. | https://kubernetes.io/blog/2026/05/05/kubernetes-v1-36-declarative-validation-ga/ ; FG table |
| Fine-grained kubelet API authz GA | **TRUE.** `KubeletFineGrainedAuthz` is GA and locked in 1.36 (Alpha 1.32, Beta 1.33). KEP-2862. | https://kubernetes.io/blog/2026/04/24/kubernetes-v1-36-fine-grained-kubelet-authorization-ga/ |
| SELinux volume label changes GA | **PARTIAL / nuance.** The 1.36 release blog says it is "generally available". The detail blog says `SELinuxMountReadWriteOncePod` is GA in 1.36 and `SELinuxChangePolicy` is Stable in 1.36, **but `SELinuxMount` is Beta and disabled by default in 1.36**. `SELinuxMount` went Stable and default-on in **1.37**. KEP-1710 appears in both the 1.36 and 1.37 GA lists. | https://kubernetes.io/blog/2026/04/22/breaking-changes-in-selinux-volume-labeling/ ; FG table (`SELinuxMount` Beta 1.33–1.36, Stable 1.37) |
| Service externalIPs deprecation/removal | **Deprecated in 1.36** (warnings are emitted; KEP-5707). **Not removed.** The timeline from the detail blog is: kube-proxy support disabled by default with an opt-back-in in **v1.40 at the earliest**, and support disabled completely in **v1.43 at the earliest**. The release blog phrases this as "full removal planned for v1.43". You can use the `DenyServiceExternalIPs` admission plugin now. | https://kubernetes.io/blog/2026/05/14/kubernetes-v1-36-deprecation-and-removal-of-service-externalips/ |
| Server-side sharded list and watch | **Alpha in 1.36** (KEP-5866), FG `ShardedListAndWatch` (default false). It adds `shardSelector` to ListOptions using `shardRange(object.metadata.uid \| object.metadata.namespace, start, end)` with an FNV-1a 64-bit hash. | https://kubernetes.io/blog/2026/05/06/kubernetes-v1-36-server-side-sharded-list-and-watch/ |

**Other 1.36 Stable graduations:**
- External ServiceAccount token signing (KEP-740)
- MutatingAdmissionPolicy (KEP-3962)
- Node log query (KEP-2258)
- OCI image volume source (KEP-4639, `ImageVolume`)
- Mutable CSINode allocatable (KEP-4876)
- DRA prioritized list (KEP-4816)
- DRA admin access (KEP-5018)
- ProcMount (KEP-4265)
- DRA PodResources (KEP-3695)
- CPU manager split L3 cache (KEP-5109)
- gogo protobuf removal (KEP-5589; also listed in the 1.35 GA list)
- CSI SA tokens via secrets field (KEP-5538)
- Portworx CSI migration (KEP-2589)

**Other 1.36 changes:**
- **Beta:**
  - Staleness mitigation (KEP-5647)
  - StrictIPCIDRValidation
  - kuberc credential plugin policy
  - MutablePodResourcesForSuspendedJobs
  - ConstrainedImpersonation
  - ComponentStatusz and ComponentFlagz
  - Mixed version proxy
  - Memory QoS refinements (the Beta graduation itself was 1.37)
  - Resource health status
- **Alpha:**
  - HPAScaleToZero continued
  - Native histograms
  - Manifest-based admission config
  - CRI list streaming
  - Workload Aware Scheduling (Workload API and PodGroup)
  - Pod-level resource managers

**1.36 deprecations and removals:**
- `Service.spec.externalIPs` deprecated (see the table above).
- **gitRepo volume driver permanently disabled** (KEP-5040; it had been deprecated since v1.11).
- The Ingress NGINX retirement is noted (see section 7).

---

## 3. Kubernetes v1.35 "Timbernetes (The World Tree Release)" (released 2025-12-17)

Source: https://kubernetes.io/blog/2025/12/17/kubernetes-v1-35-release/
- The blog gives three different counts:
  - The header says 60 enhancements (17 stable, 19 beta, 22 alpha).
  - The GA list heading says "15 enhancements promoted to stable".
  - The GA list itself contains 14 items.

| Claim | Verified | Source |
|---|---|---|
| In-Place Pod Resize GA | **TRUE.** KEP-1287 and `InPlacePodVerticalScaling` are Stable in 1.35 (Alpha 1.27, Beta 1.33). This is container-level resize. | release blog; FG table |
| Job managedBy GA | **TRUE.** KEP-4368 and `JobManagedBy` are Stable in 1.35 (driven by MultiKueue). | release blog; FG table; https://github.com/kubernetes/enhancements/blob/master/keps/sig-apps/4368-support-managed-by-for-batch-jobs/kep.yaml |
| Kubelet config drop-in dir GA | **TRUE.** KEP-3983 is Stable in 1.35 (Alpha 1.28, Beta 1.31). It uses `--config-dir`, with files that must end in `.conf`, sorted alphanumerically. | release blog; https://github.com/kubernetes/enhancements/blob/master/keps/sig-node/3983-drop-in-configuration/kep.yaml ; https://kubernetes.io/docs/tasks/administer-cluster/kubelet-config-file/ |
| Fine-grained SupplementalGroups GA | **TRUE per the release blog and the KEP** (KEP-3619 kep.yaml: stable v1.35). **CONFLICT:** the docs still show `SupplementalGroupsPolicy` as "Beta since v1.33; enabled by default" in both the FG table and the security-context task page. Those docs pages are stale. | release blog; https://github.com/kubernetes/enhancements/blob/master/keps/sig-node/3619-supplemental-groups-policy/kep.yaml ; https://kubernetes.io/docs/tasks/configure-pod-container/security-context/ |

**cgroup v1 status:**
- Maintenance mode since **v1.31**: https://kubernetes.io/blog/2024/08/13/kubernetes-v1-31-release/
- **Deprecated since v1.35**, when `failCgroupV1` started defaulting to true. The kubelet fails to start on cgroup v1 nodes unless `failCgroupV1: false` is set: https://kubernetes.io/docs/concepts/architecture/cgroups/
- **Not removed as of 1.37.** The 1.37 blog says the override "remains available" and removal is planned for a future release. KEP-5573 is at stage beta as of v1.35.
- The 1.35 blog's heading "Removal of cgroup v1 support" overstates this; only the default changed.

**Other 1.35 Stable graduations:**
- Pod `.metadata.generation` / `observedGeneration`
- PreferSameNode traffic distribution
- Topology manager max-allowable-numa-nodes
- CPUManager reserved CPUs for system daemons
- Image GC max age
- Parallel image pulls limit
- kubectl command headers
- SPDY → WebSockets
- Invariant testing
- gogo protobuf removal

**Other 1.35 Beta graduations:**
- Pod certificates (KEP-4317)
- Storage version migration in-tree (the blog says default-enabled, but the FG table says default false)
- KYAML
- HPA configurable tolerance
- StatefulSet maxUnavailable
- Image volume default-on
- `KubeletEnsureSecretPulledImages`
- Container restart rules
- Deployment terminatingReplicas
- Node topology labels via Downward API

**1.35 deprecations and removals:**
- Ingress NGINX retirement notice.
- cgroup v1 (see above).
- **kube-proxy ipvs mode deprecated** (KEP-5495; nftables is the recommended replacement).
- **1.35 is the last release supporting containerd 1.x.** containerd 2.0+ is required before upgrading to 1.36. The metric to watch is `kubelet_cri_losing_support`.

---

## 4. Supported versions, EOL dates and latest patches

Sources:
- https://endoflife.date/api/kubernetes.json
- https://kubernetes.io/releases/
- https://dl.k8s.io/release/stable-1.XX.txt
- GitHub releases API

kubernetes.io says: "The Kubernetes project maintains release branches for the most recent three minor releases (1.37, 1.36, 1.35)." Patch support is about 1 year for 1.19+.

| Minor | Released | Latest patch | EOL (k8s.io = endoflife.date "eol") | endoflife.date "support" (end of active support) |
|---|---|---|---|---|
| 1.37 | 2026-08-26 | **1.37.0** | 2027-10-28 | 2027-08-28 |
| 1.36 | 2026-04-22 | **1.36.4** | 2027-06-28 | 2027-04-28 |
| 1.35 | 2025-12-17 | **1.35.8** | 2027-02-28 | 2026-12-28 |
| 1.34 | 2025-08-27 | **1.34.11** | 2026-10-27 (still listed on k8s.io, in maintenance) | 2026-08-27 |
| 1.33 | 2025-04-23 | 1.33.13 | 2026-06-28 (EOL) | — |
| 1.32 | 2024-12-11 | 1.32.13 | 2026-02-28 (EOL) | — |

- There is a minor date discrepancy for the latest patches (1.36.4, 1.35.8, 1.34.11). kubernetes.io/releases gives the release date as 2026-08-11, while the GitHub release objects and endoflife.date give **2026-08-20**.

---

## 5. Removed API versions (complete list from the Deprecated API Migration Guide)

Source: https://kubernetes.io/docs/reference/using-api/deprecation-guide/ (page last modified 2025-05-16)

- **Nothing was removed in 1.33, 1.34, 1.35, 1.36 or 1.37.** The latest section on the page is v1.32.
- The gitRepo volume disabling in 1.36 and the removal of the static-pod opt-out gate in 1.37 are feature removals, not API-version removals.

| Removed in | group/version → Kind | Migrate to |
|---|---|---|
| **v1.32** | flowcontrol.apiserver.k8s.io/v1beta3 → FlowSchema, PriorityLevelConfiguration | flowcontrol.apiserver.k8s.io/v1 (since 1.29) |
| **v1.29** | flowcontrol.apiserver.k8s.io/v1beta2 → FlowSchema, PriorityLevelConfiguration | …/v1 (1.29) or v1beta3 (1.26) |
| **v1.27** | storage.k8s.io/v1beta1 → CSIStorageCapacity | storage.k8s.io/v1 (1.24) |
| **v1.26** | flowcontrol.apiserver.k8s.io/v1beta1 → FlowSchema, PriorityLevelConfiguration | …/v1beta2 |
| v1.26 | autoscaling/v2beta2 → HorizontalPodAutoscaler | autoscaling/v2 (1.23) |
| **v1.25** | batch/v1beta1 → CronJob | batch/v1 (1.21) |
| v1.25 | discovery.k8s.io/v1beta1 → EndpointSlice | discovery.k8s.io/v1 (1.21) |
| v1.25 | events.k8s.io/v1beta1 → Event | events.k8s.io/v1 (1.19) |
| v1.25 | autoscaling/v2beta1 → HorizontalPodAutoscaler | autoscaling/v2 (1.23) |
| v1.25 | policy/v1beta1 → PodDisruptionBudget | policy/v1 (1.21) |
| v1.25 | policy/v1beta1 → PodSecurityPolicy | removed. Use Pod Security Admission or a 3rd-party webhook. |
| v1.25 | node.k8s.io/v1beta1 → RuntimeClass | node.k8s.io/v1 (1.20) |
| **v1.22** | admissionregistration.k8s.io/v1beta1 → MutatingWebhookConfiguration, ValidatingWebhookConfiguration | …/v1 (1.16) |
| v1.22 | apiextensions.k8s.io/v1beta1 → CustomResourceDefinition | …/v1 (1.16) |
| v1.22 | apiregistration.k8s.io/v1beta1 → APIService | …/v1 (1.10) |
| v1.22 | authentication.k8s.io/v1beta1 → TokenReview | …/v1 (1.6) |
| v1.22 | authorization.k8s.io/v1beta1 → LocalSubjectAccessReview, SelfSubjectAccessReview, SubjectAccessReview, SelfSubjectRulesReview | …/v1 (1.6) |
| v1.22 | certificates.k8s.io/v1beta1 → CertificateSigningRequest | …/v1 (1.19) |
| v1.22 | coordination.k8s.io/v1beta1 → Lease | …/v1 (1.14) |
| v1.22 | extensions/v1beta1 **and** networking.k8s.io/v1beta1 → Ingress | networking.k8s.io/v1 (1.19) |
| v1.22 | networking.k8s.io/v1beta1 → IngressClass | networking.k8s.io/v1 (1.19) |
| v1.22 | rbac.authorization.k8s.io/v1beta1 → ClusterRole, ClusterRoleBinding, Role, RoleBinding | …/v1 (1.8) |
| v1.22 | scheduling.k8s.io/v1beta1 → PriorityClass | …/v1 (1.14) |
| v1.22 | storage.k8s.io/v1beta1 → CSIDriver, CSINode, StorageClass, VolumeAttachment | storage.k8s.io/v1 |
| **v1.16** | extensions/v1beta1 → NetworkPolicy | networking.k8s.io/v1 (1.8) |
| v1.16 | extensions/v1beta1, apps/v1beta2 → DaemonSet | apps/v1 (1.9) |
| v1.16 | extensions/v1beta1, apps/v1beta1, apps/v1beta2 → Deployment | apps/v1 (1.9) |
| v1.16 | apps/v1beta1, apps/v1beta2 → StatefulSet | apps/v1 (1.9) |
| v1.16 | extensions/v1beta1, apps/v1beta1, apps/v1beta2 → ReplicaSet | apps/v1 (1.9) |
| v1.16 | extensions/v1beta1 → PodSecurityPolicy | policy/v1beta1 (itself removed in 1.25) |

The deprecation policy is quoted in the 1.36 sneak peek (https://kubernetes.io/blog/2026/03/30/kubernetes-v1-36-sneak-peek/):
- GA APIs "must not be removed within a major version".
- Beta APIs must be supported for 3 releases after deprecation.
- Alpha APIs may be removed at any time.

---

## 6. Endpoints API deprecation

Source: https://kubernetes.io/blog/2025/04/24/endpoints-deprecation/

- `v1 Endpoints` has been **deprecated since Kubernetes v1.33**. The API server returns this warning: `Warning: v1 Endpoints is deprecated in v1.33+; use discovery.k8s.io/v1 EndpointSlice`
- The plan (KEP-4974) is to drop the Endpoints controller from the conformance requirements.
- Per the blog, the Endpoints type itself "will probably never completely go away" because of the GA deprecation policy.

---

## 7. ingress-nginx retirement and the Ingress API

**Announcement (2025-11-11)**, from SIG Network and the Security Response Committee:
- Source: https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/ (mirror of https://www.kubernetes.dev/blog/2025/11/12/ingress-nginx-retirement)
- "Best-effort maintenance will continue until March 2026."
- After that there are no releases, no bugfixes and no security fixes. The repos become read-only.
- Existing deployments keep working, and the Helm charts and images remain available.
- InGate is also retired.
- To check whether you run it: `kubectl get pods --all-namespaces --selector app.kubernetes.io/name=ingress-nginx`

**Steering + SRC statement (2026-01-29):**
- Source: https://kubernetes.io/blog/2026/01/29/ingress-nginx-statement/
- About 50% of cloud native environments are affected (citing Datadog).
- No drop-in replacement exists.

**Actual retirement date: 2026-03-24.**
- The 1.36 release blog says it was "retired … on March 24, 2026".
- The 1.36 sneak peek says it was "announced by SIG-Security on March 24, 2026".
- The GitHub repo `kubernetes/ingress-nginx` is **archived=true**, with last push 2026-03-23.
- The final releases were controller-v1.15.1, v1.14.5 and v1.13.9 (published 2026-03-19). The last supported-versions table lists v1.15.1 for K8s 1.31–1.35.

**What "retired" means:**
- No further releases, bugfixes or CVE patches.
- The repo is read-only.
- Artifacts remain downloadable.
- Existing installs are not broken.

The README (https://github.com/kubernetes/ingress-nginx) says: "If you are not already using ingress-nginx, you should not be deploying it… identify a Gateway API implementation."

**Recommended alternatives:**
- Gateway API: https://gateway-api.sigs.k8s.io/guides/
- Other Ingress controllers: https://kubernetes.io/docs/concepts/services-networking/ingress-controllers/
- Tooling: ingress2gateway 1.0 (https://kubernetes.io/blog/2026/03/20/ingress2gateway-1-0-release/) and https://kubernetes.io/blog/2026/02/27/ingress-nginx-before-you-migrate/

**The Ingress API is GA and frozen.** Source: https://kubernetes.io/docs/concepts/services-networking/ingress/
- Ingress has been "Stable since Kubernetes v1.19" (`networking.k8s.io/v1`).
- The docs note says the Ingress API "has been frozen". It is GA, there are "no plans to remove Ingress", and there will be "no further changes or updates". The project recommends Gateway.

---

## 8. Gateway API

**Releases** (from the GitHub API, https://github.com/kubernetes-sigs/gateway-api/releases):
- **v1.6.2 (2026-09-03) is the latest.** It contains bugfixes: redirect codes 303/307/308 moved to Extended, plus conformance fixes.
- v1.6.1 was released 2026-07-16 and v1.6.0 on 2026-06-29/30.
- v1.5.0 was released 2026-02-27 and v1.5.1 on 2026-03-14.
- Blogs:
  - v1.6: https://kubernetes.io/blog/2026/08/03/gateway-api-v1-6-release/ (TCPRoute and UDPRoute went to Standard/v1. The v1alpha2 versions are deprecated. New experimental resources move to the `gateway.networking.x-k8s.io` group with an X prefix, e.g. XBackend, XBackendTrafficPolicy, XMesh.)
  - v1.5: https://kubernetes.io/blog/2026/04/21/gateway-api-v1-5/ (ListenerSet, TLSRoute, HTTPRoute CORS filter, Gateway client-cert validation, and BackendTLS certificate selection moved to Standard. ReferenceGrant was promoted to v1.)

**Standard channel CRDs at v1.6.2.** This was verified from `config/crd/standard/*.yaml` at tag v1.6.2 (bundle-version v1.6.2, channel standard):

| Resource | Served versions (storage) | Notes |
|---|---|---|
| GatewayClass | **v1** (storage), v1beta1 served | GA |
| Gateway | **v1** (storage), v1beta1 served | GA |
| HTTPRoute | **v1** (storage), v1beta1 served | GA |
| GRPCRoute | **v1** only | GA |
| ReferenceGrant | **v1** served, **v1beta1 is still the storage version** | v1 since Gateway API 1.5 |
| BackendTLSPolicy | **v1** (storage). v1alpha3 is present but not served. | Standard |
| TLSRoute | **v1** (storage). v1alpha2 and v1alpha3 are deprecated and not served. | Standard since 1.5 |
| ListenerSet | **v1** only | Standard since 1.5 |
| TCPRoute | **v1** (storage). v1alpha2 is deprecated and not served. | Standard since 1.6 |
| UDPRoute | **v1** (storage). v1alpha2 is deprecated and not served. | Standard since 1.6 |

- The standard bundle also includes a ValidatingAdmissionPolicy (`vap_safeupgrades`).
- The experimental channel adds `gateway.networking.x-k8s.io` XBackend, XBackendTrafficPolicy and XMesh.

**Install:**
- Pattern: `kubectl apply --server-side -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.6.2/standard-install.yaml`
- Experimental channel: `experimental-install.yaml`
- **Note:** the official getting-started page (https://gateway-api.sigs.k8s.io/guides/getting-started/) still shows **v1.6.1** in its URL and uses `--server-side`.
- The v1.6.2 asset exists as a GitHub release asset. It could not be downloaded here because of a local TLS error on release-assets.githubusercontent.com, so the CRDs were read from the tagged source instead.

**Conformant implementations** (https://gateway-api.sigs.k8s.io/implementations/):
- Gateway controllers, **Conformant:**
  - Agentgateway
  - Airlock Microgateway
  - Envoy Gateway
  - Google Kubernetes Engine
  - Gravitee Kubernetes Operator
  - Higress
  - Istio
  - Kong Operator
  - Lexfrei's Cloudflare Tunnel Gateway Controller
  - N42 Gateway
  - NGINX Gateway Fabric
  - Traefik Proxy
  - Varnish Gateway
  - WSO2 Gateway
- Gateway controllers, **Partially conformant:**
  - AWS Load Balancer Controller
  - Amazon EKS
  - Calico
- **Mesh, Conformant:** Istio.
- Integrations: Argo Rollouts, cert-manager, Flagger, Knative, Kuadrant, OpenKruise Rollouts.
- "Conformant" means passing all Core tests for at least one Route type and Profile, plus all claimed Extended features, for one of the 2 most recent releases.
- Cilium, Contour, HAProxy and Kgateway do **not** appear in the current conformant list.

---

## 9. Version skew policy (current text)

Source: https://kubernetes.io/releases/version-skew-policy/

- **kube-apiserver (HA):** the newest and oldest instances must be within one minor version.
- **kubelet:**
  - It must not be newer than kube-apiserver.
  - It may be up to **three** minor versions older. (A kubelet older than 1.25 may be at most two older.)
  - Example: apiserver 1.37 → kubelet 1.37, 1.36, 1.35 or 1.34.
- **kube-proxy:**
  - It must not be newer than the apiserver and may be up to 3 minor versions older.
  - It may be up to 3 minor versions older or newer than the kubelet it runs next to.
- **kube-controller-manager, kube-scheduler, cloud-controller-manager:**
  - They must not be newer than the apiserver.
  - They are expected to match it, but may be one minor version older.
- **kubectl:** supported within **one minor version (older or newer)** of kube-apiserver. Example: apiserver 1.37 → kubectl 1.38, 1.37 or 1.36.
- In an HA cluster with skewed apiservers, the allowed range narrows for every component.

---

## 10. Admission policies, sidecars, PSA, HPA gate

- **ValidatingAdmissionPolicy:** "Stable since Kubernetes v1.30". It uses `admissionregistration.k8s.io/v1` (ValidatingAdmissionPolicy, ValidatingAdmissionPolicyBinding). The docs page also shows a `v1alpha1` example for a separate alpha sub-feature. Source: https://kubernetes.io/docs/reference/access-authn-authz/validating-admission-policy/
- **MutatingAdmissionPolicy:** "Stable since Kubernetes v1.36; enabled by default". It uses `admissionregistration.k8s.io/v1`. FG `MutatingAdmissionPolicy`: Alpha 1.30–1.33, Beta 1.34–1.35 (default off), Stable 1.36. So in 1.37 it is GA (v1). Sources: https://kubernetes.io/docs/reference/access-authn-authz/mutating-admission-policy/ and the 1.36 release blog.
- **Sidecar containers:** "Stable since Kubernetes v1.33". The FG `SidecarContainers` is locked; it was first available in 1.28 and has been on by default since 1.29. Sidecars are init containers with `restartPolicy: Always`. Source: https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/
- **Pod Security Standards:**
  - The levels are **Privileged**, **Baseline** and **Restricted**. PSS is "Stable since v1.26" (https://kubernetes.io/docs/concepts/security/pod-security-standards/).
  - The Pod Security Admission controller has been "Stable since Kubernetes v1.25" (https://kubernetes.io/docs/concepts/security/pod-security-admission/).
  - Its modes are `enforce`, `audit` and `warn`, set with namespace labels `pod-security.kubernetes.io/<MODE>: <LEVEL>` and optional `…/<MODE>-version`.
- **HPA scale-to-zero gate:** the name is **`HPAScaleToZero`** (KEP-2021, "HPA supports scaling to and from zero pods for object and external metrics"). It was Alpha 1.16–1.36 (default false) and became Beta in 1.37 (default true). Sources: https://github.com/kubernetes/enhancements/blob/master/keps/sig-autoscaling/2021-scale-from-zero/kep.yaml and the FG table.

---

## 11. CKA, CKAD and CKS curricula

**Sources:**
- https://github.com/cncf/curriculum, which contains `CKA_Curriculum_v1.35.pdf`, `CKAD_Curriculum_v1.35.pdf` and `CKS_Curriculum v1.34.pdf`. The last curriculum commit was 2026-03-14; v1.34 was archived on 2026-03-03.
- The LF pages:
  - https://training.linuxfoundation.org/certification/certified-kubernetes-administrator-cka/
  - …/certified-kubernetes-application-developer-ckad/
  - …/certified-kubernetes-security-specialist/

**Exam Kubernetes version:**
- The LF pages say "The exam is based on Kubernetes v1.35" for CKA, CKAD **and CKS**.
- They also say the environment is aligned to the newest minor "within approximately 4 to 8 weeks of the K8s release date".
- **CONFLICT:** the CKS curriculum PDF on GitHub is still labelled v1.34.
- The CNCF README says the PDF major.minor matches the Kubernetes version.

### CKA (curriculum v1.35)

- **Storage (10%)**
  - Implement storage classes and dynamic volume provisioning
  - Configure volume types, access modes and reclaim policies
  - Manage persistent volumes and persistent volume claims
- **Troubleshooting (30%)**
  - Troubleshoot clusters and nodes
  - Troubleshoot cluster components
  - Monitor cluster and application resource usage
  - Manage and evaluate container output streams
  - Troubleshoot services and networking
- **Workloads and Scheduling (15%)**
  - Understand application deployments and how to perform rolling update and rollbacks
  - Use ConfigMaps and Secrets to configure applications
  - Configure workload autoscaling
  - Understand the primitives used to create robust, self-healing, application deployments
  - Configure Pod admission and scheduling (limits, node affinity, etc.)
- **Cluster Architecture, Installation and Configuration (25%)**
  - Manage role based access control (RBAC)
  - Prepare underlying infrastructure for installing a Kubernetes cluster
  - Create and manage Kubernetes clusters using kubeadm
  - Manage the lifecycle of Kubernetes clusters
  - Implement and configure a highly-available control plane
  - Use Helm and Kustomize to install cluster components
  - Understand extension interfaces (CNI, CSI, CRI, etc.)
  - Understand CRDs, install and configure operators
- **Services and Networking (20%).** The PDF literally prints "Servicing and Networking".
  - Understand connectivity between Pods
  - Define and enforce Network Policies
  - Use ClusterIP, NodePort, LoadBalancer service types and endpoints
  - Use the Gateway API to manage Ingress traffic
  - Know how to use Ingress controllers and Ingress resources
  - Understand and use CoreDNS

### CKAD (curriculum v1.35)

- **Application Design and Build (20%)**
  - Define, build and modify container images
  - Choose and use the right workload resource (Deployment, DaemonSet, CronJob, etc.)
  - Understand multi-container Pod design patterns (e.g. sidecar, init and others)
  - Utilize persistent and ephemeral volumes
- **Application Deployment (20%)**
  - Use Kubernetes primitives to implement common deployment strategies (e.g. blue/green or canary)
  - Understand Deployments and how to perform rolling updates
  - Use the Helm package manager to deploy existing packages
  - Kustomize
- **Application Observability and Maintenance (15%)**
  - Understand API deprecations (the PDF spells it "depreciations")
  - Implement probes and health checks
  - Use built-in CLI tools to monitor Kubernetes applications
  - Utilize container logs
  - Debugging in Kubernetes
- **Application Environment, Configuration and Security (25%)**
  - Discover and use resources that extend Kubernetes (CRD, Operators)
  - Understand authentication, authorization and admission control
  - Understand requests, limits, quotas
  - Define resource requirements
  - Understand ConfigMaps
  - Create & consume Secrets
  - Understand ServiceAccounts
  - Understand Application Security (SecurityContexts, Capabilities, etc.)
- **Services and Networking (20%)**
  - Demonstrate basic understanding of NetworkPolicies
  - Provide and troubleshoot access to applications via services
  - Use Ingress rules to expose applications

### CKS (GitHub PDF v1.34; LF page says the exam is based on v1.35)

- **Cluster Setup (15%)**
  - Use Network security policies to restrict cluster level access
  - Use CIS benchmark to review the security configuration of Kubernetes components (etcd, kubelet, kubedns, kubeapi)
  - Properly set up Ingress objects with TLS
  - Protect node metadata and endpoints
  - Verify platform binaries before deploying
- **Cluster Hardening (15%)**
  - Use Role Based Access Controls to minimize exposure
  - Exercise caution in using service accounts e.g. disable defaults, minimize permissions on newly created ones
  - Restrict access to Kubernetes API
  - Upgrade Kubernetes to avoid vulnerabilities
- **System Hardening (10%)**
  - Minimize host OS footprint (reduce attack surface)
  - Using least-privilege identity and access management
  - Minimize external access to the network
  - Appropriately use kernel hardening tools such as AppArmor, seccomp
- **Minimize Microservice Vulnerabilities (20%)**
  - Use appropriate pod security standards
  - Manage Kubernetes secrets
  - Understand and implement isolation techniques (multi-tenancy, sandboxed containers, etc.)
  - Implement Pod-to-Pod encryption (Cilium, Istio)
- **Supply Chain Security (20%)**
  - Minimize base image footprint
  - Understand your supply chain (e.g. SBOM, CI/CD, artifact repositories)
  - Secure your supply chain (permitted registries, sign and validate artifacts, etc.)
  - Perform static analysis of user workloads and container images (e.g. Kubesec, KubeLinter)
- **Monitoring, Logging and Runtime Security (20%)**
  - Perform behavioral analytics to detect malicious activities
  - Detect threats within physical infrastructure, apps, networks, data, users and workloads
  - Investigate and identify phases of attack and bad actors within the environment
  - Ensure immutability of containers at runtime
  - Use Kubernetes audit logs to monitor access

The domain weights on the LF pages match the PDFs for all three exams.
