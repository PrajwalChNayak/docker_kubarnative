---
title: no-new-privileges
description: Stop a process from ever gaining more privileges than it started with, defeating setuid escalation inside containers.
level: advanced
type: concept
status: current
versions: Docker Engine 29
prerequisites:
  - docker-security/dropping-capabilities
  - foundations/capabilities
---

## Overview

`no-new-privileges` sets the kernel flag `PR_SET_NO_NEW_PRIVS` on the container
process. Once set, no child can ever acquire more privileges than its parent —
setuid binaries, setgid binaries and file capabilities stop granting anything
extra. It is a one-line flag that closes the "escalate via a setuid binary"
path, and it pairs naturally with dropping capabilities. This page shows what it
does and how to verify it.

## Why it exists and when to use it

Even a non-root container often ships setuid-root binaries (`su`, `sudo`,
`mount`, `ping` on some images, `passwd`). If an attacker gets code execution as
an unprivileged user, a setuid-root binary is a ready-made way back up to root
*inside the container*, which then makes capability abuse and further escapes
possible. `no-new-privileges` neutralises the whole class in one flag.

Set it on every application container. There is essentially no downside for a
well-formed service, because a service that needs to gain privileges at runtime
is already an anti-pattern.

## How it works underneath

`PR_SET_NO_NEW_PRIVS` is a per-process, one-way kernel flag added in Linux 3.5.
When set, `execve()` will not honour setuid/setgid bits or file capabilities to
raise the process's privileges: the new program runs with the caller's
privileges, not the file's. The flag is inherited by all children and can never
be unset, so there is no way back.

Docker exposes it as `--security-opt no-new-privileges:true` (or
`no-new-privileges=true`). In Compose it is a `security_opt` entry. It is *not*
on by default, because some legacy images rely on setuid tools.

The flag shows up in `/proc/<pid>/status` as `NoNewPrivs: 1`. That single line
is your verification.

## Basic example

Run the Tasklane API with the flag, and inspect the process flag directly:

```bash
docker run --rm --security-opt no-new-privileges:true tasklane-api:0.1.0
```

Compare the flag with and without the option:

```bash
docker run --rm alpine:3.22 grep NoNewPrivs /proc/1/status
docker run --rm --security-opt no-new-privileges:true alpine:3.22 grep NoNewPrivs /proc/1/status
```

```console include="captures/docker-security/no-new-priv-off.txt"
```

```console include="captures/docker-security/no-new-priv-on.txt"
```

The default container reports `NoNewPrivs: 0`; with the flag it reports
`NoNewPrivs: 1`.

## Explanation

With `NoNewPrivs: 1`, a setuid-root binary invoked by the compromised
unprivileged process runs as that unprivileged process, not as root. The
escalation simply does not happen — `execve` refuses to apply the setuid bit.
The attacker is stuck at the privilege level they landed on.

This is why the flag complements capability dropping. Dropping capabilities
shrinks what root-in-the-container can do; no-new-privileges stops a non-root
attacker from *becoming* root-in-the-container in the first place. Together they
mean "compromise as UID 65532" stays "UID 65532 with no capabilities".

## Common patterns

- **Always-on for app containers.** Add it to your standard runtime template.
  The `examples/compose` stack applies `security_opt: ["no-new-privileges:true"]`
  through the `x-app-security` anchor.
- **Pair with a non-root image and dropped capabilities.** The three together
  are the baseline: run as non-root, drop all capabilities, set
  no-new-privileges.
- **Strip setuid bits at build time as well.** Belt and braces: a distroless or
  scratch image with no setuid binaries has nothing to escalate through even if
  the flag were missing.
- **Kubernetes equivalent.** `securityContext.allowPrivilegeEscalation: false`
  sets the same `PR_SET_NO_NEW_PRIVS` flag. The Tasklane manifests set it on
  every container.

## Production considerations

The flag is free for modern, well-behaved services. The rare workloads that
break are those that legitimately shell out to a setuid helper — some VPN
clients, certain package operations, or images that call `sudo` in an entrypoint.
Fix the image (run as the right user from the start, or use file capabilities
carefully) rather than dropping the flag fleet-wide.

Because the setting is per-container and cheap, enforce it centrally: a Compose
anchor, a `docker run` wrapper in CI, or admission policy in Kubernetes. A
container missing it is the exception that needs justifying.

## Security considerations

`no-new-privileges` does not remove capabilities the container already has; it
only prevents *gaining* more. A container started with added capabilities still
has them. Use it alongside `--cap-drop ALL`, not instead of it.

It also does not sandbox syscalls — a process can still make any syscall its
seccomp profile allows — nor does it make the rootfs immutable. It is one layer:
it closes setuid/file-capability escalation specifically.

## Troubleshooting

- **`sudo`/`su` fails after enabling the flag.** That is the flag working. The
  binary can no longer elevate. Redesign the container to run as the correct
  user from the start; do not remove the flag.
- **A helper that used file capabilities stopped working.** File capabilities no
  longer raise privileges under this flag. Grant the capability to the container
  process itself via `--cap-add` (scoped) instead of relying on a setcap binary.
- **Verifying it is on.** `grep NoNewPrivs /proc/1/status` inside the container,
  or check `docker inspect` for the `no-new-privileges` security option.

## Common mistakes

- Assuming it drops capabilities — it does not; combine with `--cap-drop ALL`.
- Dropping the flag to make a `sudo`-based entrypoint work, instead of fixing
  the entrypoint.
- Forgetting the Kubernetes name is `allowPrivilegeEscalation: false`, not a
  `no-new-privileges` field.
- Setting it but still shipping setuid binaries and a shell in the image.

## Related topics

- [Dropping capabilities](dropping-capabilities.md)
- [Read-only root filesystem and tmpfs](read-only-root-filesystem.md)
- [Running as non-root](../docker-intermediate/running-as-non-root.md)
- [Capabilities](../foundations/capabilities.md)
- [Security context](../k8s-security/security-context.md)
