---
title: SBOMs and provenance
description: What BuildKit attaches to your images by default, how in-toto attestations and SLSA provenance are stored, and how to read them back.
level: advanced
type: concept
status: current
versions: Docker Engine 29, Buildx 0.37
prerequisites:
  - docker-advanced/buildkit-and-buildx
  - docker-advanced/registries
---

## Overview

An **SBOM** answers "what is inside this image". **Provenance** answers "how
was this image produced". Both are attached to an image as signed statements
called **attestations**, in the in-toto format, and both are produced by
BuildKit itself — one by default, one on request.

The distinction matters when an advisory lands on a Friday. An SBOM lets you
answer "are we affected" by querying, not by rebuilding and scanning every
image. Provenance lets you answer "where did this come from" without trusting
the person who pushed it.

## Why it exists and when to use it

When Log4Shell happened, the expensive part was not patching. It was finding
which of several hundred images contained the library, in which version,
including transitive dependencies nobody had listed. Teams with SBOMs
answered in minutes.

Provenance addresses a different threat: a build that did not come from the
source it claims. SLSA describes levels of build integrity, and the usable
mechanism is a signed statement from the build system describing the inputs,
the builder and the invocation.

Attach an SBOM when you ship images to anyone — including your own operations
team. Attach `mode=max` provenance when you want to make verifiable claims
about how a release was built. Skip neither on the grounds that "we know
what is in our images"; you know what you put in, not what the base image
added.

## How it works underneath

### Attestation format

An in-toto **statement** has three parts: a subject (the image digest), a
`predicateType` URI, and the predicate document itself. BuildKit wraps
statements as extra manifests inside the image index, one set per platform,
referenced from the index. That is why an image with attestations shows more
entries in `docker buildx imagetools inspect` than it has platforms.

cosign attestations are stored differently: as referring artifacts (v3)
associated with the image digest, signed with a Sigstore identity. The two
mechanisms coexist. BuildKit's attestations tell you what the *builder*
observed; a cosign attestation tells you what an *identity* asserts.

### Defaults

From the Docker attestations documentation: "Provenance attestations with the
`mode=min` level are added to images by default". SBOM is opt-in
(`--sbom=true`). Defaults can be disabled with `--provenance=false` or the
`BUILDX_NO_DEFAULT_ATTESTATIONS` environment variable.

| Attestation | Default | Flag | Predicate |
|---|---|---|---|
| Provenance `mode=min` | on | `--provenance=mode=min` | `https://slsa.dev/provenance/v0.2` |
| Provenance `mode=max` | off | `--provenance=mode=max` | same |
| SBOM | off | `--sbom=true` | in-toto SPDX |

`mode=min` includes build timestamps, the frontend used, build materials,
source repository and revision, the build platform and reproducibility
information. `mode=max` adds the LLB definition, information about the
Dockerfile including a full base64-encoded copy, and source maps relating
build steps to layers.

:::warning
`mode=max` records build-argument **values**. A pipeline that passes a token
as `--build-arg` publishes it inside the attestation. Use
`RUN --mount=type=secret`; see [ARG vs ENV](build-args-vs-env.md).
:::

### SBOM generation

BuildKit runs a scanner plugin — by default a Syft-based one — over the
build result and emits an SPDX document per platform. An alternative
generator is selected with `--attest type=sbom,generator=<image>`.

## Basic example

```bash
docker buildx build --push \
  --provenance=mode=max --sbom=true \
  -t ghcr.io/example/tasklane/tasklane-api:0.1.0 \
  --target api examples/app
```

Declaratively, in the Bake file:

```hcl include="examples/build/docker-bake.hcl" lines="62-69"
```

Read them back:

```bash
docker buildx imagetools inspect ghcr.io/example/tasklane/tasklane-api:0.1.0 \
  --format '{{ json .SBOM.SPDX }}' > sbom.spdx.json
docker buildx imagetools inspect ghcr.io/example/tasklane/tasklane-api:0.1.0 \
  --format '{{ json .Provenance.SLSA }}'
```

## Explanation

`--sbom=true` is shorthand for `--attest type=sbom`, and `--provenance=mode=max`
for `--attest type=provenance,mode=max`. Both need an exporter that can carry
attestations, which means pushing to a registry or exporting OCI — the Engine
image store historically could not hold them, which is one more reason CI
builds push rather than load.

The SBOM for a distroless Go image is short: the handful of files in the base
plus one static binary. That is the point. A Debian-based image lists
hundreds of packages, each one a potential advisory to triage, and most of
them are not used by your program.

Provenance is worth reading once, in full, on a real image. It names the
builder, the frontend, the source, the materials with their digests, and the
parameters. Once you have seen it, policies like "refuse images whose
provenance does not name our builder" stop being abstract.

## Common patterns

### Verify that attestations exist

In the pipeline, immediately after the push:

```yaml include="examples/build/github-actions-build.yaml" lines="108-116"
```

An SBOM that silently stopped being generated is worse than none, because
the dashboard still shows green.

### Sign the SBOM as well

```bash
cosign attest --yes --type spdxjson --predicate sbom.spdx.json "$IMAGE"
cosign verify-attestation --type spdxjson \
  --certificate-identity-regexp '^https://github.com/example/tasklane/.github/workflows/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "$IMAGE"
```

This gives verifiers one Sigstore-rooted path to both the image and its
contents list.

### Scan the SBOM instead of the image

```bash
grype sbom:./sbom.spdx.json --fail-on high --only-fixed
trivy image --sbom-sources oci ghcr.io/example/tasklane/tasklane-api:0.1.0
```

Faster, and it scans exactly the artefact you attested rather than a fresh
analysis that might disagree.

### Policy over the predicate

`cosign verify-attestation --policy policy.cue` evaluates a CUE or Rego
policy against the predicate — for example, that the provenance names your
builder and a protected branch.

## Production considerations

Store SBOMs where you can query them. An SBOM attached to an image in a
registry is discoverable but not searchable; "which images contain
`libxml2 < 2.13`" needs an index. Teams either run a component repository or
export SBOMs into a database as part of the pipeline.

SBOM quality varies by ecosystem. Go binaries carry module information that
Syft reads well. C libraries vendored into a binary are largely invisible,
and anything installed by `curl | sh` is invisible everywhere. Be honest
about coverage rather than treating the document as complete.

Attestations add manifests and storage to every push. It is not much, but
retention rules that delete "untagged manifests" can delete attestations.
Check that your lifecycle policy understands referrers.

SLSA levels are a claim about the *build system*, not about your Dockerfile.
BuildKit provenance supports the claim; a hosted, ephemeral, non-falsifiable
build environment is what actually earns the level.

## Security considerations

- `mode=max` leaks build arguments. Audit what your pipeline passes before
  enabling it.
- BuildKit's provenance is generated by the builder. A compromised builder
  writes whatever provenance it wants. Provenance is only as trustworthy as
  the environment that produced it, which is why signing it with a hosted
  identity matters.
- An SBOM is a map of your attack surface. For a public image this is a
  deliberate trade; publishing it is still the right default because
  attackers can enumerate packages anyway, and defenders cannot.
- Do not treat "SBOM present" as a control. Verify it corresponds to the
  image digest you are running, and that it was signed by an identity you
  accept.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `.SBOM` is empty in `imagetools inspect` | SBOM not requested, or image built without push | `--sbom=true` and push |
| No attestations after a `--load` build | Exporter cannot carry them | Push, or export OCI |
| Attestations disappeared from the registry | Retention deleted untagged manifests | Exclude referrers from lifecycle rules |
| Provenance has no source repository | Built from a local context, not a Git URL | Build from the Git context, or set the metadata |
| `mode=max` provenance missing the Dockerfile | Frontend older than required | Update the `# syntax=` pin |
| SBOM lists nothing for a Go binary | Binary stripped of module info | Avoid `-ldflags` that drop build info you need, or generate from source |

## Common mistakes

- Believing SBOMs are on by default. Only minimal provenance is.
- Enabling `mode=max` on a pipeline that passes secrets as build arguments.
- Generating an SBOM of the *build* stage, which lists the whole toolchain
  instead of the shipped image.
- Producing SBOMs nobody ingests. The value is in the query, not the file.
- Treating provenance from an unknown builder as evidence.

## Related topics

- [Image signing with cosign](image-signing-cosign.md)
- [Vulnerability scanning](vulnerability-scanning.md)
- [Reproducible builds](reproducible-builds.md)
- [ARG vs ENV](build-args-vs-env.md)
- [Supply chain security](../docker-security/supply-chain-security.md)
- [Supply-chain admission](../k8s-security/supply-chain-admission.md)
