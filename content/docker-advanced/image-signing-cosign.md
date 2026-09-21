---
title: Image signing with cosign
description: Sign images without holding a private key, verify against a named identity, and understand what cosign v3 stores in the registry.
level: advanced
type: concept
status: current
versions: Docker Engine 29, Buildx 0.37, cosign v3.1.3
prerequisites:
  - docker-advanced/registries
  - docker-beginner/images-tags-digests
---

## Overview

A signature answers one question: *who* produced this exact artefact. It does
not say the artefact is safe, free of vulnerabilities, or built from the
source you think. It binds a digest to an identity, and everything else you
want — provenance, SBOM, policy — hangs off that binding.

cosign is the Sigstore project's tool for doing this with container images.
Its headline feature is **keyless** signing: no private key exists to store
or leak, because the key lives for a few minutes inside the signing process.

## Why it exists and when to use it

Traditional signing fails operationally, not cryptographically. Somebody has
to generate a key, store it, decide who may use it, rotate it and revoke it.
In a CI pipeline the key ends up as a secret that any workflow can read, at
which point it proves much less than the diagram suggests.

Keyless signing replaces key custody with identity. The CI job proves who it
is with an OIDC token, a certificate authority (**Fulcio**) issues a
short-lived certificate for that identity, the signature and certificate are
recorded in a transparency log (**Rekor**), and the certificate expires
before anyone could steal it usefully.

Sign when: you deploy images you built, you publish images others consume, or
you plan to enforce provenance at admission. Do not sign if nobody will ever
verify — an unverified signature is a checkbox, and it costs real pipeline
complexity.

:::warning
Docker Content Trust (Notary v1) was **removed from the Docker CLI in Engine
29**. It can be built as a separate plugin. Anything that tells you to set
`DOCKER_CONTENT_TRUST=1` is describing a removed feature.
:::

## How it works underneath

**Signing, keyless.** cosign asks the environment for an OIDC token — in
GitHub Actions, the one produced by `id-token: write`. It generates an
ephemeral key pair, sends the public key and the token to Fulcio, and gets
back an X.509 certificate whose subject alternative name is the workflow
identity (for example
`https://github.com/example/tasklane/.github/workflows/build.yaml@refs/heads/main`)
and whose issuer claim is `https://token.actions.githubusercontent.com`. It
signs the image digest, uploads the signature and certificate to the
registry, and records an entry in Rekor. The private key is then discarded.

**Verification.** A verifier checks the signature against the certificate,
checks that the certificate chains to Fulcio's root, checks the Rekor entry
proves the signature existed while the certificate was valid, and — crucially
— checks that the identity and issuer match what the verifier expects.

**Storage.** cosign v3 stores signatures as **OCI 1.1 referring artifacts**,
discovered through the registry's referrers API, rather than only as a
`sha256-<digest>.sig` tag alongside the image. Older registries need the
legacy tag scheme.

### What changed in v3

cosign v3.0.0 was announced on 2025-10-08 and is described by the project as
a minor change from v2.6.x, with three behaviours flipped from opt-in to
default:

| Behaviour | v2 | v3 |
|---|---|---|
| Bundle format | `--new-bundle-format` opt-in | protobuf bundle by default |
| Trust material | flags or embedded roots | `--trusted-root` from TUF, `--use-signing-config` defaults to true |
| Signature storage | tag-based `.sig` | OCI 1.1 referring artifacts |

The old behaviour can still be selected with flags, and the project plans to
remove those flags in v4. Migrate pinned v2 invocations now rather than at
the v4 bump, and pin the cosign version in CI so a format change is a
decision rather than a surprise.

## Basic example

```bash
IMAGE=ghcr.io/example/tasklane/tasklane-api@sha256:<digest>

cosign sign --yes "$IMAGE"

cosign verify \
  --certificate-identity-regexp '^https://github.com/example/tasklane/.github/workflows/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "$IMAGE"
```

In the pipeline, the same two steps with the digest taken from the build
metadata:

```yaml include="examples/build/github-actions-build.yaml" lines="91-107"
```

Full command set, including key-pair signing:
[`examples/supply-chain/README.md`](../../examples/supply-chain/README.md).

## Explanation

Signing a **digest** is not a style preference. `cosign sign` on a tag
resolves the tag first and signs the digest it found, which means you signed
whatever the tag pointed at during that second. Take the digest from the
build's own metadata (`containerimage.digest`) and there is no window.

`--yes` skips the confirmation prompt about writing to the public
transparency log. In CI there is nobody to confirm; interactively, read the
prompt once so you know what it says.

On the verify side, the identity flags are the entire security value.
`cosign verify "$IMAGE"` with no identity constraints checks that *somebody*
signed — and anybody can sign anything. `--certificate-identity-regexp`
anchored with `^` restricts to your repository's workflows;
`--certificate-identity` pins one exact workflow and ref. Pair with
`--certificate-oidc-issuer` so that an identity from a different provider
cannot match.

Extra GitHub claims are available for tighter policies:
`--certificate-github-workflow-repository`, `--certificate-github-workflow-ref`,
`--certificate-github-workflow-sha`, `--certificate-github-workflow-name` and
`--certificate-github-workflow-trigger`.

## Common patterns

### Key pairs, for when there is no identity

```bash
cosign generate-key-pair
cosign sign --key cosign.key "$IMAGE"
cosign verify --key cosign.pub "$IMAGE"
```

`cosign generate-key-pair` prompts for a password; `COSIGN_PASSWORD` provides
it non-interactively. For anything beyond a demo, generate the key inside a
KMS and reference it: `--key awskms:///alias/tasklane-signing`,
`--key gcpkms://...`, `--key azurekms://...`, `--key hashivault://...` or
`--key k8s://<namespace>/<secret>`.

### Sign the index and its children

```bash
cosign sign --key cosign.key --recursive "$IMAGE"
```

A multi-platform tag is an index. Signing the index alone leaves the
per-platform manifests unsigned, which matters if a verifier resolves the
platform first.

### Verify in the pipeline that signs

Add a verification step immediately after signing. It catches a broken
identity configuration in the pipeline that introduced it, rather than in the
admission controller three weeks later.

### Enforce at admission

Signatures are advisory until something refuses unsigned images. In
Kubernetes that is a policy controller; see
[supply-chain admission](../k8s-security/supply-chain-admission.md) and
[attack: unsigned image](../k8s-security/attack-unsigned-image.md).

## Production considerations

Decide what identity means before you enforce it. "Signed by any workflow in
our org" and "signed by the release workflow on the default branch" are very
different policies, and the second is the one worth having.

Keyless signing depends on public good infrastructure (Fulcio, Rekor, the TUF
root). That is a dependency to acknowledge: an outage affects signing, and
verification can be done offline with a bundle and a trusted root. Sigstore
can also be self-hosted, at real operational cost.

Transparency-log entries are public. The image digest, the repository
identity and the timestamp become world-readable. For most teams that is
fine; for a private product it may leak release cadence, and
`--tlog-upload=false` with a private trust root is the alternative.

Pin the cosign version (`sigstore/cosign-installer` takes `cosign-release`),
and pin it in the verifier too. Producer and verifier disagreeing about
bundle format is the most common "signature not found" cause.

## Security considerations

- **Verification without identity constraints is theatre.** Always pass
  `--certificate-identity`/`--certificate-identity-regexp` and
  `--certificate-oidc-issuer`.
- **Anchor your regular expressions.** `--certificate-identity-regexp
  'github.com/example/tasklane'` matches
  `https://github.com/evil/github.com-example-tasklane/...`. Start with `^`.
- **`id-token: write` is a powerful permission.** Any step in that job can
  mint an identity token. Keep signing in a small job, and do not run
  untrusted code in it.
- **Signatures do not expire, certificates do.** Revocation in Sigstore is
  handled by policy (identity no longer accepted), not by a CRL. Plan how you
  would stop trusting a compromised workflow identity.
- **A signature says nothing about content.** Sign *and* scan *and* attest;
  see [vulnerability scanning](vulnerability-scanning.md) and
  [SBOMs and provenance](sboms-and-provenance.md).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `no matching signatures` | Identity or issuer mismatch, or the tag moved | Verify by digest; print the certificate with `-o text` |
| `error getting id token` in CI | Missing `id-token: write` | Add the permission to the job |
| `MANIFEST_UNKNOWN` on verify | Registry lacks referrers API support, producer used OCI 1.1 | `--registry-referrers-mode legacy` on sign |
| Verification works locally, fails at admission | Different cosign/policy version or trust root | Pin versions on both sides |
| Signature on a tag no longer verifies | The tag was re-pushed | Immutable tags; deploy by digest |
| Prompt hangs in CI | Missing `--yes` | Add `--yes` |

## Common mistakes

- Signing a tag instead of a digest.
- Running `cosign verify "$IMAGE"` with no identity flags and believing it
  proved something.
- Storing a cosign private key as a CI secret and calling it keyless.
- Signing in CI and never verifying anywhere.
- Assuming a signed image is a safe image.
- Expecting `DOCKER_CONTENT_TRUST` to still exist in Engine 29.

## Related topics

- [SBOMs and provenance](sboms-and-provenance.md)
- [Vulnerability scanning](vulnerability-scanning.md)
- [Registries](registries.md)
- [Docker in CI](docker-in-ci.md)
- [Supply chain security](../docker-security/supply-chain-security.md)
- [Supply-chain admission](../k8s-security/supply-chain-admission.md)
