---
title: Compose dependencies and healthchecks
description: depends_on conditions, restart propagation, --wait, and why "wait for the database" is a health problem rather than a sleep.
level: intermediate
type: concept
status: current
versions: Docker Engine 29, Compose v5
prerequisites:
  - docker-intermediate/compose-fundamentals
  - docker-intermediate/healthchecks
---

## Overview

`depends_on` controls the order in which Compose creates, starts and removes
services. On its own it only means "started", which is rarely what you want: a
Postgres container is "started" several seconds before it accepts connections.
The long syntax adds conditions, and one of them — `service_healthy` — is the
one that makes local stacks deterministic.

## Why it exists and when to use it

Distributed systems have to tolerate dependencies being unavailable; that is
not optional, and a retry loop in the application is the real fix. But in a
development stack, a migration that runs before the database is ready fails the
whole `up`, and the error is confusing. Health-gated dependencies remove that
class of noise so the failures you see are your own.

Use conditions when start order genuinely matters: schema migrations, seed
data, a broker that must exist before a consumer starts.

## How it works underneath

Compose determines dependency order from `depends_on`, `links`,
`volumes_from` and `network_mode: "service:..."`. It creates services in
dependency order and removes them in reverse.

The short syntax (`depends_on: [db]`) waits only until the dependency is
*running*. The long syntax takes:

- `condition`
  - `service_started` — the short-syntax behaviour.
  - `service_healthy` — the dependency's healthcheck reports healthy.
  - `service_completed_successfully` — the dependency ran to completion and
    exited 0.
- `restart: true` — when Compose restarts the dependency (for example
  `docker compose restart`), restart this service too. It applies to explicit
  Compose operations, not to automatic restarts by the runtime after a crash.
  Introduced in Compose 2.17.0.
- `required: false` — only warn if the dependency is not available. Default is
  `true`. Introduced in Compose 2.20.0.

`service_healthy` needs the dependency to *have* a healthcheck — from its
image's `HEALTHCHECK` or from the `healthcheck:` attribute in the Compose
file. Without one, the condition can never be satisfied.

Compose's `healthcheck` attribute mirrors the Dockerfile instruction:
`test`, `interval`, `timeout`, `retries`, `start_period` and `start_interval`.
`test` as a string is shorthand for `CMD-SHELL`; as a list it must start with
`NONE`, `CMD` or `CMD-SHELL`. `disable: true` (or `test: ["NONE"]`) switches
off a check inherited from the image.

## Basic example

Tasklane gates everything on the database being healthy and the migration
having finished:

```yaml include="examples/compose/compose.yaml" lines="28-45"
```

```yaml include="examples/compose/compose.yaml" lines="47-61"
```

```yaml include="examples/compose/compose.yaml" lines="77-81"
```

Bring it up and wait for health:

```bash
docker compose -f examples/compose/compose.yaml up -d --wait
docker compose -f examples/compose/compose.yaml ps
```

```console include="captures/docker-intermediate/compose-up-wait.txt"
```

```console include="captures/docker-intermediate/compose-ps-health.txt"
```

## Explanation

The chain is: `db` starts, its `pg_isready` check passes, `migrate` runs and
exits 0, then `api` and `worker` start. Nothing sleeps, and nothing retries
blindly at the Compose level.

The database's check is cheap and local: `pg_isready -U tasklane -d tasklane`
asks the local server whether it is accepting connections. `start_period: 10s`
covers first-run initialisation, when Postgres creates the cluster in the
empty volume.

`migrate` is the one-shot service. It has no healthcheck — it is not a
service that stays up — so its consumers use
`service_completed_successfully`. `restart: "no"` prevents the container from
being restarted after it exits.

The application still retries at runtime. `cmd/api`'s migrate path loops for
up to 20 attempts, two seconds apart, and the worker logs and retries claim
failures. Compose ordering is a convenience; the retry loop is the correctness
mechanism.

`up -d --wait` makes the command itself wait until every service with a
healthcheck is healthy, which turns a CI step into a reliable gate instead of
a `sleep 30`.

## Common patterns

**Health-gated database.** `pg_isready`, `mysqladmin ping`, `redis-cli ping`,
an HTTP `/healthz` — short, local, no credentials to a third system.

**One-shot migration job.**
`depends_on: {migrate: {condition: service_completed_successfully}}`, as
above. It is also the shape that maps cleanly onto a Kubernetes Job or an init
container later.

**`restart: true` for config reloads.** A proxy that reads a config generated
by another service restarts when that service restarts.

**`required: false` for optional extras.** A tracing collector that may not be
running in every profile.

**`--wait` plus `--wait-timeout` in CI.** Fail fast rather than hang.

**Retries in the application anyway.** Dependencies restart in production;
ordering at start-up does not save you from that.

## Production considerations

Ordering guarantees end at start-up. Kubernetes has no `depends_on`: Pods are
scheduled independently, and the equivalents are init containers (run to
completion before the main container), readiness probes (keep traffic away
until ready) and Jobs (run migrations once). A Compose stack that only works
because of `depends_on` will not survive the translation; one whose services
retry will.

Check intervals cost CPU and connections. `pg_isready` every five seconds per
service is fine locally and unnecessary in production, where a monitoring
system is already asking.

Beware of health checks that depend on other services: if the API's health
check queries the database, a database blip makes every dependent service
unhealthy, and with `service_healthy` dependencies that cascades on restart.
Liveness answers "is this process working", not "is my dependency up".

## Security considerations

- A health check runs inside the container with its privileges. Do not add a
  client tool or a shell to a minimal image just to satisfy a check; have the
  application check itself, as Tasklane does.
- Do not put credentials in a check command: they land in the Compose file,
  `docker inspect`, and often in shell history. `pg_isready` needs none, and
  Postgres in the example takes its password from a file.
- Health check output is stored (truncated at 4096 bytes) and visible to
  anyone who can inspect the container. Keep it terse.
- `required: false` can silently hide a missing security-relevant dependency,
  such as an audit-log shipper. Use it deliberately.

## Troubleshooting

**"dependency failed to start: container ... is unhealthy".** The dependency's
check never passed. Look at the recorded output:

```bash
docker inspect --format '{{json .State.Health}}' tasklane-db-1
docker compose -f examples/compose/compose.yaml logs db
```

**A service waits forever on `service_healthy`.** The dependency has no
healthcheck at all, so the condition can never be met.

**`service_completed_successfully` never fires.** The one-shot container is
being restarted (a `restart` policy other than `no`), or it exits non-zero.

**`up --wait` returns before the stack is usable.** Only services *with*
healthchecks are waited for. Add checks, or use `--wait-timeout` plus your own
probe.

**Everything is healthy but the API cannot reach the database.** Ordering is
fine; the problem is networking or credentials. Check that both services share
a network and that the secret is mounted.

## Common mistakes

- Short-syntax `depends_on` for a database, then blaming Compose when the
  application fails to connect.
- `sleep 10` in an entrypoint instead of a healthcheck.
- A healthcheck that checks a *dependency* rather than the container itself.
- Expecting `depends_on` to restart services when a dependency recovers. Only
  `restart: true` does, and only for explicit Compose operations.
- Using `depends_on` as a substitute for retry logic in the application.
- Assuming the same ordering guarantees exist in Kubernetes.

## Related topics

- [Compose fundamentals](compose-fundamentals.md)
- [Healthchecks](healthchecks.md)
- [Tasklane with Compose](tasklane-with-compose.md)
- [PID 1, signals and graceful shutdown](pid1-signals-graceful-shutdown.md)
- [Init and sidecar containers](../k8s-intermediate/init-and-sidecar-containers.md)
- [Jobs and CronJobs](../k8s-intermediate/jobs-and-cronjobs.md)
