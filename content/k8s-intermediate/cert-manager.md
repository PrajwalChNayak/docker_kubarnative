---
title: cert-manager
description: Issuing and renewing X.509 certificates in-cluster - Issuers, the Certificate to Order to Challenge chain, ACME HTTP-01 vs DNS-01, and the Gateway API integration.
level: intermediate
type: concept
status: current
versions: Kubernetes 1.37, cert-manager v1.21.2
prerequisites:
  - k8s-beginner/secrets
  - k8s-intermediate/gateway-api-tls-and-traffic
---

## Overview

cert-manager is a controller that obtains and renews X.509 certificates and
stores them in Secrets, so your workloads never touch a certificate authority
directly. It adds a small set of CRDs (`cert-manager.io` and `acme.cert-manager.io`)
and reconciles them the way Kubernetes reconciles everything else: you declare
the certificate you want, cert-manager makes it exist and keeps it valid.

This handbook uses **cert-manager v1.21.2** to build a private CA for the
Tasklane Gateway's TLS listener. The same controller, pointed at a public ACME
issuer, produces publicly-trusted certificates the same way.

## Why it exists and when to use it

Certificates expire, and a certificate that expires unnoticed is a full outage.
Doing it by hand — generating keys, submitting CSRs, copying PEM into Secrets,
remembering to renew before 90 days — does not scale past a handful of services
and fails exactly when someone is on holiday. cert-manager makes issuance and
**renewal** declarative and automatic: it renews ahead of expiry, rewrites the
Secret in place, and the consuming Gateway or workload picks the new key pair up.

Use it for every certificate a cluster needs: Gateway/Ingress TLS, mTLS between
services, webhook serving certificates, and internal CAs.

## How it works underneath

The objects form a chain, each reconciled by its own controller inside
cert-manager:

- **Issuer / ClusterIssuer** — *how* certificates are signed. An `Issuer` is
  namespaced; a `ClusterIssuer` is cluster-scoped and reads its backing Secrets
  from cert-manager's own namespace (the "cluster resource namespace"). Types
  include `selfSigned`, `ca` (sign from a CA key pair in a Secret), `acme`
  (Let's Encrypt and other ACME CAs), `vault` and external issuers.
- **Certificate** — *what* you want: DNS names, duration, `renewBefore`, key
  algorithm, and the `secretName` to write. This is the object you normally
  author.
- **CertificateRequest** — cert-manager creates one per issuance from a
  Certificate. It carries the encoded CSR and a reference to the issuer. It is
  immutable; a renewal produces a new one.
- **Order** and **Challenge** — created only for ACME issuers. An `Order` drives
  the ACME protocol; one or more `Challenge` objects prove control of each name.

The reconciliation for the lab's CA path:

1. You create a `selfSigned` ClusterIssuer, a CA `Certificate` (`isCA: true`)
   that it signs, and a `ca` ClusterIssuer backed by that CA's key pair.
2. You create a leaf `Certificate`. cert-manager generates a private key and a
   `CertificateRequest`.
3. The `ca` issuer signs the request. cert-manager writes `tls.crt`, `tls.key`
   and `ca.crt` into the named Secret.
4. It records the not-after time and schedules a renewal at `renewBefore`. At
   that point it repeats from step 2, rewriting the same Secret.

**ACME solvers** prove you control a name:

| Challenge | Proves control by | Use when |
|---|---|---|
| **HTTP-01** | serving a token at `http://<name>/.well-known/acme-challenge/...` | the name is publicly reachable over HTTP; cannot do wildcards |
| **DNS-01** | creating a `_acme-challenge` TXT record | you need wildcards, or the name is not publicly reachable over HTTP; needs DNS provider credentials |

The lab uses **neither**. `tasklane.localhost` is not publicly resolvable, so
ACME cannot validate it, and a private CA is the honest choice — every reader
gets a working certificate with no external dependency. For a real public name,
an `acme` ClusterIssuer with an HTTP-01 or DNS-01 solver replaces the two CA
issuers, and everything downstream is unchanged.

## Basic example

The lab's issuer chain: a self-signed ClusterIssuer signs a CA Certificate,
which backs the CA ClusterIssuer that every Tasklane certificate then uses:

```yaml include="examples/k8s/05-tls/10-issuers.yaml"
```

The serving certificate for the Gateway listener names its DNS name, its
lifetime, and the Secret to fill:

```yaml include="examples/k8s/05-tls/20-certificate.yaml"
```

Install cert-manager and its CRDs with Helm, then apply the objects:

```bash
helm repo add jetstack https://charts.jetstack.io
helm upgrade --install cert-manager jetstack/cert-manager --namespace cert-manager --create-namespace --version v1.21.2 --set crds.enabled=true
```

```console include="captures/k8s-intermediate/tls-apply.txt"
```

## Explanation

The CA certificate lives in cert-manager's namespace because a `ClusterIssuer`
can only read Secrets from there. The leaf `Certificate` sits in `tasklane`
alongside the Gateway that consumes it. cert-manager signs the leaf, writes the
Secret, and — because the CA issuer copies its own certificate into the leaf
Secret's `ca.crt` — a client trusts the whole chain from that one file, which is
exactly what `curl --cacert` and the Gateway need.

`duration: 2160h` with `renewBefore: 360h` mirrors a public ACME certificate:
90-day life, renew at 15 days out. cert-manager renews on its own timer;
nothing here needs a cron job. `privateKey.rotationPolicy: Always` generates a
fresh key on every renewal, so a leaked key has a bounded lifetime.

```bash
kubectl -n cert-manager get pods && kubectl get clusterissuer && kubectl -n tasklane get certificate,certificaterequest,secret tasklane-tls
```

```console include="captures/k8s-intermediate/cert-manager-objects.txt"
```

## Common patterns

**A ClusterIssuer per trust domain.** One `acme` ClusterIssuer for public names,
one `ca` ClusterIssuer for internal mTLS, referenced by name from every
Certificate. ClusterIssuers avoid duplicating issuer config into every namespace.

**Let cert-manager watch the Gateway.** cert-manager can create Certificates
directly from annotations on a Gateway, so you never author the Certificate
object by hand — see the integration below.

**Short-lived leaves, automatic renewal.** Prefer 90-day (or shorter) leaves
with `renewBefore` set generously. Short lifetimes limit the damage of a leaked
key and force the renewal path to be exercised routinely rather than in a crisis.

**`rotationPolicy: Always` for serving keys.** Rotate the private key on each
renewal unless a pinned key is a hard requirement.

:::note Gateway API integration
cert-manager can issue certificates for a Gateway from annotations, so the
listener's Secret is created and renewed without a hand-written `Certificate`.
Verified against the cert-manager docs for v1.21:

- Enable it with the Helm value **`config.gatewayAPI.enabled=true`**. Gateway
  API support is **no longer feature-gated since cert-manager 1.15** (it is a
  stable, file-config option now).
- Annotate the `Gateway` with **`cert-manager.io/cluster-issuer: <name>`** (or
  `cert-manager.io/issuer` for a namespaced Issuer). cert-manager reads the
  listener's `hostname` and `certificateRefs` and manages the Secret.

The lab does **not** use this: stage 5 writes the `Certificate` object
explicitly, which works on any 1.21 install regardless of that Helm value. Both
approaches are valid; the explicit object is the more portable teaching example.
:::

## Production considerations

Renewal is the feature; monitor it. Alert on Certificates whose `Ready`
condition is not `True`, and on ACME issuance failures — a rate-limited
Let's Encrypt account or a broken DNS-01 credential fails silently until the
existing certificate expires. cert-manager exposes metrics for certificate
expiry; wire them into [certificate rotation](../operations/certificate-rotation.md)
monitoring.

ACME rate limits are real. Let's Encrypt limits certificates per registered
domain per week; a reconcile loop that recreates Certificates can exhaust them.
Use the **staging** ACME endpoint while testing, and switch to production only
when issuance works.

DNS-01 needs provider credentials with permission to write TXT records. Scope
that credential to the specific zone, and prefer per-issuer credentials over a
cluster-wide one. HTTP-01 needs the name publicly reachable on port 80, which is
sometimes the deciding constraint.

Back up the CA key pair for a private `ca` issuer. It is an ordinary Secret, and
losing it means re-issuing and re-trusting every leaf it signed.

## Security considerations

The CA issuer's key pair is a signing key: whoever can read that Secret can mint
certificates trusted by everything that trusts the CA. Restrict access to
cert-manager's namespace, and treat the CA Secret like any other high-value
credential.

`ClusterIssuer` is cluster-scoped, so any namespace can reference it. That is
convenient and also a trust decision — a namespace you do not fully trust can
obtain certificates from a shared issuer. Where that matters, use namespaced
`Issuer` objects so issuance is scoped.

A leaked leaf key is bounded by the certificate's lifetime and
`rotationPolicy: Always`; a leaked CA key is not bounded at all until you rotate
the CA and re-trust. This is the argument for short leaves and a carefully
guarded CA.

## Troubleshooting

Certificate status tells the story; walk the chain from Certificate to
CertificateRequest to (for ACME) Order and Challenge:

```bash
kubectl -n tasklane describe certificate tasklane-tls
```

```console include="captures/k8s-intermediate/certificate-describe.txt"
```

- **Certificate `Ready=False`** — read its events, then the linked
  `CertificateRequest`. `Pending` usually means the issuer has not signed yet.
- **`ResolvedRefs=False` / `InvalidCertificateRef` on the Gateway listener** —
  the Secret does not exist yet; the certificate has not been issued.
- **ACME Challenge stuck** — HTTP-01: the token URL is not reachable (routing,
  firewall). DNS-01: the TXT record did not propagate or the credential lacks
  permission. `kubectl describe challenge` names the reason.
- **Renewal not happening** — check the certificate's not-after and `renewBefore`
  against cert-manager's logs; a paused or crash-looping controller stops all
  renewals.

## Common mistakes

- **Using ACME for a non-public name.** `tasklane.localhost` cannot be validated;
  use a private `ca` or `selfSigned` issuer.
- **Hitting Let's Encrypt production rate limits** while testing. Use staging
  first.
- **A `ClusterIssuer` that cannot find its CA Secret**, because the Secret is not
  in cert-manager's namespace.
- **Forgetting `crds.enabled=true`** (or a separate CRD install) on the Helm
  install, so the Certificate CRD is missing.
- **Not monitoring renewal**, so the first sign of trouble is an expired
  certificate and an outage.
- **Treating the CA key as ordinary config**, leaving it readable cluster-wide.

## Related topics

- [Gateway API: TLS and traffic management](gateway-api-tls-and-traffic.md)
- [Gateway API](gateway-api.md)
- [external-dns](external-dns.md)
- [Secrets](../k8s-beginner/secrets.md)
- [Certificate rotation](../operations/certificate-rotation.md)
- [Certificate expiry](../troubleshooting/certificate-expiry.md)
- [Labs](labs.md)
