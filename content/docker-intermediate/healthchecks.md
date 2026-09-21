---
title: Healthchecks
description: How Docker health status works, how Compose gates startup on it, and why Kubernetes ignores HEALTHCHECK entirely.
level: intermediate
type: concept
status: current
versions: Docker Engine 29, Compose v5
prerequisites:
  - docker-intermediate/dockerfile-instructions
  - docker-intermediate/entrypoint-vs-cmd
---

## Overview

A `HEALTHCHECK` tells the daemon how to ask a container whether it is working.
The daemon runs the command inside the container on a schedule and keeps a
health status alongside the normal container state: `starting`, `healthy` or
`unhealthy`.

The status is metadata. Docker does not restart an unhealthy container by
itself. What makes healthchecks useful is what *consumes* the status:
`docker ps`, Compose's `depends_on: service_healthy`, Swarm, and your own
scripts.

## Why it exists and when to use it

"The process is running" and "the service works" are different claims. A web
server stuck in a loop, a worker that lost its database connection and a
connection pool that has deadlocked are all running. The docs give exactly
this example: detecting "a web server that is stuck in an infinite loop and
unable to handle new connections, even though the server process is still
running".

In local and Compose-based workflows, a healthcheck is also the only
dependency primitive that means "ready" rather than "started".

## How it works underneath

Syntax and defaults:

```dockerfile title="healthcheck-syntax.Dockerfile" fragment
HEALTHCHECK [--interval=30s] [--timeout=30s] [--start-period=0s] \
            [--start-interval=5s] [--retries=3] \
            CMD <command>
HEALTHCHECK NONE
```

- The first check runs `interval` after the container starts, then `interval`
  after each check completes. During the start period, checks run every
  `start-interval` instead (`--start-interval` needs Engine 25.0 or later).
- A check that exceeds `timeout` is considered failed, and the process is
  killed with SIGKILL.
- It takes `retries` consecutive failures to move from `healthy` to
  `unhealthy`.
- During the start period, failures do not count towards `retries`. But once a
  check succeeds inside the start period, the container is considered started
  and subsequent failures do count.
- Exit codes: 0 healthy, 1 unhealthy, 2 reserved — do not use it.
- Output on stdout/stderr is stored in the health status, truncated to the
  first 4096 bytes, and shown by `docker inspect`. A health status change emits
  a `health_status` event.
- Only the last `HEALTHCHECK` in a Dockerfile takes effect; `HEALTHCHECK NONE`
  disables one inherited from a base image.

The check runs *inside* the container, as the container's user, sharing its
network namespace. That is why `localhost` in a healthcheck means the
container itself, and why a check counts against the container's CPU and
memory limits.

## Basic example

Tasklane's images have no shell, so the binary checks itself:

```dockerfile include="examples/app/Dockerfile" lines="48-50"
```

The `healthcheck` subcommand is a few lines of Go that fetch the liveness
endpoint and exit 0 or 1:

```go include="examples/app/internal/probe/probe.go" lines="1-10"
```

Compose declares a check for Postgres, where the image does ship a tool:

```yaml include="examples/compose/compose.yaml" lines="39-44"
```

## Explanation

Three design decisions are worth copying.

**The check is cheap and local.** It asks the process about itself over
loopback. It does not query the database, call a downstream service or run a
full self-test. A health check that depends on a dependency turns one outage
into an outage of everything that depends on it.

**Liveness and readiness are separate endpoints.** `/healthz` answers "is this
process able to serve at all" and never touches the database; `/readyz` answers
"should traffic come here now" and does ping the database. The Docker
`HEALTHCHECK` uses the liveness endpoint, because a failing readiness probe
during a database blip should not mark the container broken. Kubernetes gets
both, as separate probes.

**The check uses the same binary.** Distroless images contain no `curl`, no
`wget` and no shell, so the classic
`CMD curl -f http://localhost/ || exit 1` cannot work. Implementing a
`healthcheck` subcommand costs ten lines and removes a whole class of "the
probe binary is missing" problems.

Timing: `--start-period=5s` plus `--interval=10s --retries=3` means a
container has five seconds of grace, and then must fail three checks in a row —
about 30 seconds — before it is called unhealthy.

## Common patterns

**HTTP endpoint through the application binary.** As above. Works in
shell-less images.

**`CMD-SHELL` with a native tool.** For images that ship one:
`test: ["CMD-SHELL", "pg_isready -U tasklane -d tasklane"]`. In Compose, a
plain string is shorthand for `CMD-SHELL`; a list must start with `NONE`,
`CMD` or `CMD-SHELL`.

**Generous start period, tight interval.** Slow-starting runtimes (JVM, Rails)
want `--start-period=60s` rather than a long interval, so that a healthy
container is detected quickly once it is up.

**`HEALTHCHECK NONE` for one-shot containers.** A migration job that exits is
not unhealthy, it is finished. Use `service_completed_successfully` in Compose
rather than a health check.

**Disable an inherited check you disagree with.** Some base images ship
checks that are wrong for your use. `HEALTHCHECK NONE`, or Compose
`healthcheck: {disable: true}`.

**Use the status.** `docker ps` shows it; `docker inspect --format
'{{.State.Health.Status}}'` scripts it; Compose gates dependencies on it;
`docker compose up --wait` blocks until every service with a check is healthy.

## Production considerations

Docker does not act on health status on its own. If you want an unhealthy
container replaced, something must do it: Swarm does, Compose does not, and a
`restart: unless-stopped` policy reacts to exits, not to health. On a single
host, the honest answer is that an unhealthy container stays up until a human
or a script intervenes.

**Kubernetes ignores `HEALTHCHECK` completely.** The kubelet never reads it;
it runs its own `livenessProbe`, `readinessProbe` and `startupProbe` from the
Pod spec. Keeping the Dockerfile's `HEALTHCHECK` is still worthwhile — it is
what makes Compose and local runs behave — but the probes in the manifests are
the authority in a cluster. Where both exist, keep them consistent so that a
container that is healthy locally is ready in the cluster.

Cost is real: a check every 10 seconds in 300 containers is 30 processes per
second on the host. Prefer intervals in the tens of seconds for anything but
gating startup.

Health checks that write logs on every run drown the real logs. Keep the
output silent when healthy.

## Security considerations

- The check command runs inside the container with the container's
  privileges. Do not add `curl` or a shell to an otherwise minimal image just
  to have a health check; implement it in the application binary.
- A check that authenticates to a dependency needs that dependency's
  credentials at all times, widening the blast radius of a compromise. Check
  yourself, not your dependencies.
- Health endpoints frequently leak information: versions, hostnames,
  dependency status, stack traces. Keep them terse, and do not publish them
  outside the pod or host network.
- Health check output is stored in container metadata and visible to anyone
  who can run `docker inspect`. Do not print connection strings.

## Troubleshooting

**Status stays `starting` forever.** No check has succeeded yet and the start
period never ends because failures do not count. Look at the recorded output:

```bash
docker inspect --format '{{json .State.Health}}' <container>
```

**`unhealthy` although the service answers from the host.** The check runs
inside the container: `localhost` there is the container, and a check bound to
the host's published port will not work. Also verify the check's user can
execute the command.

**"OCI runtime exec failed: exec: \"curl\": executable file not found".** The
image has no `curl`. Use the application binary.

**The check works in a shell but not in the Dockerfile.** Exec-form
`HEALTHCHECK CMD ["/api", "healthcheck"]` does not run a shell, so `||`,
pipes and variables do not work. Use `CMD-SHELL` in Compose, or shell form in
the Dockerfile, if you need shell syntax.

**Compose never starts a dependent service.** Its dependency is not becoming
healthy; check the dependency's health first:

```console include="captures/docker-intermediate/compose-ps-health.txt"
```

## Common mistakes

- Making a healthcheck query the database, so a database blip marks every
  service unhealthy.
- Using exit code 2 to mean "something else". It is reserved.
- Expecting Docker to restart unhealthy containers. It does not.
- Expecting Kubernetes to use `HEALTHCHECK`. It does not.
- A `--timeout` longer than the `--interval`, which overlaps checks.
- `--start-period` too short for a slow runtime, so the container flaps
  between `starting` and `unhealthy` during rollout.
- Adding a shell to a distroless image only to run `curl -f`.

## Related topics

- [Every Dockerfile instruction](dockerfile-instructions.md)
- [PID 1, signals and graceful shutdown](pid1-signals-graceful-shutdown.md)
- [Compose dependencies and healthchecks](compose-dependencies-and-healthchecks.md)
- [Tasklane with Compose](tasklane-with-compose.md)
- [Probes](../k8s-intermediate/probes.md)
- [Failing probes](../troubleshooting/failing-probes.md)
