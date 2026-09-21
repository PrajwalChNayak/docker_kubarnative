---
title: What containers actually solve
description: The packaging and isolation problems that made containers necessary, and the problems they do not solve.
level: foundations
type: concept
status: current
versions: Linux kernel 6.x, Docker Engine 29, containerd 2.x, Kubernetes 1.37
prerequisites: []
---

## Overview

A container is a normal Linux process. Nothing in the kernel is called "a
container": there is no container object, no container system call, no
container file. What exists is a process whose view of the machine has been
narrowed by **namespaces**, whose resource consumption has been capped by
**cgroups**, whose filesystem root is a stack of read-only image layers under a
writable layer, and whose privileges have been reduced by **capabilities**,
**seccomp** and a **Linux Security Module**.

Everything else — images, registries, Compose, Kubernetes — is machinery for
producing that process reliably and repeatedly. This page explains which
problems that machinery was built for, because knowing the problem makes every
later mechanism obvious instead of arbitrary.

## Why it exists and when to use it

Before containers, shipping a server application meant shipping instructions.
A release was a tarball or a package plus a runbook: install this runtime
version, create this user, set these environment variables, put the config in
this path, open this port. Four problems followed from that, and containers
attack all four at once.

**1. The environment drift problem.** The application depends on a specific
interpreter, specific shared libraries, specific certificate bundles and
specific file layout. Staging has one set, production has another, and the
developer's laptop has a third. A container image freezes the entire userspace
— every file from `/bin` down — into a content-addressed artifact, so the same
bytes run everywhere. Only the kernel is inherited from the host.

**2. The dependency conflict problem.** Two applications on one host need
incompatible versions of the same library. Package managers solve this with
increasingly baroque tricks (virtualenvs, rbenv, static linking, alternative
prefixes). Containers solve it by giving each application its own root
filesystem. Their `/usr/lib` directories simply have nothing to do with each
other.

**3. The density and cost problem.** A virtual machine per application wastes
memory on a duplicated kernel and a duplicated init system, and takes tens of
seconds to boot. A container shares the host kernel, so starting one is roughly
the cost of `clone()` plus mounting a filesystem: tens of milliseconds. That
difference is what makes autoscaling, short-lived CI jobs and per-pull-request
environments practical. See [containers vs VMs](containers-vs-vms.md).

**4. The "what is running where" problem.** Once an application is an image
plus a small declarative spec, a scheduler can decide which machine runs it.
Kubernetes only became possible because the unit it schedules is
self-contained. See [why orchestration](../k8s-beginner/why-orchestration.md).

### When containers are the wrong answer

Be honest about the limits. Containers are a poor fit when:

- The workload needs a different kernel, a kernel module you cannot load, or a
  kernel version the host does not run. Containers share the host kernel;
  a Windows process cannot run on a Linux kernel, and vice versa.
- You need a hard security boundary between mutually hostile tenants on the
  same machine. The kernel syscall surface is shared. Use VMs, or a sandboxed
  runtime such as gVisor or Kata Containers, which are covered in
  [containers vs VMs](containers-vs-vms.md#the-honest-security-comparison).
- The application is a single stateful process on a single machine that nobody
  redeploys. The image pipeline is overhead with no payoff.
- The team cannot yet build, tag, scan and promote images. Containers move
  operational work earlier (into the build) rather than removing it.

:::note
Containers do not make software portable across CPU architectures. An image
built for `linux/amd64` will not run on `linux/arm64` without emulation. That
is why images ship as multi-platform indexes; see
[OCI specifications](oci-specifications.md#image-index) and
[architecture mismatch](../troubleshooting/architecture-mismatch.md).
:::

## How it works underneath

Take the Tasklane API from this handbook's running example. When you eventually
run it under Kubernetes, the kernel ends up holding one ordinary process with
four properties:

1. **A private view of the system.** The process lives in its own PID, network,
   mount, UTS and IPC namespaces, so it sees itself as PID 1 on a host with one
   network interface and its own hostname. The kernel object behind each view
   is a namespace; the handles are the symlinks in `/proc/<pid>/ns/`. See
   [Linux namespaces](linux-namespaces.md).
2. **A budget.** The process sits in a cgroup v2 directory whose `memory.max`,
   `cpu.max` and `pids.max` files hold the limits from the pod spec. Exceeding
   `memory.max` gets it killed by the kernel OOM killer; exceeding `cpu.max`
   gets it throttled. See [cgroups v2](cgroups-v2.md).
3. **A root filesystem made of layers.** The image's layers are unpacked once
   per host and stacked read-only by overlayfs, with one writable directory on
   top for the container's own writes. See
   [overlay filesystems](overlay-filesystems.md).
4. **Reduced privileges.** It keeps a subset of capabilities (Tasklane drops
   all of them), runs under a seccomp filter that rejects most of the syscall
   table, may carry an AppArmor or SELinux label, and runs as UID 65532 rather
   than root. See [capabilities](capabilities.md), [seccomp](seccomp.md) and
   [AppArmor and SELinux](apparmor-and-selinux.md).

None of that requires Docker. Docker, containerd and the kubelet are the
programs that assemble the configuration and ask the kernel for it; you can
assemble it by hand, which is what
[container from scratch](container-from-scratch.md) does.

## Basic example

The application in this handbook is a Go API with a Postgres database. Its
entire runtime contract lives in one file:

```dockerfile include="examples/app/Dockerfile" lines="37-50"
```

That is the whole packaging story: a statically linked binary, a base image
pinned by digest, a numeric user, a port and an entrypoint. There is no
install script, no runbook step, and no "make sure Go 1.27 is on the box".

## Explanation

Three things in that snippet carry most of the value.

**`FROM ${RUNTIME_IMAGE}`** pins the base by digest, so the final image
contents are reproducible. The tag is for humans; the digest is what the
builder resolves. See
[images, tags and digests](../docker-beginner/images-tags-digests.md).

**`COPY --from=build /out/api /api`** is the only content the final image adds
on top of the base. The result is a filesystem with a CA bundle, timezone data,
`/etc/passwd`, and one binary. Nothing else is present to exploit, and nothing
else needs patching.

**`USER 65532:65532`** is declared numerically because Kubernetes' `runAsNonRoot`
check happens before the image's `/etc/passwd` can be consulted. The
[container runtime stack](runtime-stack.md) turns this field of the image
config into `process.user` in the OCI runtime spec.

## Common patterns

| Problem | Pre-container approach | Container approach |
|---|---|---|
| "Works on my machine" | document the environment | ship the environment as an image |
| Two apps, conflicting libs | virtualenv, static linking, separate hosts | one root filesystem each |
| Rollback | reinstall the old package | run the previous image digest |
| Capacity | one app per VM | many containers per node, bounded by cgroups |
| Reproducible CI | pinned agents | run the build in a container |
| Config per environment | edit files on the host | environment variables, mounted files, Secrets |

The last row matters more than it looks. Because the image is immutable, all
per-environment variation has to be injected at run time. That constraint
pushes you towards twelve-factor-style configuration, which is why Tasklane
reads `PGHOST`, `PGUSER` and a password *file* rather than embedding anything.

## Production considerations

- **Images are an inventory, not a cache.** Every image you run is software
  you are responsible for patching. Basing on distroless or hardened images
  keeps that inventory small.
- **The kernel is shared and not versioned by you.** A node kernel upgrade can
  change behaviour under every container on it at once. Plan node upgrades as
  carefully as application releases; see
  [cluster upgrades](../operations/cluster-upgrades.md).
- **Limits are a production feature, not a development detail.** A container
  without `memory.max` can take the whole node down. Requests and limits are
  covered in
  [resources, requests and limits](../k8s-intermediate/resources-requests-limits.md).
- **Container logs are stdout/stderr.** The runtime writes them to a file on
  the node and the platform ships them elsewhere. Applications that log to
  files inside the container lose their logs when it exits.

## Security considerations

The single most important fact on this page: **a container is not a security
boundary in the way a VM is**. Every container on a node calls into the same
kernel. A kernel bug reachable from a syscall is reachable from inside the
container, and the defences that narrow that surface — capabilities, seccomp,
MAC labels, user namespaces — are opt-in configuration that you can switch off
by accident.

Concretely, the default posture is much weaker than most people assume:

- `docker run` keeps 14 capabilities by default, including `CAP_NET_RAW` and
  `CAP_MKNOD`.
- Kubernetes applies **no** seccomp profile unless the pod asks for
  `RuntimeDefault` or the kubelet sets `seccompDefault`.
- A pod with `hostPID`, `hostNetwork`, `privileged: true`, or a mounted
  container runtime socket is, for practical purposes, root on the node. See
  [the Docker socket is root](../docker-security/docker-socket-is-root.md).

Tasklane therefore drops every capability, sets `seccompProfile:
RuntimeDefault`, runs as UID 65532 and mounts a read-only root filesystem — not
because it is paranoid, but because those are the settings that turn the
default posture into a useful one.

## Troubleshooting

| Symptom | What it usually means |
|---|---|
| The image runs locally, fails in the cluster | different architecture, or a missing file the local bind mount used to supply |
| "exec format error" | wrong platform, see [architecture mismatch](../troubleshooting/architecture-mismatch.md) |
| Process killed with status 137 | the cgroup memory limit was exceeded; see [OOMKilled](../troubleshooting/oomkilled.md) |
| "permission denied" writing a file | read-only root filesystem, or a non-root UID against a root-owned path |
| Container exits immediately with status 0 | the entrypoint finished; a container lives exactly as long as PID 1 |

## Common mistakes

- **Treating a container as a small VM.** Running `systemd`, `sshd` and cron
  inside one, and then wondering why signals, logs and restarts behave oddly.
  One container should be one process tree with one job.
- **Assuming isolation is security.** "It is in a container" is not an answer
  to "what happens when this process is compromised?".
- **Putting configuration and secrets in the image.** That breaks the one
  property that makes images useful: the same artifact runs in every
  environment. See
  [secrets in images](../docker-security/secrets-in-images.md).
- **Ignoring the kernel dependency.** Code that needs a specific kernel
  feature, a module, or `/dev` access is not made portable by containerising it.
- **Depending on the mutable `latest` tag.** It is a moving pointer, so "the
  same image" silently becomes a different image between the test run and the
  rollout. Pin a version tag, and ideally a digest.

## Related topics

- [Containers vs virtual machines](containers-vs-vms.md)
- [A history of containers](history-of-containers.md)
- [Linux namespaces](linux-namespaces.md)
- [cgroups v2](cgroups-v2.md)
- [The container runtime stack](runtime-stack.md)
- [Build a container from scratch](container-from-scratch.md)
- [Running containers with Docker](../docker-beginner/running-containers.md)
- [Why orchestration](../k8s-beginner/why-orchestration.md)
