---
title: Grafana dashboards
description: Datasources, panels, variables and provisioning dashboards as code, built around the Tasklane overview dashboard.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37, Grafana 13.2
prerequisites:
  - operations/prometheus-and-kube-prometheus
---

## Overview

Grafana is the visualisation layer over Prometheus (and many other sources). A
**dashboard** is a JSON document of **panels**, each running a query against a
**datasource** and rendering the result. This page shows how datasources,
panels and template **variables** fit together, and — the part teams get wrong —
how to manage dashboards **as code** instead of clicking them into existence.

## Why it exists and when to use it

Prometheus can graph a single query, but it is not an operations console.
Grafana gives shared, versioned dashboards: a stable view of a system that a
whole team reads the same way, with variables to pivot by namespace or pod and
alerting hooks. Use it for the "how is the system behaving" overview and for
drill-down during incidents.

Do not build a dashboard for every metric. Good dashboards answer a question
("is Tasklane healthy?") and follow the RED (Rate, Errors, Duration) or USE
(Utilisation, Saturation, Errors) method. A wall of 60 panels nobody reads is
worse than four that matter.

:::note Grafana is AGPLv3
Grafana (and Loki) are **AGPLv3**. Running Grafana internally is fine.
Distributing a **modified** Grafana — including offering it as a network service
to third parties in some readings — triggers the AGPL's source-sharing
obligation. Know this before you fork it into a product.
:::

## How it works underneath

A **datasource** is a configured connection (type + URL + auth), for example the
Prometheus that kube-prometheus-stack installs. Each panel references a
datasource by **UID**, not by name, so dashboards stay portable across
environments that use the same UID.

A **panel** holds one or more **targets** (queries) plus display config (unit,
legend, thresholds). At render time Grafana sends each target to the datasource
over the selected time range and draws the frames it gets back.

A **template variable** is a named value the whole dashboard interpolates. A
`datasource`-typed variable lets one dashboard point at any Prometheus; a
`query`-typed variable populates a dropdown from a PromQL `label_values(...)`
call, so you can filter by namespace or pod without editing panels.

**Provisioning** is Grafana reading dashboards and datasources from files/objects
on startup instead of from its database. In Kubernetes the kube-prometheus-stack
Grafana runs a **sidecar** that watches for ConfigMaps carrying a label
(`grafana_dashboard`) and loads their JSON. That is how a dashboard becomes a
Git-managed artifact.

## Basic example

The Tasklane overview dashboard has four panels — request rate, pending backlog,
per-worker processed rate, worker error rate — and a `datasource` variable so it
is portable:

```json include="examples/observability/dashboards/tasklane.json" lines="1-24"
```

Each panel names the `${datasource}` variable and a PromQL query. The full
dashboard is in the example directory:

```json include="examples/observability/dashboards/tasklane.json" lines="25-89"
```

## Explanation

The request-rate panel uses `sum by (code) (rate(tasklane_http_requests_total[5m]))`
— `rate` converts the counter to per-second, and `sum by (code)` keeps one line
per HTTP status so a spike in `5xx` is visible. The backlog panel uses
`max(tasklane_tasks_pending)` because both API replicas report the same gauge;
`max` collapses the duplicate. The processed-rate panel splits by `pod` to show
whether one worker is doing all the work. The error panel sums the worker error
rate into a single line — the number you would alert on.

The `graphTooltip: 1` setting makes all panels share a crosshair, so hovering
one time-aligns the others — essential for correlating a request spike with a
backlog rise.

## Common patterns

- **Dashboards as code.** Store JSON in Git, deliver it as a labelled ConfigMap,
  let the sidecar load it. Review dashboard changes like any other code.

  ```bash
  kubectl create configmap tasklane-dashboard --namespace monitoring \
    --from-file=tasklane.json=examples/observability/dashboards/tasklane.json \
    --dry-run=client -o yaml \
    | kubectl label --local -f - grafana_dashboard=1 -o yaml | kubectl apply -f -
  ```

- **Variables for reuse.** A `namespace` and `pod` variable turns one dashboard
  into a template for every workload, instead of copy-pasting per app.
- **RED/USE layout.** Top row: rate, errors, latency (RED) for request-driven
  services; utilisation/saturation for resources (USE). Put the summary at the
  top, drill-down below.
- **Library panels and rows** keep large dashboards maintainable; collapse
  detail into rows so the default view stays scannable.

## Production considerations

- **Datasource UID stability.** Provision datasources as code too, with fixed
  UIDs, so dashboards move cleanly between clusters.
- **Query cost.** A dashboard open on a wall TV re-runs every query on the
  refresh interval. Wide time ranges over high-cardinality metrics can hammer
  Prometheus; prefer recording rules for heavy expressions.
- **Access control.** Grafana orgs/folders/teams scope who sees what. Read-only
  viewers for most, edit rights for few. Never ship the default admin password
  (the lab value is a placeholder).
- **Version the schema.** `schemaVersion` changes across Grafana releases;
  export from a version close to what you run so imports do not silently drop
  fields.

## Security considerations

- Grafana can reach every datasource it is configured with; a compromised
  Grafana is a window into all of them. Put it behind SSO and least-privilege
  datasource permissions.
- Disable anonymous access unless a dashboard is deliberately public, and even
  then serve a read-only org.
- Dashboard JSON can contain queries that expose sensitive label values; review
  provisioned dashboards like code.
- Respect the AGPL if you modify and distribute Grafana.

## Troubleshooting

- **Panel shows "No data":** the query returns nothing (wrong metric name,
  label, or time range), or the `${datasource}` variable is unset. Test the
  query in Explore first.
- **Dashboard not appearing:** the sidecar did not pick it up — check the
  ConfigMap carries the `grafana_dashboard` label and lives where the sidecar
  watches.
- **Wrong datasource after import:** the dashboard hard-codes a UID that does
  not exist here; use a `datasource` variable instead.
- **Slow dashboard:** high-cardinality queries or a huge range; add recording
  rules and narrow the default range.

## Common mistakes

- Building dashboards in the UI and never exporting them, so they live only in
  Grafana's database and vanish on reinstall.
- Hard-coding a datasource instead of using a `datasource` variable.
- Summing a per-replica gauge instead of using `max`.
- One giant dashboard with dozens of panels nobody reads; prefer focused,
  method-driven dashboards.
- Shipping the default admin credentials.

## Related topics

- [Prometheus and kube-prometheus](prometheus-and-kube-prometheus.md)
- [Actionable alerting](actionable-alerting.md)
- [SLOs and error budgets](slos-and-error-budgets.md)
- [Cost visibility](cost-visibility.md)
