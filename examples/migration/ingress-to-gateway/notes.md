# Ingress -> Gateway API field mapping

The `ingress.yaml` (before) and `gateway.yaml` (after) in this directory are the
worked example. This table is the general mapping. Gateway API 1.6.2, standard
channel, Kubernetes 1.37.

| Ingress (`networking.k8s.io/v1`) | Gateway API (`gateway.networking.k8s.io/v1`) | Notes |
|---|---|---|
| `spec.ingressClassName: nginx` | `Gateway.spec.gatewayClassName` + `HTTPRoute.spec.parentRefs[].name` | The class picks the controller; the parentRef binds a route to a Gateway. Two objects, two roles. |
| `spec.rules[].host` | `HTTPRoute.spec.hostnames[]` | A route may list several hostnames; a listener may pin one with `listeners[].hostname`. |
| `spec.rules[].http.paths[].path` + `pathType` | `HTTPRoute.spec.rules[].matches[].path` (`type: Exact`\|`PathPrefix`\|`RegularExpression`) | Ingress `Prefix` -> `PathPrefix`; `Exact` -> `Exact`. `ImplementationSpecific` (regex) -> `RegularExpression` (Implementation-specific support). |
| `backend.service.name` / `port.number` | `HTTPRoute.spec.rules[].backendRefs[].name` / `port` | backendRefs is a list, so traffic splitting is native (see `weight`). |
| `spec.defaultBackend` | a low-priority HTTPRoute matching `PathPrefix: /`, or omit it | There is no single "default backend" field; model it as a catch-all rule. |
| `spec.tls[].secretName` | `Gateway.spec.listeners[].tls.certificateRefs[]` (`kind: Secret`) | TLS moves to the Gateway listener, decoupled from routes. |
| `spec.tls[].hosts` | `Gateway.spec.listeners[].hostname` + route hostnames | SNI is matched by the listener hostname. |
| `nginx.ingress.kubernetes.io/ssl-redirect: "true"` | `RequestRedirect` filter (`scheme: https`, `statusCode: 301`) | A terminal filter: the rule carries no backendRefs. |
| `nginx.ingress.kubernetes.io/rewrite-target` | `URLRewrite` filter (`path.type: ReplacePrefixMatch`) | Typed rewrite; also `ReplaceFullPath`. Header rewrite uses `hostname`. |
| `nginx.ingress.kubernetes.io/canary*` weights | `backendRefs[].weight` on one rule | Weights are relative, divided by their sum, not percentages. |
| `nginx.ingress.kubernetes.io/configuration-snippet` and other raw-nginx annotations | no portable equivalent | Controller-specific behaviour becomes an implementation extension (e.g. Envoy Gateway `BackendTrafficPolicy`, `ClientTrafficPolicy`) or is dropped. |

## Status conditions to check after applying

- `Gateway`: `status.conditions` `Accepted=True` and `Programmed=True`; each
  entry in `status.listeners[]` should show `ResolvedRefs=True` (the TLS Secret
  was found) and `Programmed=True`.
- `HTTPRoute`: `status.parents[].conditions` `Accepted=True` and
  `ResolvedRefs=True` (every backendRef resolved to a real Service and port).

## Tooling

`ingress2gateway` (the sigs.k8s.io/ingress2gateway project, 1.0 released
2026-03-20) reads existing Ingress resources and provider annotations and emits
Gateway + HTTPRoute YAML. Treat its output as a first draft: annotation coverage
is provider-specific and it will not translate raw-nginx snippets. Always review
and re-apply the security and TLS parts by hand.
