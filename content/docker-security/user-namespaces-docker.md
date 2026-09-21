---
title: User namespaces in Docker
description: Map container root to an unprivileged host UID with userns-remap or rootless Docker, so root in the container is nobody on the host.
level: expert
type: concept
status: current
versions: Docker Engine 29
prerequisites:
  - foundations/linux-namespaces
  - docker-security/docker-socket-is-root
---

## Overview

By default, root inside a container is root on the host: UID 0 in the container
is UID 0 in the host kernel, so a container escape lands as real root. User
namespaces break that identity by *mapping* container UIDs to a different,
unprivileged range of host UIDs. Docker offers two ways to use them:
`userns-remap` (a daemon-wide remap) and **rootless Docker** (the whole daemon
runs unprivileged). This page explains both and their trade-offs.

## Why it exists and when to use it

The single scariest property of default containers is that root-in-container ==
root-on-host. User namespaces remove it: with remapping, an attacker who becomes
root inside the container and then escapes finds themselves as an unprivileged
host UID that owns nothing. It is the difference between "escape to root" and
"escape to nobody".

Use `userns-remap` or rootless Docker when you run workloads you do not fully
trust, on multi-tenant hosts, or wherever you want defence against the escape
classes that in-container hardening cannot fully close.

## How it works underneath

A user namespace holds a UID/GID mapping: a range of IDs inside the namespace
maps to a different range outside. Container UID 0 can map to host UID 100000,
UID 1 to 100001, and so on. Inside, the process believes it is root and can do
root-y things *within the namespace*; outside, the kernel sees an unprivileged
UID with no power over host files or processes it does not own.

Docker draws the subordinate ranges from `/etc/subuid` and `/etc/subgid`, which
must grant at least 65,536 subordinate IDs to the remap user.

### userns-remap

Enabled with the daemon option `"userns-remap": "default"` (or a specific user)
in `/etc/docker/daemon.json`. The daemon still runs as root, but every container
gets a user namespace so container root maps to a high, unprivileged host UID.
Notes and limits:

- It does not apply to daemons using the containerd image store in every case,
  and it changes image/volume ownership, so it needs its own image store and can
  complicate sharing volumes with non-remapped containers.
- Some features are incompatible with it (certain `--privileged` uses, sharing
  namespaces with the host).

### Rootless Docker

The entire daemon runs as a non-root user inside its own user namespace, so
there is no root daemon to abuse at all. This is the stronger option: even a
socket compromise cannot yield host root, because the daemon itself has none.
From the handbook baseline:

- It needs `newuidmap`/`newgidmap` (the `uidmap` package) and at least 65,536
  subordinate IDs in `/etc/subuid` and `/etc/subgid`.
- Resource limits (`--cpus`, `--memory`, `--pids-limit`) work only with cgroup
  v2 plus systemd, via a systemd user unit and `loginctl enable-linger`.
- Since Engine 29.5.0 the default rootless network driver is
  `gvisor-tap-vsock`; `pasta` is used when slirp4netns is absent.

## Basic example

Inspect the UID mapping a container sees. On a default daemon (no remap) the map
is the identity mapping — container UID 0 is host UID 0:

```bash
docker run --rm alpine:3.22 cat /proc/self/uid_map
```

```console include="captures/docker-security/uid-map-default.txt"
```

The three columns are: first ID inside the namespace, first ID outside, and
count. A default daemon prints `0 0 4294967295` (identity). With `userns-remap`
or rootless Docker the middle column is a high host UID such as `100000`, which
is the whole point: container 0 is host 100000, not host 0.

To enable the remap, add to `/etc/docker/daemon.json` and restart the daemon:

```json title="/etc/docker/daemon.json"
{
  "userns-remap": "default"
}
```

## Explanation

Under the identity mapping, an escape that reaches the host does so as root.
Under a remap, the same escape reaches the host as UID 100000, which owns no
host files, cannot signal host processes, and holds no host capabilities. The
in-container experience is unchanged — the process still sees itself as root —
so most images run without modification.

Rootless goes one step further by removing the root daemon entirely, which also
closes the "socket == host root" problem covered on the
[socket page](docker-socket-is-root.md): there is no root to escalate to.

## Common patterns

- **Rootless for untrusted or multi-tenant workloads.** It is the strongest
  posture and the recommended default for CI runners and shared build hosts.
- **`userns-remap` for a shared root daemon.** When you must keep a system
  daemon but want to remove root-in-container == root-on-host.
- **Kubernetes user namespaces.** The equivalent is pod `hostUsers: false`
  (`UserNamespacesSupport` is GA in Kubernetes 1.36). See
  [user namespaces](../k8s-security/user-namespaces.md).

## Production considerations

`userns-remap` changes file ownership semantics: images are re-owned into the
subordinate range, and volumes written by a remapped container are owned by high
UIDs on the host. Plan volume sharing and backups around this. It also disables
or complicates a handful of features, so test the full workload before rolling
it out.

Rootless Docker's constraints are real: resource limits require cgroup v2 +
systemd, some storage drivers and network modes differ, and privileged ports
need extra configuration. For first-party stateless services these are minor;
for complex stateful stacks, validate carefully.

## Security considerations

User namespaces are a strong mitigation but not a complete sandbox. A kernel bug
in the user-namespace machinery itself, or in a syscall reachable inside the
namespace, can still be exploited; keep the host kernel and `runc`/containerd
patched. User namespaces have historically expanded the reachable kernel surface
for unprivileged users, so pair them with a seccomp profile and dropped
capabilities rather than treating them as a substitute.

Neither remapping nor rootless protects a container that was *given* host access
(a host bind mount, the socket, `--privileged` where still permitted). Remove
those first; user namespaces harden what remains.

## Troubleshooting

- **"no space left" or permission errors after enabling remap.** Usually
  `/etc/subuid`/`/etc/subgid` lack the required 65,536-ID range for the remap
  user. Add the range and restart the daemon.
- **A volume is unreadable by a remapped container.** Its files are owned by
  host UIDs outside the subordinate range. Re-own them into the range or use a
  named volume created under the remap.
- **Rootless resource limits ignored.** They need cgroup v2 with systemd and
  `loginctl enable-linger`; without that, `--memory`/`--cpus` are silently
  ineffective.
- **Checking the mapping.** `cat /proc/self/uid_map` inside a container, or
  `docker info` (rootless daemons report `rootless` under security options).

## Common mistakes

- Believing default containers isolate UIDs — they do not; container root is
  host root without remapping.
- Enabling `userns-remap` and being surprised that volume ownership changed.
- Treating rootless or remap as a full sandbox and dropping seccomp/capabilities.
- Leaving a host bind mount or the socket in place, which user namespaces do not
  neutralise.

## Related topics

- [Linux namespaces](../foundations/linux-namespaces.md)
- [The Docker socket is root](docker-socket-is-root.md)
- [Rootless Docker](../docker-advanced/rootless-docker.md)
- [User namespaces (Kubernetes)](../k8s-security/user-namespaces.md)
- [Dropping capabilities](dropping-capabilities.md)
