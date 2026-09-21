---
title: Volumes and bind mounts, basics
description: Why the container filesystem is disposable, what a named volume actually is, when a bind mount is the right tool, and the file-sharing caveats on Docker Desktop.
level: beginner
type: concept
status: current
versions: Docker Engine 29
prerequisites:
  - docker-beginner/running-containers
  - foundations/overlay-filesystems
---

## Overview

A container's filesystem is the image's read-only layers with one thin
writable layer on top. Everything your process writes goes into that writable
layer, and `docker rm` deletes it. A container is therefore disposable by
construction — which is exactly what you want for the process and exactly what
you do not want for a database.

Docker offers two ways to keep data outside that writable layer. A **volume**
is storage the daemon manages, in its own directory, identified by name. A
**bind mount** is a path from the host grafted into the container.

## Why it exists and when to use it

| | Volume | Bind mount |
|---|---|---|
| Source | Managed by the daemon (`/var/lib/docker/volumes/<name>/_data` for the default `local` driver) | Any path you choose on the host |
| Created by | `docker volume create`, or on demand | Must exist, or Docker creates a directory for you |
| Portability | Same command works on any host | Depends on the host's layout |
| Permissions | Initialised from the image's directory contents and ownership | Whatever the host path already has |
| Typical use | Databases, caches, anything stateful | Source code during development, config files, sockets |
| Performance on Docker Desktop | Native VM speed | Crosses the host-to-VM boundary |

Rule of thumb: **volumes for data the container owns, bind mounts for files
you own.** Tasklane's PostgreSQL data lives in a named volume from stage 1
onwards; nothing in the running example bind-mounts application data.

A third kind, `tmpfs`, keeps data in memory and never touches disk — useful
for scratch space in a read-only container. Part C covers it in
[volumes, bind mounts and tmpfs](../docker-intermediate/volumes-bind-mounts-tmpfs.md).

## How it works underneath

The daemon builds the container's mount namespace in order: first the
overlay root filesystem, then every mount you asked for, at the path you gave.
A mount **hides** whatever was at that path in the image, exactly as a mount
does on any Linux system.

For a **volume**, the daemon creates a directory under its own root and bind
mounts it into the container. One special behaviour makes volumes convenient
for databases: when a *named, empty* volume is mounted onto a directory that
has content in the image, the daemon copies that content — including ownership
and permissions — into the volume the first time. That is how the
`postgres` image's `/var/lib/postgresql` skeleton reaches an empty volume.
Bind mounts never do this; they simply cover what was there.

**Anonymous volumes** are created when an image declares `VOLUME` or you write
`-v /data` with no name. They get a random name, are easy to lose track of,
and are what `--rm` and `docker system prune --volumes` clean up:

```console include="captures/docker-beginner/anonymous-volume.txt"
```

For a **bind mount**, the source path is resolved on the host. If it does not
exist, "when the host directory of a bind-mounted volume doesn't exist, Docker
automatically creates this directory on the host for you" with `-v` — which is
why a typo in a path silently produces an empty directory instead of an error.
`--mount type=bind` fails instead, which is the better default.

Two syntaxes do the same job:

```bash
docker run -v tasklane-db-data:/var/lib/postgresql postgres:18-trixie
docker run --mount type=volume,src=tasklane-db-data,dst=/var/lib/postgresql postgres:18-trixie
```

`--mount` is verbose, explicit and errors on mistakes; `-v` is terse and
guesses. The example scripts in this handbook use `--mount`.

## Basic example

```bash
docker volume create hb-demo
docker run --rm --mount type=volume,src=hb-demo,dst=/data alpine:3.22 sh -c 'echo "written inside $(hostname)" > /data/note'
docker run --rm --mount type=volume,src=hb-demo,dst=/data,readonly alpine:3.22 cat /data/note
docker volume inspect hb-demo
docker volume rm hb-demo
```

```console include="captures/docker-beginner/volume-roundtrip.txt"
```

Two containers, neither of which exists any more, and the data survived both.
That is the whole idea. The second container mounted the volume `readonly`, so
its attempt to write was refused by the kernel, not by Docker.

## Explanation

**Mount options you will actually use**

| Option (`--mount` form) | Meaning |
|---|---|
| `type=volume,src=NAME,dst=/path` | Named volume |
| `type=bind,src=/host/path,dst=/path` | Bind mount; source must exist |
| `,readonly` (or `,ro`) | Mount read-only |
| `type=tmpfs,dst=/tmp` | In-memory, never written to disk |

In the `-v` short form the same flags are positional and terse:
`-v /host/path:/container/path:ro`.

**Read-only root, writable where needed.** `--read-only` makes the container's
own filesystem read-only, and then you add writable mounts only where the
program genuinely needs them. The Tasklane containers run this way. A process
that cannot write to its own filesystem cannot drop a web shell there.

**Ownership is the usual surprise.** The container process runs as some UID
(65532 for Tasklane, 999 for postgres). A bind-mounted host directory keeps
its host ownership, so a process running as UID 65532 may simply not be able
to write to it. Volumes avoid this for image-provided directories because the
initial copy brings the image's ownership with it. On Docker Desktop the
file-sharing layer papers over this; on Linux it does not, and the difference
surprises people who develop on one and deploy on the other.

**The database volume mount point matters.** The `postgres:18` image sets
`PGDATA=/var/lib/postgresql/18/docker`, so the Tasklane examples mount the
volume one level up at `/var/lib/postgresql`. Mounting the wrong directory
produces a database that initialises every start and loses everything.

```yaml include="examples/compose/compose.yaml" lines="35-38"
```

## Common patterns

**Stateful service**

```bash
docker volume create tasklane-db-data
docker run -d --name tasklane-db --mount type=volume,src=tasklane-db-data,dst=/var/lib/postgresql postgres:18-trixie
```

**Configuration or a secret, read-only**

```bash
docker run -d --name tasklane-api --mount type=volume,src=tasklane-secrets,dst=/run/secrets,readonly tasklane-api:0.1.0
```

**Source code during development** — the classic bind mount, and the reason
bind mounts exist:

```bash
docker run --rm -it --mount type=bind,src="$PWD",dst=/src -w /src golang:1.27 go test ./...
```

For compiled languages this is a convenience; for interpreted ones it is the
whole inner loop. Compose formalises it with
[`develop.watch`](../docker-intermediate/compose-watch.md).

**Back up a volume** by mounting it into a throwaway container together with a
bind mount for the output:

```bash
docker run --rm --mount type=volume,src=tasklane-db-data,dst=/data --mount type=bind,src="$PWD",dst=/backup alpine:3.22 tar czf /backup/db-data.tgz -C /data .
```

For a database, prefer its own tooling (`pg_dump`) over a file-level copy of a
running data directory.

## Production considerations

- The default `local` volume driver stores data on that one host. A volume is
  not shared storage and does not move with a container. On Kubernetes, that
  problem becomes [PersistentVolumes](../k8s-intermediate/persistent-volumes-and-claims.md).
- Volumes are never removed automatically. `docker volume prune` removes only
  **anonymous** unused volumes unless you add `-a`; that is a safety feature,
  not an oversight.
- Back up the data, not the volume. Test the restore.
- Bind mounts tie a container to a host's directory layout, which makes them a
  poor fit for anything you might move.
- **Docker Desktop performance**: bind mounts cross a virtualisation boundary
  and are slower than volumes. On macOS, Docker Desktop uses VirtioFS by
  default, which the docs say "reduced the time taken to complete filesystem
  operations by up to 98%"; Docker's guidance is still to share only the
  directories you need. On Windows, keep project files in the WSL 2 Linux
  filesystem: "Performance is much higher when files are bind-mounted from the
  Linux filesystem, rather than accessed from the Windows host filesystem",
  and inotify events only work there.

## Security considerations

- A bind mount of a host path gives the container whatever access the
  container's user has to those files. Mounting `/` gives away the machine;
  see [Installing Docker](install-docker.md#post-install-on-linux-the-docker-group).
- **Never bind mount `/var/run/docker.sock`** into a container you do not
  fully trust. It is equivalent to root on the host —
  [The Docker socket is root](../docker-security/docker-socket-is-root.md).
- Mount secrets `readonly`, and only into the containers that need them. In
  stage 1 the password volume is mounted read-only at `/run/secrets`.
- Combine `--read-only` with narrow writable mounts. A read-only root
  filesystem is one of the cheapest real hardening measures available.
- Remember that volumes outlive containers. A deleted service can leave its
  data, including credentials and dumps, on the host indefinitely.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| The directory in the container is empty | A mount covered the image's content, or the host path was wrong and was created empty |
| `permission denied` writing to a mount | UID mismatch between the container process and the host directory |
| Data disappears on every restart | Nothing is mounted, or the mount point is not where the application writes |
| `docker volume rm` says the volume is in use | A container still references it. `docker ps -a --filter volume=<name>` |
| Disk keeps growing after containers are gone | Unused volumes; see [Cleanup and disk usage](cleanup-and-disk-usage.md) |
| Bind mount is very slow on a laptop | Docker Desktop file sharing; move the data into a volume |

## Common mistakes

- **Mounting over a directory the image populated** and losing it.
- **Using a bind mount where a volume belongs**, then discovering the host
  path does not exist on the next machine.
- **Assuming `--rm` cleans up named volumes.** It removes anonymous ones only.
- **Mounting the wrong PostgreSQL directory.**
- **Relying on the writable layer for data.** It dies with the container, and
  `docker diff` will show you how much of it you did not intend to write.
- **Bind mounting Windows paths into WSL 2 containers** and blaming Docker for
  the speed.

## Related topics

- [Running containers](running-containers.md)
- [Cleanup and disk usage](cleanup-and-disk-usage.md)
- [Tasklane with docker run](tasklane-with-docker-run.md)
- [Volumes, bind mounts and tmpfs](../docker-intermediate/volumes-bind-mounts-tmpfs.md)
- [Read-only root filesystem](../docker-security/read-only-root-filesystem.md)
- [Overlay filesystems](../foundations/overlay-filesystems.md)
- [Volumes on Kubernetes](../k8s-intermediate/volumes.md)
