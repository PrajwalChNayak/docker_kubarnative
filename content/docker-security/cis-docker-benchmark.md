---
title: CIS Docker Benchmark
description: What the CIS Docker Benchmark covers, its current version, and how to assess a host with docker-bench-security while knowing the tooling lags the benchmark.
level: advanced
type: concept
status: current
versions: Docker Engine 29
prerequisites:
  - docker-security/container-threat-model
  - docker-security/dropping-capabilities
---

## Overview

The CIS Docker Benchmark is a consensus checklist of host, daemon, image and
container settings that harden a Docker installation. It turns the scattered
advice in this part into numbered, auditable controls. This page explains what
the benchmark covers, its current version, and the automated scanners that check
a host against it — including the important caveat that the common scanners lag
the latest benchmark.

## Why it exists and when to use it

Teams need a shared, external definition of "hardened" for audits, compliance and
onboarding. "We follow good practice" is not auditable; "we pass CIS Docker
Benchmark section 5 with documented exceptions" is. Use it as a baseline
checklist for host and daemon configuration, as a CI gate on image/runtime
settings, and as the vocabulary for security reviews.

The Kubernetes analogue is the CIS Kubernetes Benchmark checked with kube-bench,
covered in [CIS benchmark with kube-bench](../k8s-security/cis-benchmark-kube-bench.md).

## How it works underneath

The benchmark is a versioned PDF of recommendations, each with rationale, an
audit procedure and a remediation. **The current version is CIS Docker Benchmark
v1.8.0** (verified on cisecurity.org, 2026-09-21). Recommendations are grouped
into sections that map onto the attack surfaces from the threat model:

| Section | Focus | Examples |
|---|---|---|
| 1. Host configuration | the machine the daemon runs on | separate partition for `/var/lib/docker`, audit Docker files, keep the kernel patched |
| 2. Docker daemon configuration | `dockerd` flags and `daemon.json` | do not expose the daemon on TCP without TLS, enable live-restore, default ulimits, `no-new-privileges` default |
| 3. Docker daemon files | ownership/permissions of daemon files | `docker.sock`, `daemon.json`, TLS keys owned `root` and not world-readable |
| 4. Container images and build | Dockerfile and image hygiene | run as non-root `USER`, add `HEALTHCHECK`, do not embed secrets, pin base images |
| 5. Container runtime | per-container flags | drop capabilities, read-only rootfs, no `--privileged`, no socket mount, memory/PID limits, seccomp/AppArmor on |
| 6. Docker security operations | process | image sprawl, patching cadence |
| 7. Swarm | Swarm-mode settings | (skip if not using Swarm) |

Sections 4 and 5 are the ones every page in this part has been building toward:
non-root, dropped capabilities, read-only rootfs, no-new-privileges, seccomp,
resource limits, and no socket or `--privileged`.

## Basic example

Two open-source scanners check a host against the benchmark.

**docker-bench-security** (the original shell script from Docker) runs the checks
against the live host and daemon:

```bash
docker run --rm --net host --pid host --userns host --cap-add audit_control \
  -v /etc:/etc:ro \
  -v /var/lib:/var/lib:ro \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  docker/docker-bench-security
```

**aquasecurity/docker-bench** is a Go reimplementation with the checks in
updatable YAML, run similarly against the host.

You can also spot-check individual daemon settings by hand:

```bash
docker info --format '{{.SecurityOptions}}'
docker info --format 'live-restore={{.LiveRestoreEnabled}} userns={{.SecurityOptions}}'
```

```console include="captures/docker-security/security-options.txt"
```

## Explanation

A scanner walks each recommendation, inspects the host/daemon/containers, and
reports PASS/WARN/INFO with the control number. You triage the WARNs: fix what
applies, and record a documented exception for what does not (for example, a
control about a feature you do not use). The output becomes your evidence trail.

The crucial nuance is **version drift**. The current benchmark is v1.8.0, but the
common scanners target older editions: `docker/docker-bench-security` states its
checks are based on **CIS Docker Benchmark v1.6.0**, and its prebuilt image is
out of date so a manual build is required (tracked in the project's issue #405).
`aquasecurity/docker-bench` also tops out around v1.6.0 in its bundled configs.
So a green scan means "passes ~v1.6.0", not "passes v1.8.0". Read the benchmark
itself for the newest controls rather than trusting a scanner to know them.

## Common patterns

- **Baseline once, gate continuously.** Run a full scan when standing up a host,
  then encode the per-container controls (section 5) as enforced defaults —
  Compose `x-app-security` anchors, `docker run` wrappers, or admission policy —
  so new workloads inherit them.
- **Map controls to enforcement, not prose.** Each section-5 item corresponds to
  a concrete flag covered in this part; enforce the flag rather than re-checking
  after the fact.
- **Document exceptions.** Keep a short register of controls you deliberately do
  not meet, with the reason, so an audit is a lookup, not an argument.

## Production considerations

Scanners need broad host access (the socket, host PID/network, read-only host
mounts) to inspect everything, so run them as a trusted, ephemeral job on the
host, not as a standing service, and give them read-only mounts. Prefer running
against a representative host in a pipeline over ad-hoc manual runs.

Because the tooling lags the published benchmark, treat scanner output as a
floor. Track the current v1.8.0 controls yourself, especially newer daemon and
runtime recommendations, and fold them into your enforced defaults even if no
scanner flags them yet.

## Security considerations

A passing benchmark is necessary, not sufficient: it checks configuration, not
whether your application code is safe, whether your images carry CVEs, or whether
a secret leaked into a layer. Combine it with vulnerability scanning, secret
scanning and the runtime hardening from the rest of this part.

The scanner itself is privileged. Use a trusted build of it, mount the socket
read-only, and remove the container when done; do not leave a benchmark tool with
socket access running.

## Troubleshooting

- **Scan reports controls we already enforce as WARN.** The scanner may target an
  older benchmark or misdetect a setting applied via anchor/wrapper. Verify the
  live setting with `docker inspect`; record an exception if the control does not
  apply.
- **`docker/docker-bench-security` image is stale or errors.** The prebuilt image
  is out of date (issue #405); build it from source, or use
  `aquasecurity/docker-bench`.
- **Every container fails section 5.** The per-container hardening is not being
  applied. Add the `x-app-security`-style defaults (cap drop, read-only,
  no-new-privileges, seccomp) to your runtime template.

## Common mistakes

- Assuming a green scan means "current"; the scanners lag v1.8.0.
- Running the benchmark once and never enforcing the per-container controls it
  checks.
- Treating benchmark pass as equivalent to "secure", ignoring CVEs and secrets.
- Leaving a socket-mounted scanner container running instead of removing it.
- Not documenting deliberate exceptions, so every audit re-litigates them.

## Related topics

- [The container threat model](container-threat-model.md)
- [Dropping capabilities](dropping-capabilities.md)
- [Read-only root filesystem and tmpfs](read-only-root-filesystem.md)
- [CIS benchmark with kube-bench](../k8s-security/cis-benchmark-kube-bench.md)
- [Base image patching](base-image-patching.md)
