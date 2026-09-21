---
title: The Docker socket is root
description: Why access to the daemon socket is equivalent to host root, demonstrated with a container escape and closed three ways.
level: advanced
type: concept
status: current
versions: Docker Engine 29
prerequisites:
  - docker-security/container-threat-model
  - docker-advanced/dind-vs-socket-mounting
---

## Overview

`/var/run/docker.sock` is the Docker Engine API exposed as a Unix socket.
Anything that can write to it can create containers, and a container can be
told to mount the host root filesystem and run as real root. There is no
privilege boundary between "can reach the socket" and "is root on the host":
they are the same power. This page shows the escape in a disposable lab and
closes it three ways.

:::danger Run only in a disposable VM or lab
The exploit below gives a container full root on its host, including read
access to `/etc/shadow`. Run it only on a throwaway VM or the Docker Desktop
VM, never on a workstation, a shared CI host, or anything with real data. The
runnable version is in
[`examples/security/docker/socket-escape/`](../../examples/security/docker/socket-escape/README.md).
:::

## Why it exists and when to use it

The daemon listens on the socket so the CLI, Compose and tooling can drive it.
Mounting the socket *into a container* is a popular shortcut: "the CI job needs
to build images", "the reverse proxy needs to watch container events", "the
agent manages other containers". Each of these grants host root to solve a
narrower problem. The technique to *use* is almost always a scoped alternative,
not the raw socket.

## How it works underneath

The API is not authenticated beyond filesystem permissions on the socket. The
socket is owned `root:docker`, so root and every member of the `docker` group
can use it. That is why **`docker` group membership is root-equivalent**: a
group member can run `docker run -v /:/host ... chroot /host`, which is game
over.

The escape does not exploit any bug. It uses the API exactly as designed:

1. The container has a client (`docker` CLI, or any HTTP client) and the socket.
2. It asks the daemon — which runs as root on the host — to create a new
   container with `--privileged` and the host's `/` bind-mounted at `/host`.
3. It `chroot`s into `/host`. The daemon did the privileged work; the "escape"
   is just consuming the result.

Because the daemon is root, the child container is root on the host filesystem.
`--privileged` additionally removes seccomp, gives all capabilities, and allows
device access, but even without it a plain host-root bind mount is catastrophic.

## Basic example

The vulnerable Compose file mounts the socket into a stand-in CI runner:

```yaml include="examples/security/docker/socket-escape/vulnerable/compose.yaml"
```

Bring it up and perform the escape (disposable host only):

```bash
docker compose -f vulnerable/compose.yaml up -d
docker compose -f vulnerable/compose.yaml exec ci-runner docker run --rm -v /:/host --privileged alpine:3.22 chroot /host sh -c 'id; head -n 3 /etc/shadow'
```

The maintainer's capture records the result:

```console include="captures/docker-security/socket-escape-id.txt"
```

## Explanation

`id` reports `uid=0(root)` and the host's password hashes are readable. From
here the attacker can add a user, drop a systemd unit, read every other
container's volumes, or install a rootkit. The container was never the boundary;
the socket handed over the host.

The same power is why a bind mount of the socket, `docker` group membership, an
exposed TCP daemon (`-H tcp://0.0.0.0:2375`), and Docker-in-Docker with a shared
socket are all treated identically in a threat model: each is host root.

## Common patterns

The fix is to remove the socket and meet the original need another way:

- **Give CI jobs a rootless builder, not the socket.** `docker buildx` backed
  by rootless BuildKit, or `buildah`/`kaniko`, build images with no privileged
  daemon at all.
- **Run rootless Docker.** The daemon runs as an unprivileged user, so even a
  socket compromise does not yield host root.
- **Put a scoped proxy in front of the socket.** When a component truly needs a
  slice of the API (event watching, read-only inspection), a socket proxy
  exposes only an allow-listed subset.

The fixed Compose file simply drops the mount:

```yaml include="examples/security/docker/socket-escape/fixed/compose.yaml"
```

The scoped-proxy alternative uses `ghcr.io/tecnativa/docker-socket-proxy`
(verified active and not archived, 2026-09-21). Unset capabilities default to
denied, and `POST: "0"` refuses every mutating call, so the runner can list but
never create:

```yaml include="examples/security/docker/socket-escape/fixed/socket-proxy.compose.yaml"
```

## Production considerations

- **Never give the socket to CI runners.** This is the single most common
  root-equivalent misconfiguration in the wild. Prefer rootless build tooling.
- **Treat `docker` group membership as granting root.** Audit it the way you
  audit `sudo`. On multi-user hosts, do not add developers to the `docker`
  group casually.
- **Never expose the daemon on TCP without mTLS**, and prefer not to expose it
  at all. An unauthenticated `tcp://` daemon is scanned and exploited within
  minutes on the public internet.
- If you must proxy the socket, pin the proxy image by digest, keep it
  read-only with dropped capabilities, and allow the narrowest set of API
  groups the consumer needs.

## Security considerations

A socket proxy reduces but does not eliminate risk: allowing `POST` on
containers or images can still be abused, and even read access leaks secrets
(environment variables, labels) from other containers. Grant the minimum, put
the proxy on an `internal` network, and keep it patched.

Rootless Docker is the strongest of the three fixes because it changes the
daemon's own privilege, not just who can reach it. Its trade-offs (cgroup
resource limits need cgroup v2 + systemd; some networking differences) are
covered in [rootless Docker](../docker-advanced/rootless-docker.md).

## Troubleshooting

- **"My tool needs container events."** Use a read-only socket proxy with only
  the `EVENTS`/`CONTAINERS` groups enabled, not the raw socket.
- **"The CI build fails without the socket."** Switch the build to `buildx`
  with a rootless BuildKit builder or to `kaniko`; neither needs the daemon.
- **After the fix, `docker ... info` inside the container fails to connect.**
  That is correct — there is no longer a socket to reach.

## Common mistakes

- Mounting the socket "just to build images" and calling it low risk.
- Adding users to the `docker` group as a convenience without realising it is
  equivalent to passwordless `sudo`.
- Exposing `tcp://0.0.0.0:2375` for remote access with no TLS.
- Assuming `--privileged` is required for the escape; a host-root bind mount
  alone is enough.
- Trusting a socket proxy configured with `POST: "1"`, which re-opens the
  create/start/exec path.

## Related topics

- [The container threat model](container-threat-model.md)
- [DinD vs socket mounting](../docker-advanced/dind-vs-socket-mounting.md)
- [Rootless Docker](../docker-advanced/rootless-docker.md)
- [Docker in CI](../docker-advanced/docker-in-ci.md)
- [User namespaces in Docker](user-namespaces-docker.md)
