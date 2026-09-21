# LEGACY: the Ingress version of stage 4/5

**Status: legacy.** This directory exists so you can compare the two APIs and
migrate an existing cluster. New work in this handbook uses Gateway API — see
[`examples/k8s/04-gateway`](../k8s/04-gateway) and
[`examples/k8s/05-tls`](../k8s/05-tls).

| File | Contents |
|---|---|
| `ingress.yaml` | `IngressClass` + `Ingress` with TLS, the Ingress equivalent of stages 4 and 5 |
| `migration.diff` | field-by-field diff, Ingress → Gateway + HTTPRoute, plus what has no equivalent |

## Why this is legacy, precisely

- The Ingress API (`networking.k8s.io/v1`) is **GA and frozen**. It is *not*
  deprecated, nothing is being removed, and existing Ingress objects keep
  working on Kubernetes 1.37. It gets no new features.
- **ingress-nginx is retired.** Announced 2025-11-11, retired and the repo
  archived **2026-03-24**. The last release is controller v1.15.1. No further
  releases, bug fixes or security patches will be published; images and charts
  stay downloadable and existing installs keep running. Never install it for
  new work. Check whether a cluster runs it:

  ```bash
  kubectl get pods --all-namespaces --selector app.kubernetes.io/name=ingress-nginx
  ```

- Maintained Ingress controllers do exist: F5 NGINX Ingress Controller,
  Traefik, HAProxy, Contour, Kong, Envoy Gateway. `ingress.yaml` targets
  Traefik (`controller: traefik.io/ingress-controller`).
- The lab cluster has **no Ingress controller installed**. Applying
  `ingress.yaml` creates the objects and they simply sit there with no address,
  which is itself a useful thing to see.

## The structural problem Ingress has

One object carries the listener, the TLS configuration and the routing rules,
so one RBAC grant covers all three: whoever can edit routing can also edit
certificates and hostnames. Gateway API splits those into GatewayClass,
Gateway and HTTPRoute so the platform team, the cluster operator and the
application team each own their own object.

Everything Ingress could not express — redirects, weights, header matching,
rewrites, cross-namespace backends — was bolted on with controller-specific
annotations, which is why an Ingress manifest is rarely portable between
controllers. `migration.diff` lists them against their typed Gateway API
equivalents.

## Migrating

`ingress2gateway` (1.0, released 2026-03-20) reads Ingress objects, and several
controllers' annotations, and emits Gateway API objects. Review the output: it
cannot know which listeners belong on which Gateway, or which team should own
which route.

The narrative walkthrough lives in the migration part of the handbook:
`migration/ingress-to-gateway-api` and `migration/ingress-nginx-retirement`.
