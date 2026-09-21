---
title: RBAC token abuse, and how to close it
description: A defensive analysis of how a compromised pod's over-broad ServiceAccount token becomes a cluster compromise, and the RBAC controls that prevent it.
level: expert
type: reference
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-security/rbac
  - k8s-security/service-accounts-and-tokens
---

## Overview

This page analyses the path from a **compromised pod** to a **cluster
compromise** through an over-permissioned ServiceAccount token, and the RBAC
controls that break it. It is defensive: we describe the capability a broad
token confers and the blast radius, not a step-by-step token-abuse recipe.

:::danger
Everything here runs only in the disposable local **kind** lab. The vulnerable
binding exists only to contrast with the scoped one and to show `auth can-i`
verification. Never apply a `cluster-admin` workload binding to a real cluster.
:::

## Threat model

- **Precondition.** A pod's ServiceAccount is bound to a powerful role —
  `cluster-admin`, a wildcard ClusterRole, blanket `secrets` read, or the
  `escalate`/`bind`/`impersonate` verbs — and the pod carries the token
  (auto-mount left on).
- **Adversary.** Anything that can execute in the pod: an RCE in the app, a
  malicious dependency, a poisoned image.
- **Asset at risk.** Every Secret and workload the token's role can reach —
  which, for `cluster-admin`, is the entire cluster.

## The path, at the level of capability

A pod that talks to the API server reads its token from
`/var/run/secrets/kubernetes.io/serviceaccount/token`. If the app is
compromised, so is that token — it is a bearer credential, and whoever holds it
**is** that identity. What the attacker can then do is exactly what the token's
role grants:

- With **`cluster-admin`**: read every Secret in every namespace (database
  passwords, cloud credentials, other apps' tokens), create or modify workloads
  anywhere, and grant themselves durable access. A cluster-wide skeleton key.
- With **blanket `secrets` read**: harvest credentials across namespaces and
  pivot into the systems those credentials unlock.
- With **`escalate`/`bind`**: write themselves a role more powerful than they
  started with, or bind `cluster-admin` to their own account — self-promotion.
- With **`impersonate`**: act as any other user or ServiceAccount.

The vulnerable binding that establishes the precondition:

```yaml include="examples/security/k8s/rbac-over-permission/vulnerable.yaml" lines="18-29"
```

The single line that reveals it: `kubectl auth can-i '*' '*' -A` for the account
returns `yes`.

## Controls that break the path

1. **Least-privilege RBAC.** Grant only the verbs and resources the workload
   needs, in the narrowest scope — a namespaced `Role` + `RoleBinding`, with
   `resourceNames` where possible, and **never** `secrets` read or the dangerous
   verbs for a workload account.
2. **No token where none is needed.** `automountServiceAccountToken: false`
   means there is no credential in the pod to steal in the first place.
3. **Bound, short-lived, audience-scoped tokens** so a leaked token expires and
   cannot be replayed against other services.
4. **Audit RBAC continuously** with `kubectl auth can-i` and tools like
   rbac-tool/rakkess, alerting on any workload that can read Secrets cluster-wide
   or holds `escalate`/`bind`/`impersonate`.

The scoped replacement grants read on two named ConfigMaps and nothing else:

```yaml include="examples/security/k8s/rbac-over-permission/fixed.yaml" lines="11-20"
```

## Verify

Ask the authorizer directly. The scoped account can read its ConfigMaps but not
Secrets, and cannot reach other namespaces:

```bash
kubectl apply -f examples/security/k8s/rbac-over-permission/namespace.yaml
kubectl apply -f examples/security/k8s/rbac-over-permission/fixed.yaml
kubectl auth can-i get secrets \
  --as=system:serviceaccount:rbac-demo:app -n rbac-demo
```

```console include="captures/k8s-security/rbac-overperm-scoped-secrets-no.txt"
```

A `no` here is the proof: even if this pod is fully compromised, its token opens
almost nothing. `kubectl auth can-i` asks the API server the exact question a
real request would, so it is authoritative, not an approximation.

## Common mistakes

- Binding `cluster-admin` or a wildcard ClusterRole to a workload to "make it
  work", then never scoping it back.
- Leaving auto-mount on for pods that never call the API.
- Granting `secrets` read, `escalate`, `bind` or `impersonate` to a workload.
- Auditing the YAML you wrote instead of the effective permissions
  (`auth can-i`, rbac-tool).

## Related topics

- [RBAC in depth](rbac.md)
- [Service accounts and tokens](service-accounts-and-tokens.md)
- [Authentication and authorisation](authentication-and-authorisation.md)
- [Common attack paths](common-attack-paths.md)
