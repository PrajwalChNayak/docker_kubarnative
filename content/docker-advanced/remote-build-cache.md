---
title: Remote build cache
description: Export and import BuildKit cache across machines with the inline, registry, local and gha backends, and make ephemeral CI runners build fast.
level: advanced
type: concept
status: current
versions: Docker Engine 29, Buildx 0.37
prerequisites:
  - docker-advanced/buildkit-and-buildx
  - docker-advanced/cache-and-secret-mounts
---

## Overview

Local build cache belongs to one builder on one machine. CI runners are
ephemeral, so every job starts cold and rebuilds everything — including the
dependency layers that have not changed in months. Cache backends fix that by
writing the cache somewhere both jobs can reach and importing it at the start
of the next build.

This page covers the four usable backends, what `mode=min` and `mode=max`
actually change, and how to lay out cache references so that a branch build
is warm on its first run.

## Why it exists and when to use it

A warm cache changes CI economics. A Go build that takes four minutes cold
takes well under one when the module download and the dependency compile are
restored. The trade is storage in a registry and a little complexity in the
build invocation.

Use a cache backend when at least one of these is true:

- Builds run on ephemeral runners or in containers that are discarded.
- Several machines build the same images and could share work.
- You want developers' first build of the day to be warm.

Do not bother when a long-lived machine builds the same project repeatedly.
Local cache is already faster than anything you can pull.

## How it works underneath

BuildKit's cache records map a cache key to a result: a layer blob plus the
metadata that proves it corresponds to that key. An export walks the records
for the build that just finished and writes them out; an import loads them
before solving so that the solver can match keys without executing anything.

`mode` decides how much is written. From the Docker documentation: "In `min`
cache mode (the default), only layers that are exported into the resulting
image are cached, while in `max` cache mode, all layers are cached, even
those of intermediate steps."

For a multi-stage build that is the whole game. With `mode=min` the compiler
stage is not cached at all, because none of its layers reach the final
distroless image; the next build recompiles. `mode=max` is what you want for
anything multi-stage, and `inline` cannot do it, because inline cache lives
inside the image that gets shipped.

## The backends

From the cache backends documentation:

| Backend | What it does | Status | `mode=max` | Notes |
|---|---|---|---|---|
| `inline` | Embeds cache metadata in the image | stable | no | Zero extra infrastructure; ships cache metadata to every puller |
| `registry` | Pushes cache to a separate image | stable | yes | The default choice |
| `local` | Writes cache to a directory | stable | yes | For runners with a persistent mounted volume |
| `gha` | GitHub Actions cache | **beta** | yes | Subject to GitHub cache quotas and eviction |
| `s3` | AWS S3 bucket | **unreleased** | — | Documented but not released |
| `azblob` | Azure Blob Storage | **unreleased** | — | Documented but not released |

The default `docker` driver supports `inline`, `local`, `registry` and `gha`,
but only with the containerd image store enabled. Everything else needs a
`docker-container`, `kubernetes` or `remote` builder.

:::warning
`s3` and `azblob` are marked *unreleased* in the Docker documentation. Do not
design a pipeline around them and do not present them to a team as available.
:::

## Basic example

Registry cache, which is the one to reach for by default:

```bash
docker buildx build --push -t ghcr.io/example/tasklane/tasklane-api:0.1.0 \
  --cache-to   type=registry,ref=ghcr.io/example/tasklane/buildcache:api,mode=max \
  --cache-from type=registry,ref=ghcr.io/example/tasklane/buildcache:api \
  --target api examples/app
```

The same thing declaratively, in the Bake file:

```hcl include="examples/build/docker-bake.hcl" lines="71-88"
```

## Explanation

The cache lives in `buildcache:api`, a separate repository from the image.
That separation matters: with `mode=max` the cache holds every intermediate
layer, including the Go toolchain's output, and you do not want those bytes
attached to the image that runs in production.

Two `cache-from` entries give a branch build a warm start. BuildKit tries
each import source; the branch's own cache hits after the first build on that
branch, and the `main` cache covers the first one.

```bash
docker buildx build --push -t ghcr.io/example/tasklane/tasklane-api:0.1.0 \
  --cache-to   type=registry,ref=ghcr.io/example/tasklane/buildcache:api-$BRANCH,mode=max \
  --cache-from type=registry,ref=ghcr.io/example/tasklane/buildcache:api-$BRANCH \
  --cache-from type=registry,ref=ghcr.io/example/tasklane/buildcache:api-main \
  --target api examples/app
```

## Common patterns

### Inline cache

```bash
docker buildx build --push -t ghcr.io/example/tasklane/tasklane-api:0.1.0 \
  --cache-to type=inline \
  --cache-from type=registry,ref=ghcr.io/example/tasklane/tasklane-api:0.1.0 \
  --target api examples/app
```

Cheap and simple: no second repository, no extra credentials. The cost is
`mode=min` only, and everyone who pulls the image pulls the cache metadata
with it. Fine for a single-stage image, close to useless for a multi-stage
one.

### Local cache

```bash
docker buildx build \
  --cache-to   type=local,dest=/var/cache/buildkit,mode=max \
  --cache-from type=local,src=/var/cache/buildkit \
  --target api examples/app
```

Useful when the CI system already gives you a persistent volume or a cache
restore step. Note that `type=local` grows forever: BuildKit does not prune
an exported local cache directory for you.

### GitHub Actions cache

```bash
docker buildx build \
  --cache-to type=gha,mode=max --cache-from type=gha \
  --target api examples/app
```

Inside `docker/build-push-action` the `url` and `token` parameters are
populated automatically:

```yaml title=".github/workflows/build.yaml" fragment
- uses: docker/build-push-action@v7
  with:
    cache-from: type=gha
    cache-to: type=gha,mode=max
```

Documented parameters include `url`/`url_v2`, `token`, `scope` (default
`buildkit`), `mode` (default `min`), `timeout` (default `10m`), `ghtoken` and
`version`. Give each image its own `scope`, or two targets in one workflow
will overwrite each other's cache. GitHub's own cache scoping rules still
apply: a job can read the current branch, the base branch and the default
branch, and nothing else. The backend is beta; treat cache misses after a
GitHub-side change as expected rather than as an incident.

### Choosing a layout

| Situation | Backend | Refs |
|---|---|---|
| One image, single stage | `inline` | the image itself |
| Multi-stage, any registry | `registry` `mode=max` | `<repo>/buildcache:<target>` |
| Per-branch warm start | `registry` | branch ref + `main` ref as a second `cache-from` |
| GitHub-hosted runners only | `gha` | one `scope` per target |
| Self-hosted runner with a volume | `local` | a pruned directory |

## Production considerations

Cache repositories need a retention policy. `mode=max` cache for an active
repo grows quickly, and most registries bill for it. A weekly job that
deletes cache tags older than a couple of weeks is usually enough, because a
stale cache simply misses rather than breaking.

Pull requests from forks must not write cache. A contributor who can write
your cache can plant a layer that later builds import. Build on PRs with
`--cache-from` only; the example workflow does this by clearing `cache-to`
with `--set '*.cache-to='`.

Cache imports cost time too. A `mode=max` import over a slow link can be
slower than rebuilding a small image. Measure before assuming; the useful
comparison is total job time, not cache hit count.

If your registry rejects the cache image, add `image-manifest=true` to
`--cache-to`: it makes BuildKit write a single image manifest instead of an
index. Since BuildKit v0.21 that is the default.

## Security considerations

- Cache is executable input. A layer imported from a cache reference is
  trusted as if it had been built locally. Whoever can push to the cache
  repository can influence your images. Give the cache repository the same
  access controls as the image repository.
- With `mode=max` the cache contains intermediate layers — including any file
  a build stage wrote and a later stage dropped. Do not put a private cache
  ref in a public registry namespace.
- Registry credentials for cache export are push credentials. In CI, scope
  them to the cache repository if your registry supports it.
- A cache import cannot be verified by signature today. If supply-chain
  integrity is the priority, restrict who can write cache and rebuild release
  artefacts with `--no-cache`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `cache export feature is currently not supported for docker driver` | Default driver, no containerd image store | Create a `docker-container` builder |
| Cache exports but never imports | Different ref, or the ref was overwritten by another target | One ref per target; check with `docker buildx imagetools inspect <cache-ref>` |
| First build after a base image bump misses everything | Expected: the base digest is part of every key | Nothing to fix |
| Compiler stage rebuilds every time | `mode=min` | `mode=max` |
| `gha` cache misses across branches | GitHub cache scoping | Warm from the default branch's scope |
| Registry rejects the cache push | Registry does not accept OCI indices | `image-manifest=true` |

## Common mistakes

- Pushing cache to the same tag as the image. It works with `inline` and is a
  mistake with `registry`: you either overwrite the image or ship the cache.
- Using `mode=max` with `inline`. Inline cache is `mode=min` by definition.
- Assuming cache export makes cache mounts portable. It does not —
  `type=cache` mounts stay on the builder. Both mechanisms are needed.
- Letting forked-PR builds write cache.
- Treating a cache miss as a bug. Content changed, or a key changed; find
  which vertex, using `--progress=plain` output.

## Related topics

- [BuildKit and buildx](buildkit-and-buildx.md)
- [Cache, secret and SSH mounts](cache-and-secret-mounts.md)
- [Docker in CI](docker-in-ci.md)
- [Registries](registries.md)
- [Layer caching](../docker-intermediate/layer-caching.md)
