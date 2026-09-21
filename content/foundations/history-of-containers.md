---
title: A history of containers
description: How chroot, jails, zones, cgroups, LXC, Docker, the OCI and Kubernetes got us to the stack you run today.
level: foundations
type: concept
status: current
versions: Linux kernel 6.x, Docker Engine 29, containerd 2.x, Kubernetes 1.37
prerequisites:
  - foundations/what-containers-solve
---

## Overview

Containers were not invented in 2013. Every mechanism Docker used already
existed; what did not exist was a packaging format and a workflow that made
them usable. Knowing the order things arrived explains a lot of today's
oddities: why images have layers, why `runc` is a separate binary, why
Kubernetes talks to containerd rather than to Docker, and why the word
"container" means slightly different things to different people.

Dates below are from primary sources: manual pages, kernel documentation,
project release records and the Kubernetes blog.

## Why it exists and when to use it

Read this page once, early. It is not reference material you will come back to,
but it converts a pile of unfamiliar names — runc, containerd, CRI, OCI, shim —
into a story with a direction. When a tutorial tells you to install something
that was replaced five years ago, this page is how you notice.

## How it works underneath

### Filesystem isolation: 1979 to 2000

`chroot()` "first appeared in Version 7 AT&T UNIX" (1979) and changed one
thing: the process's idea of `/`. It was never a security boundary — a
privileged process can escape a chroot — but it established the core idea that
a process's view of the filesystem is per-process state.

**FreeBSD jails** (jail(8), "first appeared in FreeBSD 4.0", March 2000,
written by Poul-Henning Kamp) took the next step: a jail isolated the
filesystem *and* the process table, users and network addresses, and was
explicitly designed as a security boundary. **Solaris Zones** (Solaris 10,
2005) went further still with resource controls and branded zones. Both were
complete container systems years before Linux had one — and both shipped as a
single vendor-integrated feature, which is exactly what Linux did not do.

### Linux builds the pieces separately: 2002 to 2013

Linux took the opposite path: independent kernel features, each merged on its
own schedule, with no product wrapped around them.

| Piece | Arrived in | Note |
|---|---|---|
| Mount namespaces | Linux 2.4.19 (2002) | the first `CLONE_NEW*` flag |
| UTS and IPC namespaces | Linux 2.6.19 (2006) | hostname, System V IPC |
| PID namespaces, first cgroups | Linux 2.6.24 (2008) | cgroups v1 shipped in this release |
| Network namespaces | completed over 2.6.24 to 2.6.29 | per-namespace network stack |
| User namespaces | usable from Linux 3.8 (2013) | unprivileged UID mapping |
| cgroup namespaces | Linux 4.6 (2016) | hides the cgroup path |
| cgroup v2 declared official | Linux 4.5 (2016) | unified hierarchy |
| Time namespaces | Linux 5.6 (2020) | boot and monotonic clock offsets |

cgroups themselves started at Google in 2006 as "process containers" (Paul
Menage and Rohit Seth), were renamed to avoid confusion with the word
"container", and merged for 2.6.24.

Userspace wrappers followed: Linux-VServer (2001) and OpenVZ (2005) used
out-of-tree patches, while **LXC** (2008) was the first widely used toolset
built on the mainline namespace and cgroup APIs. LXC gave you a container. It
did not give you a way to ship one.

### Docker makes it a workflow: 2013 to 2015

Docker was shown publicly in March 2013 and open-sourced the same month. Its
kernel work was not new; its three contributions were:

1. **The image format with layers**, so a build could be cached and a pull
   could reuse what the host already had.
2. **A registry and a naming scheme**, so "the artifact" became a thing you
   could push and pull rather than a directory you copied.
3. **A one-line UX** (`docker run`) over machinery that previously took a page
   of configuration.

Early Docker drove LXC. Docker 0.9 (2014) replaced that with its own
`libcontainer`, talking to the kernel directly. Meanwhile Google published its
own experience with a decade of cluster-scheduled containers, and in June 2014
announced Kubernetes.

### Standardisation: 2015 to 2017

Two things happened almost together.

- The **Open Container Initiative** was launched on 2015-06-22 by Docker,
  CoreOS and other container vendors. Docker donated
  `libcontainer` as **runc**, the reference implementation of the runtime
  spec. The **runtime spec and image spec both reached v1.0 on 2017-07-19**;
  the **distribution spec reached v1.0 on 2021-05-05**. Image spec and
  distribution spec v1.1 followed on 2024-02-15.
- **Kubernetes 1.0** shipped on 2015-07-21 and the project was donated to the
  newly formed CNCF.

Docker split its engine along the way: **containerd** was extracted as the
component that manages images, snapshots and container lifecycle, and donated
to the CNCF in 2017. `runc` sits below it, executing one container at a time.

### Kubernetes decouples from Docker: 2016 to 2022

The kubelet originally spoke to Docker through code compiled into it. In
Kubernetes 1.5 (blog post dated 2016-12-19) the project introduced the
**Container Runtime Interface**: a gRPC API with a `RuntimeService` and an
`ImageService`, so any runtime implementing it could be plugged in. CRI-O and
the containerd CRI plugin followed.

:::legacy dockershim
The adapter that let the kubelet keep talking to Docker Engine was called
**dockershim**. It was deprecated in Kubernetes 1.20 and **removed in 1.24**
(released 2022-05-03). Since then a Kubernetes node runs a CRI runtime such as
containerd or CRI-O directly. If you need Docker Engine underneath a modern
kubelet, that adapter now lives outside the project as `cri-dockerd`.

None of this affects your images: Docker builds OCI images, and OCI images run
on any CRI runtime. Tutorials that tell you to "install Docker on your
Kubernetes nodes" are describing a world that ended in 2022. See
[the dockershim removal](../migration/dockershim-removal.md).
:::

### Where we are in 2026

The stack you actually run is: an **OCI image** built by BuildKit, stored in a
registry that speaks the **distribution spec**, pulled by **containerd**,
unpacked by a **snapshotter** into overlayfs, described by an **OCI runtime
spec** `config.json`, and started by **runc** under a
`containerd-shim-runc-v2`. Kubernetes drives the whole thing over **CRI**.
Docker Engine 29 uses the same containerd and runc underneath; the Docker CLI
is one client of that stack rather than the stack itself.

## Basic example

The lineage is still visible on a running node. The shim and runtime versions
come straight from that history:

```bash
docker exec tasklane-control-plane containerd --version
docker exec tasklane-control-plane runc --version
docker exec tasklane-control-plane crictl version
```

```console include="captures/foundations/runtime-versions.txt"
```

## Explanation

Three consequences of this history matter every day.

**Images and runtimes are separate standards.** Because the OCI split image,
runtime and distribution into three specs, you can build with BuildKit, store
in any conformant registry, and run with containerd, CRI-O or Podman. The
specs, not any one vendor's tool, are what makes that work.

**"Docker" is ambiguous.** It can mean the CLI, the daemon, the company, the
image format, or the whole ecosystem. When someone says Kubernetes "removed
Docker support", the precise statement is that the kubelet removed its built-in
adapter for the Docker daemon's API. The image format was never at issue.

**Old defaults linger.** cgroup v1 was the only option for a decade, so
documentation and tools assume it; it is now deprecated in Kubernetes (the
kubelet refuses to start on a cgroup v1 node by default since **1.35**) and
Podman 6 removed it outright. Similarly, the original standalone Python Compose
is long gone, replaced by the `docker compose` plugin, now at v5.

## Common patterns

| If a tutorial says… | It was written before… | Do this instead |
|---|---|---|
| install Docker on your Kubernetes nodes | 2022 (Kubernetes 1.24) | use the node's CRI runtime; build images anywhere |
| run Compose as a standalone Python binary | 2020 | `docker compose`, the Go plugin, now at v5 |
| use the pod security policy API | 2022 (it was removed in 1.25) | Pod Security Admission and admission policies |
| mount `/sys/fs/cgroup/memory/...` | 2016 (cgroup v2) | the unified hierarchy at `/sys/fs/cgroup` |
| expose HTTP with the frozen Ingress API by default | 2026 | Gateway API, with Ingress treated as legacy |

## Production considerations

- **Track deprecations as a routine, not an incident.** The kubelet, the
  runtime, the cgroup version and the API versions all move on their own
  schedules. See
  [deprecated API detection](../operations/deprecated-api-detection.md).
- **Prefer specs over implementations in contracts.** "We publish OCI images to
  an OCI distribution registry" survives a tooling change; "we publish Docker
  images to Docker Hub" does not.
- **Beware of copied runbooks.** Much of the internet's container content was
  written between 2015 and 2020 and never revised.

## Security considerations

History explains today's defaults, and the defaults are the security story.
`chroot` was never meant to contain a privileged process, and that DNA
survives: a container running as UID 0 with `CAP_SYS_ADMIN` is roughly as
contained as a 1979 chroot. The mitigations added later — capabilities (Linux
2.2), seccomp filters (Linux 3.5), user namespaces (Linux 3.8), cgroup v2
delegation — are the parts that make the difference, and each is opt-in.

Two dates worth remembering for security conversations: **user namespaces
became usable in Linux 3.8 (2013)** but only reached **GA in Kubernetes 1.36
(2026)** as `hostUsers: false`; and **cgroup v1 was deprecated in Kubernetes
1.35**, which matters because several classic escapes depend on cgroup v1
behaviour.

## Troubleshooting

| Confusion | Resolution |
|---|---|
| "Do I need Docker to run Kubernetes?" | No. You need a CRI runtime. Docker is a convenient way to *build* images. |
| "Is my image a Docker image or an OCI image?" | Both formats exist and registries serve both; modern builders default to OCI-compatible manifests. |
| "Why is there a shim process per container?" | So containerd can restart without killing containers. See [runtime stack](runtime-stack.md). |
| "Why does this blog's cgroup path not exist?" | It is cgroup v1; you are on the v2 unified hierarchy. |

## Common mistakes

- **Treating LXC, Docker and Kubernetes as competitors.** They are different
  layers of the same idea, arrived at in that order.
- **Believing Docker invented containers.** It invented the workflow, and that
  was enough.
- **Copying pre-2022 Kubernetes node setup.** Node-level Docker installation,
  cgroup v1 paths and removed APIs all come from that era.
- **Assuming a standard exists where it does not.** There is no OCI standard
  for building images, for Compose files, or for networking a single host.
- **Quoting round-number dates.** "Containers started in 2013" erases the 34
  years of kernel and Unix work that made 2013 possible.

## Related topics

- [What containers actually solve](what-containers-solve.md)
- [OCI specifications](oci-specifications.md)
- [The container runtime stack](runtime-stack.md)
- [cgroups v2](cgroups-v2.md)
- [Linux namespaces](linux-namespaces.md)
- [The dockershim removal](../migration/dockershim-removal.md)
- [Podman and other alternatives](../docker-advanced/podman-and-alternatives.md)
- [Glossary](../reference/glossary.md)
