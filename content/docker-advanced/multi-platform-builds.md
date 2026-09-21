---
title: Multi-platform builds
description: Build one manifest list for amd64 and arm64, and choose between QEMU emulation, native nodes and cross-compilation with eyes open.
level: advanced
type: concept
status: current
versions: Docker Engine 29, Buildx 0.37
prerequisites:
  - docker-advanced/buildkit-and-buildx
  - docker-beginner/images-tags-digests
---

## Overview

An image reference like `postgres:18-trixie` does not point at an image. It
points at an **index** (a manifest list) that maps platforms to images. When
you pull it on an arm64 laptop and your colleague pulls it on an amd64
server, you get different bytes under the same name — and that is correct
behaviour, not a surprise.

Producing such an index for your own images is one `--platform` flag away.
Producing it *quickly* is where the decisions are.

## Why it exists and when to use it

Apple Silicon laptops are arm64. AWS Graviton, Ampere and Axion nodes are
arm64. Most CI runners and most on-premises servers are still amd64. A team
that publishes amd64 only forces every arm64 developer into emulation; a team
that publishes both pays for the second build.

Build multi-platform when developers and production differ in architecture,
when you deploy to mixed node pools, or when you publish images other people
run. Do not build platforms nobody uses: each extra platform is another full
build, another set of layers to store, and another thing to scan.

## How it works underneath

An OCI image index lists manifests with a `platform` object
(`architecture`, `os`, sometimes `variant`). The registry serves the index;
the client picks the entry matching its own platform and pulls that manifest,
then its layers. Attestations, when present, appear as extra manifests in the
same index, referenced from the index by `in-toto` predicate.

Look at a real one:

```bash
docker buildx imagetools inspect postgres:18-trixie
docker buildx imagetools inspect --raw postgres:18-trixie
```

```console include="captures/docker-advanced/imagetools-postgres.txt"
```

BuildKit builds one sub-graph per requested platform and exports them into a
single index. The Dockerfile is solved once per platform, which is why
platform-dependent instructions work at all — and why a two-platform build
does roughly twice the work unless you arrange otherwise.

### The three strategies

The Docker multi-platform documentation names three approaches.

**QEMU emulation.** `binfmt_misc` registers QEMU user-mode emulators for
foreign architectures; a foreign binary in the build container is transparently
interpreted. Easiest option, no Dockerfile change — and slow for anything
compute-bound. Compilers are the worst case: an emulated Go or Rust build can
take several times the native time, and some toolchains crash under
emulation. Docker Desktop installs the handlers for you; elsewhere:

```bash
docker run --privileged --rm tonistiigi/binfmt --install all
```

**Multiple native nodes.** One builder, several nodes, each pinned to a
platform it runs natively. Fastest and most faithful, but you have to own an
arm64 machine (or a managed builder). Nodes are appended to a single builder,
as shown in [BuildKit and buildx](buildkit-and-buildx.md#buildx-drivers).

**Cross-compilation.** Run the compiler natively on the build machine and ask
it to emit code for the target. No emulation, one compile per target, and the
compile itself runs at full speed. This is what the handbook's Dockerfile
does, and for Go it is nearly free.

## Basic example

The Tasklane build stage pins itself to the *build* platform and passes the
target platform to the compiler:

```dockerfile include="examples/app/Dockerfile" lines="15-35"
```

Build both architectures:

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  --target api -t ghcr.io/example/tasklane/tasklane-api:0.1.0 --push examples/app
```

Or through Bake, where the platform list is part of the definition:

```hcl include="examples/build/docker-bake.hcl" lines="44-54"
```

## Explanation

`FROM --platform=$BUILDPLATFORM golang:... AS build` is the whole trick. Without
it, BuildKit would pull the *arm64* golang image for the arm64 output and run
it under QEMU. With it, the builder's own architecture is used, and the
target is communicated through the automatic build arguments
`TARGETOS`/`TARGETARCH`, which Go consumes as `GOOS`/`GOARCH`.

BuildKit supplies these automatically, per the Dockerfile reference:
`TARGETPLATFORM`, `TARGETOS`, `TARGETARCH`, `TARGETVARIANT`, `BUILDPLATFORM`,
`BUILDOS`, `BUILDARCH`. They must be re-declared with `ARG` in the stage that
uses them, which is why `ARG TARGETOS TARGETARCH` appears before the build
step.

The runtime stage has no `--platform`, so it is resolved per target: the
arm64 output gets the arm64 distroless image. That is what you want.

## Common patterns

### Emulate only what cannot cross-compile

Interpreted runtimes usually need no cross-compilation at all — the arm64
base image plus your source is enough, and the only emulated part is whatever
native extension you install. Cross-compile the compiled parts; let the rest
be per-platform.

### One platform for the inner loop

`--load` accepts a single platform, because the Engine image store holds one
image per tag per platform. Keep a `dev` Bake target that narrows to the host
platform, and build the full list only in CI.

```bash
docker buildx bake -f examples/build/docker-bake.hcl dev --load
```

### Check what you published

```bash
docker buildx imagetools inspect ghcr.io/example/tasklane/tasklane-api:0.1.0
```

The output lists one entry per platform plus attestation manifests. If a
platform is missing, the build silently dropped it — usually because
`--platform` was overridden by a `--set` or an environment variable.

### Multi-platform locally without pushing

The default `docker` driver can build a multi-platform image only with the
containerd image store, which Engine 29 enables on fresh installs. Otherwise
use a `docker-container` builder and `--push`, or export to a tarball with
`--output type=oci,dest=image.tar`.

## Production considerations

Cost is the honest headline. Two platforms mean two builds, two sets of cache
entries, two SBOMs and two scan targets. On GitHub-hosted runners, amd64 and
arm64 runners both exist; splitting the build across two jobs and merging the
results with `docker buildx imagetools create` is faster than emulating, at
the price of a more complex workflow.

`linux/arm/v7` and `linux/386` are cheap to add and expensive to support.
Only publish a platform you can test.

Kubernetes nodes in a mixed cluster will pull whatever matches their node
architecture. A missing platform surfaces as `exec format error` in a
CrashLoopBackOff, not as a pull failure — see
[architecture mismatch](../troubleshooting/architecture-mismatch.md).

Pin base images by index digest, not per-platform digest. The digests in
`research/tooling-facts.md` and in the handbook's Dockerfile are index
digests, which resolve correctly on every platform.

## Security considerations

- QEMU emulation adds a binary translator inside your build. It is a large
  amount of C running on untrusted input; `--privileged` is required to
  install the handlers. Install binfmt handlers on build hosts deliberately,
  not as a step inside every pipeline.
- A manifest list can be re-pointed by a registry write. Deploy by digest so
  that "the arm64 variant changed" is not something an attacker can arrange
  silently.
- Attestations are per platform. Verifying the index is not the same as
  verifying the image your node runs; `cosign verify` on the index digest
  covers the index, and `--recursive` signs each child.
- Cross-compilation keeps foreign code out of the build entirely, which is a
  small but real security advantage over emulation.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `exec format error` at runtime | Image built for another architecture | Check `docker buildx imagetools inspect`; add the platform |
| `Multi-platform build is not supported for the docker driver` | Default driver without containerd image store | `docker-container` builder |
| `docker buildx build --load` fails with two platforms | `--load` is single-platform | Use `--push`, or narrow the platform |
| arm64 build takes 10x longer | QEMU emulation of the compiler | `--platform=$BUILDPLATFORM` plus `TARGETARCH` |
| `qemu: uncaught target signal 11` | Emulator limitation | Native node or cross-compilation |
| Only one platform in the published index | `--platform` overridden | `docker buildx bake --print` to see the resolved plan |

## Common mistakes

- Omitting `--platform=$BUILDPLATFORM` on the build stage and concluding that
  arm64 builds are inherently slow.
- Forgetting to re-declare `ARG TARGETARCH` inside the stage, then debugging
  why `GOARCH` is empty. BuildKit sets the value but each stage must declare
  the argument.
- Using `uname -m` inside a build to decide what to compile. That reports the
  *execution* platform, which under emulation is the target and under
  cross-compilation is the builder. Use the `TARGET*` arguments.
- Building `linux/arm64` for an Apple Silicon *developer* and forgetting that
  production is amd64, so the image nobody tested is the one that ships.
- Assuming a manifest list means the image was tested on both platforms.

## Related topics

- [BuildKit and buildx](buildkit-and-buildx.md)
- [Reproducible builds](reproducible-builds.md)
- [Registries](registries.md)
- [Images, tags and digests](../docker-beginner/images-tags-digests.md)
- [Architecture mismatch](../troubleshooting/architecture-mismatch.md)
