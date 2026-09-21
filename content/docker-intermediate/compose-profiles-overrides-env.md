---
title: Compose profiles, overrides and environment
description: Optional services with profiles, layering files with -f and include, and the exact precedence rules for environment variables.
level: intermediate
type: concept
status: current
versions: Docker Engine 29, Compose v5
prerequisites:
  - docker-intermediate/compose-fundamentals
---

## Overview

One Compose file rarely fits every situation. Three mechanisms adapt it:
**profiles** switch groups of services on and off, **override files** and
**include** layer configuration, and **interpolation plus `env_file`/
`environment`** parameterise values.

They are independent, and mixing them up is the source of most "why is this
variable empty" questions. Interpolation happens when the file is *parsed*;
`environment` and `env_file` set variables *inside the container*.

## Why it exists and when to use it

A stack has a core (the application and its database) and optional pieces (a
load generator, a metrics stack, a debugging proxy). Profiles keep the
optional pieces in the same file without starting them by default.

Overrides exist because environments differ in small ways: exposed ports,
mounted source, log level. Rather than duplicating the file per environment,
you layer a small file on top of the shared one.

## How it works underneath

### Profiles

A service with `profiles: [load]` is ignored unless the `load` profile is
active. Services with no `profiles` attribute are always enabled. Activate
with `--profile load`, repeated flags, or `COMPOSE_PROFILES=load,observability`;
`--profile "*"` enables all of them. Naming a service explicitly on the command
line also activates its profile.

Only *services* are affected; all other top-level elements are always active.
References from an active service to a service excluded by profiles are an
error, not an implicit activation.

### Merging files

Without `-f`, Compose reads `compose.yaml` and then `compose.override.yaml`
from the project directory. With `-f a.yaml -f b.yaml`, later files override
earlier ones.

Merge rules:

- **Mappings** are merged key by key.
- **Sequences** are appended.
- **Single-valued options** (`image`, `command`, `mem_limit`) are replaced.
- `command`, `entrypoint` and `healthcheck.test` are replaced, not appended.
- `ports`, `volumes`, `secrets` and `configs` have uniqueness keys (target
  path, or the `{ip, target, published, protocol}` tuple for ports); entries
  that share a key are merged, others are appended.
- `!reset` removes a value set by an earlier file; `!override` replaces a
  sequence instead of appending to it.

**All relative paths resolve against the first file.** This is the rule that
bites in monorepos, and the documented alternative is the top-level `include`,
where "each path listed in the `include` section is loaded as an individual
Compose application model, with its own project directory".

### Environment variables

Two different things, in order:

**Interpolation** substitutes `${VAR}` in the Compose file itself, with
precedence: shell environment, then `--env-file`, then the project's `.env`.
Modifiers `${VAR:-default}`, `${VAR-default}`, `${VAR:?error}`,
`${VAR:+alt}` and their variants are supported. `docker compose config
--environment` prints what Compose used.

**Container environment** is what the process sees, with precedence from
highest to lowest:

1. `docker compose run -e`
2. `environment` or `env_file` whose *value* was interpolated from the shell
   or an environment file
3. `environment` in the Compose file
4. `env_file` in the Compose file
5. `ENV` in the image

`env_file` accepts a list (later files win for the same key) and mappings with
`path`, `required: false` and `format: raw` (no interpolation of the values).

## Basic example

The load generator only runs when its profile is active:

```yaml include="examples/compose/compose.yaml" lines="130-134"
```

The developer-only override publishes Postgres on loopback:

```yaml include="examples/compose/compose.override.yaml"
```

Non-secret settings come from a file, secrets never do:

```text include="examples/compose/app.env"
```

```yaml include="examples/compose/compose.yaml" lines="63-76"
```

```bash
docker compose -f examples/compose/compose.yaml config --services
docker compose -f examples/compose/compose.yaml --profile load --profile observability config --services
API_PORT=9090 docker compose -f examples/compose/compose.yaml config
```

Services without a profile, and then with both profiles active:

```console include="captures/docker-intermediate/compose-services-default.txt"
```

```console include="captures/docker-intermediate/compose-services-profiles.txt"
```

## Explanation

`loadgen` and `prometheus` carry profiles, so a plain `up` starts four
services. `--profile load` adds the load generator; `COMPOSE_PROFILES=load`
does the same thing from the environment, which is handy in CI.

The override file is picked up automatically when you run `docker compose`
from `examples/compose/` with no `-f`, and ignored when you pass
`-f examples/compose/compose.yaml` explicitly. That asymmetry is deliberate:
scripts and CI name their files, humans get the convenience.

Note what the override does to `networks`: the base file attaches `db` to
`backend` only, the override lists `[backend, frontend]`. Sequences are
appended and duplicates collapse, so the result is both networks — needed
because a port cannot be published from a service that is only on an
`internal` network.

In `api`, `${API_PORT:-8080}:8080` is interpolation: if `API_PORT` is unset,
the file behaves as if you wrote 8080. `env_file` supplies non-secret tunables,
`environment` (from the `x-db-env` anchor) supplies connection settings, and
`environment` wins over `env_file` for any key in both.

## Common patterns

**`compose.yaml` plus `compose.override.yaml` for local development.** The
base file is what CI and servers use; the override is developer sugar.

**Named environment files.** `-f compose.yaml -f compose.ci.yaml` for CI,
`-f compose.yaml -f compose.prod.yaml` for a single-host deployment. Name them
explicitly so nothing is picked up by accident.

**`include` for monorepos.** Each component's Compose file resolves its own
relative paths; the root file includes them.

**Profiles for optional tooling.** `observability`, `load`, `debug`, `tools`.
Keep the default `up` small and fast.

**Mandatory variables.** `${DATABASE_URL:?set DATABASE_URL}` fails the parse
with a useful message instead of starting something broken.

**`.env` for interpolation, `env_file` for the container.** They are different
mechanisms that happen to use the same file format.

**Check the result.** `docker compose config` is the only reliable way to know
what a stack of files and variables produced.

## Production considerations

Precedence rules are subtle enough that you should not rely on memory: make
`docker compose config` part of code review for changes to these files, and
part of the deployment script's dry-run.

`.env` is read from the *project directory*, which is `--project-directory` if
set, otherwise the directory of the first `-f` file, otherwise the current
directory. Running the same command from a different directory can therefore
change the result. In CI, pass `--project-directory` explicitly.

Profiles are a Compose concept with no Kubernetes equivalent; the same
separation there comes from separate manifests, Kustomize overlays or Helm
values. Keeping optional components cleanly separated in Compose makes that
translation mechanical.

## Security considerations

- Secrets do not belong in `environment`, in `env_file` or in `.env`. All
  three end up in `docker inspect`, in `docker compose config` output and in
  the process environment, which any code in the container can read. Use
  `secrets`.
- `docker compose config` resolves interpolation, so its output contains
  whatever was in `.env`. Treat it as sensitive.
- Committing `.env` is the classic leak. Ignore it in git, and remember that
  an override file with credentials is just as bad.
- An override that adds `privileged: true`, mounts the Docker socket or
  publishes a database to `0.0.0.0` is easy to write and easy to forget. Keep
  overrides small and reviewed.
- `format: raw` env files skip interpolation, which is the right choice for
  values containing `$`, and a reminder that the parser would otherwise treat
  them as variables.

## Troubleshooting

**A variable is empty in the container.** Decide which mechanism you meant.
`docker compose config` shows interpolation results; `docker compose exec
<svc> env` shows the container's environment.

**`WARN[0000] The "FOO" variable is not set. Defaulting to a blank string.`**
Interpolation found no value. Provide one, or use `${FOO:-default}`.

**An override file is ignored.** You passed `-f`, which disables the automatic
`compose.override.yaml` pickup; or the file is not in the project directory.

**A relative path in an override points at the wrong place.** Paths resolve
against the first `-f` file. Use `include`.

**A service is missing from `up`.** Its profile is not active.

**A list in an override was appended instead of replacing.** That is the merge
rule. Use `!override`, or `!reset` to clear it first.

**`.env` values differ between machines.** Someone has the variable exported in
their shell, which takes precedence over `.env`.

## Common mistakes

- Confusing `.env` (interpolation) with `env_file` (container environment).
- Putting secrets in `environment` because it is convenient.
- Expecting `-f` to keep loading `compose.override.yaml`.
- Relying on paths being relative to the override file.
- Forgetting that `command` and `entrypoint` are replaced, not merged, so a
  partial override wipes the base value.
- Adding a `profiles:` attribute to a service that others depend on, which
  turns into a parse error rather than a silent activation.
- Reviewing the source files instead of `docker compose config`.

## Related topics

- [Compose fundamentals](compose-fundamentals.md)
- [Compose secrets, configs and scaling](compose-secrets-configs-scaling.md)
- [Compose watch](compose-watch.md)
- [Environment variables](../docker-beginner/environment-variables.md)
- [Tasklane with Compose](tasklane-with-compose.md)
- [Kustomize](../k8s-advanced/kustomize.md)
