---
title: Tasklane with docker run
description: Stage 1 of the running example - the whole system on one host with nothing but docker network, docker volume and docker run.
level: beginner
type: tutorial
status: current
versions: Docker Engine 29
prerequisites:
  - docker-beginner/publishing-ports
  - docker-beginner/environment-variables
  - docker-beginner/volumes-and-bind-mounts-basics
---

## Overview

Tasklane is the system this handbook carries from `docker run` to a production
Kubernetes cluster. It is deliberately small and deliberately realistic: an
HTTP API, a background worker that claims jobs from a queue, a PostgreSQL
database, and a schema migration that must run before either process starts.

Stage 1 runs all of it on one host with the commands from this part. Nothing
is abstracted away, which is the point: every flag here reappears as one line
of YAML in stage 2 and as one field of a Kubernetes object later. By the end
you will have felt why the next stage exists.

Everything below is in
[`examples/docker-run/`](../../examples/docker-run/README.md), as a script you
can read and run:

- [`tasklane-docker-run.sh`](../../examples/docker-run/tasklane-docker-run.sh)
- [`tasklane-docker-cleanup.sh`](../../examples/docker-run/tasklane-docker-cleanup.sh)

## The system

| Container | Image | Role |
|---|---|---|
| `tasklane-db` | `postgres:18-trixie` pinned by digest | The database. Not published |
| `tasklane-migrate` | `tasklane-api:0.1.0`, command `migrate` | One-shot schema creation, runs to completion |
| `tasklane-api` | `tasklane-api:0.1.0` | HTTP API on 8080, published to `127.0.0.1:8088` |
| `tasklane-worker` | `tasklane-worker:0.1.0` | Claims pending tasks, `/healthz` and `/metrics` on 9090 |

The API exposes `GET /` (version and hostname), `GET /healthz` (liveness, no
database), `GET /readyz` (readiness, pings the database), `GET /metrics`,
`GET /tasks` and `POST /tasks`. The worker claims a pending row with
`FOR UPDATE SKIP LOCKED`, "works" for `WORK_DURATION_MS`, then marks it done.

## Build the images

One Dockerfile produces both images from two targets:

```bash
docker build --target api    -t tasklane-api:0.1.0    examples/app
docker build --target worker -t tasklane-worker:0.1.0 examples/app
```

The images are distroless and run as UID 65532, with the binary as PID 1 and a
`HEALTHCHECK` that calls the binary's own `healthcheck` subcommand:

```dockerfile include="examples/app/Dockerfile" lines="38-50"
```

Part C takes that Dockerfile apart instruction by instruction. For now, treat
the two images as given.

## Run the stack

```bash
bash examples/docker-run/tasklane-docker-run.sh
```

```console include="captures/docker-beginner/tasklane-up.txt"
```

```bash
docker ps --filter label=org.example.tasklane.stage=docker-run --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
```

```console include="captures/docker-beginner/tasklane-ps.txt"
```

Three containers run; the migration container has already exited and been
removed. `tasklane-db` shows no published ports at all.

## Use it

```bash
curl http://127.0.0.1:8088/
curl -X POST -H 'Content-Type: application/json' -d '{"title":"first task"}' http://127.0.0.1:8088/tasks
curl http://127.0.0.1:8088/tasks
```

```console include="captures/docker-beginner/tasklane-api.txt"
```

The task is created as `pending`. A second or two later the worker has claimed
and completed it, which you can watch in its logs:

```bash
docker logs --tail 6 tasklane-worker
```

```console include="captures/docker-beginner/tasklane-worker-logs.txt"
```

## What the script does, step by step

### 1. A user-defined network

```bash
docker network create tasklane-net
```

Containers on it resolve each other by name through Docker's embedded DNS, so
`PGHOST=tasklane-db` is all the API needs:

```console include="captures/docker-beginner/tasklane-network.txt"
```

On the default bridge network this would not work at all.

### 2. Two volumes, one of them for the password

```bash
docker volume create tasklane-db-data
docker volume create tasklane-secrets
```

`tasklane-db-data` is mounted at `/var/lib/postgresql` — one level above
`PGDATA`, because the 18.x image puts the cluster in
`/var/lib/postgresql/18/docker`.

`tasklane-secrets` holds a generated password file. The script writes it once,
through a throwaway container, and every other container mounts that volume
**read-only** at `/run/secrets`. The database reads it through
`POSTGRES_PASSWORD_FILE` and the Go binaries through `PGPASSWORD_FILE`, so the
password never becomes an environment variable:

```console include="captures/docker-beginner/tasklane-inspect-env.txt"
```

The environment contains a path, not a secret. Compare that with the leak
demonstrated in
[Environment variables](environment-variables.md#security-considerations).

### 3. The database, unpublished and health-checked

```bash title="examples/docker-run/tasklane-docker-run.sh" fragment
docker run -d \
  --name tasklane-db \
  --network tasklane-net \
  --restart unless-stopped \
  -e POSTGRES_USER=tasklane \
  -e POSTGRES_DB=tasklane \
  -e POSTGRES_PASSWORD_FILE=/run/secrets/db_password \
  --mount "type=volume,src=tasklane-secrets,dst=/run/secrets,readonly" \
  --mount "type=volume,src=tasklane-db-data,dst=/var/lib/postgresql" \
  --health-cmd 'pg_isready -U tasklane -d tasklane' \
  --health-interval 5s --health-timeout 3s --health-retries 10 --health-start-period 10s \
  postgres:18-trixie@sha256:86c951e05bf56c93d95d397747fb8820ac76cc3bedb78f43abd83eedbe3666ae
```

No `-p`. The only things that can reach port 5432 are containers on
`tasklane-net`.

The image has no `HEALTHCHECK` of its own, so the script adds one with
`--health-cmd` and then waits for it, rather than sleeping a fixed number of
seconds:

```bash title="examples/docker-run/tasklane-docker-run.sh" fragment
status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name")
```

:::note Why this container is the one running as root
The official `postgres` entrypoint starts as root, prepares the data directory
and then drops to the `postgres` user before running the server. That is why
this container gets neither `--user` nor `--cap-drop ALL`, while the Tasklane
containers get both. Part E returns to the question of images that insist on
starting as root.
:::

### 4. The migration, in the foreground

```bash
docker run --rm --network tasklane-net ... tasklane-api:0.1.0 migrate
```

Foreground plus `--rm` means the script gets the exit code and nothing is left
behind. `set -e` stops everything if the migration fails, which is the
behaviour you want: an API talking to an un-migrated database is worse than an
API that never starts.

The migration is idempotent (`CREATE TABLE IF NOT EXISTS`), so re-running the
script is safe.

### 5. The API, published only to loopback

```bash title="examples/docker-run/tasklane-docker-run.sh" fragment
docker run -d \
  --name tasklane-api \
  --network tasklane-net \
  --restart unless-stopped \
  -p "127.0.0.1:8088:8080" \
  -e PGHOST=tasklane-db -e PGUSER=tasklane -e PGDATABASE=tasklane \
  -e PGPASSWORD_FILE=/run/secrets/db_password \
  --mount "type=volume,src=tasklane-secrets,dst=/run/secrets,readonly" \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 128m --cpus 0.5 \
  tasklane-api:0.1.0
```

Four decisions worth naming:

- **`127.0.0.1`** keeps the API off every other interface. Published ports
  bypass host firewalls, so the binding is the control.
- **`--restart unless-stopped`** brings it back after a crash or a reboot, but
  respects a deliberate `docker stop`.
- **`--read-only --cap-drop ALL --security-opt no-new-privileges:true`** is the
  same hardening the Compose file applies. The process needs no capabilities
  and writes nothing to disk.
- **`--memory` and `--cpus`** are cgroup limits. Without them one container can
  take down the host.

Port 8088 rather than 8080 is a small practical choice: the kind lab cluster
in later parts uses 8080 on the host.

### 6. The worker

Same environment, no published port, its own limits. It needs the database and
nothing else. Two workers would mean picking a second name by hand — the first
sign that this approach does not scale.

## Data outlives containers

Delete every container and the data is still there, because it lives in a
volume:

```bash
bash examples/docker-run/tasklane-docker-cleanup.sh
docker volume ls --filter name=tasklane
bash examples/docker-run/tasklane-docker-run.sh
curl http://127.0.0.1:8088/tasks
```

```console include="captures/docker-beginner/tasklane-persistence.txt"
```

The cleanup script keeps volumes unless you ask:

```bash
bash examples/docker-run/tasklane-docker-cleanup.sh --volumes
```

```console include="captures/docker-beginner/tasklane-cleanup.txt"
```

## What this costs, and what comes next

Stage 1 works. It is also 150 lines of shell to express something that has
four moving parts, and it has real limits:

| Limitation | What stage 2 does about it |
|---|---|
| The desired state exists only as commands in a script | A declarative `compose.yaml` |
| Ordering is a hand-written `wait_healthy` loop | `depends_on: condition: service_healthy` and `service_completed_successfully` |
| Scaling the worker means inventing container names | `docker compose up --scale worker=3`, or `deploy.replicas` |
| The password file is world-readable in a volume | Compose `secrets:`, mounted per service |
| Rebuilding on a code change is manual | `docker compose up --build --watch` |
| One flat network | `frontend` and an `internal: true` `backend` |
| Changing a flag means `rm -f` and a new `run` | `docker compose up` reconciles the difference |

None of that changes the containers themselves. The same four processes, the
same images, the same environment variables — a different way of describing
them. That is the theme of the whole handbook: the workload stays, the
orchestration grows.

Read the Compose file now if you like the contrast:
[Tasklane with Compose](../docker-intermediate/tasklane-with-compose.md).

## Common mistakes

- **Running the script without building the images first.** It stops with a
  clear error; build the two targets from `examples/app`.
- **Publishing the database "just to look at it with a GUI".** Attach a client
  container to `tasklane-net` instead, or use the Compose override file in
  stage 2, which publishes 5432 on loopback only.
- **Deleting the containers and expecting the data to go.** It is in
  `tasklane-db-data` until you pass `--volumes`.
- **Changing the password while the data volume exists.** PostgreSQL only uses
  `POSTGRES_PASSWORD_FILE` when it initialises an empty data directory; a new
  password with old data means the API cannot authenticate.
- **Starting the API before the migration.** It will serve `/healthz` happily
  and fail every database call, because `/healthz` deliberately does not touch
  the database.
- **Assuming `--restart unless-stopped` is high availability.** One host, one
  daemon. If the machine dies, so does Tasklane.

## Related topics

- [Running containers](running-containers.md)
- [Publishing ports](publishing-ports.md)
- [Volumes and bind mounts](volumes-and-bind-mounts-basics.md)
- [Environment variables](environment-variables.md)
- [Labs](labs.md)
- [Compose fundamentals](../docker-intermediate/compose-fundamentals.md)
- [Tasklane with Compose](../docker-intermediate/tasklane-with-compose.md)
- [Tasklane on Kubernetes](../k8s-beginner/tasklane-on-kubernetes.md)
