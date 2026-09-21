---
title: seccomp
description: How a BPF filter on the syscall table shrinks the kernel attack surface, and why Kubernetes needs RuntimeDefault to be asked for.
level: foundations
type: concept
status: current
versions: Linux kernel 6.x, Docker Engine 29, containerd 2.x, Kubernetes 1.37
prerequisites:
  - foundations/what-containers-solve
  - foundations/capabilities
---

## Overview

Capabilities restrict *privileged operations*. seccomp restricts *which system
calls exist at all*. A seccomp filter is a small BPF program the kernel runs on
every syscall the process makes; it sees the syscall number, the architecture
and the raw register arguments, and returns a verdict: allow, fail with an
errno, kill, log, or notify a supervisor.

For containers this is the single most effective reduction of kernel attack
surface, because most workloads use a few dozen syscalls and a kernel offers
several hundred.

## Why it exists and when to use it

Nearly every container escape starts with a syscall the workload never needed.
`unshare()`, `mount()`, `keyctl()`, `add_key()`, `bpf()`, `perf_event_open()`,
`userfaultfd()`, `io_uring_setup()` — the list of syscalls that have carried
privilege-escalation bugs is long, and a Go web service calls none of them.

Use seccomp always, in the form of a runtime's default profile, and use a
custom profile when you have a high-value workload, a profiling run to base it
on, and a plan for maintaining it.

## How it works underneath

### Filter mechanics

seccomp has two modes. The old `SECCOMP_MODE_STRICT` allowed four syscalls and
is a museum piece. Containers use `SECCOMP_MODE_FILTER` (Linux 3.5), installed
with `seccomp(SECCOMP_SET_MODE_FILTER, …)` or `prctl()`.

The filter is classic BPF, evaluated against a `seccomp_data` structure: the
syscall number, the architecture (`AUDIT_ARCH_X86_64`, `AUDIT_ARCH_AARCH64`,
…), the instruction pointer, and the six syscall arguments as 64-bit values.

Two consequences follow from that structure and are the source of most
confusion:

1. **Filters cannot dereference pointers.** A filter can say "deny `open` with
   flag `O_CREAT`" but not "deny `open` of `/etc/shadow`", because the path is
   behind a pointer and could be changed after the check. Path-based policy
   needs an LSM, not seccomp.
2. **Architecture must be matched explicitly.** A filter that only handles
   `x86_64` can be bypassed via the `i386` compat ABI unless it denies other
   architectures outright. Real profiles list the architectures they cover.

Actions, in rising severity: `SCMP_ACT_ALLOW`, `SCMP_ACT_LOG`,
`SCMP_ACT_ERRNO` (the syscall fails, usually with `EPERM`), `SCMP_ACT_TRAP`
(SIGSYS), `SCMP_ACT_KILL_THREAD`, `SCMP_ACT_KILL_PROCESS`, plus
`SCMP_ACT_NOTIFY`, which hands the decision to a user-space supervisor — the
mechanism behind newer "unprivileged workload does a privileged thing safely"
designs.

Filters are **inherited across `fork()` and `execve()` and can never be
removed**. Installing one without `CAP_SYS_ADMIN` requires the `no_new_privs`
bit, which is the same bit Kubernetes sets with
`allowPrivilegeEscalation: false`.

A process's status shows the mode and the number of filters attached:

```bash
grep -E '^Seccomp|^NoNewPrivs' /proc/<container-pid>/status
```

```console include="captures/foundations/api-seccomp.txt"
```

`Seccomp: 0` means no filter, `1` strict mode, `2` filter mode.

### The default profiles

**Docker** applies its default profile to every container unless you opt out.
It is an allowlist: the default action is `SCMP_ACT_ERRNO`, overridden for the
syscalls the profile permits, and it blocks roughly 44 syscalls out of 300-plus
— among them `mount`, `reboot`, `ptrace`, namespace-creating `clone()` forms,
`AF_ALG` and `AF_VSOCK` sockets, and kernel-module operations. Disabling it is
`--security-opt seccomp=unconfined`, and the documentation is explicit that
changing the default is not recommended.

**Kubernetes** does the opposite by default: unless a pod asks, or the kubelet
is configured with `seccompDefault: true`, containers run **unconfined**. The
pod field is:

```yaml include="examples/k8s/03-app/api.yaml" lines="42-47"
```

`type: RuntimeDefault` means "use the container runtime's default profile",
which for containerd and CRI-O is a profile very close to Docker's. The other
values are `Unconfined` and `Localhost`, the latter naming a JSON profile file
the kubelet reads from its seccomp directory on the node.

This asymmetry surprises people: a workload can be *more* exposed after moving
from `docker run` to Kubernetes, purely because nobody set
`seccompProfile`. Pod Security Admission's Restricted level requires
`RuntimeDefault` or `Localhost`, which is one more reason to run application
namespaces at Restricted.

### How the profile reaches the kernel

The pod's `seccompProfile` becomes `linux.seccomp` in the OCI runtime spec
`config.json`: an architecture list, a default action, and a list of syscall
groups with their actions. `runc` compiles that into a BPF program with
`libseccomp` and installs it in `runc init`, immediately before `execve()` of
the container process — late enough that runc's own setup work is unaffected,
early enough that the workload never runs unfiltered.

## Basic example

Tasklane's pod-level security context sets `RuntimeDefault` for every container
in the pod, including init containers. The capture above shows the result on
the node: filter mode active, `no_new_privs` set.

To see the profile itself as the runtime recorded it, read the runtime spec
from the container's bundle:

```bash
crictl inspect -o go-template --template '{{json .info.runtimeSpec.process}}' <container-id>
```

```console include="captures/foundations/api-oci-process.txt"
```

## Explanation

A useful mental model: capabilities gate *what a syscall is allowed to do*,
seccomp gates *whether the syscall can be reached*. They overlap, and the
overlap is deliberate defence in depth. `mount()` requires `CAP_SYS_ADMIN`
*and* is blocked by the default seccomp profile; an attacker needs to defeat
both.

The default profiles are also *dynamic* in one important sense: some entries
are conditional on the capabilities the container holds. Grant
`CAP_SYS_ADMIN` and parts of the profile relax, because a container that has
that capability is assumed to need the corresponding syscalls. Privilege
decisions therefore interact: `--privileged` both grants all capabilities and
switches the profile to unconfined.

## Common patterns

**Use `RuntimeDefault` everywhere.** It is one field, it costs nothing, and it
removes dozens of syscalls.

**Build a custom profile only with evidence.** The workable process is: run the
workload with an audit-style profile (default action `SCMP_ACT_LOG`), collect
the syscalls it actually makes, generate a profile, test it under load *and*
during failure paths, then enforce. Tools in this space include the Security
Profiles Operator and eBPF-based recorders.

**Version profiles with the application.** A syscall set changes when you
change language runtime version, TLS library or logging backend. A profile
that is not tested in CI will eventually break a release.

**Keep an escape hatch, deliberately.** A documented way to run one pod with
`Unconfined` in a debugging namespace beats an emergency cluster-wide change.

## Production considerations

- **`seccompDefault: true` on the kubelet** makes `RuntimeDefault` the cluster
  default, so a pod that forgets the field is still filtered. Roll it out node
  pool by node pool and watch for `EPERM` errors.
- **Custom profiles are a maintenance commitment.** Most teams get 90% of the
  benefit from `RuntimeDefault` and should spend the remaining effort
  elsewhere.
- **Performance cost is small but measurable.** A BPF program runs on every
  syscall; syscall-heavy workloads may see low single-digit percentage
  overhead.
- **Not all nodes support everything.** The kernel needs `CONFIG_SECCOMP`
  and `CONFIG_SECCOMP_FILTER`; `SCMP_ACT_NOTIFY`-based tooling needs a newer
  kernel and runtime.

## Security considerations

Threat: a bug in your application gives an attacker the ability to execute
arbitrary code in the container. They then try to reach the kernel.

- **Without a profile**, they can call anything the kernel offers. Historic
  container escapes have used `keyctl`, `userfaultfd`, `io_uring`, `bpf` and
  `perf_event_open`. Your web server calls none of those.
- **With `RuntimeDefault`**, those syscalls return `EPERM`. Their exploit code
  fails at the first step, and the failure is visible in logs and audit trails.
- **Verify** by reading `/proc/<pid>/status` on the node, as above, rather than
  trusting the manifest.

The honest limits: seccomp cannot express path-based rules, cannot inspect
structures behind pointers, and cannot protect you from a bug in a syscall you
legitimately use. It shrinks the surface; it does not make a shared kernel a
hard boundary. For that, see the sandboxed runtimes in
[containers vs VMs](containers-vs-vms.md#the-honest-security-comparison).

## Troubleshooting

| Symptom | Diagnosis |
|---|---|
| "operation not permitted" for an unusual syscall | a seccomp profile is denying it; check `Seccomp: 2` in `/proc/<pid>/status` |
| Process dies with SIGSYS | a profile with `SCMP_ACT_TRAP` or `KILL` matched |
| Works on Docker, fails on Kubernetes (or the reverse) | different default: Docker filters by default, Kubernetes does not unless asked |
| A profile works on amd64 and fails on arm64 | the profile's `architectures` list does not cover the node |
| Pod rejected by admission | Restricted PSA requires `RuntimeDefault` or `Localhost` |

To confirm a specific syscall is the cause, reproduce with the profile set to
`Unconfined` **in a disposable namespace only**, and compare.

## Common mistakes

- **Leaving Kubernetes workloads unconfined** because the Docker defaults gave
  a false sense of coverage.
- **Copying a profile from a blog.** Profiles are workload-specific; an
  unvetted one either breaks the app or allows everything.
- **Writing path-based rules.** seccomp cannot do that. Use AppArmor or
  SELinux.
- **Forgetting `no_new_privs`.** Without it, an unprivileged process cannot
  install a filter at all, and privilege can be regained through setuid
  binaries.
- **Testing only the happy path.** Error handling, crash paths and shutdown
  often use syscalls the steady state does not.

## Related topics

- [Capabilities](capabilities.md)
- [AppArmor and SELinux](apparmor-and-selinux.md)
- [Containers vs virtual machines](containers-vs-vms.md)
- [The container runtime stack](runtime-stack.md)
- [seccomp and AppArmor profiles with Docker](../docker-security/seccomp-and-apparmor-profiles.md)
- [Security context](../k8s-security/security-context.md)
- [Pod Security Standards](../k8s-security/pod-security-standards.md)
- [Runtime security with Falco](../k8s-security/runtime-security-falco.md)
