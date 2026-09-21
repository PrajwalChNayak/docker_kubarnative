---
title: Policy engines
description: When to reach for Kyverno, OPA Gatekeeper or the built-in ValidatingAdmissionPolicy — and the same rule written in all three.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-security/pod-security-standards
  - k8s-advanced/admission-policies-cel
---

## Overview

Pod Security Admission gives you three fixed profiles. A **policy engine** gives
you arbitrary admission rules: "images must be signed", "no `:latest`", "every
namespace must have a NetworkPolicy", "resource limits are required". Three
mechanisms dominate: the built-in **ValidatingAdmissionPolicy** (VAP), and the
add-on engines **Kyverno** and **OPA Gatekeeper**. This page is about choosing
between them, with the identical rule implemented in each so you can compare.

## Why it exists and when to use it

Use a policy engine when your rules are more specific than the three PSS
profiles, are organisation-wide, or must **mutate** or **generate** resources
(inject a default `securityContext`, create a default NetworkPolicy per
namespace) or **verify image signatures**. Reach for the built-in VAP first
when a pure validation rule suffices — it needs nothing installed — and add
Kyverno or Gatekeeper when you need their extra verbs.

## How it works underneath

All three run at **admission**, after authn/authz, as the API server is about to
persist an object. VAP is evaluated inside the API server; Kyverno and
Gatekeeper are admission **webhooks** the API server calls out to.

| | ValidatingAdmissionPolicy (+ Mutating) | Kyverno | OPA Gatekeeper |
|---|---|---|---|
| Language | CEL | YAML patterns (+ CEL, JMESPath) | Rego |
| Install | **None** — built into the API server | Controller + CRDs | Controller + CRDs |
| Validate | Yes | Yes | Yes |
| Mutate | Yes (MutatingAdmissionPolicy, GA 1.36) | Yes | Limited (assign mutators) |
| Generate | No | Yes | No |
| Verify image signatures | No (no crypto in CEL) | Yes (`verifyImages`, cosign) | Via external data / add-ons |
| Fail mode risk | Cannot fail open — in-process | Webhook down can block or bypass admission | Same webhook risk |
| Maturity | VAP GA 1.30, MAP GA 1.36 | CNCF, YAML-native | CNCF, Rego-native |

VAP's key operational advantage is that there is **no webhook to fail**: a
crashed policy pod cannot block all admissions or, worse, let everything
through. Its limitation is scope — validate and mutate only, no generate, no
signature verification.

## Basic example

The same rule — **no `:latest` (or untagged) image** — in all three engines.

Built-in VAP (CEL, nothing to install):

```yaml include="examples/k8s/policy/vap-disallow-latest.yaml" lines="1-20"
```

Kyverno (YAML patterns):

```yaml include="examples/k8s/policy/kyverno-disallow-latest.yaml" lines="1-22"
```

OPA Gatekeeper (Rego template + a constraint that instantiates it):

```yaml include="examples/k8s/policy/gatekeeper-disallow-latest.yaml" lines="40-50"
```

## Explanation

The VAP states the rule as one CEL expression the API server evaluates itself,
bound to namespaces by a `ValidatingAdmissionPolicyBinding`. Kyverno states it
as a declarative YAML pattern (`image: "!*:latest"`) that reads like the object
it validates. Gatekeeper splits the rule (a Rego `ConstraintTemplate` that
generates a new CRD) from where it applies (a `Constraint` of that CRD). Three
styles, one outcome: a pod with `busybox:latest` is rejected, `busybox:1.37` is
admitted. The full comparison and the runnable files are in
`examples/k8s/policy/`.

## Common patterns

- **VAP for validation floors** you want everywhere with no operational risk:
  disallow `:latest`, require limits, restrict registries.
- **Kyverno for mutate/generate/verifyImages**: inject defaults, generate a
  default-deny NetworkPolicy into every new namespace, verify cosign
  signatures ([supply-chain-admission](supply-chain-admission.md)).
- **Gatekeeper where you already invest in Rego** or need the OPA ecosystem and
  constraint libraries.
- **Layer them.** PSA as the floor, VAP for simple universal rules, one add-on
  engine for the richer policies — do not run two overlapping add-on engines.

## Production considerations

Webhook engines add a call to the admission path, so **failure policy** matters:
`failurePolicy: Fail` is safe (deny when the engine is unreachable) but can block
all deployments if the engine is down; `Ignore` keeps the cluster running but
opens a bypass window. Exempt the engine's own namespace and core system
namespaces from its policies, or a crash loop becomes unrecoverable. VAP avoids
this class of problem because it runs in-process. Start every policy in
`audit`/`warn` mode, review the violations, then switch to `Enforce`/`Deny`.

## Security considerations

A policy engine is only as trustworthy as its own deployment: its webhook config
is a high-value target, its controller often needs broad read access, and a
mutating policy can *weaken* security if misused (e.g. injecting a permissive
default). Protect the engine's RBAC and its `ValidatingWebhookConfiguration`
like control-plane components. Remember policies are admission-time only — they
govern what is created, not what a running container later does.

## Troubleshooting

If a policy is not firing, check its binding/match scope and mode (a policy in
`audit` only annotates). If deployments suddenly fail cluster-wide, suspect a
webhook engine with `failurePolicy: Fail` that is down — check the engine's pods.
`kubectl get validatingadmissionpolicy` lists the built-in policies in effect:

```bash
kubectl get validatingadmissionpolicy
```

```console include="captures/k8s-security/vap-list.txt"
```

## Common mistakes

- Installing a heavyweight engine for a rule the built-in VAP could enforce.
- Running two add-on engines with overlapping policies and fighting the
  duplication.
- Setting `failurePolicy: Fail` without exempting system namespaces, then
  locking the cluster out when the engine crashes.
- Shipping policies straight to `Enforce` without an audit period.
- Forgetting that admission policy says nothing about runtime behaviour.

## Related topics

- [Pod Security Standards](pod-security-standards.md)
- [Supply chain admission](supply-chain-admission.md)
- [Admission policies with CEL](../k8s-advanced/admission-policies-cel.md)
- [Unsigned image, and how to close it](attack-unsigned-image.md)
