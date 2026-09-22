---
title: Tasklane with Compose
description: Stage two of the running example — the whole Tasklane stack as one Compose file, read top to bottom, with health gates, a one-shot migration, file secrets, an internal network, profiles, watch and scaling.
level: intermediate
type: tutorial
status: current
versions: Docker Engine 29, Compose v5
prerequisites:
  - docker-beginner/tasklane-with-docker-run
  - docker-intermediate/compose-fundamentals
  - docker-intermediate/compose-dependencies-and-healthchecks
---

## Overview

In [Tasklane with docker run](../docker-beginner/tasklane-with-docker-run.md)
you started the API, the worker and PostgreSQL by hand, wiring them together
with `--network`, `-e` and a manually created secret file. That works once and
is unreviewable the second time: the ordering lives in your shell history, the
password is a flag, and nobody else can reproduce it.

This is stage two. The same four processes become a single
`examples/compose/compose.yaml` that you can diff, review and commit. Nothing
about the application changes — the Go binaries, the image and the database are
identical — but the operational knowledge moves out of your head and into a
file. This page reads that file top to bottom and explains why each block is
shaped the way it is, because the shapes here (health-gated ordering, a
run-to-completion migration, a file-mounted secret, an internal network) are
the same ones you meet again as Kubernetes probes, Jobs, Secrets and
NetworkPolicy in [Tasklane on Kubernetes](../k8s-beginner/tasklane-on-kubernetes.md).

Run it from the repository root:

```bash
docker compose -f examples/compose/compose.yaml up -d --wait
docker compose -f examples/compose/compose.yaml ps
docker compose -f examples/compose/compose.yaml down
```

## The service graph

The stack is four always-on services plus two optional ones. The dependency
edges are what make it a graph rather than a list:

```text
db ──(service_healthy)──► migrate ──(service_completed_successfully)──► api
 │                                                                    └► worker
 └──────────────────────(service_healthy)────────────────────────────┘

loadgen ──(service_healthy)──► api        # profile: load
prometheus                                # profile: observability
```

`db` comes up first. Its healthcheck must pass before `migrate` is allowed to
run; `migrate` must exit 0 before `api` and `worker` start. `loadgen` and
`prometheus` are excluded from a default `up` by their profiles. The rest of
this page walks each node of that graph in the order Compose brings it up.

The file opens with a project name and two reusable blocks:

```yaml include="examples/compose/compose.yaml" lines="10-25"
```

`name: tasklane` pins the project name so the stack does not rename itself when
the repository is cloned into a differently named directory. `x-app-security`
and `x-db-env` are top-level extension fields: anything beginning with `x-` is
ignored by Compose and exists only to be reused as a YAML anchor, which keeps
the hardening block and the database connection settings written once and
merged into several services with `<<: *app-security`. Read the resolved model
rather than the source when you are debugging — `config` expands every anchor:

```bash
docker compose -f examples/compose/compose.yaml config
```

```console include="captures/docker-intermediate/compose-config.txt"
```

## The database

```yaml include="examples/compose/compose.yaml" lines="28-45"
```

Three details carry the design:

- **The password is a file, not a variable.** `POSTGRES_PASSWORD_FILE`
  points at `/run/secrets/db_password`, and the service lists
  `secrets: [db_password]` to have it mounted. The value never enters the
  environment, so it cannot surface in `docker inspect` or a crash dump. This
  is covered in full under [Secrets as files](#secrets-as-files).
- **The volume mounts one level high.** The `postgres:18` image sets
  `PGDATA=/var/lib/postgresql/18/docker`, so the named volume is mounted at
  `/var/lib/postgresql` — its parent — not at the data directory itself. Mount
  it at the wrong level and Postgres either re-initialises an empty cluster or
  refuses to start.
- **The healthcheck is the gate.** `pg_isready -U tasklane -d tasklane` asks
  the local server whether it accepts connections. `start_period: 10s` covers
  first-run initialisation, when Postgres builds the cluster in the empty
  volume and would otherwise fail the first few checks. This check is what the
  dependent services wait on; without it, `service_healthy` could never be
  satisfied.

`db` is attached only to the `backend` network. Nothing publishes its port in
the base file, because nothing outside the host needs to reach it.

## Health-gated dependencies

The application services do not merely start after the database — they start
after it is *ready*, and after the schema exists. That is two different
conditions:

```yaml include="examples/compose/compose.yaml" lines="77-81"
```

`condition: service_healthy` waits for the database's healthcheck to report
healthy. `condition: service_completed_successfully` waits for the one-shot
`migrate` service to exit 0. Plain `depends_on: [db]` would only wait for the
container to be *running*, which for Postgres happens several seconds before it
accepts connections — the classic race that a `sleep 10` papers over and a
health gate removes properly.

The gate is a convenience for start-up ordering, not a correctness mechanism.
The application still retries at runtime, because in any real deployment the
database can restart underneath it. See
[Compose dependencies and healthchecks](compose-dependencies-and-healthchecks.md)
for the full set of conditions and the reasons ordering guarantees end at
start-up.

## The one-shot migration

`migrate` is the odd service: it runs a command, exits, and never comes back.

```yaml include="examples/compose/compose.yaml" lines="47-61"
```

It builds the same `api` image and runs its `migrate` subcommand instead of
serving. `restart: "no"` makes the intent explicit — this container is
*supposed* to exit, and Compose must not treat that exit as a failure to
restart. It has no healthcheck, because a healthcheck describes a service that
stays up; its consumers therefore gate on
`service_completed_successfully`, not `service_healthy`.

Running the schema migration as a separate run-to-completion unit, rather than
inside the API's start-up, keeps the migration from running once per API
replica and gives it a clean success/failure signal. This is deliberately the
same shape as a Kubernetes Job or an init container, so the pattern survives
the translation to the cluster in
[Tasklane on Kubernetes](../k8s-beginner/tasklane-on-kubernetes.md).

## The API

```yaml include="examples/compose/compose.yaml" lines="63-88"
```

`api` is the only service on both networks: `frontend` (so its port can be
published) and `backend` (so it can reach the database). It publishes
`${API_PORT:-8080}:8080`, an interpolation that defaults to 8080 when
`API_PORT` is unset. `env_file` supplies non-secret tunables and the
`x-db-env` anchor supplies connection settings; `environment` wins over
`env_file` for any key in both.

The `<<: *app-security` merge applies `read_only: true`, `cap_drop: [ALL]` and
`no-new-privileges:true`. The image already runs as UID 65532
(see [running as non-root](running-as-non-root.md)); these settings remove what
an attacker could otherwise do *after* compromising the process. A development
stack is exactly where those habits should form, so the hardening is on by
default rather than bolted on later.

`deploy.resources.limits` caps the API at half a CPU and 128 MB. On one host,
limits are what stop a runaway service from starving its neighbours.

## The worker and scaling

```yaml include="examples/compose/compose.yaml" lines="100-122"
```

The worker has no published port and lives on `backend` only. The interesting
line is `deploy.replicas: 2`. That is meaningful — not decoration — because the
worker claims tasks with `FOR UPDATE SKIP LOCKED`, so two replicas never pick
up the same row. Running replicas locally is how you find out whether that
claim is actually true before production tests it for you.

Scale further at runtime without editing the file:

```bash
docker compose -f examples/compose/compose.yaml up -d --scale worker=3
docker compose -f examples/compose/compose.yaml ps
```

```console include="captures/docker-intermediate/compose-scale-worker.txt"
```

Replicas are named `tasklane-worker-1`, `-2`, `-3` and share the service's DNS
name; Docker's embedded DNS returns one address per replica. This is why a
scaled service cannot have a `container_name` or a fixed published host port —
both must be unique per container. It is also emphatically *not* high
availability: this is N containers on one host, one failure domain, no
rescheduling if the host dies. When you need that, the answer is an
orchestrator, not more replicas. See
[Compose secrets, configs and scaling](compose-secrets-configs-scaling.md).

## Secrets as files

The password exists once, as a file, and is mounted into every service that
needs it:

```yaml include="examples/compose/compose.yaml" lines="173-175"
```

The application reads a *path*, never a value:

```yaml include="examples/compose/compose.yaml" lines="19-25"
```

A top-level `secrets` entry with a `file:` source is mounted read-only at
`/run/secrets/db_password`. Because the source is a file, Compose implements
the mount as a bind mount, which is why `uid`, `gid` and `mode` are silently
ignored for file-sourced secrets — a caveat worth remembering when you expect
`mode: 0400` to take effect.

`./secrets/db_password.txt` is a development value committed on purpose, with a
comment saying so; it grants nothing outside this stack. In any real
environment the file comes from outside the repository: a CI-provisioned file,
a mounted volume or a secrets manager that writes it before `up`. The point of
the whole arrangement is that the value is never in the image, never in the
environment and never in `docker inspect`.

## The internal backend network

```yaml include="examples/compose/compose.yaml" lines="163-171"
```

Two networks, and the important word is `internal: true` on `backend`. An
internal network has no route out: containers attached to it can talk to each
other, but not to the outside world, and nothing outside the host can reach
them. The database sits only on `backend`, so it is reachable from `api`,
`worker` and `migrate` and from nowhere else — segmentation that costs three
lines of YAML.

The developer override relaxes exactly one part of this, and only when you run
Compose with no `-f` from the example directory:

```yaml include="examples/compose/compose.override.yaml"
```

It publishes Postgres on `127.0.0.1:5432` for a local GUI client and, to do so,
adds `frontend` to `db` (a service on an `internal`-only network cannot publish
a port). It binds to loopback, not `0.0.0.0`, so the database is not exposed
beyond the machine. Keeping this in the override rather than the base file is
the discipline: the shared file stays segmented, the developer gets their
convenience. See
[Compose profiles, overrides and environment](compose-profiles-overrides-env.md).

## Profiles: load and observability

Two services carry `profiles`, so a plain `up` starts four services and
ignores these two:

```yaml include="examples/compose/compose.yaml" lines="130-134"
```

```yaml include="examples/compose/compose.yaml" lines="152-161"
```

`loadgen` creates a task a second through the public API; `prometheus` scrapes
the API and the worker replicas. Activate them explicitly:

```bash
docker compose -f examples/compose/compose.yaml --profile load up -d
docker compose -f examples/compose/compose.yaml --profile observability up -d
COMPOSE_PROFILES=load,observability docker compose -f examples/compose/compose.yaml up -d
```

Profiles keep optional pieces in the same reviewed file without paying for them
on every `up`. Note that `loadgen` runs `busybox` as user `65534:65534` and
carries the same `<<: *app-security` block: even a throwaway load generator
runs non-root and read-only here, because the checker — and good sense —
requires it. Prometheus receives its configuration as a Compose `config`
targeted at `/etc/prometheus/prometheus.yml`, so editing `prometheus.yml` and
recreating the container is enough; no image is rebuilt.

## Watch mode: rebuild on change

Tasklane is Go, so every source change means a new binary and therefore a new
image. There is no `sync` rule — syncing source into a distroless image would
achieve nothing, since there is no compiler or shell in there — so all three
rules are `rebuild`:

```yaml include="examples/compose/compose.yaml" lines="89-98"
```

```bash
docker compose -f examples/compose/compose.yaml up --build --watch
```

Edit `examples/app/cmd/api/main.go`, save, and Compose rebuilds the `api` image
and recreates only that service; the database, its volume and the worker are
untouched. A change under `cmd/` or `internal/` matches both `api` and
`worker`, so both rebuild. The layer cache is what keeps this bearable: the
`go mod download` layer and the build cache mounts in the Dockerfile mean a
rebuild recompiles changed packages only. This is the honest trade for a
compiled language, explained in full in [Compose watch](compose-watch.md) and
[layer caching](layer-caching.md).

## Verifying the whole stack

```bash
docker compose -f examples/compose/compose.yaml up -d --wait
docker compose -f examples/compose/compose.yaml ps
```

```console include="captures/docker-intermediate/compose-up-wait.txt"
```

```console include="captures/docker-intermediate/compose-ps-health.txt"
```

`up -d --wait` blocks until every service with a healthcheck is healthy, which
turns start-up into a deterministic gate instead of a guess. When it returns,
the API answers on the published port and the worker is draining the queue that
`loadgen` fills, if you started that profile.

Tear it down, and decide whether the data goes with it:

```bash
docker compose -f examples/compose/compose.yaml down       # keeps the volume
docker compose -f examples/compose/compose.yaml down -v    # deletes the volume and its data
```

## Common mistakes

- Using plain `depends_on: [db]` and then blaming Compose when the API cannot
  connect; the database is *running* long before it is *ready*. Gate on
  `service_healthy`.
- Giving `migrate` a restart policy other than `no`, so
  `service_completed_successfully` never fires because the container keeps
  coming back.
- Mounting the database volume at `/var/lib/postgresql/18/docker` instead of
  `/var/lib/postgresql`, so the data does not survive a recreate.
- Putting the database password in `environment` because it is one line
  shorter, defeating the whole reason the secret is a file.
- Publishing the database port in the base file instead of the override, so the
  segmentation that `internal: true` gives you is thrown away for everyone.
- Expecting `deploy.replicas` to be high availability. One host is one failure
  domain.
- Adding a `sync` watch rule for the Go source and wondering why nothing
  happens; a distroless image has no compiler and no shell for `sync` to use.
- Running the retired Python Compose v1 binary instead of `docker compose`.

## Related topics

- [Tasklane with docker run](../docker-beginner/tasklane-with-docker-run.md)
- [Compose fundamentals](compose-fundamentals.md)
- [Compose dependencies and healthchecks](compose-dependencies-and-healthchecks.md)
- [Compose profiles, overrides and environment](compose-profiles-overrides-env.md)
- [Compose watch](compose-watch.md)
- [Compose secrets, configs and scaling](compose-secrets-configs-scaling.md)
- [Multi-stage builds](multi-stage-builds.md)
- [Labs - Docker for intermediate](labs.md)
- [Tasklane on Kubernetes](../k8s-beginner/tasklane-on-kubernetes.md)
- [Compose v1/v2 to v5](../migration/compose-v1-v2-to-v5.md)
</content>
</invoke>
