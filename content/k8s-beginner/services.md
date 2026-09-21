---
title: Services
description: Stable names and virtual IPs for a changing set of pods, the five Service types, and the EndpointSlice machinery that makes them work.
level: beginner
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/pods
  - k8s-beginner/labels-selectors-annotations
---

## Overview

Pod IPs change on every recreation, and a Deployment recreates pods
constantly. A Service is the stable thing in front of them: a name in DNS,
usually a virtual IP, and a continuously updated list of the pod IPs that are
ready to receive traffic.

There are five types — `ClusterIP`, `NodePort`, `LoadBalancer`,
`ExternalName` and headless (`clusterIP: None`) — and they are cumulative
rather than alternatives: a NodePort Service is a ClusterIP Service with a
node port added.

## Why it exists and when to use it

Without a Service you would have to discover pod IPs yourself, watch for
changes, and load balance in every client. The Service moves that to the
platform:

- **Stable identity.** `tasklane-api.tasklane.svc.cluster.local` means the
  same thing after every rollout.
- **Readiness-aware membership.** Only pods whose `Ready` condition is true
  receive traffic. That is what makes rolling updates safe.
- **Load balancing in the datapath**, on the node, with no proxy hop through
  a central component.

Use a Service for anything another pod or the outside world needs to reach.
Use a headless Service when clients must address individual pods (databases,
clustered software, StatefulSets). Use Gateway API — not a Service type —
for HTTP routing, TLS termination and host or path matching.

## How it works underneath

### From selector to datapath

1. You create a Service with a `selector`.
2. The **EndpointSlice controller** watches pods matching that selector and
   maintains `discovery.k8s.io/v1` EndpointSlice objects: up to 100 endpoints
   each, labelled `kubernetes.io/service-name=<service>`. Each endpoint
   carries the pod IP, the target port, `conditions.ready`, and topology
   hints such as the node and zone.
3. **kube-proxy** on every node watches Services and EndpointSlices and
   programs the node's datapath (iptables by default in 1.37, nftables since
   it went GA in 1.33, or ipvs which is deprecated since 1.35).
4. A packet to the ClusterIP is DNAT'd to one of the ready endpoints, chosen
   at random with equal weight. The connection is tracked, so all packets of
   one connection reach the same pod.
5. **CoreDNS** publishes `<service>.<namespace>.svc.cluster.local` as an A
   record for the ClusterIP (or, for a headless Service, one A record per
   ready pod IP).

The ClusterIP is virtual: nothing listens on it, no interface holds it, and
you cannot ping it meaningfully. It exists only as packet-rewriting rules on
every node.

:::deprecated The older Endpoints API
EndpointSlice replaced the original one-object-per-Service `Endpoints` API,
which has been **deprecated since Kubernetes 1.33**. Reading it still works —
the API server keeps a compatibility controller and emits a warning — but new
code and new tooling must use `discovery.k8s.io/v1`. Because of the
deprecation policy for GA APIs, the old type will probably never be removed;
that is not a reason to use it.
:::

### The types

| Type | What it adds | Reachable from |
|---|---|---|
| `ClusterIP` (default) | A virtual IP and DNS | Inside the cluster |
| `NodePort` | A port (30000–32767 by default) on **every** node | Anything that can reach a node |
| `LoadBalancer` | A request to the cloud controller for an external address | The internet, or a private LB |
| `ExternalName` | Nothing. A CNAME in DNS | Inside the cluster; resolves elsewhere |
| headless (`clusterIP: None`) | Removes the VIP; DNS returns pod IPs | Inside the cluster |

Two fields change the behaviour of the externally reachable types:

- **`externalTrafficPolicy: Cluster`** (default) lets any node forward to a
  pod on any node. Simple, evenly balanced, but the client IP is lost to SNAT
  and there is one extra hop. **`Local`** preserves the client IP and skips
  the hop, but a node with no local pod drops the traffic — which is exactly
  how cloud load balancer health checks find the right nodes.
- **`spec.trafficDistribution`** expresses a preference for topologically
  close endpoints; `PreferSameNode` became stable in Kubernetes 1.35. It is a
  hint, not a guarantee.

:::deprecated Service externalIPs
`spec.externalIPs` was **deprecated in Kubernetes 1.36** (KEP-5707) and
emits warnings. kube-proxy support is expected to be disabled by default no
earlier than 1.40 and removed no earlier than 1.43. Do not build on it; use
LoadBalancer, NodePort or a Gateway instead. The `DenyServiceExternalIPs`
admission plugin blocks it today.
:::

### Ports

```yaml title="port fields" fragment
ports:
  - name: http        # required when there is more than one port
    port: 80          # the Service's port
    targetPort: http  # the container's port, by name or number
    protocol: TCP     # TCP (default), UDP or SCTP
    nodePort: 30080   # NodePort and LoadBalancer only; auto-assigned if omitted
```

Naming the target port decouples the Service from the container: the pod can
move from 8080 to 9090 without a Service change.

## Basic example

Five Services, one backend. All of them select the same
`app.kubernetes.io/name: hello-api` pods:

```yaml include="examples/k8s/basics/30-service-clusterip.yaml"
```

```yaml include="examples/k8s/basics/31-service-nodeport.yaml"
```

```yaml include="examples/k8s/basics/32-service-loadbalancer.yaml"
```

```yaml include="examples/k8s/basics/33-service-headless.yaml"
```

```yaml include="examples/k8s/basics/34-service-externalname.yaml"
```

```bash
kubectl -n tasklane-basics get svc -o wide
kubectl -n tasklane-basics get endpointslices -o wide
```

```console include="captures/k8s-beginner/basics-services.txt"
```

```console include="captures/k8s-beginner/basics-endpointslices.txt"
```

## Explanation

### ClusterIP and load balancing

`hello-api` has a ClusterIP and a DNS name. Calling it repeatedly from
another pod hits different backends, because kube-proxy picks an endpoint per
connection:

```bash
kubectl -n tasklane-basics exec config-demo -- sh -c 'for i in 1 2 3 4 5 6; do wget -qO- http://hello-api/; echo; done'
```

```console include="captures/k8s-beginner/service-load-balancing.txt"
```

The API returns its own hostname, which is the pod name, so the distribution
is visible. Note that the balancing is per **connection**, not per request: a
client that keeps one HTTP keep-alive connection open will stay on one pod.
That is the usual reason a "load balanced" service looks unbalanced under
gRPC or a connection-pooling client.

### NodePort

`hello-api-nodeport` additionally opens a port on every node. In the kind lab
only the Gateway's port is published to the host, so reach it from inside the
cluster or from a node container. On a cloud provider, a NodePort is how a
load balancer gets traffic into the cluster; it is rarely the thing you
expose to users.

### LoadBalancer stays pending in kind

```bash
kubectl -n tasklane-basics get svc hello-api-lb -o wide
kubectl -n tasklane-basics describe svc hello-api-lb
```

```console include="captures/k8s-beginner/basics-lb-pending.txt"
```

Kubernetes does not implement load balancers. A cloud-controller-manager
watches for `type: LoadBalancer` and provisions one; the lab's kind cluster
has none, so `EXTERNAL-IP` stays `<pending>` indefinitely. The Service still
works as a ClusterIP and a NodePort. Options if you want a real address
locally: `sigs.k8s.io/cloud-provider-kind`, which runs load balancer
containers on your host for kind clusters, or MetalLB on bare metal. The
handbook instead exposes HTTP through
[Gateway API](../k8s-intermediate/gateway-api.md) on `localhost:8080`.

### Headless

`hello-api-headless` has no ClusterIP. DNS returns one A record per ready pod
and the client chooses. This is how StatefulSet members address each other,
and how the Tasklane database Service works, giving
`postgres-0.postgres.tasklane.svc.cluster.local`.

```bash
kubectl -n tasklane-basics exec config-demo -- nslookup hello-api.tasklane-basics.svc.cluster.local
kubectl -n tasklane-basics exec config-demo -- nslookup hello-api-headless.tasklane-basics.svc.cluster.local
```

```console include="captures/k8s-beginner/dns-clusterip.txt"
```

```console include="captures/k8s-beginner/dns-headless.txt"
```

### ExternalName

`tasklane-db` has no selector and no endpoints at all. CoreDNS answers with a
CNAME to `postgres.tasklane.svc.cluster.local`, so a pod in
`tasklane-basics` can use the short name `tasklane-db`. The same trick
aliases an external hostname (a managed database) behind an in-cluster name,
which is how you migrate a dependency into the cluster later without changing
client configuration.

```console include="captures/k8s-beginner/dns-externalname.txt"
```

Because it is only DNS, nothing is proxied: TLS certificates, Host headers
and NetworkPolicy all see the real target, not the alias.

### EndpointSlices in the running example

```bash
kubectl -n tasklane get endpointslices -o wide
kubectl -n tasklane describe endpointslice -l kubernetes.io/service-name=tasklane-api
```

```console include="captures/k8s-beginner/tasklane-endpointslices.txt"
```

```console include="captures/k8s-beginner/tasklane-endpointslice-describe.txt"
```

Each endpoint shows `Ready`, its pod IP, its node and its zone. This is the
first place to look when a Service "does not work": no endpoints means the
selector matches nothing, or nothing is ready.

The deprecated API still answers, with a warning:

```bash
kubectl -n tasklane get endpoints
```

```console include="captures/k8s-beginner/endpoints-deprecation-warning.txt"
```

## Common patterns

- **One Service per workload, named after it.** Short names inside the
  namespace, fully qualified names across namespaces.
- **Named ports everywhere**, so probes, Services and Gateways all refer to
  `http` rather than 8080.
- **A headless Service for stateful members**, plus a normal one if clients
  also need a single entry point.
- **ExternalName for dependencies you intend to move.** Clients keep one
  name across the migration.
- **`publishNotReadyAddresses: true`** only for peer-discovery Services where
  members must find each other before they are ready.
- **Gateway API for HTTP ingress**, Services for L4 and service-to-service
  traffic. Do not build path routing out of NodePorts.

## Production considerations

- **The scaling limits are real.** Every Service and endpoint becomes rules
  on every node; the iptables mode's update cost grows with the number of
  Services, which is what the nftables mode was written to fix.
- **`externalTrafficPolicy: Local` for real client IPs**, combined with a
  load balancer that health-checks node ports.
- **Session affinity is crude.** `sessionAffinity: ClientIP` pins by source
  IP, which breaks behind NAT. Real sticky sessions belong at layer 7.
- **NodePort ranges are a cluster-wide, finite resource** and are often
  blocked by firewalls. Pin a `nodePort` only when something external depends
  on the number.
- **Each LoadBalancer Service is a billable cloud resource.** Ten of them
  cost ten load balancers; one Gateway in front of many routes usually does
  not.
- **DNS caching hides changes.** Clients that resolve once at start-up will
  keep talking to a stale ClusterIP; that is mostly harmless for ClusterIPs,
  which are stable, and painful for headless Services.

## Security considerations

- **A Service does not authenticate anything.** Any pod in the cluster can
  reach any ClusterIP unless a
  [NetworkPolicy](../k8s-intermediate/network-policy.md) says otherwise.
- **NodePort opens a port on every node**, including nodes that run nothing
  related. Treat it as an exposure decision and firewall accordingly.
- **`LoadBalancer` with a public cloud default is internet-facing.** Use the
  provider's internal-LB annotation for private services, and check what your
  cluster's defaults are.
- **ExternalName points DNS somewhere you may not control.** A pod that can
  create Services can redirect an in-cluster name to an attacker-controlled
  host; restrict who may create Services in shared namespaces.
- **Endpoints reveal topology.** EndpointSlices expose pod IPs, node names
  and zones to anyone with read access to the namespace.

## Troubleshooting

| Symptom | Check |
|---|---|
| No endpoints | `kubectl get pods -l <service selector>` — does the selector match pod **template** labels? |
| Endpoints exist, not ready | Readiness probe failing: `kubectl describe pod` |
| DNS name does not resolve | Namespace in the name; CoreDNS pods healthy; `nslookup` from a pod |
| Connection refused | `targetPort` wrong, or the container listens on 127.0.0.1 instead of 0.0.0.0 |
| Works from one node only | `externalTrafficPolicy: Local` with pods on a subset of nodes |
| `EXTERNAL-IP` pending | No load balancer controller (expected in kind) |
| Traffic all goes to one pod | Long-lived connections, not a balancing bug |

See [service with no endpoints](../troubleshooting/service-no-endpoints.md)
and [DNS failures](../troubleshooting/dns-failures.md).

## Common mistakes

- **Selecting the Deployment's labels instead of the pod template's.** The
  most common cause of an empty EndpointSlice.
- **`targetPort` set to the Service port** (80) when the container listens on
  8080.
- **Binding the application to `127.0.0.1`.** Nothing outside the container
  can reach it; bind to `0.0.0.0`.
- **Expecting `EXTERNAL-IP` locally.** kind has no cloud controller.
- **Using NodePort as a public entry point** and discovering the port range,
  the firewall rules and the lack of TLS.
- **Assuming per-request load balancing.** It is per connection.
- **Creating a Service before the workload and forgetting it.** A Service
  with no endpoints is a silent black hole; alert on it.

## Related topics

- [Pods](pods.md)
- [Deployments and ReplicaSets](deployments-and-replicasets.md)
- [Tasklane on Kubernetes](tasklane-on-kubernetes.md)
- [kube-proxy and EndpointSlices](../k8s-intermediate/kube-proxy-and-endpointslices.md)
- [DNS and CoreDNS](../k8s-intermediate/dns-and-coredns.md)
- [Gateway API](../k8s-intermediate/gateway-api.md)
- [Service with no endpoints](../troubleshooting/service-no-endpoints.md)
