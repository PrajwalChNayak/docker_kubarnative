---
title: CIS Benchmark and kube-bench
description: What the CIS Kubernetes Benchmark checks, how kube-bench automates it, and how to read results without chasing false positives on managed clusters.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37, kube-bench 0.16
prerequisites:
  - k8s-beginner/architecture
  - k8s-security/authentication-and-authorisation
---

## Overview

The **CIS Kubernetes Benchmark** is a community consensus checklist of hardening
recommendations for a cluster's components: the API server, controller manager,
scheduler, etcd, the kubelet, and baseline policies. **kube-bench** is the tool
that runs those checks against a real cluster and reports pass/fail with
remediation text. Together they turn "is our control plane hardened?" into a
concrete, repeatable score.

## Why it exists and when to use it

Control-plane flags are easy to get subtly wrong — an `--anonymous-auth=true`
here, a permissive `--authorization-mode` there — and the defaults are not all
safe. The benchmark encodes the accumulated consensus on what those flags should
be. Run kube-bench when you stand up a self-managed cluster, in CI against your
node images, and periodically to catch drift. It is a core CKS skill: "use CIS
benchmark to review the security configuration of Kubernetes components".

## How it works underneath

kube-bench runs as a Job (or a pod) on the nodes and inspects the actual
component configuration — process flags, config-file permissions and ownership,
certificate settings — comparing each against the benchmark's expected value. It
selects the **benchmark version** that matches your Kubernetes version and
groups results into sections:

- **Control plane / master**: API server, controller manager, scheduler flags.
- **etcd**: peer/client TLS, encryption, access.
- **Worker / kubelet**: kubelet flags, `--anonymous-auth=false`,
  `--authorization-mode=Webhook`, config-file permissions.
- **Policies**: RBAC, Pod Security, network policies, ServiceAccount usage.

Each check reports `PASS`, `FAIL`, `WARN` or `INFO`, with a remediation string.
`WARN` typically marks a check kube-bench cannot fully automate (it needs a human
decision) or one that does not apply to your setup.

## Basic example

kube-bench is invoked as a job against the cluster; its results are captured by
the maintainer rather than fabricated here. A single result reads like:

```text title="kube-bench result shape (illustrative)" fragment
[FAIL] 1.2.x Ensure that the --anonymous-auth argument is set to false
[PASS] 1.2.y Ensure that the --authorization-mode argument includes Node
[WARN] 5.x.z Minimize the admission of privileged containers
== Remediation ==
Edit the API server pod spec and set --anonymous-auth=false ...
```

## Explanation

Read results as **signal, not gospel**. A `FAIL` on a control-plane flag you own
is actionable — apply the remediation. A `WARN` on a policy check often means
kube-bench cannot see the whole picture (it cannot tell that Pod Security
Admission enforces `restricted` cluster-wide) and you confirm it manually. The
remediation strings are the practical value: they tell you exactly which flag or
file to change. The shape above is illustrative; the real output is captured
from a run.

## Managed clusters

On EKS, GKE and AKS you **do not control the control plane**, so master-section
checks either do not apply or cannot be inspected — the provider hardens those,
and their shared-responsibility docs say which. kube-bench ships provider
profiles (`--benchmark eks-1.x`, etc.) that skip the checks you cannot act on
and focus on the worker nodes and policies you *do* own. Running the generic
profile against a managed cluster produces a wall of irrelevant failures; use the
matching profile.

## Common patterns

- **Match the benchmark version to your Kubernetes version**, and the profile to
  your platform (self-managed vs EKS/GKE/AKS).
- **Run in CI** against node images and as a scheduled job to detect drift.
- **Triage by ownership**: fix what you control, document what the provider owns,
  justify accepted `WARN`s.
- **Track the score over time** rather than chasing a perfect one-off run.

## Production considerations

A benchmark is a floor, not a ceiling: a perfect kube-bench score does not mean
the cluster is secure — it means the component flags match consensus. It says
nothing about your RBAC sprawl, your images, or your network policies beyond
their presence. Treat it as one input alongside RBAC audits, image scanning and
runtime detection. Also beware **drift**: nodes reconfigured out-of-band, or a
new node pool from a stale image, silently regress the score.

## Security considerations

kube-bench needs to read control-plane and kubelet configuration, so it runs
with elevated host access on the nodes — scope its RBAC and run it from a trusted
image. Its report itself is sensitive: it enumerates exactly where your cluster
is weak, so treat the output like a vulnerability report, not a public artifact.

## Troubleshooting

If every master check is `FAIL` or `INFO` with "config not found", you are on a
managed cluster or ran the wrong profile — switch to the provider profile. If
results disagree with reality (a `WARN` on privileged containers you know PSA
blocks), it is a check kube-bench cannot automate; verify manually and record the
justification. If the version mismatches, kube-bench may auto-detect wrongly —
pin `--version`/`--benchmark`.

## Common mistakes

- Running the generic benchmark against a managed cluster and drowning in
  inapplicable failures.
- Treating a green kube-bench as "we are secure".
- Ignoring `WARN`s instead of resolving each to pass-or-justified.
- Running it once at launch and never again, missing drift.
- Publishing the report, which is a map of your weaknesses.

## Related topics

- [Authentication and authorisation](authentication-and-authorisation.md)
- [Pod Security Standards](pod-security-standards.md)
- [Audit logging](audit-logging.md)
- [Common attack paths](common-attack-paths.md)
