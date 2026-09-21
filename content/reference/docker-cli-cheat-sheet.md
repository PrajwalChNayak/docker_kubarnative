---
title: Docker CLI cheat sheet
description: Everyday docker, docker compose and docker buildx commands for Engine 29, Compose v5 and buildx 0.37.
level: beginner
type: reference
status: current
versions: Docker Engine 29, Compose v5, Buildx 0.37
prerequisites:
  - docker-beginner/docker-cli-basics
---

## Overview

A dense lookup for the Docker CLI on Engine 29, `docker compose` v5 and
`docker buildx` 0.37. Always `docker compose` (the plugin), never the
the standalone Python v1 binary (EOL). Placeholders are in angle brackets.

## Images

```bash
docker pull postgres:18-trixie
docker images
docker images --all
docker image inspect tasklane-api:0.1.0
docker history tasklane-api:0.1.0
docker tag tasklane-api:0.1.0 registry.example.com/tasklane-api:0.1.0
docker push registry.example.com/tasklane-api:0.1.0
docker rmi tasklane-api:0.1.0
docker image prune -a
```

On Engine 29, `docker image ls` shows a collapsed tree view by default and
hides untagged images unless you pass `--all`. The containerd image store is the
default on fresh installs.

## Containers

```bash
docker run --rm -it busybox:1.37 sh
docker run -d --name api -p 8080:8080 tasklane-api:0.1.0
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
  -u 65532 tasklane-api:0.1.0
docker ps
docker ps -a
docker logs -f api
docker exec -it api sh
docker inspect api
docker stop api
docker rm api
docker container prune
```

## Build (buildx / BuildKit)

```bash
docker build -t tasklane-api:0.1.0 --target api examples/app
docker buildx build -t tasklane-api:0.1.0 --target api examples/app
docker buildx build --platform linux/amd64,linux/arm64 -t <ref> --push .
docker buildx build --sbom=true --provenance=true -t <ref> --push .
docker buildx build --secret id=npmrc,src=$HOME/.npmrc .
docker buildx build --cache-to type=registry,ref=<ref>-cache --cache-from type=registry,ref=<ref>-cache .
docker buildx imagetools inspect postgres:18-trixie
```

BuildKit is the default builder. Only minimal provenance is attached by default;
SBOM is opt-in with `--sbom=true`. Disable defaults with `--provenance=false` or
`BUILDX_NO_DEFAULT_ATTESTATIONS`.

## Compose (v5 plugin)

```bash
docker compose up -d
docker compose up -d --build
docker compose --profile observability up -d
docker compose watch
docker compose ps
docker compose logs -f api
docker compose config
docker compose exec api sh
docker compose down
docker compose down -v
```

`docker compose config` parses and renders the effective file without building
or running — the safe way to check a compose file. In v5, build is delegated to
Docker Bake. Watch (`develop.watch`) live-syncs or rebuilds on source change.

## Networks and volumes

```bash
docker network ls
docker network create backend
docker network inspect backend
docker volume ls
docker volume create db-data
docker volume inspect db-data
docker volume prune
```

## System and cleanup

```bash
docker system df
docker system prune
docker system prune -a --volumes
docker stats
docker context ls
docker context use <name>
docker version
docker info
```

`docker system df` shows reclaimable space; `prune -a --volumes` is the big
hammer and deletes unused images **and** volumes, so read what it lists first.

## Registry and Hub notes

- Hub pull limits per 6 hours: 100 unauthenticated (per IPv4 / IPv6 /64), 200
  Personal, unlimited on paid plans. `docker login` to lift the anonymous cap.
- Docker Content Trust was removed from the CLI in Engine 29; use cosign for
  signing (see [image signing](../docker-advanced/image-signing-cosign.md)).

## Common mistakes

- **Typing the hyphenated standalone command.** That is the EOL Python v1; use
  the `docker compose` plugin.
- **`docker build` without a target on a multi-stage file.** You get the last
  stage; pass `--target api` (or `worker`).
- **`prune -a --volumes` without reading the list.** It deletes unused volumes,
  which may hold data.
- **Publishing a port on `0.0.0.0` by habit.** `-p 8080:8080` binds all
  interfaces; use `-p 127.0.0.1:8080:8080` for local-only.
- **Expecting SBOM by default.** Only minimal provenance is default; add
  `--sbom=true`.

## Related topics

- [Docker CLI basics](../docker-beginner/docker-cli-basics.md)
- [BuildKit and buildx](../docker-advanced/buildkit-and-buildx.md)
- [Dockerfile reference](dockerfile-reference.md)
- [Compose file reference](compose-file-reference.md)
