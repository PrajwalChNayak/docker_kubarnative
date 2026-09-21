---
title: DinD vs socket mounting
description: Both ways of giving a container access to Docker trade away isolation. Know exactly what each one costs and which alternatives avoid the trade.
level: advanced
type: concept
status: current
versions: Docker Engine 29, Buildx 0.37
prerequisites:
  - docker-advanced/rootless-docker
  - docker-security/docker-socket-is-root
---

## Overview

A CI job that builds images needs Docker. Two answers dominate: run a second
Docker daemon inside the job container (**Docker-in-Docker**, DinD), or mount
the host's socket into the job (**socket mounting**, sometimes called
Docker-out-of-Docker).

Both hand out privileges that most people underestimate. There are better
options for the common case, and this page says when each one is acceptable.

## Why it exists and when to use it

Containers exist to isolate. A build job that must create containers needs to
talk to something that can. The three families of answer:

| Approach | What the job gets | Isolation cost |
|---|---|---|
| Socket mounting | The host daemon's API | **Root on the host**, effectively |
| DinD (`--privileged`) | Its own daemon, in a privileged container | Container confinement largely removed |
| Rootless DinD | Its own daemon, unprivileged inside | Much less; still needs `--privileged` for seccomp/AppArmor/mount masks |
| Rootless BuildKit / buildah / kaniko | A builder, no daemon | Smallest, if you only need builds |

The last row is where most teams should land, because "we need Docker" almost
always means "we need to build an image".

## How it works underneath

### Socket mounting

```bash
docker run -v /var/run/docker.sock:/var/run/docker.sock ...
```

The container gets a UNIX socket speaking the Docker API of the **host**
daemon. Containers it starts are siblings, not children: they run on the
host, share the host's networks and volumes, and outlive the job unless
cleaned up.

The privilege is total. The API includes "create a container with
`/` bind-mounted and `--privileged`", which is a two-command path to root on
the host. There is no permission model inside the Docker API that can prevent
this — access to the socket is access to everything. See
[the Docker socket is root](../docker-security/docker-socket-is-root.md).

Mounting the socket read-only changes nothing: the API is a protocol over
that socket, not a set of files.

### DinD

```bash
docker run --privileged -d --name dind docker:<version>-dind
```

A full daemon inside the container: its own containerd, its own storage
driver, its own image store. `--privileged` is required because the inner
daemon needs to create cgroups, mount filesystems and load kernel features —
and `--privileged` removes almost every confinement the outer container had,
including device access to the host's block devices.

Isolation between jobs is better (each job has its own image store), and
isolation from the host is worse than people assume: privileged is close to
root, with `CAP_SYS_ADMIN` and unmasked `/proc` and `/sys`.

Storage is the other cost: the inner daemon starts with an empty image store,
so every job pulls everything again.

### Rootless DinD

`docker:<version>-dind-rootless` runs as UID 1000 inside a user namespace.
The Docker documentation is explicit that `--privileged` is still required
"for disabling seccomp, AppArmor, and mount masks" — but an escape lands as
an unprivileged user rather than as root, which is a materially better
position. This is the best DinD variant if you must use DinD.

## Basic example

The rootless BuildKit alternative, from the BuildKit documentation:

```bash
docker run --name buildkitd -d \
  --security-opt seccomp=unconfined \
  --security-opt apparmor=unconfined \
  --security-opt systempaths=unconfined \
  moby/buildkit:rootless
```

Then point buildx at it without giving anyone a daemon. The endpoint is
whatever address that buildkitd was configured to listen on — over TLS in
anything but a lab:

```bash
docker buildx create --name remote --driver remote tcp://localhost:1234
docker buildx build --builder remote --target api -t tasklane-api:0.1.0 examples/app
```

The three `--security-opt` flags allow `unshare`/`mount` and give each build
step its own `/proc`; the documentation notes Kubernetes lacks an equivalent
of `systempaths=unconfined`, which is why the Kubernetes examples pass
`--oci-worker-no-process-sandbox` instead.

## Explanation

The important property of the BuildKit approach is the *shape* of the
privilege: the job can ask a builder to build, and nothing more. It cannot
enumerate the host's containers, mount host paths, or start a privileged
container. Compare that with the socket, where "build an image" and "take
over the machine" are the same permission.

In Kubernetes the same argument applies with more force, since the node runs
other tenants' pods. A pod with the node's container socket mounted owns the
node.

## Alternatives, honestly

| Tool | What it is | Status |
|---|---|---|
| **BuildKit rootless** | The same builder Docker uses, run unprivileged | Actively developed; `moby/buildkit:rootless` |
| **buildah** | Daemonless image builds; supports Dockerfiles and a scripting interface | Active, part of the Podman ecosystem |
| **kaniko** | Builds in a container without a daemon | The original `GoogleContainerTools/kaniko` repository was **archived in June 2025**. `chainguard-dev/kaniko` continues it as "a supported replacement", with security patches and maintenance but "no major feature work" |
| **Podman** | Daemonless, rootless by design; `podman build` | Active; see [Podman and alternatives](podman-and-alternatives.md) |
| **Managed builders** | Docker Build Cloud, or the buildx `kubernetes`/`remote` drivers | Moves the privilege to a system designed for it |

:::warning
Documentation and tutorials still present kaniko as a Google-maintained
project. It was archived in 2025; the maintained continuation is the
Chainguard fork, and the archived repository no longer publishes artefacts.
Verify the source before adopting it.
:::

## Common patterns

### Build with buildx, do not give out the socket

Most CI "we need Docker" requirements are satisfied by a builder. GitHub
Actions' `docker/setup-buildx-action`, GitLab's BuildKit integrations and a
shared `remote` builder all avoid both DinD and the socket.

### If you must mount the socket, isolate the runner

Dedicated machine, no other tenants, no untrusted pull requests, ephemeral,
and rootless where possible. Under rootless Docker, socket access is access
to *that user's* daemon, which is a much smaller prize.

### If you must use DinD, use rootless DinD

`docker:<version>-dind-rootless`, with a named volume for the inner daemon's
data directory (the image's own documentation names the path) so the image
store survives between jobs, and a registry cache so cold starts are cheap.

### Do not mix the two

A job that has both the host socket and an inner daemon is confusing to
reason about and usually the result of copying two tutorials. Pick one.

## Production considerations

Performance: DinD pulls everything again per job unless you give it a cache
volume, and a cache volume shared between jobs reintroduces cross-job
contamination. A registry cache backend is the cleaner answer; see
[remote build cache](remote-build-cache.md).

Storage drivers inside DinD can be slow depending on the nesting; overlay on
overlay is the common problem. Benchmark before committing a whole CI fleet.

Cleanup is a real operational cost with socket mounting. Sibling containers
belong to the host daemon, so a killed job leaves containers, volumes and
networks behind. Someone has to prune them, and pruning a shared host daemon
can destroy another job's work.

Kubernetes-based CI has no Docker daemon at all on modern nodes — the runtime
is containerd or CRI-O. "Mount the Docker socket" is not even available, and
that is a good thing. Use a builder.

## Security considerations

- **Socket access is root on the host.** Not "similar to root": an API call
  away. Treat any job with the socket as a job running as root.
- **`--privileged` is not a sandbox.** It grants `CAP_SYS_ADMIN`, device
  access and unmasked kernel interfaces. Escapes are routine, not exotic.
- **Untrusted pull requests must never touch either mechanism.** A PR from a
  fork runs attacker-supplied code; giving that code the socket is giving it
  your build fleet.
- **Rootless everything reduces the blast radius**, and does not remove it.
  A compromised build can still poison cache and steal registry credentials
  that the job legitimately holds.
- **Credentials in the job are part of the threat model.** Registry push
  tokens, signing identities and cloud roles are all available to whatever
  the build executes.
- The exploits demonstrating socket escape belong in a disposable lab, never
  on a shared machine. See
  [attack: privileged pod escape](../k8s-security/attack-privileged-pod-escape.md).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot connect to the Docker daemon` in a DinD job | Inner daemon not ready, or `DOCKER_HOST` unset | Wait for the daemon; set `DOCKER_HOST=tcp://docker:2376` with TLS as the image documents |
| Bind mounts in a socket-mounted job point at the host | Sibling containers resolve paths on the host | Use volumes, or a builder instead |
| Containers left behind after jobs | Siblings outlive the job | Explicit cleanup, or DinD, or a builder |
| DinD job slow on every run | Empty image store per job | Cache volume, or registry cache |
| `mount: permission denied` inside DinD | Missing privileges for the inner daemon | Rootless DinD with the documented flags |
| Builds work locally, fail on the Kubernetes runner | No daemon on the node | Use the buildx `kubernetes` or `remote` driver |

## Common mistakes

- Mounting the socket read-only and believing it is safer.
- Treating `--privileged` as a compatibility flag rather than a privilege
  grant.
- Running untrusted PR builds on a persistent socket-mounted runner.
- Choosing DinD for isolation and then sharing one cache volume between all
  jobs.
- Adopting kaniko from a tutorial without noticing the original project was
  archived in 2025.
- Reaching for either approach when a buildx builder would do.

## Related topics

- [Rootless Docker](rootless-docker.md)
- [Docker in CI](docker-in-ci.md)
- [BuildKit and buildx](buildkit-and-buildx.md)
- [Podman and alternatives](podman-and-alternatives.md)
- [The Docker socket is root](../docker-security/docker-socket-is-root.md)
- [Container threat model](../docker-security/container-threat-model.md)
