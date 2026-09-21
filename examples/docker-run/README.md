# Tasklane, stage 1: plain `docker run`

This directory runs the whole Tasklane system — PostgreSQL, a schema
migration, the API and one worker — with nothing but `docker network create`,
`docker volume create` and `docker run`. No Compose, no Kubernetes.

It exists so that later stages have something to compare against. Stage 2
(`../compose/compose.yaml`) replaces every flag here with a few lines of YAML;
stage 3 (`../k8s/`) replaces that with objects the cluster reconciles for you.
Nothing new is added along the way — the same four processes keep running.

| File | What it does |
|---|---|
| `tasklane-docker-run.sh` | Creates the network, the volumes and the four containers. Idempotent. |
| `tasklane-docker-cleanup.sh` | Removes them again. Keeps the data volume unless you pass `--volumes`. |

## Prerequisites

Docker Engine 29 (or Docker Desktop) and the two images, built from
`../app`:

```bash
docker build --target api    -t tasklane-api:0.1.0    examples/app
docker build --target worker -t tasklane-worker:0.1.0 examples/app
```

The PostgreSQL image is pulled automatically. It is pinned by the same digest
as `../compose/compose.yaml`.

## Run it

```bash
bash examples/docker-run/tasklane-docker-run.sh
curl http://127.0.0.1:8088/
curl -X POST -H 'Content-Type: application/json' -d '{"title":"first task"}' http://127.0.0.1:8088/tasks
curl http://127.0.0.1:8088/tasks
docker logs --tail 10 tasklane-worker
bash examples/docker-run/tasklane-docker-cleanup.sh
```

Set `API_PORT` to publish somewhere other than 8088. The default avoids 8080,
which the kind lab cluster uses in later parts.

## What the script sets up

```
              host 127.0.0.1:8088
                      |  DNAT
      +---------------v-----------------------------+
      |  network tasklane-net (user-defined bridge) |
      |                                             |
      |  tasklane-api:8080 ---> tasklane-db:5432    |
      |  tasklane-worker  ---/                      |
      +---------------------------------------------+
                 volumes: tasklane-db-data, tasklane-secrets
```

- **One user-defined bridge network.** Containers on it resolve each other by
  container name, so `PGHOST=tasklane-db` works. Containers on the *default*
  bridge cannot do that.
- **Only the API publishes a port**, and only on `127.0.0.1`. PostgreSQL has no
  `-p` at all, so it is reachable from the other containers and from nowhere
  else.
- **Two named volumes.** `tasklane-db-data` holds the database at
  `/var/lib/postgresql` (the 18.x image puts the cluster in
  `/var/lib/postgresql/18/docker`, so the volume sits one level up).
  `tasklane-secrets` holds a generated password file, mounted read-only at
  `/run/secrets` and read through `POSTGRES_PASSWORD_FILE` and
  `PGPASSWORD_FILE`. The password is never passed in an environment variable,
  so it does not show up in `docker inspect`.
- **Migration first.** `tasklane-migrate` runs in the foreground with `--rm`,
  so the script can check its exit code before starting anything else.
- **Health.** Both application images carry a `HEALTHCHECK`; the database gets
  one from `--health-cmd 'pg_isready ...'`. The script polls
  `docker inspect --format '{{.State.Health.Status}}'` instead of sleeping a
  fixed number of seconds.

## Known limits of stage 1

This is deliberately the clumsy version:

- `docker run` flags are not a description of the desired state. Change one
  flag and you must delete and recreate the container by hand.
- The ordering is imperative shell (`wait_healthy`), not a declared
  dependency. Compose expresses it as `depends_on: condition: service_healthy`.
- Scaling the worker means inventing more container names.
- The password file is world-readable inside the secrets volume because both
  UID 999 (postgres) and UID 65532 (Tasklane) read it.
- Nothing restarts the stack after a host reboot except
  `--restart unless-stopped`, and nothing re-runs the migration.

Each of those is a reason the next stage exists.
