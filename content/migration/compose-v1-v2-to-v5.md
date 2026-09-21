---
title: From docker-compose v1/v2 to Compose v5
description: Retire the Python docker-compose, drop the obsolete version key, and adopt profiles, watch and include.
level: intermediate
type: migration
status: current
versions: Docker Compose v5
prerequisites:
  - docker-intermediate/compose-fundamentals
  - docker-intermediate/compose-watch
---

## Overview

There are two migrations hiding under "upgrade Compose", and they are different.
The first is a **tool** change: the standalone Python `docker-compose` (v1) is
long EOL, replaced by the Go `docker compose` plugin. The second is a **file**
change: modern Compose files drop the obsolete top-level `version:` key and gain
`profiles`, `develop.watch` and `include`. This page covers both, using the
before/after pair in `examples/migration/compose-v1-to-v5/`.

The version numbers are deliberately confusing, so be precise: **Compose v5** is
the *engine plugin* version. It jumped from v2 straight to v5 — skipping v3 and
v4 — specifically to stop people confusing the plugin version with the old
compose-*file* schema versions `2.x`/`3.x`. There is no such thing as a "version
5 compose file"; modern files have no version key at all.

## The tool: docker-compose → docker compose

| | `docker-compose` (v1) | `docker compose` (v5) |
|---|---|---|
| Language | Python | Go |
| Invocation | hyphenated binary | a Docker CLI plugin subcommand |
| Status | EOL | current (v5.5.1) |
| Builder | its own | delegated to Docker Bake in v5 |

Every command loses the hyphen:

```bash
docker compose up -d
docker compose up -d --build
docker compose ps
docker compose logs -f api
docker compose down
```

:::legacy The v1 commands, for reference only
```bash
docker-compose up -d
docker-compose build
docker-compose down
```
The hyphenated `docker-compose` is EOL. This handbook's checker rejects it
outside migration and legacy contexts.
:::

## The file: drop `version:`, modernise keys

The obsolete before file, the kind `docker-compose` v1 ran:

```yaml include="examples/migration/compose-v1-to-v5/before.compose.yaml" legacy
```

The cleaned v5 file:

```yaml include="examples/migration/compose-v1-to-v5/after.compose.yaml"
```

What changed and why:

| Before | After | Why |
|---|---|---|
| `version: "3.8"` | *(removed)* | The Compose Specification made it obsolete; Compose warns `the attribute version is obsolete` and ignores it. |
| `links: [db]` | shared network + DNS | Container links are legacy; services reach each other by service name on a common network. |
| `mem_limit: 256m` | `deploy.resources.limits.memory` | The `deploy` block is the spec's home for resource limits. |
| `POSTGRES_PASSWORD: devpassword` | a file `secret` + `..._FILE` | Secrets belong in files, not inline env, even in dev. |
| `depends_on: [db]` | `depends_on: { db: { condition: service_healthy } }` | The list form does not wait for readiness; the condition form does. |

`docker compose config` parses both files here without a build or a run, which is
exactly how to check a migration before touching the daemon.

## The v2 → v5 jump

If you are already on the plugin (v2), the tool migration is done; v5 is an
in-place upgrade with a couple of behavioural notes:

- **v5.0.0 removed the internal builder.** Builds are delegated to **Docker
  Bake** (the same engine as `docker build`). For ordinary `build:` stanzas this
  is transparent; very unusual build setups should test a build once.
- **Compose can be used as an SDK** (functional options, no Docker CLI required)
  — relevant if you embed Compose in other software, not for day-to-day use.
- **No other commands were removed in v5.** Anything else claimed as "removed in
  v5" is unverified; the release notes list only the internal-builder removal.

## Modern replacements worth adopting

Migrating is a good moment to use what the old files could not:

- **`profiles`** — gate optional services (a load generator, an observability
  stack) behind `--profile`, instead of separate override files. The lab uses
  `--profile load` and `--profile observability`.
- **`develop.watch`** — live sync or rebuild on source change
  (`docker compose watch`), replacing manual rebuild loops. See
  [Compose watch](../docker-intermediate/compose-watch.md).
- **top-level `include`** — compose one stack from several files by reference,
  instead of copy-paste or long `-f` chains.
- **`depends_on` conditions** — `service_healthy` and
  `service_completed_successfully`, so startup order actually respects
  readiness and one-shot migrations.

## Common mistakes

- **Keeping `version:`.** It is obsolete and only earns a warning; delete it.
- **Reading "v5" as a file-schema version.** It is the plugin version. Files
  have no version key.
- **Leaving `docker-compose` in scripts and CI.** The Python v1 tool is EOL;
  switch to `docker compose`.
- **Relying on `links:`.** Use networks and service DNS.
- **List-form `depends_on` for a database.** It starts the container but does
  not wait for health; use the condition form.
- **Assuming your build breaks under v5.** The internal builder is gone but
  ordinary `build:` stanzas go through Bake transparently — test once, don't
  rewrite.

## Related topics

- [Compose fundamentals](../docker-intermediate/compose-fundamentals.md)
- [Compose profiles, overrides and env](../docker-intermediate/compose-profiles-overrides-env.md)
- [Compose watch](../docker-intermediate/compose-watch.md)
- [Compose file reference](../reference/compose-file-reference.md)
- [Docker CLI cheat sheet](../reference/docker-cli-cheat-sheet.md)
