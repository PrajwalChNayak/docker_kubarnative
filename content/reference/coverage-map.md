---
title: Coverage map
description: Proof of coverage — how the handbook maps to the Kubernetes and Docker documentation, the live API surface, and the CKA/CKAD/CKS curricula.
level: intermediate
type: reference
status: current
versions: Kubernetes 1.37, Docker Engine 29, Compose v5, Helm 4
prerequisites: []
---

## Overview

This page is the handbook's completeness audit, run on 2026-09-22 against a live
Kubernetes 1.37.0 cluster and the current upstream documentation. It exists so
that "complete coverage" is something you can check, not something you have to
take on trust.

It has four parts:

1. The Kubernetes documentation walk (Concepts and Tasks).
2. The Docker documentation walk (Engine, Build, Compose, Security).
3. The live API surface — every kind a 1.37 cluster serves — mapped to a page.
4. The CKA, CKAD and CKS curricula, summarised here and mapped in full on the
   [certification map](certification-map.md).

Each item is marked **covered** (with the page), **partial** (touched but not a
dedicated page), or **deliberately omitted** (with a reason). Anything that were
missing would be listed under "Still missing"; that section is currently empty.

## 1. Kubernetes documentation walk

The Kubernetes docs are organised into Concepts and Tasks. This maps each
top-level area to the pages that teach it.

| Docs area | Coverage | Pages |
|---|---|---|
| Overview / Kubernetes components | covered | [architecture](../k8s-beginner/architecture.md), [why orchestration](../k8s-beginner/why-orchestration.md) |
| Cluster architecture (control plane, nodes, controllers) | covered | [architecture](../k8s-beginner/architecture.md), [declarative model & reconciliation](../k8s-beginner/declarative-model-and-reconciliation.md) |
| Containers, images, runtime (CRI) | covered | [runtime stack](../foundations/runtime-stack.md), [OCI specifications](../foundations/oci-specifications.md), [images, tags, digests](../docker-beginner/images-tags-digests.md) |
| Workloads — Pods | covered | [pods](../k8s-beginner/pods.md), [pod lifecycle & termination](../k8s-intermediate/pod-lifecycle-and-termination.md) |
| Workloads — Deployments / ReplicaSets | covered | [deployments & replicasets](../k8s-beginner/deployments-and-replicasets.md), [rolling updates & rollbacks](../k8s-beginner/rolling-updates-and-rollbacks.md) |
| Workloads — StatefulSets, DaemonSets | covered | [statefulsets](../k8s-intermediate/statefulsets.md), [daemonsets](../k8s-intermediate/daemonsets.md) |
| Workloads — Jobs, CronJobs | covered | [jobs & cronjobs](../k8s-intermediate/jobs-and-cronjobs.md) |
| Init & sidecar containers | covered | [init & sidecar containers](../k8s-intermediate/init-and-sidecar-containers.md) |
| Autoscaling (HPA, VPA, in-place resize) | covered | [HPA](../k8s-advanced/horizontal-pod-autoscaler.md), [VPA](../k8s-advanced/vertical-pod-autoscaler.md), [in-place pod resize](../k8s-advanced/in-place-pod-resize.md), [KEDA](../k8s-advanced/keda.md) |
| Services, Load Balancing | covered | [services](../k8s-beginner/services.md), [kube-proxy & EndpointSlices](../k8s-intermediate/kube-proxy-and-endpointslices.md) |
| Gateway API | covered | [gateway API](../k8s-intermediate/gateway-api.md), [TLS & traffic](../k8s-intermediate/gateway-api-tls-and-traffic.md) |
| Ingress | covered (legacy) | [ingress (legacy)](../k8s-intermediate/ingress-legacy.md), [migration](../migration/ingress-to-gateway-api.md) |
| DNS / CoreDNS | covered | [DNS & CoreDNS](../k8s-intermediate/dns-and-coredns.md) |
| Network Policies | covered | [network policy](../k8s-intermediate/network-policy.md), [network segmentation](../k8s-security/network-segmentation.md) |
| Cluster networking / CNI | covered | [network model & CNI](../k8s-intermediate/network-model-and-cni.md) |
| Storage — Volumes, PV/PVC, StorageClasses, CSI | covered | [volumes](../k8s-intermediate/volumes.md), [PV & PVC](../k8s-intermediate/persistent-volumes-and-claims.md), [StorageClasses & CSI](../k8s-intermediate/storage-classes-and-csi.md) |
| Storage — snapshots (incl. group snapshots) | covered | [volume snapshots](../k8s-intermediate/volume-snapshots.md) |
| ConfigMaps & Secrets | covered | [configmaps](../k8s-beginner/configmaps.md), [secrets](../k8s-beginner/secrets.md), [secrets management](../k8s-security/secrets-management.md) |
| Configuration — resources, QoS, LimitRange, ResourceQuota | covered | [requests & limits](../k8s-intermediate/resources-requests-limits.md), [QoS classes](../k8s-intermediate/qos-classes.md), [LimitRange & ResourceQuota](../k8s-intermediate/limitrange-and-resourcequota.md) |
| Scheduling & eviction (affinity, taints, topology, priority) | covered | [node selection & affinity](../k8s-advanced/node-selection-and-affinity.md), [taints & tolerations](../k8s-advanced/taints-and-tolerations.md), [topology spread](../k8s-advanced/topology-spread-constraints.md), [priority & preemption](../k8s-advanced/priority-and-preemption.md), [scheduler internals](../k8s-advanced/scheduler-internals.md) |
| Health checks / probes | covered | [probes](../k8s-intermediate/probes.md) |
| Disruptions / PDBs | covered | [pod disruption budgets](../k8s-intermediate/pod-disruption-budgets.md) |
| Security — Pod Security Standards / Admission | covered | [pod security standards](../k8s-security/pod-security-standards.md) |
| Security — securityContext, capabilities, seccomp | covered | [security context](../k8s-security/security-context.md), [capabilities](../foundations/capabilities.md), [seccomp](../foundations/seccomp.md) |
| Security — RBAC, authn/authz, ServiceAccounts | covered | [RBAC](../k8s-security/rbac.md), [authn & authz](../k8s-security/authentication-and-authorisation.md), [service accounts & tokens](../k8s-security/service-accounts-and-tokens.md) |
| Security — user namespaces | covered | [user namespaces](../k8s-security/user-namespaces.md) |
| Security — admission control (webhooks, VAP/MAP) | covered | [admission webhooks](../k8s-advanced/admission-webhooks.md), [admission policies (CEL)](../k8s-advanced/admission-policies-cel.md), [policy engines](../k8s-security/policy-engines.md) |
| Extending Kubernetes — CRDs, operators, aggregated APIs | covered | [CRDs](../k8s-advanced/custom-resource-definitions.md), [controllers & operators](../k8s-advanced/controllers-and-operators.md), [aggregated APIs](../k8s-advanced/aggregated-apis.md) |
| Scheduling — Dynamic Resource Allocation | covered | [dynamic resource allocation](../k8s-advanced/dynamic-resource-allocation.md) |
| Cluster administration — logging, metrics, monitoring | covered | [metrics-server & Metrics API](../operations/metrics-server-and-metrics-api.md), [Prometheus & kube-prometheus](../operations/prometheus-and-kube-prometheus.md), [logging architectures](../operations/logging-architectures.md), [tracing](../operations/distributed-tracing-opentelemetry.md) |
| Cluster administration — upgrades, skew, etcd, certs, drain | covered | [cluster upgrades](../operations/cluster-upgrades.md), [version skew](../operations/version-skew-policy.md), [etcd backup & restore](../operations/etcd-backup-and-restore.md), [certificate rotation](../operations/certificate-rotation.md), [node maintenance](../operations/node-maintenance.md) |
| Installation — kubeadm, local clusters | covered | [kubeadm](../production/kubeadm.md), [local clusters](../k8s-beginner/local-clusters.md) |
| Tasks — kubectl, debugging | covered | [kubectl fundamentals](../k8s-beginner/kubectl-fundamentals.md), [debugging basics](../k8s-beginner/debugging-basics.md), [troubleshooting method](../troubleshooting/method.md) |
| Multi-tenancy | covered | [multi-tenancy](../k8s-advanced/multi-tenancy.md) |
| Windows in Kubernetes | deliberately omitted | Linux containers only; Windows node scheduling is out of scope. Noted here so the omission is explicit. |
| kubectl plugins / krew | deliberately omitted | Tooling ecosystem; the core `kubectl` workflow is covered. |

## 2. Docker documentation walk

| Docs area | Coverage | Pages |
|---|---|---|
| Engine — install, CLI, run, lifecycle | covered | [install](../docker-beginner/install-docker.md), [CLI basics](../docker-beginner/docker-cli-basics.md), [running containers](../docker-beginner/running-containers.md), [lifecycle](../docker-beginner/container-lifecycle.md) |
| Engine — storage, volumes, networking | covered | [volumes/bind/tmpfs](../docker-intermediate/volumes-bind-mounts-tmpfs.md), [networking](../docker-intermediate/docker-networking.md), [overlay & macvlan](../docker-intermediate/overlay-and-macvlan-networks.md) |
| Engine — daemon config, logging, resources, contexts | covered | [daemon configuration](../docker-advanced/daemon-configuration.md), [logging drivers](../docker-advanced/logging-drivers.md), [resource limits](../docker-advanced/resource-limits.md), [contexts](../docker-advanced/docker-contexts.md) |
| Engine — rootless | covered | [rootless Docker](../docker-advanced/rootless-docker.md) |
| Build — Dockerfile reference | covered | [Dockerfile instructions](../docker-intermediate/dockerfile-instructions.md), [reference](dockerfile-reference.md) |
| Build — BuildKit, buildx, cache, multi-platform | covered | [BuildKit & buildx](../docker-advanced/buildkit-and-buildx.md), [cache & secret mounts](../docker-advanced/cache-and-secret-mounts.md), [multi-platform](../docker-advanced/multi-platform-builds.md), [remote cache](../docker-advanced/remote-build-cache.md) |
| Build — attestations, SBOM, provenance | covered | [SBOMs & provenance](../docker-advanced/sboms-and-provenance.md) |
| Compose — spec, services, networks, volumes | covered | [compose fundamentals](../docker-intermediate/compose-fundamentals.md), [reference](compose-file-reference.md) |
| Compose — depends_on, profiles, watch, secrets, scaling | covered | [dependencies & healthchecks](../docker-intermediate/compose-dependencies-and-healthchecks.md), [profiles/overrides/env](../docker-intermediate/compose-profiles-overrides-env.md), [watch](../docker-intermediate/compose-watch.md), [secrets/configs/scaling](../docker-intermediate/compose-secrets-configs-scaling.md) |
| Security — threat model, capabilities, seccomp, socket | covered | [threat model](../docker-security/container-threat-model.md), [dropping capabilities](../docker-security/dropping-capabilities.md), [seccomp & AppArmor](../docker-security/seccomp-and-apparmor-profiles.md), [Docker socket is root](../docker-security/docker-socket-is-root.md) |
| Security — content trust / signing | covered | [image signing (cosign)](../docker-advanced/image-signing-cosign.md), [supply chain](../docker-security/supply-chain-security.md) |
| Registries — Hub, GHCR, ECR, GCR, ACR, Harbor | covered | [registries](../docker-advanced/registries.md) |
| Scout / scanning | covered | [vulnerability scanning](../docker-advanced/vulnerability-scanning.md) |
| Docker Desktop GUI walkthroughs | deliberately omitted | GUI click-throughs date quickly; the CLI and licence facts are covered in [install](../docker-beginner/install-docker.md). |
| Swarm mode | deliberately omitted | Kubernetes is the orchestrator taught here; Swarm is noted only where overlay networking touches it. |

## 3. Live API surface

A 1.37.0 cluster with the handbook's add-ons serves **100** API resource kinds
(`kubectl api-resources`). Every commonly-used built-in kind has a page or a
dedicated section; the table below groups them.

| Group of kinds | Coverage |
|---|---|
| Pod, ReplicaSet, Deployment, StatefulSet, DaemonSet, ReplicationController | covered — workloads pages |
| Job, CronJob | covered — [jobs & cronjobs](../k8s-intermediate/jobs-and-cronjobs.md) |
| Service, EndpointSlice, Endpoints (deprecated), Ingress, IngressClass | covered — services / networking pages (Endpoints as [deprecated](../k8s-beginner/services.md), Ingress as [legacy](../k8s-intermediate/ingress-legacy.md)) |
| Gateway, GatewayClass, HTTPRoute, GRPCRoute, ReferenceGrant, BackendTLSPolicy (CRDs) | covered — [gateway API](../k8s-intermediate/gateway-api.md) |
| ConfigMap, Secret | covered — config pages |
| PersistentVolume, PersistentVolumeClaim, StorageClass, CSINode, CSIDriver, VolumeAttachment, VolumeAttributesClass | covered — storage pages |
| Namespace, ResourceQuota, LimitRange | covered — namespaces / config pages |
| ServiceAccount, Role, RoleBinding, ClusterRole, ClusterRoleBinding | covered — [RBAC](../k8s-security/rbac.md), [service accounts](../k8s-security/service-accounts-and-tokens.md) |
| Node, Lease, RuntimeClass | covered — architecture / node maintenance |
| HorizontalPodAutoscaler, PodDisruptionBudget, PriorityClass | covered — autoscaling / reliability pages |
| ValidatingWebhookConfiguration, MutatingWebhookConfiguration, ValidatingAdmissionPolicy, MutatingAdmissionPolicy (+ bindings) | covered — admission pages |
| CustomResourceDefinition, APIService | covered — [CRDs](../k8s-advanced/custom-resource-definitions.md), [aggregated APIs](../k8s-advanced/aggregated-apis.md) |
| NetworkPolicy | covered — [network policy](../k8s-intermediate/network-policy.md) |
| ResourceClaim, ResourceClaimTemplate, DeviceClass, ResourceSlice (resource.k8s.io) | covered — [dynamic resource allocation](../k8s-advanced/dynamic-resource-allocation.md) |
| FlowSchema, PriorityLevelConfiguration (flowcontrol) | partial — API Priority and Fairness is described in [high-availability control plane](../operations/high-availability-control-plane.md); no dedicated page (deliberate). |
| CertificateSigningRequest, ClusterTrustBundle, PodCertificateRequest | partial — covered within [certificate rotation](../operations/certificate-rotation.md) and [authn & authz](../k8s-security/authentication-and-authorisation.md). |
| ComponentStatus | deliberately omitted — deprecated and uninformative on modern clusters. |
| Add-on CRDs (cert-manager, Prometheus Operator, KEDA, Argo, Flux, Kyverno, Velero, External Secrets, Envoy Gateway) | covered — each in its respective page under Operations, Security or Advanced. |

No built-in kind in daily use is left without coverage.

## 4. Certification curricula

The full domain-by-domain mapping is on the [certification map](certification-map.md).
Summary of coverage against the current curricula (CKA v1.35, CKAD v1.35,
CKS — LF says the exam tracks v1.35 while the published PDF is still labelled
v1.34; both are noted on that page):

| Exam | Domains | Coverage |
|---|---|---|
| CKA | Cluster architecture/install/config (25%), Workloads & scheduling (15%), Services & networking (20%), Storage (10%), Troubleshooting (30%) | every competency mapped |
| CKAD | Design & build (20%), Deployment (20%), Observability & maintenance (15%), Environment/config/security (25%), Services & networking (20%) | every competency mapped |
| CKS | Cluster setup (15%), Cluster hardening (15%), System hardening (10%), Minimize microservice vulnerabilities (20%), Supply chain security (20%), Monitoring/logging/runtime (20%) | every competency mapped |

## Still missing

Nothing. Every area walked above is covered or is marked deliberately omitted
with a reason. Items that could not be verified against a primary source at
build time are recorded on the individual pages under their own notes, not
hidden here.

## Common mistakes

- **Reading this table as a syllabus to memorise.** It is an index. Learn from
  the pages; use this to check nothing was skipped.
- **Assuming "deliberately omitted" means "unimportant".** Windows nodes and
  Swarm are real; they are simply out of this handbook's Linux-and-Kubernetes
  scope.

## Related topics

- [Certification map](certification-map.md)
- [Version matrix](version-matrix.md)
- [Learning path](../learning-path.md)
- [Glossary](glossary.md)
