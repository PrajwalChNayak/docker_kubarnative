---
title: Dropping capabilities
description: The Docker default capability set, what the dangerous capabilities enable, and how to drop all and add back the minimum.
level: advanced
type: concept
status: current
versions: Docker Engine 29
prerequisites:
  - foundations/capabilities
  - docker-security/container-threat-model
---

## Overview

Linux capabilities split the powers of root into distinct units, so a process
can hold "bind to a low port" without holding "load kernel modules". Docker
grants each container a fixed default subset and drops the rest. Real hardening
goes further: drop *all* capabilities, then add back only the few a workload
proves it needs. This page covers the default set, the dangerous capabilities,
and how to verify what a container actually holds.

## Why it exists and when to use it

Historically root was all-or-nothing: UID 0 could do everything, UID non-zero
almost nothing. Capabilities were added so a program that needs exactly one
root power does not need all of them. For containers this is the difference
between "compromising the process gives the attacker `CAP_SYS_ADMIN`" and
"gives them nothing". Drop capabilities on every container; it is nearly free
and closes the capability-abuse escape class.

## How it works underneath

Every process has capability sets in `/proc/<pid>/status`: `CapInh`, `CapPrm`,
`CapEff`, `CapBnd` and `CapAmb`, each a 64-bit mask. The bounding set (`CapBnd`)
is the ceiling: a capability not in it can never be acquired, even by a setuid
binary. `--cap-drop` removes bits from the bounding (and other) sets; `--cap-add`
adds them back.

Docker does not run containers with full root capabilities. Out of the ~40
capabilities the kernel defines, the daemon grants a small **default set**
(currently fourteen), including:

| Capability | Grants |
|---|---|
| `CHOWN`, `FOWNER`, `FSETID`, `DAC_OVERRIDE` | change ownership/permissions, bypass file permission checks |
| `SETUID`, `SETGID`, `SETPCAP` | change process UID/GID and capabilities |
| `NET_BIND_SERVICE` | bind to ports below 1024 |
| `NET_RAW` | craft raw/packet sockets (ping, and ARP/DNS spoofing) |
| `KILL` | send signals across UIDs |
| `MKNOD` | create device nodes |
| `SYS_CHROOT` | call `chroot` |
| `SETFCAP` | set file capabilities |
| `AUDIT_WRITE` | write audit log records |

Everything else — `SYS_ADMIN`, `SYS_PTRACE`, `NET_ADMIN`, `SYS_MODULE`,
`DAC_READ_SEARCH`, `SYS_TIME`, and the rest — is dropped by default. Those are
the dangerous ones you must never add without a specific, understood reason.

### The dangerous capabilities

| Capability | Why it is dangerous |
|---|---|
| `SYS_ADMIN` | a grab-bag: mount filesystems, manipulate namespaces, often a direct escape primitive |
| `SYS_PTRACE` | attach to and read the memory of other processes |
| `SYS_MODULE` | load kernel modules — arbitrary kernel code |
| `NET_ADMIN` | reconfigure interfaces, routing, firewall rules |
| `DAC_READ_SEARCH` | bypass file read/search permission checks (linked to CVE-2014-9357-style host reads) |
| `SYS_TIME` | change the host clock (shared kernel time namespace by default) |
| `NET_RAW` | in the *default* set, but enables spoofing; drop it if the app does not need raw sockets |

## Basic example

The Tasklane API needs none of these — it is a Go HTTP server that binds to
:8080 (above 1024) and opens a TCP connection to Postgres. Drop everything:

```bash
docker run --rm --cap-drop ALL tasklane-api:0.1.0
```

Inspect what a default container holds versus one with all capabilities dropped:

```bash
docker run --rm alpine:3.22 grep Cap /proc/1/status
docker run --rm --cap-drop ALL alpine:3.22 grep Cap /proc/1/status
```

```console include="captures/docker-security/proc-caps-default.txt"
```

```console include="captures/docker-security/proc-caps-dropped.txt"
```

With `--cap-drop ALL`, `CapEff` and `CapBnd` read `0000000000000000`.

## Explanation

Dropping a capability makes the corresponding operation fail with `EPERM` even
for UID 0 inside the container. Demonstrate it: `chown` needs `CAP_CHOWN`, so a
capability-less container cannot change file ownership:

```bash
docker run --rm --cap-drop ALL alpine:3.22 chown nobody /etc/hostname
```

```console include="captures/docker-security/cap-drop-eperm.txt"
```

The command exits non-zero with "Operation not permitted". That is the control
working: the attacker who lands in this container inherits an empty capability
set and a shrunken bounding set, so setuid tricks cannot regain the powers.

## Common patterns

- **Drop all, add the minimum.** `--cap-drop ALL` then, only if needed,
  `--cap-add NET_BIND_SERVICE` for a process that must bind port 80/443. Most
  well-written services need nothing added.
- **Move off privileged ports instead of adding a capability.** Bind the
  container to 8080 and publish it as 80 on the host; then you do not need
  `NET_BIND_SERVICE` at all. Tasklane does this.
- **Compose anchors.** The `examples/compose` stack applies `cap_drop: [ALL]`
  through the `x-app-security` YAML anchor so every service inherits it.
- **Kubernetes equivalent.** `securityContext.capabilities.drop: ["ALL"]`, added
  back per container with `capabilities.add`. See
  [security context](../k8s-security/security-context.md).

## Production considerations

Audit `--cap-add` and `--privileged` across your fleet; a single added
`SYS_ADMIN` can undo the rest of your hardening. `--privileged` is not "add all
capabilities" — it also disables seccomp and AppArmor and allows device access,
so it is strictly worse than `--cap-add ALL`. Never use it for application
workloads.

When a workload genuinely needs a capability (a VPN sidecar wanting
`NET_ADMIN`, a profiler wanting `SYS_PTRACE`), isolate that workload and
document the grant. Prefer a design that avoids the capability entirely.

## Security considerations

`NET_RAW` is in the default set and enables ARP and DNS spoofing against
neighbours on the same network. Many hardening baselines drop it explicitly. If
Tasklane does not send raw packets — it does not — dropping all capabilities
removes `NET_RAW` for free.

Capabilities are only one layer. A container with no capabilities can still be
escaped through a kernel bug in a reachable syscall; that is what seccomp is
for. Combine capability dropping with seccomp, no-new-privileges and a
read-only rootfs.

## Troubleshooting

- **App fails with `EPERM` or "Operation not permitted" after dropping caps.**
  Identify the operation and the capability it needs (`ping` → `NET_RAW`, bind
  <1024 → `NET_BIND_SERVICE`, `chown` → `CHOWN`) and add just that one back —
  or redesign to avoid it.
- **`setcap`/setuid binary stopped working.** A dropped capability is gone from
  the bounding set, so file capabilities and setuid can no longer grant it. This
  is intended; it is also why no-new-privileges pairs well here.
- **Decoding `CapEff`.** The hex mask can be expanded with `capsh --decode=<hex>`
  on a host that has libcap.

## Common mistakes

- Using `--privileged` when the goal was "add one capability".
- Adding `SYS_ADMIN` to fix a mount error instead of mounting differently.
- Leaving the default set in place and assuming it is minimal — it still
  includes `NET_RAW`, `MKNOD` and `SYS_CHROOT`.
- Adding capabilities back at the image level so every deployment inherits them.

## Related topics

- [Capabilities](../foundations/capabilities.md)
- [no-new-privileges](no-new-privileges.md)
- [seccomp and AppArmor profiles](seccomp-and-apparmor-profiles.md)
- [The container threat model](container-threat-model.md)
- [Security context](../k8s-security/security-context.md)
