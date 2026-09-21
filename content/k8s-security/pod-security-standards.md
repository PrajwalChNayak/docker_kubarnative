---
title: Pod Security Standards and Admission
description: The three profiles, the enforce/audit/warn modes, per-namespace labels and version pinning, exemptions, and migrating off PodSecurityPolicy.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-security/security-context
  - k8s-beginner/namespaces
---

## Overview

**Pod Security Standards (PSS)** define three profiles — **Privileged**,
**Baseline** and **Restricted** — that describe how locked-down a pod is. The
built-in **Pod Security Admission (PSA)** controller enforces a chosen profile
per namespace using labels. PSS has been stable since v1.26 and PSA since v1.25;
they are the in-tree, always-available replacement for the removed PSP
mechanism (its full name appears in the migration note below).

## Why it exists and when to use it

PSA is the **floor** every cluster should have on, because it needs no
installation, cannot fail open, and stops the most dangerous pod shapes
(privileged, host namespaces, hostPath) before scheduling. Use it on every
application namespace. It is coarse — three fixed profiles, no custom rules — so
pair it with a [policy engine](policy-engines.md) when you need finer or
organisation-specific rules.

## How it works underneath

The three profiles are cumulative in strictness:

| Profile | Intent | Allows |
|---|---|---|
| **Privileged** | Unrestricted; for trusted system workloads | Everything, including `privileged`, host namespaces, hostPath |
| **Baseline** | Prevent known privilege escalations | Blocks privileged, host namespaces, most `hostPath`; still allows running as root |
| **Restricted** | Hardened, current best practice | Requires non-root, `allowPrivilegeEscalation: false`, drop ALL capabilities, seccomp `RuntimeDefault`, no host access |

PSA applies a profile through namespace labels, in three independent **modes**:

- `enforce` — the API server **rejects** violating pods at admission.
- `warn` — the client gets a warning but the pod is admitted.
- `audit` — a violation is recorded as an annotation in the audit log.

Each mode has an optional `-version` suffix that **pins** the profile to a
Kubernetes version, so a cluster upgrade cannot silently tighten the rules.
Crucially, `enforce` only checks at pod create/update — it does **not** apply to
higher-level controllers' templates. `warn` and `audit`, by contrast, evaluate
Deployments too, which is why you usually set all three.

## Basic example

The demo namespace enforces `restricted`, version-pinned, with warn and audit
on as well:

```yaml include="examples/k8s/pod-security/namespace.yaml"
```

A compliant pod is admitted; a privileged one is rejected. The rejection is
marked `expect=reject` so the harness confirms the API server blocks it:

```yaml include="examples/k8s/pod-security/noncompliant-pod.yaml"
```

## Explanation

Applying `noncompliant-pod.yaml` to `psa-demo` fails at admission with a
`violates PodSecurity "restricted:v1.37"` error that lists every field it
breaks. Nothing reaches the kubelet, so no privileged container is ever
created — the rejection *is* the security control working. The compliant pod,
which carries `runAsNonRoot`, `allowPrivilegeEscalation: false`, dropped
capabilities and a seccomp profile, is admitted normally. This is the whole
model: the namespace states a standard, and the API server refuses anything
below it.

## Common patterns

- **Enforce `restricted` on application namespaces; `baseline` where a workload
  genuinely needs root** but not host access; `privileged` only on trusted
  system namespaces (and treat that label as a finding elsewhere).
- **Always version-pin** (`enforce-version`) so upgrades are deliberate.
- **Set warn and audit to match enforce**, so controller templates that would
  produce rejected pods surface as warnings at apply time, not as silent
  ReplicaSet failures later.

## Exemptions

PSA supports cluster-level **exemptions** (by username, RuntimeClass or
namespace) configured in the `PodSecurity` admission configuration on the API
server. Exemptions are a blunt, cluster-wide escape hatch — an exempt namespace
is not evaluated at all — so keep the list tiny and reviewed. Prefer running the
rare privileged workload in its own labelled namespace over adding an exemption.

## Production considerations

The migration order for an existing, busy cluster is: turn on `warn` and
`audit` at the target level first, watch for a release cycle, fix or exempt the
workloads that trip, then promote to `enforce`. Server-side dry-run lets you
test the effect without persisting anything:

```bash
kubectl label --dry-run=server --overwrite ns tasklane \
  pod-security.kubernetes.io/enforce=restricted
```

```console include="captures/k8s-security/psa-server-dryrun-audit.txt"
```

:::legacy
PSA replaced **PodSecurityPolicy**, which was removed in Kubernetes 1.25. If you
are migrating from it, map each old policy to the nearest PSS profile plus, for
anything the three profiles cannot express, a policy-engine rule. The dedicated
migration page in Part M covers the mechanics.
:::

## Security considerations

PSA is necessary but not sufficient. It cannot express "images must be signed",
"no `:latest`", "must set resource limits", or per-team rules — those need a
[policy engine](policy-engines.md). It also only governs pod **shape**, not what
a running container does; that is the job of [runtime
security](runtime-security-falco.md). Treat `restricted` as the baseline, then
layer policy and runtime detection on top.

## Troubleshooting

If a Deployment's pods never appear, describe the ReplicaSet: a PSA rejection
shows up there as a `FailedCreate` event with the `violates PodSecurity`
message, because the Deployment controller keeps retrying a template the API
server refuses. Fix the pod template's `securityContext`, not the Deployment.
If pods you expected to be blocked are admitted, check that the namespace label
is `enforce` (not only `warn`) and spelled exactly
`pod-security.kubernetes.io/enforce`.

## Common mistakes

- Setting only `enforce` and being surprised a bad Deployment fails silently at
  the ReplicaSet instead of warning at apply time.
- Forgetting to version-pin, so an upgrade tightens rules under running apps.
- Labelling an application namespace `privileged` "temporarily".
- Treating PSA as complete and skipping policy engines and runtime security.
- Adding a namespace exemption instead of a scoped privileged namespace.

## Related topics

- [Security context](security-context.md)
- [Policy engines](policy-engines.md)
- [Runtime security with Falco](runtime-security-falco.md)
- [Privileged pod escape, and how to close it](attack-privileged-pod-escape.md)
