---
title: Gateway API
description: The role-oriented model that replaces Ingress - GatewayClass, Gateway and HTTPRoute, the status conditions that tell you it worked, and two lessons the lab taught.
level: intermediate
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/services
  - k8s-intermediate/network-model-and-cni
  - k8s-intermediate/kube-proxy-and-endpointslices
---

## Overview

Gateway API is the current, portable way to route external HTTP, gRPC and TCP
traffic into a cluster. It is a set of CRDs from SIG-Network
(`gateway.networking.k8s.io`), not part of core Kubernetes, installed once per
cluster and implemented by a controller (the lab uses **Envoy Gateway
v1.9.1**). This handbook's baseline is **Gateway API v1.6.2, standard channel**.

It exists because [Ingress](ingress-legacy.md) is frozen and its most-used
controller, ingress-nginx, was retired in March 2026. Everything Ingress could
not express — redirects, weights, header matching, cross-namespace routing — was
bolted on with controller-specific annotations. Gateway API puts those in a
typed, portable API instead.

The design is **role-oriented**: three resources owned by three different teams.

| Resource | Owned by | Describes |
|---|---|---|
| `GatewayClass` | infrastructure / platform team | which controller implements Gateways of this class |
| `Gateway` | cluster operator | listeners: ports, protocols, TLS, which namespaces may attach routes |
| `HTTPRoute` (and `GRPCRoute`) | application team | hostnames, paths, header matches, backends |

## Why it exists and when to use it

One Ingress object mixed the listener, the TLS configuration and the routing
rules, so a single RBAC grant over it covered all three. Whoever could edit a
route could also change certificates and hostnames. Splitting the concerns lets
the platform team own the class, the operator own the Gateway and its
certificates, and each application team own only its own routes — with
`ReferenceGrant` as the explicit, auditable consent for a route in one namespace
to reference a backend or certificate in another.

Use Gateway API for all new north-south (external-to-cluster) HTTP exposure in
this handbook. Reach for [Ingress](ingress-legacy.md) only to read or migrate an
existing cluster.

## How it works underneath

The resources form a chain the controller reconciles:

1. You install the CRDs and a controller. The controller registers a
   `GatewayClass` naming itself in `spec.controllerName`.
2. You create a `Gateway` referencing that class. The controller sees it,
   provisions data-plane infrastructure (for Envoy Gateway, an Envoy Deployment
   and a Service), and configures the listeners.
3. You create an `HTTPRoute` whose `parentRefs` point at the Gateway (optionally
   a named listener via `sectionName`). The controller resolves the route's
   `backendRefs` to EndpointSlices and programs the data plane.
4. Traffic arrives at the data-plane Service, Envoy matches the request against
   the route rules, and forwards to a backend pod — balancing **per request**,
   unlike kube-proxy's per-connection choice.

**Status conditions are the contract.** The controller writes back structured
conditions you read to know it worked:

| Condition | On | Means |
|---|---|---|
| `Accepted` | Gateway, listener, route | the config is valid and this controller has taken ownership |
| `Programmed` | Gateway, listener | the data plane is configured and (for the Gateway) has an address |
| `ResolvedRefs` | listener, route | every referenced Secret, backend and cross-namespace grant resolved |

A route that is `Accepted=True` but `ResolvedRefs=False` is attached but points
at something that does not exist — a typo in a backend name, or a certificate
Secret that has not been created yet.

**Channels and versions.** The **standard** channel holds the GA and stable
resources; the **experimental** channel adds early features in the
`gateway.networking.x-k8s.io` group (`XBackendTrafficPolicy`, `XMesh` and
similar). At v1.6.2 the standard channel serves:

| Resource | Version | Status |
|---|---|---|
| GatewayClass, Gateway, HTTPRoute | `v1` | GA |
| GRPCRoute | `v1` | GA |
| ReferenceGrant | `v1` served (`v1beta1` still the storage version) | standard |
| BackendTLSPolicy, TLSRoute, ListenerSet | `v1` | standard (since 1.5) |
| TCPRoute, UDPRoute | `v1` | standard (since 1.6) |

Install the standard channel with server-side apply:

```bash
kubectl apply --server-side -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.6.2/standard-install.yaml
```

**GAMMA and mesh.** The same route types describe east-west (service-to-service)
traffic inside a mesh under the GAMMA initiative: an HTTPRoute whose `parentRef`
is a Service, not a Gateway, configures mesh routing. Istio is the conformant
mesh implementation. This handbook uses Gateway API only for north-south
traffic; the mesh use is the same objects pointed at a different parent.

## Basic example

Stage 4 exposes the Tasklane API. One file carries all three roles' objects —
the `EnvoyProxy` (implementation settings), `GatewayClass`, `Gateway` and
`HTTPRoute`:

```yaml include="examples/k8s/04-gateway/gateway.yaml"
```

On the host, `http://localhost:8080` reaches the `http` listener through kind's
port mapping to NodePort 30080.

## Explanation

The `Gateway` declares one `http` listener on port 80 and, with
`allowedRoutes.namespaces.from: Same`, only accepts routes from its own
namespace — the operator's control over who may attach. The `HTTPRoute` attaches
with `parentRefs` naming the Gateway and its `http` section, matches every path
under `/`, and sends traffic to the `tasklane-api` Service on port 80. The
Service's port, not the pod's, appears here; the data plane resolves it to the
pod endpoints itself.

Two lessons in this file came straight from building the lab, and both are real
constraints, not lab quirks:

**Only patch a Service port that a listener creates.** Envoy Gateway builds the
data-plane Service from the Gateway's listeners — a port exists on the Service
only because a listener asked for it. The `EnvoyProxy` here strategically merges
a `nodePort` onto **port 80**, which the `http` listener created. Patching port
443 before an HTTPS listener exists would append a port with no name, and **the
API server rejects the whole Service** — the data plane then silently keeps its
last good config and your new listener never appears. This is why the
[TLS stage](gateway-api-tls-and-traffic.md) insists on applying the Gateway
before the EnvoyProxy patch.

**`externalTrafficPolicy` must be `Cluster` in kind.** Envoy Gateway defaults
its Service to `Local`, which only answers on the node running the Envoy pod and
preserves the client source IP. But kind maps host port 8080 to the
**control-plane node only**, and the Envoy pod may land on a worker. `Cluster`
lets kube-proxy forward from the control-plane node to whichever node hosts
Envoy. The trade-off is exactly the one from
[kube-proxy traffic policies](kube-proxy-and-endpointslices.md#how-it-works-underneath):
`Cluster` costs an extra hop and the real client IP, `Local` needs a pod on
every ingress node.

## Common patterns

**Split ownership along the resource boundaries.** RBAC-grant the platform team
GatewayClass, the operator Gateway, and each app team only HTTPRoute in its
namespace. This is the whole point of the API; do not collapse it back into one
role.

**One Gateway, many routes.** A shared Gateway with a wildcard or per-team
listener, and one HTTPRoute per application, is the common topology. Use
`allowedRoutes` to control which namespaces may attach.

**Cross-namespace with `ReferenceGrant`.** A route may reference a backend or a
TLS Secret in another namespace only if that namespace publishes a
`ReferenceGrant` permitting it. This is consent, not configuration: the owning
team opts in.

**Read the conditions, do not guess.** After applying anything, check
`Accepted`, `Programmed` and `ResolvedRefs` rather than tailing controller logs.

## Production considerations

The Gateway controller and its data plane are on the critical path for all
inbound traffic; run the controller with multiple replicas, and treat a data
plane rollout like any other. Envoy Gateway reconciles a data-plane Deployment
per Gateway (or a merged one), so capacity planning is real infrastructure, not
just a rule count.

Certificates belong to the operator's Gateway, and are best issued
automatically — see [cert-manager](cert-manager.md), which can watch Gateways
directly. DNS records for the Gateway's address are best managed by
[external-dns](external-dns.md), which has a `gateway-httproute` source.

Portability is the promise but not a guarantee: core conformance covers the
common cases, and each implementation declares which Extended features it
supports. Check the conformance report for your controller before relying on a
feature like header-based routing or specific redirect codes.

## Security considerations

`allowedRoutes` on a listener is the boundary that stops any namespace from
attaching a route and hijacking a hostname. Default it to `Same` and widen
deliberately; `From: All` lets any namespace attach.

The data-plane Service is a NodePort or LoadBalancer, i.e. a real external door.
In the lab, kind binds the NodePorts to `127.0.0.1` only; in production, the
LoadBalancer and its security groups are the perimeter.

A `ReferenceGrant` is a cross-namespace trust grant. Auditing who can create one
in a namespace that holds certificates or sensitive backends is part of securing
the cluster, because it is the mechanism by which another team's route reaches
your Secret.

## Troubleshooting

```bash
kubectl get gatewayclass,gateway -A
```

```console include="captures/k8s-intermediate/gatewayclass.txt"
```

```bash
kubectl -n tasklane describe gateway tasklane
```

```console include="captures/k8s-intermediate/gateway-describe.txt"
```

```bash
kubectl -n tasklane get httproute -o wide && kubectl -n tasklane describe httproute tasklane-api
```

```console include="captures/k8s-intermediate/httproutes.txt"
```

- **Gateway has no address** — `Programmed=False`. The controller has not
  provisioned the data plane; check the controller's own pods and the
  GatewayClass `controllerName` matches an installed controller.
- **Route `Accepted=False`** — its `parentRefs` name a Gateway or `sectionName`
  that does not exist, or the listener's `allowedRoutes` refuses this namespace.
- **Route `ResolvedRefs=False`** — a `backendRef` or certificate Secret does not
  exist. Check the reason (`BackendNotFound`, `InvalidCertificateRef`).
- **New listener never appears after a patch** — the data-plane Service was
  rejected. Inspect it and its events:

```bash
kubectl -n envoy-gateway-system get svc -o wide
```

```console include="captures/k8s-intermediate/envoy-service.txt"
```

## Common mistakes

- **Patching a Service port that no listener created**, which makes the API
  server reject the whole Service and silently freezes the data plane.
- **`externalTrafficPolicy: Local` where the ingress node has no data-plane
  pod**, so traffic is dropped.
- **Confusing the Service port and the pod port** in `backendRefs`; use the
  Service port.
- **Assuming portability of an Extended feature** without checking the
  controller's conformance report.
- **Collapsing the three roles into one**, throwing away the API's main benefit.
- **Tailing logs instead of reading `status.conditions`**, which already say
  exactly what is wrong.
- **Installing the experimental channel** for a feature that is in the standard
  channel, pulling in unstable APIs you did not need.

## Related topics

- [Gateway API: TLS and traffic management](gateway-api-tls-and-traffic.md)
- [Ingress (legacy)](ingress-legacy.md)
- [kube-proxy and EndpointSlices](kube-proxy-and-endpointslices.md)
- [Network model and CNI](network-model-and-cni.md)
- [cert-manager](cert-manager.md)
- [external-dns](external-dns.md)
- [Migrating from Ingress to Gateway API](../migration/ingress-to-gateway-api.md)
- [Labs](labs.md)
