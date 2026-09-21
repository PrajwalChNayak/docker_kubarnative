---
title: Namespaces
description: What a namespace scopes, what it does not, and how the tasklane namespace enforces a security profile from the moment it is created.
level: beginner
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/manifest-anatomy
---

## Overview

A namespace is a name scope for objects, and a handle that other systems —
RBAC, quotas, network policy, Pod Security Admission — attach rules to. It is
not a virtual cluster, not a network boundary by itself, and not a
sandbox.

Tasklane uses two: `tasklane` for the running example and `tasklane-basics`
for the Part F teaching manifests, so the exercises can be deleted wholesale
without touching the application.

## Why it exists and when to use it

Namespaces solve three practical problems:

1. **Name collisions.** Two teams can both have a Service called `api`.
2. **Blast radius of a command.** `kubectl delete deploy --all` is a very
   different event in `team-b` than in `kube-system`.
3. **A place to hang policy.** Roles, RoleBindings, ResourceQuotas,
   LimitRanges, NetworkPolicies and Pod Security labels are all per
   namespace. Policy that applies to "everything in here" is far easier to
   reason about than policy that applies to a list of objects.

Use a namespace per team, per environment within a cluster, or per
application group. Do not use one per pod, and do not use one per developer
unless quotas and RBAC follow.

What **cannot** be namespaced: Nodes, PersistentVolumes, StorageClasses,
ClusterRoles, ClusterRoleBindings, CustomResourceDefinitions, GatewayClasses,
IngressClasses, and namespaces themselves.

## How it works underneath

A namespace is an object in the core group. When you create one, the
namespace controller creates a `default` ServiceAccount in it, and the API
server begins accepting namespaced objects with that `metadata.namespace`.

Three things follow automatically:

- **DNS.** A Service `api` in namespace `tasklane` gets the record
  `api.tasklane.svc.cluster.local`. Pods in the same namespace can say `api`;
  pods elsewhere need `api.tasklane` or the full name. The namespace is a DNS
  label, which is why its name is limited to 63 characters of lowercase
  alphanumerics and dashes.
- **Admission by label.** Pod Security Admission reads
  `pod-security.kubernetes.io/enforce|audit|warn` labels on the namespace and
  applies the matching Pod Security Standard to every pod created in it.
- **Object references stay inside.** A pod can only mount a ConfigMap or
  Secret from its own namespace. There is no cross-namespace reference for
  those; Gateway API's `ReferenceGrant` exists precisely because a controlled
  exception had to be invented for routes and backends.

**Deletion is a cascade.** Deleting a namespace sets a `deletionTimestamp`,
after which the namespace controller deletes every object in it and the
namespace stays in `Terminating` until they are gone. Any object with an
unsatisfied finalizer blocks the whole thing — the classic stuck namespace
described in
[stuck terminating namespace](../troubleshooting/stuck-terminating-namespace.md).

### The built-in namespaces

| Namespace | Contents |
|---|---|
| `default` | Where objects land when nobody said otherwise. Treat it as scratch space |
| `kube-system` | Control-plane and add-on workloads. Do not deploy here |
| `kube-public` | World-readable cluster info (`cluster-info` ConfigMap) |
| `kube-node-lease` | One Lease per node, renewed by the kubelet as a heartbeat |

## Basic example

```yaml include="examples/k8s/01-namespace/namespace.yaml"
```

```yaml include="examples/k8s/basics/00-namespace.yaml"
```

```console include="captures/k8s-beginner/get-namespaces.txt"
```

```console include="captures/k8s-beginner/describe-namespace.txt"
```

## Explanation

Both namespaces carry the same three Pod Security Admission labels:

- `enforce: restricted` — a violating pod is **rejected** at admission.
- `warn: restricted` — `kubectl` prints a warning for a violating object,
  including for objects that create pods later (a Deployment), where
  `enforce` only acts when the pod itself is created.
- `audit: restricted` — a violation is annotated in the audit log.

`enforce-version: v1.37` pins the profile to this Kubernetes version's
definition. Without it, the namespace follows `latest`, and a cluster upgrade
can tighten the rules under a running workload.

Setting all three is the standard pattern: `warn` gives the fast feedback at
`kubectl apply` time, `enforce` is the actual gate, `audit` gives the
security team a record.

The effect is visible with a server dry-run — a plain `busybox` pod runs as
root and is refused:

```bash
kubectl -n tasklane-basics run psa-test --image=busybox:1.37 --dry-run=server -- sleep 1
```

```console include="captures/k8s-beginner/psa-reject-server-dry-run.txt"
```

The Part F teaching manifests all satisfy the restricted profile: non-root
UID, `allowPrivilegeEscalation: false`, all capabilities dropped and the
`RuntimeDefault` seccomp profile.

## Common patterns

- **Create the namespace in the same directory as the workload**, numbered
  first (`00-namespace.yaml`), so a single `kubectl apply -f <dir>` works.
- **Label namespaces with their owner and environment**
  (`app.kubernetes.io/part-of`, `environment`, `team`), then select on those
  labels in NetworkPolicies and dashboards.
- **Set the Pod Security labels at creation.** Retrofitting `enforce` onto a
  namespace full of running pods rejects the next rollout, not the current
  pods.
- **Pin the namespace in your context** while working:
  `kubectl config set-context --current --namespace=tasklane`.
- **One namespace per environment only within one cluster.** Production in
  the same cluster as development shares a control plane, a CNI and a node
  pool; that is a risk decision, not a naming decision.

## Production considerations

- **Quotas belong to namespaces.** A ResourceQuota caps CPU, memory, object
  counts and PVC storage; a LimitRange supplies defaults for pods that forgot
  requests. Without either, one namespace can starve the cluster. See
  [LimitRange and ResourceQuota](../k8s-intermediate/limitrange-and-resourcequota.md).
- **RBAC is namespace-scoped by default.** A Role plus RoleBinding gives
  rights inside one namespace; a ClusterRole bound with a RoleBinding reuses
  a permission set inside one namespace, which is the usual way to grant
  `view` or `edit`.
- **Deleting a namespace is irreversible and asynchronous.** Nothing asks for
  confirmation, and PersistentVolumeClaims in it are deleted too.
- **Namespace count has a cost.** Every namespace multiplies default objects,
  informer memory in controllers, and NetworkPolicy evaluation. Thousands of
  namespaces is a real design, not an accident.

## Security considerations

- **A namespace alone stops nothing.** Pods in different namespaces can talk
  to each other freely until a NetworkPolicy says otherwise, and they share
  nodes, the kernel and the CNI. Hard multi-tenancy needs separate clusters
  or strong isolation; see
  [multi-tenancy](../k8s-advanced/multi-tenancy.md).
- **Pod Security Admission is the cheapest real control you get.** Label
  every namespace, including `default`.
- **Watch for cluster-scoped grants.** A RoleBinding in a namespace that
  references a ClusterRole with `secrets` access across the cluster does not
  confine anything; the confinement comes from the binding type, not from
  where the YAML lives.
- **ServiceAccount tokens are namespace-scoped identities.** A compromised
  pod gets its namespace's rights, which is an argument for
  `automountServiceAccountToken: false` on workloads that never call the API,
  as both Tasklane workloads do.

## Troubleshooting

- **`namespaces "x" not found`** — apply the namespace first, or it was
  deleted while objects still referenced it.
- **A namespace stuck in `Terminating`** — a finalizer is unsatisfied.
  `kubectl get namespace x -o jsonpath='{.spec.finalizers}'` and
  `kubectl api-resources --verbs=list --namespaced -o name` to find leftover
  objects.
- **Pods rejected with a Pod Security message** — read the message: it names
  every field that violated the profile.
- **A Deployment applies cleanly but creates no pods, with warnings** —
  `warn` is set but `enforce` rejected the pods. Look at the ReplicaSet's
  events, not the Deployment's.
- **A Service cannot be resolved** — the client is in another namespace and
  used the short name.

## Common mistakes

- **Deploying into `default`.** It has no quota, no policy and no owner.
- **Treating namespaces as a security boundary** without NetworkPolicy, RBAC
  and Pod Security.
- **Expecting a Secret to be visible across namespaces.** Copy it (badly) or
  use an operator such as External Secrets (well).
- **Forgetting `enforce-version`,** then being surprised when an upgrade
  changes what is allowed.
- **Deleting a namespace to "clean up"** while a PersistentVolumeClaim in it
  holds the only copy of data.

## Related topics

- [Manifest anatomy](manifest-anatomy.md)
- [Labels, selectors and annotations](labels-selectors-annotations.md)
- [Pod Security Standards](../k8s-security/pod-security-standards.md)
- [LimitRange and ResourceQuota](../k8s-intermediate/limitrange-and-resourcequota.md)
- [Stuck terminating namespace](../troubleshooting/stuck-terminating-namespace.md)
