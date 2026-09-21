---
title: DNS failures
description: How CoreDNS, ndots:5, search domains and resolv.conf resolve names in a cluster, and why NetworkPolicy, an overloaded CoreDNS or a broken upstream break resolution.
level: advanced
type: troubleshooting
status: current
versions: Kubernetes 1.37
prerequisites:
  - troubleshooting/method
  - k8s-intermediate/dns-and-coredns
  - k8s-intermediate/network-policy
---

## Overview

In-cluster name resolution goes through **CoreDNS**, and pods are configured
with a `search` domain list and `ndots:5` that make short names resolve to
cluster Services. When DNS breaks, everything downstream looks broken — apps
report "host not found" or "connection timed out" for a name that should
resolve. This page traces a lookup end to end and covers the usual failures:
CoreDNS itself, `ndots` surprises, resolv.conf, NetworkPolicy blocking DNS
egress, and upstream resolution for external names.

## Symptoms

- Apps log `no such host`, `Temporary failure in name resolution`, or connection
  timeouts to a Service name that exists.
- `nslookup <svc>` from inside a pod fails or times out, while the Service and
  its endpoints are fine.
- Resolution is slow (seconds) even when it eventually succeeds — a classic
  `ndots`/search-domain symptom.
- Only **external** names fail (in-cluster names work), or vice versa.

## How it works underneath

Each pod's `/etc/resolv.conf` (with the default `dnsPolicy: ClusterFirst`) points
its nameserver at the cluster DNS Service (`kube-dns` in `kube-system`, served by
CoreDNS) and sets:

```text
search <ns>.svc.cluster.local svc.cluster.local cluster.local
options ndots:5
```

`ndots:5` means: if the name you look up has **fewer than 5 dots**, try it with
each `search` domain appended first, and only try it as-is last. So `postgres`
becomes `postgres.<ns>.svc.cluster.local` (a hit) on the first search entry.

Two consequences that cause real bugs:

- **External names pay a tax.** `example.com` has one dot (< 5), so the resolver
  tries `example.com.<ns>.svc.cluster.local`, `example.com.svc.cluster.local`,
  `example.com.cluster.local` — all NXDOMAIN — before finally querying
  `example.com.`. That is up to four extra round-trips per lookup, which under
  load overloads CoreDNS and adds latency. A **fully qualified** name with a
  trailing dot (`example.com.`) skips the search list.
- **CoreDNS is a Deployment.** It runs as pods; if those pods are unhealthy,
  under-resourced, or unreachable, resolution fails cluster-wide. It is a shared
  dependency and a single point of failure if you run too few replicas.

CoreDNS forwards names it does not own (anything outside `cluster.local`) to the
node's upstream resolvers via its `forward` plugin. A broken upstream, or a node
`/etc/resolv.conf` the CoreDNS pods inherit, breaks external resolution while
in-cluster names still work.

`NodeLocal DNSCache` is a common production add-on: a DaemonSet that runs a DNS
cache on every node so pods query a local listener over TCP, cutting CoreDNS load
and conntrack races. Its absence is not a bug, but its presence changes where to
look.

### NetworkPolicy blocks DNS

DNS is just UDP/TCP traffic to port 53 of the CoreDNS pods in `kube-system`. A
**default-deny egress** NetworkPolicy that forgets to allow DNS egress breaks
resolution for every pod it selects — the app cannot reach CoreDNS at all, so
every name fails. This is the most common self-inflicted DNS outage. See
[NetworkPolicy blocking traffic](networkpolicy-blocking.md).

## Diagnosis

1. **Resolve from inside an affected pod.** Distroless pods have no tools, so
   attach an ephemeral container:

   ```bash
   kubectl -n <ns> debug -it <pod> --image=busybox:1.37 --target=<container> -- \
     nslookup postgres
   ```

   Try a Service name, a fully-qualified name, and an external name to localise
   the failure.

2. **Check CoreDNS health.**

   ```bash
   kubectl -n kube-system get pods -l k8s-app=kube-dns -o wide
   kubectl -n kube-system logs -l k8s-app=kube-dns --tail=50
   ```

   `SERVFAIL`/timeout logs, or crash-looping CoreDNS pods, point at CoreDNS or
   its upstream.

3. **Inspect the pod's resolver config.**

   ```bash
   kubectl -n <ns> debug -it <pod> --image=busybox:1.37 --target=<container> -- \
     cat /etc/resolv.conf
   ```

4. **Suspect NetworkPolicy** if only some namespaces fail: list policies and
   confirm DNS egress is allowed.

   ```bash
   kubectl -n <ns> get networkpolicy
   ```

## Fixes

- **NetworkPolicy blocking DNS.** Add an egress rule allowing UDP and TCP port 53
  to the `kube-system` CoreDNS pods (or to the whole namespace) for every
  default-deny policy. This is the first fix to check when a policy was just
  applied.
- **External-name latency/failures.** Use fully-qualified names with a trailing
  dot for external hosts, lower `ndots` via `dnsConfig` for DNS-heavy pods, or
  add NodeLocal DNSCache to absorb the extra queries.
- **CoreDNS overloaded.** Scale CoreDNS up, give it CPU/memory headroom, and
  consider NodeLocal DNSCache. Investigate a query storm from a misconfigured
  `ndots`.
- **Broken upstream.** Fix the node's upstream resolvers or CoreDNS `forward`
  configuration; confirm the CoreDNS pods can reach the upstream.
- **Wrong `dnsPolicy`.** Pods on host network need `dnsPolicy: ClusterFirstWithHostNet`
  to still use cluster DNS.

## Prevention

- Always pair a **default-deny egress** policy with an explicit **DNS egress
  allow** rule; make it a template.
- Prefer fully-qualified external names, or tune `ndots` for services that
  resolve many external names per second.
- Run CoreDNS with enough replicas and resources for the cluster's query rate,
  and monitor its latency and error metrics.
- Consider NodeLocal DNSCache for busy clusters to cut CoreDNS load and tail
  latency.

## Common mistakes

- A default-deny egress policy with no DNS allow, breaking every lookup.
- Not realising `ndots:5` multiplies external lookups; blaming CoreDNS for load
  that a trailing dot would remove.
- Running a single, under-resourced CoreDNS replica as a cluster-wide SPOF.
- Testing DNS from your laptop instead of from inside the affected pod, missing
  the pod's own resolv.conf and policy context.
- Forgetting `ClusterFirstWithHostNet` for host-network pods.

## Related topics

- [A method for debugging Kubernetes](method.md)
- [NetworkPolicy blocking traffic](networkpolicy-blocking.md)
- [Service has no endpoints](service-no-endpoints.md)
- [DNS and CoreDNS](../k8s-intermediate/dns-and-coredns.md)
- [Network policy](../k8s-intermediate/network-policy.md)
