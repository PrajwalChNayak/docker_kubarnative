---
title: When not to use Kubernetes
description: A decision framework for when Kubernetes is the wrong tool — small teams, few services, low scale, and the complexity tax.
level: advanced
type: reference
status: current
versions: Kubernetes 1.37
prerequisites:
  - production/cost-of-kubernetes
  - production/alternatives
---

## Overview

Most Kubernetes writing assumes you should use Kubernetes and only argues about
how. This page argues the other side, because the most expensive Kubernetes
mistakes are made before the first `kubectl apply`: choosing it for a problem it
does not fit. Kubernetes is a superb answer to "we have many services, many
teams and real scale, and we need a common substrate to run them on." It is a
poor answer to "we have three services and four engineers." This page gives you a
framework to tell which situation you are in.

This is not anti-Kubernetes — the rest of the handbook is deeply pro-Kubernetes
where it fits. It is anti-*cargo-cult*: adopting Kubernetes because it is the
default in the industry, not because it solves a problem you actually have.

## The complexity tax

Kubernetes is not one tool; it is a platform you assemble and operate. Adopting
it means taking on, permanently:

- A control plane and nodes to run or pay for.
- A CNI, ingress/Gateway, cert-manager, CSI drivers, autoscalers, an
  observability stack, policy engines and secret management — each with its own
  upgrades and CVEs.
- Three Kubernetes upgrades a year under a version-skew policy.
- A new operational vocabulary the whole team must learn well enough to debug at
  3 a.m.
- The [hidden costs](cost-of-kubernetes.md): platform headcount, load balancers,
  cross-AZ traffic, observability storage, idle headroom.

That tax is worth paying when the problems Kubernetes solves are problems you
have at scale. It is dead weight when they are not. The tax does not shrink for
small deployments — a 3-service cluster carries almost the same operational
surface as a 300-service one.

## A decision framework

Work through these. The more that point away from Kubernetes, the more you should
reach for something simpler first.

### Team

- **Can you staff a platform capability?** If no one's job can be "the cluster,"
  Kubernetes will be operated by people who are also trying to ship features, and
  it will be operated badly. This is the single strongest signal.
- **Does the team already know Kubernetes?** Learning it *and* running production
  on it *and* shipping the product simultaneously is a lot for a small team.

### Workload shape

- **How many services and teams?** A handful of services run by one team rarely
  needs an orchestrator's multi-tenancy, scheduling and self-healing. Dozens of
  services across teams start to.
- **What scale and variability?** Steady, modest traffic on a couple of machines
  does not need autoscaling across a node fleet. Spiky, large or unpredictable
  load does.
- **Stateless and simple, or complex topology?** A few stateless web apps and a
  managed database are trivial to run without Kubernetes. Many interdependent
  services with complex networking benefit from what Kubernetes provides.
- **Batch/scheduled/event-driven?** Serverless and managed queues may fit better
  than standing pods.

### Portability and constraints

- **Do you genuinely need multi-cloud / no lock-in?** Kubernetes is a strong
  portability story — but "we might go multi-cloud someday" is usually not worth
  the tax today. Real regulatory or contractual multi-cloud requirements are.
- **On-prem / air-gapped / edge?** Here Kubernetes (or a lightweight distro) is
  often the *best* option, because the managed alternatives are not available.

### The honest test

> If a managed container platform (Cloud Run, ECS/Fargate, Azure Container Apps)
> or even a couple of well-run VMs would run your workload today, and you cannot
> point to a specific Kubernetes capability you need *now*, you probably do not
> need Kubernetes yet.

"Yet" matters: you can start simpler and move to Kubernetes when the workload and
team grow into it. Migrating a containerised app onto Kubernetes later is far
cheaper than carrying a cluster you did not need for years. Containers are the
portable unit; Kubernetes is one way — not the only way — to run them.

## Signals you *do* need it

For balance, adopt Kubernetes when several of these are true:

- Many services and multiple teams needing a shared, self-service substrate.
- Real, variable scale that benefits from pod and node autoscaling.
- A need for consistent deployment, rollout, self-healing and policy across a
  fleet.
- On-prem/edge where managed platforms are unavailable and you need orchestration.
- An existing platform team and Kubernetes expertise.

## Common mistakes

- **Adopting Kubernetes for résumé or default reasons** rather than a problem you
  have.
- **Believing it will save money at small scale** — the platform overhead
  dominates any bin-packing win.
- **Planning for hypothetical multi-cloud** and paying the tax now for a future
  that may never come.
- **Underestimating the learning curve** for a small team shipping a product.
- **Assuming a managed control plane removes the complexity** — it removes the
  control-plane slice, not the workload, add-on and day-2 slices.
- **Refusing to revisit the decision** as the team and workload grow into (or out
  of) needing it.

## Related topics

- [The cost of Kubernetes](cost-of-kubernetes.md)
- [Alternatives to Kubernetes](alternatives.md)
- [k3s and lightweight distributions](k3s-and-lightweight.md)
- [Managed Kubernetes compared](managed-kubernetes-compared.md)
