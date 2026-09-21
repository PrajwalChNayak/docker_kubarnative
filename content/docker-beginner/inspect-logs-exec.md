---
title: Inspect, logs and exec
description: The three commands you debug containers with, and what each one is really doing to the daemon, the log files and the kernel namespaces.
level: beginner
type: concept
status: current
versions: Docker Engine 29
prerequisites:
  - docker-beginner/container-lifecycle
---

## Overview

Three commands answer nearly every "what is this container doing?" question.
`docker inspect` prints the daemon's complete record of an object.
`docker logs` replays what the container wrote to stdout and stderr.
`docker exec` starts an extra process inside the container's namespaces.

They fail in different ways, and the failures are informative: `inspect` works
on a dead container, `logs` works on a dead container, `exec` does not,
because there are no namespaces left to join.

## Why it exists and when to use it

Containers hide their contents behind namespaces, so the usual host tools
(`ps`, `ls`, `tail /var/log/...`) show you nothing useful. These three
commands are the supported way through that boundary, and every higher-level
tool is built on them: `kubectl logs` and `kubectl exec` are the same ideas
with an API server in the middle.

Reach for them in this order. `docker ps -a` for state, `docker logs` for what
the application said, `docker inspect` for how the container was configured,
and `docker exec` only when you need to look around inside a *running*
container.

## How it works underneath

**inspect** is a plain API read: `GET /containers/{id}/json`. It returns the
container's configuration (`Config`), the flags you passed (`HostConfig`), the
runtime state (`State`), the mounts and the network settings. No process is
started and nothing is touched inside the container, so it works in every
state including `exited` and `dead`.

**logs** returns what the **logging driver** captured. The container's stdout
and stderr are pipes held by the shim; the daemon reads them and hands each
line to the driver. With the default `json-file` driver, every line becomes a
JSON object with a timestamp and stream name, written to a file under
`/var/lib/docker/containers/<id>/`. `docker logs` reads that file back, which
is why:

- `docker logs` works after the process has exited, but not after
  `docker rm`, which deletes the file;
- it shows only what went to stdout and stderr. A program that writes to
  `/var/log/app.log` inside the container logs to a file nobody collects;
- with `--log-driver none` there is nothing to read, and with some remote
  drivers `docker logs` is unavailable entirely.

The exact file path is in the inspect output as `LogPath`.

**exec** creates a new process in the existing container. The daemon asks
containerd for an exec on the running task; the shim's runtime calls `setns`
on the container's mount, PID, UTS, IPC and network namespaces, applies the
same cgroup, and then `execve`s your command. Consequences worth internalising:

- The exec'd process is **not** a child of PID 1. It appears in the container's
  PID namespace, but the application knows nothing about it.
- It sees the container's filesystem, so it can only run programs that exist
  **in the image**. A distroless image has no shell, so `docker exec ... sh`
  cannot work.
- Environment variables from the image and from `docker run -e` apply, but
  anything PID 1 set for itself at runtime does not.
- When the container stops, exec'd processes are killed with it.

```bash
docker exec exec-demo ps -o pid,user,args
docker exec exec-demo sh -c 'for n in pid mnt net uts; do echo "$n pid1=$(readlink /proc/1/ns/$n) exec=$(readlink /proc/self/ns/$n)"; done'
```

```console include="captures/docker-beginner/exec-namespaces.txt"
```

The namespace inode numbers printed for PID 1 and for the exec'd process are
what joining a namespace means: same inode, same namespace.

## Basic example

```bash
docker logs --timestamps --tail 4 logs-demo
docker inspect --format 'driver={{.HostConfig.LogConfig.Type}} path={{.LogPath}}' logs-demo
```

```console include="captures/docker-beginner/logs-basics.txt"
```

Both stdout and stderr end up in the same stream by default; `--details` and
the JSON log file distinguish them.

## Explanation

### inspect is a query language

The raw JSON is long. `--format` turns it into exactly the fact you need,
which is how scripts should read Docker state:

```bash
docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' tasklane-api
docker inspect --format '{{.State.Health.Status}}' tasklane-db
docker inspect --format '{{range .Mounts}}{{.Type}} {{.Name}} -> {{.Destination}}{{println}}{{end}}' tasklane-api
docker inspect --format '{{json .NetworkSettings.Networks}}' tasklane-api
docker image inspect --format '{{.Config.User}} {{json .Config.Entrypoint}}' tasklane-api:0.1.0
```

`docker inspect` works on containers, images, volumes and networks. Add
`--type` when a name is ambiguous.

### logs has the flags that matter

```bash
docker logs --follow tasklane-worker
docker logs --tail 100 tasklane-api
docker logs --since 10m tasklane-api
docker logs --until 2026-09-21T12:00:00Z --since 2026-09-21T11:00:00Z tasklane-api
docker logs --timestamps tasklane-api
```

`--since`/`--until` take either a timestamp or a relative value such as
`42m`. `--follow` streams until you interrupt it.

The default `json-file` driver performs **no rotation** unless you ask for it.
On a busy host that is how you fill a disk:

```bash
docker run -d --name logrot-demo --log-driver json-file --log-opt max-size=8k --log-opt max-file=3 alpine:3.22 sh -c 'i=0; while [ $i -lt 2000 ]; do i=$((i+1)); echo "log line $i"; done; sleep 2'
docker inspect --format 'opts={{json .HostConfig.LogConfig.Config}}' logrot-demo
```

```console include="captures/docker-beginner/logs-rotation.txt"
```

Set it once for every container in `daemon.json` instead:

```json title="/etc/docker/daemon.json"
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```

Existing containers keep their old configuration: "Existing containers don't
use the new logging configuration automatically." Recreate them to apply it.

The `local` driver is the documented alternative: it "performs log-rotation by
default, and uses a more efficient file format", with `max-size` 20m,
`max-file` 5 and compression enabled. Its files are not JSON and are not meant
to be read by other tools. [Logging drivers](../docker-advanced/logging-drivers.md)
covers shipping logs somewhere central.

### exec, and the images where it does not work

```bash
docker exec -it tasklane-db psql -U tasklane -d tasklane
docker exec -u 0 tasklane-api id
docker exec -e PGPASSWORD_FILE=/run/secrets/db_password tasklane-api /api healthcheck
```

The Tasklane images are distroless: one static binary, no shell, no `ls`, no
package manager. So the usual reflex fails, and the binary's own subcommand is
the way in:

```console include="captures/docker-beginner/exec-distroless.txt"
```

This is a feature, not a limitation. An image with no shell removes most of
what an attacker would use after getting code execution. The debugging answer
is not to add a shell to the production image; it is to attach a debug
container that brings its own tools — `docker debug` in Docker Desktop, and
`kubectl debug` ephemeral containers on Kubernetes.

### The neighbours: top, stats, port, diff

```bash
docker top tasklane-api
docker stats --no-stream
docker port tasklane-api
docker diff tasklane-api
```

```console include="captures/docker-beginner/top-and-stats.txt"
```

`docker top` lists the container's processes as seen from the host, `docker
stats` reads cgroup counters, and `docker diff` shows every file added,
changed or deleted in the writable layer — a quick way to find a container
that is writing where it should not.

## Common patterns

**Wait for health instead of sleeping**

```bash
until [ "$(docker inspect --format '{{.State.Health.Status}}' tasklane-db)" = healthy ]; do sleep 1; done
```

This is what `examples/docker-run/tasklane-docker-run.sh` does. A fixed
`sleep 10` is both slower and less reliable.

**Get the last error from a crashed container**

```bash
docker logs --tail 50 tasklane-api
docker inspect --format '{{.State.ExitCode}} {{.State.OOMKilled}} {{.State.Error}}' tasklane-api
```

**Run a throwaway toolbox on the container's network**

```bash
docker run --rm --network tasklane-net busybox:1.37-musl nslookup tasklane-db
```

When the container you care about has no tools, bring a container that does
and share the namespace you need.

**Follow two containers at once**: you cannot, with `docker logs`. That is one
of the small conveniences `docker compose logs -f` adds in Part C.

## Production considerations

- Applications should log to stdout/stderr as structured lines (the Tasklane
  binaries emit JSON via `log/slog`). Anything else needs a log agent inside
  the container, which is a second process to supervise.
- Configure rotation globally in `daemon.json` before you need it. A full
  `/var/lib/docker` takes down every container on the host.
- `docker logs` is a debugging tool, not a log pipeline. Ship logs to a
  central system; see [logging architectures](../operations/logging-architectures.md).
- Treat `docker exec` in production as an exception that is worth alerting on.
  Changes made that way are invisible to your deployment tooling and vanish on
  the next restart.
- `docker stats` is fine for a glance; use real metrics for anything you want
  to alert on.

## Security considerations

- Anyone who can run `docker exec` can run any program in the container,
  including as root with `-u 0`. Access to the daemon is access to everything.
- Logs leak. Request bodies, tokens in URLs and environment dumps all end up
  readable by anyone with `docker logs` or access to the log files. Scrub
  before logging, not after.
- `docker inspect` prints every environment variable, which is the main reason
  secrets do not belong in `-e`. See
  [Environment variables](environment-variables.md#security-considerations).
- Do not add a shell or a package manager to a production image just to make
  `exec` convenient; that trade is strongly in the attacker's favour.

## Troubleshooting

| Message | Meaning |
|---|---|
| `Error: No such container` | Wrong name, or the container was removed (`--rm`) |
| `Container ... is not running` (`exec`) | It exited. Use `docker logs` and `docker ps -a` |
| `exec: "sh": executable file not found in $PATH` | The image has no shell (distroless, scratch) |
| `docker logs` prints nothing | The process writes to a file, or the driver is `none`, or it has not written yet |
| `configured logging driver does not support reading` | A remote driver is in use; read the logs at their destination |

## Common mistakes

- **Using `docker exec` to fix something.** The change is gone at the next
  recreate. Fix the image or the configuration.
- **`docker exec -it` in a script.** No TTY exists; the command hangs or fails.
- **Assuming logs are complete.** Buffered output may not have flushed, and
  anything written to a file inside the container is not there at all.
- **Deleting a container before reading its logs.** `docker rm` deletes the
  log file too.
- **Reading `/var/lib/docker/containers/...` with external tools.** The docs
  warn against it for the `local` driver, and the format can change.
- **Believing `docker inspect` shows live values.** `Config.Env` is what the
  container was created with, not what the process has now.

## Related topics

- [Container lifecycle](container-lifecycle.md)
- [Environment variables](environment-variables.md)
- [Cleanup and disk usage](cleanup-and-disk-usage.md)
- [Healthchecks](../docker-intermediate/healthchecks.md)
- [Logging drivers](../docker-advanced/logging-drivers.md)
- [Troubleshooting method](../troubleshooting/method.md)
- [Debugging basics on Kubernetes](../k8s-beginner/debugging-basics.md)
