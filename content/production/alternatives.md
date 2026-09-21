---
title: Alternatives to Kubernetes
description: Managed container platforms, serverless containers, plain VMs, Nomad and PaaS — honest trade-offs for running containers without Kubernetes.
level: advanced
type: reference
status: current
versions: Kubernetes 1.37
prerequisites:
  - production/when-not-to-use-kubernetes
  - docker-intermediate/compose-fundamentals
---

## Overview

Containers are the portable unit of deployment; Kubernetes is one way to run
them, not the only way. When [Kubernetes is the wrong
fit](when-not-to-use-kubernetes.md), several alternatives run the same OCI images
with far less operational surface. This page surveys them with their honest
trade-offs and no advocacy — each is the right answer for some situation and the
wrong answer for others. The through-line: you can run Tasklane's exact images on
every option here; what differs is how much platform you operate to do it.

## Managed container platforms

These run your containers on a provider-operated substrate. You bring an image
and a little config; the provider handles scheduling, scaling and the hosts.

| Platform | Shape | Strengths | Trade-offs |
|---|---|---|---|
| **AWS ECS + Fargate** | AWS-native orchestrator; Fargate removes the nodes | Deep AWS integration (IAM, ALB, VPC); no cluster to run; task definitions are simple | AWS-only; less flexible than Kubernetes; ecosystem is AWS services, not CNCF |
| **Google Cloud Run** | Serverless containers, request- or CPU-driven, scales to zero | Trivial deploys; pay-per-use; scale-to-zero; great for HTTP and event workloads | Request/stateless-oriented; less suited to long-lived stateful services; GCP-only |
| **Azure Container Apps** | Serverless containers on a managed Kubernetes+KEDA substrate | Event-driven autoscaling (KEDA), scale-to-zero, Dapr integration; hides Kubernetes | Azure-only; less control than raw AKS; abstraction leaks for advanced needs |
| **Fly.io** | Containers (Firecracker microVMs) run close to users at the edge | Simple global deploy, anycast, good developer experience | Smaller provider; fewer managed services around it; different operational model |
| **Render** | PaaS-style container and app hosting | Very low operational overhead; git-push deploys; managed databases | Opinionated; less control and scale ceiling than cloud-native platforms |

The common trade is **control for simplicity and lock-in**: you give up the CNCF
ecosystem and multi-cloud portability, and you get no cluster to operate. For a
small team running a few services in one cloud, that trade is often clearly worth
it — the very case [when not to use Kubernetes](when-not-to-use-kubernetes.md)
describes.

## Serverless containers, more generally

Cloud Run and Container Apps are examples of the broader **serverless container**
model: you supply an image, the platform runs it on demand, scales it (often to
zero) and bills for usage. It fits HTTP services, event consumers and batch jobs
well. It fits poorly when you need long-lived connections, specialised hardware,
per-node control, or a large mesh of always-on services where the per-request
model stops saving money. Cold starts and execution-time limits are the usual
sharp edges.

## Plain VMs with Compose or systemd

You do not need an orchestrator to run containers. On one or a few VMs:

- **Docker Compose** runs a multi-container stack from a single file — the same
  approach the handbook uses in
  [Compose fundamentals](../docker-intermediate/compose-fundamentals.md). Ideal
  for a single-host deployment, a staging box, or an appliance.
- **systemd units** (or Podman + `quadlet`) supervise containers as OS services
  with restart policies, journald logging and boot ordering — no daemon-of-daemons,
  just the init system you already run.

Strengths: almost nothing to learn beyond what you know, trivial to reason about,
cheap. Trade-offs: no multi-node scheduling, no self-healing across hosts, no
rolling-update primitive beyond what you script, and you own the VM (patching,
capacity). This is the right tool for genuinely small, stable deployments — and
it is astonishing how far one well-provisioned VM plus a managed database goes.

## HashiCorp Nomad

Nomad is a general-purpose scheduler that orchestrates containers *and* non-container
workloads (raw binaries, VMs, Java) with a single small binary. It is
deliberately simpler than Kubernetes: fewer concepts, easier to operate, and it
pairs with Consul (service discovery/mesh) and Vault (secrets) when you want
them.

Strengths: much lower operational complexity than Kubernetes; runs mixed
workloads; strong on-prem/edge story. Trade-offs: a far smaller ecosystem than
the CNCF landscape, fewer off-the-shelf integrations and operators, and a smaller
talent pool. Nomad is a real answer for teams that want orchestration without
Kubernetes's surface area — note HashiCorp's licence change to BSL applies (see
`research/tooling-facts.md`).

## Platform-as-a-Service (PaaS)

Classic and modern PaaS (Heroku-style, and the internal developer platforms
built on Cloud Foundry or similar) take the abstraction further: you push code or
an image and the platform builds, deploys, scales and routes it. The developer
never sees infrastructure.

Strengths: the lowest operational overhead of all; excellent developer velocity.
Trade-offs: the most lock-in and the least control; cost can climb at scale; you
live within the platform's opinions. Many organisations build an internal
developer platform *on top of* Kubernetes to get PaaS ergonomics with Kubernetes
flexibility underneath — which is a reason to run Kubernetes, not an alternative
to it.

## Choosing

- **A few stateless HTTP services, one cloud** → serverless containers (Cloud
  Run / Container Apps / Fargate).
- **One or two small, stable services** → a VM with Compose or systemd, plus a
  managed database.
- **Orchestration without Kubernetes's complexity, mixed workloads, on-prem** →
  Nomad.
- **Maximum developer velocity, minimal ops, lock-in acceptable** → PaaS.
- **Many services, many teams, real scale, or on-prem orchestration at size** →
  Kubernetes (this handbook).

None of these is a downgrade. The skill is matching the platform to the team and
the workload, and being willing to move up (or down) as they change.

## Common mistakes

- **Assuming Kubernetes or nothing.** The middle ground — serverless containers,
  a VM, Nomad — serves most small workloads better.
- **Ignoring lock-in on the managed platforms** when portability genuinely
  matters to you.
- **Forcing a stateful or always-on service onto a per-request serverless model**
  and paying for cold starts and awkward workarounds.
- **Dismissing "just a VM"** for deployments small and stable enough that one VM
  plus a managed database is the correct, boring answer.
- **Treating PaaS as an alternative to Kubernetes** when you actually want PaaS
  ergonomics *on* Kubernetes.

## Related topics

- [When not to use Kubernetes](when-not-to-use-kubernetes.md)
- [The cost of Kubernetes](cost-of-kubernetes.md)
- [Compose fundamentals](../docker-intermediate/compose-fundamentals.md)
- [k3s and lightweight distributions](k3s-and-lightweight.md)
