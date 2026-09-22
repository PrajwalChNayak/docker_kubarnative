# Helm 3 -> 4 command & flag cheatsheet

Helm 4.3.0 (2026-09-09). Every row below was checked against
`helm <cmd> --help` on the 4.3.0 binary in `.tools/helm.exe`. Where Helm 3 and
Helm 4 spellings differ, use the Helm 4 spelling.

## Flag renames (verified against `helm upgrade --help` on 4.3.0)

| Helm 3 | Helm 4 | Notes |
|---|---|---|
| `--atomic` | `--rollback-on-failure` | Setting it defaults `--wait` to `watcher`. `--atomic` is **not** accepted on install or upgrade in 4.3.0. |
| `--force` | `--force-replace` | Forces updates by delete+recreate. |
| `--wait` (boolean) | `--wait` (WaitStrategy: `watcher` \| `hookOnly` \| `legacy`) | Omitting the flag = `hookOnly`. Bare `--wait` = `watcher`. `legacy` is the Helm 3 behaviour. |
| `--dry-run` (boolean) | `--dry-run` (string: `none` \| `client` \| `server`) | Bare `--dry-run` still means client-side. |
| `--post-renderer <path-to-exe>` | `--post-renderer <plugin-name>` (+ `--post-renderer-args`) | Post-renderers are plugins now; an executable path is no longer accepted. |

## Server-side apply (new default)

| Behaviour | Helm 4 |
|---|---|
| New installs | Server-side apply, `--server-side` defaults to `auto` (uses SSA for a fresh release). |
| Upgrades/rollbacks of a release first created by Helm 3 | Keep the release's previous (client-side) method. |
| Force through field-manager conflicts | `--force-conflicts` |

## Commands removed or changed in 4.3.0 (verified against `--help`)

| Helm 3 | In Helm 4.3.0 | Verification |
|---|---|---|
| `helm version --client` | `--client` flag removed | `helm version --client` -> `Error: unknown flag: --client` |
| `helm repo add --no-update` | flag removed; use `--force-update` to overwrite | `helm repo add --help` lists only `--force-update` |
| `helm status --show-desc` / `--show-resources` | flags removed | not present in `helm status --help` |
| `helm lint` (implicit current dir) | a `PATH` argument is required | `helm lint --help` shows `Usage: helm lint PATH [flags]` |
| `helm template --hide-notes` / `--render-subchart-notes` | removed | not present in `helm template --help` |
| `helm registry login <url>` | accepts a host only | `Usage: helm registry login [host] [flags]` |

## Charts and OCI

- Chart `apiVersion: v2` still works. Chart API **v3 is experimental**
  (`HELM_EXPERIMENTAL_CHART_V3=1`).
- Install an OCI chart by digest: `helm install rel oci://REG/REPO@sha256:...`.
- Go SDK import path is `helm.sh/helm/v4` (`pkg/chart/v2`, `pkg/release/v1`).

## End of life

- Helm 3 bug fixes ended at the final feature release, **2026-09-09** (v3.22.0).
- Helm 3 security fixes end **2027-02-10**.
