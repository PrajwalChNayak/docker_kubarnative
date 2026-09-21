---
title: Supply chain security
description: Pin by digest, sign with Sigstore, attach SBOM and provenance, and trust base images so the image you run is the image you built.
level: expert
type: concept
status: current
versions: Docker Engine 29
prerequisites:
  - docker-advanced/image-signing-cosign
  - docker-advanced/sboms-and-provenance
  - docker-security/secrets-in-images
---

## Overview

Supply chain security answers one question: is the image running in production
the exact artefact your pipeline built from the source you reviewed? The threats
are substitution (a tag repointed to a malicious image), tampering (a layer
altered in transit or in the registry), and opaque provenance (no record of how
or from what an image was built). The controls are digest pinning, signing,
attestations (SBOM and provenance), and disciplined base-image trust. This page
ties them together.

## Why it exists and when to use it

Tags are mutable pointers. `postgres:18` today and `postgres:18` next week can be
different images, and a compromised registry account can repoint a tag to a
backdoored image without changing its name. High-profile incidents — typosquatted
base images, dependency confusion, build-system compromise — are supply chain
attacks. Apply these controls to every image you build and depend on; they are
the registry-and-build half of the threat model.

## How it works underneath

- **Digest pinning.** An image digest (`sha256:...`) is the content hash of the
  image manifest. Referencing `image@sha256:...` means the runtime pulls exactly
  those bytes or fails. A tag is a convenience label on top; the digest is the
  identity. The Tasklane Dockerfile pins its base images by multi-arch index
  digest, keeping the tag only for humans.
- **Signing.** A signature binds a digest to a key (or, with keyless signing, to
  an OIDC identity) and is stored alongside the image. Verifying it before deploy
  proves who produced that digest. The current tool is **Sigstore cosign**
  (v3.1.3 in this handbook), which since v3 defaults to the protobuf bundle
  format, OCI 1.1 referring artefacts, and a TUF-fetched trusted root.
- **Attestations.** BuildKit can attach an **SBOM** (a list of components in the
  image) and **provenance** (how, when and from what it was built, per SLSA). In
  Engine 29 / buildx, **provenance at `mode=min` is attached by default**; **SBOM
  is opt-in** with `--sbom=true`. Disable defaults with `--provenance=false` or
  `BUILDX_NO_DEFAULT_ATTESTATIONS`.
- **Base-image trust.** Prefer minimal, maintained bases (distroless, Alpine,
  Docker Hardened Images) from known publishers, pinned by digest, over
  arbitrary tags from unknown accounts.

## Basic example

Inspect an image's manifest, digest and attached attestations without pulling it:

```bash
docker buildx imagetools inspect gcr.io/distroless/static-debian13:nonroot
```

```console include="captures/docker-security/imagetools-inspect.txt"
```

The output shows the media types and, where present, the provenance/SBOM
attestation manifests. Pin the resolved digest in your Dockerfile:

```dockerfile include="examples/app/Dockerfile" lines="12-13"
```

Build with an SBOM and default provenance, then verify a signature at deploy
time (keyless example):

```bash
docker buildx build --sbom=true --provenance=mode=max -t registry.example.com/tasklane-api:0.1.0 --push .
cosign verify registry.example.com/tasklane-api:0.1.0 --certificate-identity-regexp '.*' --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Explanation

Each control closes a different gap. Digest pinning defeats tag substitution:
even if `postgres:18` is repointed, `postgres:18@sha256:86c9...` still resolves
to the reviewed bytes. Signing defeats "who built this": a valid signature ties
the digest to your pipeline's identity. Provenance and SBOM defeat opacity: they
record the build inputs and the component inventory so you can answer "is this
image affected by CVE-X?" and "was this built by our CI, from our source?".

Used together in an admission gate — verify the signature, check the provenance
issuer, require an SBOM — they let a cluster refuse any image that is not your
pipeline's exact, signed output. That admission step lives in
[supply-chain admission](../k8s-security/supply-chain-admission.md).

## Common patterns

- **Pin every base image by digest**, tag alongside for readability, and let a
  bot bump both (see [base image patching](base-image-patching.md)).
- **Sign on push, verify on deploy.** Keyless cosign in CI signs with the
  workflow's OIDC identity; admission control verifies before scheduling.
- **Attach `--provenance=mode=max` and `--sbom=true`** for release builds, and
  store the SBOM for continuous CVE re-scanning as new vulnerabilities are
  disclosed.
- **Use Docker Hardened Images or distroless** as trusted, minimal bases; they
  are free (DHI is Apache-2.0 "Community" tier since 2025-12-17).

:::deprecated Docker Content Trust is legacy
Docker Content Trust (DCT), the older Notary v1 / TUF signing built into the CLI
via `DOCKER_CONTENT_TRUST=1`, was **removed from the Docker CLI in Engine 29**;
it can only be built as a separate plugin. Do not adopt it for new work. Use
Sigstore cosign, which is actively developed and integrates with keyless OIDC
signing and OCI 1.1 artefacts.
:::

## Production considerations

Signing and attestations are only as good as the verification step. Signing
images but never verifying them at deploy time buys nothing; the value is in the
admission gate that *refuses* unsigned or wrong-provenance images. Roll out
verification in warn/audit mode first, then enforce.

Re-resolve base-image digests just before publishing (`docker buildx imagetools
inspect`), because upstream rebuilds change them. Keep SBOMs after release and
re-scan them as new CVEs land, rather than only scanning at build time — a clean
image today can be vulnerable tomorrow without changing a byte.

Manage keys carefully. Prefer keyless (OIDC-based) signing so there is no
long-lived private key to steal; where you must use keys, store them in a KMS or
hardware token, not a CI variable.

## Security considerations

Attestations describe an image; they do not sanitise it. An SBOM can faithfully
list a component with a critical CVE, and provenance can faithfully record a
build that pulled a malicious dependency. Combine supply chain metadata with
vulnerability scanning and secret scanning — they answer different questions.

Trust is transitive: a signed image built `FROM` an untrusted base inherits that
base's risk. Pin and vet bases, and prefer publishers with a patching cadence
you can rely on. A signature proves origin, not safety.

## Troubleshooting

- **`cosign verify` fails.** Check the `--certificate-identity`/`-regexp` and
  `--certificate-oidc-issuer` match the signing workflow; a keyless signature is
  tied to that identity, not a key.
- **No provenance on an image.** It may have been built with
  `--provenance=false` or `BUILDX_NO_DEFAULT_ATTESTATIONS` set, or by a
  non-BuildKit builder. Rebuild with BuildKit.
- **Digest drift breaks a build.** The pinned base digest no longer exists (it
  was garbage-collected or the tag moved). Re-resolve with `imagetools inspect`
  and update the pin via your dependency bot.
- **SBOM missing components.** `--sbom=true` must be set explicitly; it is not on
  by default.

## Common mistakes

- Depending on mutable tags in production instead of digests.
- Signing images but never verifying them at deploy time.
- Adopting the removed Docker Content Trust for new signing instead of cosign.
- Treating an SBOM or provenance as proof of safety rather than of contents/origin.
- Storing signing keys in CI variables instead of using keyless or a KMS.

## Related topics

- [Image signing with cosign](../docker-advanced/image-signing-cosign.md)
- [SBOMs and provenance](../docker-advanced/sboms-and-provenance.md)
- [Vulnerability scanning](../docker-advanced/vulnerability-scanning.md)
- [Base image patching](base-image-patching.md)
- [Supply chain admission](../k8s-security/supply-chain-admission.md)
