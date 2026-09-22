# RBAC over-permission

## Threat

A workload's ServiceAccount is bound to `cluster-admin` (or to any role that
grants secrets-wide access or the `escalate`/`bind`/`impersonate` verbs).

## Why it is dangerous

Every pod using that ServiceAccount carries a token with the role's power. A
`cluster-admin` binding turns the application's token into a **cluster
super-user token**. If the pod is compromised, the attacker can:

- read **every Secret in every namespace** (database passwords, cloud
  credentials, other apps' tokens),
- create or modify workloads anywhere in the cluster,
- grant themselves durable access.

The `escalate` and `bind` verbs are especially dangerous because they let a
subject create RBAC that exceeds its own permissions; `impersonate` lets it
act as any other user or group. A `ClusterRoleBinding` also crosses every
namespace boundary, so scoping the workload to one namespace gives no
protection. (The mechanism is what matters here — a broad token is a skeleton
key — not a step-by-step recipe for using it.)

## Control

Grant the **least privilege** the workload actually needs, in the **narrowest
scope**:

- Prefer a namespaced `Role` + `RoleBinding` over a `ClusterRole` binding.
- Name specific resources with `resourceNames` where you can.
- Never grant `secrets` read, `*` verbs/resources, or `escalate`/`bind`/
  `impersonate` to a workload account.

`fixed.yaml` gives the app read access to two named ConfigMaps and nothing
else.

## Verify

```bash
kubectl apply -f examples/security/k8s/rbac-over-permission/namespace.yaml
kubectl apply -f examples/security/k8s/rbac-over-permission/fixed.yaml
```

The scoped account can read its ConfigMaps but not Secrets, and cannot reach
other namespaces:

```bash
kubectl auth can-i get configmaps \
  --as=system:serviceaccount:rbac-demo:app -n rbac-demo          # yes
kubectl auth can-i get secrets \
  --as=system:serviceaccount:rbac-demo:app -n rbac-demo          # no
kubectl auth can-i get secrets \
  --as=system:serviceaccount:rbac-demo:app -n kube-system        # no
kubectl auth can-i '*' '*' \
  --as=system:serviceaccount:rbac-demo:app -A                    # no
```

For contrast, the same `auth can-i '*' '*' -A` against the vulnerable
`cluster-admin` binding returns `yes` — the one-line signal that an account is
far too powerful.
