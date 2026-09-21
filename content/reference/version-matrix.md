---
title: Version matrix
description: The baseline versions, maturities and EOL dates this handbook is written against, as verified 2026-09-21.
level: beginner
type: reference
status: current
versions: Kubernetes 1.37, Docker Engine 29, Helm 4.3
prerequisites: []
---

## Overview

Every page in this handbook is written against the versions below, all verified
against primary sources on **2026-09-21**. Versions and EOL dates move; treat
this as a snapshot, and re-verify before relying on a date. Digests in the
examples change on every rebuild and should be re-resolved before publishing.

## Kubernetes releases and EOL

Three supported minors at a time, ~14 months of patches each.

| Minor | Released | Latest patch | EOL |
|---|---|---|---|
| **1.37** ("Garhwal") | 2026-08-26 | 1.37.0 | 2027-10-28 |
| 1.36 ("Haru") | 2026-04-22 | 1.36.4 | 2027-06-28 |
| 1.35 ("Timbernetes") | 2025-12-17 | 1.35.8 | 2027-02-28 |
| 1.34 | 2025-08-27 | 1.34.11 | **2026-10-27 — ends within weeks; upgrade now** |
| 1.33 and older | — | — | unsupported |

This handbook documents **1.37**. Every manifest must use API versions served by
1.37. No API versions were removed in 1.33–1.37; the last removal was 1.32
(flowcontrol v1beta3). See [removed API versions](../migration/removed-api-versions.md).

## Core toolchain

| Component | Current | Notes |
|---|---|---|
| Docker Engine | **29** (29.8.1, 2026-09-15) | Cycle 28 EOL 2026-05-13. 25.0 supported to 2026-12-04 per endoflife.date only. |
| Docker Compose | **v5** (v5.5.1) | Always `docker compose`; never a top-level `version:` key. |
| Dockerfile frontend | `# syntax=docker/dockerfile:1` | `:1` resolves to 1.26.0 today (1.27.0 exists). |
| Buildx / BuildKit | v0.37.1 / v0.33.0 | BuildKit is the default builder. |
| Helm | **4** (v4.3.0, 2026-09-09) | Helm 3: bug fixes ended 2026-09-09, security fixes to 2027-02-10. |
| containerd / runc / CRI-O | 2.4.0 / 1.5.1 / 1.37.0 | kind 1.37 nodes run containerd 2.3.4. |
| kubectl / Kustomize | v1.37.0 / v5.8.1 (built in) | kubectl supported within ±1 minor of the API server. |

## Local clusters

| Tool | Version | Node/notes |
|---|---|---|
| kind | v0.33.0 | node `kindest/node:v1.37.0` |
| minikube / k3d / k3s | v1.39.0 / v5.9.0 / v1.37.0+k3s1 | |

## Ecosystem (selected)

| Project | Version | Note |
|---|---|---|
| Gateway API | **v1.6.2** | lab impl: Envoy Gateway v1.9.1 |
| cert-manager | v1.21.2 | |
| Argo CD / Flux | v3.5.3 / v2.9.5 | |
| Prometheus / Grafana / Loki | v3.14.0 / v13.2.2 / v3.7.8 | Grafana & Loki are AGPLv3 |
| kube-prometheus | v0.18.0 | matrix lists K8s 1.33–1.36 only — no 1.37 column yet |
| metrics-server | v0.9.0 | supports K8s 1.34+ |
| KEDA / Karpenter / VPA / Cluster Autoscaler | v2.20.2 / v1.14.1 / 1.7.1 / 1.36.1 | Cluster Autoscaler has **no 1.37 release yet** |
| Kyverno / Gatekeeper / Falco | v1.19.1 / v3.23.1 / 0.44.1 | |
| Trivy / Grype / Syft / cosign | v0.74.0 / v0.119.0 / v1.52.0 / v3.1.3 | |
| Cilium / Calico / Istio / Linkerd | v1.20.2 / v3.32.2 / 1.31.0 / edge-26.9.3 | Linkerd OSS publishes edge only |
| Velero | v1.18.2 | repo moved to `velero-io/velero`; CNCF Sandbox |
| hadolint / kubeconform / Pluto / kube-bench | v2.15.1 / v0.8.0 / v5.24.4 / v0.16.0 | kubent unmaintained — prefer Pluto |
| Podman | v6.1.2 | v6 removed cgroup v1, CNI, iptables, slirp4netns |

## Retirements and removals to know

| Thing | Status |
|---|---|
| ingress-nginx | **Retired, repo archived 2026-03-24**; last release controller v1.15.1. See [retirement](../migration/ingress-nginx-retirement.md). |
| dockershim | Removed in 1.24. See [life after dockershim](../migration/dockershim-removal.md). |
| Pod security policy (PSP) | Removed in 1.25. See [PSP to PSA](../migration/psp-to-pod-security-admission.md). |
| Compose v1 (the standalone Python binary) | Long EOL; use `docker compose` v5. |
| Endpoints API | Deprecated since 1.33; use EndpointSlice. |
| cgroup v1 | Deprecated since 1.35 (`failCgroupV1` defaults true); not removed. cgroup v2 is the baseline. |
| MinIO | Repo archived 2026-04-25; not used as an example. |

## Docker facts worth pinning

- Docker Desktop is free for orgs with **< 250 employees AND < $10M revenue**,
  and for personal/education/non-commercial OSS use; otherwise paid.
- Docker Hub pulls per 6 hours: 100 unauthenticated (per IPv4 / IPv6 /64), 200
  Personal, unlimited paid.
- Engine 29: containerd image store default on fresh installs; default container
  open-file soft limit 1024; nftables experimental; rootless uses
  `gvisor-tap-vsock` since 29.5.0.
- `gcr.io/distroless/*-debian12` tags are deprecated — use `-debian13`.

## Common mistakes

- **Treating these dates as fixed.** They move; re-verify against the source
  before an upgrade or audit.
- **Reusing a pinned image digest without re-resolving.** Digests change on
  every rebuild.
- **Assuming add-on support for 1.37.** kube-prometheus and Cluster Autoscaler
  lag; check the compatibility matrix.
- **Ignoring the 1.34 EOL.** It ends 2026-10-27 — within weeks of this snapshot.

## Related topics

- [Removed API versions](../migration/removed-api-versions.md)
- [Cluster upgrades](../operations/cluster-upgrades.md)
- [Version skew policy](../operations/version-skew-policy.md)
- [Certification map](certification-map.md)
