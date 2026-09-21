# Secrets management examples

A Kubernetes `Secret` is only **base64-encoded**, not encrypted. Base64 is
encoding, not a secret. So a Secret is protected only by (1) RBAC that keeps
subjects from reading it and (2) **encryption at rest** so an etcd backup does
not leak it. These examples cover both, plus two ways to keep secret material
out of Git.

| File | What it is | Needs |
|---|---|---|
| `encryption-config.yaml` | `EncryptionConfiguration` for the apiserver (KMS v2 + fallback). Encryption at rest. | control-plane access; not `kubectl apply`-able |
| `eso-externalsecret.yaml` | External Secrets Operator: sync from an external store into a native Secret. | ESO installed (`external-secrets.io`) |
| `sealed-secret.yaml` | A `SealedSecret` that is safe to commit to Git. | Sealed Secrets controller installed |

## Encryption at rest (KMS v2)

`encryption-config.yaml` is passed to kube-apiserver with
`--encryption-provider-config`. With KMS v2 the apiserver never holds a
long-lived key: it keeps a short-lived data-encryption key wrapped by a
key-encryption key that lives in an external KMS, and rotation happens in the
KMS. `identity` stays last during migration so existing plaintext Secrets
remain readable; once you remove it, run a **Storage Version Migration (GA in
1.37)** to rewrite every Secret encrypted.

Verify (control-plane, run by the maintainer): read a Secret straight out of
etcd and confirm it is not plaintext, e.g. `etcdctl get /registry/secrets/...`
should show a `k8s:enc:kms:v2:` prefix, not the value.

## Keeping secrets out of Git

- **ESO** leaves the source of truth in a cloud secret manager / Vault / another
  cluster. Git holds only an `ExternalSecret` that references it by name.
- **Sealed Secrets** encrypts the value with the controller's public key; the
  `SealedSecret` is safe to commit and only the in-cluster controller can
  decrypt it. Generate `encryptedData` with `kubeseal` — never by hand.

The CSI Secrets Store driver is a third option: it mounts secrets from an
external store as files, so no Kubernetes Secret is created at all.

## Validation

The CRD manifests validate with kubeconform plus the CRDs-catalog schema
location (see `captures/requests/k8s-security.txt`). `encryption-config.yaml`
is an apiserver config object, not a cluster resource, so it is excluded from
the apply/dry-run harness.
