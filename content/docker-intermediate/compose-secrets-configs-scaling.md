---
title: Compose secrets, configs and scaling
description: Mount credentials as files instead of environment variables, ship configuration without baking it in, and run several replicas of a service on one host.
level: intermediate
type: concept
status: current
versions: Docker Engine 29, Compose v5
prerequisites:
  - docker-intermediate/compose-fundamentals
  - docker-intermediate/compose-profiles-overrides-env
---

## Overview

Three Compose features that look small and change how a stack behaves:

- **`secrets`** mount sensitive files into containers, by default at
  `/run/secrets/<name>`.
- **`configs`** do the same for non-sensitive files, so configuration is not
  baked into an image.
- **`deploy.replicas` / `--scale`** run several containers for one service on
  the host.

All three have Kubernetes analogues (Secret, ConfigMap, replicas), which makes
them a good place to build habits.

## Why it exists and when to use it

Environment variables are the default way to configure containers and the
worst way to pass credentials: they are visible in `docker inspect`, in
`docker compose config`, in `/proc/<pid>/environ`, and they are inherited by
every child process. Compose secrets replace that with a file whose path you
control.

Configs solve the other half: a config file that lives in the image forces a
rebuild for every change and makes the image environment-specific.

Replicas answer "can I run three workers" locally, which is how you discover
that your worker is not safe to run concurrently before production does.

## How it works underneath

**Secrets.** A top-level `secrets` block defines sources: `file:` (contents of
a path) or `environment:` (the value of a host environment variable,
Compose-only, not supported by `docker stack deploy`). A service must then
list the secret explicitly — defining it grants nothing. Short syntax mounts
it read-only at `/run/secrets/<name>`; long syntax adds `source`, `target`
(a filename or an absolute path), `uid`, `gid` and `mode` (default `0444`).

One caveat straight from the documentation: `uid`, `gid` and `mode` are only
implemented when the source is `environment`. With a `file` source, Compose
uses a bind mount, which cannot remap ownership, and those attributes are
silently ignored.

**Configs.** The same model for non-secret content: a top-level `configs`
block with `file:` or `content:`, referenced per service, mounted at
`/<name>` by default or at an explicit `target`.

**Replicas.** `deploy.replicas: N` (or `--scale service=N` at run time, or the
service-level `scale` attribute) starts N containers named
`<project>-<service>-<n>`. They share the service's DNS name: Docker's
embedded DNS returns one address per replica. A replicated service cannot have
`container_name` or a fixed published host port — both are unique per
container.

## Basic example

The database password exists once, as a file, and is mounted into every
service that needs it:

```yaml include="examples/compose/compose.yaml" lines="173-179"
```

```yaml include="examples/compose/compose.yaml" lines="28-34"
```

The application reads a path, never a value:

```yaml include="examples/compose/compose.yaml" lines="19-25"
```

Prometheus gets its configuration as a config, not baked into an image:

```yaml include="examples/compose/compose.yaml" lines="152-161"
```

```yaml include="examples/compose/prometheus.yml"
```

The worker runs two replicas:

```yaml include="examples/compose/compose.yaml" lines="115-116"
```

```bash
docker compose -f examples/compose/compose.yaml up -d --wait
docker compose -f examples/compose/compose.yaml up -d --scale worker=3
docker compose -f examples/compose/compose.yaml ps
```

```console include="captures/docker-intermediate/compose-scale-worker.txt"
```

## Explanation

`PGPASSWORD_FILE: /run/secrets/db_password` is the whole point: the value is
never in the environment, so it cannot appear in `docker inspect` output or in
a crash dump of the environment block. Postgres supports the same convention
with `POSTGRES_PASSWORD_FILE`, and many images do — check before falling back
to a plain variable.

The secret's source is `./secrets/db_password.txt`, which is a development
value committed to the repository on purpose, with a comment saying so. In any
real environment the file comes from outside the repository: a mounted volume,
a CI-provisioned file, or a secrets manager that writes it before `up`.

Prometheus's config arrives as a `config` targeted at
`/etc/prometheus/prometheus.yml`. Editing `prometheus.yml` and recreating the
container is enough; no image is rebuilt.

`deploy.replicas: 2` on the worker is meaningful because the worker claims
tasks with `FOR UPDATE SKIP LOCKED`, so two replicas never process the same
row. Running replicas locally is how you find out whether that is true.

Prometheus discovers those replicas through Compose's DNS:

```yaml include="examples/compose/prometheus.yml" lines="6-13"
```

## Common patterns

**File-based credentials everywhere.** `*_FILE` environment variables pointing
into `/run/secrets/`. Supported by Postgres, MySQL, MariaDB and many
application images; trivial to implement in your own code.

**`environment:` source for CI.** `secrets: {token: {environment: "CI_TOKEN"}}`
takes the value from the runner's environment and presents it to the container
as a file, so the variable does not leak into the container.

**External secret material.** Generate or fetch the file before `up`, keep it
out of git, and mount it read-only.

**`configs` with inline `content:`** for a two-line config, and `file:` for
anything bigger.

**Scale the stateless tier.** `--scale worker=4`. Never scale a service with a
fixed published port or a `container_name`.

**Prove concurrency safety locally.** If two replicas duplicate work locally,
they will duplicate it in production too.

## Production considerations

Compose secrets are files on the host, mounted into containers. They are not
encrypted at rest, not versioned, not rotated and not audited. That is
acceptable for a development stack and thin for anything else; in Kubernetes
the equivalent is a Secret (base64, not encrypted, unless you enable encryption
at rest) plus External Secrets or Sealed Secrets for the actual management.

Scaling on one host has hard limits: no rescheduling if the host dies, no
spread across failure domains, no rolling update with health gating. When you
need those, the answer is an orchestrator, not more replicas.

Replicas share the host's CPU and memory. Set `deploy.resources.limits` per
service — the Tasklane stack does — or one runaway replica starves the rest.

Published ports and replicas do not mix. Put a reverse proxy in front, or let
the orchestrator's Service do the load balancing.

## Security considerations

- A secret is mounted into the container rather than copied into it, so the
  value is not in the image and not in the container's writable layer. With a
  `file` source Compose implements that as a bind mount from the host path,
  which is also why ownership cannot be remapped. It *is* readable by the
  container's user and by anyone who can `docker exec` in.
- Default mode `0444` means world-readable inside the container. With a
  `file` source you cannot change that through Compose (`mode` is ignored), so
  if a stricter mode matters, control the ownership of the source file and the
  container user instead.
- A secret defined in the top-level block but not listed by a service is not
  mounted anywhere. Grant explicitly, per service — that is the whole design.
- Never pass credentials as build arguments: they end up in `docker history`
  and in provenance attestations.
- Committing a development secret is fine only if it is obviously a
  development secret, is documented as such, and grants nothing. Anything else
  belongs outside the repository and in `.gitignore`.
- Configs are world-readable inside the container as well. If a "config" holds
  a token, it is a secret.

## Troubleshooting

**"service refers to undefined secret".** The secret is not defined at the top
level, or the name is misspelled.

**The application cannot read the secret.** Check the path and permissions
inside the container:

```bash
docker compose -f examples/compose/compose.yaml exec db ls -l /run/secrets
```

**`mode`, `uid` or `gid` had no effect.** Expected for `file`-sourced secrets.

**`--scale` fails with a port conflict.** A published host port cannot be
shared by replicas. Remove the mapping or use a proxy.

**`--scale` is ignored.** `deploy.replicas` is set and conflicts with the
`scale` attribute; keep one source of truth.

**Only one replica does any work.** The work queue is not safe for concurrent
consumers, or they are all polling the same locked row. That is an application
problem — and the reason to test it locally.

**A config change does nothing.** The container mounts the file at start.
Recreate the service (`up -d --force-recreate <svc>`), or use a
`sync+restart` watch rule.

## Common mistakes

- Using `environment` for passwords because it is one line shorter.
- Defining a secret and forgetting to grant it to the service.
- Expecting `mode: 0400` to work with a `file` source.
- Committing a real credential in `secrets/`.
- Scaling a service that has `container_name` or a fixed published port.
- Treating `deploy.replicas` as high availability. One host, one failure
  domain.
- Putting an API token in `configs` instead of `secrets`.

## Related topics

- [Compose fundamentals](compose-fundamentals.md)
- [Compose profiles, overrides and environment](compose-profiles-overrides-env.md)
- [Tasklane with Compose](tasklane-with-compose.md)
- [Secrets in images](../docker-security/secrets-in-images.md)
- [Secrets (Kubernetes)](../k8s-beginner/secrets.md)
- [Secrets management](../k8s-security/secrets-management.md)
