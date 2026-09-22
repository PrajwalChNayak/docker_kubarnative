---
title: Labs - Docker for intermediate
description: Eleven exercises on Dockerfiles, multi-stage builds, layer caching, signals, healthchecks, non-root images and Compose, ending with the whole Tasklane stack under Compose, each with a full solution.
level: intermediate
type: lab
status: current
versions: Docker Engine 29, Compose v5
prerequisites:
  - docker-intermediate/tasklane-with-compose
---

## Overview

Eleven exercises, roughly two hours. The first half is images — authoring a
Dockerfile, ordering it for the cache, shrinking it with multi-stage builds,
and getting signals, healthchecks and non-root right. The second half is
Compose: dependencies, watch, profiles, secrets and scaling, using the Tasklane
stack in `examples/`.

Nothing here needs a cluster, a cloud account or a registry login. Everything
runs against your local Docker Engine 29 and Compose v5. Work through the
exercises in order — several build on images or containers created earlier —
and clean up with the final one. Each exercise is a task plus a way to check
yourself; full solutions follow in [Solutions](#solutions).

## Setup

You need Docker Engine 29 (or Docker Desktop), the Compose v5 plugin, a shell,
`curl`, and this repository checked out. Run everything from the repository
root.

```bash
docker version
docker compose version
docker info --format '{{.ServerVersion}} {{.Driver}}'
```

Build the two Tasklane images once; the later exercises reuse them:

```bash
docker build --target api    -t tasklane-api:0.1.0    examples/app
docker build --target worker -t tasklane-worker:0.1.0 examples/app
```

Everything created below is named `lab-*` or `tasklane-*`, or lives in the
`tasklane` Compose project, so the cleanup in exercise 11 can find it.

## Exercises

### 1. Author a hardened multi-stage Dockerfile

Without copying `examples/app/Dockerfile`, write your own `lab.Dockerfile` that
builds the Tasklane API from `examples/app` and produces a final image that:

1. compiles the binary in a `golang` build stage and ships it in a distroless
   `static-debian13:nonroot` runtime stage (two stages, one `FROM` each);
2. runs as UID 65532, not root;
3. sets an exec-form `ENTRYPOINT`;
4. passes `hadolint` with no errors.

Build it as `lab-api:hand`, then confirm the image runs as a non-root user.

### 2. Order a Dockerfile for the cache

Using your `lab.Dockerfile` from exercise 1, prove the difference between a
good and a bad layer order. First rebuild after touching only a `.go` source
file; then rebuild after touching `go.mod`. Which rebuild re-downloads
dependencies, and why? Then deliberately break the order so that every source
change re-runs `go mod download`, and explain the single line that caused it.

### 3. See what multi-stage buys you

Compare the size of the final `tasklane-api:0.1.0` image with the size of its
own `build` stage. Then show that the final image contains no shell and no
package manager. Why can it still run the Go binary?

### 4. Signals and graceful shutdown

`tasklane-api` fails readiness on `SIGTERM`, waits `SHUTDOWN_DELAY_SECONDS`,
then exits. Start it with `SHUTDOWN_DELAY_SECONDS=3` (it needs no database to
start), then:

1. stop it with `docker stop` and record the exit code and the last log lines;
2. start it again and end it with `docker kill`, and record that exit code;
3. explain the two exit codes and which shutdown the worker relies on to hand
   an in-flight task back to the queue.

### 5. Read and trigger the healthcheck

The image carries a `HEALTHCHECK`. Without reading the Dockerfile, find the
healthcheck command, the interval and the retries from a running container.
Then run the exact healthcheck command yourself inside the container and read
its exit code. What makes this healthcheck safe for a distroless image with no
shell and no `curl`?

### 6. Prove the image is non-root and read-only

Start `tasklane-api:0.1.0` and, from outside the container, show the UID its
process runs as. Then start it with a read-only root filesystem and
`--cap-drop ALL --security-opt no-new-privileges`, and attempt to write a file
into `/`. What happens, and which of those flags is doing the work?

### 7. Compose: health-gated dependencies and the one-shot migration

Bring up the Tasklane Compose stack and wait for health. Then break the
migration on purpose — make `migrate` exit non-zero — and observe what happens
to `api` and `worker`. Which `depends_on` condition stops them, and why is that
better than a `sleep`?

### 8. Compose watch rebuilds only what changed

Start the stack in watch mode. Touch `examples/app/cmd/api/main.go` and record
which services Compose rebuilds. Then touch `examples/app/internal/store/store.go`
and record which services rebuild this time. Explain the difference from the
`develop.watch` rules, and why there is no `sync` rule.

### 9. Compose profiles

Show which services a plain `up` would start, then which services are added by
the `load` profile and by the `observability` profile. Do it without starting
anything. Then start the `load` profile and confirm the load generator is
posting tasks.

### 10. Compose secrets and scaling

Show that the database password reaches the containers as a file and never as
an environment variable. Then scale the worker to three replicas and show their
names. Why is scaling the worker safe, and why could you not scale a service
that publishes a fixed host port?

### 11. Clean up

Remove every container, image and volume these labs created, and confirm
nothing is left behind.

## Solutions

### 1. Author a hardened multi-stage Dockerfile

```dockerfile title="lab.Dockerfile"
# syntax=docker/dockerfile:1
FROM golang:1.27-trixie AS build
WORKDIR /src
# Dependencies first so this layer is cached until go.mod/go.sum change.
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Static binary: no libc needed in the runtime image.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api

FROM gcr.io/distroless/static-debian13:nonroot AS api
COPY --from=build /out/api /api
# distroless :nonroot is UID/GID 65532. Declared numerically so a runtime can
# verify non-root without reading /etc/passwd.
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/api"]
```

```bash
docker build -f lab.Dockerfile --target api -t lab-api:hand examples/app
docker run --rm -i hadolint/hadolint:v2.15.1 hadolint - < lab.Dockerfile
docker run --rm --entrypoint /api lab-api:hand --help 2>/dev/null; true
docker image inspect lab-api:hand --format 'user={{.Config.User}}'
```

The `user=65532:65532` line is the confirmation. The build stage runs on the
full `golang` image because compilation needs a toolchain; the runtime stage
ships only the static binary on a distroless base, which is why the final image
has no shell and no package manager. `CGO_ENABLED=0` is what makes the binary
static, so it can run on `static-debian13` with no libc. The exec-form
`ENTRYPOINT` makes the binary PID 1 and lets it receive `SIGTERM` directly —
see exercise 4. Compare your file with the reference at
[`examples/app/Dockerfile`](../../examples/app/Dockerfile), which additionally
pins the base images by digest and cross-compiles.

### 2. Order a Dockerfile for the cache

```bash
# touch a source file only
touch examples/app/cmd/api/main.go
docker build -f lab.Dockerfile --target api -t lab-api:hand examples/app
# touch the dependency manifest
touch examples/app/go.mod
docker build -f lab.Dockerfile --target api -t lab-api:hand examples/app
```

The first rebuild reuses the cached `go mod download` layer: `COPY go.mod
go.sum` produced an identical layer, so BuildKit skips the download and only
recompiles. The second rebuild changes `go.mod`, which invalidates that
`COPY` and every layer after it, so `go mod download` runs again. The bad order
is a single move — copy the whole tree before downloading:

```dockerfile title="bad-order.Dockerfile" fragment
COPY . .
RUN go mod download          # now invalidated by ANY source change
RUN CGO_ENABLED=0 go build -o /out/api ./cmd/api
```

Because `COPY . .` comes first, any edit anywhere busts the download layer, so
every build re-resolves modules. The rule is: copy the least-frequently-changed
inputs first. See [layer caching](layer-caching.md).

### 3. See what multi-stage buys you

```bash
docker build --target build -t lab-api:build examples/app
docker build --target api   -t tasklane-api:0.1.0 examples/app
docker images lab-api:build tasklane-api:0.1.0
docker run --rm --entrypoint /bin/sh tasklane-api:0.1.0 -c 'echo hi'   # fails: no shell
docker history tasklane-api:0.1.0
```

The `build` stage carries the whole Go toolchain and module cache and is large;
the final `api` image is a single static binary on distroless and is a small
fraction of it. The final image has no `/bin/sh`, so the `docker run ... sh`
command fails — which is the point: nothing for an attacker to pivot into. It
still runs the application because the Go binary is statically linked and needs
no interpreter, shell or libc. See [multi-stage builds](multi-stage-builds.md)
and [image size optimisation](image-size-optimisation.md).

### 4. Signals and graceful shutdown

```bash
docker run -d --name lab-sig -e SHUTDOWN_DELAY_SECONDS=3 tasklane-api:0.1.0
docker stop lab-sig
docker inspect lab-sig --format 'stopped: exit={{.State.ExitCode}}'
docker logs lab-sig --tail 5
docker rm lab-sig

docker run -d --name lab-sig -e SHUTDOWN_DELAY_SECONDS=3 tasklane-api:0.1.0
docker kill lab-sig
docker inspect lab-sig --format 'killed: exit={{.State.ExitCode}}'
docker rm lab-sig
```

`docker stop` sends `SIGTERM`, which the exec-form ENTRYPOINT delivers straight
to the Go process as PID 1: it fails readiness, waits `SHUTDOWN_DELAY_SECONDS`,
drains, and exits **0**. `docker kill` sends `SIGKILL`, which the kernel
delivers and the process cannot trap, so it dies immediately with exit
**137** (128 + signal 9). The worker relies on the graceful `SIGTERM` path to
hand its in-flight task back to the queue with `FOR UPDATE SKIP LOCKED`; a
`SIGKILL` skips that, so the task stays claimed until its lease expires. Note
that `docker stop` escalates to `SIGKILL` after its timeout (default 10s), so
`SHUTDOWN_DELAY_SECONDS` must stay comfortably under that. See
[PID 1, signals and graceful shutdown](pid1-signals-graceful-shutdown.md).

### 5. Read and trigger the healthcheck

```bash
docker run -d --name lab-hc tasklane-api:0.1.0
docker inspect lab-hc --format '{{json .Config.Healthcheck}}'
docker inspect lab-hc --format '{{json .State.Health.Status}}'
docker exec lab-hc /api healthcheck; echo "exit: $?"
docker rm -f lab-hc
```

`.Config.Healthcheck` shows the test (`["CMD","/api","healthcheck"]`), the
interval, timeout, retries and start period. The check works on a distroless
image because it calls the application's *own* `healthcheck` subcommand — the
same binary that is already in the image — rather than a shell, `curl` or
`wget`, none of which exist here. The subcommand exits 0 when healthy and
non-zero otherwise, which is exactly the contract Docker's HEALTHCHECK expects.
See [healthchecks](healthchecks.md).

### 6. Prove the image is non-root and read-only

```bash
docker run -d --name lab-nr tasklane-api:0.1.0
docker inspect lab-nr --format 'user={{.Config.User}}'
docker top lab-nr -o user,pid,args
docker rm -f lab-nr

docker run --rm \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --entrypoint /api tasklane-api:0.1.0 --help 2>/dev/null; true

docker run --rm --read-only --entrypoint /bin/sh busybox:1.37 \
  -c 'echo test > /oops' ; echo "write exit: $?"
```

`docker top` shows the process owned by UID 65532, not root — the image's
`USER 65532:65532` at work, so it is non-root even without any runtime flag.
`--read-only` mounts the root filesystem read-only, so a write into `/` fails
with `Read-only file system` (shown with the busybox probe, since the
distroless image has no shell to run a write test). The three flags do
different jobs: `USER` sets who you are, `--read-only` removes where you can
write, `--cap-drop ALL` removes what the kernel lets you do, and
`no-new-privileges` stops a setuid binary from regaining any of it. Together
they are the [running as non-root](running-as-non-root.md) baseline that the
Compose stack applies with its `x-app-security` anchor.

### 7. Compose: health-gated dependencies and the one-shot migration

```bash
docker compose -f examples/compose/compose.yaml up -d --wait
docker compose -f examples/compose/compose.yaml ps
```

```console include="captures/docker-intermediate/compose-up-wait.txt"
```

```console include="captures/docker-intermediate/compose-ps-health.txt"
```

Now break the migration and watch the gate hold:

```bash
docker compose -f examples/compose/compose.yaml down
docker compose -f examples/compose/compose.yaml run --rm \
  -e PGDATABASE=does-not-exist migrate
docker compose -f examples/compose/compose.yaml up -d 2>&1 | tail -5
```

`api` and `worker` both declare
`depends_on: {migrate: {condition: service_completed_successfully}}`. When the
migration exits non-zero, that condition is never met, so Compose refuses to
start the services that depend on it — you get a clear "dependency failed to
start" rather than an API that boots against a schema that does not exist. A
`sleep` would have started the API anyway and produced a confusing runtime
error instead. `db` is gated with `service_healthy` on its `pg_isready`
healthcheck, so nothing runs before the database accepts connections. See
[Compose dependencies and healthchecks](compose-dependencies-and-healthchecks.md).

### 8. Compose watch rebuilds only what changed

```bash
docker compose -f examples/compose/compose.yaml up -d --wait
docker compose -f examples/compose/compose.yaml watch &
touch examples/app/cmd/api/main.go        # matches ../app/cmd -> api AND worker
touch examples/app/internal/store/store.go # matches ../app/internal -> api AND worker
```

Both files sit under paths that both services watch: the `api` service has
`rebuild` rules for `../app/cmd`, `../app/internal` and `../app/go.mod`, and the
worker has the first two. So editing anything under `cmd/` or `internal/`
rebuilds *both* images and recreates *both* services; only a `go.mod` change is
API-only. There is no `sync` rule because syncing Go source into a distroless
image is pointless — no compiler, no shell — so every change is a `rebuild`, and
the layer cache from exercise 2 is what keeps each rebuild fast. See
[Compose watch](compose-watch.md).

### 9. Compose profiles

```bash
docker compose -f examples/compose/compose.yaml config --services
docker compose -f examples/compose/compose.yaml \
  --profile load --profile observability config --services
```

```console include="captures/docker-intermediate/compose-services-default.txt"
```

```console include="captures/docker-intermediate/compose-services-profiles.txt"
```

The default `config --services` lists `db`, `migrate`, `api` and `worker`.
Adding the two profiles brings `loadgen` and `prometheus` into the list.
Because `--profile` on `config` never starts anything, this is the safe way to
see what an `up` *would* do. Start the load generator and check it is working:

```bash
docker compose -f examples/compose/compose.yaml --profile load up -d
docker compose -f examples/compose/compose.yaml logs --tail 5 loadgen
docker compose -f examples/compose/compose.yaml exec api /api healthcheck; echo $?
```

`loadgen` posts a task a second to `http://api:8080/tasks`. See
[Compose profiles, overrides and environment](compose-profiles-overrides-env.md).

### 10. Compose secrets and scaling

```bash
docker compose -f examples/compose/compose.yaml up -d --wait
docker compose -f examples/compose/compose.yaml exec api ls -l /run/secrets
docker compose -f examples/compose/compose.yaml exec api printenv | grep -i pgpassword
docker compose -f examples/compose/compose.yaml up -d --scale worker=3
docker compose -f examples/compose/compose.yaml ps
```

```console include="captures/docker-intermediate/compose-scale-worker.txt"
```

`ls /run/secrets` shows `db_password`, mounted read-only; `printenv` shows
`PGPASSWORD_FILE` (a path), never `PGPASSWORD` (a value) — so the password is a
file the process reads, not an environment variable that any child process or
`docker inspect` could leak. `--scale worker=3` starts `tasklane-worker-1`,
`-2` and `-3`; the worker is safe to scale because it claims rows with
`FOR UPDATE SKIP LOCKED`, so no two replicas take the same task, and it
publishes no host port. A service with a fixed published port cannot be scaled,
because a host port is unique and the replicas would collide. See
[Compose secrets, configs and scaling](compose-secrets-configs-scaling.md).

### 11. Clean up

```bash
docker compose -f examples/compose/compose.yaml down -v
docker rm -f lab-sig lab-hc lab-nr lab-api 2>/dev/null; true
docker image rm lab-api:hand lab-api:build 2>/dev/null; true
docker image rm tasklane-api:0.1.0 tasklane-worker:0.1.0 2>/dev/null; true
docker builder prune -f
docker system df
```

`down -v` removes the stack's containers, its networks and the `db-data`
volume — and the database with it. `docker system df` at the end should show no
lingering `lab-*` or `tasklane-*` containers or volumes. Keep the Tasklane
images if you are moving straight on to the Kubernetes parts, which load them
into kind with `kind load docker-image`.

## Common mistakes

- **Copying the whole build context before `go mod download`,** so every source
  edit re-resolves modules. Copy `go.mod`/`go.sum` first (exercise 2).
- **Expecting `docker kill` to shut down gracefully.** It sends `SIGKILL`,
  which cannot be trapped; only `docker stop` (`SIGTERM`) runs the drain.
- **Adding `curl` or a shell to a distroless image just to healthcheck it.**
  Have the binary check itself, as Tasklane does.
- **Testing writes against the distroless image directly.** It has no shell;
  use a small `busybox` container to demonstrate `--read-only`.
- **Using plain `depends_on` and blaming Compose** when the API cannot reach a
  database that is running but not yet ready. Gate on `service_healthy`.
- **Adding a `sync` watch rule for Go source** and wondering why nothing
  rebuilds; a compiled language needs `rebuild`.
- **Scaling a service that publishes a fixed host port,** then hitting a port
  conflict. Only the portless, stateless tier scales on one host.
- **Forgetting `down -v`,** and leaving the `db-data` volume behind to confuse
  the next run.

## Related topics

- [Tasklane with Compose](tasklane-with-compose.md)
- [Dockerfile instructions](dockerfile-instructions.md)
- [Multi-stage builds](multi-stage-builds.md)
- [Layer caching](layer-caching.md)
- [PID 1, signals and graceful shutdown](pid1-signals-graceful-shutdown.md)
- [Healthchecks](healthchecks.md)
- [Running as non-root](running-as-non-root.md)
- [Compose dependencies and healthchecks](compose-dependencies-and-healthchecks.md)
- [Compose watch](compose-watch.md)
- [Compose profiles, overrides and environment](compose-profiles-overrides-env.md)
- [Compose secrets, configs and scaling](compose-secrets-configs-scaling.md)
</content>
