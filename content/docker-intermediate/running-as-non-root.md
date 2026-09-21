---
title: Running as non-root
description: Numeric UIDs, file ownership, why containers can bind port 80 without capabilities, and what non-root does and does not protect.
level: intermediate
type: concept
status: current
versions: Docker Engine 29, Compose v5
prerequisites:
  - docker-intermediate/dockerfile-instructions
  - docker-intermediate/choosing-base-images
---

## Overview

By default a container process runs as root — UID 0 inside the container,
and, without user namespaces, UID 0 on the host as well. Running as an
unprivileged user instead is the cheapest hardening step available: one `USER`
instruction, plus getting file ownership right.

It is not a sandbox. It removes a specific and very common escalation path: a
compromised process that can write to `/etc`, install packages, read every
mounted secret and, if a container escape exists, arrive on the host as root.

## Why it exists and when to use it

Containers isolate with namespaces and cgroups, not with a security boundary
as strong as a VM. Root in a container is root on the host kernel with a
reduced capability set. Every layer you remove — capabilities, write access,
privileged UID — shrinks what a bug turns into.

Always run non-root, unless the workload genuinely needs a privileged
operation (binding a raw socket for a network tool, managing devices). Those
cases exist and should be documented in a comment right where they happen.

## How it works underneath

`USER <uid>[:<gid>]` writes the user into the image config. The runtime
`setuid`s to it before `execve`. Rules that matter:

- Numeric IDs need no lookup. Names are resolved from `/etc/passwd` inside the
  image, which a distroless or scratch image may not have, and Kubernetes
  `runAsNonRoot` cannot validate a name at all — it needs a numeric UID.
- Specifying a group gives the user *only* that group: "when specifying a
  group for the user, the user will have only the specified group membership.
  Any other configured group memberships will be ignored."
- If the user has no primary group, the process runs with the root group.
- `USER` applies to later `RUN` steps too, so put it after the steps that need
  to write to system directories.

**Ports below 1024.** The traditional rule is that binding them requires
`CAP_NET_BIND_SERVICE`. In Docker it usually does not: when the container gets
its own network namespace, the daemon sets
`net.ipv4.ip_unprivileged_port_start=0` inside it. The moby source is explicit
— "allow opening any port less than 1024 without CAP_NET_BIND_SERVICE" — and
it applies when the network mode is private, not with `--network host` or when
joining another container's namespace, and the daemon only sets it if the
sysctl exists. So an unprivileged process in a normal Docker container can
bind port 80. Do not rely on that portability-wise: other runtimes and
configurations differ, and listening on 8080 costs nothing.

**File ownership.** The classic failure is a build that creates files as root
and a runtime that cannot write them. Fix it at copy time with
`COPY --chown=` rather than with a `RUN chown -R`, which duplicates the whole
tree into a new layer.

## Basic example

The Tasklane images run as UID 65532, the distroless `nonroot` user:

```dockerfile include="examples/app/Dockerfile" lines="41-45"
```

The Compose stack removes what the process could otherwise reach:

```yaml include="examples/compose/compose.yaml" lines="12-17"
```

## Explanation

`USER 65532:65532` is numeric, so nothing needs `/etc/passwd`, and Kubernetes
can verify `runAsNonRoot: true` against it. The `:nonroot` base image already
defaults to that UID; repeating it makes the intent explicit and survives a
base-image change.

`read_only: true` mounts the root filesystem read-only. Combined with a
non-root user it means an attacker cannot drop a binary anywhere that is
executable. Where the process needs scratch space, add a `tmpfs` mount for
exactly that path instead of making the whole filesystem writable.

`cap_drop: [ALL]` removes every Linux capability. A static Go binary listening
on 8080 needs none. `no-new-privileges:true` sets the `PR_SET_NO_NEW_PRIVS`
bit, so `setuid` binaries inside the container cannot raise privileges — which
defeats the classic "find a setuid helper" escalation.

The three settings work together: non-root decides *who*, capabilities decide
*what that identity may do in the kernel*, and read-only decides *what it may
change*.

## Common patterns

**Numeric UID in the image, matching security context in the orchestrator.**

```yaml title="k8s-security-context.yaml" fragment
# container securityContext, matching USER 65532:65532 in the image
securityContext:
  runAsNonRoot: true
  runAsUser: 65532
  runAsGroup: 65532
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: ["ALL"]
  seccompProfile:
    type: RuntimeDefault
```

**`COPY --chown` instead of `RUN chown -R`.** Ownership is set as the files
are copied, with no extra layer.

**Create a user when the base image has none.**

```dockerfile title="create-user.Dockerfile" fragment
RUN groupadd --gid 10001 app && useradd --uid 10001 --gid app --no-create-home app
USER 10001:10001
```

**Group-writable directories for arbitrary UIDs.** OpenShift and some
platforms run containers as a random UID with GID 0. Making the directories
the process writes owned by group 0 and group-writable (`chmod g=u`) keeps such
images portable.

**Unprivileged high ports.** Listen on 8080/8443 and publish `-p 80:8080`. The
mapping is free and removes the question entirely.

**Writable paths as explicit mounts.** `tmpfs` for `/tmp` and caches, named
volumes for data, everything else read-only.

## Production considerations

Volume permissions are where non-root gets stuck. A named volume is seeded
from the image's content at that path, including ownership, the first time it
is used; a bind mount keeps the host's ownership, which is almost never your
container UID. In Kubernetes, `fsGroup` fixes group ownership on supported
volume types; with Docker you set ownership in the image, or `chown` the host
path, or use an init container.

Pick and document a UID convention. 65532 (distroless `nonroot`) and 10001 are
common. Avoid UID 1000: it collides with the first human user on most Linux
hosts, which matters for bind mounts and for user-namespace mapping.

Rootless Docker is a different and complementary thing: the *daemon* runs as an
unprivileged user, so container root maps to your UID on the host. It does not
make the process inside non-root, and it has its own constraints (subordinate
UID ranges, cgroup v2 + systemd for resource limits). See
[rootless Docker](../docker-advanced/rootless-docker.md).

## Security considerations

- Non-root does not stop a container escape by itself; it removes the easiest
  ones. Combine with dropped capabilities, `no-new-privileges`, seccomp and a
  read-only root filesystem.
- Never mount the Docker socket into a container to "work around" permission
  problems. Access to `/var/run/docker.sock` is root on the host, full stop.
- `--privileged` disables essentially all of this. There is almost always a
  narrower flag (`--cap-add`, `--device`, a specific `--security-opt`).
- An image that runs as root can be forced non-root at runtime (`--user`,
  `runAsUser`), but only if its files are readable by that UID. Test it, do
  not assume it.
- Writable, executable paths are what turn code execution into persistence.
  Read-only root plus `noexec` scratch mounts breaks that chain.

## Troubleshooting

**`permission denied` writing to a mounted path.** Compare the UID the process
runs as with the ownership of the mount:

```bash
docker run --rm --entrypoint /bin/sh <image> -c 'id; ls -ln /data'
docker inspect --format '{{.Config.User}}' <image>
```

**`exec /app: permission denied`.** The binary is not executable by the
container user. `COPY --chmod=0755`.

**`user: unknown userid 65532`.** Something resolves the UID against
`/etc/passwd`, which the image lacks. Use a `:nonroot` base or ship a passwd
entry.

**The container works as root and fails as non-root.** Usually one of: a
write to a path that should be a volume or tmpfs, a file owned by root that
should have been `--chown`ed, or a package that insists on writing to its
install directory.

**A read-only root filesystem breaks startup.** Find what it writes
(`/tmp`, `/var/run`, a cache directory) and mount a tmpfs there rather than
dropping `read_only`.

## Common mistakes

- Running as root "for now" in the Dockerfile, and never coming back.
- `USER appuser` in an image with no `/etc/passwd` entry.
- `RUN chown -R` on a large tree, doubling the image size.
- Setting `USER` before the `RUN` steps that install packages, so the build
  fails.
- Assuming a non-root container cannot bind port 80 under Docker. It can, by
  default.
- Treating non-root as sufficient and leaving `--privileged`, mounted sockets
  or full capabilities in place.
- Using UID 1000 and then fighting bind-mount ownership on every developer's
  laptop.

## Related topics

- [Choosing base images](choosing-base-images.md)
- [Volumes, bind mounts and tmpfs](volumes-bind-mounts-tmpfs.md)
- [Dropping capabilities](../docker-security/dropping-capabilities.md)
- [Read-only root filesystem](../docker-security/read-only-root-filesystem.md)
- [No new privileges](../docker-security/no-new-privileges.md)
- [Security context](../k8s-security/security-context.md)
- [Rootless Docker](../docker-advanced/rootless-docker.md)
