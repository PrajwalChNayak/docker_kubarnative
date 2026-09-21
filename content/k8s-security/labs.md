---
title: Security labs
description: Hands-on exercises for RBAC least privilege, Pod Security enforcement, network segmentation and admission policy, with full solutions.
level: expert
type: lab
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-security/rbac
  - k8s-security/pod-security-standards
  - k8s-security/network-segmentation
---

## Overview

These labs exercise the controls from Part I against the Tasklane cluster. Each
has a goal, a set of steps, and a full solution. The theme throughout is
**verify the control, do not assume it** — every exercise ends by proving the
control actually blocks what it should.

:::danger
Run every exercise **only** in the disposable local **kind** lab (`kind` cluster
`tasklane`, 1.37, stages 1–4 applied). Several steps deliberately create
manifests designed to be rejected; never point them at a shared or production
cluster.
:::

## Setup

All manifests referenced here already exist under `examples/`. From the repo
root, with the lab cluster up:

```bash
kubectl config current-context
kubectl get ns tasklane -o jsonpath='{.metadata.labels}'
```

The `tasklane` namespace is PSA `restricted`; the exercises add their own
disposable namespaces (`psa-demo`, `rbac-demo`, `netpol-demo`, `signing-demo`).

## Exercises

### Exercise 1 — Prove least-privilege RBAC

Apply the least-privilege deployer and confirm it can deploy but cannot read
Secrets, exec into pods, or create RoleBindings.

1. Apply `examples/k8s/rbac/deployer.yaml`.
2. List everything the deployer may do in `tasklane`.
3. Run the negative checks for `secrets`, `pods/exec` and `rolebindings`.

### Exercise 2 — Watch restricted PSA reject a privileged pod

1. Apply `examples/k8s/pod-security/namespace.yaml`.
2. Apply the compliant pod and confirm it is admitted.
3. Apply the non-compliant (privileged) pod and confirm the API server rejects
   it, and read the error.

### Exercise 3 — Contain lateral movement with default-deny

1. Deploy `examples/security/k8s/missing-networkpolicy/` namespace and workloads.
2. Confirm `client-denied` can reach `server` (the vulnerable, un-segmented
   state).
3. Apply the default-deny policy set and confirm `client-denied` now times out
   while `client-allowed` still connects.

### Exercise 4 — Scope an over-permissioned account

1. Apply `examples/security/k8s/rbac-over-permission/fixed.yaml`.
2. Prove the scoped `app` account cannot read Secrets in its own namespace or in
   `kube-system`, and is not a cluster admin.

### Exercise 5 — Compare three policy engines

Read the three implementations of the "no `:latest`" rule in
`examples/k8s/policy/` and, for each, state one capability it has that the others
lack. Then decide which you would deploy for (a) a simple universal validation
rule with no operational risk, and (b) verifying image signatures.

## Solutions

### Solution 1

```bash
kubectl apply -f examples/k8s/rbac/deployer.yaml
kubectl auth can-i --list \
  --as=system:serviceaccount:tasklane:tasklane-deployer -n tasklane
kubectl auth can-i get secrets \
  --as=system:serviceaccount:tasklane:tasklane-deployer -n tasklane      # no
kubectl auth can-i create pods/exec \
  --as=system:serviceaccount:tasklane:tasklane-deployer -n tasklane      # no
kubectl auth can-i create rolebindings \
  --as=system:serviceaccount:tasklane:tasklane-deployer -n tasklane      # no
```

The `--list` output shows create/update/patch on deployments, replicasets,
services, configmaps and httproutes, and no secrets row. Captured output:

```console include="captures/k8s-security/rbac-deployer-can-i-list.txt"
```

If any negative check returns `yes`, the Role is too broad — the whole point of
the deployer is that a leaked token opens almost nothing.

### Solution 2

```bash
kubectl apply -f examples/k8s/pod-security/namespace.yaml
kubectl apply -f examples/k8s/pod-security/compliant-pod.yaml       # admitted
kubectl apply -f examples/k8s/pod-security/noncompliant-pod.yaml    # rejected
```

The non-compliant apply fails at admission:

```console include="captures/k8s-security/psa-noncompliant-reject.txt"
```

The error is `violates PodSecurity "restricted:v1.37"` and lists `privileged`
and the missing fields. Because admission refuses it, nothing reaches the
kubelet — the rejection *is* the control working.

### Solution 3

```bash
kubectl apply -f examples/security/k8s/missing-networkpolicy/namespace.yaml
kubectl apply -f examples/security/k8s/missing-networkpolicy/workloads.yaml
kubectl apply -f examples/security/k8s/missing-networkpolicy/fixed-networkpolicy.yaml
kubectl -n netpol-demo exec client-denied -- wget -qO- --timeout=3 http://server:8080/
```

```console include="captures/k8s-security/netpol-denied-probe.txt"
```

A timeout and non-zero exit on `client-denied`, with `client-allowed` still
connecting, proves the lateral path is closed. If `client-denied` still reaches
the server, the CNI is not enforcing NetworkPolicy — check that first.

### Solution 4

```bash
kubectl apply -f examples/security/k8s/rbac-over-permission/namespace.yaml
kubectl apply -f examples/security/k8s/rbac-over-permission/fixed.yaml
kubectl auth can-i get secrets --as=system:serviceaccount:rbac-demo:app -n rbac-demo
kubectl auth can-i get secrets --as=system:serviceaccount:rbac-demo:app -n kube-system
kubectl auth can-i '*' '*' --as=system:serviceaccount:rbac-demo:app -A
```

```console include="captures/k8s-security/rbac-overperm-scoped-secrets-no.txt"
```

All three return `no`. The scoped account can read only its two named ConfigMaps.

### Solution 5

- **ValidatingAdmissionPolicy**: needs nothing installed and cannot fail open —
  unique among the three. Validate/mutate only.
- **Kyverno**: can `generate` resources and `verifyImages` (cosign) — unique.
- **Gatekeeper**: Rego and a reusable template/constraint split, with the OPA
  constraint-library ecosystem.

For (a) a simple universal validation rule with no operational risk, choose the
built-in **VAP**. For (b) verifying image signatures, choose **Kyverno** (or
Sigstore policy-controller) — a VAP cannot check a signature because CEL has no
crypto.

## Common mistakes

- Editing manifests to make a "rejected" step succeed — the rejection is the
  pass condition.
- Concluding a NetworkPolicy works without probing, on a CNI that does not
  enforce it.
- Reading the RBAC YAML instead of asking `kubectl auth can-i` for the effective
  answer.
- Running the reject exercises against a non-lab cluster.

## Related topics

- [RBAC in depth](rbac.md)
- [Pod Security Standards](pod-security-standards.md)
- [Network segmentation](network-segmentation.md)
- [Policy engines](policy-engines.md)
- [Common attack paths](common-attack-paths.md)
