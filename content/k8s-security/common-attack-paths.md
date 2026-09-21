---
title: Common attack paths
description: A map of the paths that turn a small foothold into a cluster compromise — compromised pods, exposed kubelet and dashboard, anonymous auth, broad RBAC, unencrypted etcd, supply chain — and the one control that closes each.
level: expert
type: reference
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-security/4c-model
  - k8s-security/rbac
---

## Overview

The individual attack pages each dissect one path in depth. This page is the
**map**: the handful of recurring paths that turn a small foothold into a
cluster compromise, each with the single most effective control that closes it.
Use it as a review checklist. Every path is described at the level of capability
and blast radius — what an attacker gains — not as an exploitation script.

:::danger
Any demonstration referenced here runs only in the disposable local **kind**
lab. These are defensive checks for hardening your own cluster, not a target
list. Never point them at a shared or production cluster.
:::

## The paths and their controls

### 1. Compromised pod → token → API

A breached application reads its mounted ServiceAccount token and uses it against
the API server. **Blast radius = whatever the token's RBAC grants.** If that is
broad, it is a cluster compromise.

- **Close it:** least-privilege RBAC, and `automountServiceAccountToken: false`
  so there is no token to steal. See
  [attack-rbac-token-abuse](attack-rbac-token-abuse.md).

### 2. Privileged pod → node root

A pod admitted with `privileged`, host namespaces or `hostPath` gains node-level
root: other pods' Secrets, the kubelet's credentials, the node disk. **Blast
radius = the node and a pivot onward.**

- **Close it:** Pod Security Admission `restricted` on every namespace, plus a
  policy-engine backstop. See
  [attack-privileged-pod-escape](attack-privileged-pod-escape.md).

### 3. Exposed kubelet API (port 10250)

The kubelet serves an API on **10250**. If it allows anonymous access or
authorises broadly, anyone who can reach it can list pods, read logs and run
commands in containers on that node. **Blast radius = every pod on the node.**

- **Close it:** set the kubelet `--anonymous-auth=false` and
  `--authorization-mode=Webhook`, and keep 10250 off any untrusted network. The
  CIS Benchmark checks exactly these; [kube-bench](cis-benchmark-kube-bench.md)
  finds them.

### 4. Exposed or over-permissioned dashboard

A web dashboard or similar in-cluster admin UI, reachable without auth or bound
to a powerful ServiceAccount, is a direct console into the cluster. **Blast
radius = the dashboard's ServiceAccount, often admin.**

- **Close it:** never expose admin UIs publicly, require authentication, and give
  them a minimal ServiceAccount. Treat any admin endpoint as a crown-jewel asset.

### 5. Anonymous API access

If `system:anonymous`/`system:unauthenticated` is bound to anything meaningful,
unauthenticated callers inherit it. **Blast radius = whatever that binding
grants.**

- **Close it:** ensure no RBAC binding targets the anonymous or unauthenticated
  groups, and keep anonymous auth off where possible. See
  [authentication-and-authorisation](authentication-and-authorisation.md).

### 6. Overly-broad RBAC

A `cluster-admin` or wildcard binding on a human or workload account is a
skeleton key: read all Secrets, create workloads anywhere, self-promote via
`escalate`/`bind`. **Blast radius = the whole cluster.**

- **Close it:** audit effective permissions with `kubectl auth can-i` and
  rbac-tool/rakkess; scope everything down. See [rbac](rbac.md).

### 7. Unencrypted etcd

etcd stores every Secret, only base64-encoded by default. Anyone who reads an
etcd disk or backup reads every Secret at once. **Blast radius = every
credential in the cluster.**

- **Close it:** encryption at rest with KMS v2, plus disk/backup encryption at
  the cloud layer. See [secrets-management](secrets-management.md).

### 8. Supply chain

An unverified image runs attacker code with a workload's identity — via a
poisoned build, a compromised registry, or a repointed mutable tag. **Blast
radius = the namespace the workload runs in, then onward via paths 1 and 2.**

- **Close it:** admission-time signature verification and registry restriction.
  See [attack-unsigned-image](attack-unsigned-image.md).

## How the paths chain

These paths are dangerous because they **compose**. A supply-chain foothold
(8) gives a compromised pod, whose token (1) or privileged escape (2) reaches
the node, whose kubelet credentials (3) or a broad binding (6) reach the API
server, from which unencrypted etcd (7) yields every Secret. The defensive
lesson mirrors the [4C model](4c-model.md): each control that breaks one link
contains the whole chain, which is why defence in depth — not a single perfect
control — is the goal.

## A review checklist

| Path | One-line check |
|---|---|
| Pod → token → API | Any workload account with `cluster-admin` or `secrets` read? |
| Privileged → node | Any app namespace not `enforce=restricted`? |
| Kubelet 10250 | `--anonymous-auth=false`, `--authorization-mode=Webhook`? |
| Dashboard | Any admin UI reachable or bound to admin? |
| Anonymous auth | Any binding to `system:anonymous`/`system:unauthenticated`? |
| Broad RBAC | `auth can-i '*' '*' -A` `yes` for any workload? |
| Unencrypted etcd | Encryption-at-rest configured and migrated? |
| Supply chain | Signature verification enforced at admission? |

## Common mistakes

- Treating these as independent when they chain — fixing one link and leaving
  the rest.
- Auditing configuration you intended instead of effective state
  (`auth can-i`, kube-bench, a real probe).
- Assuming managed clusters close the control-plane paths for you without reading
  the shared-responsibility model.
- Focusing on exotic exploits while the open door is a broad token or a
  privileged pod.

## Related topics

- [The 4C security model](4c-model.md)
- [Privileged pod escape](attack-privileged-pod-escape.md)
- [RBAC token abuse](attack-rbac-token-abuse.md)
- [Lateral movement](attack-lateral-movement.md)
- [Unsigned image](attack-unsigned-image.md)
