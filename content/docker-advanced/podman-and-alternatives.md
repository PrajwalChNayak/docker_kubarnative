---
title: Podman and alternatives
description: An honest comparison of Podman 6, nerdctl, Colima, Rancher Desktop and Finch against Docker, including what each one gets wrong for your case.
level: advanced
type: reference
status: current
versions: Docker Engine 29, Buildx 0.37, Podman v6.1.2
prerequisites:
  - docker-advanced/rootless-docker
  - docker-beginner/install-docker
---

## Overview

Docker is not the only way to build and run OCI containers, and since Docker
Desktop's licensing change the alternatives get asked about constantly. They
are real tools with real trade-offs, not drop-in replacements with different
logos.

This page compares them without advocacy. The images you build are OCI
images either way; what differs is the daemon model, the network stack, the
Compose story and the desktop experience.

:::note
Docker Desktop is free for companies with **fewer than 250 employees AND less
than $10 million annual revenue**, and for personal, education and
non-commercial open-source use. Everyone else needs a paid subscription.
Docker **Engine** on Linux is not affected by that licensing. For many
teams the real question is "what do we run on macOS and Windows", not "what
replaces Docker".
:::

## The landscape

| Tool | What it is | Daemon | Rootless | Compose |
|---|---|---|---|---|
| Docker Engine | The reference implementation | Yes (`dockerd`) | Optional | `docker compose` (v5) |
| Podman | Daemonless engine, Docker-compatible CLI | No | By design | `podman compose`, or a Docker-compatible socket |
| nerdctl | Docker-compatible CLI for containerd | containerd | Yes | `nerdctl compose` |
| Colima | Lima VM running containerd or Docker on macOS/Linux | Depends | Depends | Depends on the runtime chosen |
| Rancher Desktop | Desktop app: Kubernetes (k3s) + containerd or dockerd | Depends | Depends | Depends |
| Finch | AWS client that packages Lima, nerdctl, containerd and BuildKit | containerd | Yes | `finch compose` |

## Podman

Podman v6.1.2 is the current release. The repository moved:
`containers/podman` now redirects to
**`github.com/podman-container-tools/podman`**, whose organisation describes
itself as a CNCF Sandbox project.

**Podman 6.0.0 (2026-06-24) removed a lot.** From the release notes:

- **cgroup v1 removed.** cgroup v2 only.
- **CNI removed** — Netavark is the only network backend.
- **iptables removed** — nftables is required.
- **slirp4netns removed** — pasta is the rootless network stack.
- **BoltDB removed**, with automatic migration to SQLite.
- Network isolation is on by default.
- Intel Macs and Windows 10 are no longer supported.
- **libkrun is the default macOS provider.**
- Go import path is now `go.podman.io/podman/v6`.
- Docker-compatible API is at v1.44.
- `volume prune` only removes anonymous volumes.

That list is the honest summary of a Podman 6 migration: if you are on an old
kernel, on CNI, on iptables-based firewalling, or on an Intel Mac, Podman 6
is not a straight upgrade.

**What is genuinely better.** No daemon: `podman run` forks a conmon process
that supervises the container, so there is no root-owned service that "being
in a group" grants you. Rootless is the default rather than a mode. Pods are
a first-class concept, which maps neatly onto Kubernetes, and
`podman generate kube` produces manifests.

**What is genuinely harder.** The Docker-compatible API socket covers most of
the API but not all of it, and tools that use less common endpoints —
Testcontainers, some IDE integrations, some CI runners — find the gaps.
Compose support is a separate implementation with its own quirks. Anything
in your organisation that assumes `docker` on the path needs an alias or a
change.

## nerdctl

A "Docker-compatible CLI for containerd", and a **non-core sub-project** of
containerd. It exists partly to expose containerd features before Docker
does: lazy pulling, image encryption, rootless without slirp overhead. It
supports `nerdctl compose`.

Choose it when containerd is already the runtime you care about — a
Kubernetes node, or a Lima/Colima VM — and you want a familiar CLI on top.
It is not a desktop product; you bring your own VM on macOS and Windows.

## Colima, Rancher Desktop, Finch

These solve the *macOS and Windows* problem, which is really "run a Linux VM
and make it feel local".

- **Colima** provisions a Lima VM with containerd or Docker inside and wires
  up the socket. Minimal, CLI-driven, easy to reason about. You own the VM
  lifecycle.
- **Rancher Desktop** is a full desktop application with a GUI, a bundled
  k3s cluster, and a choice of containerd or dockerd. Attractive when
  developers want a local Kubernetes without extra tooling; heavier than
  Colima.
- **Finch** is AWS's client that packages Lima, nerdctl, containerd and
  BuildKit, with support for macOS, Windows and Linux. Its VM images track
  Amazon Linux 2023.

All three end up running the same containerd and BuildKit that everything
else does. The differences that matter in practice are file-sharing
performance, how VM resources are configured, and whether your team wants a
GUI.

## Choosing

| If you… | Consider |
|---|---|
| Run Linux servers and build in CI | Docker Engine, or BuildKit alone |
| Need rootless and daemonless on Linux | Podman |
| Want Kubernetes locally on a laptop | Rancher Desktop, or kind on any of these |
| Want minimal macOS tooling | Colima or Finch |
| Depend on Testcontainers or Docker API tooling | Verify compatibility before switching |
| Have a Docker Desktop licence question | Read the licence terms; Engine on Linux is unaffected |

The best reason to switch is a requirement you can name. "Docker is
proprietary" is not accurate for Engine, which is open source; "we cannot pay
for Desktop licences for 400 developers" is a real requirement, and it points
at a *desktop* replacement rather than an engine replacement.

## What does not change

- **Images are OCI images.** Anything here can build an image the others run,
  and that Kubernetes runs. Kubernetes has not used Docker as a runtime since
  dockershim was removed in 1.24, and Docker-built images run fine because
  they are OCI images.
- **Dockerfiles are the same**, and BuildKit is the builder under most of
  these tools.
- **Registries are the same.** Signatures and attestations work the same way.
- **The security fundamentals are the same**: non-root users, dropped
  capabilities, read-only root filesystems, seccomp.

Your handbook examples — the Tasklane Dockerfile, the Compose stack, the
manifests — work under all of these with at most a command-name change.

## Migration notes

Aliasing `docker` to `podman` works for simple use and breaks in interesting
ways later (Compose behaviour, `--format` output differences, API clients).
If you migrate, do it deliberately: run both for a sprint, list the tools
that touch the Docker API, and test those first.

For Compose specifically, remember that Compose **v5.0.0 removed the internal
builder and delegates builds to Bake**, and the top-level `version:` key has
been obsolete for years. A migration that also drags along a 2019 compose
file will fail for reasons unrelated to the engine.

## Common mistakes

- Treating Podman as a drop-in for the Docker API. Most of it is compatible;
  the parts that are not surface at the worst time.
- Switching engines to avoid a Desktop licence, when only the desktop product
  is licensed and Engine on Linux is free.
- Missing that Podman 6 removed cgroup v1, CNI, iptables and slirp4netns, and
  planning a migration on an unsupported host.
- Assuming images built by one tool need conversion for another. They do not.
- Comparing tools on benchmarks from a different VM configuration than yours.
- Expecting a local Kubernetes distribution bundled in a desktop app to match
  your production cluster's version and CNI.

## Related topics

- [Rootless Docker](rootless-docker.md)
- [DinD vs socket mounting](dind-vs-socket-mounting.md)
- [Daemon configuration](daemon-configuration.md)
- [Install Docker](../docker-beginner/install-docker.md)
- [Alternatives](../production/alternatives.md)
- [dockershim removal](../migration/dockershim-removal.md)
