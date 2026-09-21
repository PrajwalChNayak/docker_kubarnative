---
title: Container lifecycle
description: The six states a container passes through, how stop, kill, pause and restart policies drive them, and what exit codes tell you.
level: beginner
type: concept
status: current
versions: Docker Engine 29
prerequisites:
  - docker-beginner/running-containers
---

## Overview

A container is a record in the daemon's database plus, while it runs, a
process tree. The record outlives the process: that is why `docker ps` shows
nothing and `docker ps -a` shows a dozen dead containers holding disk space.

The daemon reports the record's state in `State.Status`, which takes one of
these values: `created`, `running`, `paused`, `restarting`, `removing`,
`exited` and `dead`. Understanding which command moves a container between
them removes most of the mystery from "why is it not starting".

## Why it exists and when to use it

The split between create and start exists so that everything expensive and
fallible — pulling, unpacking, allocating a network address, validating
mounts — happens before anything runs. `docker create` gives you a container
you can inspect and start later; `docker run` just does both.

The split matters in practice when you want to know *where* a failure
happened. A container that never left `created` failed during setup. A
container in `exited` with code 1 ran your program and your program failed.
Those are completely different investigations.

## How it works underneath

| State | What it means | How you get there |
|---|---|---|
| `created` | Configuration and filesystem are ready, no process exists yet | `docker create`, or `docker run` momentarily |
| `running` | PID 1 is executing | `docker start`, `docker run`, `docker unpause`, `docker restart` |
| `paused` | All processes frozen in place, memory retained | `docker pause` |
| `restarting` | The restart policy is waiting out its backoff before starting again | A non-zero exit under `on-failure`, or any exit under `always` |
| `removing` | The daemon is tearing the container down | `docker rm` on a large container |
| `exited` | PID 1 has returned; the writable layer and config remain | The process ended, or `docker stop`/`docker kill` |
| `dead` | The daemon could not remove the container cleanly | Rare: a stuck mount, an unresponsive filesystem |

**Stopping** is a two-phase protocol. `docker stop` sends `SIGTERM` (or the
image's `STOPSIGNAL`, or `--signal`), waits for the timeout (10 seconds by
default, `-t` to change it), and only then sends `SIGKILL`. A process that
handles `SIGTERM` exits with its own code, usually 0. A process that ignores
it is killed, and the exit code becomes 137 (128 + 9).

**Killing** skips the polite phase: `docker kill` sends `SIGKILL` immediately.

**Pausing** uses the cgroup v2 freezer, not a signal. The processes do not
know they were paused, so no timers fire and no connection is closed — and
nothing inside can react to it either.

**Removing** deletes the record and the writable layer. Named volumes survive;
anonymous volumes go only with `docker rm -v` or `--rm`.

### Restart policies

`--restart` is the daemon's little supervisor. It is not a scheduler: it only
restarts a container on the same host, and only while the daemon runs.

| Policy | Behaviour |
|---|---|
| `no` | "Don't automatically restart the container. (Default)" |
| `on-failure[:max-retries]` | "Restart the container if it exits due to an error, which manifests as a non-zero exit code", at most `max-retries` times |
| `always` | "Always restart the container if it stops." A manually stopped container restarts when the daemon restarts |
| `unless-stopped` | Like `always`, except a container you stopped stays stopped across daemon restarts |

Two details from the documentation that explain most confusion:

- "A restart policy only takes effect after a container starts successfully…
  the container is up for at least 10 seconds and Docker has started
  monitoring it."
- "An increasing delay (double the previous delay, starting at 100
  milliseconds) is added before each restart to prevent flooding the server."

So a container that crashes instantly does not spin the CPU: it backs off,
appearing in `restarting` between attempts. Kubernetes reuses this idea and
calls the result `CrashLoopBackOff`.

## Basic example

Four containers, one in each of the states you will actually see:

```bash
docker create --name state-created alpine:3.22 sleep 300
docker run -d --name state-running alpine:3.22 sleep 300
docker run -d --name state-paused alpine:3.22 sleep 300
docker pause state-paused
docker run --name state-exited alpine:3.22 sh -c 'exit 3'
docker ps -a --filter name=state- --format 'table {{.Names}}\t{{.State}}\t{{.Status}}'
```

```console include="captures/docker-beginner/ps-states.txt"
```

Note that `docker ps` alone would show only one of them. `-a` includes
everything.

## Explanation

The exit code is the single most useful number in this page's output. Docker
reports the container's `State.ExitCode`:

| Code | Meaning |
|---|---|
| 0 | The process finished successfully. Normal for jobs, suspicious for servers |
| 1–125 | The program's own failure code |
| 125 | The daemon could not start the container at all |
| 126 | The command was found but is not executable |
| 127 | The command was not found in the image |
| 137 | `SIGKILL` (128 + 9): stop timeout expired, `docker kill`, or an out-of-memory kill |
| 143 | `SIGTERM` (128 + 15): terminated and did not handle the signal itself |

For 137, check `State.OOMKilled` to distinguish "killed by the kernel for
exceeding `--memory`" from "killed by Docker for not stopping in time".

Graceful shutdown is worth seeing in a real program. The Tasklane API handles
`SIGTERM` by failing readiness, waiting `SHUTDOWN_DELAY_SECONDS`, then
draining in-flight requests:

```bash
docker run -d --name stop-demo -e SHUTDOWN_DELAY_SECONDS=2 tasklane-api:0.1.0
docker stop stop-demo
docker inspect --format 'status={{.State.Status}} exitcode={{.State.ExitCode}}' stop-demo
docker logs stop-demo
```

```console include="captures/docker-beginner/stop-sigterm.txt"
```

Compare with `docker kill`, which gives the process no chance to do any of
that:

```console include="captures/docker-beginner/kill-sigkill.txt"
```

A failing container under a restart policy shows the backoff and the retry
limit:

```bash
docker run -d --name restart-demo --restart on-failure:3 alpine:3.22 sh -c 'echo attempt; exit 1'
docker inspect --format 'status={{.State.Status}} restartcount={{.RestartCount}}' restart-demo
```

```console include="captures/docker-beginner/restart-on-failure.txt"
```

## Common patterns

**Restart a service after config changes**: you cannot. `docker restart`
reuses the original configuration. Changing a flag means `docker rm -f` plus a
new `docker run` — which is exactly the friction that motivates Compose.

**Run a job and capture its result**

```bash
docker run --rm --name migrate tasklane-api:0.1.0 migrate
echo $?
```

Foreground plus `--rm` means the shell gets the exit code and nothing is left
behind. Stage 1 of Tasklane runs its migration this way.

**Give a slow server more time to stop**

```bash
docker stop -t 30 tasklane-api
```

**Clean up the graveyard**

```bash
docker ps -a --filter status=exited
docker container prune -f
```

## Production considerations

- Use `unless-stopped` rather than `always` for services you sometimes stop on
  purpose during maintenance.
- Make the stop timeout longer than the application's drain time, otherwise
  `SIGKILL` cuts connections. Set `--stop-timeout` on the container so anyone
  running `docker stop` inherits it.
- Handle `SIGTERM` in the application. A shell wrapper that uses `sh -c` often
  swallows signals because the shell becomes PID 1 and does not forward them;
  Part C covers [PID 1 and signals](../docker-intermediate/pid1-signals-graceful-shutdown.md).
- Restart policies do not survive host failure, do not move work elsewhere, and
  do not know whether your process is healthy — only whether it exited.
  Wanting more than that is the reason Kubernetes exists.

## Security considerations

- A stopped container keeps its writable layer, including anything written to
  disk — logs, cached credentials, temporary files. `docker rm` deletes it;
  forgotten containers are a quiet data-retention problem.
- `docker pause` is not a security control. The processes resume with all
  their memory and open file descriptors.
- `--restart always` on a compromised container is a persistence mechanism: it
  comes back after every reboot. When responding to an incident, remove the
  container rather than stopping it.
- Exit code 137 with `OOMKilled: true` can be a denial-of-service signal, not
  just a sizing mistake.

## Troubleshooting

- **"Container is not running" on `exec`.** Check `docker ps -a`; it exited.
- **Container stuck in `restarting`.** It crashes at startup; read
  `docker logs` for the last attempt and check `RestartCount`.
- **`docker stop` takes 10 seconds every time.** The process ignores
  `SIGTERM`, so the timeout always expires. Fix the signal handling.
- **Container in `dead`.** Usually a wedged mount. `docker rm -f` may fail;
  this is one of the rare cases where the daemon needs a restart.
- **`docker rm` refuses.** The container is running. Stop it first, or use
  `-f`, which stops and removes in one step.

## Common mistakes

- **Treating exit code 0 as success for a server.** Your server returned; find
  out why.
- **Using `docker kill` habitually.** It bypasses graceful shutdown and, for
  the Tasklane worker, leaves a task stuck in `processing` because the release
  path never runs.
- **Expecting `--restart` to fix a broken image.** It will retry forever
  (`always`) and hide the real error.
- **Forgetting `-a`** and concluding a container "disappeared".
- **Running `docker rm -f` on the database container** and expecting data
  loss. With a named volume the data survives; without one it does not.

## Related topics

- [Running containers](running-containers.md)
- [Inspect, logs and exec](inspect-logs-exec.md)
- [Cleanup and disk usage](cleanup-and-disk-usage.md)
- [PID 1, signals and graceful shutdown](../docker-intermediate/pid1-signals-graceful-shutdown.md)
- [Healthchecks](../docker-intermediate/healthchecks.md)
- [CrashLoopBackOff](../troubleshooting/crashloopbackoff.md)
- [OOMKilled](../troubleshooting/oomkilled.md)
