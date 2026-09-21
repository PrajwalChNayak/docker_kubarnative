---
title: Distributed tracing with OpenTelemetry
description: Spans, context propagation, W3C traceparent, OTLP, Collector pipelines, head vs tail sampling, and the Tempo/Jaeger backends.
level: expert
type: concept
status: current
versions: Kubernetes 1.37, OpenTelemetry Collector 0.161
prerequisites:
  - operations/prometheus-and-kube-prometheus
  - operations/logging-architectures
---

## Overview

A **trace** follows one request across every service it touches. Where a metric
says "5% of requests are slow" and a log says "this one failed", a trace says
"the request spent 400ms waiting on the database call inside the worker". This
page covers the tracing data model (spans, context propagation, W3C
`traceparent`), **OpenTelemetry** as the vendor-neutral standard, the **OTLP**
protocol, the **Collector** pipeline, and the sampling choice that dominates
cost: head vs tail.

## Why it exists and when to use it

In a system of one process, a stack trace is enough. In a system where a request
crosses an API, a queue and a worker, no single process sees the whole story.
Distributed tracing reconstructs it by having every service record its slice and
tag it with a shared trace id.

Use tracing to answer "where did the latency go?" and "what path did this
request take?" across services. It is the third pillar beside metrics and logs.
You do **not** need it for a single service with no fan-out — the cost of
instrumenting and storing traces is only repaid when requests cross boundaries.

## How it works underneath

**Spans and traces.** A **span** is one timed operation: a name, start/end time,
attributes, and status. Spans form a tree via parent-child links; the whole tree
sharing one **trace id** is the trace. The Tasklane API handling `POST /tasks`
is a span; the database write it makes is a child span; the worker later
processing that task is another span, ideally linked to the same trace.

**Context propagation.** For the worker's span to join the API's trace, the
trace context must travel with the request. The **W3C Trace Context** standard
defines the `traceparent` HTTP header:
`traceparent: 00-<trace-id>-<span-id>-<flags>`. The caller injects it; the
callee extracts it and makes its spans children. Across a queue, the context
rides in message metadata instead of a header. Get propagation wrong and you get
disconnected single-span "traces".

**OpenTelemetry (OTel).** A CNCF project that standardises the API, SDKs and
wire protocol so instrumentation is not tied to one vendor. You instrument once
against OTel and can send to Tempo, Jaeger, or a SaaS without re-instrumenting.

**OTLP.** The OpenTelemetry Protocol — one wire format for traces, metrics and
logs, over gRPC (port 4317) or HTTP (4318). Because all three signals share a
protocol, one Collector receiver ingests everything.

**The Collector.** A standalone process with a pipeline of **receivers**
(ingest) → **processors** (batch, filter, sample, enrich) → **exporters** (send
onward). Running a Collector between apps and backends decouples them: apps only
know OTLP, and you change backends or add sampling in the Collector, not in
every app.

## Basic example

A gateway Collector that receives OTLP and fans traces, metrics and logs to
their backends. This is the custom-resource form (needs the OpenTelemetry
Operator); a raw Deployment variant is in the example directory for the bare
lab:

```yaml include="examples/observability/otel/collector-cr.yaml" lines="20-50"
```

The pipeline wiring makes the signal flow explicit:

```yaml include="examples/observability/otel/collector-cr.yaml" lines="51-64"
```

## Explanation

`memory_limiter` sits first in every pipeline for a reason: under load it sheds
data before the Collector runs out of memory, protecting it from an OOM that
would drop *everything*. `batch` groups spans before export, cutting per-request
overhead and backend load. Each signal has its own pipeline but shares the one
OTLP receiver, so a single endpoint serves traces, metrics and logs.

The exporters name real backends — Tempo for traces, Loki for logs, a Prometheus
scrape endpoint for metrics. Swapping Tempo for Jaeger is a one-line exporter
change; the apps never notice, which is the whole point of the Collector.

## Common patterns

- **Agent + gateway.** A per-node Collector (agent) enriches with Kubernetes
  metadata and forwards to a central gateway Collector that does sampling and
  export. The agent keeps app-to-Collector latency tiny; the gateway centralises
  policy.
- **Auto-instrumentation.** The OTel Operator can inject language SDKs into pods
  via an annotation, so you get traces without editing app code (best-effort;
  hand-instrument the spans that matter).
- **Correlating the three pillars.** Put the trace id into logs (as a field, not
  a Loki label) and exemplars into metrics, so you can jump metric → trace →
  log for one request.
- **Span attributes over log lines.** Record structured detail as span
  attributes; it is queryable in the tracing backend without a text scan.

## Production considerations

- **Sampling is the cost lever.** Storing every span is expensive and mostly
  redundant. Two strategies:
  - **Head sampling** decides at the *start* of a trace (e.g. keep 10%). Cheap
    and stateless, but blind — it may drop the very trace that errored.
  - **Tail sampling** decides after seeing the *whole* trace (keep it if it
    errored or was slow). Far more useful, but the Collector must buffer all
    spans of a trace and therefore **all spans of one trace must reach the same
    Collector instance**, which constrains how you load-balance and scale out.
- **Backends.** **Tempo** (Grafana, object-storage-backed, cheap, trace-id
  lookup + TraceQL) and **Jaeger** (CNCF, mature UI) are the common
  open-source choices. Both speak OTLP.
- **Clock skew** across nodes distorts span timing; rely on durations within a
  service more than absolute cross-service timestamps.
- **Collector as a bottleneck.** Size and scale the gateway; a `memory_limiter`
  plus horizontal scaling (with tail-sampling affinity) keeps it healthy.

## Security considerations

- Spans and their attributes can capture **PII and secrets** (URLs with tokens,
  SQL with values, headers). Scrub sensitive attributes in a Collector
  processor before export.
- The OTLP receiver is an ingest endpoint; do not expose it publicly. Keep it on
  the cluster network and authenticate cross-cluster export.
- Exporter configs hold backend credentials — store them in Secrets.
- Auto-instrumentation injects a sidecar/init and SDK into pods; treat that
  supply chain like any injected code.

## Troubleshooting

- **Disconnected single-span traces:** context propagation is broken — the
  caller is not injecting `traceparent` or the callee is not extracting it
  (often a missing propagator across an async/queue boundary).
- **No traces at all:** apps cannot reach the OTLP endpoint, or sampling is set
  to ~0%. Add the `debug` exporter temporarily to see spans arrive.
- **Tail sampling keeps nothing/everything:** policy misconfigured, or spans of a
  trace are landing on different Collector instances (fix load-balancing so a
  trace is whole on one instance).
- **Collector OOM:** raise `memory_limiter` headroom or add replicas; batching
  and buffering under tail sampling are memory-hungry.

## Common mistakes

- Expecting traces to connect without propagating `traceparent` across every
  hop, including queues.
- Turning on tail sampling while load-balancing spans across Collectors, so
  traces are split and decisions are wrong.
- Head-sampling at a low rate and then wondering why error traces are missing.
- Putting high-cardinality identifiers into metric/log labels instead of span
  attributes.
- Shipping raw request URLs/headers as span attributes, leaking secrets.

## Related topics

- [Logging architectures](logging-architectures.md)
- [Prometheus and kube-prometheus](prometheus-and-kube-prometheus.md)
- [SLOs and error budgets](slos-and-error-budgets.md)
- [Kubernetes events](kubernetes-events.md)
