---
title: seccomp and AppArmor profiles
description: The kernel syscall filter and the LSM profile Docker applies by default, when to customise them, and why unconfined is dangerous.
level: advanced
type: concept
status: current
versions: Docker Engine 29
prerequisites:
  - foundations/seccomp
  - foundations/apparmor-and-selinux
  - docker-security/dropping-capabilities
---

## Overview

Two of Docker's default defences filter what a container can ask the kernel to
do. **seccomp** restricts the set of system calls the process may make at all.
**AppArmor** (on Debian/Ubuntu) or **SELinux** (on RHEL) adds mandatory access
control on top, constraining file, capability and network operations regardless
of Unix permissions. Both are on by default with sane profiles. This page
explains those defaults, when a custom profile is worth the effort, and why
turning them off is rarely acceptable.

## Why it exists and when to use it

Dropping capabilities limits which *privileged* operations a container can
perform, but many kernel exploits live in ordinary syscalls that need no
capability. seccomp shrinks the reachable syscall surface directly, which is the
single most effective mitigation against unknown kernel bugs. AppArmor/SELinux
add a second, independent policy layer so that even a syscall that is allowed is
constrained in what it may touch.

Keep the defaults on everywhere. Reach for a custom seccomp profile when you
want to tighten further for a known-narrow workload, and reach for `unconfined`
essentially never.

## How it works underneath

### seccomp

seccomp (secure computing mode) installs a BPF filter that the kernel checks on
every syscall. Docker ships a **default seccomp profile** that, in the words of
the Docker documentation, "disables around 44 system calls out of 300+". It is
an allow-list with targeted denials: it blocks calls that are dangerous and
rarely needed in containers — for example `keyctl`, `add_key`, `request_key`
(kernel keyring), `mount`/`umount2` (filesystem mounting), `reboot`,
`swapon`/`swapoff`, `kexec_load`, and clock setters like `clock_settime`.

The profile is applied unless you override it. `--security-opt seccomp=unconfined`
removes it entirely; `--security-opt seccomp=/path/profile.json` supplies your
own. Many blocked syscalls also require a capability the default set lacks, so
seccomp and capability dropping reinforce each other.

### AppArmor and SELinux

On Debian/Ubuntu hosts, Docker loads a default AppArmor profile called
`docker-default` and applies it to each container. It denies writes to sensitive
`/proc` and `/sys` paths, restricts mounting, and blocks a range of
capability-backed operations. You can supply a custom profile with
`--security-opt apparmor=<profile>`. Engine 29.8.0 added configuration of the
default-profile template.

On RHEL/Fedora hosts, **SELinux** provides the equivalent using type
enforcement (containers run under the `container_t` type) and Multi-Category
Security to isolate containers from each other and from host files. Enable it
with `--security-opt label=...` options and the daemon's `selinux-enabled`
setting. AppArmor and SELinux are alternatives; a given host runs one.

## Basic example

Ask the daemon which of these are active:

```bash
docker info --format '{{.SecurityOptions}}'
```

```console include="captures/docker-security/security-options.txt"
```

The output lists the enabled options — typically `seccomp` (with
`profile=builtin` or `default`), and `apparmor` or `selinux` depending on the
host. On rootless daemons it also lists `rootless`.

Run a container with an explicit, tightened profile instead of the default:

```bash
docker run --rm --security-opt seccomp=my-profile.json tasklane-api:0.1.0
```

## Explanation

The default profiles are chosen to run almost every real workload unmodified
while blocking operations a container should never need. Because they are on by
default, most teams get this protection without thinking about it — until
someone adds `--privileged` (which disables both seccomp and AppArmor) or
`seccomp=unconfined` to "make an error go away", silently removing the
protection for that container.

A custom seccomp profile is worth writing when you know the exact syscalls a
workload uses and want to deny everything else. Tools can record a workload's
syscalls (for example with `strace` or an eBPF tracer) to seed the allow-list.
For a small static Go binary like Tasklane, the used set is narrow, so a
tightened profile is feasible.

## Common patterns

- **Keep defaults, forbid disabling them.** Enforce that no application
  container runs `--privileged`, `seccomp=unconfined` or `apparmor=unconfined`.
  In Kubernetes this is `seccompProfile.type: RuntimeDefault` on every pod,
  which the Tasklane manifests set.
- **Tighten for narrow workloads.** Ship a custom seccomp profile that allow-
  lists only the syscalls a specific service makes.
- **Record then restrict.** Trace a workload under load to build the syscall
  set, then generate a profile from it and test in staging.
- **SELinux on RHEL.** Leave SELinux in enforcing mode; do not "fix" a denial by
  disabling it — write or adjust the policy, or relabel the volume.

## Production considerations

`RuntimeDefault` seccomp is not always on by default in Kubernetes the way it is
in Docker — set `seccompProfile.type: RuntimeDefault` explicitly, or enforce it
with Pod Security Admission / policy. A pod with no seccomp profile runs
`Unconfined`, which is the loose setting, not the Docker default.

Custom profiles are a maintenance commitment: a dependency upgrade can introduce
a new syscall and break a too-tight profile at runtime. Test profile changes
under realistic load, and prefer the well-tested default unless you have a
concrete reason and the capacity to maintain a custom one.

## Security considerations

`--privileged` disables seccomp *and* AppArmor/SELinux at once and grants all
capabilities and device access; it is the single most damaging runtime flag and
must never be used for application workloads. `seccomp=unconfined` alone re-opens
the full ~300-syscall surface, dramatically enlarging kernel-exploit exposure.

seccomp filters syscalls but does not understand their arguments beyond simple
matching, and profiles must be maintained as kernels and libraries evolve.
AppArmor/SELinux add an independent layer precisely so that a gap in one is
backed by the other. Defence in depth means running both, plus capability
dropping.

## Troubleshooting

- **A syscall fails with `EPERM` / "Operation not permitted" and no capability
  fits.** The default seccomp profile likely blocks it. Confirm by running
  temporarily with `seccomp=unconfined` *in a lab only*; if it then works, add
  just that syscall to a custom profile rather than shipping unconfined.
- **AppArmor "permission denied" on `/proc` or `/sys` writes.** The
  `docker-default` profile blocks these; write elsewhere or, if truly needed,
  craft a scoped custom profile.
- **SELinux `avc: denied` in the host audit log.** Relabel the volume (`:z`/`:Z`
  mount option) or extend the policy; do not set SELinux permissive.
- **Which profile is active?** `docker inspect` shows the applied
  `SecurityOpt`, and `docker info` shows what the daemon supports.

## Common mistakes

- Using `--privileged` and losing seccomp and AppArmor along with it.
- Setting `seccomp=unconfined` to silence an error instead of adding the one
  syscall to a custom profile.
- Assuming Kubernetes applies the Docker default seccomp profile — it does not
  unless you set `RuntimeDefault`.
- Disabling SELinux instead of relabelling a volume or fixing the policy.

## Related topics

- [seccomp](../foundations/seccomp.md)
- [AppArmor and SELinux](../foundations/apparmor-and-selinux.md)
- [Dropping capabilities](dropping-capabilities.md)
- [The container threat model](container-threat-model.md)
- [Security context](../k8s-security/security-context.md)
