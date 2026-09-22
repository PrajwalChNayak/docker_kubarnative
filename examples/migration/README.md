# Migration before/after artifacts

Each directory holds a "before" (legacy) and "after" (current) pair, referenced
by the [Part M: Migration](../../content/migration) pages. Old manifests here
carry the `legacy` code-block attribute so the validator's bans do not fire on
them.

| Directory | Migration |
|---|---|
| [`ingress-to-gateway/`](ingress-to-gateway) | A legacy Ingress and the equivalent Gateway + HTTPRoute, with a field-by-field mapping. |
| [`helm3-to-4/`](helm3-to-4) | Helm 3 → Helm 4 command and flag changes. |
| [`compose-v1-to-v5/`](compose-v1-to-v5) | An obsolete `version:`-keyed v1 file and the cleaned Compose v5 form. |
| [`removed-apis/`](removed-apis) | Deliberately old API versions plus the Pluto command that detects them. |

Each subdirectory has its own README with the exact commands. The removed-apis
fixtures are intentionally invalid for 1.37 — that is the point, so the
detection tooling has something to find.
