---
title: From PodSecurityPolicy to Pod Security Admission
description: Map removed PodSecurityPolicies to Pod Security Standards levels and admission modes, and know where PSA stops and a policy engine begins.
level: advanced
type: migration
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-security/pod-security-standards
  - k8s-security/security-context
  - k8s-security/policy-engines
---

## Overview

PodSecurityPolicy (PSP) was deprecated in 1.21 and **removed in 1.25**; its API,
`policy/v1beta1 PodSecurityPolicy`, no longer exists. Its replacement, Pod
Security Admission (PSA), is a built-in admission controller — Stable since 1.25
— that enforces the three Pod Security Standards (PSS) levels through namespace
labels. This page maps PSP concepts to PSS levels and PSA modes, shows the
audit-first migration path, and is honest about what PSA cannot do so you know
when you also need a policy engine.

If you never ran PSP, you do not need to migrate anything — start straight at
[Pod Security Standards](../k8s-security/pod-security-standards.md). This page is
for clusters carrying PSP objects or PSP-shaped assumptions.

## The model shift

PSP and PSA solve the same problem — constraining what a Pod may request — with
very different mechanics.

| | PodSecurityPolicy (removed) | Pod Security Admission |
|---|---|---|
| Granularity | per-policy, selected by RBAC on the `use` verb | per-namespace, by label |
| Selection | whichever PSP the creating identity may `use` (order-dependent, surprising) | the namespace's labels, deterministic |
| Rules | ~30 independent fields | three fixed, versioned levels |
| Mutation | could mutate Pods (defaults, fsGroup) | **never mutates**; validate-only |
| Failure mode | famously hard to reason about | three explicit modes |

The loss of mutation is the big behavioural change: PSP could quietly add
`securityContext` defaults, PSA only accepts or rejects. Anything you relied on
PSP to *set* must now be set in the manifest, by a mutating policy engine, or by
a mutating admission policy.

## PSP → PSS level mapping

The three PSS levels are fixed policies. Map each PSP to the nearest level, then
tighten:

| PSP shape | PSS level |
|---|---|
| `privileged: true`, host namespaces, wide capabilities | **privileged** (unrestricted; used only for trusted infra) |
| No privilege escalation controls, but blocks the obvious host escapes | **baseline** (minimally restrictive; blocks known escalations) |
| `MustRunAsNonRoot`, drop `ALL` capabilities, `readOnlyRootFilesystem`, seccomp `RuntimeDefault`, restricted volumes | **restricted** (hardened; current best practice) |

The Tasklane `tasklane` namespace runs at **restricted**, which its pods already
satisfy (non-root UID 65532, `allowPrivilegeEscalation: false`, `drop: ["ALL"]`,
`seccompProfile: RuntimeDefault`).

## PSA modes and labels

PSA enforces a level in one of three independent modes, set as namespace labels:

```yaml title="namespace with PSA labels (fragment)" fragment
metadata:
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: v1.37
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/audit: restricted
```

- **enforce** — reject Pods that violate the level (only Pods; not Deployments).
- **warn** — allow, but return a client-visible warning (catches the workload
  controllers that create Pods, because the warning surfaces on the Deployment).
- **audit** — allow, but annotate the audit log.

Pin `<mode>-version` to a release (for example `v1.37`) so a cluster upgrade
does not silently change what a level means. Because `enforce` only sees Pods,
always pair it with `warn` at the same level to catch bad Deployments at apply
time.

## Exemptions

PSA can exempt by **username**, **RuntimeClass name**, or **namespace**, but only
through the API server's `AdmissionConfiguration` file — not with a per-object
annotation. Exemptions are cluster-wide and coarse:

```yaml title="PodSecurity admission config (fragment)" fragment
apiVersion: apiserver.config.k8s.io/v1
kind: AdmissionConfiguration
plugins:
  - name: PodSecurity
    configuration:
      apiVersion: pod-security.admission.config.k8s.io/v1
      kind: PodSecurityConfiguration
      defaults:
        enforce: baseline
        enforce-version: latest
      exemptions:
        usernames: []
        runtimeClasses: []
        namespaces: [kube-system]
```

Setting a cluster-wide `defaults` block means new namespaces are governed even
before anyone labels them — a strong safety default.

## Migration steps

Never start at `enforce`. You will break workloads you did not know were
non-compliant.

1. **Set a cluster default of `baseline` warn/audit** in `AdmissionConfiguration`
   so nothing is silently unprotected.
2. **Label each namespace `warn` and `audit` at the target level**
   (`restricted` for app namespaces). Apply nothing to `enforce` yet.
3. **Collect violations.** Read the warnings on apply and the audit annotations.
   Fix manifests: add the missing `securityContext`, drop capabilities, set
   `runAsNonRoot`.
4. **For defaults PSP used to inject**, add them explicitly or via a mutating
   policy engine (see below). PSA will not add them for you.
5. **Flip `enforce` to the target level** once warnings are clean, still keeping
   `warn`/`audit` on to catch drift.
6. **Delete any leftover PSP RBAC** (`ClusterRole` `use` rules on
   `podsecuritypolicies`) — dead references now, but confusing.

## Where PSA falls short → policy engines

PSA is deliberately narrow. It has exactly three levels, cannot mutate, and
cannot express anything outside PSS. It cannot:

- require your own rules (allowed registries, mandatory labels, image digests);
- enforce something *between* baseline and restricted, or a per-team variant;
- mutate Pods to add defaults, sidecars or `securityContext` fields;
- validate non-Pod resources.

For those, add a policy engine —
[Kyverno or Gatekeeper](../k8s-security/policy-engines.md) — alongside PSA, not
instead of it. PSA gives you a strong, zero-dependency baseline; the engine adds
the organisation-specific rules and any mutation you lost with PSP. Kubernetes'
built-in ValidatingAdmissionPolicy (GA since 1.30) and MutatingAdmissionPolicy
(GA since 1.36) can cover many cases with CEL and no extra controller.

## Common mistakes

- **Starting at `enforce`.** Always run `warn`/`audit` first and read the
  results.
- **Expecting PSA to mutate.** It never sets defaults; PSP's mutation is gone.
  Set fields in the manifest or with a mutating policy.
- **Labelling only `enforce`.** `enforce` ignores Deployments, so a bad template
  is accepted and only the Pod is rejected later. Pair it with `warn`.
- **Not pinning `<mode>-version`.** An upgrade can change what `restricted`
  means; pin it and bump deliberately.
- **Trying to exempt with an annotation.** Exemptions live only in the
  API server's admission config, and are cluster-wide.
- **Assuming PSA replaces a policy engine.** It covers PSS and nothing else.

## Related topics

- [Pod Security Standards](../k8s-security/pod-security-standards.md)
- [Security context](../k8s-security/security-context.md)
- [Policy engines](../k8s-security/policy-engines.md)
- [Admission policies with CEL](../k8s-advanced/admission-policies-cel.md)
- [Removed API versions](removed-api-versions.md)
