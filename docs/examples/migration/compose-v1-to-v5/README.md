# compose-v1-to-v5

A before/after pair for modernising an old Compose file.

| File | Role |
|---|---|
| `before.compose.yaml` | BEFORE: old-style file with a top-level `version:`, container `links:`, `mem_limit:`, an inline password, and a conditionless `depends_on`. Shown with the legacy `docker-compose` (v1) commands. |
| `after.compose.yaml` | AFTER: Compose v5 - no `version:`, DNS instead of links, a file secret, `deploy.resources.limits`, a healthcheck condition, and `develop.watch`. |
| `db_password.txt` | Dev-only secret value used by the after file. Never a real credential. |

## Command mapping (Compose v1 -> v5 plugin)

| Legacy (`docker-compose`, v1, hyphen) | Modern (`docker compose`, v5 plugin) |
|---|---|
| `docker-compose up -d` | `docker compose up -d` |
| `docker-compose build` | `docker compose build` (build is delegated to Bake in v5) |
| `docker-compose up -d --build` | `docker compose up -d --build` |
| `docker-compose ps` / `logs -f` / `down` | `docker compose ps` / `logs -f` / `down` |
| (no equivalent) | `docker compose watch` - live sync/rebuild |

## Validate locally (parse only, no build, no run)

```bash
docker compose -f examples/migration/compose-v1-to-v5/before.compose.yaml config
docker compose -f examples/migration/compose-v1-to-v5/after.compose.yaml config
```

The before file emits `the attribute version is obsolete` and still parses.
The full narrative is in `content/migration/compose-v1-v2-to-v5.md`.
