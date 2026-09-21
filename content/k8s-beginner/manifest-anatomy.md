---
title: Manifest anatomy
description: The four fields every Kubernetes object has, how API groups and versions are spelled, and how to validate a manifest before the cluster sees it.
level: beginner
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/declarative-model-and-reconciliation
  - k8s-beginner/kubectl-fundamentals
---

## Overview

Every Kubernetes object, from a Pod to a GatewayClass to a CustomResource,
has the same outer shape:

```yaml title="the universal shape" fragment
apiVersion: <group>/<version>     # or just <version> for the core group
kind: <Kind>
metadata:
  name: <name>
  namespace: <namespace>          # namespaced kinds only
spec: {}                          # what you want
status: {}                        # what is, written by a controller
```

Learn this once and every new resource type becomes a question of "what goes
in `spec`?", which `kubectl explain` answers.

## Why it exists and when to use it

The uniform envelope is what makes the ecosystem work. `kubectl`, RBAC,
admission control, audit logging, server-side apply, garbage collection and
every GitOps tool operate on `apiVersion`, `kind` and `metadata` without
knowing anything about the kind in question. A CRD installed today gets all
of those features for free.

It also means a manifest is a **document with a schema**. You can validate
it, diff it, review it and store it in git before any cluster is involved —
which is what `kubeconform` and `kubectl apply --dry-run=server` do in this
handbook's harness.

## How it works underneath

### apiVersion: groups and versions

The API is split into **groups**. The original resources (Pod, Service,
ConfigMap, Secret, Namespace, Node, PersistentVolumeClaim) live in the
unnamed **core group**, whose `apiVersion` is just `v1` and whose URL path is
`/api/v1`. Everything else lives in a named group under `/apis`:

| apiVersion | Kinds you will use |
|---|---|
| `v1` | Pod, Service, ConfigMap, Secret, Namespace, ServiceAccount, PersistentVolumeClaim |
| `apps/v1` | Deployment, ReplicaSet, StatefulSet, DaemonSet |
| `batch/v1` | Job, CronJob |
| `networking.k8s.io/v1` | NetworkPolicy, Ingress (GA and frozen) |
| `discovery.k8s.io/v1` | EndpointSlice |
| `rbac.authorization.k8s.io/v1` | Role, RoleBinding, ClusterRole, ClusterRoleBinding |
| `policy/v1` | PodDisruptionBudget |
| `autoscaling/v2` | HorizontalPodAutoscaler |
| `storage.k8s.io/v1` | StorageClass, CSIDriver, VolumeAttachment |
| `gateway.networking.k8s.io/v1` | GatewayClass, Gateway, HTTPRoute, GRPCRoute (CRDs, Gateway API v1.6.2) |

Version suffixes state maturity: an alpha version may change or vanish and is
usually off by default, a beta version is on by default and may still change,
and `v1` is stable and supported for the life of the major version.

:::legacy Removed API versions
**No API versions were removed between Kubernetes 1.33 and 1.37**; the last
removal was `flowcontrol.apiserver.k8s.io/v1beta3` in 1.32. That does not
make old manifests safe: `extensions/v1beta1`, `apps/v1beta1` and their
siblings were removed years ago and will simply fail to apply. The full list
is in [removed API versions](../migration/removed-api-versions.md).
:::

The same object can be served under several versions at once; the API server
converts on the fly and stores one **storage version**. That is why
`kubectl get -o yaml` may show a different `apiVersion` than you submitted.

### kind, resource and scope

`kind` is the Go type name (`Deployment`); the **resource** is the lowercase
plural in the URL (`deployments`). RBAC rules and `kubectl api-resources`
speak resources; manifests speak kinds.

Objects are either **namespaced** (Pod, Deployment, Service, Secret) or
**cluster-scoped** (Namespace, Node, PersistentVolume, StorageClass,
ClusterRole, GatewayClass). A namespaced object without
`metadata.namespace` lands in whatever namespace the command targets, which
is a good reason to write it explicitly in files.

### metadata

| Field | Meaning |
|---|---|
| `name` | Unique within namespace and kind. Usually a DNS label: lowercase alphanumerics and `-`, at most 253 characters (63 for names used as DNS labels, such as Services) |
| `namespace` | Required for namespaced kinds; the file should say it |
| `labels` | Identifying key/value pairs, **selectable** |
| `annotations` | Non-identifying metadata, not selectable, larger values allowed |
| `uid` | Server-assigned identity; what `ownerReferences` really point at |
| `resourceVersion` | Opaque version for optimistic concurrency and watches |
| `generation` / `creationTimestamp` / `deletionTimestamp` | Server-managed |
| `finalizers` | Keys that block deletion until a controller removes them |
| `ownerReferences` | Parent objects, used by garbage collection |

Fields below the line are written by the server. Do not put them in a file:
`resourceVersion` in particular turns an apply into a conflict.

:::note Relaxed Service names
Kubernetes 1.37 made Service name validation less strict (KEP-5311). Other
kinds already allowed names that Services did not. Stick to lowercase DNS
labels and the difference never matters.
:::

### spec and status

`spec` is yours. `status` belongs to the controller and is a separate
subresource, so `kubectl apply` ignores it and RBAC can grant it separately.
Not every kind has both: a ConfigMap has neither (`data` sits at the top
level), and a Namespace's `status` holds only its phase.

### Multiple documents in one file

YAML documents separated by `---` are applied as separate objects, in file
order. The handbook groups objects that belong together — the API
ServiceAccount, Deployment and Service live in one file — because they are
reviewed and deleted together.

## Basic example

```yaml include="examples/k8s/01-namespace/namespace.yaml"
```

```yaml include="examples/k8s/basics/30-service-clusterip.yaml"
```

```console include="captures/k8s-beginner/api-versions.txt"
```

## Explanation

The Namespace is cluster-scoped: it has a `name` and no `namespace`. Its
labels are not decoration — the `pod-security.kubernetes.io/*` labels are
read by an admission plugin, which is a recurring Kubernetes idiom: labels
and annotations are the extension points that let controllers attach
behaviour to objects without changing their schema.

The Service is namespaced and says so in the file. Its `spec.selector`
matches pod labels rather than naming pods, and `targetPort: http` refers to
a **named container port**, so the pod can change its port number without
touching the Service.

`kubectl api-versions` lists every group/version this cluster serves,
including the Gateway API CRDs the lab installs. If an `apiVersion` is not in
that list, no manifest using it can be applied.

### Validate before you apply

```bash
kubeconform -strict -summary -kubernetes-version 1.37.0 examples/k8s/basics/*.yaml
kubectl apply --dry-run=server -f examples/k8s/basics/
```

`kubeconform` checks manifests against the JSON schemas for a given
Kubernetes version, offline and fast, which makes it ideal for CI and for
catching a typo like `replica: 3`. `--dry-run=server` goes further: it runs
defaulting and admission on the real cluster. The handbook's harness runs
both, and every manifest in `examples/` passes them.

## Common patterns

- **Always write `metadata.namespace`** in files that are applied by a
  pipeline; do not rely on the operator's current context.
- **One logical unit per file**, numbered so that `kubectl apply -f <dir>`
  processes them in a sensible order (`00-namespace.yaml` first).
- **Use `kubectl explain <kind>.<path>`** rather than guessing field names,
  and `--recursive` to see the whole subtree.
- **Generate a skeleton**, then trim:
  `kubectl create deployment web --image=... --dry-run=client -o yaml`.
- **Keep `spec` minimal.** Every field you do not set is a default you get to
  inherit as the cluster improves; explicitly setting defaults freezes them.
- **Label everything with the recommended set** (`app.kubernetes.io/name`,
  `component`, `part-of`), as described in
  [labels, selectors and annotations](labels-selectors-annotations.md).

## Production considerations

- **Pin API versions deliberately and scan for deprecations.** Pluto reads
  manifests and reports removed or deprecated versions before an upgrade;
  see [deprecated API detection](../operations/deprecated-api-detection.md).
- **Immutable fields exist.** A Deployment's `spec.selector` and a Job's
  template cannot be changed after creation; the apply fails and you must
  recreate the object. Choose selectors you can live with.
- **Validate in CI**, not on a developer's laptop:
  `kubeconform` plus `kubectl apply --dry-run=server` against a real cluster
  of the target version catches almost everything.
- **Avoid hand-written duplication across environments.** That is what
  [Kustomize](../k8s-advanced/kustomize.md) and
  [Helm](../k8s-advanced/helm.md) are for.

## Security considerations

- **`metadata.annotations` is a common place for accidental secrets.**
  Anything in an object is visible to everyone with `get` on that kind in
  that namespace, and to every backup of etcd.
- **`kubectl apply` of a manifest from the internet runs someone else's
  RBAC, webhooks and privileged pods.** Read it first; `--dry-run=server`
  plus `kubectl diff` shows what would change.
- **Cluster-scoped kinds are not namespaced away.** A manifest that quietly
  includes a ClusterRoleBinding grants rights across the whole cluster.
- **Field ownership matters.** A manifest applied with server-side apply
  claims the fields it sets; a second tool changing them will be told.

## Troubleshooting

- **`no matches for kind "X" in version "Y"`** — the group/version is not
  served (removed version, or a missing CRD).
- **`unknown field "spec.foo"`** — strict validation rejecting a typo. Check
  with `kubectl explain`.
- **`field is immutable`** — you changed something that cannot change; delete
  and recreate, or roll a new object name.
- **`metadata.name: Invalid value`** — uppercase letters, underscores or a
  name longer than the limit.
- **An object applied to the wrong namespace** — the file omitted
  `metadata.namespace` and the context supplied one.

## Common mistakes

- **Copying `status` or `resourceVersion` out of `kubectl get -o yaml`** into
  a manifest. Export cleanly instead, or write the file by hand.
- **Copying beta API versions from an old tutorial.** Several were removed
  years ago; see the callout above.
- **Indentation errors that silently produce a different object.** YAML makes
  `spec.template.spec` and `spec.spec` look similar in a diff; validate.
- **Tabs in YAML.** They are not allowed. Editors should be configured to
  insert spaces.
- **Forgetting that `data` values in ConfigMaps are strings.** `PGPORT: 5432`
  fails; `PGPORT: "5432"` is correct.

## Related topics

- [Declarative model and reconciliation](declarative-model-and-reconciliation.md)
- [Namespaces](namespaces.md)
- [Labels, selectors and annotations](labels-selectors-annotations.md)
- [Manifest field reference](../reference/manifest-field-reference.md)
- [Removed API versions](../migration/removed-api-versions.md)
