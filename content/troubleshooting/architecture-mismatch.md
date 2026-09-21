---
title: Architecture mismatch
description: Why a container fails with "exec format error" or "no match for platform" — arm64 vs amd64 images, multi-arch manifests, buildx and --platform, emulation, and Apple Silicon pushing to amd64 clusters.
level: intermediate
type: troubleshooting
status: current
versions: Docker Engine 29, Kubernetes 1.37
prerequisites:
  - troubleshooting/method
  - docker-advanced/multi-platform-builds
  - foundations/oci-specifications
---

## Overview

`exec format error` and `no match for platform` are the two faces of one
problem: an image built for one CPU architecture is being run on another. It has
become common because developer laptops moved to arm64 (Apple Silicon, some
Windows and cloud dev machines) while most clusters run amd64. An image built
locally then runs on the laptop and fails in the cluster. This page explains the
mechanism and the fix: build multi-arch images, or the right single arch, with
`buildx`.

## Symptoms

- A container crashes immediately with `exec format error` (or the app exits
  before any of its own output).
- The kubelet reports `no match for platform in manifest` and the pod is
  `ImagePullBackOff` — see [ImagePullBackOff](imagepullbackoff.md).
- An image runs on your arm64 laptop but fails on an amd64 node, or vice versa.
- Under emulation the container runs but is unusually slow.

## How it works underneath

A compiled binary contains machine code for a specific architecture. Running an
amd64 binary on an arm64 kernel (or the reverse) fails at `execve` with `exec
format error` — the kernel cannot interpret the code. Containers do not
virtualise the CPU, so the image's architecture must match the node's, or an
emulator must stand in.

OCI images handle this with a **manifest list** (a multi-arch index): one tag
points at several per-architecture manifests, and the runtime selects the one
matching the node. `postgres:18` and the other public images the handbook pins
are multi-arch indexes covering amd64, arm64 and more. Two failure modes:

- **Single-arch image on the wrong node.** An image built only for arm64 has no
  amd64 entry, so an amd64 node's pull gets `no match for platform`, or (if
  forced) the binary fails with `exec format error`.
- **Emulation masks it locally.** Docker Desktop and BuildKit can run foreign
  binaries via QEMU (`binfmt_misc`). So an amd64 image "works" on an arm64 laptop
  under emulation and you never notice it is the wrong arch — until it reaches a
  node with no emulator and fails. Emulation is also slow and occasionally buggy,
  so it is for testing, not production.

### Why Apple Silicon → amd64 cluster bites

`docker build` on an arm64 laptop produces an **arm64** image by default. Push
that to an amd64 cluster and every pod fails with `exec format error` or the
node cannot find a matching platform. The build succeeded, the push succeeded,
the laptop ran it — the only broken link is the architecture, discovered in the
cluster.

## Diagnosis

1. **Check the image's architecture(s).**

   ```bash
   docker buildx imagetools inspect <image-ref>
   ```

   This lists every platform in the manifest list. A single `linux/arm64` entry
   for a tag you deploy to amd64 nodes is the bug.

2. **Check a local image's arch.**

   ```bash
   docker image inspect <image> --format '{{.Os}}/{{.Architecture}}'
   ```

3. **Check the node's architecture.**

   ```bash
   kubectl get nodes -o custom-columns=NAME:.metadata.name,ARCH:.status.nodeInfo.architecture
   ```

4. **Confirm the error class.** `exec format error` in the container log, or
   `no match for platform` in the pod Events, both point here.

## Fixes

- **Build multi-arch with `buildx`** so one tag serves every node:

  ```bash
  docker buildx build --platform linux/amd64,linux/arm64 -t <ref> --push .
  ```

  A multi-arch push requires `--push` (the local image store cannot hold a
  manifest list in the same way); the registry receives an index and each node
  pulls its match.

- **Build the single arch your cluster needs**, when you do not need multi-arch:

  ```bash
  docker buildx build --platform linux/amd64 -t <ref> --push .
  ```

- **For kind**, build for the node architecture and `kind load` it; kind nodes
  are the host's architecture, so an arm64 host runs arm64 nodes. Match the build
  to the node arch.

- **Pin base images that are multi-arch.** The handbook's base images
  (`golang`, `distroless`, `postgres`) are multi-arch indexes, so a multi-arch
  build of your own image just works across arches.

- **Do not rely on emulation in production.** Use it to test a foreign arch
  locally, but ship native images to each architecture.

## Prevention

- Make CI build **multi-arch** (or the exact cluster arch) rather than whatever
  the build agent happens to be — never let the agent's architecture leak into
  the artifact by accident.
- Verify the pushed manifest with `docker buildx imagetools inspect` as a CI
  gate.
- Keep base images multi-arch so your images can be too.
- Label or document node architectures, and use `nodeSelector`
  (`kubernetes.io/arch`) if you must pin a single-arch workload to matching
  nodes.

## Common mistakes

- Building on an Apple Silicon laptop and pushing an arm64-only image to an amd64
  cluster.
- Trusting that "it ran on my machine" proves the arch is right — emulation hides
  the mismatch.
- Forgetting `--push` on a multi-arch `buildx` build and ending up with an
  incomplete image.
- Running emulated images in production and paying the performance cost.
- Debugging the app for an `exec format error` that is purely an architecture
  problem.

## Related topics

- [A method for debugging Kubernetes](method.md)
- [ImagePullBackOff and ErrImagePull](imagepullbackoff.md)
- [Docker build cache and disk exhaustion](docker-disk-exhaustion.md)
- [Multi-platform builds](../docker-advanced/multi-platform-builds.md)
- [OCI specifications](../foundations/oci-specifications.md)
