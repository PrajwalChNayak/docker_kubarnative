---
title: Audit logging
description: The API server audit policy — stages, levels and backends — and what to actually log so you can answer who did what, when.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-security/authentication-and-authorisation
  - k8s-security/rbac
---

## Overview

**Audit logging** is the API server's record of every request: who made it, what
they asked for, and what happened. It is how you answer "who read that Secret?"
or "when was this ClusterRoleBinding created?" after the fact. Without it, an
incident is invisible; with it, you have the evidence trail. Auditing is
configured with an **audit policy** and one or more **backends**, both on the
API server.

## Why it exists and when to use it

The API server is the one place every consequential action passes through, which
makes it the ideal audit point. You want auditing on from day one on any cluster
that matters, because you cannot retroactively log an event you did not capture.
It underpins compliance ("use Kubernetes audit logs to monitor access" is an
explicit CKS objective) and incident response alike.

## How it works underneath

Each API request passes through up to four **stages**, and the audit policy
decides how much to record at each:

| Stage | When |
|---|---|
| `RequestReceived` | As soon as the request arrives |
| `ResponseStarted` | Response headers sent (for long-running requests like watches) |
| `ResponseComplete` | Response finished |
| `Panic` | The request triggered a panic |

For matching requests, the policy also picks a **level** — how much detail:

| Level | Records |
|---|---|
| `None` | Nothing (used to drop noisy requests) |
| `Metadata` | Who, what, when, verb, resource — but **not** request/response bodies |
| `Request` | Metadata plus the request body |
| `RequestResponse` | Metadata plus request **and** response bodies |

A policy is an ordered list of rules; the **first matching rule** sets the level
for a request. Bodies can contain secret material, so `RequestResponse` on
Secrets would log the secret values — you deliberately log Secrets at `Metadata`
only. Matched events are written to **backends**: the **log** backend (a file on
the control-plane node, usually shipped to a SIEM) and the **webhook** backend
(streamed to an external service).

## Basic example

An audit policy is an apiserver config file, not a cluster resource:

```yaml title="audit-policy.yaml" fragment
apiVersion: audit.k8s.io/v1
kind: Policy
# Drop the highest-volume, lowest-value noise first.
omitStages:
  - RequestReceived
rules:
  # Secrets: record who/what, never the contents.
  - level: Metadata
    resources:
      - group: ""
        resources: ["secrets", "configmaps"]
  # RBAC changes: capture the full object — these are high-signal.
  - level: RequestResponse
    resources:
      - group: "rbac.authorization.k8s.io"
        resources: ["roles", "clusterroles", "rolebindings", "clusterrolebindings"]
  # Everything else at metadata.
  - level: Metadata
```

## Explanation

Rules are evaluated top to bottom, so the specific, sensitive resources come
first: Secrets and ConfigMaps at `Metadata` (never their bodies), then RBAC
objects at `RequestResponse` because a new `cluster-admin` binding is exactly
what you want the full record of. A final catch-all logs everything else at
`Metadata`. `omitStages: [RequestReceived]` halves volume by skipping the
duplicate "request arrived" event. This is a fragment; the real file is passed
to kube-apiserver with `--audit-policy-file`.

## Common patterns

- **Metadata as the floor, `RequestResponse` for RBAC and admission changes.**
- **`level: None` for noisy, low-value traffic** (health checks, leader-election
  leases, kube-system's own chatter) to control volume and cost.
- **Never log secret bodies** — Secrets at `Metadata` only.
- **Ship to a SIEM** and alert on high-signal events: Secret reads by unusual
  subjects, new bindings, `exec` into pods, anonymous requests.

## Production considerations

Audit volume is large and directly costs storage and money, so the policy is a
constant balance between coverage and noise — start from a known-good policy and
trim. The log backend writes to the control-plane node, so managed clusters
often expose audit through the provider's logging pipeline instead of a file you
control; know which you have. Retention must match your compliance window, and
the pipeline itself must be reliable — a dropped audit stream is a blind spot
during exactly the incident you are auditing for.

## Security considerations

Audit logs contain sensitive metadata (who accessed what) and must be protected
and tamper-evident; an attacker's first move is often to stop or scrub logs, so
ship them off the cluster in near-real-time. Feed high-signal events to
detection — Falco can consume the audit stream as an event source — so an
anomalous Secret read or a surprise `cluster-admin` binding pages someone rather
than sitting in a file. Auditing is detective, like Falco: it records, it does
not prevent.

## Troubleshooting

If expected events are missing, check the **first matching rule** — a broad
early rule at `None` can swallow requests you meant to log later. If Secret
values appear in logs, a rule is logging their bodies (`Request`/
`RequestResponse`); drop Secrets to `Metadata`. If volume is unmanageable,
add `level: None` rules for the noisiest resources and `omitStages`.

## Common mistakes

- Not enabling auditing until after an incident, when it is too late.
- Logging Secret bodies at `Request`/`RequestResponse`.
- One blanket `RequestResponse` rule that produces unaffordable volume.
- Leaving logs only on the control-plane node where an attacker can delete them.
- Collecting audit logs but alerting on none of them.

## Related topics

- [Authentication and authorisation](authentication-and-authorisation.md)
- [RBAC in depth](rbac.md)
- [Runtime security with Falco](runtime-security-falco.md)
- [Common attack paths](common-attack-paths.md)
