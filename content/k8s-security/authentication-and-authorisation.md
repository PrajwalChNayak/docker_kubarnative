---
title: Authentication and authorisation
description: How the API server decides who you are and what you may do — X.509, OIDC and ServiceAccount tokens, then the Node, RBAC and Webhook authorisers in order.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/architecture
  - k8s-beginner/kubectl-fundamentals
---

## Overview

Every request to the Kubernetes API server passes through the same pipeline:
**authentication** (who are you?), then **authorisation** (may you do this?),
then **admission** (should this specific object be allowed, possibly mutated?).
This page covers the first two. Getting them right is the whole cluster layer
of the [4C model](4c-model.md): a request that fails authn is anonymous, and a
request that fails authz is `forbidden`, before any object is ever touched.

## Why it exists and when to use it

The API server is the single front door to the cluster. etcd is never accessed
directly by clients; the kubelet, controllers, `kubectl` and your pipelines all
go through the API server. That makes authn/authz the choke point where you can
actually enforce identity and least privilege. You configure it whenever you
add human users, wire up CI, or give a workload API access.

## How it works underneath

A request arrives with credentials. The API server runs its **authenticators**
in sequence until one accepts; the first to succeed sets the username and
groups, and the rest are skipped. If none accepts, the request is
`system:anonymous`. Authenticators include:

- **X.509 client certificates.** The certificate's Common Name is the username
  and its Organization fields are groups. Used by cluster components and by
  `kubeadm`-issued admin certs. Certificates cannot be revoked individually
  before expiry, so keep their lifetimes short.
- **OIDC / structured authentication.** The API server trusts an external
  identity provider (Entra ID, Okta, Google, Dex). The user presents an ID
  token; the API server validates its signature and maps claims to username and
  groups. This is how you should onboard **human users** — no per-user certs to
  rotate.
- **ServiceAccount tokens.** Signed JWTs the API server issues for in-cluster
  identities. Modern tokens are **bound, projected and audience-scoped** (see
  [service-accounts-and-tokens](service-accounts-and-tokens.md)); legacy
  static, never-expiring Secret-based tokens are discouraged.
- **Webhook token authentication** and **authenticating proxies** exist for
  bespoke setups.

Once authenticated, the request carries a username and a set of groups. The
API server then runs its **authorisers**, in the order configured by
`--authorization-config` (or the older `--authorization-mode`). The order is a
**union that stops at the first explicit decision**: the first authoriser to
say *allow* or *deny* wins; a "no opinion" falls through to the next. A typical
order is:

1. **Node** — the specialised authoriser for kubelets. It lets a node read only
   the objects (Secrets, ConfigMaps, pods) relevant to pods scheduled on *that*
   node, and is paired with the NodeRestriction admission plug-in.
2. **RBAC** — the general-purpose, role-based authoriser almost all access
   flows through. Covered in depth on the [rbac](rbac.md) page.
3. **Webhook** — delegates the decision to an external service, used by some
   managed providers to bridge cloud IAM.

:::legacy
**ABAC** (attribute-based access control) is the original, file-based
authoriser. It is still present but effectively legacy: policy lives in a file
on the control plane and changes require an API server restart. Prefer RBAC.
:::

## Basic example

You never write the authn config as a normal manifest, but you interrogate the
result constantly. Ask the API server who a token belongs to:

```bash
kubectl auth whoami --as=system:serviceaccount:tasklane:tasklane-api
```

```console include="captures/k8s-security/whoami-api-token-review.txt"
```

## Explanation

`kubectl auth whoami` (and `--as` impersonation) asks the API server to resolve
an identity through the same authenticators a real request would use, then
reports the username and groups. Every ServiceAccount lands in predictable
groups: `system:serviceaccounts` and `system:serviceaccounts:<namespace>`.
RBAC rules can target those groups, which is how you grant something to every
account in a namespace at once — powerful and occasionally dangerous.

## Common patterns

- **Humans via OIDC, workloads via ServiceAccounts.** Never share a human's
  kubeconfig with a pipeline, and never mint a human a long-lived
  ServiceAccount token.
- **Short-lived everything.** Prefer OIDC ID tokens and projected, expiring
  ServiceAccount tokens over static certs and Secret tokens.
- **Groups, not individuals, in RBAC.** Bind roles to OIDC groups so joiners
  and leavers are handled by the identity provider, not by editing RoleBindings.

## Production considerations

Authentication is not authorisation. A valid token only establishes identity;
what it can do is entirely RBAC's job, and a fresh ServiceAccount can do almost
nothing by default. Conversely, **anonymous access** is authentication too:
ensure `--anonymous-auth` is not granting `system:anonymous` anything through a
stray binding. The classic exposure is an authoriser order or a
`system:unauthenticated` binding that lets unauthenticated callers reach a
sensitive endpoint.

## Security considerations

- **X.509 certs cannot be revoked** before expiry, so treat a leaked admin cert
  as valid until it expires — keep lifetimes short and rotate.
- **The order of authorisers matters**: if a permissive Webhook authoriser runs
  before RBAC and returns allow, RBAC never gets to deny. Know your order.
- **Impersonation** (`--as`) is itself an RBAC-gated power (`impersonate`
  verb). Handing it out lets a subject become anyone; treat it like admin.

## Troubleshooting

A `Unauthorized` (401) means authentication failed — bad, missing or expired
credentials. A `Forbidden` (403) means authentication succeeded but no
authoriser allowed the action; the message names the user, verb and resource,
which is your starting point. Use `kubectl auth can-i` to reproduce the exact
authz question, and `kubectl auth whoami` to confirm the identity actually in
play.

## Common mistakes

- Confusing 401 (authn) with 403 (authz) and debugging the wrong half.
- Leaving a binding to `system:anonymous` or `system:unauthenticated` in place.
- Issuing long-lived certs or static tokens to humans and pipelines.
- Assuming a valid token implies permission — it does not; RBAC decides.

## Related topics

- [RBAC](rbac.md)
- [Service accounts and tokens](service-accounts-and-tokens.md)
- [Audit logging](audit-logging.md)
- [The 4C security model](4c-model.md)
