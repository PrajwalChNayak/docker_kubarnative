---
title: Logging architectures
description: 12-factor stdout logging, node agent vs sidecar vs direct-write, Loki label cardinality, structured logs, retention and PII.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37, Loki 3.7
prerequisites:
  - k8s-beginner/debugging-basics
  - operations/prometheus-and-kube-prometheus
---

## Overview

Logs are the narrative record of what a process did. In Kubernetes the
platform, not the app, is responsible for collecting them: a well-behaved
container writes lines to **stdout/stderr**, the kubelet captures them, and a
**collector** ships them to a store like **Loki**. This page compares the three
collection architectures — **node agent**, **sidecar**, and **direct write** —
and covers the details that decide whether logging scales: label cardinality,
structured logging, retention and PII.

## Why it exists and when to use it

Metrics tell you *that* something is wrong; logs tell you *what*. You need a
logging pipeline because container filesystems are ephemeral — when a pod dies,
its logs die with it unless something shipped them off the node.

The guiding rule is **12-factor**: treat logs as an event stream and write them
to stdout. The app must not manage log files, rotation, or shipping; those are
the platform's job. This keeps the container simple and lets you swap the
backend without touching the app.

## How it works underneath

When a container writes to stdout/stderr, the container runtime captures the
stream and the kubelet writes it to a file on the node under
`/var/log/pods/<namespace>_<pod>_<uid>/<container>/*.log`, with rotation. That
file is what `kubectl logs` reads and what a collector tails.

**Node agent (DaemonSet).** One collector pod per node reads every local pod
log file (or reads them through the Kubernetes API) and forwards them. This is
the default and cheapest model: the app does nothing but write stdout, and one
agent serves all pods on the node.

**Sidecar.** A second container in the pod tails a shared volume (or the app's
files) and forwards them, or re-emits them to stdout for the node agent. It
costs one extra container per pod and exists only for cases the node agent
cannot handle: an app that writes multiple log files, or needs per-app parsing.

**Direct write.** The app itself ships logs to the backend via an SDK/appender.
It couples the app to the backend, loses logs when the backend is down or the
app crashes mid-flush, and bypasses the platform's retention and redaction. In
Kubernetes, avoid it.

| Model | Cost | App change | Use when |
|---|---|---|---|
| Node agent | 1 agent/node | none (stdout) | default |
| Sidecar | 1 container/pod | maybe | app can't use stdout, multiple files, special parsing |
| Direct write | none extra | SDK in app | almost never on Kubernetes |

## Basic example

Grafana **Alloy** as a node agent. Promtail is **deprecated** in favour of
Alloy, so new work uses Alloy. This DaemonSet tails each node's pods through the
Kubernetes API and ships to Loki:

```yaml include="examples/operations/logging/alloy-daemonset.yaml" lines="1-24"
```

The collector config discovers only the local node's pods, maps a small set of
metadata to labels, lifts the JSON `level` field to a label, and writes to Loki:

```text include="examples/operations/logging/alloy-daemonset.yaml" lines="55-108"
```

## Explanation

The manifest uses `loki.source.kubernetes`, which reads logs **through the API
server** — so it needs no `hostPath` and runs as a **non-root** user, at the
cost of API load. The classic node-agent form instead mounts `/var/log/pods` as
a `hostPath` and uses `loki.source.file`; those files are root-owned, so that
variant must run as **root**. Both are node agents; pick by whether you can
afford API load or need to avoid running root DaemonSets.

The relabeling deliberately keeps only `namespace`, `app` and `container` as
labels and lifts `level`. It drops the pod name. That is not an oversight — see
cardinality below.

## Common patterns

- **Structured logging (JSON).** Emit machine-parseable lines
  (`{"level":"error","msg":"...","task_id":"..."}`). The collector can then lift
  a few fields to labels and leave the rest queryable in the line. Tasklane logs
  JSON to stdout.
- **Label only what you filter streams by; keep the rest in the line.** Loki
  indexes labels, not content; LogQL filters (`|= "task_id=123"`) scan the line
  cheaply.
- **Central multi-tenant Loki** with per-tenant labels and retention, fronted by
  Grafana Explore for querying.
- **Log-based metrics** (Loki's `metric` queries) for the rare event that has no
  metric yet — but prefer a real metric for anything you alert on.

## Production considerations

- **Loki label cardinality is the scaling limit.** Loki creates one **stream**
  per unique label set. High-cardinality labels — pod name, request id, user id,
  trace id — explode the number of streams and destroy performance and cost.
  Keep labels bounded (`namespace`, `app`, `container`, `level`) and push
  identifiers into the log body.
- **Retention lives on the store, not the agent.** Configure Loki retention and
  compaction; do not try to rotate at the agent.
- **Backpressure.** When the backend is slow, the agent buffers; size buffers and
  set limits so a Loki outage does not fill node disks.
- **Cost.** Logs are usually the largest telemetry bill. Sample or drop chatty
  debug logs at the agent, and set aggressive retention on low-value streams.
- **Loki is AGPLv3.** Running it internally is fine; modifying and distributing
  it triggers source-sharing obligations.

## Security considerations

- **PII and secrets.** Logs frequently capture emails, tokens or request bodies.
  Scrub or avoid them **before** they reach the line — deletion from an
  immutable log store is slow or impossible. Redact at the app or in a collector
  processing stage.
- **Access control.** Logs are sensitive; gate Loki/Grafana behind auth and
  per-tenant isolation. A read-all logging user is a data-exfiltration path.
- **Root DaemonSets.** File-tailing agents run as root with host mounts — a
  large privilege. Prefer the API-tail form, or constrain the root agent
  tightly (read-only root FS, dropped capabilities).
- **Retention and compliance.** Some data must be kept (audit) and some must be
  deleted (right-to-erasure). Encode both in retention policy.

## Troubleshooting

- **No logs in Loki:** the agent is not discovering pods (RBAC, node selector),
  or cannot reach Loki's push endpoint. Check the agent's own logs and `/ready`.
- **Loki slow or OOMing:** cardinality — too many streams. Audit labels; a
  single high-cardinality label is usually the cause.
- **Missing recent lines:** rotation raced the tailer, or the app buffers stdout
  (disable output buffering in the app).
- **`kubectl logs` works but Loki is empty:** the agent, not the kubelet, is the
  problem — narrow to the collector.

## Common mistakes

- Writing to log files inside the container instead of stdout, defeating the
  platform pipeline.
- Putting pod name, request id or user id in Loki **labels**, exploding
  cardinality.
- Starting new work on **Promtail** (deprecated) instead of Alloy.
- Logging PII/secrets and trying to delete them later.
- Using direct-write from the app, coupling it to the backend and losing logs on
  outage.

## Related topics

- [Distributed tracing with OpenTelemetry](distributed-tracing-opentelemetry.md)
- [Kubernetes events](kubernetes-events.md)
- [Prometheus and kube-prometheus](prometheus-and-kube-prometheus.md)
- [Debugging basics](../k8s-beginner/debugging-basics.md)
