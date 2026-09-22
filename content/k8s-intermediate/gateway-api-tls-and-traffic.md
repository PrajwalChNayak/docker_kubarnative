---
title: Gateway API - TLS and traffic management
description: Terminating TLS on a listener, redirecting HTTP to HTTPS, splitting traffic by weight, matching on headers, and re-encrypting to the backend with BackendTLSPolicy.
level: intermediate
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-intermediate/gateway-api
  - k8s-beginner/services
---

## Overview

Once a [Gateway](gateway-api.md) is routing plain HTTP, the next steps are
almost always the same: serve HTTPS, force clients onto it, and shift a fraction
of traffic to a new version. Gateway API expresses all of this in typed fields
rather than the per-controller annotations Ingress needed.

This page covers five things, all demonstrated by stage 5 of the lab:

- **TLS termination** on a listener (`tls.mode: Terminate`, `certificateRefs`).
- **HTTP → HTTPS redirect** with the `RequestRedirect` filter.
- **Weighted traffic splitting** across backends.
- **Header and method matching** for canary pinning.
- **Re-encryption to the backend** with `BackendTLSPolicy`.

## Why it exists and when to use it

TLS termination at the edge means backends speak plain HTTP inside the cluster
while clients get encryption — one place to hold certificates, one place to
rotate them. A redirect makes "http://" reach the same secure endpoint instead
of failing or serving cleartext. Weighted splitting is the primitive under every
canary and blue/green rollout: send 10% of traffic to the new version, watch,
then move the weight. Header matching gives you a deterministic escape hatch —
"this header always goes to the canary" — for testing the new version directly
while the split stays small for everyone else.

## How it works underneath

**Termination.** An HTTPS listener names `mode: Terminate` and one or more
`certificateRefs` pointing at Secrets of type `kubernetes.io/tls`. The data
plane presents the certificate, decrypts the connection, and then — because it
now has the plaintext HTTP request — can match on host, path and headers. The
alternative, `mode: Passthrough` (a `TLSRoute`, matched on SNI only), hands the
encrypted stream straight to the backend and gives up all L7 routing. Terminate
is what you want whenever you route on anything above TCP.

**Redirect.** A `RequestRedirect` filter is **terminal**: a rule that uses it
must have no `backendRefs`, because the Gateway answers the request itself with
a 3xx and a `Location` header. It runs entirely in the data plane; nothing
reaches a pod.

**Weighting.** `backendRefs[].weight` values are **relative, not percentages**.
The data plane divides each backend's weight by the sum of weights in the rule,
so `9` and `1` is a 90/10 split and `3` and `1` is 75/25. A `weight: 0` backend
stays a valid reference but receives nothing.

**Match precedence.** When several rules could match, Gateway API computes
precedence **from the match specificity, not from list order**: a longer path
wins over a shorter one, and a rule with a header match beats a bare path match
on the same path. This is why the canary's header rule takes priority over the
weighted split rule even though both match `/`.

**Re-encryption.** Terminating at the edge leaves the hop from the data plane to
the pod in plaintext. `BackendTLSPolicy` (standard channel at v1.6.2) attaches
to a Service and tells the data plane to open a **new** TLS connection to the
backend, validating the backend's certificate against a named CA and SNI. That
is distinct from termination (client-to-Gateway) and from passthrough
(no termination at all): it is Gateway-to-backend TLS.

## Basic example

The HTTPS listener is added to the stage-4 Gateway. `mode: Terminate`, a
`hostname` that pins SNI and Host to the certificate's only name, and a
`certificateRefs` to the Secret cert-manager fills:

```yaml include="examples/k8s/05-tls/30-gateway.yaml" lines="26-44"
```

The routes carry the redirect, the header match and the weighted split:

```yaml include="examples/k8s/05-tls/60-routes.yaml"
```

Apply the stage in the order stage 5 prescribes — Gateway before the EnvoyProxy
patch, for the reason explained on the
[Gateway API page](gateway-api.md#explanation):

```console include="captures/k8s-intermediate/tls-apply.txt"
```

## Explanation

The redirect route attaches to the `http` listener, matches `tasklane.localhost`
and bounces every request to `https` with a 301. It has no `backendRefs`,
because `RequestRedirect` is terminal. In the lab the redirect names port 8443,
because kind exposes the HTTPS listener through a host mapping on that port; on a
cluster whose Gateway really listens on 443, you drop the port and the scheme
implies it.

The application route attaches to **both** listeners. Its first rule matches
`/` **and** the header `x-tasklane-track: canary`, and sends those requests
straight to the canary backend — the deterministic pin. Its second rule matches
`/` alone and splits 9:1 between the stable and canary Services. Because
precedence is by specificity, the header rule wins for requests that carry the
header, and everyone else falls through to the split.

Verify each behaviour. The redirect:

```bash
curl -sS -o /dev/null -D - --resolve tasklane.localhost:8080:127.0.0.1 http://tasklane.localhost:8080/
```

```console include="captures/k8s-intermediate/curl-redirect.txt"
```

The split (roughly nine stable responses to one canary):

```bash
for i in $(seq 1 20); do curl -s --cacert /tmp/tasklane-ca.crt --resolve tasklane.localhost:8443:127.0.0.1 https://tasklane.localhost:8443/; echo; done | sort | uniq -c
```

```console include="captures/k8s-intermediate/curl-split.txt"
```

The header pin (always the canary):

```bash
curl -sS -i -H 'x-tasklane-track: canary' --cacert /tmp/tasklane-ca.crt --resolve tasklane.localhost:8443:127.0.0.1 https://tasklane.localhost:8443/
```

```console include="captures/k8s-intermediate/curl-canary-header.txt"
```

And the certificate the listener actually serves:

```bash
openssl s_client -connect 127.0.0.1:8443 -servername tasklane.localhost -CAfile /tmp/tasklane-ca.crt </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -dates -ext subjectAltName
```

```console include="captures/k8s-intermediate/openssl-cert.txt"
```

## Common patterns

**Terminate at the edge, redirect at the edge.** An HTTPS listener plus a
one-rule `RequestRedirect` route on the HTTP listener is the standard secure
front door. Keep the HTTP listener only to answer the redirect.

**Split by weight, pin by header.** Drive the weighted rule from a progressive
delivery tool while keeping a header rule for engineers to reach the new version
on demand. This is the shape [Argo Rollouts and Flagger](../k8s-advanced/progressive-delivery.md)
automate — they adjust the very `backendRefs[].weight` fields shown here.

**Match on method for read/write splits.** `matches[].method` lets you route
`GET` and `POST` differently, for example to send writes to a primary and reads
to a replica-backed Service.

**Re-encrypt sensitive backends with `BackendTLSPolicy`.** When the hop from the
Gateway to the pod must also be encrypted (compliance, a shared node network),
attach a `BackendTLSPolicy` to the Service rather than terminating TLS twice by
hand.

## Production considerations

Certificate lifecycle is the operational heart of this. Issue the listener's
certificate automatically with [cert-manager](cert-manager.md); on renewal
cert-manager rewrites the Secret in place and Envoy Gateway picks up the new key
pair without a restart. The lab's certificate mirrors a public ACME lifetime
(90 days, renew at 15) precisely so the renewal path is exercised.

A weighted split is not a health check. The Gateway sends the configured
fraction regardless of whether the canary is healthy beyond readiness; a bad
canary still gets its 10% of real users. Progressive delivery tools add the
metric analysis and automatic rollback that raw weights lack.

Redirect loops are the classic self-inflicted outage: if something in front of
the Gateway (a load balancer terminating TLS) already speaks HTTPS to clients
but forwards HTTP, an HTTP→HTTPS redirect at the Gateway loops forever. Know
where TLS actually terminates in your path.

## Security considerations

Set a `hostname` on the HTTPS listener. Without it the listener accepts every
SNI, and any route may attach a hostname it does not own; with it, only the
certificate's name is served. The lab's listener names `tasklane.localhost`,
which is also the certificate's only `dnsName`.

`certificateRefs` to a Secret in another namespace requires a `ReferenceGrant`
from that namespace — cross-namespace certificate access is consent, not
configuration. Keep TLS Secrets in the operator's namespace and grant
deliberately.

A private CA (as in the lab) makes browsers warn until `ca.crt` is imported.
That warning is correct behaviour, not a bug; do not train users to click
through certificate warnings, and use a publicly-trusted issuer for anything
real.

## Troubleshooting

```bash
kubectl -n tasklane describe certificate tasklane-tls
```

```console include="captures/k8s-intermediate/certificate-describe.txt"
```

Then confirm the endpoint end to end with the CA the issuer copied into the leaf
Secret's `ca.crt`:

```bash
kubectl -n tasklane get secret tasklane-tls -o jsonpath='{.data.ca\.crt}' | base64 -d > /tmp/tasklane-ca.crt
curl -sS -i --cacert /tmp/tasklane-ca.crt --resolve tasklane.localhost:8443:127.0.0.1 https://tasklane.localhost:8443/
```

```console include="captures/k8s-intermediate/curl-https.txt"
```

- **Listener `ResolvedRefs=False` with `InvalidCertificateRef`** — the Secret
  does not exist yet or is not a TLS Secret. The certificate has not been issued;
  check cert-manager.
- **`curl` reports a certificate error** — the client does not trust the issuer.
  Import the CA (`--cacert`), or the name does not match the listener `hostname`.
- **The split is not the ratio you set** — weights are relative to the rule's
  sum, not percentages, and a keep-alive connection stays on one backend. Use
  fresh connections when measuring.
- **The redirect loops** — TLS is already terminated in front of the Gateway;
  the request arrives as HTTP and is redirected to HTTPS forever.

## Common mistakes

- **`RequestRedirect` with `backendRefs`.** The filter is terminal; a rule using
  it must have no backends.
- **Treating weights as percentages.** They are relative to the sum in the rule.
- **Relying on list order for precedence.** Gateway API ranks by match
  specificity, not order.
- **No `hostname` on the HTTPS listener**, so it accepts every SNI.
- **Terminating TLS and assuming the backend hop is encrypted.** It is
  plaintext until you add a `BackendTLSPolicy`.
- **Forgetting the redirect route's port in kind.** Without the explicit `8443`
  the redirect targets 443, which the lab does not expose.

## Related topics

- [Gateway API](gateway-api.md)
- [cert-manager](cert-manager.md)
- [external-dns](external-dns.md)
- [Progressive delivery](../k8s-advanced/progressive-delivery.md)
- [Certificate rotation](../operations/certificate-rotation.md)
- [Certificate expiry](../troubleshooting/certificate-expiry.md)
- [Labs](labs.md)
