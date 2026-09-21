---
title: Certification map (CKA, CKAD, CKS)
description: The current CKA, CKAD and CKS curriculum domains mapped to the handbook pages that teach each competency.
level: intermediate
type: reference
status: current
versions: Kubernetes 1.37; CKA/CKAD curriculum v1.35, CKS curriculum v1.34
prerequisites: []
---

## Overview

This maps the three CNCF/Linux Foundation Kubernetes certifications to the pages
that teach each competency. Use it as a study checklist, not a substitute for
hands-on practice — all three exams are performance-based.

:::note Curriculum versions, verified 2026-09-21
The CNCF curriculum repo carries **CKA v1.35**, **CKAD v1.35** and **CKS v1.34**
PDFs. The Linux Foundation pages say all three exams are "based on Kubernetes
v1.35" and that the environment tracks the newest minor within ~4–8 weeks of
release. So there is a genuine **CKS discrepancy**: the published curriculum PDF
is labelled v1.34 while the exam environment is stated as v1.35. Study to v1.35
behaviour but expect v1.34-era wording in the objectives. The exam environment
is **not** 1.37; this handbook documents 1.37, so a few defaults and maturities
here are ahead of the exam.
:::

## CKA — Certified Kubernetes Administrator (v1.35)

| Domain (weight) | Handbook pages |
|---|---|
| Cluster Architecture, Installation & Configuration (25%) | [architecture](../k8s-beginner/architecture.md), [rbac](../k8s-security/rbac.md), [kubeadm](../production/kubeadm.md), [cluster upgrades](../operations/cluster-upgrades.md), [high-availability control plane](../operations/high-availability-control-plane.md), [helm](../k8s-advanced/helm.md), [kustomize](../k8s-advanced/kustomize.md), [custom resource definitions](../k8s-advanced/custom-resource-definitions.md), [controllers and operators](../k8s-advanced/controllers-and-operators.md) |
| Workloads & Scheduling (15%) | [deployments and replicasets](../k8s-beginner/deployments-and-replicasets.md), [rolling updates and rollbacks](../k8s-beginner/rolling-updates-and-rollbacks.md), [configmaps](../k8s-beginner/configmaps.md), [secrets](../k8s-beginner/secrets.md), [horizontal pod autoscaler](../k8s-advanced/horizontal-pod-autoscaler.md), [node selection and affinity](../k8s-advanced/node-selection-and-affinity.md), [taints and tolerations](../k8s-advanced/taints-and-tolerations.md) |
| Services & Networking (20%) | [services](../k8s-beginner/services.md), [network model and cni](../k8s-intermediate/network-model-and-cni.md), [network policy](../k8s-intermediate/network-policy.md), [gateway api](../k8s-intermediate/gateway-api.md), [ingress-legacy](../k8s-intermediate/ingress-legacy.md), [dns and coredns](../k8s-intermediate/dns-and-coredns.md) |
| Storage (10%) | [persistent volumes and claims](../k8s-intermediate/persistent-volumes-and-claims.md), [storage classes and csi](../k8s-intermediate/storage-classes-and-csi.md), [volumes](../k8s-intermediate/volumes.md) |
| Troubleshooting (30%) | [method](../troubleshooting/method.md), [crashloopbackoff](../troubleshooting/crashloopbackoff.md), [service no endpoints](../troubleshooting/service-no-endpoints.md), [dns failures](../troubleshooting/dns-failures.md), [node notready](../troubleshooting/node-notready.md), [metrics-server and metrics api](../operations/metrics-server-and-metrics-api.md) |

## CKAD — Certified Kubernetes Application Developer (v1.35)

| Domain (weight) | Handbook pages |
|---|---|
| Application Design & Build (20%) | [dockerfile instructions](../docker-intermediate/dockerfile-instructions.md), [multi-stage builds](../docker-intermediate/multi-stage-builds.md), [jobs and cronjobs](../k8s-intermediate/jobs-and-cronjobs.md), [daemonsets](../k8s-intermediate/daemonsets.md), [init and sidecar containers](../k8s-intermediate/init-and-sidecar-containers.md), [volumes](../k8s-intermediate/volumes.md) |
| Application Deployment (20%) | [rolling updates and rollbacks](../k8s-beginner/rolling-updates-and-rollbacks.md), [progressive delivery](../k8s-advanced/progressive-delivery.md), [helm](../k8s-advanced/helm.md), [kustomize](../k8s-advanced/kustomize.md) |
| Observability & Maintenance (15%) | [probes](../k8s-intermediate/probes.md), [debugging basics](../k8s-beginner/debugging-basics.md), [deprecated api detection](../operations/deprecated-api-detection.md), [removed api versions](../migration/removed-api-versions.md) |
| Environment, Configuration & Security (25%) | [configmaps](../k8s-beginner/configmaps.md), [secrets](../k8s-beginner/secrets.md), [service accounts and tokens](../k8s-security/service-accounts-and-tokens.md), [security context](../k8s-security/security-context.md), [resources requests limits](../k8s-intermediate/resources-requests-limits.md), [limitrange and resourcequota](../k8s-intermediate/limitrange-and-resourcequota.md), [custom resource definitions](../k8s-advanced/custom-resource-definitions.md) |
| Services & Networking (20%) | [services](../k8s-beginner/services.md), [network policy](../k8s-intermediate/network-policy.md), [gateway api](../k8s-intermediate/gateway-api.md), [ingress-legacy](../k8s-intermediate/ingress-legacy.md) |

## CKS — Certified Kubernetes Security Specialist (curriculum v1.34; exam stated v1.35)

CKS requires a valid CKA first.

| Domain (weight) | Handbook pages |
|---|---|
| Cluster Setup (15%) | [network segmentation](../k8s-security/network-segmentation.md), [cis benchmark kube-bench](../k8s-security/cis-benchmark-kube-bench.md), [gateway api tls and traffic](../k8s-intermediate/gateway-api-tls-and-traffic.md), [supply chain admission](../k8s-security/supply-chain-admission.md) |
| Cluster Hardening (15%) | [rbac](../k8s-security/rbac.md), [service accounts and tokens](../k8s-security/service-accounts-and-tokens.md), [authentication and authorisation](../k8s-security/authentication-and-authorisation.md), [cluster upgrades](../operations/cluster-upgrades.md) |
| System Hardening (10%) | [seccomp](../foundations/seccomp.md), [apparmor and selinux](../foundations/apparmor-and-selinux.md), [capabilities](../foundations/capabilities.md), [security context](../k8s-security/security-context.md) |
| Minimize Microservice Vulnerabilities (20%) | [pod security standards](../k8s-security/pod-security-standards.md), [from psp to pod security admission](../migration/psp-to-pod-security-admission.md), [policy engines](../k8s-security/policy-engines.md), [secrets management](../k8s-security/secrets-management.md), [user namespaces](../k8s-security/user-namespaces.md) |
| Supply Chain Security (20%) | [supply chain security](../docker-security/supply-chain-security.md), [sboms and provenance](../docker-advanced/sboms-and-provenance.md), [image signing cosign](../docker-advanced/image-signing-cosign.md), [vulnerability scanning](../docker-advanced/vulnerability-scanning.md), [base image patching](../docker-security/base-image-patching.md) |
| Monitoring, Logging & Runtime Security (20%) | [runtime security falco](../k8s-security/runtime-security-falco.md), [audit logging](../k8s-security/audit-logging.md), [common attack paths](../k8s-security/common-attack-paths.md), [attack privileged pod escape](../k8s-security/attack-privileged-pod-escape.md) |

## Study notes

- **All three are hands-on.** Practice in the kind lab against the Tasklane
  stack; know `kubectl` cold (see the [cheat sheet](kubectl-cheat-sheet.md)).
- **The exam version lags this handbook.** Where a maturity or default differs
  (in-place resize, user namespaces, SSA), the exam follows ~1.35, not 1.37.
- **CKS Gateway/Ingress.** The CKA/CKAD objectives now name the Gateway API
  explicitly alongside Ingress controllers; know both.

## Common mistakes

- **Studying to the wrong version.** The exams track ~1.35; do not assume 1.37
  defaults on the exam.
- **Ignoring the CKS curriculum/exam version gap.** The PDF says v1.34, the exam
  page says v1.35 — prepare for both.
- **Skipping troubleshooting for CKA.** It is 30% of the exam, the largest
  domain.
- **Treating certification as coverage.** The exams test operation, not the
  design judgement the rest of this handbook builds.

## Related topics

- [kubectl cheat sheet](kubectl-cheat-sheet.md)
- [Manifest field reference](manifest-field-reference.md)
- [Version matrix](version-matrix.md)
- [Glossary](glossary.md)
