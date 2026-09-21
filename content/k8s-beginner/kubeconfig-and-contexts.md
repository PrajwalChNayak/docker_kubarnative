---
title: kubeconfig and contexts
description: How kubectl decides which cluster it talks to and as whom, and how to keep several clusters apart without disaster.
level: beginner
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/kubectl-fundamentals
---

## Overview

A kubeconfig file answers three questions: which **cluster** (URL and CA
certificate), which **user** (credentials), and which **context** (a named
pairing of the two, plus a default namespace). `kubectl` reads the
`current-context` and everything follows from there.

Most "it worked yesterday" incidents are a context problem, and a
disturbing number of production incidents are "I ran it against the wrong
cluster". This page is short, but it prevents both.

## Why it exists and when to use it

Kubernetes has no login command and no session. Every request carries
credentials, and the kubeconfig is where those credentials live, along with
the trust anchor used to verify the API server's certificate. Separating
`clusters` from `users` means one credential can address several clusters, or
one cluster can be addressed by several identities — an admin certificate, a
read-only OIDC login, a CI ServiceAccount token — without duplicating URLs.

You interact with it whenever you have more than one cluster, which is nearly
always: a local kind cluster, a staging cluster, production.

## How it works underneath

kubectl builds its configuration in this order:

1. `--kubeconfig <file>` if given.
2. Otherwise the `KUBECONFIG` environment variable, which is a **list** of
   paths (`:` separated on Linux and macOS, `;` on Windows). Files are
   merged; for a duplicated key, the first file wins.
3. Otherwise `~/.kube/config`.

Flags override everything: `--context`, `--namespace`, `--server`, `--user`.

The file itself:

```yaml title="~/.kube/config (shape only)" fragment
apiVersion: v1
kind: Config
current-context: kind-tasklane
clusters:
  - name: kind-tasklane
    cluster:
      server: https://127.0.0.1:6443
      certificate-authority-data: <base64 CA>
users:
  - name: kind-tasklane
    user:
      client-certificate-data: <base64 cert>
      client-key-data: <base64 key>
contexts:
  - name: kind-tasklane
    context:
      cluster: kind-tasklane
      user: kind-tasklane
      namespace: tasklane
```

Note that `kind: Config` here is a client-side format. It is never sent to
the API server, and the API server has no idea your context exists.

**Credential types** you will meet:

| Type | Where it comes from | Notes |
|---|---|---|
| Client certificate | kind, kubeadm, `kubeadm certs` | Cannot be revoked individually; rotate the CA or the user |
| Bearer token | ServiceAccount tokens, static tokens | ServiceAccount tokens are short-lived and audience-bound by default |
| Exec credential plugin | `aws eks get-token`, `gke-gcloud-auth-plugin`, OIDC helpers | kubectl runs a binary and reads a token from its stdout |
| OIDC id\_token | Corporate SSO | Refreshed by kubectl or by a plugin |

`users` entries hold real secrets. A kubeconfig is a credential file, not a
configuration file.

## Basic example

```bash
kubectl config get-contexts
kubectl config current-context
kubectl config view --minify
kubectl auth whoami
```

```console include="captures/k8s-beginner/config-get-contexts.txt"
```

```console include="captures/k8s-beginner/config-current-context.txt"
```

```console include="captures/k8s-beginner/config-view-minify.txt"
```

```console include="captures/k8s-beginner/auth-whoami.txt"
```

## Explanation

`get-contexts` marks the current context with `*` and shows the default
namespace for each. kind names its context `kind-<cluster name>`, so the lab
context is `kind-tasklane`; minikube uses `minikube`, k3d uses
`k3d-<name>`, Docker Desktop uses `docker-desktop`.

`config view --minify` prints only the current context's cluster and user,
with certificate data redacted as `DATA+OMITTED`. Add `--raw` to see the
actual bytes — which is exactly why the file needs careful permissions.

`kubectl auth whoami` asks the **server** who you are, rather than trusting
the file's naming. It returns your username and groups, which is the
authoritative answer when RBAC is refusing something.

Useful writes:

```bash
kubectl config use-context kind-tasklane
kubectl config set-context --current --namespace=tasklane
kubectl config rename-context kind-tasklane lab
kubectl config unset users.old-cluster
```

`set-context --current --namespace` is the one to internalise: it removes
`-n` from every subsequent command and, more importantly, stops you running
a namespace-less command against `default` by accident.

## Common patterns

- **One file per cluster, merged with `KUBECONFIG`.** Keep
  `~/.kube/config.d/prod.yaml` and friends, then
  `export KUBECONFIG=~/.kube/config:~/.kube/config.d/prod.yaml`. Deleting a
  cluster is deleting a file.
- **Put the cluster name in your shell prompt.** Every context-switching tool
  (kubectx, kube-ps1 and similar third-party helpers) exists because humans
  cannot remember which cluster the last terminal tab points at.
- **Separate terminals for separate clusters**, each with its own
  `KUBECONFIG`, rather than switching contexts in one.
- **Use per-context namespaces** instead of typing `-n` for your main
  working namespace.
- **In CI, never use a personal kubeconfig.** Mount a ServiceAccount token or
  use the provider's short-lived credential command.

## Production considerations

- **Least privilege per context.** A day-to-day context should be read-only;
  write access should require deliberately selecting another context.
- **Short-lived credentials.** Exec plugins that mint tokens on demand beat
  long-lived client certificates, which cannot be revoked without rotating a
  CA.
- **Do not distribute one admin kubeconfig.** `kubeadm`'s
  `admin.conf` is cluster-admin; issue per-user credentials instead.
- **Expect certificate expiry.** Client certificates from kubeadm expire
  after a year; see
  [certificate rotation](../operations/certificate-rotation.md).
- **Name contexts unambiguously.** `prod-eu-west-1` beats `cluster-2`,
  especially in a postmortem.

## Security considerations

- **The file is secret.** `chmod 600 ~/.kube/config`. It frequently contains
  a private key that is equivalent to cluster-admin.
- **Never commit a kubeconfig**, and scan for it: the base64 blobs are easy
  to miss in a review.
- **`insecure-skip-tls-verify: true` disables server authentication.** Any
  machine on the path can impersonate the API server and harvest your token.
  Fix the CA data instead.
- **Exec plugins run code.** A kubeconfig you were handed can execute an
  arbitrary binary with your user's rights as soon as you run `kubectl`.
  Read the `exec` block before using a file you did not create.
- **Tokens end up in shell history and CI logs.** Prefer plugins that fetch
  credentials over pasting tokens.

## Troubleshooting

- **`The connection to the server ... was refused`** — the cluster is down or
  the context points at a deleted cluster. `kubectl config current-context`,
  then `kubectl cluster-info`.
- **`Unable to connect to the server: x509: certificate signed by unknown
  authority`** — wrong or stale `certificate-authority-data`, often after a
  cluster was recreated with the same name.
- **`error: You must be logged in to the server (Unauthorized)`** — expired
  credentials, or an exec plugin that failed. Run the plugin command by hand
  and read its error.
- **Everything is `Forbidden`** — right cluster, wrong identity.
  `kubectl auth whoami` and `kubectl auth can-i --list`.
- **Objects "disappeared"** — you are in another context or namespace.
  `kubectl get <kind> -A` settles it.

## Common mistakes

- **Deploying to the wrong cluster** because the context was left over from a
  previous task. Check `current-context` before any write, and make the
  prompt show it.
- **Sharing a kubeconfig between teammates.** Audit logs then name the wrong
  person.
- **Editing `~/.kube/config` by hand** and breaking the YAML; use
  `kubectl config set-*` and `unset`.
- **Setting `KUBECONFIG` to a directory.** It takes a list of files, not a
  folder.
- **Assuming the context's namespace applies to `-A` commands or to
  manifests.** A manifest's `metadata.namespace` always wins over the
  context.

## Related topics

- [kubectl fundamentals](kubectl-fundamentals.md)
- [Namespaces](namespaces.md)
- [Local clusters](local-clusters.md)
- [Authentication and authorisation](../k8s-security/authentication-and-authorisation.md)
- [RBAC](../k8s-security/rbac.md)
