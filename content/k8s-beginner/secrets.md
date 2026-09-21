---
title: Secrets
description: What a Kubernetes Secret actually protects, why base64 is not encryption, and how Tasklane keeps its database password out of environment variables.
level: beginner
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/configmaps
---

## Overview

A Secret is a ConfigMap with different defaults: values are base64-encoded in
the API, the kubelet mounts them from memory instead of disk, and the
ecosystem treats them as sensitive. What it is **not**, out of the box, is
encrypted — either in etcd or in transit to your terminal.

Understanding exactly which protections you get, and which you have to
configure, is the difference between "we use Kubernetes Secrets" and "our
credentials are protected".

## Why it exists and when to use it

Secrets exist so that credentials can be:

- kept out of container images, which are copied everywhere and rarely
  deleted,
- kept out of the pod spec, which is readable by anyone who can read pods,
- **delivered as files**, so they can be rotated and so they do not leak into
  process listings, crash dumps or `kubectl describe` output,
- governed by their own RBAC rules, separately from ConfigMaps,
- encrypted at rest in etcd, once you configure a provider.

Use a Secret for database passwords, API tokens, TLS private keys and
registry credentials. Use an external manager (External Secrets Operator,
Sealed Secrets, a cloud KMS or Vault) when you need rotation, audit and a
source of truth outside the cluster — which production generally does.

## How it works underneath

### base64 is encoding, not encryption

```bash
kubectl -n tasklane-basics get secret hello-secret -o yaml
kubectl -n tasklane-basics get secret hello-secret -o jsonpath='{.data.api-token}' |base64 -d
```

```console include="captures/k8s-beginner/secret-yaml.txt"
```

```console include="captures/k8s-beginner/secret-decode.txt"
```

The encoding exists so binary values survive JSON. It provides no
confidentiality whatsoever, and anyone who can read the object can read the
value. Writing `stringData` in a manifest lets you supply plain text; the API
server encodes it into `data` when it stores it.

### Where the protection actually comes from

| Control | Status by default | What to do |
|---|---|---|
| RBAC on `secrets` | Enforced, but many default roles include it | Grant `get` on secrets narrowly; prefer per-workload Secrets |
| Encryption at rest in etcd | **Off** unless the API server is started with an `EncryptionConfiguration` | Configure a KMS provider; see [secrets management](../k8s-security/secrets-management.md) |
| etcd backups | Contain the same data | Encrypt and restrict backups |
| Node exposure | The kubelet only receives Secrets used by pods on that node | Node isolation, and treat node compromise as Secret compromise |
| Mounted as `tmpfs` | Yes, on Linux | Nothing; but env vars do not get this |
| Audit logging | Records access to the API | Enable it; see [audit logging](../k8s-security/audit-logging.md) |

Whether the lab cluster encrypts etcd is checkable:

```bash
kubectl -n kube-system get pod -l component=kube-apiserver -o jsonpath='{.items[0].spec.containers[0].command}' |tr ',' '\n' |grep -i encryption
```

```console include="captures/k8s-beginner/apiserver-encryption-flag.txt"
```

A kind cluster ships without `--encryption-provider-config`, which is normal
for a lab and unacceptable for production.

### Types

`type` is a hint that determines which keys are required:

| Type | Required keys | Used by |
|---|---|---|
| `Opaque` | none | Anything. The default |
| `kubernetes.io/tls` | `tls.crt`, `tls.key` | Gateway and Ingress TLS, cert-manager |
| `kubernetes.io/dockerconfigjson` | `.dockerconfigjson` | `imagePullSecrets` |
| `kubernetes.io/basic-auth` | `username`, `password` | Convention |
| `kubernetes.io/ssh-auth` | `ssh-privatekey` | Convention |
| `kubernetes.io/service-account-token` | — | Legacy long-lived tokens |

Modern ServiceAccount tokens are **projected volumes**: short-lived,
audience-bound, and rotated by the kubelet, rather than a stored Secret. See
[service accounts and tokens](../k8s-security/service-accounts-and-tokens.md).

### Mounted files versus environment variables

Both work. Files are better:

| | Environment variable | Mounted file |
|---|---|---|
| Visible in `kubectl describe pod` | The reference, not the value | The reference only |
| Leaks into child processes | Yes, the whole environment is inherited | No |
| Leaks into crash dumps and logs | Frequently | Rarely |
| Updated when the Secret changes | Never | Yes, after the kubelet sync period |
| Stored on the node's disk | — | No: `tmpfs`, in memory |

```bash
kubectl -n tasklane-basics exec config-demo -- ls -l /etc/hello-secret
kubectl -n tasklane-basics exec config-demo -- sh -c 'mount |grep hello-secret'
```

```console include="captures/k8s-beginner/secret-volume-tmpfs.txt"
```

This is why Tasklane takes `PGPASSWORD_FILE`, not `PGPASSWORD`: the
application reads the file itself, and the password never appears in its
environment.

## Basic example

```yaml include="examples/k8s/basics/41-secret.yaml"
```

The consuming pod mounts it read-only with restrictive permissions:

```yaml include="examples/k8s/basics/42-config-demo.yaml"
```

The real application does the same thing with the database password:

```yaml include="examples/k8s/03-app/config.yaml"
```

```bash
kubectl -n tasklane describe secret tasklane-db
```

```console include="captures/k8s-beginner/secret-describe.txt"
```

## Explanation

`describe secret` prints key **names and sizes**, never values — which is why
it is the right command to use in a shared screen or a ticket.

In `42-config-demo.yaml`, `defaultMode: 0400` makes the file readable only by
the pod's UID. The mount is `readOnly: true`, so a compromised process cannot
overwrite the credential and feed it back to something else.

The lab's `tasklane-db` Secret is deliberately **not** in `examples/`: it is
created imperatively, so no credential is ever committed:

```bash
kubectl -n tasklane create secret generic tasklane-db --from-literal=password='<chosen at install time>'
```

`--from-literal` puts the value in your shell history; `--from-file=password=./pw.txt`
does not, which is the better habit. In production neither is right: the
Secret should be produced by an operator from an external store.

## Common patterns

- **One Secret per workload and purpose.** Fine-grained Secrets make RBAC
  meaningful and reduce blast radius.
- **Mount, do not export.** Files over environment variables, every time.
- **`immutable: true`** for Secrets that never change in place, which also
  stops the kubelet watching them.
- **`imagePullSecrets` on the ServiceAccount**, not on every pod spec.
- **Generate, do not commit.** External Secrets Operator syncs from a real
  manager; Sealed Secrets lets you commit an encrypted blob that only the
  cluster can open.
- **Rotate by creating a new Secret name** and rolling the workload, rather
  than mutating in place: it gives you an atomic switch and a rollback.

## Production considerations

- **Turn on encryption at rest**, with a KMS provider rather than a local
  key, and plan the key rotation. Storage Version Migration went **GA in
  1.37** and is the supported way to rewrite existing objects after changing
  encryption.
- **Back up etcd as if it were a credential vault**, because it is.
- **Rotation needs a consumer story.** A mounted Secret updates in place, but
  the application must re-read the file; otherwise a rollout is required.
- **Audit `get` on secrets.** Unexpected reads are one of the strongest
  compromise signals you get.
- **Beware of copies.** Helm release data, GitOps caches, CI logs, monitoring
  and error trackers all accumulate secret values that never expire.
- **Per-namespace separation is the practical boundary.** A workload that
  should not read a credential should not run in the namespace that holds it.

## Security considerations

- **Anyone with `get` on secrets in a namespace has every credential in it.**
  Check with `kubectl auth can-i get secrets -n <ns>` for the identities you
  care about; default `edit` and `admin` roles include it.
- **Node compromise equals Secret compromise** for everything scheduled
  there. The kubelet has the plaintext.
- **`kubectl get secret -o yaml` leaks to your terminal, your scrollback and
  your shell history.** Use `describe`, or decode a single key deliberately.
- **Client-side `kubectl apply` writes the whole object into the
  `last-applied-configuration` annotation**, so an applied Secret manifest
  puts its values in an annotation too. Prefer `--server-side`, or create
  Secrets outside of apply.
- **A pod that can create pods can read any Secret in its namespace** by
  mounting it. RBAC on pods is RBAC on secrets, indirectly.
- **Never commit a Secret manifest.** The lab's `41-secret.yaml` contains a
  throwaway string and says so; treat any real value in git as burned.

## Troubleshooting

- **`CreateContainerConfigError`** — the Secret or key is missing.
  `kubectl describe pod` names it.
- **The application reads an empty password** — a trailing newline from
  `--from-file`, or the key name differs from the file name you expected.
  Tasklane trims whitespace when reading `PGPASSWORD_FILE`.
- **Permission denied on the mounted file** — `defaultMode` is too strict for
  the container's UID, or `runAsUser` does not match.
- **The rotated Secret has not taken effect** — environment variables never
  update; mounted files need the sync period plus an application that
  re-reads.
- **`Forbidden` reading a Secret from a pod** — the ServiceAccount has no
  RBAC for it, which is the correct default.

## Common mistakes

- **Believing base64 protects anything.**
- **Committing Secret manifests** "because they are only staging".
- **Exporting secrets as environment variables** and then logging the
  environment on start-up.
- **One giant Secret for the whole namespace**, mounted by every workload.
- **Rotating the value but not restarting the consumers.**
- **Assuming the cloud provider encrypts etcd for you.** Some managed
  services do encrypt at rest by default; verify your provider's
  documentation rather than assuming.

## Related topics

- [ConfigMaps](configmaps.md)
- [Pods](pods.md)
- [Tasklane on Kubernetes](tasklane-on-kubernetes.md)
- [Secrets management](../k8s-security/secrets-management.md)
- [Service accounts and tokens](../k8s-security/service-accounts-and-tokens.md)
- [RBAC](../k8s-security/rbac.md)
