---
title: Aggregated APIs
description: How kube-aggregator hands a URL path to your own API server, what that buys over a CRD, and why almost nobody should build one.
level: expert
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-advanced/custom-resource-definitions
  - k8s-advanced/controllers-and-operators
---

## Overview

An aggregated API is a second API server, running as an ordinary workload,
that the main kube-apiserver proxies to. You register it with an APIService
object claiming a group/version, and from then on every request to
`/apis/<group>/<version>/...` is forwarded to your pods. To clients it is
indistinguishable from a built-in API: `kubectl get` works, RBAC applies,
discovery lists it.

You have almost certainly used one. `kubectl top` reads `metrics.k8s.io`,
which is not stored in etcd at all — it is computed on demand by metrics-server
and served through aggregation. That is the canonical example of a resource
that should not be a [CRD](custom-resource-definitions.md): it is derived,
high-churn, and never persisted.

The API is `apiregistration.k8s.io/v1`, GA and stable. The `v1beta1` version
was removed in 1.22.

## Why it exists and when to use it

Start from the assumption that you want a CRD, and look for a reason it cannot
work. The Kubernetes documentation's comparison is the right checklist. On
ease of use, CRDs win every row: they need no programming, no extra service to
run and fail, no upstream bug fixes to track, and no handling of multiple API
versions. An aggregated API "requires programming and building binary and
image", and is "an additional service to create and that could fail".

Where aggregation wins is capability:

| Feature | CRD | Aggregated API |
|---|---|---|
| Custom storage (not etcd) | No | Yes |
| Subresources beyond `status` and `scale`, for example `logs` or `exec` | No | Yes |
| Strategic merge patch | No | Yes |
| Protocol Buffers clients | No | Yes |
| Arbitrary validation and business logic | Via webhooks | Native, in your handler |

Reduced to a rule: **build an aggregated API when the objects should not live
in etcd.** Metrics that are recomputed every 15 seconds, a view over an
existing external database, a resource with millions of instances, a resource
that must be served from a cache with its own consistency model. If your
objects are configuration that users create and a controller reconciles, that
is a CRD, and building an API server instead is a career-scale mistake in
effort terms.

:::warning The cost is a distributed systems project, not a feature
You are writing an API server: versioning, conversion, defaulting,
admission, authorisation delegation, TLS, discovery, availability. You will
track upstream `k8s.io/apiserver` changes three times a year. Two thirds of
"we should build an aggregated API" conversations end correctly with a CRD.
:::

## How it works underneath

The aggregation layer runs in-process inside kube-apiserver. Until an
APIService exists, it does nothing.

1. You create an **APIService** naming a group and version. The docs describe
   this as the object that "claims" a URL path in the Kubernetes API.
2. kube-aggregator adds that group/version to discovery, so `kubectl api-resources`
   and every client library learn about it.
3. A request arriving at that path is **proxied** to the Service in
   `spec.service`, over TLS validated against `spec.caBundle`.
4. Your server authenticates the request — not by re-authenticating the user,
   but by trusting the front proxy — authorises it by asking the main API
   server, and answers.

### The APIService object

| Field | Meaning |
|---|---|
| `spec.group`, `spec.version` | The group/version being claimed. The object's name must be `<version>.<group>`. |
| `spec.service` | `name`, `namespace` and `port` of the backing Service. `port` defaults to 443. Omit `service` entirely for a group served locally by kube-apiserver itself. |
| `spec.caBundle` | PEM CA bundle used to validate your server's serving certificate. |
| `spec.insecureSkipTLSVerify` | Disables that validation. Strongly discouraged. |
| `spec.groupPriorityMinimum` | Sorts groups against each other, highest first. The `*.k8s.io` groups conventionally sit at 18000. |
| `spec.versionPriority` | Sorts versions within the group, highest first, then by kube-like version ordering where GA beats beta beats alpha. Must be greater than zero. |
| `status.conditions` | Carries an `Available` condition, with a `reason` when it is false. |

### Trust: why a second server can believe the first

Your API server does not see the user's credentials. kube-aggregator terminates
authentication and re-presents the request with the user's identity in HTTP
headers, signed by a client certificate.

Three pieces make that safe:

- kube-apiserver is started with the aggregation layer flags — the
  `--requestheader-*` and `--proxy-client-*` family — which define the CA that
  signs the proxy client certificate and which headers carry identity.
- The `extension-apiserver-authentication` ConfigMap in `kube-system` publishes
  that CA. Your server reads it, which is why its ServiceAccount needs a
  RoleBinding to the `extension-apiserver-authentication-reader` Role in
  `kube-system`.
- Your server delegates authorisation back to the main API server with
  SubjectAccessReviews, which is what the `system:auth-delegator` ClusterRole
  grants.

Get the first wrong and your server trusts headers from anyone who can reach
it. Get the third wrong and you have written an API with no authorisation.

### Availability is now your problem

The aggregator proxies live requests. If your pods are down, requests to that
group fail, the APIService goes `Available=False`, and — because discovery is
aggregated — clients doing a full discovery may see errors for *unrelated*
groups. A broken aggregated API is a classic cause of "`kubectl` is slow and
prints a warning about the metrics API".

The documentation is specific about latency: discovery requests "must
round-trip from the kube-apiserver in five seconds or less", and if your
extension server cannot meet that, you must change it so it can.

## Basic example

The lab already runs one: metrics-server v0.9.0.

```bash
kubectl get apiservices | grep metrics
```

```console include="captures/k8s-advanced/agg-apiservices-metrics.txt"
```

The APIService object itself, with the backing Service, the CA settings and the
`Available` condition:

```bash
kubectl get apiservice v1beta1.metrics.k8s.io -o yaml | head -40
```

```console include="captures/k8s-advanced/agg-apiservice-yaml.txt"
```

And what the group actually serves:

```bash
kubectl get --raw /apis/metrics.k8s.io/
```

```console include="captures/k8s-advanced/agg-metrics-group.txt"
```

## Explanation

### The metrics API in 1.37

`metrics.k8s.io/v1` became **stable in 1.37**. The v1 surface is identical to
`v1beta1` apart from the version: same NodeMetrics and PodMetrics types, same
fields, same numbers. No feature gate is involved, because the API is served by
an aggregated server, not by kube-apiserver.

That last point is the whole lesson of this page. "The API is stable in 1.37"
does not mean your cluster serves it. Whether `metrics.k8s.io/v1` exists
depends entirely on the implementation behind the APIService. **metrics-server
v0.9.0 registers `v1beta1.metrics.k8s.io`**, so on the lab cluster the v1
endpoint is not there, however new the control plane is. The capture above is
the authoritative answer for your cluster.

Two consequences:

- `kubectl top` prefers v1 and falls back to v1beta1, so it works either way.
- **The HPA controller supports only v1beta1 in 1.37.** Discovery-based
  selection between the two is planned but not in this release. So the
  [HorizontalPodAutoscaler](horizontal-pod-autoscaler.md) needs v1beta1 to
  remain registered regardless.

This is also why Storage Version Migration, which works on every built-in
resource and every CRD, "will fail" for aggregated APIs: the migration
machinery requires an integer resource version, which aggregated servers are
not obliged to provide.

### Reading the object

`insecureSkipTLSVerify: true` in the metrics-server manifests is a real
security trade-off, made because the aggregator would otherwise need the CA
that signed metrics-server's serving certificate, which it generates itself.
It means kube-apiserver does not verify who it is talking to for that group.
In a cluster you care about, issue the serving certificate from a CA you
control — cert-manager is the usual route — and set `caBundle` instead.

`groupPriorityMinimum` and `versionPriority` in those manifests are both low
numbers. They only matter when two APIServices claim overlapping ground, which
is rare and unpleasant when it happens.

## Common patterns

**Aggregated API plus CRD.** The two are not exclusive. A common shape is
configuration in CRDs, reconciled by a controller, with a small aggregated API
serving a derived, non-persisted view — exactly the split between "the
Deployment object" and "the metrics about it".

**Aggregation for `logs`-style subresources.** If your resource needs a verb
that is not CRUD — streaming, exec, an arbitrary action endpoint — that is a
real reason to aggregate, and one a CRD cannot answer.

**apiserver-builder / sample-apiserver.** Do not start from a blank file. The
documentation points at the apiserver-builder library, which scaffolds the
extension server and its controllers together.

**Treat it like a control-plane component.** Multiple replicas, a
PodDisruptionBudget, an anti-affinity rule, a PriorityClass, and alerts on the
APIService's `Available` condition.

## Production considerations

An aggregated API server is on the critical path for its group, and partly on
the critical path for discovery. Plan for at least two replicas on different
nodes and treat a single-replica deployment as a scheduled outage generator,
exactly as you would a [webhook](admission-webhooks.md).

Certificates expire. The serving certificate needs rotation, and `caBundle`
needs to follow it. cert-manager's CA injector can write `caBundle` on an
APIService the same way it does on a webhook configuration.

Version skew is real. Your server links `k8s.io/apiserver` at some version and
runs against a control plane that moves three times a year. Budget an upgrade
of your extension server into every cluster upgrade.

Watch the APIService condition, not just the pods:

```bash
kubectl get apiservices -o custom-columns='NAME:.metadata.name,AVAILABLE:.status.conditions[?(@.type=="Available")].status,REASON:.status.conditions[?(@.type=="Available")].reason'
```

An aggregated API that answers slowly is worse than one that is down, because
everything that does discovery pays for it.

## Security considerations

**Threat.** An APIService points a Kubernetes API path at a Service. Whoever
controls the Service controls what that path returns and, because clients
trust the API server, what the cluster believes.

**Exploit.** An attacker with `update` on `apiservices` — or merely `patch` on
the Service the APIService references, or on its EndpointSlices — repoints
`metrics.k8s.io` at a pod they control. That pod returns fabricated PodMetrics.
Every HPA reading resource metrics now scales on numbers the attacker chooses:
to zero, to deny service, or to the maximum, to exhaust a cluster's capacity
and its budget. Nothing in the audit log shows a scaling decision being
tampered with, because the scaling decisions are genuine; only their input is
forged. The same trick against a policy-relevant group lets an attacker return
whatever objects they like to anything that lists them.

**Fix.**

- `apiservices` is a cluster-admin resource. `create`, `update` and `patch` on
  it are equivalent to controlling an API path; audit who holds them.
- Set `caBundle` and leave `insecureSkipTLSVerify` false wherever you can, so
  the aggregator verifies it is talking to the server you meant.
- Lock down the backing Service and its namespace. Write access to the
  Service, its selector or its EndpointSlices is equivalent to write access to
  the APIService.
- In the extension server, delegate authorisation with SubjectAccessReviews
  rather than implementing your own. Do not trust the identity headers unless
  the request presented a certificate signed by the requestheader CA.
- Alert on changes to APIService objects and on `Available=False`.

**Verify.**

```bash
kubectl auth can-i update apiservices --as=system:serviceaccount:tasklane:tasklane-api
kubectl get apiservice v1beta1.metrics.k8s.io -o jsonpath='{.spec.service}{"\n"}{.spec.insecureSkipTLSVerify}{"\n"}'
```

The first must answer `no`. The second must name the Service you expect, in the
namespace you expect.

## Troubleshooting

**`kubectl get` for the group returns "the server is currently unable to handle
the request".** The APIService is `Available=False`. Read the condition's
`reason` and `message` first; they usually name the failing Service or a TLS
problem.

**`kubectl api-resources` prints an error about one group and then continues.**
Aggregated discovery failed for that group. Harmless to other groups in modern
clients, but it means something is down.

**`kubectl top` says metrics are not available.** Either metrics-server is not
running, or its APIService is unavailable. Check both, in that order.

**TLS errors in the kube-apiserver log for the aggregated path.** `caBundle`
does not match the serving certificate, or the certificate is not valid for
`<service>.<namespace>.svc`.

**Your server sees requests as anonymous.** The requestheader configuration is
wrong, or the server cannot read the `extension-apiserver-authentication`
ConfigMap in `kube-system`. Check the RoleBinding to
`extension-apiserver-authentication-reader`.

**Everything works but every authorisation decision is "allowed".** The server
is not delegating. Check the `system:auth-delegator` ClusterRoleBinding and
that SubjectAccessReviews are actually being issued.

## Common mistakes

- Building one when a CRD would have done. This is the mistake; the rest are
  details.
- Expecting `metrics.k8s.io/v1` to exist because the Kubernetes release says it
  is stable. The implementation decides, and metrics-server v0.9.0 registers
  v1beta1.
- Assuming an HPA can use v1. In 1.37 the HPA controller supports only v1beta1.
- Leaving `insecureSkipTLSVerify: true` in a production manifest because it was
  in the example you copied.
- One replica, and discovering during a node drain that it was load-bearing.
- Naming the APIService anything other than `<version>.<group>`.
- Forgetting the `system:auth-delegator` binding, and shipping an API with no
  authorisation.
- Trying to run a StorageVersionMigration against an aggregated resource.
- Letting the extension server's `k8s.io/apiserver` dependency drift until it
  blocks a control-plane upgrade.

## Related topics

- [Custom Resource Definitions](custom-resource-definitions.md)
- [Controllers and operators](controllers-and-operators.md)
- [Admission webhooks](admission-webhooks.md)
- [Admission policies with CEL](admission-policies-cel.md)
- [Horizontal Pod Autoscaler](horizontal-pod-autoscaler.md)
- [Metrics Server and the Metrics API](../operations/metrics-server-and-metrics-api.md)
- [cert-manager](../k8s-intermediate/cert-manager.md)
