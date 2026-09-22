---
title: Deprecated API detection
description: Find deprecated and soon-to-be-removed API usage before an upgrade with Pluto, the apiserver metric and audit logs.
level: advanced
type: tutorial
status: current
versions: Kubernetes 1.37, Pluto 5.24
prerequisites:
  - operations/version-skew-policy
  - k8s-beginner/manifest-anatomy
---

## Overview

An upgrade breaks when a manifest or controller calls an API version the new
minor has **removed**. The fix is to find every deprecated call *before*
upgrading and migrate it. This tutorial shows the three complementary
techniques: scanning manifests and live objects with **Pluto**, watching the
apiserver's own `apiserver_requested_deprecated_apis` metric, and using the
**audit log** to catch callers nothing else sees.

:::note Nothing was removed in 1.33–1.37
No API versions were removed in Kubernetes 1.33 through 1.37 — the last removal
was the `flowcontrol.apiserver.k8s.io` v1beta3 FlowSchema and
PriorityLevelConfiguration in **1.32**. So on today's supported
minors these scans should come back clean. The point is to build the habit and
the tooling now, so the minor that *does* remove an API (there will be one)
finds you ready.
:::

## Deprecated vs removed

- **Deprecated** — still served, but marked for future removal; the apiserver
  returns a warning. Your manifests keep working *today*.
- **Removed** — no longer served; requests fail. This is what breaks an upgrade.

GA APIs cannot be removed within a major version; beta APIs are supported for 3
releases after deprecation; alpha APIs can vanish anytime. The
[removed-api-versions](../migration/removed-api-versions.md) migration page lists
the full history.

## Step 1 — Scan manifests on disk with Pluto

Use **Pluto** (v5.24.4). Do **not** use kubent (kube-no-trouble): its last
release was 2024 and it is effectively unmaintained. Scan a directory of YAML
before it ever reaches the cluster — perfect for CI:

```bash
pluto detect-files -d examples/
```

```console include="captures/operations/ops-pluto-files.txt"
```

Pluto knows each API's deprecation and removal version and flags anything
deprecated or removed for your target Kubernetes version. Wire this into CI so a
pull request that adds a deprecated API fails the build.

## Step 2 — Scan what is actually live

Manifests on disk are not the whole story — Helm charts, operators and CI apply
objects too. Pipe live objects through Pluto:

```bash
kubectl get deployments,daemonsets,statefulsets,ingresses,networkpolicies,poddisruptionbudgets \
  -A -o yaml | pluto detect -
```

`pluto detect -` reads a manifest stream on stdin, so `kubectl get -o yaml`
piped in scans exactly what is stored in the cluster.

## Step 3 — Watch the apiserver's deprecation metric

The most reliable signal is the apiserver telling you what is calling deprecated
APIs right now. `apiserver_requested_deprecated_apis` is a gauge with one series
per deprecated group/version/resource that has been requested — any non-zero
series names an API something is still using:

```bash
kubectl get --raw /metrics | grep apiserver_requested_deprecated_apis
```

```console include="captures/operations/ops-deprecated-apis-metric.txt"
```

This catches the caller that static scans miss — a controller or script hitting
a deprecated endpoint even though no stored object uses it. Alert on it so a new
deprecated caller is noticed the day it appears, not the day you upgrade.

## Step 4 — Use the audit log for the caller identity

The metric says *which* API; the **audit log** says *who*. Enable an audit
policy that logs requests to deprecated groups, and the log's `user` and
`userAgent` fields identify the offending client (a controller, a CI robot, a
person). See [audit logging](../k8s-security/audit-logging.md). This is how you
find the exact workload to fix when the metric flags a deprecated call.

## Putting it in the pipeline

- **CI gate:** `pluto detect-files` on every change; fail on deprecated/removed.
- **Cluster monitor:** alert on any non-zero `apiserver_requested_deprecated_apis`.
- **Pre-upgrade:** `pluto detect -` over live objects + review the metric +
  audit-log the callers, then migrate before the upgrade.

## Common mistakes

- Scanning only files and missing runtime callers (operators, CI, scripts) that
  the metric and audit log would catch.
- Using **kubent**, which is unmaintained; use Pluto.
- Treating a *deprecation warning* as an emergency — deprecated APIs still work;
  removed ones do not. Know which minor removes each.
- Upgrading first and scanning after, when the whole value is scanning **before**.
- Ignoring `apiserver_requested_deprecated_apis` because "our manifests are
  clean" — the caller may not be in your manifests.

## Related topics

- [Version skew policy](version-skew-policy.md)
- [Cluster upgrades](cluster-upgrades.md)
- [Removed API versions](../migration/removed-api-versions.md)
- [Audit logging](../k8s-security/audit-logging.md)
