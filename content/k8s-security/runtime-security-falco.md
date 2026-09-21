---
title: Runtime security with Falco
description: Detecting malicious behaviour in running containers from syscalls or eBPF, how Falco rules and drivers work, and where detection fits alongside prevention.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37, Falco 0.44
prerequisites:
  - k8s-security/security-context
  - foundations/seccomp
---

## Overview

Every control so far — RBAC, Pod Security, admission policy, signing — is
**preventive** and acts *before* a container runs. **Falco** is **detective**
and acts *while* it runs: it watches the actual behaviour of containers and
alerts when something matches a rule, such as a shell spawned in a container, a
write to a sensitive path, or an outbound connection to an unexpected host. It
is the "assume breach" layer that catches what prevention missed.

## Why it exists and when to use it

Prevention is never complete: a zero-day, a legitimate-but-abused permission, or
a subtle misconfiguration can still get code running. Runtime detection gives
you a chance to notice and respond. Deploy Falco (a CNCF graduated project) when
you need to satisfy the "monitoring, logging and runtime security" requirements
of frameworks like the CIS Benchmark or CKS, or simply to know when a container
does something it never should.

## How it works underneath

Falco consumes a stream of **kernel events** — primarily **syscalls** — and
evaluates each against a rule set. It gets those events from a **driver**:

- **Modern eBPF probe** (CO-RE) — the recommended default on current kernels;
  no kernel module to compile, portable across kernel versions.
- **Kernel module** — the classic driver.
- **Legacy eBPF probe** — for older kernels.

It also ingests **Kubernetes audit events** as a second event source, so it can
alert on API-level actions (a pod created with `hostPath`, a Secret read) as
well as in-container syscalls. Falco runs as a **DaemonSet**, one agent per
node, because syscalls are a node-local signal.

A rule matches fields of an event and raises an alert at a priority. The engine
ships hundreds of community rules; you tune them to your workloads to control
noise. Alerts go out through **falcosidekick** to Slack, a SIEM, Prometheus
Alertmanager, and similar, where your on-call actually sees them.

## Basic example

A Falco rule is YAML: a condition over event fields, an output template and a
priority.

```yaml title="falco-rule.yaml" fragment
- rule: Shell spawned in container
  desc: A shell was executed inside a container, which Tasklane never does.
  condition: >
    spawned_process and container
    and proc.name in (bash, sh, zsh)
  output: >
    Shell in container (pod=%k8s.pod.name ns=%k8s.ns.name
    proc=%proc.cmdline image=%container.image.repository)
  priority: WARNING
  tags: [container, shell, mitre_execution]
```

## Explanation

The `condition` is the detection logic: a process was spawned, inside a
container, and its name is a shell. The `output` is what the responder sees,
templated with context — pod, namespace, command and image — so the alert is
actionable without further digging. Because Tasklane's containers are distroless
and never run a shell, this rule firing is a strong signal that something is
wrong. This is a fragment for illustration; production rule sets live in Falco's
own configuration, not in application manifests.

## Common patterns

- **eBPF driver by default** on modern kernels; fall back to the module only
  where eBPF is unavailable.
- **Tune before you enforce alerting.** Run in a namespace, collect what fires,
  suppress the legitimate noise, then wire alerts to on-call.
- **Combine syscall and audit sources** so you see both in-container behaviour
  and control-plane actions.
- **Map rules to MITRE ATT&CK** tags so alerts speak your incident-response
  team's language.

## Production considerations

Falco is a per-node agent reading a high-volume event stream, so it costs CPU;
the eBPF driver and good rule tuning keep it modest. The real work is **alert
fatigue**: an untuned rule set drowns responders and trains them to ignore
Falco. Budget time to curate rules per workload. Ensure alerts reach a system
people watch (Alertmanager/SIEM), and that Falco's own DaemonSet and output
pipeline are monitored — a detector that is silently down is worse than none.

## Security considerations

Falco is detection, not prevention: by the time a rule fires, the behaviour has
already happened, so pair it with a response plan (isolate the pod, rotate its
credentials, preserve evidence). The agent needs privileged, node-level access
to read syscalls, which makes the Falco DaemonSet itself a sensitive workload —
protect its RBAC and image supply chain accordingly. Detection complements the
preventive layers; it does not replace hardening the pods in the first place.

## Troubleshooting

If Falco produces no events, the driver likely failed to load — check the agent
logs for the eBPF/module load step and the kernel compatibility. If alerts never
reach your channel, the problem is usually the falcosidekick output config, not
the rules. If a rule floods, narrow its condition or add an exception for the
known-good process/image rather than disabling the whole rule.

## Common mistakes

- Deploying the default rule set untuned and drowning in false positives.
- Treating Falco as prevention and skipping pod hardening.
- Sending alerts nowhere anyone looks.
- Forgetting Falco is a privileged workload that itself must be secured.
- Not monitoring whether the Falco DaemonSet is actually running on every node.

## Related topics

- [Audit logging](audit-logging.md)
- [Security context](security-context.md)
- [CIS Benchmark and kube-bench](cis-benchmark-kube-bench.md)
- [Common attack paths](common-attack-paths.md)
