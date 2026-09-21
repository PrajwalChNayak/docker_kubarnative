---
title: Docker build cache and disk exhaustion
description: Why a Docker host runs out of disk — build cache growth, dangling images and volumes, overlay2 layers and container logs — and how to measure and reclaim it with buildx du and system prune.
level: intermediate
type: troubleshooting
status: current
versions: Docker Engine 29
prerequisites:
  - troubleshooting/method
  - docker-beginner/cleanup-and-disk-usage
  - docker-advanced/logging-drivers
---

## Overview

"No space left on device" on a Docker host is rarely the images you can see. It
is the **build cache**, dangling layers, stopped containers, unused volumes and
runaway container logs — all under `/var/lib/docker`. This page shows where the
space actually goes, how to measure each category, and how to reclaim it safely
with `docker system df`, `docker buildx du` and the `prune` commands, without
deleting data you still need.

## Symptoms

- Builds or `docker run` fail with `no space left on device`, or writes inside
  containers fail.
- `/var/lib/docker` (the Docker data root) is nearly full; `df -h` on the host
  confirms it.
- On a Kubernetes node the same problem drives `DiskPressure` and pod eviction —
  see [Evicted pods](evicted-pods.md).

## How it works underneath

The Docker daemon stores everything under its data root, `/var/lib/docker` by
default. The big consumers:

- **Build cache.** BuildKit (the default builder in Engine 29) keeps a cache of
  build steps to speed up rebuilds. It grows with every distinct build and is
  **not** counted as images — it lives in the builder and can quietly become the
  largest consumer on a CI host.
- **Images and dangling layers.** Rebuilding a tag leaves the old image
  untagged (`<none>:<none>`, "dangling"). The `overlay2` storage driver keeps
  each layer under `/var/lib/docker/overlay2`; shared layers are deduplicated,
  but orphaned ones accumulate.
- **Stopped containers.** Each keeps its writable layer until removed. Containers
  run without `--rm` pile up.
- **Volumes.** Named and anonymous volumes persist after their container is gone
  (this is the point of volumes) and are easy to leak — every `docker run -v
  /data` without cleanup leaves an anonymous volume behind.
- **Container logs.** With the default `json-file` logging driver and no
  rotation, a chatty container's log under
  `/var/lib/docker/containers/<id>/<id>-json.log` grows without bound. A single
  container can fill the disk this way. See
  [logging drivers](../docker-advanced/logging-drivers.md).

## Diagnosis

1. **Get the category breakdown.**

   ```bash
   docker system df
   ```

   It reports Images, Containers, Local Volumes and **Build Cache** with total
   vs reclaimable size. Add `-v` for a per-object breakdown.

2. **Measure the build cache specifically.**

   ```bash
   docker buildx du
   docker buildx du --verbose
   ```

   This shows the BuildKit cache the images total does not include — often the
   surprise on a build host.

3. **Find dangling images and leaked volumes.**

   ```bash
   docker image ls --filter dangling=true
   docker volume ls --filter dangling=true
   ```

4. **Find oversized container logs.** On the host:

   ```bash
   du -sh /var/lib/docker/containers/*/*-json.log 2>/dev/null | sort -h | tail
   ```

5. **Confirm the data root** if it is not the default:

   ```bash
   docker info --format '{{.DockerRootDir}}'
   ```

## Fixes

- **Reclaim the build cache** (usually the biggest win):

  ```bash
  docker buildx prune
  docker buildx prune --filter until=168h --keep-storage=10GB
  ```

- **Remove dangling images:**

  ```bash
  docker image prune
  ```

- **Targeted sweep** of stopped containers, dangling images, unused networks and
  the build cache in one step:

  ```bash
  docker system prune
  ```

- **Include unused images and volumes — destructive, read the flags:**

  ```bash
  docker system prune -a --volumes
  ```

  :::warning `-a --volumes` deletes data
  `-a` removes every image not used by a running container, and `--volumes`
  deletes volumes not attached to a container — including databases you meant to
  keep. On a shared or production host, prune with filters
  (`--filter until=...`, `--filter label=...`) and never blanket-delete volumes.
  :::

- **Cap logs at the source** so they never exhaust disk again. Set rotation per
  container or as a daemon default:

  ```bash
  docker run --log-opt max-size=10m --log-opt max-file=3 <image>
  ```

  Or in `/etc/docker/daemon.json` set `log-driver` and `log-opts` globally, then
  restart the daemon.

## Prevention

- **Run throwaway containers with `--rm`** so they leave no writable layer.
- **Set log rotation as a daemon default** (`max-size`, `max-file`) so no single
  container can fill the disk.
- **Prune the build cache on a schedule** on CI hosts, with `--filter until=` and
  `--keep-storage` rather than wiping it (which slows every build).
- **Track named volumes** and delete them deliberately; avoid accidental
  anonymous volumes.
- **Alert on `/var/lib/docker` free space** and on `docker system df`
  reclaimable size before it becomes an outage.

## Common mistakes

- Deleting images to free space while the **build cache** is the real consumer
  (invisible to `docker image ls`).
- Running `docker system prune -a --volumes` on a host with data volumes and
  losing a database.
- Leaving `json-file` logging unrotated, so one container fills the disk.
- Forgetting `--rm` and accumulating stopped containers and anonymous volumes.
- Pruning aggressively on CI and destroying the cache that keeps builds fast.

## Related topics

- [A method for debugging Kubernetes](method.md)
- [Architecture mismatch](architecture-mismatch.md)
- [Evicted pods](evicted-pods.md)
- [Cleanup and disk usage](../docker-beginner/cleanup-and-disk-usage.md)
- [Logging drivers](../docker-advanced/logging-drivers.md)
