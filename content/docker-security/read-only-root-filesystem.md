---
title: Read-only root filesystem and tmpfs
description: Make the container filesystem immutable, then grant back only the writable paths the workload truly needs on a locked-down tmpfs.
level: advanced
type: concept
status: current
versions: Docker Engine 29
prerequisites:
  - docker-security/container-threat-model
  - docker-intermediate/volumes-bind-mounts-tmpfs
---

## Overview

A read-only root filesystem stops a compromised process from writing to the
container: no dropping tools, no overwriting binaries or config, no persisting a
foothold on disk. Most services need to write in only one or two places, so the
pattern is to mount the whole rootfs read-only and grant those paths back as
small, hardened tmpfs mounts. This page covers `--read-only`, `--tmpfs`, and how
to find the paths a workload actually needs.

## Why it exists and when to use it

Attackers who land in a container want to write: fetch a second-stage payload,
replace a binary with a trojaned one, drop a cron entry, or edit config to
persist. An immutable rootfs removes that whole toolkit. It also catches bugs:
an app that writes where it should not fails loudly in testing instead of
silently accumulating state that vanishes on restart.

Use it for essentially every application container. The cost is enumerating the
writable paths once; the benefit is a much smaller runtime attack surface.

## How it works underneath

Normally a container's writable layer sits on top of the image's read-only
layers via the storage driver (overlayfs). `--read-only` mounts that top layer
read-only, so every write to the container filesystem returns `EROFS`
("Read-only file system").

The process still needs *some* writable space — a temp directory, a PID file, a
cache. You provide it explicitly:

- **`--tmpfs <path>`** mounts an in-memory tmpfs at that path. It is writable,
  never touches disk, and vanishes when the container stops. Harden it with
  `noexec` (no running binaries from it), `nosuid` (ignore setuid bits) and a
  `size` cap.
- **A named volume or bind mount** for data that must persist (a database's data
  directory) — that path is writable independently of the read-only rootfs.

The key property: writable paths are now an explicit allow-list, not the whole
filesystem.

## Basic example

Run the Tasklane API read-only, granting `/tmp` back as a capped, non-exec
tmpfs:

```bash
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m tasklane-api:0.1.0
```

Show that the rootfs is genuinely immutable, and that the tmpfs is not:

```bash
docker run --rm --read-only alpine:3.22 sh -c 'echo x > /root/x'
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m alpine:3.22 sh -c 'echo ok > /tmp/ok && cat /tmp/ok'
```

```console include="captures/docker-security/read-only-write-fail.txt"
```

```console include="captures/docker-security/read-only-tmpfs-ok.txt"
```

## Explanation

The first command fails with `sh: can't create /root/x: Read-only file system`
and a non-zero exit. The second writes and reads back `ok`, because `/tmp` is a
separate writable mount. That is the whole model: default-deny writes, then
allow the minimum.

In Compose the same is expressed with `read_only: true` plus a `tmpfs:` list.
The `examples/compose` stack applies `read_only: true` to every app service
through the `x-app-security` anchor, and the hardened example adds the tmpfs:

```yaml include="examples/security/docker/hardened-run/compose.yaml" lines="10-16"
```

## Common patterns

- **Read-only rootfs + one tmpfs.** The common case: a stateless service that
  only needs a scratch `/tmp`. Cap the size so a bug cannot exhaust host memory.
- **Read-only rootfs + persistent volume.** A datastore mounts its data
  directory as a volume (writable) while the rest of the rootfs stays immutable.
  Postgres in Tasklane keeps `/var/lib/postgresql` on a named volume.
- **Framework scratch paths.** Some runtimes insist on writing to `/run`, a
  cache dir, or a config dir. Grant each as its own small tmpfs rather than
  reverting the whole rootfs to writable.
- **Kubernetes equivalent.** `securityContext.readOnlyRootFilesystem: true`
  plus `emptyDir` volumes (optionally `medium: Memory`) for the writable paths.

## Production considerations

Enumerate writable paths during testing, not in production. Run the container
read-only in CI and let it fail; each failure names a path the app wants. Grant
the smallest set. This turns "the app writes somewhere, we are not sure where"
into an explicit, reviewable list.

Size every tmpfs. An uncapped tmpfs is host memory an attacker (or a logging
bug) can fill. `noexec` and `nosuid` should be the default for every scratch
mount; a payload written to a `noexec` tmpfs cannot be executed from there.

Distroless images help: with no shell and no package manager, there is little to
write *to* even before you make the rootfs read-only, and little to run if a
payload is written.

## Security considerations

Read-only rootfs does not protect writable mounts: a bind-mounted host directory
or a shared volume is still writable and still a target, so scope and permission
those carefully. It also does not stop in-memory-only attacks — a process can
still be exploited and run entirely in RAM — which is why you pair it with
capability dropping and seccomp to limit what that in-memory code can do.

`noexec` on the tmpfs is a meaningful hurdle but not absolute: an attacker with
the ability to `memfd_create` and execute can bypass a `noexec` mount. seccomp
and a minimal capability set raise that bar further.

## Troubleshooting

- **App crashes with `EROFS` / "Read-only file system".** Find the path it
  tried to write and add a `--tmpfs`/volume for exactly that path. Common
  culprits: `/tmp`, `/run`, a framework cache, a lock or PID file.
- **Logs disappeared after enabling read-only.** The app was logging to a file
  on the rootfs. Log to stdout/stderr instead (the twelve-factor default), or
  mount the log directory as a volume.
- **tmpfs "no space left on device".** The `size=` cap is too small for the
  workload's scratch usage; raise it deliberately rather than removing the cap.
- **Uploads or generated files vanish on restart.** They were on a tmpfs. If
  they must persist, use a volume, not a tmpfs.

## Common mistakes

- Reverting the whole rootfs to writable because one path failed, instead of
  granting that one path.
- Mounting tmpfs without `noexec`, `nosuid` or a size limit.
- Assuming read-only protects data on bind mounts and volumes (it does not).
- Writing logs and PID files to the rootfs and being surprised when they fail.

## Related topics

- [Volumes, bind mounts and tmpfs](../docker-intermediate/volumes-bind-mounts-tmpfs.md)
- [Dropping capabilities](dropping-capabilities.md)
- [no-new-privileges](no-new-privileges.md)
- [Choosing base images](../docker-intermediate/choosing-base-images.md)
- [Security context](../k8s-security/security-context.md)
