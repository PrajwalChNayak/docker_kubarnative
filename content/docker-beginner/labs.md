---
title: Labs - Docker for beginners
description: Ten exercises that exercise every command in Part B, ending with the Tasklane stack running on your own machine.
level: beginner
type: lab
status: current
versions: Docker Engine 29
prerequisites:
  - docker-beginner/tasklane-with-docker-run
---

## Overview

Ten exercises, roughly 90 minutes. Each one is a task plus a way to check
yourself; the solutions give the commands and say what to look for. Nothing
here needs a cluster, a cloud account or a registry account.

Work through them in order — several build on containers created earlier — and
clean up at the end with the final exercise.

## Setup

You need Docker Engine 29 or Docker Desktop, a shell, `curl`, and this
repository checked out. Run everything from the repository root.

```bash
docker version
docker info --format '{{.ServerVersion}} {{.Driver}}'
```

Build the two Tasklane images once; exercises 7 to 10 use them:

```bash
docker build --target api    -t tasklane-api:0.1.0    examples/app
docker build --target worker -t tasklane-worker:0.1.0 examples/app
```

Everything created below is named `lab-*` or `tasklane-*`, so the cleanup in
exercise 10 can find it.

## Exercises

### 1. First containers

1. Run `alpine:3.22` so that it prints its own hostname and exits, leaving no
   container behind.
2. Run it again with a name of your choosing, without `--rm`, and find it with
   a `docker ps` command.
3. Explain, in one sentence, why the container exited.

### 2. States

Produce four containers at once, one in each of `created`, `running`,
`paused` and `exited`, and print a single table showing all four names and
states. Then make the exited one's exit code be 3 rather than 0.

### 3. Stop versus kill

1. Start `tasklane-api:0.1.0` with `SHUTDOWN_DELAY_SECONDS=2` (it needs no
   database to start).
2. Stop it gracefully and read its logs. What did it print, and what exit code
   did it end with?
3. Start it again, `docker kill` it, and compare the exit code.
4. Which of the two leaves the Tasklane worker's in-flight task stuck in
   `processing`, and why?

### 4. Restart policies

Start a container that exits with code 1 immediately, under
`--restart on-failure:3`. Watch the `restarting` state, then report the
`RestartCount` and final status. Now explain why the daemon did not consume
100% CPU retrying.

### 5. Tags and digests

1. Show the digests of the local `postgres` images.
2. Ask the registry what `postgres:18-trixie` is, without pulling it.
3. Decide which digest you would paste into a Dockerfile, and say why.
4. Check whether your locally built `tasklane-api:0.1.0` has a `RepoDigest`,
   and explain the result.

### 6. Logs and exec

1. Run a container that prints ten numbered lines, one per second, then exits.
   Show only the last three, with timestamps.
2. Find where the daemon stored those logs.
3. Start `alpine:3.22` with `sleep 300`, then use `docker exec` to list its
   processes and to show that the exec'd process is in the same PID namespace
   as PID 1.
4. Try `docker exec -it <tasklane-api container> sh`. Explain the error, then
   get useful information out of that container anyway.

### 7. Publishing

1. Run the API publishing container port 8080 to host port 8089, reachable
   only from your own machine, and `curl` `/`.
2. Show the mapping with two different commands.
3. Repeat with `-P` instead and explain where the host port number came from.
4. Why can another machine on your network not reach the first container?

### 8. Networks, environment and secrets

1. Create a network, start PostgreSQL 18 on it with no published port, and
   from a second, throwaway container on the same network prove that the name
   `tasklane-db` resolves.
2. Start a container with `-e PGPASSWORD=hunter2` and show the value using
   only `docker inspect`. Name two other places that value is now visible.
3. Rework it so the password comes from a file at `/run/secrets/db_password`
   and `PGPASSWORD_FILE` points at it.

### 9. Volumes

1. Create a named volume, write a file into it from one container, and read it
   back from a second container that mounts it read-only. Confirm that the
   read-only container cannot write.
2. Start the Tasklane stack, create a task, remove every container, start the
   stack again and show that the task is still there.
3. Show the disk that the images, containers and volumes on your machine are
   using, then remove **only** the containers labelled by the stage-1 script.

### 10. Clean up

Remove everything the labs created — containers, the lab volume, the network —
without touching anything else on the machine, and verify with
`docker system df` that the reclaimable space went down.

## Solutions

### 1. First containers

```bash
docker run --rm alpine:3.22 hostname
docker run --name lab-hostname alpine:3.22 hostname
docker ps -a --filter name=lab-hostname
```

The container exits because its PID 1 — `hostname` — finished. A container
lives exactly as long as its first process; there is nothing else to keep it
running. The first invocation left nothing behind because `--rm` deleted the
container on exit; the second is still listed by `docker ps -a`.

### 2. States

```bash
docker create --name lab-created alpine:3.22 sleep 300
docker run -d --name lab-running alpine:3.22 sleep 300
docker run -d --name lab-paused alpine:3.22 sleep 300
docker pause lab-paused
docker run --name lab-exited alpine:3.22 sh -c 'exit 3'
docker ps -a --filter name=lab- --format 'table {{.Names}}\t{{.State}}\t{{.Status}}'
docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' lab-exited
```

`docker create` stops after the filesystem and configuration are ready, so
nothing has run yet. `docker pause` uses the cgroup freezer, so the processes
are still there, just not scheduled. The shape of this output is in
[Container lifecycle](container-lifecycle.md#basic-example):

```console include="captures/docker-beginner/ps-states.txt"
```

### 3. Stop versus kill

```bash
docker run -d --name lab-stop -e SHUTDOWN_DELAY_SECONDS=2 tasklane-api:0.1.0
docker stop lab-stop
docker inspect --format 'status={{.State.Status}} exit={{.State.ExitCode}}' lab-stop
docker logs lab-stop
docker run -d --name lab-kill -e SHUTDOWN_DELAY_SECONDS=2 tasklane-api:0.1.0
docker kill lab-kill
docker inspect --format 'status={{.State.Status}} exit={{.State.ExitCode}}' lab-kill
```

```console include="captures/docker-beginner/stop-sigterm.txt"
```

```console include="captures/docker-beginner/kill-sigkill.txt"
```

`docker stop` sends `SIGTERM` and waits (10 seconds by default), so the API
runs its shutdown path: fail readiness, wait `SHUTDOWN_DELAY_SECONDS`, drain,
exit with its own code. `docker kill` sends `SIGKILL`, which cannot be
handled; the exit code becomes 137 (128 + 9).

It is `docker kill` that strands work: the worker's SIGTERM path calls
`Release` to put a claimed task back to `pending`. With `SIGKILL` that code
never runs and the row stays `processing`.

### 4. Restart policies

```bash
docker run -d --name lab-restart --restart on-failure:3 alpine:3.22 sh -c 'exit 1'
docker ps -a --filter name=lab-restart
docker inspect --format 'status={{.State.Status}} restarts={{.RestartCount}}' lab-restart
```

```console include="captures/docker-beginner/restart-on-failure.txt"
```

The daemon does not retry in a tight loop: "An increasing delay (double the
previous delay, starting at 100 milliseconds) is added before each restart to
prevent flooding the server." While it waits, the container's state is
`restarting`. With `on-failure:3` it stops trying after three attempts;
`always` would keep going forever, which is how a broken image hides its own
error.

### 5. Tags and digests

```bash
docker image ls --digests postgres
docker buildx imagetools inspect postgres:18-trixie
docker image inspect tasklane-api:0.1.0 --format '{{json .RepoDigests}}'
```

```console include="captures/docker-beginner/imagetools-index.txt"
```

Paste the **index** digest — the one `imagetools inspect` reports for the
reference itself, not one of the per-platform manifests below it. The index
digest resolves correctly on amd64 and arm64; a platform manifest digest
pins you to one architecture.

`RepoDigests` is empty for `tasklane-api:0.1.0` because a digest is assigned
by a registry when the manifest is stored, and this image has never been
pushed.

### 6. Logs and exec

```bash
docker run -d --name lab-logs alpine:3.22 sh -c 'i=0; while [ $i -lt 10 ]; do i=$((i+1)); echo "line $i"; sleep 1; done'
docker logs --timestamps --tail 3 lab-logs
docker inspect --format 'driver={{.HostConfig.LogConfig.Type}} path={{.LogPath}}' lab-logs

docker run -d --name lab-exec alpine:3.22 sleep 300
docker exec lab-exec ps -o pid,user,args
docker exec lab-exec sh -c 'readlink /proc/1/ns/pid; readlink /proc/self/ns/pid'
```

```console include="captures/docker-beginner/logs-basics.txt"
```

```console include="captures/docker-beginner/exec-namespaces.txt"
```

The two `readlink` results print the same namespace inode: `exec` joins the
existing namespaces with `setns` rather than creating new ones.

`docker exec ... sh` on a Tasklane container fails with
`executable file not found` because the distroless image contains one static
binary and no shell. Useful information is still available from outside — and
the binary's own subcommand works:

```bash
docker exec <container> /api healthcheck
docker logs <container>
docker inspect <container>
```

```console include="captures/docker-beginner/exec-distroless.txt"
```

### 7. Publishing

```bash
docker run -d --name lab-port -p 127.0.0.1:8089:8080 tasklane-api:0.1.0
curl -s http://127.0.0.1:8089/
docker port lab-port
docker ps --filter name=lab-port --format 'table {{.Names}}\t{{.Ports}}'

docker rm -f lab-port
docker run -d --name lab-port -P tasklane-api:0.1.0
docker port lab-port
```

```console include="captures/docker-beginner/port-publish.txt"
```

```console include="captures/docker-beginner/port-publish-all.txt"
```

`-P` publishes every port the image declares with `EXPOSE` — 8080 for the API
image — on an ephemeral host port the daemon picks. `EXPOSE` itself publishes
nothing; it is metadata.

No other machine can reach the first container because the DNAT rule matches
only the `127.0.0.1` address. Drop the address and the same command would
publish on `0.0.0.0`, reachable from the network and not filtered by ufw.

### 8. Networks, environment and secrets

```bash
docker network create lab-net
docker run -d --name tasklane-db --network lab-net -e POSTGRES_PASSWORD=lab -e POSTGRES_USER=tasklane -e POSTGRES_DB=tasklane postgres:18-trixie
docker run --rm --network lab-net busybox:1.37-musl nslookup tasklane-db

docker run -d --name lab-env -e PGPASSWORD=hunter2 alpine:3.22 sleep 300
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' lab-env
```

```console include="captures/docker-beginner/env-inspect-leak.txt"
```

The value is also in `/proc/<pid>/environ` inside the container, in the
environment of every child process the application spawns, and in your shell
history on the host.

The file version:

```bash
docker volume create lab-secrets
printf 'hunter2' | docker run --rm -i --mount type=volume,src=lab-secrets,dst=/secrets busybox:1.37-musl sh -c 'cat > /secrets/db_password && chmod 0444 /secrets/db_password'
docker run -d --name lab-env-file --mount type=volume,src=lab-secrets,dst=/run/secrets,readonly -e PGPASSWORD_FILE=/run/secrets/db_password alpine:3.22 sleep 300
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' lab-env-file
```

Now the environment holds a path. That is the pattern the Tasklane stack uses
in every stage.

### 9. Volumes

```bash
docker volume create lab-data
docker run --rm --mount type=volume,src=lab-data,dst=/data alpine:3.22 sh -c 'echo hello > /data/note'
docker run --rm --mount type=volume,src=lab-data,dst=/data,readonly alpine:3.22 sh -c 'cat /data/note; touch /data/second || echo "write refused"'
```

```console include="captures/docker-beginner/volume-roundtrip.txt"
```

Persistence across the whole stack:

```bash
bash examples/docker-run/tasklane-docker-run.sh
curl -X POST -H 'Content-Type: application/json' -d '{"title":"survives"}' http://127.0.0.1:8088/tasks
bash examples/docker-run/tasklane-docker-cleanup.sh
bash examples/docker-run/tasklane-docker-run.sh
curl http://127.0.0.1:8088/tasks
```

```console include="captures/docker-beginner/tasklane-persistence.txt"
```

Disk usage and targeted cleanup:

```bash
docker system df
docker rm -f $(docker ps -aq --filter label=org.example.tasklane.stage=docker-run)
```

```console include="captures/docker-beginner/tasklane-df.txt"
```

The containers are gone; the volumes and images are not, because nothing
asked for them to be.

### 10. Clean up

```bash
bash examples/docker-run/tasklane-docker-cleanup.sh --volumes
docker rm -f lab-hostname lab-created lab-running lab-paused lab-exited lab-stop lab-kill lab-restart lab-logs lab-exec lab-port lab-env lab-env-file
docker volume rm lab-data lab-secrets
docker network rm lab-net
docker system df
```

Notice what you did **not** run: `docker system prune -a --volumes`. Removing
exactly what you created is a habit worth forming now, because the same
command on a server deletes images you cannot re-pull and volumes you cannot
recreate. See
[Cleanup and disk usage](cleanup-and-disk-usage.md#explanation).

## Common mistakes

- Running the exercises from a directory other than the repository root, so
  the `examples/...` paths do not resolve.
- Forgetting to build the two Tasklane images before exercise 3.
- Using `-it` in a command that is not interactive, then wondering why it
  hangs in a script.
- Leaving `lab-paused` paused: `docker rm -f` handles it, but `docker rm`
  alone will not.
- Expecting exercise 9's task list to be empty after cleanup. It is not, and
  that is the lesson.
- Reaching for `docker system prune -a` to tidy up at the end.

## Related topics

- [Container lifecycle](container-lifecycle.md)
- [Inspect, logs and exec](inspect-logs-exec.md)
- [Publishing ports](publishing-ports.md)
- [Volumes and bind mounts](volumes-and-bind-mounts-basics.md)
- [Cleanup and disk usage](cleanup-and-disk-usage.md)
- [Tasklane with docker run](tasklane-with-docker-run.md)
- [Labs - Docker intermediate](../docker-intermediate/labs.md)
