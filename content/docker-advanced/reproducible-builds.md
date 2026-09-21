---
title: Reproducible builds
description: Make the same source produce the same image digest with SOURCE_DATE_EPOCH, rewrite-timestamp, pinned digests and deterministic compiler flags.
level: advanced
type: concept
status: current
versions: Docker Engine 29, Buildx 0.37
prerequisites:
  - docker-advanced/buildkit-and-buildx
  - docker-advanced/build-args-vs-env
---

## Overview

Build the same commit twice, an hour apart, and you normally get two
different image digests. Nothing changed except timestamps and a few
machine-specific paths — but the digest is a hash, so "nothing changed"
becomes "completely different artefact".

Reproducible builds close that gap. The goal is modest and precise: given the
same source and the same declared inputs, produce a byte-identical image.
Achieving it fully is hard; achieving most of it is a handful of settings
that also make your builds easier to debug.

## Why it exists and when to use it

Three concrete payoffs:

1. **Verification.** A third party can rebuild your release and check that
   the digest matches. That turns "trust the publisher" into "check the
   claim", which is the whole argument of SLSA.
2. **Diffing.** When two images differ, a reproducible build tells you the
   difference is real, not noise from timestamps.
3. **Cache and storage.** Identical layers deduplicate in registries and on
   nodes. Non-deterministic builds push new blobs for unchanged content.

You do not need bit-for-bit reproducibility to ship software. You do need it
if you make supply-chain claims, if you are in a regulated environment that
asks "prove this binary came from this source", or if you want a rebuild to
be a meaningful check rather than a coin toss.

## How it works underneath

Four categories of non-determinism dominate container images.

**Timestamps.** Every layer's file metadata and the image config's `created`
field carry wall-clock times. BuildKit supports the cross-ecosystem
`SOURCE_DATE_EPOCH` convention, described in the Docker documentation as "a
standardized environment variable for instructing build tools to produce a
reproducible output". BuildKit reads it as a special build argument, and it
affects the `created` timestamp in the OCI image config, the `created`
timestamps in the config's `history` entries, the
`org.opencontainers.image.created` annotation on the index, and file
timestamps exported by the `local` and `tar` exporters.

Layer file timestamps are a separate step. The image exporter takes an
option:

```bash
docker buildx build \
  --output type=image,name=ghcr.io/example/tasklane/tasklane-api:0.1.0,push=true,rewrite-timestamp=true \
  --target api examples/app
```

`rewrite-timestamp=true` requires BuildKit v0.13 or later. BuildKit also
accepts `SOURCE_DATE_EPOCH=context`, which resolves the timestamp from the
build context itself — the Git commit time, or an HTTP `Last-Modified`.

**Inputs that move.** `FROM golang:1.27` is a promise about a tag, and tags
move. Pin by digest, as the handbook's Dockerfile does. The same applies to
package installs: `apt-get install foo` today and tomorrow are different
builds. Snapshot repositories or pinned versions are the only fix.

**Compiler and archive metadata.** Go embeds the build path and a build ID
unless told otherwise. The Tasklane build uses `-trimpath` to strip absolute
paths and `-buildid=` to clear the build ID; `-s -w` drop the symbol table
and DWARF data, which also removes path-dependent bytes. Other toolchains
have equivalents (`-ffile-prefix-map` for GCC and Clang, `SOURCE_DATE_EPOCH`
support in many archivers).

**Ordering and concurrency.** Anything that depends on directory iteration
order, network timing or parallelism can vary. Tar archives written from a
filesystem walk are the classic case; BuildKit normalises this, but a
`RUN tar` in your own build does not.

## Basic example

```dockerfile include="examples/app/Dockerfile" lines="26-35"
```

```bash
export SOURCE_DATE_EPOCH="$(git log -1 --pretty=%ct)"
docker buildx build --target api \
  --output type=image,name=ghcr.io/example/tasklane/tasklane-api:0.1.0,push=true,rewrite-timestamp=true \
  examples/app
```

In GitHub Actions, the documented pattern sets it as an environment variable
on the build step:

```yaml title=".github/workflows/build.yaml" fragment
- name: Build
  uses: docker/build-push-action@v7
  env:
    SOURCE_DATE_EPOCH: 0
```

or from the commit:

```yaml title=".github/workflows/build.yaml" fragment
- run: echo "TIMESTAMP=$(git log -1 --pretty=%ct)" >> "$GITHUB_ENV"
- uses: docker/bake-action@v7
  env:
    SOURCE_DATE_EPOCH: ${{ env.TIMESTAMP }}
```

## Explanation

`-trimpath` removes `/src/...` from the binary, so the same source compiled
in a different directory produces the same bytes. `-buildid=` clears Go's
content-derived build ID, which otherwise varies with those paths.
`CGO_ENABLED=0` removes the host's libc and linker from the equation
entirely.

Setting `SOURCE_DATE_EPOCH` to the commit time rather than `0` keeps the
timestamps meaningful — tooling that sorts images by creation date still
works — while making them a function of the source rather than of the clock.

The distroless base is pinned by index digest, so the runtime layers are
fixed bytes. Between the pinned base, the deterministic compiler output and
the rewritten timestamps, a rebuild of the same commit should produce the
same digest.

## Common patterns

### Verify the claim

Reproducibility you never check is a hope, not a property. Build twice and
compare:

```bash
docker buildx build --target api --output type=oci,dest=a.tar examples/app
docker buildx build --target api --no-cache --output type=oci,dest=b.tar examples/app
sha256sum a.tar b.tar
```

Add it to a weekly job rather than to every build; a daily rebuild that
compares against the published digest catches regressions and doubles as a
canary for a compromised builder.

### Pin everything that is pulled

| Input | How to pin |
|---|---|
| Base image | `image:tag@sha256:...` index digest |
| Dockerfile frontend | `# syntax=docker/dockerfile:1.27.0` or a digest |
| OS packages | exact versions, or a snapshot repository |
| Language dependencies | lockfile, committed, with checksums |
| Tools fetched by the build | `ADD --checksum=sha256:...` |

### Keep volatile data out of the image

A build timestamp label, a random UUID, or a `RUN date > /build-info` makes
reproducibility impossible by construction. Put that information in
provenance, where it belongs, instead of in a layer.

## Production considerations

Full bit-for-bit reproducibility across *different machines* is the hard
case: different kernel versions, different filesystem behaviour and different
QEMU versions all leak in. Start with "reproducible on the same builder
image", which is achievable, and treat cross-machine reproducibility as a
goal you measure rather than assume.

Reproducibility and `latest`-style floating bases are mutually exclusive. If
your security policy is "always rebuild on the newest base", you are choosing
freshness over reproducibility for that input; be explicit about it, and pin
the digest per release so that a released artefact is still rebuildable.

Attestations interact: provenance records the build inputs, so a reproducible
build plus `mode=max` provenance lets a verifier re-run the recorded
invocation. That combination is what makes SLSA build-level claims
meaningful; see [SBOMs and provenance](sboms-and-provenance.md).

## Security considerations

- A reproducible build turns a compromised builder into a detectable event:
  an independent rebuild produces a different digest. Without it, a malicious
  builder is invisible.
- `SOURCE_DATE_EPOCH=0` makes every image claim 1970. That is fine for
  reproducibility and confusing for incident response; prefer the commit
  timestamp.
- Pinning by digest also pins vulnerabilities. Pair it with automated bumps
  (Renovate, Dependabot) and with scanning, or you have traded one risk for
  another. See [base image patching](../docker-security/base-image-patching.md).
- Reproducibility does not imply the source is trustworthy. It proves the
  artefact corresponds to the source, nothing more.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Digest differs on every build | Timestamps | `SOURCE_DATE_EPOCH` + `rewrite-timestamp=true` |
| Digest differs between machines | Absolute paths in binaries | `-trimpath` / `-ffile-prefix-map` |
| Digest differs after a base bump | Expected | Compare against the same pinned base |
| `rewrite-timestamp` rejected | BuildKit older than v0.13 | Upgrade the builder |
| Layers differ but files look identical | File ordering or mtimes inside an archive created by the build | Normalise the archive (`--sort=name`, `--mtime`) |
| Reproducible locally, not in CI | Different frontend version | Pin `# syntax=` to an exact version |

## Common mistakes

- Setting `SOURCE_DATE_EPOCH` but exporting with the default image exporter,
  so file timestamps still vary. The exporter option is separate.
- Embedding a build date label "for traceability" and then wondering why
  digests change.
- Pinning the base image tag but not the digest.
- Comparing `docker images` IDs instead of registry digests. The local image
  ID is the config digest and can differ for unrelated reasons.
- Treating reproducibility as binary. Most projects reach "same builder, same
  digest" easily and stop there, which is already useful — as long as you say
  which claim you are making.

## Related topics

- [BuildKit and buildx](buildkit-and-buildx.md)
- [ARG vs ENV](build-args-vs-env.md)
- [SBOMs and provenance](sboms-and-provenance.md)
- [Multi-platform builds](multi-platform-builds.md)
- [Images, tags and digests](../docker-beginner/images-tags-digests.md)
- [Base image patching](../docker-security/base-image-patching.md)
