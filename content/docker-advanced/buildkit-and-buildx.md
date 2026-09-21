---
title: BuildKit and buildx
description: How BuildKit turns a Dockerfile into a content-addressed build graph, and what each buildx driver changes about where that graph runs.
level: advanced
type: concept
status: current
versions: Docker Engine 29, Buildx 0.37
prerequisites:
  - docker-intermediate/layer-caching
  - docker-intermediate/multi-stage-builds
---

## Overview

`docker build` has not been a sequential interpreter of Dockerfile lines
since BuildKit became the default builder. It is a compiler front end plus a
parallel, content-addressed solver. Understanding that shape explains most of
what looks like magic: why unrelated stages build at the same time, why a
cache hit can happen before the source is even read, why `--target` can skip
whole branches of a build, and why a cache mount is not a layer.

This page covers the internals — LLB, frontends, the solver, the cache — and
then the practical layer on top: buildx drivers, which decide *where* the
solver runs and therefore which features are available at all.

## Why it exists and when to use it

The pre-BuildKit builder executed one instruction at a time in the daemon,
committed a layer after each, and cached by comparing instruction strings and
parent layer IDs. It could not run two stages in parallel, could not skip a
stage that nothing depended on, could not mount a secret without leaving it
in an image, and could not export cache anywhere except into an image.

BuildKit replaces that model:

| Need | Pre-BuildKit | BuildKit |
|---|---|---|
| Independent stages | Sequential | Parallel |
| Unused stage | Built anyway | Never solved |
| Secrets during build | `ARG` or a copied file | `RUN --mount=type=secret` |
| Compiler caches | Lost between builds | `RUN --mount=type=cache` |
| Cache sharing between machines | Inline only | registry, local, gha backends |
| Cross-platform | One image per build | One manifest list per build |
| Non-Dockerfile inputs | None | Any frontend image |

You are already using it. What is worth choosing deliberately is the
**driver**, because the default one cannot do several of the things above.

## How it works underneath

### LLB: the intermediate representation

BuildKit does not execute Dockerfiles. It executes **LLB** — a low-level
build definition that the BuildKit README compares to LLVM IR: "LLB is to
Dockerfile what LLVM IR is to C." LLB is a directed acyclic graph of vertices
(run this process with these mounts; fetch this source; copy these paths),
marshalled as Protobuf, and the README describes it as "concurrently
executable", "efficiently cacheable" and "vendor-neutral".

Everything downstream operates on the graph, not on your text file. A stage
that nothing depends on has no edge into the requested output, so it is never
solved. Two stages that share only a base image are two independent
sub-graphs, so they run at the same time.

### Frontends: Dockerfile is just one language

A **frontend** converts a build definition into LLB. The built-in one is
`dockerfile.v0`. The other, `gateway.v0`, lets any image act as a frontend —
which is exactly what the `# syntax=` line selects:

```dockerfile title="examples/app/Dockerfile" fragment
# syntax=docker/dockerfile:1
# check=error=true
```

BuildKit pulls that image and asks it to produce LLB. This is why new
Dockerfile syntax works on an old daemon: the language implementation ships
from a registry, not with your Engine. The handbook pins `:1`, which
currently resolves to frontend 1.26.0 on Docker Hub even though 1.27.0
exists.

:::tip
`# check=error=true` turns [build checks](https://docs.docker.com/build/checks/)
into build failures. Run them without building at all with
`docker buildx build --check .`.
:::

### The solver

The solver walks the LLB graph backwards from the requested outputs, computes
a cache key for each vertex, and only executes vertices whose result it does
not already have. Cache keys are content-based, not string-based: for a
`COPY`, the key includes a checksum of the copied files, so touching a file
without changing its bytes does not invalidate anything. The result is
content-addressed too, so two different paths to the same content converge.

There is a second, cheaper key: BuildKit can match a cache record *before*
computing the expensive input. If a remote cache entry says "this `COPY` of
these file checksums produced this layer", the layer is fetched rather than
recomputed. This is why a warm registry cache can skip work whose inputs were
never even read.

### Where the state lives

Each builder keeps its own state: the layer store for build results, the
content-addressed cache records, and any `type=cache` mount directories. This
is **not** the Engine image store. A cache mount lives in the builder's
state, is shared between builds on that builder, and never becomes a layer.

```bash
docker buildx du
docker buildx du --verbose
docker buildx prune --filter 'until=168h' --reserved-space 10GB
```

```console include="captures/docker-advanced/buildx-du.txt"
```

## Basic example

List the builders the Engine knows about:

```bash
docker buildx ls
docker buildx inspect default
```

```console include="captures/docker-advanced/buildx-ls.txt"
```

Create a dedicated container builder and use it:

```bash
docker buildx create --name tasklane --driver docker-container --bootstrap --use
docker buildx build --target api -t tasklane-api:0.1.0 examples/app
```

## Explanation

`docker buildx ls` prints one row per builder, then one indented row per node
with its status, BuildKit version and the platforms it advertises. The
platform list is the important column: it tells you what a multi-platform
build can produce natively and what would have to be emulated.

`--bootstrap` starts the builder immediately instead of on first build, so
failures surface at create time. `--use` switches the current builder, which
is per Docker context — a detail that bites when you switch contexts and
wonder where your cache went.

## Buildx drivers

The driver decides where BuildKit runs. From the Docker build-drivers
documentation:

| Driver | What it is | Load into image store | Cache export | Multi-arch images | BuildKit config |
|---|---|---|---|---|---|
| `docker` (default) | BuildKit bundled into the Docker daemon | yes | limited | with the containerd image store | no |
| `docker-container` | A BuildKit container managed by buildx | no (needs `--load`) | yes | yes | yes |
| `kubernetes` | BuildKit pods in a cluster | no | yes | yes | yes |
| `remote` | Connects to a buildkitd you run | no | yes | yes | externally |
| `cloud` | Managed builder in Docker Build Cloud | conditional | yes | yes | managed by Docker |

The docs note that "the `docker` driver doesn't support all cache export
options" and that the default driver supports the `inline`, `local`,
`registry` and `gha` cache backends "but only if you have enabled the
containerd image store".

The practical rule: the moment you need a registry cache, a manifest list, or
a custom BuildKit configuration, create a `docker-container` builder. It
costs one container and one volume.

### docker-container

```bash
docker buildx create --name tasklane --driver docker-container \
  --driver-opt image=moby/buildkit:v0.33.0,network=host --bootstrap
```

Documented `--driver-opt` keys include `image`, `memory`, `cpu-quota`,
`cpu-period`, `cpuset-cpus`, `cgroup-parent` (default `/docker/buildx`),
`network`, `restart-policy` (default `unless-stopped`), `default-load`
(default `false`) and `env.<key>`. Cache persists in a dedicated Docker
volume, so the builder survives restarts.

### kubernetes

```bash
docker buildx create --bootstrap --name kube --driver kubernetes \
  --driver-opt namespace=buildkit,replicas=3,requests.cpu=2,requests.memory=4Gi
```

Documented options cover `image`, `namespace`, `replicas`, `requests.*`,
`limits.*`, `nodeselector`, `tolerations`, `schedulername`, `serviceaccount`,
`annotations`, `labels`, `loadbalance`, `timeout`, `rootless`,
`qemu.install`, `qemu.image` and `default-load`. Native multi-architecture
builds use one node per architecture, appended to the same builder:

```bash
docker buildx create --bootstrap --name kube --driver kubernetes \
  --platform=linux/amd64 --node=builder-amd64 \
  --driver-opt=namespace=buildkit,nodeselector="kubernetes.io/arch=amd64"
docker buildx create --append --bootstrap --name kube --driver kubernetes \
  --platform=linux/arm64 --node=builder-arm64 \
  --driver-opt=namespace=buildkit,nodeselector="kubernetes.io/arch=arm64"
```

### remote

```bash
docker buildx create --name remote --driver remote tcp://localhost:1234
```

Options are `cacert`, `cert`, `key`, `servername` and `default-load`. The
endpoint can also be `kube-pod://buildkitd-XXXXXXXXXX-xxxxx`, which connects
to a single pod through the Kubernetes API. `remote` is the driver to reach
for when a platform team runs buildkitd centrally and developers should not
each carry a builder.

## Common patterns

- **One builder per project** when projects have very different cache
  profiles. Cache is per builder, and a shared builder means one noisy repo
  evicting another's cache.
- **`--call=check` in CI** before the real build: it runs the Dockerfile
  checks and exits, which is seconds instead of minutes.
- **`--print` with Bake** to review the resolved plan in review, not after a
  failed push. See [remote build cache](remote-build-cache.md) and
  [`examples/build/README.md`](../../examples/build/README.md).
- **Explicit `--builder`** in scripts rather than relying on `--use`, so the
  script does not depend on a developer's current selection.

## Production considerations

Builder state grows without bound unless you bound it. Engine 29 exposes
garbage collection policy in `daemon.json` under `builder.gc`, with
`defaultReservedSpace`, `maxUsedSpace`, `minFreeSpace`, `keepDuration` and
filters; buildx exposes the same knobs per prune with `--reserved-space`,
`--max-used-space` and `--min-free-space`. Pick numbers deliberately: a
builder that fills the disk takes the daemon with it.

BuildKit is a remote code execution service by design — it runs whatever the
Dockerfile says. A shared builder is a shared trust boundary: builds from
different teams can see each other's cache mounts if they share cache mount
IDs. Separate builders, or at least separate cache IDs, for separate trust
domains.

## Security considerations

- `RUN --security=insecure` and `--allow security.insecure` give a build
  effectively privileged access. Never enable it on a shared builder.
- `--allow network.host` lets a build reach your host network, including
  metadata services. Treat it as a privilege grant.
- The `gateway.v0` frontend means `# syntax=` pulls and executes an image
  from a registry. Pin it by digest in a hostile environment.
- Provenance at `mode=max` embeds the Dockerfile and build-arg values. That
  is a feature until a build arg holds a token — see
  [build args vs env](build-args-vs-env.md).

## Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| `ERROR: Multi-platform build is not supported for the docker driver` | Default driver without the containerd image store | `docker info`; create a `docker-container` builder |
| `cache export feature is currently not supported for docker driver` | Same | Same |
| Cache never hits in CI | Ephemeral runner, no remote cache backend | [remote build cache](remote-build-cache.md) |
| Builder disappeared after switching contexts | Builders are per context | `docker context ls`, then `docker buildx ls` |
| Disk full on the build host | Unbounded builder state | `docker buildx du`, `docker buildx prune` |

## Common mistakes

- Assuming `docker build` and `docker buildx build` differ. `docker build` is
  an alias for `docker buildx build`; the difference is the driver, not the
  command.
- Expecting `docker images` to show a multi-platform build. Without
  `--load`, nothing enters the Engine image store, and `--load` accepts a
  single platform only.
- Pruning the Engine (`docker system prune`) and expecting build cache in a
  `docker-container` builder to go with it. It does not; use
  `docker buildx prune`.
- Treating a cache mount as a layer. It is builder state. A fresh builder, or
  a CI runner, starts cold unless you export cache somewhere shared.
- Adding `--no-cache` to "fix" a build. It hides the real invalidation and
  makes every later build slow. Find the vertex that changed instead.

## Related topics

- [Cache, secret and SSH mounts](cache-and-secret-mounts.md)
- [Remote build cache](remote-build-cache.md)
- [Multi-platform builds](multi-platform-builds.md)
- [Reproducible builds](reproducible-builds.md)
- [Docker in CI](docker-in-ci.md)
- [Layer caching](../docker-intermediate/layer-caching.md)
- [Multi-stage builds](../docker-intermediate/multi-stage-builds.md)
