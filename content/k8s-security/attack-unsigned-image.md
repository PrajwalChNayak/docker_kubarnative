---
title: Unsigned image, and how to close it
description: A defensive analysis of how an unverified image runs attacker code in your namespace, and the admission-time signature verification that stops it.
level: expert
type: reference
status: current
versions: Kubernetes 1.37, Kyverno 1.19
prerequisites:
  - k8s-security/supply-chain-admission
  - k8s-security/policy-engines
---

## Overview

This page analyses how an **unsigned or untrusted image** ends up running in your
cluster, and the admission-time control that closes the path: verify a cosign
signature before a pod may run. It is defensive — the focus is what an attacker
gains from control over image bytes and how verification removes it.

:::danger
Everything here runs only in the disposable local **kind** lab. Rejection depends
on a policy engine (Kyverno) being installed in the lab. Never treat these
manifests as production-ready without your own signing keys.
:::

## Threat model

- **Precondition.** The cluster admits any image the kubelet can pull; there is
  **no admission-time verification** that an image was built by you and is
  unmodified.
- **Adversary.** Anyone who can influence which image bytes a workload runs: a
  compromised registry account, a typosquatted image name, a poisoned CI step,
  or a mutable `:latest` tag repointed to a malicious build.
- **Asset at risk.** The namespace the workload runs in — its identity, its
  mounted Secrets, and its network access.

## The path, at the level of capability

Kubernetes trusts an image because it exists and can be pulled — nothing more.
So if an attacker changes what image a workload references, or repoints a mutable
tag, **their code runs inside your namespace** with that workload's ServiceAccount
identity and network reach. From there the other paths in this part open up:
tokens, lateral movement, Secret access. The root cause is that authenticity was
never checked; the image was trusted on sight.

## Controls that break the path

1. **Admission-time signature verification** (the primary control). A Kyverno
   `verifyImages` rule verifies a cosign signature against your public key and,
   with `mutateDigest`, pins the pod to the verified digest. An unsigned image
   has no signature to verify, so admission rejects it. Sigstore's
   policy-controller is an equivalent verifier.
2. **Restrict registries and require digests** with a built-in
   ValidatingAdmissionPolicy — CEL cannot check a signature, but it can force
   every image to come from an approved registry and carry a `@sha256:` digest,
   refusing unknown registries and mutable tags with no controller installed.
3. **Verify provenance/SLSA attestations** for high-assurance workloads, so an
   image must have come from your trusted CI identity, not merely be signed.

The Kyverno rule that requires a signature (syntax checked against kyverno.io):

```yaml include="examples/security/k8s/unsigned-image/policy-kyverno-verifyimages.yaml" lines="11-41"
```

## Verify an unsigned image is rejected

With Kyverno and the policy installed, an unsigned image under the protected
prefix is refused at admission:

```bash
kubectl apply -f examples/security/k8s/unsigned-image/namespace.yaml
kubectl apply -f examples/security/k8s/unsigned-image/policy-kyverno-verifyimages.yaml
kubectl apply -f examples/security/k8s/unsigned-image/unsigned-pod.yaml
```

The final apply is rejected with an image-verification failure: no signature was
found for the image. A pod referencing a correctly signed image under the same
prefix is admitted and its reference is rewritten to the verified `@sha256:`
digest. That contrast — unsigned refused, signed admitted-and-pinned — is the
verification. The example README walks through it end to end.

## Common mistakes

- Assuming the built-in VAP can verify a signature — it restricts registries and
  digests only; signature verification needs Kyverno or policy-controller.
- Trusting "a signature exists" without pinning the expected **signer identity**.
- Keeping signing keys on build agents where an attacker who owns CI can sign.
- Verifying signatures but still allowing `:latest` and unknown registries.
- Treating admission verification as runtime protection — it checks what runs,
  not what the container then does.

## Related topics

- [Supply chain admission](supply-chain-admission.md)
- [Policy engines](policy-engines.md)
- [Image signing with cosign](../docker-advanced/image-signing-cosign.md)
- [Common attack paths](common-attack-paths.md)
