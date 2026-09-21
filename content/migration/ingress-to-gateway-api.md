---
title: Migrating from Ingress to Gateway API
description: How to move a legacy Ingress, annotations and all, to typed Gateway API resources, and how to run both during the transition.
level: intermediate
type: migration
status: current
versions: Kubernetes 1.37, Gateway API 1.6.2
prerequisites:
  - k8s-intermediate/gateway-api
  - k8s-intermediate/ingress-legacy
---

## Overview

The Ingress API (`networking.k8s.io/v1`) is GA, frozen, and going nowhere, but
its most-used implementation, ingress-nginx, was retired and archived on
2026-03-24. Every feature beyond dumb path routing lived in controller-specific
`nginx.ingress.kubernetes.io/*` annotations, which are not portable and are now
unmaintained. Gateway API is this handbook's recommended replacement, and this
page shows the mechanical migration: what each Ingress field and annotation
becomes, how TLS and traffic splitting change, and how to run both APIs side by
side while you migrate host by host.

This is a translation guide, not an introduction. For the concepts, read
[Gateway API](../k8s-intermediate/gateway-api.md) and
[the legacy Ingress](../k8s-intermediate/ingress-legacy.md) first. For the
retirement facts, see [ingress-nginx retirement](ingress-nginx-retirement.md).

## The model shift

Ingress is one object with an annotation bag. Gateway API is several typed
objects split along team boundaries:

| Concern | Ingress | Gateway API | Typical owner |
|---|---|---|---|
| Which controller | `spec.ingressClassName` | `GatewayClass` (cluster-wide) | platform team |
| Listeners, ports, TLS | annotations + `spec.tls` | `Gateway` | cluster operator |
| Hostnames, paths, backends | `spec.rules` | `HTTPRoute` (and `GRPCRoute`, `TCPRoute`…) | application team |
| Cross-namespace grants | (implicit / none) | `ReferenceGrant` | namespace owner |

The gain is that behaviour becomes typed and validated by the API server
instead of being free text in an annotation that only one controller
understood. The cost is more objects and a new mental model.

## Field-by-field migration

The worked before/after pair lives in `examples/migration/ingress-to-gateway/`.
The legacy Ingress, with its ingress-nginx annotations:

```yaml include="examples/migration/ingress-to-gateway/ingress.yaml" legacy
```

The equivalent Gateway API resources:

```yaml include="examples/migration/ingress-to-gateway/gateway.yaml"
```

Part G's lab keeps its own legacy Ingress and a ready-made
[`migration.diff`](../../examples/ingress-legacy/migration.diff) under
[`examples/ingress-legacy/`](../../examples/ingress-legacy/) — read that diff to
see the exact edit against the running stack rather than the illustrative pair
above. The full mapping, kept next to the files so it cannot drift, is in
`examples/migration/ingress-to-gateway/notes.md`. The essentials:

| Ingress | Gateway API |
|---|---|
| `spec.ingressClassName` | `Gateway.spec.gatewayClassName` **plus** `HTTPRoute.spec.parentRefs[]` |
| `rules[].host` | `HTTPRoute.spec.hostnames[]` |
| `paths[].path` + `pathType` (`Prefix`/`Exact`/`ImplementationSpecific`) | `matches[].path.type` (`PathPrefix`/`Exact`/`RegularExpression`) |
| `backend.service.name`/`port` | `backendRefs[].name`/`port` |
| `spec.defaultBackend` | a low-priority HTTPRoute matching `PathPrefix: /` |

Note the split of `ingressClassName`: the class name moves to the Gateway, and
each route additionally names its Gateway with a `parentRef`. There is no single
"default backend" field; you model it as a catch-all rule.

### TLS

Ingress terminates TLS per host through `spec.tls[].secretName`. Gateway API
moves termination onto a listener:

```yaml title="listener TLS (fragment)" fragment
listeners:
  - name: https
    protocol: HTTPS
    port: 443
    hostname: tasklane.localhost
    tls:
      mode: Terminate
      certificateRefs:
        - kind: Secret
          group: ""
          name: tasklane-tls
```

The same Secret, now referenced by type. `mode: Terminate` decrypts at the
Gateway so HTTP-level route matching works; `mode: Passthrough` (via `TLSRoute`)
hands the encrypted stream to the backend and gives up L7 routing. A Secret in
another namespace needs a `ReferenceGrant` in that namespace.

### Redirects and rewrites

These were annotations. They are now typed, terminal or in-line filters:

| ingress-nginx annotation | Gateway API filter |
|---|---|
| `ssl-redirect: "true"` | `RequestRedirect` (`scheme: https`, `statusCode: 301`) — terminal, no backendRefs |
| `rewrite-target` | `URLRewrite` (`path.type: ReplacePrefixMatch` or `ReplaceFullPath`) |
| header manipulation snippets | `RequestHeaderModifier` / `ResponseHeaderModifier` |

Raw `configuration-snippet` annotations have no portable equivalent. Where you
relied on them, you move to an implementation extension (for Envoy Gateway,
`ClientTrafficPolicy` / `BackendTrafficPolicy`) or drop the behaviour.

### Traffic splitting and canary

ingress-nginx expressed canaries with a second Ingress and `canary-weight`
annotations. Gateway API makes it a first-class list, because `backendRefs` is a
list with weights:

```yaml title="weighted split (fragment)" fragment
rules:
  - backendRefs:
      - name: tasklane-api
        port: 80
        weight: 9
      - name: tasklane-api-canary
        port: 80
        weight: 1
```

Weights are relative — each backend's weight divided by the sum — not
percentages, so `9` and `1` is a 90/10 split. Header- or query-based canaries
become an extra rule with a `headers` match; rule precedence is computed from
the specificity of the match, not list order. The lab's full example is in
`examples/k8s/05-tls/60-routes.yaml`.

## Gradual coexistence

You do not cut over in one apply. Ingress and Gateway API are independent APIs
served by independent controllers, so they run at the same time:

1. Install a Gateway API implementation (the lab uses Envoy Gateway) alongside
   the existing Ingress controller. They watch different resources and ignore
   each other.
2. Create a `Gateway` with listeners for the hostnames you are migrating.
3. Migrate **one host at a time**: write its `HTTPRoute`, test it directly, then
   move DNS (or the load balancer) for that host from the Ingress to the
   Gateway address.
4. Delete the migrated host's rule from the Ingress once traffic has moved.
5. When the last rule is gone, delete the Ingress and uninstall its controller.

Because the two paths have separate addresses, you can shift traffic with DNS
weighting or by testing against the Gateway's address with a `Host` header
before any public DNS change.

## Tooling

`ingress2gateway` (project `sigs.k8s.io/ingress2gateway`, 1.0 released
2026-03-20) reads Ingress resources and provider annotations and emits Gateway +
HTTPRoute YAML. It is a first-draft generator: annotation coverage is
provider-specific, it will not translate raw-nginx snippets, and it does not
know your ReferenceGrant or security needs. Always review its output and
re-apply TLS and cross-namespace grants by hand.

## Status conditions to check

After applying, do not trust `kubectl apply` alone — check that the controller
accepted and programmed the resources:

- `Gateway`: `status.conditions` shows `Accepted=True` and `Programmed=True`;
  each `status.listeners[]` shows `ResolvedRefs=True` (the TLS Secret was found)
  and `Programmed=True`.
- `HTTPRoute`: `status.parents[].conditions` shows `Accepted=True` and
  `ResolvedRefs=True` (every `backendRef` resolved to a real Service and port).

A route that is `Accepted=False` with reason `NoMatchingParent` usually means
the `parentRef` `sectionName` does not match a listener name, or the listener's
`allowedRoutes` excludes the route's namespace.

## Common mistakes

- **Porting `configuration-snippet` verbatim.** There is no target for raw nginx
  config. Re-express the intent as a filter or an implementation policy, or
  accept that the behaviour is gone.
- **Forgetting the `parentRef`.** Setting `gatewayClassName` is not enough; a
  route with no `parentRef` attaches to nothing and silently serves no traffic.
- **Leaving `pathType: ImplementationSpecific` regex as `PathPrefix`.** A
  regex path must become `type: RegularExpression`, whose support is
  implementation-specific; a plain prefix will match differently.
- **Cross-namespace Secret or Service without a `ReferenceGrant`.** The
  reference resolves to `ResolvedRefs=False` and the listener or route stays
  down.
- **Cutting over all hosts at once.** Migrate host by host so a mistake affects
  one hostname, not the whole ingress surface.
- **Treating `ingress2gateway` output as final.** It is a starting draft, not a
  verified manifest.

## Related topics

- [Gateway API](../k8s-intermediate/gateway-api.md)
- [Gateway API TLS and traffic](../k8s-intermediate/gateway-api-tls-and-traffic.md)
- [The legacy Ingress](../k8s-intermediate/ingress-legacy.md)
- [ingress-nginx retirement](ingress-nginx-retirement.md)
- [Manifest field reference](../reference/manifest-field-reference.md)
