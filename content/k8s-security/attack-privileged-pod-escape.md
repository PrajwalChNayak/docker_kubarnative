---
title: Privileged pod escape, and how to close it
description: A defensive analysis of the privileged-pod-to-node-root path — the threat model, the controls that break it, and how to verify they hold.
level: expert
type: reference
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-security/pod-security-standards
  - k8s-security/security-context
---

## Overview

This page dissects one of the most damaging paths in Kubernetes — a **privileged
pod becoming root on the node** — and, more importantly, the controls that make
it impossible. It is a defensive analysis: a threat model, the specific controls
that break the path, and how to verify each. It is not an exploitation tutorial;
we describe capability and blast radius, not command sequences.

:::danger
Everything here runs only in the disposable local **kind** lab. The vulnerable
manifest exists solely to prove the hardened configuration **rejects** it. Never
apply these against a shared or production cluster.
:::

## Threat model

- **Precondition.** A workload is admitted with `privileged: true`, or host
  namespaces (`hostPID`/`hostNetwork`/`hostIPC`), or a `hostPath` mount of a
  sensitive node path. This happens when a namespace is not `restricted`, when
  PSA is off, or when an over-broad exemption applies.
- **Adversary.** Anyone who can get a pod scheduled there: a compromised
  application in the namespace, a CI pipeline with create-pod rights, or a
  supply-chain foothold in an image.
- **Asset at risk.** The node and everything on it.

## The path, at the level of capability

A privileged container runs with all Linux capabilities and effectively no
isolation from the node — it is **node-level root**. From that position the
attacker gains, in terms of capability and blast radius:

- **Access to every other pod on the node.** Their mounted Secrets and volumes
  sit on the node filesystem the privileged container can reach.
- **The kubelet's credentials.** With the node's identity, the attacker can act
  against the API server as that node, reaching the Secrets and pods the Node
  authoriser grants it.
- **The whole node disk and process table**, via `hostPath` and `hostPID`.

One over-permissioned pod thus becomes a node foothold and a pivot toward the
rest of the cluster. The vulnerable manifest that establishes the precondition:

```yaml include="examples/security/k8s/privileged-escape/vulnerable-pod.yaml" lines="14-35"
```

Note it can only be admitted in a namespace labelled `enforce=privileged`.
Needing that label is itself the warning sign.

## Controls that break the path

Defence in depth, each control independent:

1. **Pod Security Admission, `restricted`, on every application namespace.**
   `restricted` forbids `privileged`, host namespaces and `hostPath`, so the pod
   is rejected at admission — it never schedules. This is the primary control.
2. **A policy-engine backstop** (Kyverno/Gatekeeper) that denies privileged and
   host-namespace pods cluster-wide, catching any namespace that was never
   labelled and giving a central, audited denial.
3. **User namespaces** (`hostUsers: false`) so that even a container that
   regains privilege inside its namespace is not root on the node.
4. **Minimal exemptions and no stray `privileged` namespaces** — treat an
   `enforce=privileged` label on an app namespace as an incident.

The hardened equivalent workload does real work with none of the host access and
is admitted by `restricted`:

```yaml include="examples/security/k8s/privileged-escape/fixed-pod.yaml" lines="5-30"
```

## Verify

The verification is that the hardened namespace **rejects** the privileged pod.
`reject-check.yaml` is the vulnerable pod aimed at the restricted namespace and
is marked `expect=reject`:

```bash
kubectl apply -f examples/security/k8s/privileged-escape/namespaces.yaml
kubectl apply -f examples/security/k8s/privileged-escape/reject-check.yaml
```

```console include="captures/k8s-security/priv-escape-reject.txt"
```

The apply fails with `violates PodSecurity "restricted:v1.37"`, naming
`privileged`, `hostPID` and the `hostPath` volume. Because admission refuses to
persist the pod, nothing reaches the kubelet and no privileged container is ever
created — the rejection is the proof the path is closed.

## Common mistakes

- Labelling an application namespace `privileged` "temporarily" and leaving it.
- Relying on a policy engine alone (which can fail open) without PSA underneath.
- Granting a broad PSA exemption instead of a single scoped privileged namespace.
- Assuming `runAsNonRoot` alone stops escape — without user namespaces, a real
  root-in-container bug still lands as node root.

## Related topics

- [Pod Security Standards](pod-security-standards.md)
- [Security context](security-context.md)
- [User namespaces](user-namespaces.md)
- [Common attack paths](common-attack-paths.md)
