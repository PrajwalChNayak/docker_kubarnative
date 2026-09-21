---
title: Images, tags and digests
description: What an image reference really points at, why tags are mutable and digests are not, and how an index differs from a manifest.
level: beginner
type: concept
status: current
versions: Docker Engine 29
prerequisites:
  - docker-beginner/running-containers
---

## Overview

An image is not a file. It is a small JSON **manifest** that lists a config
blob and a set of layer blobs, all stored in a registry and addressed by the
SHA-256 digest of their content. A **tag** is a mutable label pointing at one
of those manifests, and a **digest** is the manifest's own content address.

`postgres:18-trixie` and
`postgres@sha256:86c951e05bf56c93d95d397747fb8820ac76cc3bedb78f43abd83eedbe3666ae`
can refer to the same bytes today. Only the second one still will next month.

## Why it exists and when to use it

Content addressing gives you an identity that cannot be forged or quietly
changed: if the digest matches, the bytes match. Tags give humans something
pronounceable, at the cost of being repointable at any moment by whoever owns
the repository.

Pin by digest when you care about reproducibility and supply-chain integrity:
base images in a Dockerfile, images in a Compose file or a Kubernetes
manifest, anything a build depends on. Use tags when a human is typing at a
terminal and the exact bytes do not matter. The Tasklane Dockerfile does both
— the tag stays visible for readers, the digest is what BuildKit resolves:

```dockerfile include="examples/app/Dockerfile" lines="12-13"
```

## How it works underneath

A full reference has four parts:

```text
registry.example.com:5000/team/tasklane-api:0.1.0@sha256:<64 hex chars>
└── registry ───────────┘└── repository ──┘└─ tag ┘└──── digest ──────┘
```

Omit the registry and Docker assumes Docker Hub (`docker.io`). Omit the
namespace on Hub and it assumes `library`, so `alpine:3.22` is really
`docker.io/library/alpine:3.22`. Omit the tag and it assumes `latest`, which
is a tag like any other and carries no promise of being current.

Above the manifest sits an **index** (historically a "manifest list"). It maps
platforms to manifests:

```text
index (sha256:86c9…)                 ← what `postgres:18-trixie` points at
├── linux/amd64  → manifest sha256:… → config + layers
├── linux/arm64  → manifest sha256:… → config + layers
└── attestations → manifest sha256:…
```

The daemon picks the entry matching your platform and pulls only that
manifest's blobs. This has two consequences people trip over:

- The digest you pin in a Dockerfile or manifest is normally the **index**
  digest, which stays valid on every architecture. That is what the digests in
  `research/tooling-facts.md` are.
- The image ID you see locally is not the index digest. Historically it is the
  digest of the **config blob** for your platform; with the containerd image
  store, `docker image ls` can also show the index. Do not compare local IDs
  with registry digests and expect them to match.

`docker buildx imagetools inspect` asks the registry directly and shows the
index without pulling anything:

```bash
docker buildx imagetools inspect postgres:18-trixie
```

```console include="captures/docker-beginner/imagetools-index.txt"
```

Layers are shared across images by digest. Two images built on the same base
store that base once, which is why 15 images can occupy far less disk than
the sum of their sizes — see [Cleanup and disk usage](cleanup-and-disk-usage.md).

## Basic example

```bash
docker image ls alpine
docker image ls --digests postgres
docker image inspect tasklane-api:0.1.0 --format '{{.Id}} {{json .RepoTags}} {{json .RepoDigests}}'
```

```console include="captures/docker-beginner/image-ls.txt"
```

```console include="captures/docker-beginner/image-digests.txt"
```

The `RepoDigests` field is empty for an image you built locally and never
pushed: a digest only exists once a registry has stored the manifest.

```console include="captures/docker-beginner/image-inspect.txt"
```

## Explanation

**Tags are pointers, and they move.** `postgres:18` points at the newest 18.x
build. When 18.7 is published, the same tag resolves to different bytes. Your
laptop keeps the old image, CI pulls the new one, and you spend an afternoon
on "works on my machine". The pull policy makes it worse: the default,
`missing`, means a host that already has *something* tagged `18` never checks
again.

**`latest` is not special.** It is the default tag, nothing more. An image
whose `latest` was last pushed in 2019 still answers to `latest`.

:::warning Never `:latest` in anything that matters
In this handbook `:latest` is banned from production-grade examples and the
checker enforces it. A deployment that says `:latest` cannot be rolled back
reliably, cannot be reproduced, and gives a registry compromise a free path
into your cluster.
:::

**Digests are immutable, and also unreadable.** Keep the tag next to the
digest for humans, and let a bot (Renovate, Dependabot) bump both together.
That is the pattern in the Tasklane Dockerfile and in
`examples/compose/compose.yaml`:

```yaml include="examples/compose/compose.yaml" lines="27-29"
```

**Image IDs are local.** They identify the image inside your daemon. Pushing
the same image to two registries gives the same digest; rebuilding it may
give a different one, because layer content includes timestamps and ordering
unless you work at it ([reproducible builds](../docker-advanced/reproducible-builds.md)).

`docker image history` shows the layers and the instruction that produced
each one — useful for understanding size and cache behaviour:

```console include="captures/docker-beginner/image-history.txt"
```

## Common patterns

**Pin a base image by digest**

```dockerfile title="Dockerfile.fragment" fragment
FROM golang:1.27-trixie@sha256:433790e515d27dc6003e847e644cc0af956985cf315c1c58a3b73ee2dd305183
```

**Re-resolve a digest before publishing**

```bash
docker buildx imagetools inspect postgres:18-trixie --format '{{.Manifest.Digest}}'
```

**Tag the same image several ways**

```bash
docker image tag tasklane-api:0.1.0 registry.example.com/team/tasklane-api:0.1.0
docker image tag tasklane-api:0.1.0 registry.example.com/team/tasklane-api:0.1
```

Tagging creates no new image; it adds a name to the existing one.

**Use a meaningful version scheme.** Semantic version for releases, plus an
immutable build identifier (commit SHA) for traceability. Moving tags such as
`0.1` or `stable` are conveniences for humans, never deployment inputs.

## Production considerations

- Pin by digest in Dockerfiles, Compose files, Kubernetes manifests and Helm
  values. Record the tag in a comment.
- Rebuild regularly anyway. A pinned base image is a frozen set of CVEs;
  pinning without a refresh process trades one risk for another. See
  [base image patching](../docker-security/base-image-patching.md).
- Prefer a registry you control, mirrored or proxied, so a rate limit or an
  upstream deletion cannot stop a deployment.
- Treat digests as build outputs: have CI print the digest it pushed and feed
  that digest into the deployment, rather than re-resolving a tag later.
- Multi-platform images matter as soon as developers use ARM laptops and
  servers are x86-64. Part D covers
  [multi-platform builds](../docker-advanced/multi-platform-builds.md).

## Security considerations

- A tag is a mutable pointer controlled by whoever can push to the repository.
  Pinning by digest is the cheapest supply-chain control there is.
- A digest proves *what* the bytes are, not *who* made them or whether they
  are safe. Provenance and signatures answer that; see
  [image signing with cosign](../docker-advanced/image-signing-cosign.md) and
  [SBOMs and provenance](../docker-advanced/sboms-and-provenance.md).
- Typosquatting is real: `alpne`, or an unofficial `postgres` fork in a
  personal namespace. Official Docker Hub images live under `library/`, shown
  in the UI as "Docker Official Image".
- `gcr.io/distroless/*-debian12` tags are deprecated; use `-debian13`. An
  image that no longer receives updates is a growing liability.

## Troubleshooting

- **`manifest unknown`**: the tag or digest does not exist in that repository.
  Check spelling, and whether you are pointing at the right registry.
- **`no matching manifest for linux/arm64`**: the image has no build for your
  platform. Try `--platform linux/amd64` (emulated) or find an ARM build.
- **The same tag behaves differently on two machines**: one has an old copy.
  `docker pull` or run with `--pull always`, then compare digests.
- **`RepoDigests` is empty**: the image was built locally and never pushed.
- **Disk full of `<none>` images**: dangling images, left when a tag was moved
  to a newly built image. See [Cleanup and disk usage](cleanup-and-disk-usage.md).

## Common mistakes

- **Using `:latest` anywhere near production.**
- **Pinning a digest but never updating it**, then shipping a base image full
  of known CVEs.
- **Copying a digest from a blog post.** Digests change on every rebuild;
  re-resolve them yourself.
- **Assuming the local image ID equals the registry digest.** They are
  different objects.
- **Thinking `docker image tag` copies an image.** It creates a name.
- **Deleting a tag expecting the layers to go.** They persist until nothing
  references them; see pruning.

## Related topics

- [Pulling and pushing](pulling-and-pushing.md)
- [Cleanup and disk usage](cleanup-and-disk-usage.md)
- [Choosing base images](../docker-intermediate/choosing-base-images.md)
- [Registries](../docker-advanced/registries.md)
- [Image signing with cosign](../docker-advanced/image-signing-cosign.md)
- [ImagePullBackOff](../troubleshooting/imagepullbackoff.md)
- [OCI specifications](../foundations/oci-specifications.md)
