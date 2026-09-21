---
title: The 4C security model
description: How Cloud, Cluster, Container and Code layer up, and why each outer layer can only add to the security of the layers inside it.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/architecture
  - k8s-security/authentication-and-authorisation
---

## Overview

Cloud Native security is usually taught as the **4C model**: four nested
layers — **Cloud, Cluster, Container, Code** — where each outer layer wraps
the ones inside it. The single load-bearing idea is that **you cannot make up
for a weak inner layer by hardening an outer one**. Application code full of
injection flaws is not saved by a well-configured cluster, and a hardened
container image is not saved by a cluster that lets any pod read every Secret.

This page frames the rest of Part I. Every later page lives in one of these
layers, and the whole part is about pushing controls as far *in* as you can,
so that a failure at one layer is contained by the next.

## Why it exists and when to use it

The model exists to stop teams from spending all their effort in one place.
It is common to see a cluster with beautiful network policies whose workloads
run as root with `cluster-admin` tokens, or a heavily audited cloud account
whose CI pipeline ships unsigned images. The 4C picture makes the gaps
obvious by forcing you to ask, at each layer, "what does this layer assume the
layer inside it already did?"

Use it as a **checklist and a threat-modelling frame**, not as a product. When
you review a system, walk the four layers outside-in for blast radius and
inside-out for defence in depth.

## How it works underneath

The layers are concentric because a compromise propagates outward with
difficulty and inward with ease. Breaking application code gets you a process
in a container. Breaking out of the container gets you the node. Breaking the
cluster's trust model (a token, the API server) gets you other tenants.
Breaking the cloud account gets you everything.

| Layer | What it is | Primary controls | Blast radius if it fails |
|---|---|---|---|
| **Cloud** | The account/datacentre: IAM, VPC, node OS, control-plane hosting | Cloud IAM least privilege, private API endpoints, node image hardening, etcd disk encryption | The entire environment |
| **Cluster** | The Kubernetes control plane and its trust model | Authn/authz (RBAC), admission control, Pod Security, network policy, encryption at rest, audit logging | Every namespace and tenant |
| **Container** | The pod and its runtime confinement | `securityContext`, capabilities, seccomp, read-only root, user namespaces, runtime detection | One node's workloads |
| **Code** | The application and its dependencies | Input validation, dependency and image scanning, secrets handling, signed artifacts | One workload |

The cloud layer is mostly out of scope for this handbook — it is your provider
and your node images — but two cloud-layer facts matter to Kubernetes directly:
**etcd holds every Secret**, so the disk it lives on and its backups must be
encrypted; and the **API server endpoint** should not be openly reachable.

## Basic example

The Tasklane manifests already embody the inner three layers. The namespace
enforces Pod Security at the cluster layer:

```yaml include="examples/k8s/01-namespace/namespace.yaml"
```

Each workload confines itself at the container layer with a `securityContext`
that runs as non-root, drops all capabilities and mounts a read-only root
filesystem — see the API Deployment:

```yaml include="examples/k8s/03-app/api.yaml" lines="42-47"
```

## Explanation

Notice how the two examples reinforce each other. The namespace label is a
**cluster-layer** control: the API server refuses any pod that is not
`restricted`. The pod's `securityContext` is a **container-layer** control: it
is what makes the pod `restricted` in the first place. If someone removed the
namespace label, the pod would still be hardened; if someone weakened the pod,
the namespace would still reject it. Two independent layers, each closing the
other's gaps.

The **code layer** is where the container's process actually behaves. Tasklane
reads its database password from a file rather than an environment variable,
keeps liveness probes off the database, and ships as a distroless non-root
image. Those are code and image decisions that no cluster control can make for
it.

## Common patterns

- **Outside-in for blast radius, inside-out for defence.** When triaging, ask
  what an attacker at each layer reaches next. When designing, push each
  control as far in as it will go so an outer failure is contained.
- **Map every control you own to a layer.** A control with no layer is usually
  a control nobody owns.
- **Assume the layer inside is already breached.** Design the cluster layer as
  if some pod is compromised, and the container layer as if the code is.

## Production considerations

Most real incidents are not exotic. They are a layer that was simply skipped:
a workload with a `cluster-admin` binding (cluster layer), a privileged pod
(container layer), a leaked long-lived token (cluster layer), an unpatched
dependency (code layer). The 4C value in production is that it turns "are we
secure?" into a small number of concrete, ownable questions per layer, each of
which maps to a later page in this part.

## Security considerations

The model's biggest failure mode is treating the layers as independent budgets
— "we did cluster security this quarter". They are multiplicative, not
additive: the weakest layer sets your real posture. A single privileged pod
(container) collapses cluster and often cloud security with it, because it
gives node-level root and the kubelet's identity. That is exactly the path the
[attack-privileged-pod-escape](attack-privileged-pod-escape.md) page dissects.

## Troubleshooting

If a workload is rejected and you are not sure which layer said no, identify
the enforcing component. A `violates PodSecurity` error is the cluster-layer
Pod Security admission plug-in. A policy-engine message (Kyverno/Gatekeeper)
is a cluster-layer admission webhook. A `forbidden` error naming a verb and
resource is RBAC. A container that starts but crashes on a permission error
inside is usually a container-layer `securityContext` mismatch with what the
code expects.

## Common mistakes

- Hardening one layer thoroughly and ignoring the rest, then believing the
  reassuring metric from the layer you focused on.
- Forgetting the cloud layer entirely, especially etcd disk encryption and a
  publicly reachable API server.
- Assuming the container layer confines the code when the pod runs privileged
  or as root — it does not.
- Treating "we scan images" (code) as if it covered runtime (container) or
  access (cluster).

## Related topics

- [Authentication and authorisation](authentication-and-authorisation.md)
- [Pod Security Standards](pod-security-standards.md)
- [Security context](security-context.md)
- [Common attack paths](common-attack-paths.md)
- [Kubernetes architecture](../k8s-beginner/architecture.md)
