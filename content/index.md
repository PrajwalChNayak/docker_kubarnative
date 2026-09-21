---
title: Containers & Kubernetes Handbook
description: A zero-to-expert path through Docker, the container ecosystem beneath it, and running Kubernetes in production.
level: foundations
type: reference
status: current
versions: Kubernetes 1.37, Docker Engine 29, Compose v5, Helm 4
prerequisites: []
---

## Overview

This handbook takes you from "what is a container?" to operating production
Kubernetes with confidence. It does not stop at the commands. Every page
explains the **mechanism underneath** — which component acts, in what order,
and what state it changes — because that is what lets you debug a system at
02:00 instead of pattern-matching against a tutorial.

One small application, **Tasklane** (an API, a background worker and a
database), runs through the entire book. You start it with `docker run`, then
Compose, then plain Kubernetes manifests, then Kustomize and Helm, then GitOps,
then production hardening. You watch the same system mature.

Everything here was written and validated against **Kubernetes 1.37**, **Docker
Engine 29**, **Docker Compose v5** and **Helm 4**, verified on 2026-09-21. Every
manifest in the book was accepted by a real 1.37 API server; every Dockerfile
was built.

:::note Reading order
New here? Start with the [learning path](learning-path.md). It orders every
page, estimates the effort per stage, and gives you a checkpoint to know when
you are ready to move on.
:::

## The five levels

Every page carries a level badge and lists its prerequisites, so you always
know whether you are ready for it.

| Level | You will be able to… |
|---|---|
| **Foundations** | Explain what a container actually is: namespaces, cgroups v2, capabilities, the OCI specs, and the runtime stack from the Docker CLI down to `runc`. |
| **Beginner** | Run containers and simple Kubernetes workloads, and read manifests without guessing. |
| **Intermediate** | Write good Dockerfiles and Compose files; run stateful and networked workloads on Kubernetes with probes, storage, Gateway API and NetworkPolicy. |
| **Advanced** | Schedule, autoscale, package (Helm, Kustomize), deliver (GitOps, canary) and extend Kubernetes with operators and admission policy. |
| **Expert** | Secure, observe, upgrade, back up and cost-manage production clusters — and know when Kubernetes is the wrong tool. |

## What this handbook insists on being current about

The container ecosystem moves fast, and most tutorials online are years out of
date. This book is explicit where that matters:

- **Kubernetes runs a CRI runtime**, not Docker. `dockershim` was removed in
  1.24. Your Docker-built images still run fine, because they are OCI images.
- **Gateway API is the primary way to expose HTTP traffic.** The community
  `ingress-nginx` controller was **retired and archived in March 2026** and
  receives no further fixes. The Ingress API is taught only as Legacy, with a
  full [migration guide](migration/ingress-to-gateway-api.md).
- **PodSecurityPolicy is gone** (removed 1.25). Use Pod Security Admission and
  admission policies.
- **cgroup v2** is the baseline. **Compose v5** uses the `docker compose`
  plugin and has no top-level `version:` key. **Helm 4** changes several
  defaults from Helm 3.

Where a feature is Beta or Alpha, the page says so, states the feature gate and
whether it is on by default, and — for Alpha — that it is not for production.

## Start here

- [Learning path](learning-path.md) — the recommended order and checkpoints.
- [What problem containers solve](foundations/what-containers-solve.md) — the very beginning.
- [The running example](https://github.com/PrajwalChNayak/docker_kubarnative/tree/main/examples) — Tasklane's source and the one-command lab.
- [Coverage map](reference/coverage-map.md) — how the book maps to the Kubernetes and Docker docs and to the CKA/CKAD/CKS curricula.

## Common mistakes

- **Skipping Foundations because you already use Docker.** The later security
  and troubleshooting chapters assume you understand namespaces, cgroups and
  capabilities. Twenty minutes there saves hours later.
- **Copying manifests from old tutorials.** If a manifest uses
  `extensions/v1beta1`, `PodSecurityPolicy` or an Ingress annotation for traffic
  splitting, it predates this book's baseline. The [reference](reference/removed-api-versions.md)
  and [migration](migration/) sections show the current form.

## Related topics

- [Learning path](learning-path.md)
- [Certification map](reference/certification-map.md)
- [Version matrix](reference/version-matrix.md)
- [Glossary](reference/glossary.md)
