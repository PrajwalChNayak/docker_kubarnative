---
title: Cache, secret and SSH mounts
description: Use RUN --mount to keep compiler caches between builds and to pass credentials into a build without ever writing them into a layer.
level: advanced
type: concept
status: current
versions: Docker Engine 29, Buildx 0.37
prerequisites:
  - docker-advanced/buildkit-and-buildx
  - docker-intermediate/layer-caching
---

## Overview

`RUN --mount` attaches a filesystem to a single build step. The step sees it,
uses it, and the mount disappears when the step ends. Nothing about it is
committed to the layer. That one mechanism solves two unrelated problems:
package-manager and compiler caches that used to be thrown away on every
build, and credentials that used to end up baked into images.

Four mount types matter in practice: `cache`, `secret`, `ssh` and `bind`.
`tmpfs` rounds out the set.

## Why it exists and when to use it

Before mounts, a build had exactly two ways to get data into a step: copy it
into the context, or pass it as a build argument. Both are permanent. A
`COPY`'d `.npmrc` is in a layer forever even if a later step deletes it,
because deleting a file only adds a whiteout in the next layer. A build arg
is recorded in the image config and printed by `docker history`.

Mounts break that link. The Docker build-secrets documentation puts the
warning plainly: "Build arguments and environment variables are
inappropriate for passing secrets to your build, because they persist in the
final image."

Use a **cache mount** when a tool maintains its own on-disk cache: Go module
and build caches, npm/pnpm stores, pip wheels, Maven `~/.m2`, cargo
registries, apt lists. Use a **secret mount** for any credential. Use an
**SSH mount** when the credential is a key you should not copy at all.

## How it works underneath

BuildKit models each mount as an extra input edge on the LLB vertex for that
`RUN`. The distinction that matters is whether the mount contributes to the
vertex's cache key:

- A **bind mount** from a stage or context does: its content is part of the
  key, because the command's output depends on it.
- A **cache mount** does **not**. Its contents are mutable builder state,
  shared across builds, and deliberately excluded from the key. If it were
  included, no build would ever hit cache.
- A **secret mount** does not contribute its *value* either. The ID is part
  of the definition; the bytes are not. That is why rotating a token does not
  invalidate the layer — and why you must not rely on a secret change to
  force a rebuild.

Secret mounts are backed by a tmpfs inside the step's mount namespace. The
default path is `/run/secrets/<id>`. SSH mounts forward the *agent socket*,
not a key: the build can ask the agent to sign, but cannot read the key.

Cache mount `sharing` controls concurrency between builds using the same
cache ID: `shared` (default, concurrent writers allowed), `locked` (second
build waits) and `private` (a new, empty cache for the second build). Use
`locked` for tools whose cache is not concurrency-safe — many package
managers are not.

## Basic example

The Tasklane Dockerfile uses two cache mounts, one for the Go module cache
and one for the compiler's build cache:

```dockerfile include="examples/app/Dockerfile" lines="21-35"
```

The secret and SSH demonstration lives in its own file:

```dockerfile include="examples/build/Dockerfile.secret-demo"
```

Build it:

```bash
export NPM_TOKEN=not-a-real-token
printf 'hunter2' > /tmp/api_token
docker buildx build -f examples/build/Dockerfile.secret-demo \
  --secret id=api_token,src=/tmp/api_token \
  --secret id=NPM_TOKEN \
  --ssh default \
  --output type=local,dest=./out \
  examples/build
```

## Explanation

The `--mount=type=cache,target=/go/pkg/mod` on `go mod download` means the
module cache survives between builds. The second build of a changed source
file re-runs `go build` but downloads nothing. Because the mount is not part
of the cache key, a change to `go.sum` still invalidates the `COPY` above it
and re-runs the download — with a warm cache directory underneath, so it
fetches only what is new.

On the secret side, three forms appear:

| Form | CLI | In the Dockerfile |
|---|---|---|
| From a file | `--secret id=api_token,src=/tmp/api_token` | `--mount=type=secret,id=api_token` |
| From an environment variable | `--secret id=NPM_TOKEN` or `--secret id=npm,env=NPM_TOKEN` | `--mount=type=secret,id=NPM_TOKEN,env=NPM_TOKEN` |
| SSH agent | `--ssh default` | `--mount=type=ssh` |

`required=true` is not optional in production pipelines. Without it a missing
secret mounts as an empty file and the build "succeeds" with an
unauthenticated artefact, which you discover much later.

For private Git dependencies BuildKit understands two predefined secret IDs:
`GIT_AUTH_TOKEN`, which it uses with Basic authentication and the fixed
username `x-access-token`, and `GIT_AUTH_HEADER` for custom schemes. Both can
be scoped per host, for example
`--secret id=GIT_AUTH_TOKEN.github.com,env=GITHUB_TOKEN`.

## Common patterns

### Mount option reference

From the Dockerfile reference:

| Type | Options |
|---|---|
| `cache` | `id`, `target`, `ro`, `sharing` (`shared`\|`private`\|`locked`), `from`, `source`, `mode` (default `0755`), `uid`, `gid` |
| `secret` | `id`, `target`, `env`, `required` (default `false`), `mode` (default `0400`), `uid`, `gid` |
| `ssh` | `id` (default `default`), `target` (default `/run/buildkit/ssh_agent.${N}`), `required`, `mode` (default `0600`), `uid`, `gid` |
| `bind` | `target`, `source`, `from`, `rw` |
| `tmpfs` | `target`, `size` |

### apt without the layer bloat

```dockerfile title="Dockerfile" fragment
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install --no-install-recommends -y ca-certificates=<pinned-version>
```

Two details: `sharing=locked` because apt's lock is not shared-safe, and the
Debian images ship a config that deletes downloaded `.deb` files — remove
`/etc/apt/apt.conf.d/docker-clean` if you want the cache to be useful.

### Do not run the build as root and write to a root-owned cache

`uid` and `gid` exist for exactly that. A cache mount owned by `0:0` under a
`USER 1000` step fails with permission errors that look like tool bugs.

### Bind mounts instead of COPY

```dockerfile title="Dockerfile" fragment
RUN --mount=type=bind,source=go.sum,target=go.sum \
    --mount=type=bind,source=go.mod,target=go.mod \
    go mod download
```

The files are visible to the step without being copied into the layer.
Useful when a step needs a large input it should not carry.

## Production considerations

Cache mounts are per builder. An ephemeral CI runner has an empty one on
every job, so the cache mount buys nothing there — that is what
[remote build cache](remote-build-cache.md) is for. Cache mounts and registry
cache are complementary, not alternatives: the registry cache restores
*layers*, the cache mount speeds up the work inside a layer that has to run.

Cache mounts grow. `docker buildx du --verbose` shows them; `docker buildx
prune --filter 'until=168h'` bounds them. On a long-lived build host, set
`builder.gc` policy in `daemon.json` rather than relying on anyone
remembering.

Give the cache an explicit `id` when the target path is shared by several
projects (`id=tasklane-gomod`), otherwise unrelated builds interleave in one
directory.

## Security considerations

- Build secrets are for *build-time* credentials. A secret your application
  needs at runtime does not belong in the build at all — mount it at run
  time. See [secrets in images](../docker-security/secrets-in-images.md).
- A secret mount protects the layer, not the process. If the step writes the
  secret to a file that a later `COPY` picks up, it is in the image. Check
  with `docker history --no-trunc` and by exporting the filesystem.
- Provenance at `mode=max` records secret *IDs* but not values; build-arg
  values, by contrast, are recorded. Never pass a credential as `ARG`.
- A shared builder shares cache mounts. Two builds that use the same cache ID
  can read each other's cached files. For untrusted multi-tenant builds, use
  separate builders.
- `--ssh default` forwards your agent into the build. Any `RUN` in that
  Dockerfile can use it while it runs. Only forward the agent into
  Dockerfiles you trust, and prefer a deploy key with read-only scope.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `failed to solve: secret <id> not found` | Secret declared `required=true`, not passed | Add `--secret id=<id>,...` |
| The secret file is empty | Not passed, and `required` defaults to `false` | Set `required=true` |
| `permission denied` writing to a cache mount | Mount owned by root, step runs as non-root | `uid=`/`gid=` on the mount |
| Cache mount seems ignored between builds | Different builder, or different mount `id`/`target` | `docker buildx ls`; give the mount an explicit `id` |
| apt cache mount does nothing | `docker-clean` config deletes packages | Remove `/etc/apt/apt.conf.d/docker-clean` in the same stage |
| Two parallel builds corrupt the cache | `sharing=shared` with a non-concurrent tool | `sharing=locked` |

## Common mistakes

- Using `ARG` for a token "because it is only during the build". It is in
  the image config afterwards.
- Echoing a secret to check it worked. The build log is an artefact too, and
  in CI it is usually world-readable inside the org.
- Expecting a rotated secret to invalidate cache. Secret values are excluded
  from the cache key by design.
- `COPY . .` before the dependency step, so the dependency cache mount is
  behind an always-invalidated layer. Copy manifests first.
- Mounting a cache at a path the tool does not actually use. Confirm with the
  tool (`go env GOMODCACHE`, `npm config get cache`) instead of guessing.

## Related topics

- [BuildKit and buildx](buildkit-and-buildx.md)
- [Remote build cache](remote-build-cache.md)
- [Build args vs env](build-args-vs-env.md)
- [Layer caching](../docker-intermediate/layer-caching.md)
- [Secrets in images](../docker-security/secrets-in-images.md)
