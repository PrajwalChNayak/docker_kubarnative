---
title: SLOs and error budgets
description: SLI, SLO and SLA; error budgets; and multiwindow multi-burn-rate alerts that page on real budget burn.
level: expert
type: concept
status: current
versions: Kubernetes 1.37, Prometheus 3.14
prerequisites:
  - operations/actionable-alerting
  - operations/prometheus-and-kube-prometheus
---

## Overview

A **Service Level Objective** turns "the service should be reliable" into a
number you can measure and alert on. This page defines the SLI/SLO/SLA trio,
explains the **error budget** that falls out of an SLO, and shows the
**multiwindow, multi-burn-rate** alerting approach that pages when you are
actually spending the budget too fast — the modern replacement for threshold
alerts on raw error rate.

## Why it exists and when to use it

Reliability without a target is an argument: is 99% good? For whom? SLOs replace
that argument with a measured objective agreed between engineering and the
business. The **error budget** — the allowed amount of unreliability — then gives
a shared, unemotional decision rule: budget left means ship features; budget
spent means stop and fix stability.

Use SLOs for user-facing services where you can define "good" from the user's
side (a fast, successful request). Do not slap an SLO on everything; pick the
few user journeys that matter (for Tasklane: creating a task succeeds quickly,
and tasks get processed).

## How it works underneath

- **SLI (Indicator)** — a measured ratio of good events to total events. For the
  Tasklane API: `good = non-5xx responses`, `total = all responses`, so
  `SLI = sum(rate(non-5xx)) / sum(rate(all))`. An SLI is a number between 0 and
  1, computed from metrics like `tasklane_http_requests_total`.
- **SLO (Objective)** — a target for the SLI over a window: "99.9% of requests
  succeed over 30 days". It is internal.
- **SLA (Agreement)** — a contractual promise to a customer with consequences
  (refunds) if missed. The SLA is looser than the SLO on purpose, so you breach
  the internal SLO first and react before the contract is at risk.

**Error budget.** If the SLO is 99.9%, the budget is the remaining **0.1%** of
events that may be bad over the window. At, say, 43,200 requests/month that is
about 43 allowed failures. The budget is a quantity you spend: every failed
request draws it down, and it refills as the window rolls.

**Burn rate.** How fast you are spending the budget relative to "steady". A burn
rate of 1 spends the whole budget exactly over the window; a burn rate of 14.4
spends it in ~2 days. Alerting on burn rate — not on raw error rate — is what
makes SLO alerts both sensitive to real problems and quiet when things are fine.

## Basic example

Define the API availability SLI as a recording rule and alert on budget burn.
The SLI (fragment):

```yaml title="slo-rules.yaml (illustrative)" fragment
groups:
  - name: tasklane-slo.rules
    rules:
      # Good = non-5xx. Total = all. Ratio over 5m and 1h windows.
      - record: tasklane:api_availability:ratio_rate5m
        expr: |
          sum(rate(tasklane_http_requests_total{code!~"5.."}[5m]))
          / sum(rate(tasklane_http_requests_total[5m]))
      - record: tasklane:api_availability:ratio_rate1h
        expr: |
          sum(rate(tasklane_http_requests_total{code!~"5.."}[1h]))
          / sum(rate(tasklane_http_requests_total[1h]))
```

A multi-burn-rate **page** for a 99.9% SLO (fragment):

```yaml title="slo-alerts.yaml (illustrative)" fragment
# Fast burn: 14.4x over 1h AND 5m confirms it is happening NOW. Pages.
- alert: TasklaneAPIErrorBudgetFastBurn
  expr: |
    (1 - tasklane:api_availability:ratio_rate1h)  > (14.4 * 0.001)
    and
    (1 - tasklane:api_availability:ratio_rate5m)  > (14.4 * 0.001)
  for: 2m
  labels:
    severity: critical
```

## Explanation

The SLI is a **ratio of rates**, which is why it is robust: it does not care
about absolute traffic, only the fraction that is bad. `code!~"5.."` counts
successes; dividing by all requests gives availability.

The burn-rate alert compares the *observed* bad fraction to the budget times a
multiplier. `14.4 × 0.001` is the bad-rate that would exhaust a 0.1% budget in
about two days — fast enough to matter. The **`and` of a long and a short
window** is the key trick: the long window (1h) gives significance (not a blip),
the short window (5m) gives freshness (still happening now). Requiring both
avoids paging on a spike that has already recovered.

## Common patterns

- **Multiwindow, multi-burn-rate** (the Google SRE approach): several alerts at
  different burn rates and windows — e.g. 14.4×/1h+5m as a critical **page**,
  6×/6h+30m and 1×/3d+6h as warning **tickets**. Fast burns page; slow burns
  file work.
- **Latency SLOs** alongside availability, using histogram quantiles (native
  histograms make this cheaper): "99% of `POST /tasks` under 300ms".
- **Journey SLOs** over per-endpoint: measure the thing the user cares about.
- **SLO dashboards** showing budget remaining and burn rate, so everyone sees
  the same number.

## Production considerations

- **Pick achievable SLOs.** 100% is the wrong target — it forbids all risk and
  all deploys. Every nine costs more; 99.9% and 99.99% are worlds apart in cost.
- **The error-budget policy is the point.** Agree in advance what happens when
  the budget is exhausted (freeze features, prioritise reliability). Without the
  policy, the number is decoration.
- **Measure from the user's side** where possible (load balancer / gateway
  metrics), not just from inside one service, so you capture failures the
  service never sees.
- **Windows and rolling.** A 30-day rolling window is common; align alerting
  math to it.

## Security considerations

- SLO dashboards and budget status can reveal outage timing and system weakness;
  treat externally-visible reliability data with care.
- Do not let SLI metrics carry high-cardinality labels (per-user) that could
  both blow up Prometheus and expose usage patterns.
- Availability metrics can hint at attack impact (a DoS shows as budget burn);
  route sensitive SLO alerts to trusted channels.

## Troubleshooting

- **SLI stuck at 1 or 0:** the query has no data or the label match is wrong
  (`code` values not what you think). Verify with the raw metric.
- **Budget alerts never fire during real incidents:** the windows/multipliers do
  not match your SLO window; recompute the burn thresholds.
- **Alert flaps:** you are alerting on a single short window; use the long+short
  `and` pattern.
- **Budget burns with no user impact:** the SLI counts events users do not care
  about (health checks, retried-then-succeeded); refine "good".

## Common mistakes

- Setting the SLO to 100%, leaving zero budget and blocking all change.
- Alerting on raw error rate or a static threshold instead of burn rate.
- Using one window, so alerts either flap or lag.
- Defining the SLO with no error-budget policy, so nothing changes when it is
  spent.
- Measuring only inside one service and missing user-visible failures upstream.

## Related topics

- [Actionable alerting](actionable-alerting.md)
- [Prometheus and kube-prometheus](prometheus-and-kube-prometheus.md)
- [Distributed tracing with OpenTelemetry](distributed-tracing-opentelemetry.md)
- [Capacity planning](capacity-planning.md)
