---
title: NetworkPolicy
description: The additive allow-list model, why a default-deny needs a DNS hole, the AND-vs-OR selector trap, and why the whole thing depends on your CNI.
level: intermediate
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-intermediate/network-model-and-cni
  - k8s-beginner/services
  - k8s-beginner/labels-selectors-annotations
---

## Overview

The [flat pod network](network-model-and-cni.md) lets any pod reach any other
pod, in any namespace, on any port. NetworkPolicy is how you take that back. A
`NetworkPolicy` (`networking.k8s.io/v1`, GA since 1.8) is a namespaced object
that selects pods and describes which traffic is allowed to or from them.

Three facts define the whole model:

- **It is allow-listing only.** There is no deny rule. You permit traffic; you
  never forbid it directly.
- **It is additive with no ordering.** The effective policy for a pod is the
  union of every policy that selects it. There is no priority, no "first match".
- **A pod is unaffected until some policy selects it.** The moment one policy
  selects a pod for a direction, everything not explicitly allowed in that
  direction is dropped for that pod.

## Why it exists and when to use it

Without policy, a compromised front-end can open a socket straight to the
database, and a leaked pod in one namespace can scan every other namespace. The
flat network is a flat trust domain. NetworkPolicy turns it into segments so a
breach in one workload does not become a breach in all of them.

Use it on anything holding data (Tasklane's PostgreSQL), on anything exposed to
untrusted input (the API behind the Gateway), and as a namespace-wide
default-deny that you then poke holes in. The pattern this handbook uses is
**deny everything, then allow exactly what the application needs** — it is far
easier to reason about a closed namespace with four holes than an open one you
are trying to wall off after the fact.

## How it works underneath

The API server stores a NetworkPolicy like any other object. **Kubernetes core
does nothing else with it.** Enforcement is entirely the CNI plugin's job: a
component on each node (for the lab's kindnet, that is `kube-network-policies`;
for Calico, Felix; for Cilium, eBPF programs) watches NetworkPolicy, Namespace
and Pod objects and programs the node's datapath — iptables, nftables or eBPF —
so that packets not matching an allow rule are dropped.

The order of evaluation, per direction, is:

1. Does **any** policy in the pod's namespace select this pod for this direction
   (`Ingress` or `Egress`)? If none does, all traffic in that direction is
   allowed — the pod is "not isolated".
2. If at least one does, the pod is **isolated** for that direction. A packet is
   allowed only if some selecting policy has a rule that matches its peer and
   port. Otherwise it is **dropped** — silently, at the datapath.

Two consequences follow from this that trip everyone up. First, **the two
directions are independent**: selecting a pod for `Ingress` does nothing to its
egress, and vice versa. Second, because policies are additive, you cannot write
a policy that *removes* access another policy grants — you delete or narrow the
granting policy instead.

Selectors are the identity system. NetworkPolicy never sees IP addresses you
chose or Services; it works on **labels**. `podSelector` matches pods, and
`namespaceSelector` matches namespaces by their labels — including the automatic
`kubernetes.io/metadata.name` label every namespace carries. The port in a rule
is the port on the **destination pod** (the container port), because by the time
the datapath evaluates the policy, kube-proxy has already rewritten any Service
IP to a pod IP.

:::warning The selector AND-vs-OR trap
Inside one `from`/`to` list item, a `namespaceSelector` and a `podSelector`
combine with **AND**: "pods matching X *inside* namespaces matching Y". Split
across two list items they become **OR**: "everything in namespaces matching Y,
*plus* every pod matching X anywhere". This one difference has opened more
clusters than any other NetworkPolicy mistake — an accidental OR on a DNS rule
allows every pod in the cluster, not just CoreDNS.
:::

## Basic example

Start by taking the namespace dark in both directions. An empty `podSelector`
selects every pod:

```yaml include="examples/k8s/06-network-policy/00-default-deny.yaml"
```

Nothing works now — including DNS, because name resolution is egress to
CoreDNS. The single most forgotten rule is the one that adds it back. Note that
the namespace selector and pod selector sit in **one** list item, so they are
ANDed to "the `k8s-app=kube-dns` pods inside `kube-system`":

```yaml include="examples/k8s/06-network-policy/10-allow-dns.yaml"
```

Now allow the database's real callers, on the container port `5432`, using a
`matchExpressions` `In` set for the three components that need it:

```yaml include="examples/k8s/06-network-policy/20-postgres.yaml"
```

The API's ingress comes from two other namespaces (the Envoy Gateway data plane
and monitoring), so each peer needs a `namespaceSelector` — a bare `podSelector`
only ever matches the policy's own namespace:

```yaml include="examples/k8s/06-network-policy/30-api.yaml"
```

Apply the whole set together, or the namespace loses DNS the moment `00-` lands:

```bash
kubectl apply -f examples/k8s/06-network-policy/00-default-deny.yaml -f examples/k8s/06-network-policy/10-allow-dns.yaml -f examples/k8s/06-network-policy/20-postgres.yaml -f examples/k8s/06-network-policy/30-api.yaml -f examples/k8s/06-network-policy/40-worker.yaml -f examples/k8s/06-network-policy/50-maintenance.yaml
kubectl -n tasklane get networkpolicy
```

```console include="captures/k8s-intermediate/netpol-apply.txt"
```

## Explanation

The result is a namespace where the Gateway can reach the API, Prometheus can
scrape both workloads, the API, worker and nightly maintenance Job can reach
PostgreSQL, every pod can resolve DNS, and nothing else can talk to anything.
Prove it with a pod that no policy selects — it can resolve names (the DNS rule
selects *all* pods) but cannot open the database:

```bash
kubectl -n tasklane label pod netcheck app.kubernetes.io/component=netcheck --overwrite
kubectl -n tasklane exec netcheck -- getent hosts postgres
kubectl -n tasklane exec netcheck -- pg_isready -h postgres -t 5
```

```console include="captures/k8s-intermediate/netpol-blocked.txt"
```

Give the same pod a label the database policy admits, and the connection
succeeds — identity is the label, not the address:

```bash
kubectl -n tasklane label pod netcheck app.kubernetes.io/component=api --overwrite
kubectl -n tasklane exec netcheck -- pg_isready -h postgres -t 5
```

```console include="captures/k8s-intermediate/netpol-allowed.txt"
```

A **dropped** connection hangs until the client's timeout; a **rejected** one
fails instantly. NetworkPolicy drops, so "it just hangs" is the fingerprint of a
policy that is doing its job.

## Common patterns

**Default-deny per namespace, then narrow allows.** Ship `00-default-deny` and
`10-allow-dns` as the baseline for every application namespace, and let each
workload add its own ingress and egress policies.

**One policy per workload and direction.** `api-ingress` and
`api-egress-postgres` are separate objects. Small, single-purpose policies are
readable and can be revoked one at a time, and the additive model means they
compose without interfering.

**Allow DNS explicitly and always.** After any default-deny egress, add the
CoreDNS egress rule (UDP and TCP on 53). Forgetting it is the classic outage:
the symptom is `no such host`, not `connection refused`, because resolution
fails before a packet is ever sent to the real destination.

**Select by component labels, not by name.** `app.kubernetes.io/component: api`
survives a rename or a second Deployment; a policy keyed to one pod name does
not.

## Production considerations

NetworkPolicy is a namespaced object, so it cannot express cluster-wide
baselines: "every namespace denies cross-namespace traffic by default" has to be
replicated into each namespace, usually by a controller or a GitOps template. If
you need genuinely cluster-scoped rules with an explicit deny and a priority
order, that is what **AdminNetworkPolicy** and **BaselineAdminNetworkPolicy**
were designed for — see the note below.

Policy changes apply to **new** connections. A long-lived connection opened
before a tightening policy landed can survive until it closes, so restart the
client when you test a change, and do not assume a new deny has severed existing
sessions.

Egress policy to the world is coarse. `ipBlock` matches CIDRs, but a pod that
talks to an external API by DNS name resolves to addresses you do not control
and that change; egress by IP is brittle for SaaS endpoints. FQDN-based egress
is a plugin feature (Cilium, Calico), not part of the core API.

:::note AdminNetworkPolicy status
`AdminNetworkPolicy` and `BaselineAdminNetworkPolicy` are **not** part of core
Kubernetes. They are CRDs from the SIG-Network `network-policy-api` project,
served under `policy.networking.k8s.io/v1alpha1` — **alpha, off by default, and
not for production**. They add cluster-scoped, ordered rules with explicit
`Allow`, `Deny` and `Pass` actions, which core NetworkPolicy cannot express.
Support depends on the CNI implementing them; treat them as emerging, and verify
your plugin's coverage before relying on them.
:::

## Security considerations

**Policy is only as real as your CNI.** On a cluster whose plugin ignores
NetworkPolicy, the API server still accepts every object, `kubectl get netpol`
still lists them, and **nothing is enforced**. The lab's kindnet ships
`kube-network-policies` and does enforce; a managed cluster may not, depending
on the plugin. Test with a pod that should be blocked — never assume.

`hostNetwork: true` pods use the node's network namespace and are not subject to
pod selectors the way ordinary pods are; a privileged pod can reprogram the
datapath outright. Pair NetworkPolicy with Pod Security Admission so that the
policy cannot simply be side-stepped.

Do not forget egress to the cloud metadata endpoint (`169.254.169.254`). A
default-deny egress that only re-allows DNS and the database also blocks
metadata, which is usually what you want; if you allow broad egress, block that
address explicitly.

Verify the fix, do not trust the manifest: run the exploit (a shell pod
connecting to the database) before and after applying the policy, and confirm
the paths that must still work still do:

```bash
curl -sS -o /dev/null -w 'gateway->api HTTP %{http_code}\n' http://localhost:8080/
```

```console include="captures/k8s-intermediate/netpol-gateway-still-works.txt"
```

## Troubleshooting

`kubectl describe` prints the effective rules and, crucially, which directions a
policy actually constrains:

```bash
kubectl -n tasklane describe networkpolicy api-ingress
```

```console include="captures/k8s-intermediate/netpol-describe.txt"
```

- **Everything broke, including name resolution** — a default-deny egress with
  no DNS allow. The tell is `no such host` / `Temporary failure in name
  resolution`, not a connection error.
- **A connection hangs then times out** — it is being dropped by a policy. A
  connection that fails instantly is something else (no endpoint, wrong port).
- **A cross-namespace peer is refused** — you used a bare `podSelector`, which
  only matches the policy's own namespace. Cross-namespace needs a
  `namespaceSelector`.
- **A rule allows far more than intended** — check whether a `namespaceSelector`
  and `podSelector` you meant to AND are in separate list items (an OR).
- **The policy has no effect at all** — the CNI is not enforcing NetworkPolicy.
  Confirm the plugin supports it and its agent is running on every node.

See [NetworkPolicy blocking traffic](../troubleshooting/networkpolicy-blocking.md)
for a systematic walkthrough.

## Common mistakes

- **Forgetting the DNS egress hole** after a default-deny. The commonest
  self-inflicted outage in this whole topic.
- **`namespaceSelector` + `podSelector` in two list items** when you meant an
  AND — a silent, much wider allow.
- **Using the Service port** in a rule. The port is the destination pod's
  container port (5432), not the Service port (80).
- **Assuming enforcement.** A plugin that ignores NetworkPolicy accepts every
  object and blocks nothing.
- **Expecting a policy to deny.** There is no deny; you narrow or delete the
  allowing policy instead.
- **A label typo.** Selectors are labels, so a mistyped label is a silent outage
  or a silent hole, with no error anywhere.
- **Trusting that an existing connection was cut.** Enforcement is on new
  connections; restart the client to test.

## Related topics

- [Network model and CNI](network-model-and-cni.md)
- [kube-proxy and EndpointSlices](kube-proxy-and-endpointslices.md)
- [DNS and CoreDNS](dns-and-coredns.md)
- [Services](../k8s-beginner/services.md)
- [Labels, selectors and annotations](../k8s-beginner/labels-selectors-annotations.md)
- [Network segmentation](../k8s-security/network-segmentation.md)
- [NetworkPolicy blocking traffic](../troubleshooting/networkpolicy-blocking.md)
- [Labs](labs.md)
