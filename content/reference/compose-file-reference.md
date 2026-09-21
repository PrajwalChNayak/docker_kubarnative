---
title: Compose file reference
description: The Compose Specification top-level keys and the common service keys, for Compose v5 - no version key.
level: intermediate
type: reference
status: current
versions: Docker Compose v5
prerequisites:
  - docker-intermediate/compose-fundamentals
---

## Overview

A lookup for the Compose Specification as `docker compose` v5 implements it.
Modern Compose files have **no top-level `version:` key** — it is obsolete and
only earns a warning. Validate any file with `docker compose config`, which
renders the effective document without building or running. The lab file is
`examples/compose/compose.yaml`.

## Top-level keys

| Key | Purpose |
|---|---|
| `name` | project name (namespaces containers, networks, volumes) |
| `services` | the containers and their configuration |
| `networks` | named networks; `internal: true` isolates from the outside |
| `volumes` | named volumes for persistent data |
| `configs` | non-secret files mounted into services |
| `secrets` | secret files mounted at `/run/secrets/<name>` |
| `include` | compose one project from several files by reference |
| `models` | AI model definitions (v5), with `endpoint_var`/`model_var` |

There is no `version:` key. `x-*` keys are custom extension fields, commonly used
with YAML anchors to share config (see `x-app-security` in the lab file).

## Common service keys

| Key | Purpose | Notes |
|---|---|---|
| `image` | image to run | Pin by digest for reproducibility. |
| `build` | `context`, `dockerfile`, `target`, `args` | v5 delegates builds to Bake. |
| `command` / `entrypoint` | override image defaults | |
| `environment` | env vars (map or list) | Never put secrets here. |
| `env_file` | load env from a file | `{path, required}` long form supported. |
| `ports` | publish ports `"host:container"` | Bind locally with `"127.0.0.1:8080:8080"`. |
| `expose` | document container ports | No publish. |
| `volumes` | mounts (named, bind, tmpfs) | |
| `secrets` / `configs` | reference top-level secrets/configs | Mounted as files. |
| `depends_on` | start order | Use the condition form for readiness (below). |
| `healthcheck` | container health probe | `test`, `interval`, `timeout`, `retries`, `start_period`. |
| `restart` | `no`/`always`/`on-failure`/`unless-stopped` | |
| `networks` | attach to named networks | |
| `deploy` | `replicas`, `resources.limits/reservations` | `mem_limit` is legacy; use `deploy.resources`. |
| `develop.watch` | live sync/rebuild | `docker compose watch`. |
| `profiles` | gate optional services | `--profile <name>`. |
| `user` | run as uid:gid | |
| `read_only`, `cap_drop`, `security_opt` | hardening | e.g. `no-new-privileges:true`. |
| `provider`, `gpus`, `post_start`/`pre_stop` | v5 extras | |

## depends_on conditions

```yaml title="depends_on conditions (fragment)" fragment
depends_on:
  db:
    condition: service_healthy
  migrate:
    condition: service_completed_successfully
```

Conditions are `service_started` (default in the list form), `service_healthy`
(needs a healthcheck), and `service_completed_successfully` (a one-shot job).
The bare list form (`depends_on: [db]`) only waits for start, not readiness.

## develop.watch actions

| Action | Effect | Min Compose |
|---|---|---|
| `sync` | copy changed files into the container | |
| `rebuild` | rebuild the image and recreate | |
| `restart` | restart the service | 2.32.0+ |
| `sync+restart` | sync then restart | 2.23.0+ |
| `sync+exec` | sync then run a command | 2.32.0+ |

Attributes: `path`, `action`, `target`, `ignore`, `include`, `initial_sync`,
`exec`.

## Secrets and configs

```yaml title="secrets and configs (fragment)" fragment
services:
  db:
    secrets: [db_password]        # mounted at /run/secrets/db_password
secrets:
  db_password:
    file: ./secrets/db_password.txt
configs:
  prometheus_config:
    file: ./prometheus.yml
```

Secrets are mounted as read-only files under `/run/secrets/`, which is why the
app reads `PGPASSWORD_FILE` rather than a `PGPASSWORD` env var.

## Networks

```yaml title="networks (fragment)" fragment
networks:
  frontend: {}
  backend:
    internal: true    # no route out; the database is only reachable in-cluster
```

## Common mistakes

- **Keeping `version:`.** It is obsolete; delete it.
- **Reading "v5" as a file-schema version.** It is the plugin version; files
  have no version key.
- **Secrets in `environment`.** Use a `secret` file and a `*_FILE` variable.
- **List-form `depends_on` for a database.** It does not wait for health.
- **`mem_limit`/`cpus` at the top of a service.** Use `deploy.resources.limits`.
- **Skipping `docker compose config`** before running — it catches interpolation
  and schema errors offline.

## Related topics

- [Compose fundamentals](../docker-intermediate/compose-fundamentals.md)
- [Compose watch](../docker-intermediate/compose-watch.md)
- [Compose secrets, configs, scaling](../docker-intermediate/compose-secrets-configs-scaling.md)
- [Migrating Compose v1/v2 to v5](../migration/compose-v1-v2-to-v5.md)
