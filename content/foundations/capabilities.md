---
title: Linux capabilities
description: How root's power is split into ~40 capabilities, which ones Docker keeps by default, and why CAP_SYS_ADMIN is the dangerous one.
level: foundations
type: concept
status: current
versions: Linux kernel 6.x, Docker Engine 29, containerd 2.x, Kubernetes 1.37
prerequisites:
  - foundations/what-containers-solve
  - foundations/linux-namespaces
---

## Overview

Traditional Unix had two privilege levels: UID 0 could do anything, everyone
else almost nothing. Linux capabilities split "anything" into around forty
independent privileges — bind a low port, change file ownership, load a kernel
module, mount a filesystem — that can be granted and removed one at a time.

Containers depend on this. "Root in a container" usually means UID 0 with a
reduced capability set, which is much less than root on the host. The catch is
that *reduced* is not *safe*: a handful of the remaining capabilities are
equivalent to full root if you are creative.

## Why it exists and when to use it

Capabilities let you run a program that needs exactly one privileged operation
without giving it everything. A web server binding port 80 needs
`CAP_NET_BIND_SERVICE`; a packet sniffer needs `CAP_NET_RAW`; a backup agent
needs `CAP_DAC_READ_SEARCH`. Without capabilities, each of those is a setuid
root binary and a CVE waiting to happen.

In container work you use them for three things: dropping everything you do not
need, adding back the single one you do, and recognising when an image is
asking for far too much.

## How it works underneath

### The five sets

Every process carries five capability sets, visible in `/proc/<pid>/status`:

| Set | `status` field | Meaning |
|---|---|---|
| Effective | `CapEff` | what the kernel checks right now |
| Permitted | `CapPrm` | what the process may move into effective |
| Inheritable | `CapInh` | legacy set, preserved across `execve()` with file capabilities |
| Bounding | `CapBnd` | the ceiling: a capability removed here can never be regained, by any exec |
| Ambient | `CapAmb` | capabilities that survive `execve()` of a non-setuid binary |

The **bounding set** is the one that matters for containers. When a runtime
"drops" capabilities, it removes them from the bounding set of the container's
first process, so no `execve()`, setuid binary or file capability can bring
them back for any descendant.

Capabilities are also *namespaced*. A process in a user namespace can hold all
capabilities **with respect to that namespace** while holding none on the host.
That is why rootless containers work: `CAP_NET_ADMIN` inside your own user
namespace lets you configure your own virtual interfaces, not the host's.

### What runtimes do by default

Docker keeps 14 capabilities for a container started as root:

```text
AUDIT_WRITE  CHOWN            DAC_OVERRIDE  FOWNER
FSETID       KILL             MKNOD         NET_BIND_SERVICE
NET_RAW      SETFCAP          SETGID        SETPCAP
SETUID       SYS_CHROOT
```

Everything else is dropped from the bounding set. `--cap-add` and `--cap-drop`
adjust the list, both accept `ALL`, and both accept names with or without the
`CAP_` prefix. `--privileged` grants **all** capabilities, gives access to all
host devices, and relaxes the seccomp and LSM configuration — it is not "a bit
more privilege", it is effectively root on the node.

Kubernetes expresses the same thing per container:

```yaml include="examples/k8s/03-app/api.yaml" lines="123-127"
```

`drop: ["ALL"]` empties the bounding set. Because Tasklane also runs as UID
65532 and binds port 8080, it needs nothing back. If it had to bind port 80 you
would add `NET_BIND_SERVICE` — one capability, not `privileged: true`.

### Non-root users and capabilities

A process running as a non-zero UID normally has **empty** effective and
permitted sets, regardless of the bounding set, unless file capabilities or the
ambient set are used. So `runAsNonRoot: true` plus `drop: ["ALL"]` is belt and
braces: the first makes the capability sets empty in practice, the second makes
them empty by policy even if the image's `USER` changes.

`allowPrivilegeEscalation: false` sets the `no_new_privs` bit, which stops a
process from gaining privileges through setuid binaries or file capabilities
during `execve()`. It also shows up in `/proc/<pid>/status` as `NoNewPrivs: 1`.

## Basic example

Compare the container with the node's init process:

```bash
grep -E '^Cap(Inh|Prm|Eff|Bnd|Amb)|^NoNewPrivs' /proc/<container-pid>/status
grep -E '^Cap(Inh|Prm|Eff|Bnd|Amb)|^NoNewPrivs' /proc/1/status
```

```console include="captures/foundations/api-caps.txt"
```

The values are hexadecimal bitmasks. `0000000000000000` is an empty set.
`capsh --decode=<mask>` turns a mask into names when `libcap` is available.

The same information as the runtime configured it, before the process started:

```console include="captures/foundations/api-oci-process.txt"
```

That is `process.capabilities` from the OCI runtime spec, which is where the
kubelet's `securityContext` ends up after passing through CRI.

## Explanation

Three capabilities deserve individual attention.

**`CAP_SYS_ADMIN` is a synonym for root.** It is the kernel's junk drawer: it
permits `mount()`, `unshare()`, `setns()`, `pivot_root()`, arbitrary `ioctl`s
on many devices, writing to many `/proc` and `/sys` interfaces, and a long tail
of other operations. With it, a container process can mount a filesystem,
enter other namespaces, or abuse kernel interfaces to reach host state. Any
image whose documentation says "run with `--cap-add SYS_ADMIN`" is asking you
to disable container isolation.

**`CAP_NET_RAW` is on by default and rarely needed.** It allows raw and packet
sockets: ARP spoofing, DNS response forging and traffic sniffing inside the
pod network. Dropping it costs almost nothing — `ping` is the usual casualty.

**`CAP_DAC_OVERRIDE` bypasses file permission checks.** It is in Docker's
default set, so a root-in-container process reads and writes every file in its
filesystem regardless of modes — including mounted Secrets.

Others worth naming: `CAP_SYS_PTRACE` (read other processes' memory, relevant
whenever `shareProcessNamespace` or `hostPID` is in play), `CAP_SYS_MODULE`
(load kernel modules: instant host compromise), `CAP_BPF` and
`CAP_PERFMON` (kernel introspection), `CAP_SYS_CHROOT`, `CAP_MKNOD` (create
device nodes), and `CAP_SETUID`/`CAP_SETGID` (become any user).

## Common patterns

| Need | Right answer | Wrong answer |
|---|---|---|
| Bind port 80 | `NET_BIND_SERVICE`, or listen on 8080 and let the Service map 80 | `privileged: true` |
| `ping` from a debug pod | `NET_RAW` in that debug pod only | adding `NET_RAW` to the application |
| Change file ownership at startup | fix ownership at build time, or use `fsGroup` | `CHOWN` plus running as root |
| Tune sysctls | node configuration, or `securityContext.sysctls` for the safe ones | `privileged: true` |
| Mount something at run time | a volume declared in the pod spec | `CAP_SYS_ADMIN` |
| Profile with perf | a dedicated debug workload on a dedicated node | `CAP_SYS_ADMIN` cluster-wide |

The default posture for application workloads is: drop `ALL`, add back at most
one capability, with a comment saying why.

## Production considerations

- **Enforce it, do not document it.** Pod Security Admission's Restricted
  level requires `drop: ["ALL"]` and allows only `NET_BIND_SERVICE` back. The
  `tasklane` namespace in this handbook runs Restricted.
- **Audit what you actually grant.** A cluster-wide query for containers with
  `add:` in their security context is a five-minute job and usually surprising.
- **Capabilities are per container, not per pod.** An init container or sidecar
  with extra capabilities is still a container on the node.
- **Dropping capabilities can break images silently at run time**, not at
  start-up — for example an image that chowns a data directory on first write.
  Test the failure paths, not just the happy path.

## Security considerations

Threat: an attacker who achieves remote code execution inside a container
wants to reach the node. Their first look is at the capability sets.

- With `CapEff: 0000000000000000` and `no_new_privs`, they have a normal
  unprivileged user on a filesystem with almost nothing in it.
- With Docker's default 14 and UID 0, they can read and modify every file in
  the container, forge network traffic with `NET_RAW`, and create device nodes
  with `MKNOD`.
- With `CAP_SYS_ADMIN` or `privileged: true`, they mount the host filesystem
  or abuse a device and own the node. This is not theoretical; it is a
  well-trodden path, demonstrated in
  [privileged pod escape](../k8s-security/attack-privileged-pod-escape.md).

Verify the fix from outside the container, in the node's `/proc`, exactly as
the capture above does. A `securityContext` that was silently ignored because
it sat at the wrong level in the YAML looks perfect in `kubectl get -o yaml`
and empty in `/proc/<pid>/status`.

:::best-practice
`drop: ["ALL"]`, `allowPrivilegeEscalation: false`, `runAsNonRoot: true`, and a
non-zero numeric `runAsUser`. Four lines, and the entire capability-based
escalation class is gone.
:::

## Troubleshooting

| Symptom | Cause |
|---|---|
| "operation not permitted" on `bind()` to port < 1024 | missing `NET_BIND_SERVICE` |
| `ping` says "socket: operation not permitted" | `NET_RAW` dropped; usually correct |
| chown/chmod fails at start-up | `CHOWN`/`FOWNER` dropped; fix ownership in the image instead |
| A container works with `--privileged` and not without | find which single capability or device it needs; never ship the privileged version |
| The security context appears ignored | it is set at pod level where a container-level field is required, or vice versa |

## Common mistakes

- **Using `privileged: true` as a debugging step and leaving it in.**
- **Adding `CAP_SYS_ADMIN` because an error message mentioned `mount`.**
- **Assuming non-root means no capabilities.** File capabilities and the
  ambient set can give a non-root process real privileges; that is why the
  bounding set and `no_new_privs` matter.
- **Dropping capabilities but keeping UID 0.** Better than nothing, still a
  much larger attack surface than a non-root UID.
- **Reading `CapEff` of the wrong process.** The shell you `exec`ed in may have
  different sets from the container's PID 1 if the exec requested them.

## Related topics

- [seccomp](seccomp.md)
- [AppArmor and SELinux](apparmor-and-selinux.md)
- [Linux namespaces](linux-namespaces.md)
- [The container runtime stack](runtime-stack.md)
- [Dropping capabilities with Docker](../docker-security/dropping-capabilities.md)
- [no-new-privileges](../docker-security/no-new-privileges.md)
- [Security context](../k8s-security/security-context.md)
- [Pod Security Standards](../k8s-security/pod-security-standards.md)
