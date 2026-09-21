---
title: Containers vs virtual machines
description: What a shared kernel really means for isolation, performance and security, and where gVisor and Kata Containers fit.
level: foundations
type: concept
status: current
versions: Linux kernel 6.x, Docker Engine 29, containerd 2.x, Kubernetes 1.37
prerequisites:
  - foundations/what-containers-solve
---

## Overview

The difference between a container and a virtual machine is one sentence: **a
VM gets its own kernel, a container borrows the host's**. Everything else —
boot time, image size, density, the strength of the isolation boundary, which
workloads fit — follows from that single fact.

This page works through the consequences, and then gives an honest comparison
of the security properties, including the sandboxed runtimes (gVisor, Kata
Containers) that exist precisely because "container" and "VM" are not the only
two options.

## Why it exists and when to use it

A hypervisor virtualises *hardware*. The guest sees virtual CPUs, virtual
memory, virtual disks and virtual NICs, and runs its own kernel against them.
The boundary between guest and host is the hardware interface, enforced by the
CPU itself (Intel VT-x / AMD-V) and a relatively small host component (KVM plus
a device model such as QEMU, Cloud Hypervisor or Firecracker).

A container runtime virtualises the *kernel's own abstractions*. The process
sees a private set of PIDs, mounts, network interfaces and so on, but when it
calls `openat()` or `io_uring_setup()` it enters exactly the same kernel code
as every other process on the machine.

Choose VMs when you need a different kernel, hard multi-tenant isolation, or
device passthrough. Choose containers when you want density, fast start-up and
a single build artifact. In practice most production Kubernetes runs containers
*inside* VMs: the VM is the tenancy boundary, the container is the packaging
and scheduling unit.

## How it works underneath

### The boot path

A VM boot runs firmware, a bootloader, kernel initialisation, device probing
and an init system before your process starts: seconds at best, and a fixed
memory cost of a few tens to hundreds of MiB for the guest kernel and
userspace.

Starting a container is: unpack or reuse the image snapshot, mount the
overlay, `clone()` with the right `CLONE_NEW*` flags, apply the cgroup limits,
`pivot_root`, drop capabilities, install the seccomp filter, `execve()`. That
is milliseconds to tens of milliseconds, and the only fixed memory cost is the
process itself.

### What "shared kernel" means in the lab

A kind cluster makes this visible: every "node" is a container on your machine,
so all the nodes and every pod share one kernel.

```bash
docker info --format 'host kernel: {{.KernelVersion}}'
docker exec tasklane-control-plane uname -srm
docker exec tasklane-worker uname -srm
```

```console include="captures/foundations/kernel-shared.txt"
```

Three "machines", one kernel version string, because there is one kernel. On a
real cluster the nodes are separate VMs, and those numbers can differ — which
is why node-level features (cgroup version, PSI, AppArmor, seccomp
availability) are node properties, not cluster properties.

### The syscall surface

The practical measure of attack surface is how much kernel code a workload can
reach. A Linux kernel exposes on the order of 350 to 400 syscalls, many with
multiplexed sub-operations (`ioctl`, `prctl`, `keyctl`, `bpf`, `io_uring`). A
container process can reach all of them unless a seccomp filter is installed;
Docker's default profile blocks around 44 of them, and Kubernetes installs no
profile at all unless you ask for `RuntimeDefault`.

A VM guest, by contrast, reaches the host only through the virtual device
interfaces the hypervisor exposes — a much narrower and much more carefully
audited surface.

## Basic example

| Property | Virtual machine | Container | gVisor (`runsc`) | Kata Containers |
|---|---|---|---|---|
| Kernel | own guest kernel | host kernel | user-space kernel in Go, plus a restricted host surface | own guest kernel in a lightweight VM |
| Start-up | seconds | milliseconds | tens of milliseconds | hundreds of milliseconds |
| Memory overhead | tens to hundreds of MiB | process only | tens of MiB | tens of MiB |
| Image format | VM disk image | OCI image | OCI image | OCI image |
| Syscall path | guest kernel → virtual device → host | host kernel | intercepted by the Sentry, small filtered host surface | guest kernel → virtio → host |
| Density | low | high | high | medium |
| Typical use | tenancy boundary, non-Linux guests | application packaging and scheduling | untrusted code with an acceptable syscall-compat trade-off | untrusted code needing near-full compatibility |

gVisor and Kata are both used through Kubernetes' `RuntimeClass`
(`node.k8s.io/v1`): the pod names a runtime class, the kubelet passes the
matching runtime handler over CRI, and containerd starts a different shim. They
are not drop-in for every workload — gVisor re-implements a subset of Linux,
and Kata pays a virtualisation cost and cannot share the host's page cache in
the same way.

## Explanation

The table hides one important nuance: **isolation is not one property**.

- **Resource isolation** is comparable. A cgroup's `memory.max` and `cpu.max`
  bound a container as firmly as a hypervisor bounds a guest's RAM and vCPUs.
  Noisy-neighbour effects exist in both (shared caches, shared memory
  bandwidth, shared disks).
- **Namespace isolation** is about *visibility*, not permission. A container
  cannot see host PIDs because it is in a different PID namespace, not because
  a policy denied it. Put the process back in the host namespace
  (`hostPID: true`) and the visibility returns instantly.
- **Kernel isolation** is where containers are weaker by construction. One
  privilege-escalation bug in a syscall handler crosses the boundary. VM escape
  requires a bug in the hypervisor's much smaller interface.
- **Blast radius** differs accordingly: a container escape usually means the
  node, and — if the node runs a credential-bearing agent — potentially the
  cluster.

## Common patterns

**Containers in VMs.** Managed Kubernetes gives every customer their own nodes,
which are VMs. The VM is the tenancy boundary; containers inside it are
same-trust workloads.

**Node pools by trust level.** Untrusted or customer-supplied workloads get
their own node pool, often with a sandboxed `RuntimeClass`, taints, and network
policy separating them from the rest.

**VMs for the data plane, containers for the control plane.** Databases with
heavy I/O tuning and kernel-version sensitivity often stay on VMs while the
stateless tier is containerised. That is a legitimate architecture, not a
failure to modernise.

## Production considerations

- **Capacity planning changes shape.** With VMs you size a machine per
  workload; with containers you size a node pool and let requests and limits
  pack it. Over-provisioned requests waste a node pool; missing limits let one
  workload evict its neighbours.
- **Kernel upgrades become shared events.** All containers on a node inherit a
  kernel fix or regression at once. Roll nodes, do not patch in place.
- **Node-local state is ephemeral.** A VM is a pet with a disk; a container's
  writable layer disappears with it. Anything durable belongs in a volume.
- **Sandboxed runtimes cost something.** Expect syscall-compatibility gaps with
  gVisor and extra memory and boot time with Kata. Measure with your workload
  before committing.

## Security considerations

### The honest security comparison

State it plainly: **a default container is weaker isolation than a VM.** The
container's defences are layered mitigations, not a single enforced boundary:

| Layer | What it stops | How it fails |
|---|---|---|
| Namespaces | seeing and naming host objects | host namespaces re-enabled by config (`hostPID`, `hostNetwork`, `hostIPC`) |
| cgroups | starving the node of CPU, memory, PIDs | no limit set; cgroup writes granted to the container |
| Capabilities | most privileged operations | `privileged: true`, or `CAP_SYS_ADMIN` added "temporarily" |
| seccomp | reaching rarely used syscalls | no profile applied (the Kubernetes default) |
| AppArmor / SELinux | file and operation classes even for root | LSM not enabled on the node kernel; profile set to unconfined |
| User namespaces | root-in-container equals root-on-host | not enabled; in Kubernetes this is `hostUsers: false`, **GA in 1.36** |

Remove enough of those and "container" means "process running as root on your
node". That is why [privileged pod escape](../k8s-security/attack-privileged-pod-escape.md)
is a short demo rather than a research project.

The counter-argument in containers' favour is real too: VMs are only a stronger
boundary if they are *maintained*. A fleet of un-patched VMs with SSH exposed
is worse than well-configured containers. Choose deliberately, and configure
what you chose.

:::warning
"We run untrusted user code in containers" needs a design, not an assumption.
The workable designs are: one VM (or node pool) per tenant; a sandboxed
`RuntimeClass` such as gVisor or Kata; or both. User namespaces plus a strict
seccomp profile raise the bar but do not by themselves make a shared kernel
safe for hostile code.
:::

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| A container works on one node and fails on another | different kernel version, cgroup version, or LSM enabled on only one node |
| "operation not permitted" for a syscall that works elsewhere | seccomp profile or missing capability, not a VM/container difference |
| Sandboxed runtime pod stuck in `ContainerCreating` | `RuntimeClass` handler not configured in containerd on that node |
| Huge memory use per workload compared with a VM plan | many small containers each carrying their own runtime, or no limits so page cache accrues to the cgroup |

## Common mistakes

- **Claiming containers are "as isolated as VMs".** They are not, by
  construction. Say what your actual boundary is.
- **Running mutually hostile tenants on the same node** with nothing but
  namespaces between them.
- **Lift-and-shift of a whole VM into one container**, complete with init
  system and SSH. You inherit the VM's maintenance burden and lose the
  container's operational model.
- **Assuming a sandbox is free.** gVisor and Kata change syscall behaviour and
  performance; test rather than assume.
- **Forgetting the kernel is shared with the *host's* other duties** — the
  kubelet, the CNI agent, the log shipper. A container that exhausts a
  node-level resource harms all of them.

## Related topics

- [What containers actually solve](what-containers-solve.md)
- [Linux namespaces](linux-namespaces.md)
- [cgroups v2](cgroups-v2.md)
- [seccomp](seccomp.md)
- [The container runtime stack](runtime-stack.md)
- [User namespaces in Kubernetes](../k8s-security/user-namespaces.md)
- [The 4C model](../k8s-security/4c-model.md)
- [Privileged pod escape](../k8s-security/attack-privileged-pod-escape.md)
