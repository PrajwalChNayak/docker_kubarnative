---
title: Cleanup and disk usage
description: Where Docker's disk space goes, how to measure it, and how to prune safely without deleting the volume that held your database.
level: beginner
type: concept
status: current
versions: Docker Engine 29
prerequisites:
  - docker-beginner/images-tags-digests
  - docker-beginner/volumes-and-bind-mounts-basics
---

## Overview

Docker never deletes anything you did not tell it to. Images stay after the
container that used them is gone, stopped containers keep their writable
layers, build cache accumulates, and volumes outlive everything. On a
development machine this is convenient right up to the moment the disk fills;
on a server it is an outage.

`docker system df` tells you where the space went. The `prune` family removes
things — and some of its flags remove things you very much wanted to keep.

## Why it exists and when to use it

Retention is deliberate: keeping layers is what makes the next pull and the
next build fast, and keeping stopped containers is what makes `docker logs`
work after a crash. The cost is that cleanup is your job.

Run `docker system df` when the disk looks suspicious, before a big build, and
as part of any host's routine maintenance. Run a targeted `prune` regularly on
CI machines, where the churn is highest and nothing on disk is precious.

## How it works underneath

Four pools of data, all under Docker's data root (`/var/lib/docker` on Linux,
a VM disk image on Docker Desktop):

| Pool | What it holds | Reclaimable when |
|---|---|---|
| **Images** | Layer blobs and manifests, shared between images | No container references them; "dangling" images have no tag |
| **Containers** | The writable layer and the log file of every container, running or not | The container is removed |
| **Local volumes** | Named and anonymous volume data | No container references them |
| **Build cache** | BuildKit's cache mounts and layer cache | Pruned by age or size |

The "SHARED SIZE"/"RECLAIMABLE" columns in `docker system df` exist because
layers are shared by digest: deleting one image may free nothing if another
image uses the same layers.

A **dangling** image is one with no tag — usually the previous build of a tag
you rebuilt, now shown as `<none>`. Nothing references it, and on a machine
that builds frequently these are the main source of waste:

```bash
docker system df
docker image ls --filter dangling=true
```

```console include="captures/docker-beginner/disk-usage.txt"
```

`docker system df -v` breaks the same numbers down per image, container and
volume, which is how you find the one 6 GB volume nobody remembers creating.

## Basic example

```bash
docker run --name prune-demo-1 --label handbook.demo=prune alpine:3.22 true
docker run --name prune-demo-2 --label handbook.demo=prune alpine:3.22 true
docker ps -a --filter label=handbook.demo=prune --format 'table {{.Names}}\t{{.Status}}'
docker container prune -f --filter label=handbook.demo=prune
```

```console include="captures/docker-beginner/prune-labelled.txt"
```

Two containers exited seconds after starting and stayed on disk until pruned.
Note the filter: pruning by label removes exactly what you labelled, which is
the safe way to automate cleanup.

## Explanation

### What each prune command removes

| Command | Removes |
|---|---|
| `docker container prune` | All stopped containers |
| `docker image prune` | "All dangling images" — untagged and unreferenced |
| `docker image prune -a` | "All images without at least one container associated to them" — including tagged ones you will have to pull again |
| `docker volume prune` | "Anonymous local volumes not used by at least one container". Named volumes need `-a` |
| `docker network prune` | Networks with no containers attached |
| `docker builder prune` | Build cache |
| `docker system prune` | Stopped containers, unused networks, dangling images and unused build cache. **No volumes** |
| `docker system prune --volumes` | The above plus unused **anonymous** volumes |
| `docker system prune -a` | The above plus every unused tagged image |

Every prune command accepts `--filter`, and two filters are worth knowing:

```bash
docker image prune -a --filter "until=24h"
docker container prune -f --filter label=handbook.demo=prune
```

`until` takes a duration or a timestamp and restricts deletion to older
objects. `label` restricts it to things you marked yourself.

:::danger The flags that cost people data
`docker system prune -a --volumes` on a server is the classic way to delete a
production database. It removes every image no container is currently using —
including the one you would need to start the service again — plus unused
anonymous volumes. A stopped database container makes its image "unused", and
`-a` takes it.

Before running any prune with `-a` or `--volumes`, run `docker system df -v`
and read the list. On a shared host, prefer targeted removal by label or name.
:::

Named volumes are protected from `--volumes` by default: `docker volume prune`
removes only anonymous volumes unless `-a` is given. This is the single
safeguard standing between a routine cleanup and your data, so do not defeat
it casually.

### Manual removal

```bash
docker rm -f tasklane-api
docker rm -v tasklane-api
docker image rm tasklane-api:0.1.0
docker volume rm tasklane-db-data
docker network rm tasklane-net
```

`docker rm -v` also removes the container's anonymous volumes. `docker image
rm` removes a *tag*; the layers go only when the last tag referencing them is
gone and no container uses them.

### Logs are part of the problem

The default `json-file` driver does no rotation, so one chatty container can
fill a disk while `docker system df` still looks healthy — log files are
counted under the container's size. Configure rotation in `daemon.json` or use
the `local` driver, as described in
[Inspect, logs and exec](inspect-logs-exec.md#logs-has-the-flags-that-matter).

### Docker Desktop

Everything lives inside the VM's virtual disk, which grows and does not
automatically shrink when you delete things. Pruning inside Docker reclaims
space for Docker; reclaiming it for the host may need the Desktop UI's disk
management. `docker system df` still reports the truth about what Docker is
storing.

## Common patterns

**Routine on a CI runner**

```bash
docker container prune -f --filter "until=24h"
docker image prune -f --filter "until=168h"
docker builder prune -f --max-used-space 20GB
```

Age filters keep the recent cache that makes builds fast while removing the
rest. Run it on a timer, not from the job that just failed.

**Label everything a script creates**, then remove by label:

```bash
docker rm -f $(docker ps -aq --filter label=org.example.tasklane.stage=docker-run)
```

The Tasklane stage-1 script labels its containers, volumes and network so that
this is possible; its cleanup script removes them by name for the same reason.

**Find the biggest offenders**

```bash
docker system df -v
docker ps -a --size --format 'table {{.Names}}\t{{.Size}}'
```

**Before deleting a volume, look inside it**

```bash
docker run --rm --mount type=volume,src=tasklane-db-data,dst=/data alpine:3.22 du -sh /data
```

## Production considerations

- Put a rotation policy in `daemon.json` on every host before it matters.
- Monitor the data root as a normal disk-usage alert. `/var/lib/docker` filling
  up takes down every container on the host, and the failure modes are
  confusing (containers that will not start, databases that cannot write).
- Automate pruning with filters and labels, never with `-a --volumes` on a
  schedule.
- Give `/var/lib/docker` its own filesystem where you can, so a runaway
  container cannot fill the root filesystem.
- Registries need garbage collection too; images you push accumulate there as
  well. See [Registries](../docker-advanced/registries.md).
- [Docker disk exhaustion](../troubleshooting/docker-disk-exhaustion.md) walks
  through the incident version of this page.

## Security considerations

- Stopped containers and old volumes keep whatever was written to them:
  credentials in log files, database dumps, cached tokens. Deleting a service
  should include deleting its data, deliberately.
- Old images keep old vulnerabilities, and an unpatched image left on a host
  can still be started. Prune images you no longer deploy.
- `docker system prune` needs daemon access, which is root-equivalent. Treat
  cleanup automation as privileged code: a prune command built from
  interpolated shell variables is a way to delete things you did not intend.
- Filling the disk is a denial-of-service vector; log rotation is a security
  control as much as a housekeeping one.

## Troubleshooting

| Symptom | What to check |
|---|---|
| "no space left on device" from a container | `docker system df`, then the host's `df -h` for the data root |
| Disk did not shrink after pruning | Layers still referenced by another image, or Docker Desktop's VM disk not reclaimed |
| `docker volume rm` says the volume is in use | A stopped container still references it; remove it first |
| `docker image rm` says the image has dependent children | Another image or container depends on it; use the digest or remove dependents |
| Build cache enormous | `docker builder prune`, and check for cache mounts in Dockerfiles |
| `docker system df` disagrees with `du` | Sharing between layers, plus the log files and the VM disk on Desktop |

## Common mistakes

- **`docker system prune -a --volumes` on a host with data.**
- **Pruning to fix a full disk during an incident** without looking first, then
  discovering the image you need has to be pulled and the registry is
  unreachable.
- **Assuming `docker rm` frees image layers.** It frees the writable layer.
- **Forgetting anonymous volumes.** They accumulate invisibly from images that
  declare `VOLUME`.
- **Leaving `json-file` logging unrotated** on a long-lived host.
- **Cleaning up by deleting `/var/lib/docker` by hand.** Stop the daemon and
  use the CLI; manual deletion corrupts the daemon's metadata.

## Related topics

- [Images, tags and digests](images-tags-digests.md)
- [Volumes and bind mounts](volumes-and-bind-mounts-basics.md)
- [Inspect, logs and exec](inspect-logs-exec.md)
- [Logging drivers](../docker-advanced/logging-drivers.md)
- [Daemon configuration](../docker-advanced/daemon-configuration.md)
- [Docker disk exhaustion](../troubleshooting/docker-disk-exhaustion.md)
- [Image size optimisation](../docker-intermediate/image-size-optimisation.md)
