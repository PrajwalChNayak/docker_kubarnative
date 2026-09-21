---
title: Glossary
description: An A-Z of container and Kubernetes terms used across the handbook.
level: beginner
type: reference
status: current
versions: Docker Engine 29, Kubernetes 1.37
prerequisites: []
---

## Overview

Definitions of the container and Kubernetes terms this handbook uses. Each entry
is one or two sentences; follow the linked pages for depth. Where a term names a
specific version or maturity, that is stated on the topic page, not here.

## A

**Admission controller** — code that intercepts a request to the API server
after authentication/authorization and before persistence, to validate or mutate
it. Built-in examples include Pod Security Admission.

**Affinity / anti-affinity** — Pod scheduling rules that attract Pods to (or
repel them from) nodes or other Pods by label.

**Annotation** — arbitrary non-identifying key/value metadata on an object. Not
selectable, unlike labels.

**API group** — a namespace for Kubernetes APIs, e.g. `apps`, `batch`,
`networking.k8s.io`. The core group has an empty name (`v1`).

## B

**Bake** — Docker's build orchestrator (`docker buildx bake`); Compose v5
delegates image builds to it.

**Baseline** — the middle Pod Security Standards level; blocks known privilege
escalations while staying permissive.

**BuildKit** — the default Docker build engine, with caching, secret mounts and
concurrent stages.

## C

**Capability** — a unit of root's power (Linux splits root into ~40). Containers
drop all and add back only what they need.

**cgroup (v2)** — the kernel mechanism that limits and accounts a process
group's CPU, memory, PIDs and IO. v2 is the baseline; v1 is deprecated.

**CNI (Container Network Interface)** — the plugin API that wires Pod networking
(Cilium, Calico).

**ConfigMap** — a Kubernetes object holding non-secret configuration as
key/value data.

**containerd** — the container runtime the kubelet drives over CRI, and the core
of Docker Engine.

**CRI (Container Runtime Interface)** — the gRPC API between the kubelet and a
runtime (containerd, CRI-O). dockershim, the old Docker bridge, was removed in
1.24.

**CRD (CustomResourceDefinition)** — an object that adds a new kind to the API,
the basis of operators and Gateway API.

**CronJob** — a Job on a schedule (`batch/v1`).

## D

**DaemonSet** — a workload that runs one Pod per matching node.

**Deployment** — the common stateless workload; manages ReplicaSets for rolling
updates.

**Distroless** — a minimal base image with no shell or package manager, only the
runtime dependencies.

**dockershim** — the kubelet's removed built-in Docker bridge. See
[life after dockershim](../migration/dockershim-removal.md).

## E

**EndpointSlice** — the scalable list of a Service's backends
(`discovery.k8s.io/v1`); replaced the deprecated Endpoints.

**Ephemeral container** — a container added to a running Pod for debugging
(`kubectl debug`).

## F

**Filter (Gateway API)** — a typed transform on an HTTPRoute rule
(RequestRedirect, URLRewrite, header modifiers).

**Finalizer** — a key that blocks deletion until a controller does cleanup.

## G

**Gateway API** — the successor to Ingress: typed resources (GatewayClass,
Gateway, HTTPRoute) for L4/L7 routing.

**GatewayClass** — cluster-scoped; selects the controller that implements a
Gateway.

**GitOps** — driving cluster state from Git as the source of truth (Argo CD,
Flux).

## H

**Headless Service** — a Service with `clusterIP: None`; DNS returns pod IPs
directly, used by StatefulSets.

**Helm** — the Kubernetes package manager; packages are charts. See
[Helm 3 to 4](../migration/helm-3-to-4.md).

**HPA (HorizontalPodAutoscaler)** — scales replica count on metrics
(`autoscaling/v2`).

## I

**Image (OCI)** — a standard, layered, content-addressed artifact. Built by
Docker, run by any OCI runtime.

**Ingress** — the legacy, frozen HTTP routing API (`networking.k8s.io/v1`).
Prefer Gateway API.

**Init container** — a container that runs to completion before app containers;
one with `restartPolicy: Always` is a sidecar.

## J

**Job** — a workload that runs Pods to successful completion (`batch/v1`).

**JSONPath** — the expression language `kubectl -o jsonpath` uses to extract
fields.

## K

**kubelet** — the node agent that runs Pods by calling the CRI runtime.

**kube-proxy** — the component that programs Service routing on each node
(iptables/nftables/ipvs).

**Kustomize** — template-free manifest customization via overlays; built into
`kubectl`.

**KYAML** — a machine-unambiguous YAML output (`kubectl get -o kyaml`), stable in
1.37.

## L

**Label / selector** — identifying key/value metadata, and the queries that match
on it. The backbone of Service and controller wiring.

**LimitRange** — per-namespace defaults and bounds on resource requests/limits.

## M

**Manifest** — a YAML/JSON declaration of desired object state.

**metrics-server** — the cluster add-on that serves the Metrics API for
`kubectl top` and the HPA.

## N

**Namespace (Kubernetes)** — a scope for names and policy within a cluster.

**Namespace (Linux)** — the kernel feature isolating a process's view of PIDs,
mounts, network, users, etc.

**NetworkPolicy** — a namespaced firewall for Pod traffic
(`networking.k8s.io/v1`).

## O

**OCI (Open Container Initiative)** — the standards bodies for image and runtime
formats. Why Docker images run on any runtime.

**Operator** — a controller plus CRDs that automates an application's lifecycle.

## P

**PersistentVolume / PersistentVolumeClaim** — a piece of storage, and a request
to bind one.

**Pod** — the smallest deployable unit; one or more containers sharing network
and storage.

**Pod Security Admission (PSA)** — the built-in controller enforcing Pod Security
Standards by namespace label. Replaced the removed PSP mechanism.

**PodDisruptionBudget (PDB)** — limits voluntary disruptions to keep a minimum
available.

**Probe** — a kubelet health check: `liveness`, `readiness`, `startup`.

## Q

**QoS class** — a Pod's eviction priority (`Guaranteed`, `Burstable`,
`BestEffort`), derived from its requests and limits.

## R

**RBAC** — role-based access control (`rbac.authorization.k8s.io/v1`): Roles and
bindings grant verbs on resources.

**Reconciliation** — a controller's loop driving actual state toward desired
state.

**ReferenceGrant** — a Gateway API object permitting a cross-namespace reference.

**runc / crun** — the low-level OCI runtimes that create the container process.

## S

**Secret** — a Kubernetes object for sensitive data; base64-encoded, not
encrypted at rest unless configured.

**seccomp** — a syscall filter; `RuntimeDefault` blocks dangerous syscalls.

**Server-side apply (SSA)** — apply performed on the API server with field
ownership tracking; Helm 4's default for new installs.

**Service** — a stable virtual endpoint load-balancing to a set of Pods.

**Sidecar** — a helper container; in Kubernetes, an init container with
`restartPolicy: Always` (stable since 1.33).

**StatefulSet** — a workload with stable identities and per-Pod storage.

## T

**Taint / toleration** — a node marker that repels Pods, and the Pod permission
to ignore it.

**Topology spread** — constraints that even Pods across zones/nodes.

## U

**User namespace** — a Linux namespace mapping container UIDs to unprivileged
host UIDs (`hostUsers: false`, GA in 1.36).

## V

**ValidatingAdmissionPolicy / MutatingAdmissionPolicy** — CEL-based, in-tree
admission policies (`admissionregistration.k8s.io/v1`).

**Volume** — storage attached to a Pod; ephemeral (emptyDir) or persistent
(PVC).

## W

**Watch** — a streaming API that pushes object changes to clients and
controllers.

**Workload** — a controller that manages Pods (Deployment, StatefulSet,
DaemonSet, Job, CronJob).

## Common mistakes

- **Confusing a Linux namespace with a Kubernetes namespace** — unrelated
  concepts that share a word.
- **Treating a Secret as encrypted** — it is base64 by default; enable
  encryption at rest.
- **Calling any helper container a "sidecar" loosely** — in Kubernetes it has a
  precise meaning (an always-restarting init container).
- **Using "Ingress" and "Gateway" interchangeably** — different APIs; Ingress is
  frozen.

## Related topics

- [Manifest field reference](manifest-field-reference.md)
- [kubectl cheat sheet](kubectl-cheat-sheet.md)
- [Certification map](certification-map.md)
- [Version matrix](version-matrix.md)
