---
title: external-dns
description: Publishing DNS records for Services, Ingresses and Gateway API routes to a real DNS provider - sources, the TXT ownership registry, --policy, and the RBAC it needs.
level: intermediate
type: concept
status: current
versions: Kubernetes 1.37, external-dns v0.23.0
prerequisites:
  - k8s-intermediate/gateway-api
  - k8s-intermediate/dns-and-coredns
---

## Overview

[CoreDNS](dns-and-coredns.md) answers names *inside* the cluster. **external-dns**
answers the opposite problem: publishing *external* DNS records — in Route 53,
Cloud DNS, Cloudflare and others — so the outside world can reach a Gateway,
Ingress or Service by name. It is a controller that watches Kubernetes objects
and reconciles a DNS provider's records to match them.

This page documents **external-dns v0.23.0**. It is not installed in the lab
(the lab's names are `*.localhost`, which need no external provider), so there
is no captured output here; the flags and behaviour below are verified against
the external-dns documentation.

## Why it exists and when to use it

Without it, exposing a service means someone manually creating a DNS record that
points at a load balancer address, and remembering to change it when the address
changes. external-dns closes that loop: create a Gateway or Ingress with a
hostname, and the matching record appears; delete it, and (with the right
policy) the record is removed. The name and the workload stay in sync
automatically, the same way [cert-manager](cert-manager.md) keeps certificates
in sync.

Use it whenever cluster objects own public hostnames — which is most production
clusters exposing HTTP.

## How it works underneath

external-dns runs a reconcile loop:

1. **Read sources.** For each configured `--source`, it lists the relevant
   objects and extracts a desired set of DNS names and targets. A Gateway route
   contributes its `hostnames`; a Service or Ingress contributes a hostname from
   an annotation or its own spec, and a target from the load balancer address.
2. **Read the provider.** It lists existing records in the configured zones via
   the `--provider` plugin.
3. **Reconcile.** It computes the difference and applies changes — subject to
   `--policy` and to ownership, below.

**Sources** (`--source`, repeatable). The ones that matter here, with exact
names:

| `--source` value | Reads |
|---|---|
| `service` | Services (typically `LoadBalancer`), hostname from annotation |
| `ingress` | Ingress objects and their `status` address |
| `gateway-httproute` | Gateway API `HTTPRoute` hostnames |
| `gateway-grpcroute` | `GRPCRoute` hostnames |
| `gateway-tlsroute` / `gateway-tcproute` / `gateway-udproute` | the other route types |

For the Gateway route sources, the desired names come from the **route's own
`hostnames` field**, and the target from the parent Gateway's address — so a
route that already declares `tasklane.example.com` needs no extra annotation for
external-dns to publish it. The Service source, by contrast, has no inherent
hostname and takes one from a hostname annotation on the Service.

**Providers** (`--provider`) are pluggable: `aws` (Route 53), `google` (Cloud
DNS), `azure`, `cloudflare` and many more. Each needs credentials scoped to the
zones it manages, supplied the provider's usual way (IRSA/workload identity, a
Secret, environment).

**The TXT ownership registry** is what makes external-dns safe to run against a
shared zone. With `--registry=txt`, for every record it manages, external-dns
also writes a companion **TXT record** encoding a `--txt-owner-id` — a unique
identifier for this external-dns instance (usually the cluster name). On each
loop it only ever modifies records whose TXT companion carries **its own** owner
id, so it will never touch a record it did not create, and two clusters sharing
a zone do not fight. `--txt-prefix` (or `--txt-suffix`) avoids naming collisions
between the TXT record and the real record, which matters for CNAMEs.

**`--policy`** governs how aggressive reconciliation is:

| `--policy` | Behaviour |
|---|---|
| `sync` | create, update **and delete** — records fully track the cluster |
| `upsert-only` | create and update, but **never delete** |
| `create-only` | create only; never update or delete |

Start with `upsert-only`. It is the safe default: a mistaken object deletion
cannot wipe a production record.

## Basic example

The shape of a Deployment's arguments for the Gateway route source (the manifest
is illustrative, not from the lab, so it is not applied here):

```yaml title="external-dns-args.yaml" fragment
args:
  - --source=gateway-httproute
  - --source=ingress
  - --provider=aws
  - --registry=txt
  - --txt-owner-id=tasklane-prod
  - --txt-prefix=edns-
  - --policy=upsert-only
  - --domain-filter=example.com
```

With this running and an `HTTPRoute` declaring `hostnames: [tasklane.example.com]`
attached to a Gateway that has an address, external-dns creates an A/ALIAS (or
CNAME) record for `tasklane.example.com` pointing at the Gateway, plus a TXT
record marking it owned by `tasklane-prod`.

## Explanation

The division of labour is the point. The application team writes the hostname
once, in the place it already belongs — the `HTTPRoute` for
[Gateway API](gateway-api.md), or the Ingress spec — and two controllers react:
[cert-manager](cert-manager.md) issues the certificate for that name, and
external-dns publishes the record for it. Nobody edits DNS by hand, and nothing
drifts.

`--domain-filter` scopes external-dns to zones it should manage, so it ignores
names outside `example.com` even if an object declares one. Combined with the
TXT registry's owner id, this is what lets external-dns run safely alongside
records managed by other teams or tools in the same account.

## Common patterns

**Gateway route source plus cert-manager.** Pair `--source=gateway-httproute`
with cert-manager's [Gateway integration](cert-manager.md) so a single hostname
on a route produces both a certificate and a DNS record. This is the modern
"declare a hostname, get a working HTTPS endpoint" pattern.

**`upsert-only` in production, `sync` where churn is expected.** Use
`upsert-only` for stable production names, and reserve `sync` for environments
where records genuinely should disappear with their objects (ephemeral preview
environments).

**One owner id per cluster.** Set `--txt-owner-id` to something unique and
stable per cluster. Two clusters with the same owner id in one zone will each
believe they own the other's records.

**Scope with `--domain-filter`.** Always constrain the zones external-dns may
touch, even when its credentials are already scoped; defence in depth against a
misconfigured source publishing into the wrong zone.

## Production considerations

The provider credential is the blast radius. external-dns needs write access to
DNS zones, which is a powerful grant — a bug or a compromise can repoint or
delete records. Scope the credential to exactly the zones under
`--domain-filter`, use workload identity rather than long-lived keys where the
provider supports it, and never give it more zones than it manages.

Deletion is destructive and asynchronous to your intent. Under `--policy=sync`,
deleting or mislabelling a source object removes the public record, and DNS
caches mean the outage outlives the fix by the record's TTL. This is why
`upsert-only` is the conservative default.

Rate limits and propagation vary by provider. A reconcile storm (many objects
changing at once) can hit provider API limits; external-dns backs off, but large
migrations are worth staging. Record TTLs (set per object via annotation)
trade propagation speed against provider load.

Run a single external-dns per owner id. Multiple replicas are fine for
availability if they share the owner id and the provider's API tolerates it, but
two *independent* deployments managing the same names will thrash.

## Security considerations

Treat the DNS-write credential as a top-tier secret. Control over a zone allows
traffic redirection and, combined with ACME DNS-01, the ability to issue
certificates for those names — a full impersonation primitive. Least-privilege
scoping to specific zones is not optional.

external-dns needs read access across the cluster to its sources. Grant it a
`ClusterRole` with `get`, `list` and `watch` only, on exactly the resources its
configured sources read — for the sources above that is Gateways and the route
types in `gateway.networking.k8s.io`, `ingresses` in `networking.k8s.io`, and
`services` plus `nodes` and `namespaces` in the core group. It never needs write
access to any Kubernetes object; the only thing it writes is DNS.

The TXT ownership registry is a safety control, not just bookkeeping. Without it
(`--registry=noop`), external-dns will happily overwrite any record matching a
source name, including ones created by other systems. Keep `--registry=txt` in
any shared zone.

## Troubleshooting

- **No record appears** — check the source is enabled for the object's kind
  (`gateway-httproute` for routes, not `service`), the object actually declares a
  hostname (a route needs `hostnames`; a Service needs its hostname annotation),
  and the parent has an address to point at. external-dns logs the desired and
  applied changes at the default log level.
- **Records are not deleted** — that is `--policy=upsert-only` working as
  intended. Switch to `sync` only if you want deletions.
- **external-dns refuses to touch an existing record** — it is not the owner.
  The TXT companion carries a different `--txt-owner-id`, so external-dns leaves
  it alone. Reconcile the owner ids or the record was created by something else.
- **Provider API errors** — credential scope or rate limits. Confirm the
  credential can write the zone in `--domain-filter`.

## Common mistakes

- **Running `--policy=sync` before trusting the setup**, so a stray object
  deletion wipes a production record.
- **Reusing one `--txt-owner-id` across clusters**, making them fight over
  records.
- **`--registry=noop` in a shared zone**, letting external-dns clobber records
  it did not create.
- **Using `--source=service` for Gateway routes**; the route sources are
  `gateway-httproute` and friends.
- **A DNS-write credential scoped to the whole account** instead of the specific
  managed zones.
- **Forgetting `--domain-filter`**, so external-dns considers hostnames outside
  the zones you meant to manage.

## Related topics

- [Gateway API](gateway-api.md)
- [DNS and CoreDNS](dns-and-coredns.md)
- [cert-manager](cert-manager.md)
- [Ingress (legacy)](ingress-legacy.md)
- [Services](../k8s-beginner/services.md)
- [Labs](labs.md)
