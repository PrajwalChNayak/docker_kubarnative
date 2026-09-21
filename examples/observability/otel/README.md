# OpenTelemetry Collector for Tasklane

A gateway OpenTelemetry Collector that receives OTLP (traces, metrics, logs)
from instrumented workloads, batches, and fans out to a traces backend (Tempo),
a logs backend (Loki) and a Prometheus-scrapable metrics endpoint.

Written against OpenTelemetry Collector **v0.161.0**. OTLP is the
OpenTelemetry Protocol — one wire format (gRPC on 4317, HTTP on 4318) for all
three signals, which is why a single receiver feeds every pipeline.

## Two ways to run it

- **`collector-cr.yaml`** — an `OpenTelemetryCollector` custom resource
  (`opentelemetry.io/v1beta1`). **Requires the OpenTelemetry Operator.** The
  operator reconciles the CR into a Deployment, ConfigMap, Service and RBAC.
  Install the operator first:

  ```bash
  # cert-manager is a prerequisite of the operator's admission webhooks.
  kubectl apply -f https://github.com/open-telemetry/opentelemetry-operator/releases/latest/download/opentelemetry-operator.yaml
  kubectl apply -f examples/observability/otel/collector-cr.yaml
  ```

- **`collector-raw.yaml`** — the same pipeline as a plain
  Deployment + ConfigMap + Service. **No operator required**, so it runs on the
  bare kind lab:

  ```bash
  kubectl apply -f examples/observability/otel/collector-raw.yaml
  ```

Use one, not both.

## Pipeline

```
OTLP (4317/4318) -> memory_limiter -> batch -> traces  -> otlphttp/tempo
                                            -> metrics -> prometheus (:8889)
                                            -> logs    -> otlphttp/loki
```

`memory_limiter` is first in every pipeline so the collector sheds load before
it OOMs; `batch` cuts export overhead. Point the exporter endpoints at your
real Tempo, Loki and Prometheus before relying on this.

## Sampling

This gateway does head sampling (the SDK/collector decides up front). For
tail-based sampling (keep a trace only if it errored or was slow) add the
`tail_sampling` processor — note it must see *whole* traces, so all spans of a
trace must reach the same collector instance, which constrains how you scale
out. See the distributed-tracing page.

## Validate locally

```bash
.tools/kubeconform.exe -strict -summary -kubernetes-version 1.37.0 \
  -schema-location default \
  -schema-location "https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json" \
  examples/observability/otel/*.yaml
```
