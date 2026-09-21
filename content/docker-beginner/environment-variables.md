---
title: Environment variables
description: How -e, --env-file and image ENV combine, why environment variables are the standard container configuration channel, and why secrets do not belong in them.
level: beginner
type: concept
status: current
versions: Docker Engine 29
prerequisites:
  - docker-beginner/running-containers
---

## Overview

An image is immutable, but the same image must run against a development
database on a laptop and a production one in a cluster. Environment variables
are the configuration channel that every platform supports identically: the
daemon puts them in the process's environment at `execve` time, and the
program reads them with `getenv`.

The Tasklane binaries are written this way on purpose. `store.Open` passes an
empty connection string to pgx, which then reads the standard libpq variables
(`PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`, `PGSSLMODE`). Nothing in the
image knows whether it is running under `docker run`, Compose or Kubernetes.

## Why it exists and when to use it

Environment variables are the lowest common denominator of process
configuration: no file format, no parser, no path to mount, available in every
language. That is the whole appeal, and the reason the twelve-factor style
settled on them.

Use them for anything non-secret that differs between environments:
hostnames, ports, feature flags, log levels, timeouts. Use a **file** for
anything secret, and for anything large or structured — a certificate, a full
configuration document, a list. Files can be mounted read-only, can have
permissions, and do not appear in `docker inspect`.

## How it works underneath

The environment of the container's PID 1 is assembled by the daemon from, in
increasing precedence:

1. `ENV` instructions baked into the image (visible with
   `docker image inspect --format '{{json .Config.Env}}'`).
2. `--env-file` files, read by the **CLI** on the host, one `KEY=value` per
   line.
3. `-e KEY=value` flags, and `-e KEY` alone, which copies `KEY` from your
   current shell.

The result is stored in the container's `Config.Env` and passed to the process
at exec. Three consequences follow directly:

- **They are fixed for the container's lifetime.** There is no way to change a
  variable in a running container; you create a new one. `docker restart`
  reuses the old values.
- **They are inherited.** Any child process, any `docker exec`, any crash
  handler that dumps the environment sees them.
- **They are plainly visible** to anyone who can query the daemon, forever,
  because `Config.Env` is part of the container record.

`--env-file` parsing happens client-side and is deliberately dumb: no shell
expansion, no quotes stripped in the way a shell would, `#` comments and blank
lines ignored. `KEY` with no `=` takes the value from your environment.

## Basic example

```bash
docker run --rm -e GREETING=hello -e PGHOST=tasklane-db alpine:3.22 env
```

```console include="captures/docker-beginner/env-print.txt"
```

The same values from a file — this is the real Tasklane settings file, shared
by the API and the worker in every stage:

```ini include="examples/compose/app.env"
```

```bash
docker run --rm --env-file examples/compose/app.env alpine:3.22 env
```

```console include="captures/docker-beginner/env-file.txt"
```

Note what is in that file and what is not: timings and durations, no
credentials.

## Explanation

**Precedence, concretely.** `-e` beats `--env-file`, which beats image `ENV`.
When two `--env-file` files set the same key, the later file wins. When the
same `-e` appears twice, the last one wins. There is no merging of values.

**`-e VAR` without a value is a footgun and a convenience.** It copies the
variable from your shell, which is handy in scripts and invisible in code
review. Someone reading the command cannot tell what value the container got.

**Shell quoting applies before Docker sees anything.** `-e MSG=hello world`
passes `MSG=hello` and then tries to run `world` in the container. Quote the
whole pair: `-e "MSG=hello world"`.

**Files beat variables for secrets, and the pattern has a name.** Many images
support a `*_FILE` convention: instead of `POSTGRES_PASSWORD`, set
`POSTGRES_PASSWORD_FILE=/run/secrets/db_password` and mount the file. The
Tasklane store does the same with `PGPASSWORD_FILE`:

```go include="examples/app/internal/store/store.go" lines="40-49"
```

The variable then holds a *path*, which is not sensitive, and the secret lives
in a file you can mount read-only. Stage 1 mounts that file from a volume;
Compose mounts it as a secret; Kubernetes mounts it from a Secret. The
application code never changes.

## Common patterns

**One set of variables, many containers.** Define them once in the script or
Compose file rather than repeating them per container. The stage-1 script
keeps them in a shell array shared by migrate, api and worker:

```bash title="examples/docker-run/tasklane-docker-run.sh" fragment
DB_ENV=(
  -e PGHOST=tasklane-db
  -e PGPORT=5432
  -e PGUSER=tasklane
  -e PGDATABASE=tasklane
  -e PGSSLMODE=disable
  -e PGPASSWORD_FILE=/run/secrets/db_password
)
```

**Sensible defaults in code, overrides in the environment.** The Tasklane
binaries use a small `env(key, default)` helper, so `PORT`, `WORK_DURATION_MS`
and `SHUTDOWN_DELAY_SECONDS` are all optional. An image that crashes because
an operator forgot a variable is a worse image.

**Fail fast on missing required configuration.** Optional is fine for tuning,
not for identity. A database user with no default should stop the process with
a clear message, not connect to something unexpected.

**Keep a `.env`-style file out of the image.** `--env-file` is read on the
host; the file never enters the image, which is exactly what you want.

## Production considerations

- Environment variables are set at container creation. A configuration change
  is a redeploy — plan for that rather than fighting it.
- Keep non-secret configuration in version control (`app.env` is committed on
  purpose) and secrets somewhere else entirely.
- Beware of very large values: the environment competes with the argument list
  for a limited buffer, and multi-kilobyte variables belong in files.
- Name variables for the ecosystem you are in. Using the standard `PG*`
  variables means every PostgreSQL client tool inside the container — `psql`,
  `pg_isready` — is configured automatically too.
- In Kubernetes the same values come from ConfigMaps and Secrets; the
  container contract is identical. See
  [ConfigMaps](../k8s-beginner/configmaps.md).

## Security considerations

Environment variables are not a secret store. Concretely, a password passed
with `-e` is visible:

```bash
docker run -d --name env-demo -e PGPASSWORD=hunter2 alpine:3.22 sleep 60
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' env-demo
```

```console include="captures/docker-beginner/env-inspect-leak.txt"
```

- `docker inspect` shows it to anyone with daemon access, for as long as the
  container record exists — including after the container has exited.
- Every child process inherits it, so a crash dump, an error report or a
  debugging endpoint that prints the environment leaks it.
- It appears in `/proc/<pid>/environ` inside the container.
- Baking one into an image with `ENV` is worse still: it is then in the image
  layers and in every registry that stores them. See
  [secrets in images](../docker-security/secrets-in-images.md).
- Shell history on the host keeps the command line that contained the value.

Use a file mounted at runtime, with the `*_FILE` convention where the image
supports it. In stage 1 the file comes from a volume; the password is never
present in `Config.Env`, as the Tasklane inspect capture shows:

```console include="captures/docker-beginner/tasklane-inspect-env.txt"
```

## Troubleshooting

- **The variable is not set inside the container.** Check the flag came before
  the image name, and `docker inspect --format '{{json .Config.Env}}'`.
- **`--env-file` line ignored.** Lines need `KEY=value`; quotes are kept as
  literal characters, and `export` prefixes are not shell-interpreted.
- **A value was truncated at a space.** Your shell split it; quote it.
- **The application still uses the old value.** Environment changes need a new
  container, not a restart.
- **Variables set in an entrypoint script are missing from `docker exec`.**
  `exec` starts from the container's recorded environment, not PID 1's live
  one.

## Common mistakes

- **Passing passwords, tokens or keys with `-e`.**
- **Putting `-e` after the image name**, making it an argument to the program.
- **Committing a `.env` file with real credentials.** Commit the shape, not
  the secrets.
- **Relying on a variable that only exists on your machine** because you used
  bare `-e VAR`.
- **Using `localhost` as a hostname value** inside a container. It means the
  container itself.
- **Expecting variable expansion in `--env-file`.** `PGHOST=$DB_HOST` is the
  literal string `$DB_HOST`.

## Related topics

- [Running containers](running-containers.md)
- [Volumes and bind mounts](volumes-and-bind-mounts-basics.md)
- [Tasklane with docker run](tasklane-with-docker-run.md)
- [Build args vs env](../docker-advanced/build-args-vs-env.md)
- [Compose profiles, overrides and env](../docker-intermediate/compose-profiles-overrides-env.md)
- [Secrets in images](../docker-security/secrets-in-images.md)
- [ConfigMaps](../k8s-beginner/configmaps.md)
- [Secrets](../k8s-beginner/secrets.md)
