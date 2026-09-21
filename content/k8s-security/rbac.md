---
title: RBAC in depth
description: Roles, ClusterRoles and bindings, aggregation, the dangerous verbs escalate, bind and impersonate, wildcard risks, and how to audit real permissions.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-security/authentication-and-authorisation
  - k8s-beginner/namespaces
---

## Overview

Role-Based Access Control is the authoriser almost every request flows
through. It answers one question: may this **subject** (user, group or
ServiceAccount) perform this **verb** (get, list, create, patch, delete…) on
this **resource** (pods, secrets, deployments…), in this **scope** (a namespace
or the whole cluster)? RBAC is **purely additive**: there are no deny rules, so
a subject can do the union of everything its bindings grant, and nothing else.

## Why it exists and when to use it

RBAC is how you implement least privilege at the cluster layer. You reach for
it every time you onboard a user or group, give a workload API access, or scope
a pipeline. The default posture is strong — a new ServiceAccount can do almost
nothing — so RBAC is mostly about **granting the minimum**, then **auditing that
you did not grant too much**.

## How it works underneath

Four object types, in two pairs:

- **Role** / **ClusterRole** hold rules (`apiGroups`, `resources`, `verbs`).
  A Role is namespaced; a ClusterRole is cluster-wide and can also cover
  cluster-scoped resources (nodes, namespaces, PersistentVolumes) and
  non-resource URLs.
- **RoleBinding** / **ClusterRoleBinding** attach a Role or ClusterRole to
  subjects. A RoleBinding grants within one namespace (and can reference a
  ClusterRole, applying its rules *only* in that namespace). A
  ClusterRoleBinding grants cluster-wide.

The authoriser walks the subject's bindings, expands each to its rules, and
allows the request if any rule matches the verb, resource and scope. There is
no ordering and no precedence because there is no deny — evaluation is a simple
"does any rule permit this?".

**Aggregation** lets a ClusterRole collect rules from others via an
`aggregationRule` label selector. This is how the built-in `view`, `edit` and
`admin` roles pick up permissions for CRDs automatically: a CRD ships a
ClusterRole labelled `rbac.authorization.k8s.io/aggregate-to-view: "true"` and
its rules flow into `view`.

## Basic example

The Tasklane deployer is a least-privilege Role: it manages workload objects
and nothing else.

```yaml include="examples/k8s/rbac/deployer.yaml" lines="21-39"
```

The observer reuses the built-in `view` ClusterRole through a namespaced
RoleBinding, which deliberately excludes Secrets:

```yaml include="examples/k8s/rbac/observer.yaml" lines="23-36"
```

## Explanation

The deployer Role names exactly the resources a rollout touches, with exactly
the verbs it needs, and no `secrets` entry at all. Because it is a Role bound by
a RoleBinding, it cannot reach any other namespace. The observer shows the
other half of good RBAC: **reuse the aggregated built-ins** where they fit.
`view` is maintained by the project, already excludes Secrets (reading a Secret
equals reading its contents), and automatically covers new CRDs — you would
have to work to reproduce that safely by hand.

## The dangerous verbs and wildcards

Three verbs let a subject increase its own power and must be treated as
privileged:

| Verb | On | Why it is dangerous |
|---|---|---|
| `escalate` | roles/clusterroles | Create or edit a role granting **more than the subject already has**. Normally RBAC stops you writing a role you could not use; `escalate` removes that guard. |
| `bind` | rolebindings/clusterrolebindings | Bind an existing role to any subject, including binding `cluster-admin` to yourself. |
| `impersonate` | users/groups/serviceaccounts | Act as another identity, inheriting its permissions. |

Wildcards (`resources: ["*"]`, `verbs: ["*"]`, `apiGroups: ["*"]`) are their
own hazard: they grant permissions on resources that **do not exist yet**, so
installing a new CRD or a new API version silently widens the grant. Prefer
explicit lists. A ClusterRoleBinding to a wildcard ClusterRole is effectively
`cluster-admin`.

## Common patterns

- **Namespaced Role first.** Reach for a cluster-wide grant only when the
  resource is genuinely cluster-scoped or the access must span namespaces.
- **Bind to groups.** Attach roles to OIDC groups so membership is managed in
  the identity provider.
- **`resourceNames` to pin objects.** Grant `get` on one named ConfigMap rather
  than all ConfigMaps when you can.
- **Reuse `view`/`edit`/`admin`** rather than re-deriving read/write roles.

## Production considerations

RBAC sprawls. Over time, bindings accumulate and nobody remembers why. Audit
what subjects *can actually do*, not what you think you granted, with
`kubectl auth can-i`:

```bash
kubectl auth can-i --list \
  --as=system:serviceaccount:tasklane:tasklane-deployer -n tasklane
```

```console include="captures/k8s-security/rbac-deployer-can-i-list.txt"
```

Tools such as **rbac-tool** (`rbac-tool who-can`, `rbac-tool policy-rules`) and
**rakkess** (`kubectl access-matrix`) turn the whole cluster's RBAC into a
readable matrix and answer "who can read Secrets in namespace X?" — the
question that matters most. Run them in CI against your manifests.

## Security considerations

The negative checks are the point. A workload account must fail these:

```bash
kubectl auth can-i get secrets \
  --as=system:serviceaccount:tasklane:tasklane-deployer -n tasklane
```

```console include="captures/k8s-security/rbac-deployer-secrets-no.txt"
```

If any of `get secrets`, `create pods/exec`, `create rolebindings`, or
`impersonate` returns `yes` for a workload account, that account is a lateral
movement and privilege escalation risk — exactly the path dissected in
[attack-rbac-token-abuse](attack-rbac-token-abuse.md). Read access to Secrets
is read access to their contents; `pods/exec` is a shell into other workloads;
`escalate`/`bind` is self-promotion to admin.

## Troubleshooting

A `forbidden` error names the user, verb and resource — reproduce it with
`kubectl auth can-i <verb> <resource> --as=<subject> -n <ns>`. If the answer is
`no` but you expected `yes`, check the **scope**: a Role only works in its own
namespace, and a ClusterRole needs a ClusterRoleBinding (or a RoleBinding, which
scopes it down). If a subject can do more than expected, list every binding that
targets it and its groups (`system:serviceaccounts:<ns>` is easy to grant to by
accident).

## Common mistakes

- Granting `cluster-admin` or a wildcard ClusterRole to a workload
  ServiceAccount "to make it work".
- Using `resources: ["*"]`/`verbs: ["*"]`, which silently expands as new CRDs
  and API versions appear.
- Forgetting that a RoleBinding to a ClusterRole scopes the grant to one
  namespace — and being surprised it does not span the cluster.
- Handing out `impersonate`, `escalate` or `bind` without realising they are
  admin-equivalent.
- Auditing intent (the YAML) instead of effect (`auth can-i`, rbac-tool).

## Related topics

- [Authentication and authorisation](authentication-and-authorisation.md)
- [Service accounts and tokens](service-accounts-and-tokens.md)
- [RBAC token abuse, and how to close it](attack-rbac-token-abuse.md)
- [Audit logging](audit-logging.md)
