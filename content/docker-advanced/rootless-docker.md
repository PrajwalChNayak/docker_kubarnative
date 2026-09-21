---
title: Rootless Docker
description: Run the daemon and containers as an unprivileged user with user namespaces, and know exactly which features you give up.
level: advanced
type: concept
status: current
versions: Docker Engine 29, Buildx 0.37
prerequisites:
  - foundations/linux-namespaces
  - docker-advanced/daemon-configuration
---

## Overview

The Docker daemon normally runs as root, and membership of the `docker` group
is equivalent to root on the host. Rootless mode removes that: the daemon,
containerd, runc and every container run as an ordinary user, inside a user
namespace where that user is mapped to UID 0.

It is a genuine mitigation, not a cosmetic one — a container escape lands you
as an unprivileged user rather than as root. It also costs features, and the
honest way to teach it is to be specific about which.

## Why it exists and when to use it

The threat is concrete: a container breakout, a malicious image running a
build step, or a careless `-v /:/host` reaches root on the host. With
rootless mode, the same breakout reaches an unprivileged user who owns only
their own files.

Rootless fits well on shared build machines, developer laptops, CI runners
where jobs run arbitrary Dockerfiles, and multi-user servers. It fits badly
where you need host networking, low ports without configuration, or exotic
storage — see the limitations below.

The alternative on the same axis is `userns-remap`, where the daemon stays
root but containers get a user namespace. That protects the container
boundary but not the daemon; rootless protects both.

## How it works underneath

Rootless mode composes three mechanisms.

**User namespaces.** The daemon runs inside a user namespace created by
RootlessKit. Inside it, your user appears as UID 0; outside, everything is
owned by your real UID and by the subordinate IDs allocated to you. The
Docker documentation requires `newuidmap`/`newgidmap` from the `uidmap`
package, and **at least 65,536** subordinate UIDs and GIDs in `/etc/subuid`
and `/etc/subgid`.

**Network namespace with a userspace stack.** An unprivileged process cannot
create a veth pair into the host network, so the container network is
attached through a userspace network stack. Since **29.5.0**, rootless Docker
uses **`gvisor-tap-vsock` by default**, and slirp4netns is no longer
installed by Docker packaging; pasta is used when slirp4netns is absent.
Select a driver with `DOCKERD_ROOTLESS_ROOTLESSKIT_NET`, and the
port-forwarding driver with `DOCKERD_ROOTLESS_ROOTLESSKIT_PORT_DRIVER` — the
latter decides whether containers see the real client source IP.

**A user systemd service.** The daemon is a user unit, not a system one. The
documentation is explicit that a system-wide unit is not supported, and that
you need `loginctl enable-linger` so the service survives logout.

The socket is `$XDG_RUNTIME_DIR/docker.sock`, typically
`/run/user/1000/docker.sock`, and the CLI reaches it through the `rootless`
context or `DOCKER_HOST`.

## Basic example

```bash
dockerd-rootless-setuptool.sh install
systemctl --user enable --now docker
sudo loginctl enable-linger "$(whoami)"

export DOCKER_HOST=unix:///run/user/1000/docker.sock
docker context use rootless
docker info
```

```console include="captures/docker-advanced/info-logging.txt"
```

## Explanation

`dockerd-rootless-setuptool.sh install` checks the prerequisites, writes
`~/.config/systemd/user/docker.service`, and creates a CLI context named
`rootless`. Prerequisite failures at this point are almost always missing
`uidmap` or empty `/etc/subuid`.

`loginctl enable-linger` is what stops the daemon dying when your SSH session
ends. On a build server, forgetting it produces the confusing symptom of a
daemon that works interactively and vanishes from cron.

`docker context use rootless` is preferable to exporting `DOCKER_HOST`
everywhere, because buildx builders are per context and a mismatch is hard to
see. See [Docker contexts](docker-contexts.md).

## Limitations, concretely

| Limitation | Detail | Workaround |
|---|---|---|
| Privileged ports | Binding below 1024 fails | `net.ipv4.ip_unprivileged_port_start=0`, or `CAP_NET_BIND_SERVICE` on rootlesskit |
| Resource limits | `--cpus`, `--memory`, `--pids-limit` need **cgroup v2 + systemd** | Delegate controllers (below) |
| Networking | Userspace stack; throughput differs from a kernel veth path | `gvisor-tap-vsock` default since 29.5.0; measure before assuming |
| Source IP | The port driver may rewrite the client address | Choose the port driver deliberately |
| Storage drivers | Not every driver works unprivileged | Check `docker info` on your kernel |
| Host networking, some devices | Not available in the usual sense | Redesign, or use rootful for that workload |
| AppArmor | Profiles interact differently | Test your profiles under rootless |

Delegating cgroup controllers is a one-time host change:

```ini title="/etc/systemd/system/user@.service.d/delegate.conf"
[Service]
Delegate=cpu cpuset io memory pids
```

`cpuset` delegation needs systemd 244 or newer. Without delegation, resource
flags are silently ineffective, which is the worst possible failure mode for
a limit.

## Common patterns

- **Rootless for builds, rootful for the shared runtime.** Build hosts run
  arbitrary Dockerfiles, which is exactly the untrusted workload rootless is
  for. A production node running your own images is a different risk.
- **One rootless daemon per user** on a shared machine, so users cannot see
  each other's containers.
- **Rootless plus a `docker-container` builder** keeps BuildKit inside the
  same unprivileged boundary.
- **Rootless Docker-in-Docker** for CI: the `docker:<version>-dind-rootless`
  image runs as UID 1000, though the documentation notes that `--privileged`
  is still required "for disabling seccomp, AppArmor, and mount masks". See
  [DinD vs socket mounting](dind-vs-socket-mounting.md).
- **BuildKit rootless directly** when you only need builds:
  `moby/buildkit:rootless` with `--security-opt seccomp=unconfined
  --security-opt apparmor=unconfined --security-opt systempaths=unconfined`.

## Production considerations

Data lives under `~/.local/share/docker` instead of `/var/lib/docker`. Home
directories on NFS are a common cause of failures, and disk quotas on `/home`
are a common cause of surprise. Plan storage for it.

Configuration is `~/.config/docker/daemon.json`, not `/etc/docker/daemon.json`.
Configuration management that writes the system file silently does nothing.

Performance: a userspace network stack behaves differently from the kernel
path, and the numbers depend heavily on the driver, the kernel and the
workload. Benchmark your own traffic rather than accepting a figure from a
blog post — including one written in the opposite direction.

Kubernetes has a parallel story. The `KubeletInUserNamespace` feature gate is
**Beta and on by default in 1.37**, but enabling the gate does not by itself
make the kubelet rootless: the user namespace has to be created outside
Kubernetes. Pod-level user namespaces (`hostUsers: false`) are a different
feature and went **GA in 1.36**. See
[user namespaces](../k8s-security/user-namespaces.md).

## Security considerations

- Rootless removes the "docker group equals root" escalation. That alone
  justifies it on multi-user machines. See
  [the Docker socket is root](../docker-security/docker-socket-is-root.md).
- It does **not** make containers safe to run untrusted code without further
  controls. Dropped capabilities, seccomp, read-only root filesystems and
  `no-new-privileges` all still apply.
- A container escape reaches your user account — which owns your SSH keys,
  your cloud credentials and your source tree. "Unprivileged" is not
  "harmless".
- Subordinate ID ranges must not overlap between users. An overlap breaks the
  isolation between two users' containers.
- `--privileged` still exists in rootless mode and still removes most of the
  container's confinement; it just cannot exceed your user's privileges.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `newuidmap: not found` | `uidmap` package missing | Install it, re-run the setup tool |
| Setup complains about subordinate IDs | Fewer than 65,536 in `/etc/subuid` or `/etc/subgid` | Extend both files, log out and back in |
| Daemon dies at logout | No lingering | `sudo loginctl enable-linger $(whoami)` |
| `--memory` has no effect | cgroup v2 controllers not delegated | `Delegate=` drop-in, then `systemctl daemon-reload` |
| Cannot publish port 80 | Privileged port | `net.ipv4.ip_unprivileged_port_start=0` |
| CLI talks to the rootful daemon | `DOCKER_HOST` or context not set | `docker context use rootless` |
| Containers see the gateway as the client IP | Port driver behaviour | Choose a port driver that preserves source IPs |

## Common mistakes

- Running the setup tool with `sudo`. It is meant to run as the unprivileged
  user; with `sudo` you get a rootless daemon for root, which is absurd.
- Editing `/etc/docker/daemon.json` and wondering why nothing changed.
- Expecting resource limits to work on cgroup v1 or without delegation.
- Assuming rootless implies no privileged containers.
- Benchmarking network throughput once, on one driver, and generalising.

## Related topics

- [Daemon configuration](daemon-configuration.md)
- [Resource limits](resource-limits.md)
- [DinD vs socket mounting](dind-vs-socket-mounting.md)
- [Docker contexts](docker-contexts.md)
- [Linux namespaces](../foundations/linux-namespaces.md)
- [The Docker socket is root](../docker-security/docker-socket-is-root.md)
- [User namespaces in Docker](../docker-security/user-namespaces-docker.md)
