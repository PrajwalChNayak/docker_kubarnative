---
title: DNS and CoreDNS
description: How a name like "postgres" becomes a Service IP - the Corefile, Service and Pod records, headless records, the ndots:5 search-domain tax, and NodeLocal DNSCache.
level: intermediate
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/services
  - k8s-intermediate/kube-proxy-and-endpointslices
---

## Overview

Cluster DNS is how a pod turns a name into an address. A Deployment addresses its
database as `postgres`, and something has to resolve that to a Service IP that
[kube-proxy](kube-proxy-and-endpointslices.md) then translates to a pod. That
something is **CoreDNS**, running as a Deployment in `kube-system` behind a
Service named `kube-dns` (the name is historical).

CoreDNS is the default cluster DNS. Its predecessor, **kube-dns, is deprecated
in 1.37** — no new packages are expected after 1.40 — so CoreDNS is the only one
this handbook documents.

## Why it exists and when to use it

Pod IPs are ephemeral and Service IPs are stable but still not human-facing.
Every workload needs to find its dependencies by a stable name, across
restarts, rescheduling and scaling. DNS is that name layer: the API's config
says `PGHOST=postgres`, not an IP, and it keeps working when the database pod
moves.

You do not "use" cluster DNS explicitly — every pod is wired to it
automatically. You do need to understand it the moment resolution gets slow, a
headless Service behaves oddly, or a [NetworkPolicy](network-policy.md) silently
breaks name lookups.

## How it works underneath

**The kubelet configures every pod's `/etc/resolv.conf`** at creation, pointing
`nameserver` at the `kube-dns` Service ClusterIP and adding a `search` list and
`options ndots:5`. The pod's libc resolver sends queries there; CoreDNS answers.

```bash
kubectl apply -f examples/k8s/06-network-policy/debug-pod.yaml
kubectl -n tasklane exec netcheck -- cat /etc/resolv.conf
```

```console include="captures/k8s-intermediate/resolv-conf.txt"
```

**CoreDNS is configured by a Corefile**, stored in the `coredns` ConfigMap. The
`kubernetes` plugin is what makes it cluster-aware: it watches Services and
EndpointSlices through the API server and answers from that live data, rather
than from a zone file.

```bash
kubectl -n kube-system get configmap coredns -o yaml
```

```console include="captures/k8s-intermediate/coredns-configmap.txt"
```

A typical Corefile chains plugins: `kubernetes cluster.local` (cluster records),
`forward . /etc/resolv.conf` (send everything else to the node's upstream
resolver), plus `cache`, `health`, `ready`, `errors` and `loop`. Each plugin
handles the query or passes it down the chain.

**The records the `kubernetes` plugin serves:**

| Query | Record | Resolves to |
|---|---|---|
| `postgres.tasklane.svc.cluster.local` | A / AAAA | the Service's ClusterIP |
| `tasklane-api.tasklane.svc.cluster.local` | A / AAAA | the Service's ClusterIP |
| a **headless** Service (`clusterIP: None`) | A / AAAA | one record **per ready pod** |
| `postgres-0.postgres.tasklane.svc.cluster.local` | A | that specific StatefulSet pod |
| `_http._tcp.tasklane-api.tasklane.svc.cluster.local` | SRV | port and target for the named port |

The general Service form is
`<service>.<namespace>.svc.<cluster-domain>`. A **headless** Service is the
mechanism behind [StatefulSet](statefulsets.md) per-pod names: because it has no
ClusterIP, DNS returns the pod addresses directly, and each pod also gets its own
`<pod>.<service>.<namespace>.svc.<cluster-domain>` A record — which is how
`postgres-0` is addressable and stable.

```bash
kubectl -n tasklane exec netcheck -- getent hosts postgres tasklane-api postgres.tasklane.svc.cluster.local postgres-0.postgres.tasklane.svc.cluster.local
```

```console include="captures/k8s-intermediate/dns-names.txt"
```

**`ndots:5` and the search list are the performance story.** The resolver treats
a name with fewer than 5 dots as *possibly* relative and tries each entry in the
`search` list first. `postgres` (0 dots) becomes, in order,
`postgres.tasklane.svc.cluster.local`, `postgres.svc.cluster.local`,
`postgres.cluster.local`, and only then `postgres` as an absolute name — up to
four lookups (each an A and AAAA query) before the right answer. A fully
qualified name ending in a dot (`postgres.tasklane.svc.cluster.local.`) skips the
whole search dance. This is why external names in hot paths are worth writing
fully qualified, and why a busy pod can generate surprising DNS query volume.

## Basic example

Inside the network-policy stage, the debug pod resolves the same name several
ways. `getent hosts postgres` succeeds via the search list; the fully qualified
name resolves in one query; the headless record `postgres-0.postgres...` returns
the specific pod. All of it is served by CoreDNS from live Service and
EndpointSlice data, not a static file.

## Explanation

The resolution of `postgres` from a Tasklane API pod, end to end:

1. The libc resolver reads `/etc/resolv.conf`, sees 0 dots < `ndots:5`, and
   sends `postgres.tasklane.svc.cluster.local` (first search entry) to the
   `kube-dns` ClusterIP.
2. That query is itself routed by kube-proxy's rules to a CoreDNS pod.
3. CoreDNS's `kubernetes` plugin matches the `svc.cluster.local` zone, looks up
   the `postgres` Service in `tasklane`, and returns its ClusterIP.
4. The API pod opens a TCP connection to that ClusterIP:5432, which kube-proxy
   DNATs to the actual PostgreSQL pod.

Every arrow is a component doing one job: resolver → kube-proxy → CoreDNS →
API server data → back, then a second kube-proxy translation for the real
connection.

## Common patterns

**Fully qualify hot external names.** For a name your app resolves constantly,
especially an external one, write it with a trailing dot or enough dots to beat
`ndots:5`, and skip the search-list lookups.

**Tune `ndots` per pod when needed.** `dnsConfig.options` on a pod can lower
`ndots` for a workload that mostly talks to external names, cutting query
amplification. Do it deliberately — lowering it can break resolution of short
in-cluster names.

**Use `dnsPolicy` intentionally.** `ClusterFirst` (the default) sends everything
to CoreDNS. `None` plus an explicit `dnsConfig` gives full control for special
cases; `Default` inherits the node's resolver and loses cluster records.

**Headless Service for per-pod addressing.** When clients need to reach specific
pods (a StatefulSet, a peer-to-peer system), a headless Service gives stable
per-pod names; a normal Service gives you one virtual IP and no way to pick a
pod.

## Production considerations

CoreDNS is on the critical path for essentially every connection, so treat it as
infrastructure: run enough replicas, give it requests and limits, and watch its
latency and error metrics. A slow CoreDNS looks like slowness in every
application at once.

**NodeLocal DNSCache** is the standard scaling answer at size. It runs a DNS
cache as a DaemonSet on every node; pods query the node-local cache over a link-
local address instead of crossing the network to a CoreDNS pod for every lookup.
It cuts latency, reduces conntrack pressure from UDP DNS, and shields CoreDNS
from query storms. Add it when DNS query volume or conntrack on busy nodes
becomes a problem, not before.

The `cache` plugin's TTL governs how quickly a Service IP change (or endpoint
change on a headless Service) is seen. Very long caches trade freshness for load;
the defaults are usually right.

Autoscale CoreDNS with load. A fixed two-replica CoreDNS behind a cluster that
grew tenfold is a common, quiet bottleneck.

## Security considerations

**A default-deny egress [NetworkPolicy](network-policy.md) blocks DNS**, because
resolution is egress to CoreDNS in `kube-system` on port 53. The symptom is not
"connection refused" but `no such host` / `Temporary failure in name
resolution` — the lookup fails before any packet reaches the real destination.
Every default-deny namespace needs an explicit DNS egress allow (UDP **and** TCP
on 53), as the network-policy stage shows.

DNS answers reveal cluster structure: which Services and namespaces exist. On a
shared cluster, a pod can enumerate Services by resolving names. This is another
reason to segment with NetworkPolicy — it limits not just connections but what a
compromised pod can usefully reach after resolving a name.

The `loop` and `errors` plugins in the Corefile are guard rails, not decoration.
A misconfigured `forward` that points CoreDNS back at itself is a classic
crash-loop; keep `loop` enabled so it is detected at start rather than in
production.

## Troubleshooting

```bash
kubectl -n tasklane exec netcheck -- cat /etc/resolv.conf
kubectl -n tasklane exec netcheck -- getent hosts postgres
kubectl -n kube-system get pods -l k8s-app=kube-dns
kubectl -n kube-system logs -l k8s-app=kube-dns --tail=50
```

- **`no such host` after tightening egress policy** — DNS egress is blocked. Add
  the CoreDNS allow rule. This is the single most common DNS "failure".
- **Slow but working resolution** — the `ndots:5` search-list tax on an external
  name. Fully qualify it or lower `ndots`.
- **A Service resolves but the connection fails** — DNS is fine; the problem is
  endpoints or kube-proxy, not resolution.
- **A headless Service returns no records** — no pod is ready; headless records
  only list ready endpoints.
- **CoreDNS crash-looping** — a `forward` loop; check the Corefile and that
  `loop` is enabled.

See [DNS failures](../troubleshooting/dns-failures.md) for a full method.

## Common mistakes

- **Denying egress without allowing DNS.** Resolution stops namespace-wide.
- **Assuming a name is resolved absolutely.** Short names walk the search list
  first because of `ndots:5`.
- **Expecting a normal Service to give per-pod addresses.** Use a headless
  Service for that.
- **Fixed CoreDNS replicas** on a cluster that keeps growing.
- **Pointing `forward` at the cluster resolver itself**, creating a loop.
- **Configuring an app with a pod IP** instead of a Service name, defeating the
  entire point of DNS.

## Related topics

- [Services](../k8s-beginner/services.md)
- [kube-proxy and EndpointSlices](kube-proxy-and-endpointslices.md)
- [Network model and CNI](network-model-and-cni.md)
- [NetworkPolicy](network-policy.md)
- [StatefulSets](statefulsets.md)
- [DNS failures](../troubleshooting/dns-failures.md)
- [Labs](labs.md)
