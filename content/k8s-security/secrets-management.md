---
title: Secrets management
description: Why a Secret is only base64, and how RBAC, encryption at rest with KMS v2, External Secrets, Sealed Secrets and the CSI driver actually protect it.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/secrets
  - k8s-security/rbac
---

## Overview

A Kubernetes `Secret` is **base64-encoded, not encrypted**. Base64 is
reversible with one command; it hides nothing. A Secret is protected only by two
things: **RBAC** that stops subjects reading it, and **encryption at rest** so an
etcd backup does not leak it. This page covers both, plus three ways to keep the
secret material out of your Git repository in the first place: External Secrets,
Sealed Secrets and the CSI Secrets Store driver.

## Why it exists and when to use it

Every non-trivial workload has credentials — the Tasklane database password, for
example. The questions are always: who can read it (RBAC), is it encrypted where
it is stored (etcd), and where does the source of truth live (in-cluster, or an
external manager). You make these decisions the moment you create a Secret, and
the defaults are weak, so they need deliberate attention.

## How it works underneath

A Secret is a normal API object stored in etcd. By default the API server writes
it to etcd with only base64 encoding, so anyone who can read etcd — a disk, a
snapshot, a backup, a node with etcd on it — reads every Secret in plaintext.

Two independent protections:

- **RBAC.** `get`, `list` and `watch` on `secrets` all expose contents (a `list`
  returns the values). The built-in `view` role deliberately **excludes**
  Secrets for this reason. Grant Secret read only to the specific subjects that
  need a specific Secret, ideally with `resourceNames`.
- **Encryption at rest.** An `EncryptionConfiguration` passed to the API server
  with `--encryption-provider-config` makes it encrypt Secrets before writing to
  etcd. **KMS v2** is the recommended provider: the API server holds only a
  short-lived data-encryption key wrapped by a key-encryption key that lives in
  an external KMS, so rotation happens in the KMS and no long-lived key sits on
  the control plane.

## Basic example

The encryption config is an **apiserver config file, not a cluster resource** —
you never `kubectl apply` it:

```yaml include="examples/k8s/secrets-management/encryption-config.yaml" lines="13-37"
```

## Explanation

Providers are tried **in order for writes** (the first is used) and **every
provider for reads** (until one decrypts). KMS v2 comes first so new writes are
encrypted; `identity` (no encryption) stays **last** so existing plaintext
Secrets remain readable during migration. Once the config is live you re-encrypt
everything already in etcd by running a **Storage Version Migration** (GA and
on by default in 1.37), then you can remove `identity`. Verifying it worked
means reading a Secret straight out of etcd and seeing a `k8s:enc:kms:v2:`
prefix instead of the value — a control-plane check the maintainer runs.

## Keeping secrets out of Git

Committing a base64 Secret to Git is committing the plaintext. Three tools solve
this differently:

- **External Secrets Operator (ESO).** The source of truth stays in a cloud
  secret manager, Vault, or another cluster; Git holds only an `ExternalSecret`
  that references it. ESO creates and owns the native Secret.

```yaml include="examples/k8s/secrets-management/eso-externalsecret.yaml" lines="28-46"
```

- **Sealed Secrets.** The value is encrypted with the in-cluster controller's
  public key, producing a `SealedSecret` that is **safe to commit**. Only the
  controller can decrypt it, and it generates the matching Secret. You produce
  the ciphertext with `kubeseal`, never by hand.

- **CSI Secrets Store driver.** Mounts secrets from an external store directly
  as files in the pod, so **no Kubernetes Secret object is created at all** —
  useful when you want to avoid etcd holding the value entirely.

## Common patterns

- **Encryption at rest on every cluster**, KMS v2 in production.
- **Least-privilege Secret RBAC**: name the Secret with `resourceNames`, never
  grant blanket `secrets` read to workloads.
- **Never commit plaintext Secrets**; use ESO, Sealed Secrets or the CSI driver.
- **Mount Secrets as files, not env vars**, as Tasklane does — env vars leak
  into logs, crash dumps and child processes more easily than files.

## Production considerations

Encryption at rest protects etcd-at-rest; it does **not** stop a subject with
Secret RBAC from reading the value through the API, so RBAC remains primary. KMS
availability becomes part of your control-plane availability — if the KMS is
unreachable, the API server cannot decrypt Secrets. ESO and Sealed Secrets each
add a controller you must run and whose own credentials (ESO's store access, the
Sealed Secrets private key) are now high-value: back up the Sealed Secrets key,
because losing it means every committed `SealedSecret` is undecryptable.

## Security considerations

Rank the exposures: an unencrypted etcd backup leaks everything at once; overly
broad Secret RBAC leaks through the front door; secrets in Git leak to everyone
with repo access forever. Address all three. The CSI driver and short-lived,
audience-scoped tokens ([service accounts](service-accounts-and-tokens.md))
reduce how long and how widely a secret exists in a readable form.

## Troubleshooting

If a pod cannot read its Secret, check RBAC on the *pod's* ServiceAccount and
that the Secret exists in the same namespace. If ESO or Sealed Secrets is not
producing a Secret, check the controller's logs and its access to the backing
store or its key. If Secrets in etcd are still plaintext after configuring
encryption, you set the config but never migrated existing objects — run the
Storage Version Migration.

## Common mistakes

- Believing base64 is encryption.
- Committing plaintext Secrets to Git.
- Granting workloads blanket `secrets` read, or using `view` and being surprised
  it cannot read Secrets (that is by design).
- Configuring encryption at rest but forgetting to re-encrypt existing Secrets.
- Losing the Sealed Secrets private key with no backup.

## Related topics

- [Secrets (beginner)](../k8s-beginner/secrets.md)
- [RBAC in depth](rbac.md)
- [Service accounts and tokens](service-accounts-and-tokens.md)
- [Audit logging](audit-logging.md)
