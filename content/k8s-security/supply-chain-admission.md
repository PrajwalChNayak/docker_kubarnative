---
title: Supply chain admission
description: Verifying image signatures at admission with cosign, restricting registries, and how SBOMs and SLSA provenance fit the picture.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-security/policy-engines
  - docker-advanced/image-signing-cosign
---

## Overview

The supply chain is everything between a developer's commit and a running
container: source, build, registry, and the pull. Kubernetes trusts an image
simply because it can pull it, so the cluster-side control is **admission-time
verification** — refuse to run any image that is not signed by a key you
control and does not come from an approved registry. This page is about that
gate; the image-signing mechanics themselves are in Part D.

## Why it exists and when to use it

If an attacker can change which image bytes a workload runs — a compromised
registry credential, a typosquatted name, a poisoned CI step, a mutable
`:latest` tag repointed — they run their code with your workload's identity and
network access. Signature verification breaks that: only images you signed run.
Apply it to every namespace that runs first-party or otherwise sensitive
workloads.

## How it works underneath

**cosign** (Sigstore) signs an image and stores the signature in the registry
alongside it, referenced by the image digest. At admission, a verifier fetches
the signature for the pulled image and checks it against your public key (or,
in keyless mode, against a Sigstore certificate identity). If verification
fails, the pod is rejected. Two verifiers are common:

- **Kyverno `verifyImages`** — a `ClusterPolicy` rule that verifies signatures
  and, with `mutateDigest`, rewrites the image reference to the verified
  `@sha256:` digest so the running pod is pinned to exactly the bytes verified.
- **Sigstore policy-controller** — a dedicated admission controller purpose-built
  for Sigstore verification, if you prefer a single-purpose tool.

A built-in **ValidatingAdmissionPolicy cannot verify a signature** — CEL has no
crypto — but it *can* enforce an **approved registry and digest pinning** at the
API server with nothing installed, which shrinks the attack surface and pairs
well with a signature verifier.

## Basic example

The Kyverno `verifyImages` rule that requires a cosign signature on images under
a protected prefix (syntax checked against the current kyverno.io docs):

```yaml include="examples/security/k8s/unsigned-image/policy-kyverno-verifyimages.yaml" lines="11-41"
```

The built-in registry/digest guard that complements it:

```yaml include="examples/security/k8s/unsigned-image/vap-restrict-registries.yaml" lines="8-24"
```

## Explanation

The Kyverno rule matches `ghcr.io/tasklane/*`, marks a signature `required`, and
verifies it against the given public key; `mutateDigest: true` pins the pod to
the verified digest. An unsigned image under that prefix has no signature to
verify, so admission rejects it. The VAP takes a different angle — it does not
check signatures but forces every image to come from the approved registry
*and* carry a `@sha256:` digest, refusing unknown registries and mutable tags
outright. Used together, they enforce "signed, from our registry, pinned by
digest". The runnable files and the placeholder key are in
`examples/security/k8s/unsigned-image/`.

## SBOM, provenance and SLSA

Signature verification proves **who** built an image and that it is unchanged.
Two adjacent artifacts prove **what** is in it and **how** it was built:

- **SBOM** (Software Bill of Materials) lists the packages in the image, so a
  scanner can tell you instantly whether a new CVE affects you. Generate it at
  build time (Syft, or `docker buildx --sbom=true`).
- **SLSA provenance** is signed metadata describing the build — the source, the
  builder, the steps — so you can require that an image came from your trusted
  CI, not a laptop. cosign can attach and verify provenance and SBOM as
  **attestations**, and Kyverno can require those attestations at admission the
  same way it requires a signature.

Together: sign for authenticity, attest provenance for build integrity, attach
an SBOM for vulnerability triage, and verify all three at admission.

## Common patterns

- **Restrict registries first** (a VAP or policy), then add signature
  verification — the two are cheap wins in that order.
- **Pin by digest** everywhere; never run `:latest`.
- **Verify attestations, not just signatures**, for high-assurance workloads:
  require SLSA provenance from your CI identity.
- **Scope image policies by namespace** so third-party namespaces with their own
  trust roots are handled separately.

## Production considerations

Verification adds a registry round-trip and a webhook to the admission path, so
mind the same failure-policy trade-offs as any [policy
engine](policy-engines.md): a verifier that is down with `failurePolicy: Fail`
blocks deployments. Key management is the real operational cost — protect the
signing key (KMS-backed or keyless), plan rotation, and keep the public key in
policy under version control. Emergency changes need a break-glass path that is
audited, not a disabled policy.

## Security considerations

Admission verification is only as strong as the key trust: if an attacker can
sign with a key your policy trusts, verification passes. Keep signing keys off
build agents (use keyless/OIDC identities or a KMS), and verify the **signer
identity**, not merely "a valid signature exists". Verification is also
admission-time only — it says nothing about what the verified image does at
runtime, which is [runtime security](runtime-security-falco.md)'s job.

## Troubleshooting

If a correctly-signed image is rejected, check the public key in the policy
matches the signing key, and that the signature is in the same registry/repo as
the image (cosign stores it by digest). If an unsigned image is *admitted* when
it should be blocked, confirm the verifier (Kyverno/policy-controller) is
installed and its policy is in `Enforce`, and that the image reference actually
matches the policy's `imageReferences`. See the unsigned-image example's README
for the end-to-end check.

## Common mistakes

- Assuming the built-in VAP can verify signatures — it cannot; it restricts
  registries and digests only.
- Trusting "a signature exists" without pinning the expected signer identity.
- Keeping signing keys on build agents.
- Verifying signatures but still allowing `:latest` and unknown registries.
- Treating admission verification as runtime protection.

## Related topics

- [Policy engines](policy-engines.md)
- [Image signing with cosign](../docker-advanced/image-signing-cosign.md)
- [SBOMs and provenance](../docker-advanced/sboms-and-provenance.md)
- [Unsigned image, and how to close it](attack-unsigned-image.md)
