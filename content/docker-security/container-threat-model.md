---
title: The container threat model
description: The attack surfaces of a Docker system and the escape classes that hardening exists to close.
level: advanced
type: concept
status: current
versions: Docker Engine 29
prerequisites:
  - foundations/linux-namespaces
  - foundations/capabilities
  - docker-intermediate/running-as-non-root
---

## Overview

A container is not a security boundary in the way a virtual machine is. It is a
process on the host, wrapped in namespaces and cgroups, sharing the host's
kernel. Every hardening technique in this part exists to compensate for that
one fact. This page lays out the attack surfaces of a Docker system, names the
classes of container escape, and gives you a mental model to hang the rest of
Part E on.

The rest of the part is organised threat-first: each page states a threat,
shows a concrete exploit in a disposable lab, applies a fix, and then verifies
the fix. This page is the map.

## Why it exists and when to use it

You cannot defend a system you have not modelled. "Harden the containers" is
not actionable; "an attacker who gets code execution in the API container must
not reach the database container or the host" is. Threat modelling turns vague
unease into a checklist of surfaces to close and controls to verify.

Use it at design time to decide which controls are worth their cost, and during
review to find the surface everyone forgot. The Tasklane stack in `examples/`
is the worked example throughout: an internet-facing API, a worker, and a
database on an internal network.

## How it works underneath

A running container is a set of Linux kernel features applied to a normal
process:

- **Namespaces** give it a private view of PIDs, mounts, network, users, IPC,
  UTS and (optionally) time. They control what the process can *see*.
- **cgroups v2** bound what it can *consume* (CPU, memory, PIDs, IO).
- **Capabilities** split root's powers into ~40 units; the runtime grants a
  small default set and drops the rest.
- **seccomp** filters which syscalls the process may make at all.
- **LSMs** (AppArmor on Debian/Ubuntu, SELinux on RHEL) add mandatory access
  control on top.

The load-bearing reality: **all of this shares one kernel**. A container escape
is any path from inside the process to code execution or data access on the
host or in a peer container. The kernel is the common trust boundary, so a
kernel bug, or a misconfiguration that hands back a capability or a mount, is an
escape.

### Attack surfaces

Think in six surfaces, roughly following the image's life:

| Surface | What an attacker targets | Example |
|---|---|---|
| **Image** | secrets and vulnerable code baked into layers | an API key left in a layer; an unpatched CVE in a base image |
| **Registry** | supply of images | a typosquatted base image; a compromised or unsigned tag |
| **Build** | the build pipeline | a malicious `RUN` that exfiltrates build secrets; cache poisoning |
| **Daemon** | the Docker Engine and its socket | a container with `/var/run/docker.sock`; the `docker` group |
| **Runtime** | the running container's config | `--privileged`, added capabilities, host mounts, no seccomp |
| **Host kernel** | shared-kernel bugs | a syscall the seccomp profile should have blocked |

Each later page closes one or more of these. The socket page closes the daemon
surface; capabilities, read-only rootfs, no-new-privileges and seccomp harden
the runtime surface; secrets-in-images closes the image surface; supply-chain
and base-image-patching close the registry and build surfaces.

### Container escape classes

Escapes fall into a handful of families:

1. **Handed-over host access.** The container was given the means to escape:
   `--privileged`, the Docker socket, `--pid=host`, `--net=host`, `--cap-add
   SYS_ADMIN`, or a bind mount of a sensitive host path. No kernel bug needed;
   the config *is* the hole. These are the most common real-world escapes.
2. **Capability abuse.** A dangerous capability the container should not have
   (`SYS_ADMIN`, `SYS_PTRACE`, `DAC_READ_SEARCH`, `SYS_MODULE`) lets the process
   do something host-affecting from inside.
3. **Kernel exploit.** A bug in a syscall reachable from the container yields
   host code execution. seccomp shrinks the reachable syscall set precisely to
   shrink this surface.
4. **Runtime or filesystem CVE.** Bugs in `runc`, containerd or the image
   unpacking path (for example the `runc` `/proc/self/exe` overwrite,
   CVE-2019-5736). Patching the runtime is the control.
5. **Shared-namespace lateral movement.** Not a host escape but a peer one: a
   compromised container reaches another over a shared network with no
   segmentation, or a shared volume.

:::note
Virtual machines put a hypervisor and a second kernel between guest and host.
Containers do not. Where the workload is genuinely untrusted (multi-tenant
build farms, running arbitrary user code), reach for a stronger sandbox —
gVisor, Kata Containers, or a VM — rather than trusting namespaces alone.
:::

## Basic example

The Tasklane API is a Go binary in a distroless image that already runs as a
non-root numeric UID. Model one threat against it: an attacker finds an RCE in
a dependency and gets code execution as UID 65532 inside the API container.

Ask what they can do next:

- **Read the database password?** It arrives via `PGPASSWORD_FILE`, so it is in
  the container's memory and mounted file — yes, for this container. Segmenting
  the network stops them reaching *other* databases.
- **Escape to the host?** Only if the container has a capability, a host mount,
  or the socket. The hardened Tasklane container drops all capabilities, runs
  read-only, sets no-new-privileges and keeps the default seccomp profile, so
  the easy paths are closed.
- **Reach the worker or a peer service?** Only over a network they share. The
  Compose stack puts the database on an `internal: true` network.

This is the whole method: assume compromise of one component, enumerate the
next hop, and close it.

## Explanation

The point of the exercise is that hardening is *layered and independent*.
Dropping capabilities does nothing against a kernel bug; seccomp does. A
read-only rootfs does nothing against a stolen database password; network
segmentation and secret scoping do. No single control is sufficient, so the
model's job is to make sure each surface has at least one control and that the
controls fail independently.

It also forces honesty about the trust boundary. If the workload is your own
code, namespaces plus the hardening in this part are a reasonable boundary
against *escalation after a bug*. If the workload is untrusted, the shared
kernel is the boundary and you should not rely on containers alone.

## Common patterns

- **Assume-breach per component.** For every container, write one sentence:
  "if this is compromised, the attacker can reach X; we stop them reaching Y
  with Z." If Z is blank, you have found work to do.
- **Default-deny, then add back.** Start from dropped capabilities, read-only
  rootfs, no added privileges, and a deny-all network, then add only what the
  workload proves it needs.
- **Separate blast radii.** Internet-facing components, workers and datastores
  belong on separate networks and, ideally, separate nodes.

## Production considerations

Threat modelling is cheap and repeatable; do it per service and revisit it when
the architecture changes. Encode the outcomes as enforced controls, not wiki
prose: Compose `x-app-security` anchors, `docker run` flags in CI, or Pod
Security Admission and admission policies in Kubernetes. A control nobody
enforces is a comment.

Weigh cost honestly. Full VM-level isolation per workload is expensive and
usually unnecessary for first-party code. Dropping capabilities and running
read-only is nearly free. Spend the isolation budget where the trust boundary
actually is.

## Security considerations

The most exploited surface in practice is the daemon, not the kernel: exposed
sockets, `docker` group membership treated as harmless, and `--privileged`
containers. Kernel-exploit escapes make headlines but are rarer than a CI
runner that was handed the socket. Model the boring surfaces first.

Remember that the host kernel version is part of your attack surface. An
up-to-date kernel and runtime (`runc` 1.5.1, containerd 2.4.0 in this
handbook's baseline) closes whole escape classes that no in-container setting
can.

## Troubleshooting

- **"Which control stops this escape?"** Match the escape to its class above.
  Handed-over access → remove the mount/capability/socket. Kernel/syscall →
  seccomp and a patched kernel. Runtime CVE → update `runc`/containerd.
- **"The app broke when I hardened it."** That is the model working: the app
  wanted a capability or a writable path. Grant the minimum back with a
  comment explaining why, rather than reverting to the permissive default.

## Common mistakes

- Treating a container as equivalent to a VM and running untrusted code in it.
- Hardening the image but leaving the runtime permissive (or vice versa).
- Forgetting the daemon surface: an exposed socket defeats every in-container
  control at once.
- Modelling only the internet-facing component and ignoring lateral movement to
  the database.
- Writing the model in a doc and never enforcing it in config.

## Related topics

- [The Docker socket is root](docker-socket-is-root.md)
- [Dropping capabilities](dropping-capabilities.md)
- [seccomp and AppArmor profiles](seccomp-and-apparmor-profiles.md)
- [Linux namespaces](../foundations/linux-namespaces.md)
- [Capabilities](../foundations/capabilities.md)
- [Network segmentation](../k8s-security/network-segmentation.md)
