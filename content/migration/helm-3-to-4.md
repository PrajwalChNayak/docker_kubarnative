---
title: Upgrading from Helm 3 to Helm 4
description: The breaking changes from Helm 3 to Helm 4 - server-side apply, wait strategies, flag renames - with each claim checked against the 4.3.0 CLI.
level: intermediate
type: migration
status: current
versions: Helm 4.3.0
prerequisites:
  - k8s-advanced/helm
  - k8s-advanced/helm-chart-development
---

## Overview

Helm 4.0.0 shipped 2025-11-12; 4.3.0 is current (2026-09-09). The upgrade is
mostly painless — your charts keep working — but a handful of flags were renamed
and the default apply method changed, so CI pipelines and scripts need edits.
This page lists the breaking changes, and, because several flag removals were
only *reported* in secondary sources, it marks each one as **verified against
`helm <cmd> --help` on the 4.3.0 binary** or not. Helm 3 is now end of life:
bug fixes ended 2026-09-09, security fixes end 2027-02-10.

## Chart compatibility: mostly fine

- **Chart `apiVersion: v2` still works.** Your existing charts install unchanged.
- **Chart API v3 is experimental**, behind `HELM_EXPERIMENTAL_CHART_V3=1`. Do
  not adopt it for production charts yet.
- The Go SDK moved to `helm.sh/helm/v4` (packages `pkg/chart/v2`,
  `pkg/release/v1`).

## Server-side apply is the new default

The biggest behavioural change. On a **new install**, Helm 4 uses server-side
apply (SSA). The `--server-side` flag defaults to `auto`:

| Situation | Apply method |
|---|---|
| Fresh install under Helm 4 | server-side (`auto` resolves to SSA) |
| Upgrade/rollback of a release first created by Helm 3 | keeps the previous client-side method |
| Force through field-manager conflicts | add `--force-conflicts` |

Because upgrades preserve the original method, a Helm 3 release stays
client-side until you deliberately move it. Watch for field-manager conflicts on
resources also touched by other controllers; that is what `--force-conflicts`
is for.

## Wait became a strategy

`--wait` is no longer a boolean. It is a `WaitStrategy`:

| Form | Meaning |
|---|---|
| flag omitted | `hookOnly` (wait only for hooks) |
| `--wait` (bare) | `watcher` (kstatus-based readiness watch) |
| `--wait=watcher` | explicit kstatus watch |
| `--wait=legacy` | the Helm 3 polling behaviour |
| `--wait=hookOnly` | hooks only |

If a pipeline relied on bare `--wait` meaning "wait for everything", it still
does — bare `--wait` is `watcher`. If it relied on the *old polling algorithm*
specifically, pin `--wait=legacy`.

## Flag renames (verified against `helm upgrade --help`, 4.3.0)

| Helm 3 | Helm 4 | Notes |
|---|---|---|
| `--atomic` | `--rollback-on-failure` | Setting it defaults `--wait` to `watcher`. |
| `--force` | `--force-replace` | Update by delete + recreate. |
| `--post-renderer <exe path>` | `--post-renderer <plugin name>` (+ `--post-renderer-args`) | Post-renderers are plugins now; a raw executable path is no longer accepted. |
| `--dry-run` (bool) | `--dry-run <none\|client\|server>` | Bare `--dry-run` is still client-side. |

:::warning A research claim that did not hold
Secondary notes said `--atomic` was "restored on install as a deprecated alias".
On the 4.3.0 binary it is **not** accepted on `install` or `upgrade` —
`--atomic` errors as an unknown flag. Use `--rollback-on-failure`.
:::

## Command changes (each checked against the 4.3.0 CLI)

These were reported as removals in the Helm 4 changelog summary and flagged
UNVERIFIED in this handbook's research. Running the 4.3.0 binary confirms every
one:

| Helm 3 usage | Helm 4.3.0 result | How it was checked |
|---|---|---|
| `helm version --client` | `Error: unknown flag: --client` | ran the command |
| `helm repo add --no-update` | flag gone; use `--force-update` | `helm repo add --help` |
| `helm status --show-desc` / `--show-resources` | flags gone | `helm status --help` |
| `helm lint` with no path | a `PATH` argument is now required | `helm lint --help` → `Usage: helm lint PATH [flags]` |
| `helm template --hide-notes` / `--render-subchart-notes` | flags gone | `helm template --help` |
| `helm registry login <url>` | accepts a host only | `Usage: helm registry login [host] [flags]` |

Anything not on the two tables above, and not in the rename table, was **not**
verified here — check it against `helm <cmd> --help` on your own 4.x before you
rely on it.

## OCI and other niceties

- Install an OCI chart by digest: `helm install rel oci://REG/REPO@sha256:...`.
- `helm registry login` takes a domain, not a URL (see above).
- Reproducible chart archives honour `SOURCE_DATE_EPOCH`.
- `helm uninstall` now runs an ownership check before deleting resources.

## Migration checklist

1. Install Helm 4 alongside Helm 3 if you can, and test in a throwaway
   namespace.
2. Grep your CI for `--atomic`, `--force`, `--wait`, `--post-renderer`,
   `version --client`, `repo add --no-update`, and the removed `status`/
   `template` flags. Replace per the tables above.
3. Decide your wait strategy explicitly (`watcher` vs `legacy`) rather than
   relying on the changed default.
4. Expect SSA on new installs; add `--force-conflicts` where controllers
   co-own fields.
5. Keep charts on `apiVersion: v2`; leave chart API v3 alone.
6. Note the Helm 3 EOL dates and plan the cutover before 2027-02-10.

## Common mistakes

- **Leaving `--atomic` in scripts.** It is an unknown flag in 4.3.0; use
  `--rollback-on-failure`.
- **Assuming `--wait` still means the old algorithm.** Bare `--wait` is now
  `watcher` (kstatus); pin `--wait=legacy` for the Helm 3 behaviour.
- **Passing an executable to `--post-renderer`.** It takes a plugin name now.
- **Ignoring SSA field-manager conflicts** on new installs instead of adding
  `--force-conflicts` deliberately.
- **Adopting chart API v3** because it exists; it is experimental.
- **Trusting a changelog summary over the CLI.** Verify each flag against
  `helm <cmd> --help`.

## Related topics

- [Helm](../k8s-advanced/helm.md)
- [Helm chart development](../k8s-advanced/helm-chart-development.md)
- [Helm versus Kustomize](../k8s-advanced/helm-vs-kustomize.md)
- [Version matrix](../reference/version-matrix.md)
