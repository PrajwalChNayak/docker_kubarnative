---
title: Docker CLI basics
description: How the docker command is organised, how it reaches a daemon, and the small set of flags and output formats you will use all day.
level: beginner
type: reference
status: current
versions: Docker Engine 29
prerequisites:
  - docker-beginner/install-docker
---

## Overview

`docker` is a thin HTTP client. Every command you type becomes one or more
requests to the Docker Engine API, which the daemon serves over a Unix socket
(`/var/run/docker.sock` on Linux), a named pipe on Windows, or TCP when
configured that way. The CLI holds almost no state: it does not know what
images exist or what containers are running until it asks.

That is why `docker ps` can fail with "Cannot connect to the Docker daemon"
even though the binary is installed, and why the same CLI can drive a local
daemon, a daemon in a VM or a remote one just by switching context.

## The command structure

Modern Docker groups commands by object:

```bash
docker container ls
docker image ls
docker volume ls
docker network ls
docker system df
```

The short forms you see everywhere — `docker ps`, `docker images`, `docker
run`, `docker rm` — are top-level aliases of the grouped commands and behave
identically. `docker ps` is `docker container ls`. Prefer the grouped form
when writing scripts: it says which object you mean.

The object groups you meet in this part:

| Group | Objects it manages | Typical commands |
|---|---|---|
| `container` | running and stopped containers | `run`, `create`, `start`, `stop`, `rm`, `logs`, `exec`, `inspect`, `ls` |
| `image` | local images | `pull`, `push`, `ls`, `inspect`, `history`, `tag`, `rm`, `prune` |
| `volume` | named and anonymous volumes | `create`, `ls`, `inspect`, `rm`, `prune` |
| `network` | container networks | `create`, `ls`, `inspect`, `connect`, `rm` |
| `system` | daemon-wide operations | `df`, `info`, `events`, `prune` |
| `buildx` | builds, and registry queries | `build`, `imagetools inspect` |
| `compose` | multi-container projects (Part C) | `up`, `down`, `ps`, `logs` |

## Getting help without leaving the terminal

`--help` works at every level and is generated from the binary you actually
have, so it never lies about your version:

```bash
docker --help
docker container --help
docker container run --help
docker image inspect --help
```

This is the fastest way to check whether a flag exists in Engine 29. If a
tutorial shows a flag your `--help` does not list, believe `--help`.

## Which daemon am I talking to?

```bash
docker context ls
docker context use desktop-linux
docker version
```

```console include="captures/docker-beginner/context-ls.txt"
```

The active context sets the API endpoint. `DOCKER_HOST` overrides it for a
single command. Docker Desktop creates and selects `desktop-linux`, which
points at the daemon inside its VM. Remote contexts over SSH are covered in
[Docker contexts](../docker-advanced/docker-contexts.md).

:::warning `sudo docker` ignores your context
`sudo` switches to root's home directory, so `~/.docker/config.json` and the
contexts you configured are not read. On a machine where you use both, expect
`docker ps` and `sudo docker ps` to disagree.
:::

## Output formatting

Almost every listing and inspect command accepts `--format` with a Go
template, plus the shorthands `json` and `table`. This is the difference
between eyeballing output and scripting it:

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
docker ps --format json
docker inspect --format '{{.State.Status}}' tasklane-api
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' tasklane-api
docker image inspect --format '{{.Config.User}}' tasklane-api:0.1.0
```

`docker inspect` returns the daemon's full JSON view of an object. Piping it
through a template is how the example scripts in this handbook wait for
health, read exit codes and find log paths, instead of parsing human output
that changes between releases.

## Filters

`--filter` (`-f`) is evaluated by the daemon, not by grep, so it is both
faster and reliable on large hosts:

```bash
docker ps --filter status=exited
docker ps -a --filter name=tasklane-
docker ps --filter label=org.example.tasklane.stage=docker-run
docker image ls --filter dangling=true
docker image ls --filter reference='tasklane-*'
```

Labels are the most useful of these. Label everything a script creates
(`--label`), then list and clean up by that label rather than by guessing
names. Stage 1 of the running example does exactly that; see
[Tasklane with docker run](tasklane-with-docker-run.md).

## Flags that behave differently than you expect

| Flag | Where it belongs | Note |
|---|---|---|
| `-d` / `--detach` | `docker run` | Prints the container ID and returns; the container keeps running |
| `-it` | `docker run`, `docker exec` | `-i` keeps stdin open, `-t` allocates a TTY. Both only make sense for interactive sessions |
| `--rm` | `docker run` | "Automatically remove the container and its associated anonymous volumes when it exits" |
| `-f` | `docker rm`, `docker logs`, `docker ps` | Force, follow and filter respectively. Same letter, three meanings |
| `-v` | `docker run`, `docker rm`, `docker volume` | Mount, remove-volumes, and part of the group name. Prefer `--mount` for clarity in `docker run` |
| `-p` vs `-P` | `docker run` | `-p` publishes one mapping you choose, `-P` publishes every `EXPOSE`d port on a random host port |

Everything after the image name is the command and its arguments, not flags
for Docker:

```bash
docker run --rm alpine:3.22 echo hello
docker run --rm -e GREETING=hi alpine:3.22 env
```

In the first line `--rm` is a Docker flag and `echo hello` runs inside the
container. Move `--rm` after `alpine:3.22` and it becomes an argument to the
container's command, which is a very common beginner error.

## An id is an id

Most commands accept a container or image by name, by full ID, or by any
unambiguous ID prefix:

```bash
docker logs tasklane-api
docker logs 9f2
```

Names are stable and readable; IDs are content or daemon identifiers. Always
pass `--name` when you start something you intend to look at again, otherwise
the daemon invents a name like `nostalgic_hopper` and your scripts cannot find
it.

## Exit codes

The CLI's exit code is usually the container's exit code for foreground
`docker run`, which makes it scriptable:

```bash
docker run --rm alpine:3.22 false
echo $?
```

`docker run` also has its own failure codes when the daemon cannot start the
container at all (for example 125 for a daemon-level error and 126/127 for
command not executable or not found). Those tell you the container never ran.

## Common mistakes

- **Putting Docker flags after the image name.** They are then passed to the
  process inside the container.
- **Parsing human-readable output with `grep`/`awk`.** Column widths and
  wording change between releases. Use `--format` and `--filter`.
- **Using the old hyphenated Compose command.** That is Compose v1, long EOL.
  The plugin is `docker compose`, two words.
- **Assuming a stopped container is gone.** Without `--rm` it stays on disk
  with its writable layer, visible only to `docker ps -a`.
- **Forgetting that `docker` needs a daemon.** "Cannot connect to the Docker
  daemon" is a connectivity or permission problem, not a missing binary.

## Related topics

- [Installing Docker](install-docker.md)
- [Running containers](running-containers.md)
- [Inspect, logs and exec](inspect-logs-exec.md)
- [Docker contexts](../docker-advanced/docker-contexts.md)
- [Docker CLI cheat sheet](../reference/docker-cli-cheat-sheet.md)
