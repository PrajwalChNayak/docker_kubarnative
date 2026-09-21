---
title: Labels, selectors and annotations
description: How Kubernetes finds objects without knowing their names, and why the recommended app.kubernetes.io labels are worth the typing.
level: beginner
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/manifest-anatomy
---

## Overview

Kubernetes almost never refers to objects by name. A Service does not list
pods; it carries a **selector**, and the set of matching pods is computed
continuously. A Deployment owns pods whose labels match its selector. A
NetworkPolicy allows traffic from pods with certain labels. Labels are the
join key of the whole system.

Annotations look similar and do the opposite job: arbitrary, non-selectable
metadata for tools and controllers.

## Why it exists and when to use it

Name-based references break the moment something is replaced, and in
Kubernetes everything is replaced. Pods get new names on every rollout, so a
Service that named pods would be wrong within seconds of a deploy. A label
selector stays true across replacements because it describes a *kind* of pod
rather than a specific one.

The same mechanism gives you ad-hoc querying: "all api pods across every
namespace", "everything belonging to Tasklane", "everything from revision
7". That is worth keeping tidy from day one, because you cannot
retro-fit labels onto an incident.

## How it works underneath

### Labels

`metadata.labels` is a string map, indexed by the API server so that
`?labelSelector=` queries are cheap. Constraints:

- **Key** — an optional DNS-subdomain prefix, a `/`, then a name of at most
  63 characters (alphanumerics, `-`, `_`, `.`). Prefixes such as
  `app.kubernetes.io/` and `kubernetes.io/` are reserved for shared meaning;
  `kubernetes.io/` and `k8s.io/` are reserved for the project itself.
- **Value** — at most 63 characters, alphanumerics plus `-`, `_`, `.`, or
  empty.

Two selector dialects exist:

| Dialect | Example | Where |
|---|---|---|
| Equality | `app=api`, `tier!=db` | `kubectl -l`, older APIs, Service `spec.selector` |
| Set-based | `env in (prod,staging)`, `!canary` | `kubectl -l`, `matchExpressions` in modern APIs |

In manifests the structured form appears as `matchLabels` (an AND of
equalities) and `matchExpressions` (operators `In`, `NotIn`, `Exists`,
`DoesNotExist`). All terms are ANDed. There is no OR; that is deliberate, and
it pushes you to label objects with the thing you actually want to select.

Service `spec.selector` is the exception: it is a plain map, equality only,
and it has no `matchExpressions`.

### The recommended labels

Kubernetes defines a shared vocabulary so that tools written by strangers can
group your objects:

| Label | Tasklane value |
|---|---|
| `app.kubernetes.io/name` | `tasklane-api`, `tasklane-worker`, `postgres` |
| `app.kubernetes.io/component` | `api`, `worker`, `database` |
| `app.kubernetes.io/part-of` | `tasklane` |
| `app.kubernetes.io/instance` | a deployed instance's unique name |
| `app.kubernetes.io/version` | the application version |
| `app.kubernetes.io/managed-by` | the tool that manages the object |

The handbook uses the first three everywhere and leaves the rest to the
packaging layer (Helm sets `instance` and `managed-by` for you).

### Selectors that cannot change

A Deployment's, StatefulSet's and DaemonSet's `spec.selector` is
**immutable** after creation. It must also match the pod template's labels,
or the API server rejects the object. Choose a selector made of stable
identity labels (`app.kubernetes.io/name`) and keep volatile information
(version, revision) out of it.

The Deployment controller adds one label of its own to each ReplicaSet and
pod: **`pod-template-hash`**, a hash of the pod template. It is what keeps
two ReplicaSets of the same Deployment from adopting each other's pods, and
it is why you can tell old pods from new ones during a rollout.

### Annotations

`metadata.annotations` is also a string map, but it is not indexed and not
selectable, and values may be large. It carries data for tools:

| Annotation | Written by |
|---|---|
| `kubectl.kubernetes.io/last-applied-configuration` | client-side `kubectl apply` |
| `kubernetes.io/change-cause` | you; shown by `kubectl rollout history` |
| `deployment.kubernetes.io/revision` | the Deployment controller, on each ReplicaSet |
| `kubectl.kubernetes.io/restartedAt` | `kubectl rollout restart` |
| Ingress/Gateway controller options, cert-manager issuers, Prometheus scrape hints | third-party controllers |

Annotations are how a controller extends an object it does not own the schema
of. They are also where secrets accidentally end up; see below.

## Basic example

```yaml title="labels live in three places in a Deployment" fragment
metadata:
  labels:                              # 1. labels ON the Deployment object
    app.kubernetes.io/name: hello-api
spec:
  selector:
    matchLabels:                       # 2. which pods this Deployment owns (immutable)
      app.kubernetes.io/name: hello-api
  template:
    metadata:
      labels:                          # 3. labels ON the pods; must match (2)
        app.kubernetes.io/name: hello-api
        app.kubernetes.io/component: api
        app.kubernetes.io/part-of: tasklane
```

The full object is in
[20-deployment.yaml](../../examples/k8s/basics/20-deployment.yaml).

```bash
kubectl -n tasklane get pods --show-labels
kubectl -n tasklane get pods -l 'app.kubernetes.io/component in (api,worker)' -o wide
kubectl -n tasklane get pods -L app.kubernetes.io/component,pod-template-hash
```

```console include="captures/k8s-beginner/tasklane-pods-labels.txt"
```

```console include="captures/k8s-beginner/tasklane-pods-label-columns.txt"
```

## Explanation

The Deployment carries labels in two places, and they are not the same thing:

- `metadata.labels` label the **Deployment object**. They are how you find
  the Deployment; nothing selects pods with them.
- `spec.template.metadata.labels` label the **pods**. These must match
  `spec.selector.matchLabels`, and these are what Services select.

Forgetting this is the single most common labelling bug: a Service whose
selector matches the Deployment's labels instead of the pod template's
labels, which produces a Service with no endpoints.

`--show-labels` prints every label as a column; `-L key` adds one column per
key, which is the readable way to watch `pod-template-hash` change during a
rollout.

Ad-hoc label edits are sometimes exactly the right tool:

```bash
kubectl -n tasklane label pod <pod> debug=true
kubectl -n tasklane label pod <pod> app.kubernetes.io/name-
```

Removing the label a ReplicaSet selects on (the trailing `-` deletes a label)
**orphans** the pod: the ReplicaSet notices it is one short and creates a
replacement, while the orphan keeps running for you to inspect. It is the
classic way to take a misbehaving pod out of service without losing it.

## Common patterns

- **Identity labels in selectors, descriptive labels outside them.** Name and
  component are stable; version and revision are not.
- **Label by intent for policy**: `tier=frontend`, `data-classification=pii`,
  `network=restricted`. NetworkPolicies and admission policies then read like
  sentences.
- **Use annotations for anything a human should read but nothing should
  select**: owner, ticket link, runbook URL, change cause.
- **Standardise `part-of` per system** so one selector collects an entire
  application: `kubectl get all -l app.kubernetes.io/part-of=tasklane`.
- **Use `kubectl label --overwrite` in scripts**; without it, re-labelling an
  object fails.

## Production considerations

- **Labels drive cost reporting and dashboards.** Prometheus, Grafana and
  most cost tools group by label; missing labels mean invisible spend.
- **Changing a Deployment's selector requires recreating it.** Plan the
  scheme once, cluster-wide, and document it.
- **Cardinality matters.** Labels become metric series; a label whose value
  is a pod ID or a timestamp will multiply your monitoring bill.
- **Annotations have no size guard beyond the object limit.** Large
  annotations (a whole rendered manifest, for example) bloat etcd and every
  watch that carries the object.
- **`kubectl get all` is not all.** It covers a fixed list of kinds, not
  CRDs. Select by label across explicit kinds instead.

## Security considerations

- **Labels are a control-plane input.** A pod that can label itself, or a
  namespace, can change which NetworkPolicy and which Pod Security profile
  applies. Do not grant `patch` on namespaces casually.
- **Never put secrets in annotations or labels.** Both are readable by anyone
  with `get` on the object, appear in `kubectl describe`, and end up in
  backups and audit logs.
- **`last-applied-configuration` copies the whole manifest into an
  annotation.** If a Secret is applied client-side, its values sit in that
  annotation too. Server-side apply avoids this; so does creating Secrets
  outside of applied manifests.
- **Selector-based policy fails open.** A NetworkPolicy that selects
  `app=api` protects nothing if the pods are labelled `app.kubernetes.io/name=api`.
  Verify with `kubectl get pods -l <selector>` before trusting a policy.

## Troubleshooting

- **Service has no endpoints** — the selector does not match pod labels.
  `kubectl get pods -l <the service's selector>` returns nothing, which is
  the proof.
- **`selector does not match template labels`** — the Deployment's own
  consistency check; fix the pod template.
- **`field is immutable`** on a Deployment apply — you changed
  `spec.selector`. Recreate the Deployment, or roll out a new name.
- **Two Deployments fighting over pods** — overlapping selectors. Each sees
  too many replicas and deletes the other's pods.
- **A pod that will not go away** — it may have been orphaned by a label
  edit; nothing owns it, so delete it explicitly.

## Common mistakes

- **Selecting on the Deployment's labels rather than the pod template's.**
- **Putting the version in the selector,** which makes every release a
  selector change and therefore impossible.
- **Inventing a private label scheme** instead of the `app.kubernetes.io/*`
  set, then finding that no tool groups your objects.
- **Using annotations where labels are needed.** You cannot select on an
  annotation, and `--field-selector` does not read them.
- **Uppercase or over-long values.** Values are limited to 63 characters, and
  many are used as DNS labels.

## Related topics

- [Manifest anatomy](manifest-anatomy.md)
- [Deployments and ReplicaSets](deployments-and-replicasets.md)
- [Services](services.md)
- [kubectl fundamentals](kubectl-fundamentals.md)
- [Network policy](../k8s-intermediate/network-policy.md)
