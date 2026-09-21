---
title: Kubernetes events
description: The Event API, why events expire, and how to keep them with an event-exporter for debugging and audit.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/debugging-basics
  - operations/logging-architectures
---

## Overview

A Kubernetes **Event** is a short, timestamped record that a component emits
about an object: "Scheduled", "Pulling image", "BackOff", "Killing". Events are
the first thing `kubectl describe` shows and the fastest way to learn *why* a
pod is stuck. But they are **ephemeral** — they expire after about an hour by
default — so anything you want to keep must be shipped off-cluster. This page
covers the Event API, the TTL mechanism, and event exporters.

## Why it exists and when to use it

Controllers make decisions the user never directly sees: the scheduler picks a
node, the kubelet pulls an image, the runtime kills a container. Events are how
those components narrate their actions on an object, without dumping into their
own logs where you would never find them.

Use events for real-time diagnosis: a pod is `Pending`, `describe` it, and the
events say `FailedScheduling: 0/3 nodes available: insufficient cpu`. Use an
event exporter when you need events to *outlive* their TTL — for postmortems,
audit, or alerting on patterns like repeated `OOMKilling`.

## How it works underneath

Events are first-class API objects in the `events.k8s.io/v1` group (the old core
`v1` Event is still served but `events.k8s.io/v1` is current). A component
creates an Event referencing an involved object, with a `reason` (short, machine
tokens like `Scheduled`), a human `message`, a `type` (`Normal` or `Warning`),
and timestamps. Repeated identical events are **aggregated** with a count and a
`lastTimestamp` rather than stored one-per-occurrence, which is why `describe`
shows "(x12 over 5m)".

**Expiry.** Events would swamp etcd if kept forever, so the kube-apiserver
prunes them. The retention is controlled by the apiserver flag
`--event-ttl`, which **defaults to 1 hour**. After the TTL the apiserver deletes
the Event. This is a control-plane setting; on managed clusters you usually
cannot change it, and even where you can, raising it pressures etcd.

Because events live in etcd under the apiserver's TTL, they are *not* durable
and *not* a log. Treating them as an audit trail without exporting them loses
data the moment the TTL passes.

## Basic example

The everyday use — read recent events, newest last:

```bash
kubectl get events -A --sort-by=.lastTimestamp | tail
```

```console include="captures/operations/ops-events-recent.txt"
```

Scoped to Tasklane during an incident:

```bash
kubectl -n tasklane get events --sort-by=.lastTimestamp | tail
```

```console include="captures/operations/ops-events-ns.txt"
```

You can confirm the apiserver's TTL (where you have control-plane access):

```console include="captures/operations/ops-event-ttl.txt"
```

## Explanation

`kubectl describe pod` merges the object's spec/status with the Events that
reference it, which is why it is the best single command for "why is this pod
unhappy". The `Warning`-type events are the ones that usually matter:
`FailedScheduling`, `BackOff`, `Unhealthy` (a failing probe), `FailedMount`,
`OOMKilling`. `Normal` events (`Scheduled`, `Pulled`, `Created`, `Started`)
trace the happy path.

`--sort-by=.lastTimestamp` matters because default event ordering is not
chronological. Sorting by last timestamp gives a readable timeline, and `tail`
shows the most recent.

## Common patterns

- **`kubectl get events --watch`** during a deploy to watch the scheduler and
  kubelet narrate a rollout live.
- **`kubectl events`** (the dedicated subcommand) offers nicer filtering than
  `get events` on current clusters.
- **Event exporter.** Deploy an event-exporter (for example the Kubernetes
  event-exporter or Alloy's `otelcol`/`loki.source.api` receivers) that watches
  the Event API and ships every event to Loki, Elasticsearch, or a webhook —
  making events durable and queryable long after the TTL.
- **Alerting on events.** Route specific `reason`s (`OOMKilling`,
  `FailedScheduling`, repeated `BackOff`) into alerts, since some failures show
  up as events before any metric moves.

## Production considerations

- **Do not rely on the 1-hour TTL for anything you need later.** Export events
  if you want history. Raising `--event-ttl` is a band-aid that loads etcd.
- **Event volume can be high.** A crash-looping deployment generates a flood;
  exporters and alert rules should aggregate by `reason`/object, not fire per
  event.
- **kube-state-metrics** exposes some event-adjacent counts as metrics, which is
  often a better alerting source than scraping events directly.
- **Managed clusters** may cap or hide event TTL controls; assume you cannot
  change it and export instead.

## Security considerations

- Events can leak information — image names, node names, config errors,
  sometimes secret-mount failures with paths. Treat exported events as
  sensitive and control access to the store.
- Anyone with `create` on events can inject misleading records; in multi-tenant
  clusters, RBAC on the Event API matters for trust in your audit trail.
- An event exporter reads events cluster-wide; its ServiceAccount is a
  broad-read credential — scope and protect it.
- Events are **not** the security audit log. Use the API server's
  [audit log](../k8s-security/audit-logging.md) for authenticated,
  tamper-resistant records of who did what.

## Troubleshooting

- **`describe` shows no events:** they already expired (older than the TTL), or
  the object is new. Check `get events` sorted by time.
- **Events exist but not in your store:** the exporter is down or lacks RBAC to
  list events; check its logs.
- **Flood of duplicate-looking events:** aggregation is working (note the
  count); the underlying object is failing repeatedly — fix the root cause.
- **Cannot change TTL:** you are on a managed control plane; export events
  instead of trying to retain them in etcd.

## Common mistakes

- Treating events as a durable log or an audit trail; they expire in ~1 hour.
- Sorting events by default order and misreading the timeline (use
  `--sort-by=.lastTimestamp`).
- Alerting per-event instead of on aggregated `reason`s, creating storms.
- Confusing Events with the API server **audit log**, which is the real record
  of API access.

## Related topics

- [Logging architectures](logging-architectures.md)
- [Actionable alerting](actionable-alerting.md)
- [Debugging basics](../k8s-beginner/debugging-basics.md)
- [Audit logging](../k8s-security/audit-logging.md)
