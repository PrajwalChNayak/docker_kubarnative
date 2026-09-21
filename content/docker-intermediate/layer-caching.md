---
title: Layer caching
description: How BuildKit decides whether it can reuse a step, why one edit can invalidate everything after it, and how to order a Dockerfile around that.
level: intermediate
type: concept
status: current
versions: Docker Engine 29, Compose v5
prerequisites:
  - docker-intermediate/dockerfile-instructions
  - docker-intermediate/build-context-and-dockerignore
---

## Overview

Every step in a build has a cache key. If the key matches a result the builder
already has, the step is skipped and its result reused; the build prints
`CACHED`. If it does not match, the step runs — and because each key includes
the parent's key, every step after it runs too.

Most "why is my build slow" questions are answered by finding the first step
that missed and asking what changed about its key.

## Why it exists and when to use it

A container image is built from immutable layers, so the builder can
substitute a previously computed layer for an identical step. The payoff is
large: a well-ordered Dockerfile rebuilds an application in the time it takes
to compile it, while a badly ordered one re-downloads the world on every
keystroke.

The same mechanism has a cost: the cache can hide staleness. `RUN apt-get
upgrade` reuses a month-old result without complaint, because nothing about
the instruction changed.

## How it works underneath

The rules, from the [cache invalidation
reference](https://docs.docker.com/build/cache/invalidation/):

- The builder checks the base image first, then compares each instruction
  against the cached layers. If no cached layer matches exactly, the cache is
  invalidated.
- For `ADD`, `COPY` and `RUN --mount=type=bind`, the key includes a checksum
  computed from the contents and metadata of the files involved. `mtime` is
  not part of it, so touching a file changes nothing.
- For everything else, only the instruction string and the parent key matter.
  The files in the container are not inspected: `RUN apt-get update` matches
  on the command text alone.
- Once the cache is invalidated, every later instruction rebuilds.

Additional keys that are easy to forget:

- **`ARG` values.** A changed build argument causes a miss on its first *use*,
  not on its declaration. All `RUN` steps after an `ARG` use it implicitly as
  an environment variable, so `ARG CACHEBUST` followed by any `RUN` is the
  standard way to force a rebuild. Predefined args are exempt unless you
  declare them.
- **`SOURCE_DATE_EPOCH`.** `WORKDIR` respects it, so a per-commit timestamp
  invalidates `WORKDIR` and everything after it.
- **Secret metadata, not secret contents.** Changing the value behind
  `RUN --mount=type=secret` does not invalidate anything; changing the secret
  id or mount path does.
- **Cache mounts are not cache keys.** `RUN --mount=type=cache` content is
  scratch space shared between builds; it neither invalidates a step nor ends
  up in the layer.

## Basic example

Two Dockerfiles for the same application, differing only in where the source
copy sits:

```dockerfile include="examples/dockerfiles/cache-ordering/Dockerfile.unordered"
```

```dockerfile include="examples/dockerfiles/cache-ordering/Dockerfile.ordered"
```

Build both, edit `app.py`, build both again:

```bash
docker build -f examples/dockerfiles/cache-ordering/Dockerfile.unordered -t cacheorder-unordered:0.1.0 examples/dockerfiles/cache-ordering
docker build -f examples/dockerfiles/cache-ordering/Dockerfile.ordered -t cacheorder-ordered:0.1.0 examples/dockerfiles/cache-ordering
echo "# touched" >> examples/dockerfiles/cache-ordering/app.py
docker build -f examples/dockerfiles/cache-ordering/Dockerfile.unordered -t cacheorder-unordered:0.1.0 examples/dockerfiles/cache-ordering
docker build -f examples/dockerfiles/cache-ordering/Dockerfile.ordered -t cacheorder-ordered:0.1.0 examples/dockerfiles/cache-ordering
```

Timed rebuild of the unordered file, where the simulated ten-second install
runs again:

```console include="captures/docker-intermediate/cache-unordered-rebuild.txt"
```

Timed rebuild of the ordered file, where it does not:

```console include="captures/docker-intermediate/cache-ordered-rebuild.txt"
```

## Explanation

In `Dockerfile.unordered`, `COPY . .` precedes the install step. Editing
`app.py` changes the checksum of that copy, the `COPY` step misses, and the
`RUN` below it inherits the miss even though `requirements.txt` is untouched.

In `Dockerfile.ordered`, the only input to the steps above the install is
`requirements.txt`. Editing `app.py` misses only on the final `COPY`, which
costs milliseconds.

The Tasklane image applies the same shape to Go:

```dockerfile include="examples/app/Dockerfile" lines="21-35"
```

`go.mod` and `go.sum` change when dependencies change — a few times a month.
Source files change constantly. Separating them means `go mod download` runs
only when it has something new to do, and the cache mounts make even a miss
cheap.

## Common patterns

**Manifest first, source second.** `package.json` + `package-lock.json`, then
`npm ci`, then the source. `go.mod` + `go.sum`, then `go mod download`, then
the source. `requirements.txt`, then `pip install`, then the source. Same
shape in every ecosystem.

**Order by rate of change.** Base image, system packages, language
dependencies, application source, configuration. Least volatile first.

**Cache mounts for package managers.** A cache mount survives across builds
and is shared between them, and its contents never enter a layer:

```dockerfile title="cache-mount.Dockerfile" fragment
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go build ./...
```

**`COPY --link` for layers you want to keep.** With `--link`, the copied layer
is independent of the layers below it, so changing an earlier instruction (or
rebasing onto a patched base image) does not invalidate it.

**Split `--no-cache` by stage.** `docker build --no-cache-filter deps .`
rebuilds one stage and keeps the rest of the cache.

**Pin, then bump deliberately.** Pinning the base image by digest means an
upstream rebuild cannot silently change your base *or* silently invalidate
your cache. Renovate or Dependabot bumps the digest, and the miss happens in a
reviewed commit.

## Production considerations

CI runners usually start with an empty local cache, which makes remote cache
backends the deciding factor in build time. BuildKit supports `inline`,
`registry`, `local`, `gha` (beta), `s3` and `azblob` (both documented as
unreleased) backends; the `registry` backend with `mode=max` is the usual
starting point. The mechanics belong to
[remote build cache](../docker-advanced/remote-build-cache.md).

Cache and reproducibility pull in opposite directions. `RUN apt-get update &&
apt-get install -y curl` can produce different results on different days and
identical results from cache on the same day. If you need to know what is
inside, pin package versions and record an SBOM; if you need freshness, rebuild
with `--no-cache` on a schedule rather than hoping.

Compose v5 delegates builds to Bake, so cache configuration for a Compose
service is expressed in the `build` section (`cache_from`, `cache_to`,
`no_cache`, `no_cache_filter`) rather than by Compose's own builder, which no
longer exists.

## Security considerations

- A cache is a place where data from a previous build survives. On a shared
  builder, that includes files that were only supposed to exist during a
  build. Prefer per-project builders, or scope cache mounts with
  `BUILDKIT_CACHE_MOUNT_NS`.
- Secrets mounted with `--mount=type=secret` are excluded from the cache by
  design. Secrets passed as `ARG` are in `docker history` *and* in the cache
  key.
- Cache poisoning is a real supply-chain risk with shared remote caches: a
  writable registry cache lets anyone who can push substitute layer content
  for your build steps. Give CI read-only access to shared caches unless it is
  the trusted producer.
- A digest-pinned base image plus `--no-cache` on release builds gives you a
  build whose inputs you can name. `latest` plus a warm cache gives you a
  build nobody can reconstruct.

## Troubleshooting

**Everything rebuilds every time.** Look for an instruction near the top whose
inputs change on every build: `COPY . .`, an `ARG` holding a git SHA, or
`SOURCE_DATE_EPOCH`.

**Nothing rebuilds when it should.** `RUN` steps do not notice the outside
world. Use `--no-cache`, `--no-cache-filter <stage>`, or bump a pinned version.

**A step is `CACHED` in CI but not locally.** The remote cache has it and the
local builder does not, or the two builders have different frontends. Compare
`docker buildx ls` and the `# syntax=` line.

**Cache misses after a file was only reformatted.** File contents *did*
change. Only `mtime` is ignored.

**A multi-stage build rebuilds an intermediate stage constantly.** Something
in that stage reads a volatile file. `COPY --link` in the consuming stage
prevents the invalidation from cascading into the final image layers.

## Common mistakes

- Copying the whole source tree before installing dependencies.
- Chasing "cache busting" with `ARG CACHEBUST=$(date)` in normal builds, which
  defeats the cache entirely rather than selectively.
- Believing `docker build --pull` refreshes package versions. It refreshes the
  base image only.
- Writing package caches into the image (`pip install` without
  `--no-cache-dir`, `apt` lists left in place) instead of using cache mounts.
- Assuming Compose and `docker build` share a builder and cache. Check with
  `docker buildx ls`.

## Related topics

- [Build context and .dockerignore](build-context-and-dockerignore.md)
- [Multi-stage builds](multi-stage-builds.md)
- [Image size optimisation](image-size-optimisation.md)
- [BuildKit and buildx](../docker-advanced/buildkit-and-buildx.md)
- [Cache and secret mounts](../docker-advanced/cache-and-secret-mounts.md)
- [Remote build cache](../docker-advanced/remote-build-cache.md)
