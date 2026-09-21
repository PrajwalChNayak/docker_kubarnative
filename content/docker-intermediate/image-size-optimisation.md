---
title: Image size optimisation
description: Find out where the megabytes are, remove them in the right order, and know when a smaller image stops being worth it.
level: intermediate
type: concept
status: current
versions: Docker Engine 29, Compose v5
prerequisites:
  - docker-intermediate/multi-stage-builds
  - docker-intermediate/choosing-base-images
---

## Overview

Image size costs pull time on every node that has not seen the image, storage
in every registry and cache, and attack surface in every running container. It
is also easy to over-optimise: past a point you are trading debuggability and
build complexity for megabytes nobody notices.

The order of effect is stable across ecosystems: base image and multi-stage
first, then what you copy, then layer hygiene, then binary-level tricks.

## Why it exists and when to use it

Pull time matters most where images are pulled often: autoscaling, spot
instances, CI runners, Kubernetes nodes joining a cluster, and any rollout
that touches many nodes at once. A 1.2 GB image that takes 90 seconds to pull
turns a scale-out into a latency incident.

Registry costs and Docker Hub's pull limits — 100 pulls per six hours
unauthenticated, per IPv4 address or IPv6 /64, 200 authenticated — add a second
reason to keep layers shared and images small.

## How it works underneath

An image is a stack of layers; each layer is a tar of the *changes* a step
made. Three consequences:

- **Deleting a file in a later layer does not remove it.** The file still
  exists in the earlier layer and still ships. This is why `RUN wget big.tar
  && ... && rm big.tar` as separate `RUN` steps saves nothing.
- **Layers are shared.** Two images from the same base share its layers on
  disk and during pulls. Ten images on a shared base cost less than ten
  unrelated small ones.
- **Compressed vs on-disk size differ.** `docker image ls` shows the
  uncompressed size; the registry stores compressed layers; `docker system df`
  accounts for sharing. Compare like with like.

`docker history` attributes size to instructions, which is where an
investigation starts.

## Basic example

The same Go service, single-stage and multi-stage:

```dockerfile include="examples/dockerfiles/size-naive-vs-optimised/Dockerfile.naive"
```

```dockerfile include="examples/dockerfiles/size-naive-vs-optimised/Dockerfile.optimised"
```

```bash
docker build -f examples/dockerfiles/size-naive-vs-optimised/Dockerfile.naive -t sizedemo-naive:0.1.0 examples/dockerfiles/size-naive-vs-optimised
docker build -f examples/dockerfiles/size-naive-vs-optimised/Dockerfile.optimised -t sizedemo-optimised:0.1.0 examples/dockerfiles/size-naive-vs-optimised
docker image ls sizedemo-naive:0.1.0 sizedemo-optimised:0.1.0
docker history sizedemo-naive:0.1.0
```

Sizes of the two images:

```console include="captures/docker-intermediate/size-images.txt"
```

Where the naive image's bytes are:

```console include="captures/docker-intermediate/history-naive.txt"
```

And the optimised one:

```console include="captures/docker-intermediate/history-optimised.txt"
```

## Explanation

The single-stage image ships the Go toolchain (hundreds of megabytes), the
module cache, the source tree and a Debian userland, to run one static binary.
The multi-stage image ships the binary plus a distroless base.

Ordered by how much each change buys:

1. **Multi-stage.** Removes the entire build environment. Almost always the
   largest single win.
2. **A smaller runtime base.** `static-debian13` instead of `golang`, or
   `-slim` instead of a full distribution image.
3. **Copy artefacts, not trees.** `COPY --from=build /out/app /app`, not the
   whole `/src`.
4. **Layer hygiene.** Clean up inside the same `RUN` that created the mess,
   or better, never create it: cache mounts keep package caches out of layers
   entirely.
5. **Binary-level.** `-ldflags="-s -w"` strips symbols and DWARF from Go
   binaries; production dependency pruning (`npm ci --omit=dev`) removes dev
   dependencies; compiled-language debug info can move to a separate artefact.

## Common patterns

**Cache mounts instead of cleanup incantations.**

```dockerfile title="apt-cache-mount.Dockerfile" fragment
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates
```

Nothing from the cache lands in the layer, and rebuilds do not re-download.
Where you cannot use cache mounts, do it the old way in one step:
`apt-get update && apt-get install -y --no-install-recommends X && rm -rf /var/lib/apt/lists/*`.

**`--no-install-recommends` / `--no-cache` / `--omit=dev`.** One flag per
ecosystem that removes a lot: apt recommends, apk's index cache, npm dev
dependencies, pip's wheel cache (`--no-cache-dir`).

**Dependency stage.** Install into a clean prefix (`/usr/local`, a virtualenv,
`node_modules`) in one stage, `COPY --from=` it into the runtime stage. You get
the installed tree without the package manager's caches, lists and build
toolchain.

**`COPY --link`** so copied layers stay valid when earlier layers change, and
can be rebased onto a patched base image without rebuilding.

**Share a base across your images.** Same base digest everywhere means one
download per node, not one per service.

**Squash only if you measured.** Flattening an image removes shared layers,
which frequently makes total pull volume *worse* across a fleet.

## Production considerations

Measure what you actually care about. Cold pull time on a node is a function
of compressed size and layer count; disk on a node is a function of unique
layers across all images there. `docker system df -v` shows the latter.

Big wins that are not the Dockerfile: a pull-through registry mirror close to
the nodes, and (in Kubernetes) `imagePullPolicy: IfNotPresent` with immutable
tags so nodes stop re-pulling the same content.

Do not optimise away your ability to operate. A distroless image with no shell
is right for production *if* you have decided how to debug it — `docker debug`,
a separate debug tag, or `kubectl debug` with an ephemeral container.

Beyond a few tens of megabytes, further shrinking usually costs more engineer
time than it saves. Spend the next hour on something else.

## Security considerations

- Smaller images contain fewer packages, which means fewer CVEs to triage and
  fewer tools for an attacker. That is the durable benefit; the megabytes are
  secondary.
- A secret written in one layer and deleted in the next is still in the image
  and readable with `docker save`. Size cleanup does not delete it; only never
  writing it does. Use `RUN --mount=type=secret`.
- `docker history` can expose build arguments and commands; provenance
  attestations in `max` mode include build args. Neither is a place for
  credentials.
- Stripping symbols (`-s -w`) makes post-incident analysis harder. Keep an
  unstripped copy of release binaries somewhere you can reach.

## Troubleshooting

**"The image is huge and I do not know why."**

```bash
docker history --no-trunc --format '{{.Size}}\t{{.CreatedBy}}' <image>
docker image inspect --format '{{len .RootFS.Layers}}' <image>
```

**`docker image ls` and the registry disagree.** Uncompressed vs compressed.
Use `docker manifest inspect` or the registry UI for pushed sizes.

**Disk fills up although images are small.** Build cache and volumes.
`docker system df` and `docker builder prune`.

**A deleted file still costs space.** It was deleted in a later layer. Move
the deletion into the same `RUN`, or avoid creating it.

**Multi-platform images look twice as large.** An index holds one manifest per
platform; a node pulls only its own.

## Common mistakes

- Chasing layer count. Layer count barely matters; content does.
- `RUN rm -rf` in a separate step from the one that created the files.
- Installing build tools in the runtime stage "just in case".
- Copying the whole build stage instead of the artefact.
- Switching to Alpine to save 40 MB on a Python service and paying for it in
  build time and compatibility.
- Squashing images, losing layer sharing across a fleet.
- Optimising an image that is pulled once a week on one host.

## Related topics

- [Multi-stage builds](multi-stage-builds.md)
- [Choosing base images](choosing-base-images.md)
- [Layer caching](layer-caching.md)
- [Cleanup and disk usage](../docker-beginner/cleanup-and-disk-usage.md)
- [Cache and secret mounts](../docker-advanced/cache-and-secret-mounts.md)
- [Docker disk exhaustion](../troubleshooting/docker-disk-exhaustion.md)
