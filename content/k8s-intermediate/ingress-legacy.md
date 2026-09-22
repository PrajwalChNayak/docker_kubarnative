---
title: Ingress (legacy)
description: The Ingress API is GA and frozen, ingress-nginx is retired, and new work belongs on Gateway API - what Ingress is, why it stalled, and how to read an existing one.
level: intermediate
type: concept
status: legacy
versions: Kubernetes 1.37
prerequisites:
  - k8s-intermediate/gateway-api
  - k8s-beginner/services
---

:::legacy
Ingress is covered here for reading and migrating existing clusters. For new
work in this handbook, use [Gateway API](gateway-api.md). Do not start a new
project on Ingress, and never install the retired `kubernetes/ingress-nginx`
controller.
:::

## Overview

`Ingress` (`networking.k8s.io/v1`) is the original Kubernetes API for routing
external HTTP and HTTPS traffic to Services by host and path. It has been
**Stable since 1.19** and is served by Kubernetes 1.37. It is **not
deprecated** — existing Ingress objects keep working and there are no plans to
remove them — but the API is **frozen**: it receives no new features, and the
project directs new work to [Gateway API](gateway-api.md).

Like Ingress itself, an `Ingress` object is inert without an **Ingress
controller** to implement it. The controller watches Ingress objects and
programs a proxy (Traefik, HAProxy, an NGINX build, Envoy) to match requests and
forward them to Service backends.

## Why it exists and when to use it

Ingress solved a real problem in 2016: exposing many HTTP Services through one
load balancer and one IP, routing by hostname and path, without a NodePort per
Service. That job has not gone away. But the API stopped at the basics — host,
path, TLS, one backend per path — and never grew typed support for redirects,
weighted splits, header matching, rewrites or cross-namespace backends.

Use Ingress today only in two situations: you are operating a cluster that
already runs it, or you are migrating one to Gateway API and need to read the old
objects. For anything new, the answer is [Gateway API](gateway-api.md).

## How it works underneath

The pieces mirror Gateway API's, but collapsed into fewer objects:

- An `IngressClass` names a controller in `spec.controller` (an
  implementation-specific string such as `traefik.io/ingress-controller`). It is
  the analogue of `GatewayClass`.
- An `Ingress` object references a class with `spec.ingressClassName` and
  carries **everything else** — the TLS configuration (`spec.tls`) and the
  routing rules (`spec.rules`) — in one object.
- The controller reconciles Ingress objects into proxy configuration and,
  usually, provisions or updates a LoadBalancer Service, then writes the
  external address back to `status.loadBalancer`.

`pathType` has three values: `Prefix` (matches on whole path segments — `/api`
matches `/api` and `/api/v1` but not `/apifoo`), `Exact`, and
`ImplementationSpecific` (means "ask the controller", and is the seam through
which portability leaks away).

:::deprecated ingress-nginx is retired
`kubernetes/ingress-nginx` was announced for retirement on 2025-11-11 and the
repository was **archived on 2026-03-24**. The last release is controller
**v1.15.1**. There will be **no further releases, bug fixes or security
patches**. Existing installs keep running and the images and charts stay
downloadable, but you must not deploy it for new work. Check whether a cluster
runs it:

```bash
kubectl get pods --all-namespaces --selector app.kubernetes.io/name=ingress-nginx
```

InGate, the intended successor experiment, was also retired. See
[the ingress-nginx retirement migration page](../migration/ingress-nginx-retirement.md).
:::

**Maintained Ingress controllers still exist.** If you must stay on the Ingress
API for now, these are actively maintained: F5 NGINX Ingress Controller
(`nginx/kubernetes-ingress`), Traefik, HAProxy, Contour, Kong, and Envoy Gateway
(which also implements Gateway API). None is a drop-in replacement for
ingress-nginx — annotations differ per controller — so a migration is required
either way, and Gateway API is the better destination.

## Basic example

The Ingress equivalent of the Tasklane API's Gateway and TLS stages. One object
carries the class reference, the TLS block and the routing rules; a cert-manager
annotation drives certificate issuance:

```yaml include="examples/ingress-legacy/ingress.yaml" legacy
```

This targets Traefik, deliberately not ingress-nginx. The lab cluster has **no**
Ingress controller installed, so applying this creates the objects and they sit
with no address — itself a useful thing to see, and the reason there is no
captured output on this page.

## Explanation

Notice what is mixed into one object: the listener (implied — an Ingress never
says which port it listens on, the controller decides), the TLS material
(`spec.tls` names a Secret), and the routing (`spec.rules`). Compare the
[Gateway API version](gateway-api.md), where a `Gateway` owns listeners and TLS
and an `HTTPRoute` owns routing, as separate objects with separate owners.

Everything Ingress could not express was added through **controller-specific
annotations** — redirect-to-HTTPS, canary weights, header routing, URL rewrites
each spelled differently by each controller. That is why an Ingress manifest is
rarely portable between controllers, and why "just swap the controller" after
ingress-nginx's retirement is not a config change but a rewrite.

## Common patterns

There are no new patterns to adopt here — the pattern is **migrate**. The
current-day equivalents are:

| Ingress | Gateway API |
|---|---|
| `IngressClass` | `GatewayClass` (adds typed `parametersRef`) |
| `Ingress` `spec.tls` | a `Gateway` HTTPS listener, explicit port and `tls.mode` |
| `Ingress` `spec.rules` | `HTTPRoute` (`hostnames`, `matches`, `backendRefs`) |
| redirect-to-HTTPS annotation | `RequestRedirect` filter |
| canary / weight annotations | `backendRefs[].weight` |
| header / method annotations | `matches[].headers`, `matches[].method` |
| rewrite annotations | `URLRewrite` filter |
| (impossible) | `ReferenceGrant` for cross-namespace backends |

## Production considerations

If you run Ingress in production today, the pressing task is knowing which
controller you depend on and whether it is maintained. An ingress-nginx install
is now accruing unpatched CVEs by definition; plan its replacement, do not defer
it.

Because routing, TLS and listener config share one object and one RBAC surface,
anyone who can edit an Ingress can change its certificates and hostnames.
Splitting that responsibility is a reason to migrate, not just a nicety.

Annotation-driven behaviour is invisible to `kubectl explain` and to schema
validation. Inventory the annotations in use before migrating —
`ingress2gateway` reads several controllers' annotations, but treat its output
as a first draft.

## Security considerations

A frozen API still gets no **feature** changes, but its controllers get security
fixes — unless the controller is retired. The security story for Ingress is now
mostly the controller's: an unmaintained one (ingress-nginx) is the risk, and
the fix is to move off it.

TLS Secrets referenced by an Ingress live in the same namespace as the Ingress,
so a namespace's route editors can read its serving keys. Gateway API's
cross-namespace consent model (`ReferenceGrant`) exists partly to fix this.

Wildcard hosts and `ImplementationSpecific` paths behave differently per
controller; a rule that is safe on one controller can over-match on another.
Pin behaviour to a controller you have tested, and re-test on migration.

## Troubleshooting

- **Ingress has no `ADDRESS`** — no controller is watching its class, or the
  controller has not provisioned a load balancer. On the lab this is expected;
  in production, check the controller pods and that `ingressClassName` matches an
  installed `IngressClass`.
- **404 or wrong backend** — `pathType` semantics. `Prefix` matches on segments;
  a rule expecting substring behaviour will not match.
- **TLS not served** — the Secret named in `spec.tls` does not exist or is not a
  `kubernetes.io/tls` Secret; cert-manager has not issued it yet.
- **Behaviour differs after changing controllers** — annotations are
  controller-specific and do not carry over. This is migration, not
  configuration.

## Common mistakes

- **Installing `kubernetes/ingress-nginx` for new work.** It is retired and
  unpatched; use Gateway API.
- **Assuming annotations are portable.** They are per-controller; swapping
  controllers means rewriting them.
- **Treating `Prefix` as a substring match.** It matches whole path segments.
- **Believing Ingress is deprecated.** It is frozen, not deprecated — it keeps
  working, it just gets nothing new.
- **Starting a new project on Ingress** because it looks simpler. The simplicity
  ends the moment you need a redirect or a weight.

## Related topics

- [Gateway API](gateway-api.md)
- [Gateway API: TLS and traffic management](gateway-api-tls-and-traffic.md)
- [Migrating from Ingress to Gateway API](../migration/ingress-to-gateway-api.md)
- [The ingress-nginx retirement](../migration/ingress-nginx-retirement.md)
- [Services](../k8s-beginner/services.md)
- [cert-manager](cert-manager.md)
- [Labs](labs.md)
