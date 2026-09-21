---
title: Volumes, bind mounts and tmpfs
description: The three mount types in depth — initialisation behaviour, propagation, SELinux labels, and what Docker Desktop's VM changes.
level: intermediate
type: concept
status: current
versions: Docker Engine 29, Compose v5
prerequisites:
  - docker-beginner/volumes-and-bind-mounts-basics
---

## Overview

A container's writable layer disappears with the container. Anything that must
outlive it, or must be shared with the host, arrives through a mount. Docker
has three kinds:

| Type | Lives in | Managed by | Typical use |
|---|---|---|---|
| Volume | `/var/lib/docker/volumes/<name>/_data` on the daemon host | Docker | databases, application state |
| Bind mount | any host path | you | source code in development, host config |
| tmpfs | host memory | kernel | scratch space, secrets that must not touch disk |

They look similar in a `docker run` command and behave very differently.

## Why it exists and when to use it

Volumes exist so that data is decoupled from both the container and the host's
directory layout. Docker manages the location, so the same Compose file works
on every machine, and `docker volume` can back up, inspect and prune them.

Bind mounts exist for the cases where the host path *is* the point: editing
source code that a container runs, or handing a container a host config file.

tmpfs mounts exist for data that should never be written to disk at all, and
for making a read-only root filesystem workable.

## How it works underneath

All three end up as mounts in the container's mount namespace, performed by
the runtime before the process starts.

**Volume initialisation.** If you mount an *empty* volume over a directory
that has content in the image, the image's content is copied into the volume,
and that is a supported way to pre-populate data. If the volume is *not*
empty, the image content is hidden: "the pre-existing files are obscured by
the mount", and there is no way to reveal them again without recreating the
container. `volume-nocopy` disables the copy.

**Propagation.** Volumes use `rprivate` and it is not configurable. Bind
mounts default to `rprivate` and can be `shared`, `slave`, `private` or their
recursive variants — this controls whether mounts created *inside* the mounted
tree are visible on the other side. It only works on Linux hosts, and the docs
note that "mount propagation doesn't work with Docker Desktop". You need it
rarely: mostly for containers that themselves mount things, such as a CSI
driver or a backup agent.

**Recursive bind mounts.** Submounts under a bind-mounted path are included by
default. `--mount type=bind,bind-recursive=...` controls it, and recursive
*read-only* submounts require kernel 5.12 or newer; on older kernels submounts
silently stay read-write.

**SELinux labels.** On an SELinux host, a bind mount is unusable by the
container until it is relabelled. `:z` labels the content as shared between
containers, `:Z` as private to one. Both change labels on the *host* path —
the docs warn that using `:Z` on `/home` or `/usr` "renders your host machine
inoperable". SELinux labels can only be set with `-v`, not with `--mount`.

**tmpfs.** Linux only, never shared between containers, gone when the container
stops. It is memory: usage counts against the container's memory cgroup limit,
so a large `tmpfs-size` cannot give a container more RAM, and filling it can
OOM-kill the container. `tmpfs-size` defaults to 50% of host RAM and
`tmpfs-mode` to `1777`.

**Bind-mount source creation.** `-v /missing/path:/data` creates the host
directory (as a directory, owned by root). `--mount type=bind` errors instead,
unless you pass `bind-create-src`.

## Basic example

Tasklane's database keeps its data in a named volume:

```yaml include="examples/compose/compose.yaml" lines="35-38"
```

The path matters: the Postgres 18 image sets `PGDATA=/var/lib/postgresql/18/docker`,
so the volume is mounted one level up at `/var/lib/postgresql`.

## Explanation

On first start the volume is empty, so Docker seeds it from the image and
Postgres initialises the cluster inside it. On later starts the volume already
has content, so the image's version of that directory is hidden — which is
exactly what you want: the data wins, not the image.

Two failure modes follow directly:

- Mount the volume at the *wrong* path (`/var/lib/postgresql/data` for this
  image) and Postgres initialises somewhere that is not persisted. Everything
  works until the container is recreated.
- Change the image to a different major version and the existing volume still
  contains the old cluster. Postgres refuses to start, which is better than the
  alternative.

Bind mounts in the same stack are deliberately absent from `compose.yaml` and
appear only in the override file, where developer-only conveniences belong.

## Common patterns

**Named volume for state.** Databases, message queues, anything with a
durability guarantee. Never a bind mount into a laptop filesystem: the
performance and permission behaviour differ from production, and Docker
Desktop adds a VM boundary.

**Bind mount for source, in development only.** Compose Watch is usually
better for compiled languages; see [Compose watch](compose-watch.md).

**Read-only mounts for configuration.** `-v /etc/app/config.yaml:/etc/app/config.yaml:ro`,
or Compose `configs`. A config a container can rewrite is a config you cannot
reason about.

**tmpfs plus a read-only root filesystem.**

```yaml title="tmpfs-scratch.yaml" fragment
# service fragment: read-only root, writable scratch space only where needed
read_only: true
tmpfs:
  - /tmp:size=64m,mode=1777
```

**Anonymous volume to shadow a bind mount.** The classic
`-v $(pwd):/app -v /app/node_modules` trick: the second, anonymous volume
keeps the container's `node_modules` from being hidden by the host directory.

**`volume-subpath` to share one volume between containers** without giving
each the whole tree. The subdirectory must exist in the volume first.

**Back up a volume by mounting it into a throwaway container**, since there is
no `docker volume export`:

```bash
docker run --rm -v db-data:/data:ro -v "$PWD":/backup busybox:1.37-musl tar czf /backup/db-data.tgz -C /data .
```

## Production considerations

On a single host, a volume is only as durable as that host's disk. Volume
drivers exist for networked storage, but if you need replication, snapshots
and failover you are describing Kubernetes PersistentVolumes and a CSI driver.

Docker Desktop runs the daemon inside a Linux VM. Volumes live in the VM, so
they are fast; bind mounts cross a file-sharing boundary between the host and
the VM, which is where "my test suite is ten times slower in Docker" comes
from. Keep hot paths (dependency trees, build caches) in volumes rather than
bind mounts, and prefer Compose Watch to a bind mount of the whole tree.

Ownership is the other recurring production issue: a named volume inherits the
ownership of the image's directory at first use, a bind mount keeps the host's.
A non-root container writing to a bind mount needs the host path to be owned
by its UID; see [running as non-root](running-as-non-root.md).

`docker volume prune` removes unused volumes and will happily delete the
database you stopped yesterday. Label volumes you care about and prune with
filters.

## Security considerations

- A bind mount hands host filesystem access to the container process. Mount
  the narrowest path, read-only where possible, and never mount `/`,
  `/var/run/docker.sock`, `/proc` or `/sys` without a very specific reason.
  The Docker socket is root on the host.
- Secrets on a volume are on disk, at rest, on the host. `tmpfs` (or Compose
  `secrets`, which mounts files under `/run/secrets`) keeps them out of the
  image and off durable storage.
- On SELinux hosts, do not disable enforcement to make a mount work. Use `:z`
  or `:Z` — carefully, on a directory you own.
- Volumes outlive containers and are not namespaced by project unless Compose
  names them. A leftover volume with production data attached to a test stack
  is a real incident pattern.
- `read_only: true` plus tmpfs for scratch paths removes the attacker's
  ability to persist anything in the container filesystem.

## Troubleshooting

**Data disappears after recreating the container.** The volume is mounted at
the wrong path, or it was an anonymous volume that `docker compose down -v`
removed. Check what is actually mounted:

```bash
docker inspect --format '{{json .Mounts}}' <container>
docker volume ls
docker volume inspect <volume>
```

**The container sees an empty directory where the image had files.** A
non-empty volume or a bind mount is hiding them. Only an empty *volume* is
seeded from the image; bind mounts never are.

**`permission denied` on a mounted path.** UID mismatch. Compare `id` inside
the container with `ls -ln` on the host path.

**Changes on the host are not visible in the container (or vice versa).**
On Docker Desktop, the path may not be shared with the VM. On Linux, check
whether the mount is a bind mount at all, and whether propagation matters.

**Writes to a read-only root filesystem fail.** Add a tmpfs for that path
rather than dropping `read_only`.

**The container runs out of memory when writing to tmpfs.** tmpfs is charged
to the memory limit. Reduce `tmpfs-size` or raise the limit.

## Common mistakes

- Using a bind mount for database data in development, then being surprised by
  production behaviour.
- Mounting a volume over a path whose image content you needed, and losing it
  silently.
- Expecting `VOLUME` in a Dockerfile to bind a host path. It cannot; it only
  creates an anonymous volume.
- `docker compose down -v` on a stack with real data.
- Believing tmpfs gives a container extra memory.
- Bind-mounting `/var/run/docker.sock` to "just run a container from a
  container".
- Using `:Z` on a shared system directory.

## Related topics

- [Volumes and bind mounts basics](../docker-beginner/volumes-and-bind-mounts-basics.md)
- [Running as non-root](running-as-non-root.md)
- [Compose fundamentals](compose-fundamentals.md)
- [Compose secrets, configs and scaling](compose-secrets-configs-scaling.md)
- [Volumes (Kubernetes)](../k8s-intermediate/volumes.md)
- [Persistent volumes and claims](../k8s-intermediate/persistent-volumes-and-claims.md)
