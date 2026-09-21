---
title: kube-proxy and EndpointSlices
description: How a Service IP becomes a real connection - EndpointSlices, the iptables and nftables datapaths, traffic policies and topology-aware routing.
level: intermediate
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/services
  - k8s-intermediate/network-model-and-cni
---

## Overview

A Service's ClusterIP is a **virtual address**. Nothing listens on it. It exists
only as rules in the kernel on every node, installed by kube-proxy from the
Service's EndpointSlices.

Two controllers and one node agent:

- The **EndpointSlice controller** watches Services and pods and maintains
  EndpointSlice objects listing the ready pod addresses.
- **kube-proxy** (a DaemonSet) watches Services and EndpointSlices and programs
  the node's datapath.
- The **kubelet** reports pod readiness, which is the input to all of it.

## Why it exists and when to use it

Pod IPs change constantly. A Service gives a stable name and address; something
has to translate that address into a currently-healthy pod, on every node,
within a second or two of any change. That is the entire job.

You do not "use" kube-proxy directly — you inherit its behaviour every time you
create a Service, and its details explain most Service-related mysteries.

## How it works underneath

**EndpointSlices** (`discovery.k8s.io/v1`, GA since 1.21) hold up to 100
endpoints each by default (`--max-endpoints-per-slice`, maximum 1000). A Service
with 3,000 pods gets 30 slices, and a pod change rewrites one small object
instead of one enormous one. Each endpoint carries three conditions:

- `ready` — shorthand for "serving and not terminating",
- `serving` — the pod's readiness, independent of termination,
- `terminating` — the pod has a deletion timestamp.

Service proxies normally ignore terminating endpoints, but may use ones that are
`serving` and `terminating` when every remaining endpoint is terminating — that
is what lets a node that is scaling to zero drain connections instead of
blackholing them.

The old **`v1 Endpoints`** API is **deprecated since 1.33**. The API server
emits `Warning: v1 Endpoints is deprecated in v1.33+; use discovery.k8s.io/v1
EndpointSlice` on every request. Because of the GA deprecation policy the type
itself is unlikely ever to be removed, but nothing new should read it: Endpoints
cannot represent dual-stack, per-endpoint hints or the three conditions above.

```bash
kubectl -n tasklane get endpointslices -o wide
kubectl get --raw /api/v1/namespaces/tasklane/endpoints 2>&1 | head -c 600
```

```console include="captures/k8s-intermediate/endpoints-raw-deprecation.txt"
```

**kube-proxy modes:**

| Mode | Status | Notes |
|---|---|---|
| `iptables` | the **default on Linux in 1.37** | one chain per Service, random selection; rule count grows with Services × endpoints |
| `nftables` | **GA since 1.33** | the successor datapath; faster, incremental updates, better at scale |
| `ipvs` | **deprecated since 1.35** | disabled by default no earlier than 1.40, removed no earlier than 1.43 |
| `kernelspace` | Windows | |

1.37 does not change the default: it is still `iptables`, and the documentation
recommends pinning the mode explicitly in kube-proxy's configuration so an
upgrade never changes your datapath by surprise. Migrating to `nftables` has two
behaviour changes worth knowing: NodePort Services are reachable only on the
node's primary addresses by default (`--nodeport-addresses primary`), and
kube-proxy does not add the permissive firewall-compatibility rules that
`iptables` mode does.

```bash
kubectl -n kube-system get configmap kube-proxy -o yaml
```

```console include="captures/k8s-intermediate/kube-proxy-config.txt"
```

**The datapath.** For a ClusterIP Service, kube-proxy installs DNAT rules: a
packet to the Service IP and port is rewritten to one of the endpoint pod IPs
and its target port, and conntrack pins the connection to that choice.
Selection is per *connection*, not per request — which is why HTTP keep-alive
and gRPC send everything down one connection to one pod, and why an autoscaled
service can look wildly unbalanced.

**Traffic policies** restrict which endpoints a node may use:

- `internalTrafficPolicy: Local` — in-cluster traffic only goes to pods on the
  same node; it fails if there are none.
- `externalTrafficPolicy: Local` — NodePort and LoadBalancer traffic is only
  answered by nodes that host a pod, which **preserves the client source IP**
  and avoids a second hop. The cost is that nodes without a pod drop the
  traffic. That is exactly the lesson encoded in the lab's Gateway
  configuration: kind maps host ports to the control-plane node only, so the
  Envoy Service must use `Cluster`, not `Local`.

**Topology-aware routing.** `spec.trafficDistribution` expresses a preference:

| Value | Effect |
|---|---|
| `PreferSameZone` | prefer endpoints in the client's zone, fall back cluster-wide |
| `PreferSameNode` | prefer the same node, then the same zone, then cluster-wide |
| `PreferClose` | deprecated alias for `PreferSameZone` |

The EndpointSlice controller writes `hints` on each endpoint and kube-proxy
honours them. The older `service.kubernetes.io/topology-mode: Auto` annotation
does something similar but distributes proportionally to allocatable CPU; if
both are set, the annotation takes precedence.

## Basic example

Tasklane's API Service and the slices behind it:

```yaml include="examples/k8s/03-app/api.yaml" lines="139-156"
```

```bash
kubectl -n tasklane get endpointslices -l kubernetes.io/service-name=tasklane-api -o yaml
```

```console include="captures/k8s-intermediate/endpointslice-yaml.txt"
```

## Explanation

The Service's `selector` matches pod labels; the EndpointSlice controller does
the matching and writes the result. `targetPort: http` resolves to the container
port named `http` (8080), so the Service's port 80 and the pod's 8080 are
connected by name rather than by a number repeated in two files.

The slice's `kubernetes.io/service-name` label is how everything finds the
slices for a Service, and `addressType` is `IPv4`, `IPv6` or `FQDN`.

Headless Services (`clusterIP: None`, like `postgres`) still get EndpointSlices,
but kube-proxy programs nothing for them: the point is DNS, which returns the
pod addresses directly. That is how a StatefulSet's per-pod names work.

## Common patterns

**Pin the proxy mode** in the kube-proxy ConfigMap rather than relying on the
default.

**`externalTrafficPolicy: Local` for real client IPs**, combined with a
DaemonSet or topology spread so every node that can receive external traffic
actually hosts a pod.

**`PreferSameZone` to cut cross-zone traffic costs**, but only for services with
enough endpoints per zone to absorb the load — with three endpoints in one zone
and thirty in another, zone-local routing overloads the three.

**Beware keep-alive imbalance.** Connection-level load balancing plus long-lived
connections equals hot pods. The fixes are a proxy that balances per request (a
Gateway data plane, a service mesh) or periodic connection recycling in the
client.

## Production considerations

At scale, `iptables` mode is the constraint people hit first: rule sync time
grows with the number of Services and endpoints, and a large rollout can make a
node's proxy sync take seconds — during which new endpoints are not yet
programmed. `nftables` mode was built for that and is GA; test it in staging,
mind the NodePort address behaviour, and roll it out per node pool.

Endpoint propagation is eventually consistent everywhere: API server →
controller → EndpointSlice → every kube-proxy → kernel rules. Budget for it in
shutdown handling ([pod lifecycle](pod-lifecycle-and-termination.md)).

Conntrack table exhaustion on busy nodes shows up as random connection failures;
`nf_conntrack_max` and the UDP timeout defaults are worth reviewing on any node
handling many short-lived connections.

Services with tens of thousands of endpoints are unusual and expensive. If you
are there, topology-aware routing and slice size are the levers.

## Security considerations

kube-proxy programs the node's packet filter, so it runs privileged with
`hostNetwork`, and its ServiceAccount can read Services and EndpointSlices
cluster-wide. Compromising it means owning that node's datapath — redirecting a
Service's traffic anywhere.

NodePort Services open a port on **every** node, reachable by anything that can
reach a node's address, with no authentication. Treat NodePort as a
cluster-external door and firewall it explicitly; in this handbook the only
NodePorts are the lab's Gateway ports, and kind binds them to 127.0.0.1.

`Service.spec.externalIPs` lets a Service claim an arbitrary IP on every node
and is a known traffic-hijacking primitive. It is **deprecated in 1.36** (not
removed), and the `DenyServiceExternalIPs` admission plugin blocks it today.

Anyone who can edit a Service's selector can point it at other pods, including
pods in the same namespace that they do not own. Service edit rights are more
powerful than they look.

## Troubleshooting

**Service with no endpoints:**

```bash
kubectl -n tasklane get endpointslices -l kubernetes.io/service-name=tasklane-api
kubectl -n tasklane get pods -l app.kubernetes.io/name=tasklane-api
```

No slice, or an empty one, means the selector matches nothing or every matching
pod is unready. Compare the Service's selector with the pods' labels character
by character — this is almost always a label mismatch.

**Some requests fail, some succeed.** One endpoint is bad and kube-proxy is
still selecting it: check readiness on each pod.

**A NodePort works from one node only.** `externalTrafficPolicy: Local` with no
pod on the other nodes.

**Stale endpoints after a rollout.** Look at the kube-proxy pod on the node
where the *client* runs, not where the server runs.

## Common mistakes

- **Reading `v1 Endpoints`** in new tooling. Deprecated since 1.33; use
  EndpointSlices.
- **Assuming per-request load balancing.** It is per connection.
- **`externalTrafficPolicy: Local` without pods on every ingress node.**
- **Enabling topology-aware routing on a small service**, overloading one zone.
- **Ignoring the proxy mode default** and being surprised after an upgrade.
- **Debugging Services from the wrong node.**
- **Using NodePort as a public entry point** with no firewall.

## Related topics

- [Services](../k8s-beginner/services.md)
- [Network model and CNI](network-model-and-cni.md)
- [DNS and CoreDNS](dns-and-coredns.md)
- [Pod lifecycle and termination](pod-lifecycle-and-termination.md)
- [Gateway API](gateway-api.md)
- [Service has no endpoints](../troubleshooting/service-no-endpoints.md)
- [Deprecated API detection](../operations/deprecated-api-detection.md)
