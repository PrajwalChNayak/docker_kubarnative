---
title: The ingress-nginx retirement
description: What the March 2026 retirement of ingress-nginx means, the risk of staying, and your options for moving off it.
level: intermediate
type: migration
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-intermediate/ingress-legacy
  - k8s-intermediate/gateway-api
---

## Overview

`kubernetes/ingress-nginx` — for years the default way to expose HTTP in
Kubernetes, and by some counts running in about half of all clusters — has been
retired. This page states the facts, explains what "retired" actually means for
a running install, weighs the risk of staying, and lays out the two supported
ways forward. The mechanics of moving to Gateway API are in
[Migrating from Ingress to Gateway API](ingress-to-gateway-api.md); this page is
the decision.

:::warning
Do not confuse the projects. **ingress-nginx** (`kubernetes/ingress-nginx`,
community-run) is retired. **F5 NGINX Ingress Controller**
(`nginx/kubernetes-ingress`, a separate, commercially-backed product) is
maintained and is one of the migration targets below.
:::

## The facts

- **Announced 2025-11-11** by SIG Network and the Security Response Committee.
- **Retired and the repository archived on 2026-03-24.** The repo is read-only.
- **The last release is controller v1.15.1** (published 2026-03-19, alongside
  v1.14.5 and v1.13.9). Its supported-versions table stops at Kubernetes 1.35.
- **No further releases, bug fixes or CVE patches** will ever ship.
- **Existing installs keep running.** The Helm charts and container images stay
  downloadable; nothing is deleted.
- The companion **InGate** project is retired too.
- The README now says, in effect: if you are not already using ingress-nginx,
  do not deploy it — pick a Gateway API implementation.

## The risk of staying

An archived HTTP-facing proxy is a security liability, not a stable dependency.

- **Unpatched CVEs.** ingress-nginx has a history of serious vulnerabilities
  (the "IngressNightmare" class among them). The next one will not be fixed.
  Anything terminating internet traffic must receive security patches.
- **Compatibility rot.** With the support table frozen at 1.35, each cluster
  upgrade increases the version skew between the controller and the API server.
  Nothing guarantees it keeps working on 1.37 and beyond.
- **No help coming.** No maintainers, no releases, no backports. You would be
  maintaining a fork.

Running it unchanged for a short, planned migration window is defensible.
Treating it as a permanent component is not.

## How to inventory your usage

Before you can migrate, find every place it runs and everything that depends on
it.

```bash
kubectl get pods --all-namespaces --selector app.kubernetes.io/name=ingress-nginx
kubectl get ingressclass
kubectl get ingress --all-namespaces
```

Then find the controller-specific behaviour that will not port cleanly — the
annotations:

```bash
kubectl get ingress -A -o json \
  | jq -r '.items[] | select(.metadata.annotations // {} | keys[] | startswith("nginx.ingress.kubernetes.io")) | "\(.metadata.namespace)/\(.metadata.name)"'
```

Every `nginx.ingress.kubernetes.io/*` annotation is a decision point: it maps to
a Gateway API filter, to an implementation policy, or to nothing.

## What to do now

There are two supported directions. They are not equivalent.

### Option 1: migrate to Gateway API (recommended)

Gateway API is this handbook's primary way to expose HTTP, and it is where the
ecosystem's investment is going. It replaces controller-specific annotations
with typed, portable resources. Choose a conformant implementation — Envoy
Gateway (the lab's choice), Istio, NGINX Gateway Fabric, Traefik, Kong Operator
and others are all conformant — and follow
[the migration guide](ingress-to-gateway-api.md). Prefer this unless you have a
concrete reason not to.

### Option 2: move to a maintained Ingress controller

If you must keep the Ingress API for now — a large annotation surface, a
short timeline, a third-party chart that only speaks Ingress — swap ingress-nginx
for a maintained controller that still implements `networking.k8s.io/v1`:

| Controller | Project | Notes |
|---|---|---|
| F5 NGINX Ingress Controller | `nginx/kubernetes-ingress` | Different codebase and annotations from ingress-nginx; migration is not a drop-in. |
| Traefik | `traefik/traefik` | Also a Gateway API implementation. |
| HAProxy Kubernetes Ingress | `haproxytech/kubernetes-ingress` | |
| Contour | `projectcontour/contour` | Envoy-based; CNCF incubating. |
| Kong Ingress Controller | `kong/kubernetes-ingress-controller` | Also Gateway API. |
| Envoy Gateway | `envoyproxy/gateway` | Gateway API-native; the lab's choice. |

Each controller has its own annotations and its own IngressClass, so this is a
real migration, not a rename. Several of these speak Gateway API too, so
Option 2 can be a stepping stone to Option 1.

:::danger
Never install `kubernetes/ingress-nginx` for new work. It is archived and will
never be patched again. This handbook's checker rejects it outside migration and
legacy pages.
:::

## Common mistakes

- **Assuming another controller is a drop-in.** ingress-nginx annotations are
  not portable to F5 NGINX Ingress Controller, Traefik or anyone else. Budget a
  real migration.
- **Confusing ingress-nginx with F5's NGINX Ingress Controller.** One is
  retired; the other is a maintained, separate product.
- **Leaving it in place indefinitely "because it still works".** It works until
  the next unpatched CVE or the next incompatible upgrade.
- **Migrating without inventorying annotations first.** The annotations, not the
  routing rules, are where the surprises hide.
- **Forgetting the IngressClass and any admission webhook** when you uninstall,
  which can leave orphaned objects or a broken validating webhook.

## Related topics

- [Migrating from Ingress to Gateway API](ingress-to-gateway-api.md)
- [Gateway API](../k8s-intermediate/gateway-api.md)
- [The legacy Ingress](../k8s-intermediate/ingress-legacy.md)
- [Deprecated API detection](../operations/deprecated-api-detection.md)
- [Version matrix](../reference/version-matrix.md)
