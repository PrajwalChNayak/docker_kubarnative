# Unsigned image admitted

## Threat

The cluster admits any image the kubelet can pull. There is **no admission-time
verification** that an image was built by you and not tampered with.

## Why it is dangerous

Without verification, an attacker who can influence what image a workload
references — a compromised registry account, a typosquatted name, a poisoned
CI step, a mutable `:latest` tag repointed to a malicious build — gets their
code running inside your namespace with that workload's identity and network
access. The image is trusted purely because it exists. Signing plus
admission-time verification breaks that: only images signed by a key you
control are allowed to run, and the pod is pinned to the exact verified digest.

## Control

Verify a **cosign** signature at admission:

- **Kyverno `verifyImages`** (`policy-kyverno-verifyimages.yaml`) checks the
  signature against your public key and, with `mutateDigest`, pins the pod to
  the verified digest. This is the signature-verification control. (Sigstore's
  policy-controller is an equivalent admission verifier.)
- A built-in **ValidatingAdmissionPolicy** (`vap-restrict-registries.yaml`)
  cannot check a signature — CEL has no crypto — but it enforces an approved
  registry and digest pinning at the API server with no extra controller. Use
  it alongside signature verification, not instead of it.

The Kyverno `verifyImages` structure was checked against the current
kyverno.io docs: `verifyImages[].imageReferences`, `mutateDigest`,
`verifyDigest`, `required`, and `attestors[].entries[].keys.publicKeys`.

## Verify an unsigned image is rejected

With Kyverno and `require-signed-images` installed:

```bash
kubectl apply -f examples/security/k8s/unsigned-image/namespace.yaml
kubectl apply -f examples/security/k8s/unsigned-image/policy-kyverno-verifyimages.yaml
kubectl apply -f examples/security/k8s/unsigned-image/unsigned-pod.yaml
```

The last command is rejected with an image-verification failure (no signature
found for `ghcr.io/tasklane/demo-unsigned:0.1.0`). A pod referencing a
correctly signed image under the same prefix is admitted and its image is
rewritten to the verified `@sha256:` digest. That difference — unsigned
refused, signed admitted-and-pinned — is the verification.

:::note
`unsigned-pod.yaml` is **not** marked `expect=reject`, because rejection
depends on Kyverno being installed. The plain server-side dry-run harness does
not assume a policy engine, so it validates the manifest as well-formed
without asserting a denial.
:::
