---
title: Actionable alerting
description: Symptom-based alerts, Alertmanager routing, grouping, inhibition and silences, and how to avoid alert fatigue.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37, Prometheus 3.14
prerequisites:
  - operations/prometheus-and-kube-prometheus
---

## Overview

An alert is a promise: when it fires, a human is expected to do something. An
alert that fires and needs no action is noise, and enough noise trains people to
ignore the pager. This page covers **actionable** alerting — firing on symptoms
users feel, routing them with **Alertmanager**, and controlling volume with
grouping, inhibition and silences so the signal survives.

## Why it exists and when to use it

Dashboards are pull: someone has to look. Alerting is push: the system tells you
when to look. You need it because nobody watches graphs at 03:00.

The discipline is to alert on **symptoms, not causes**. "Backlog rising and not
draining" is a symptom a user feels; "worker pod CPU at 80%" is a cause that may
or may not matter. Cause-based alerts multiply (there are endless causes) and
fire when nothing is actually wrong. Symptom-based alerts map to SLOs and stay
few. Use cause metrics for *diagnosis* on the dashboard, not for paging.

## How it works underneath

Prometheus evaluates alerting rules on each group interval. A rule has an `expr`,
an optional `for` duration, `labels` and `annotations`. When `expr` is true for
at least `for`, the alert becomes **firing** and Prometheus pushes it to
**Alertmanager**. The `for` clause is what stops a one-scrape blip from paging
you.

**Alertmanager** owns everything after firing:

1. **Grouping** — it batches alerts that share a set of labels (for example all
   alerts for one service/cluster) into a single notification, so a node failure
   that trips 40 pods sends one page, not 40.
2. **Routing** — a routing tree matches alert labels to receivers (PagerDuty,
   Slack, email), so `severity: critical` pages and `severity: warning` goes to
   a channel.
3. **Inhibition** — a firing alert can suppress others. If a whole cluster is
   down, inhibit the per-service alerts it would obviously cause.
4. **Silences** — a time-boxed mute matching labels, used during maintenance so
   planned work does not page.
5. **Repeat/resolve** — it re-sends unacknowledged alerts on `repeat_interval`
   and sends a resolved notification when the alert clears.

The Prometheus Operator models the Prometheus-side rules as `PrometheusRule`
CRDs and the Alertmanager config as an `Alertmanager` + `AlertmanagerConfig`.

## Basic example

Tasklane's actionable alerts fire on the two symptoms that matter — the backlog
not draining, and workers erroring — each with a `for` window and a runbook:

```yaml include="examples/observability/prometheusrule-tasklane.yaml" lines="29-60"
```

`TasklaneTasksBacklogHigh` uses `max(tasklane_tasks_pending) > 50` held for
`10m`: a brief spike during a burst of task creation is normal and self-heals,
so the `for` window keeps it from paging. `TasklaneWorkerErrors` fires on any
sustained worker error rate, because errors mean tasks are not being processed.

## Explanation

Two design choices make these actionable. First, the **threshold plus `for`**:
`> 50` alone would flap; ten minutes of sustained backlog means workers are
genuinely behind, not momentarily busy. Second, the **runbook_url annotation**:
the responder lands on a page that says what to check (worker replicas, worker
errors, database health), turning a page into a procedure instead of a puzzle.

The `severity` and `team` labels are what Alertmanager routes on. `severity:
warning` here would go to a channel, not a phone; a true user-facing outage
would be `severity: critical` and page. Choosing severity honestly is half of
avoiding fatigue.

## Common patterns

- **Symptom + runbook + severity.** Every paging alert names a symptom, links a
  runbook, and carries a severity the routing tree understands.
- **Multi-window burn-rate alerts** for SLOs (covered on the
  [SLOs page](slos-and-error-budgets.md)): fast-burn pages, slow-burn tickets.
- **Grouping by service and cluster** so correlated failures collapse into one
  notification.
- **Inhibition of downstream alerts** when an upstream/global alert fires (a
  cluster-down alert inhibits its per-pod children).
- **Dead-man's switch.** A rule that *always* fires (`Watchdog`) routed to a
  monitor that pages if it ever *stops* — this catches "the whole alerting
  pipeline is broken and that's why it's quiet".

## Production considerations

- **Fewer, better alerts.** Track alert volume as a metric. If an alert fires
  often and nobody acts, delete or downgrade it.
- **HA Alertmanager.** Run a cluster of ≥3 Alertmanagers; they gossip to
  deduplicate so a replica loss does not double-page or drop notifications.
- **Route to the right severity channel.** Warnings must not page; criticals
  must. Mis-severity is the fastest route to fatigue.
- **Test the pipeline.** Fire a synthetic alert end to end periodically; a
  Watchdog/dead-man's switch makes silence trustworthy.
- **Runbooks are part of the alert.** An alert without a runbook is half-built.

## Security considerations

- Alertmanager receiver config holds credentials (PagerDuty keys, Slack webhook
  URLs, SMTP passwords). Store them in Secrets, not in the CRD body.
- Anyone who can create `PrometheusRule`/`AlertmanagerConfig` objects can
  suppress alerts (a silence-like route) or spam receivers; restrict it in
  shared clusters.
- Alert annotations can leak internal detail into third-party notifiers (Slack,
  email). Keep sensitive values out of `description`.
- Protect the Alertmanager UI — its silence feature can mute real incidents.

## Troubleshooting

- **Alert firing in Prometheus but no notification:** the routing tree has no
  matching receiver, or Alertmanager cannot reach the notifier. Check
  Alertmanager status and logs.
- **Flapping alerts:** add or lengthen `for`, or widen the threshold; the
  underlying signal is noisy.
- **Alert storms on one failure:** add grouping and inhibition so correlated
  alerts collapse.
- **Silence not working:** silence matchers must match the alert's labels
  exactly (including regex anchoring).
- **Suspicious silence — no alerts at all:** verify the Watchdog is being
  received; the pipeline may be down.

## Common mistakes

- Alerting on causes (CPU, memory, restart counts) instead of user symptoms,
  producing a pager nobody trusts.
- Omitting `for`, so every blip pages.
- No runbook, so each page is solved from scratch.
- Everything at `critical`, so nothing is.
- No dead-man's switch, so a broken alerting pipeline looks like calm.

## Related topics

- [SLOs and error budgets](slos-and-error-budgets.md)
- [Prometheus and kube-prometheus](prometheus-and-kube-prometheus.md)
- [Grafana dashboards](grafana-dashboards.md)
- [Kubernetes events](kubernetes-events.md)
