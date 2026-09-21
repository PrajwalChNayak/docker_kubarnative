---
title: ServiceAccounts and projected tokens
description: How pods get an identity, why modern tokens are bound, projected and audience-scoped, and why you should turn auto-mounting off by default.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-security/authentication-and-authorisation
  - k8s-beginner/secrets
---

## Overview

A **ServiceAccount** is the identity a pod presents to the API server. Every
pod runs as one — the namespace's `default` account if you do not choose
another. The token that proves that identity has changed a great deal: modern
tokens are **bound** to a specific pod, **projected** into the pod as a file,
**audience-scoped**, and **expiring**. This page is about getting an identity
onto a pod safely and, just as important, keeping a token off pods that do not
need one.

## Why it exists and when to use it

Workloads that call the Kubernetes API — controllers, operators, some
sidecars — need an identity RBAC can target. Most application pods, Tasklane's
included, never call the API at all, and for them the right amount of token is
**none**. So the two jobs are: give the few workloads that need API access a
narrowly-scoped account, and stop everything else from carrying a credential
it could leak.

## How it works underneath

Historically, creating a ServiceAccount also created a **static Secret** holding
a JWT that never expired, and the token was mounted into every pod using that
account. A leaked token was valid forever and was not tied to any pod.

Modern clusters use the **TokenRequest** API and **projected service-account
token** volumes instead:

- The kubelet requests a token for the pod from the API server and projects it
  as a file, by default at
  `/var/run/secrets/kubernetes.io/serviceaccount/token`.
- The token is **bound** to that pod object (and its ServiceAccount): when the
  pod is deleted, the token stops working.
- It has an **expiry** (typically an hour) and the kubelet **rotates** it in
  place before it lapses.
- It is **audience-scoped** — issued for the `kubernetes` API audience by
  default, and you can request tokens for other audiences so a token meant for
  one service cannot be replayed against another.

You can mint one directly to see the mechanism (truncated so no usable token is
printed):

```bash
kubectl create token tasklane-api -n tasklane --duration=10m | cut -c1-20
```

```console include="captures/k8s-security/sa-api-create-token.txt"
```

## Basic example

The most important field is often the one that turns tokens **off**. Tasklane's
API never talks to the API server, so its ServiceAccount disables auto-mounting:

```yaml include="examples/k8s/03-app/api.yaml" lines="1-12"
```

## Explanation

`automountServiceAccountToken: false` means no token volume is projected into
the pod at all. There is then no credential in the container for an attacker to
steal if the app is compromised — the single most effective ServiceAccount
hardening step, and it costs nothing for a workload that does not use the API.
You can set it on the **ServiceAccount** (applies to every pod using it) or on
an individual **Pod spec** (wins for that pod). Set it at both levels for
defence in depth on sensitive workloads.

When a pod *does* need API access, prefer a **projected token with an explicit
audience and expiry** over relying on the default mount, and give the account a
tightly scoped Role.

## Common patterns

- **Dedicated account per workload.** Never share one ServiceAccount across
  unrelated deployments, and never use `default` for anything that has
  permissions.
- **Disable the `default` account's auto-mount** namespace-wide, then opt
  specific pods back in.
- **`kubernetes.io/enforce-mountable-secrets`.** Annotating a ServiceAccount
  with this restricts which Secrets pods using it may mount to those listed in
  the account's `secrets` field — a guard against a compromised workload
  mounting arbitrary Secrets.
- **Projected audience tokens** for talking to non-Kubernetes services (e.g. a
  token a sidecar presents to Vault) so credentials are not reusable elsewhere.

## Production considerations

Auto-mounting is on by default for backwards compatibility, so a fresh cluster
projects a token into most pods whether they use it or not. Sweep for it: any
pod with a mounted token that never calls the API is needless exposure. For the
workloads that do call the API, watch token **expiry and rotation** — an
application that reads the token once at startup and caches it forever will
break when the kubelet rotates the file; read it from disk on each use.

## Security considerations

A ServiceAccount token is a bearer credential: whoever holds it *is* that
identity. The controls, in order of impact:

1. **No token where none is needed** (`automountServiceAccountToken: false`).
2. **Least-privilege RBAC** so that even a stolen token can do little.
3. **Bound, short-lived, audience-scoped tokens** so a leaked token expires and
   cannot be replayed against other services.

:::danger
Everything in this handbook runs only in the disposable local **kind** lab.
Minting and inspecting tokens, and applying the RBAC and PSA examples, is safe
there and must not be pointed at a shared or production cluster.
:::

Avoid re-introducing **static, never-expiring token Secrets**. They exist for
legacy integrations that cannot use TokenRequest; if you must create one, treat
it as a long-lived credential with all the rotation burden that implies.

## Troubleshooting

If an in-cluster client gets `401 Unauthorized`, the token may have expired and
not been re-read from disk. If it gets `403 Forbidden`, authentication worked
but RBAC denied it — check with `kubectl auth can-i --as=system:serviceaccount:<ns>:<name>`.
If a pod unexpectedly has no token, confirm `automountServiceAccountToken` on
both the pod and its ServiceAccount. Inspect the account with:

```bash
kubectl -n tasklane get sa tasklane-api -o yaml
```

```console include="captures/k8s-security/sa-api-get-yaml.txt"
```

## Common mistakes

- Leaving auto-mount on for pods that never call the API.
- Using the `default` ServiceAccount and then binding it a role.
- Caching a projected token forever instead of re-reading the rotating file.
- Creating static token Secrets out of habit when TokenRequest would do.
- Reusing one audience/token across services, making it replayable.

## Related topics

- [RBAC in depth](rbac.md)
- [Secrets management](secrets-management.md)
- [Authentication and authorisation](authentication-and-authorisation.md)
- [RBAC token abuse, and how to close it](attack-rbac-token-abuse.md)
