---
title: AppArmor and SELinux
description: Mandatory access control for containers: profiles, labels, and what each one actually stops.
level: foundations
type: concept
status: current
versions: Linux kernel 6.x, Docker Engine 29, containerd 2.x, Kubernetes 1.37
prerequisites:
  - foundations/what-containers-solve
  - foundations/capabilities
---

## Overview

Capabilities and seccomp restrict *operations* and *syscalls*. Linux Security
Modules restrict *objects*: this process may read that path, may not write this
one, may connect to that socket type. They implement **mandatory access
control** — a policy that the process cannot change, on top of the ordinary
owner/group/mode checks (discretionary access control) that the file's owner
*can* change.

Two LSMs dominate container hosts: **AppArmor** (path-based profiles; Debian,
Ubuntu, SUSE) and **SELinux** (label-based policy; RHEL, Fedora, CentOS
Stream). A node runs one or the other, or neither. Which one you get is a
property of the node's distribution, not of Kubernetes.

## Why it exists and when to use it

seccomp cannot say "not that file", because a filter cannot follow a pointer.
Capabilities cannot say "may write `/var/log` but not `/etc`". MAC fills
exactly that gap, and it keeps applying when the process is UID 0: even root
cannot step outside its profile or its label.

For most teams the correct use is not to write policy but to make sure the
distribution's container policy is **enabled and not overridden**. That default
policy already blocks writes to `/proc` and `/sys` paths, blocks mount
operations, and confines every container away from the host's files.

## How it works underneath

### AppArmor: paths and profiles

AppArmor attaches a **profile** to a process by executable path or by explicit
transition. The profile is a list of rules over file paths, capabilities,
network operations, mounts and signals, in either `enforce` or `complain`
(log-only) mode. The label a process carries is readable at
`/proc/<pid>/attr/current`.

Container runtimes ship a default container profile — Docker's is
`docker-default`, containerd's CRI plugin uses a profile commonly named
`cri-containerd.apparmor.d` — generated at runtime start and applied to every
container unless told otherwise. Broadly, those profiles deny writes to
`/proc/sys` (other than a small allowlist), deny mounts, deny `ptrace` outside
the container, and deny raw access to kernel interfaces.

Kubernetes exposes this per container:

```yaml title="apparmor-fragment.yaml" fragment
securityContext:
  appArmorProfile:
    type: RuntimeDefault        # or Localhost with localhostProfile: <name>
```

The `appArmorProfile` field is **GA since Kubernetes 1.31**; before that the
same thing was expressed with a `container.apparmor.security.beta.kubernetes.io/<container>`
annotation, which still works but should not be used in new manifests.

### SELinux: labels and types

SELinux labels every process and every object with
`user:role:type:level`. Policy is written in terms of **types**: a process in
type `container_t` may access files of type `container_file_t`, and that is
essentially it. Because the rules are about labels rather than paths, renaming
or bind-mounting a file changes nothing.

Container platforms add **MCS categories** (the `level` part, such as
`s0:c12,c345`) so that two containers on the same node get different
categories and therefore cannot touch each other's files even though both are
`container_t`. That is real per-container isolation that AppArmor's shared
profile does not provide.

Kubernetes sets labels through `securityContext.seLinuxOptions` (`user`,
`role`, `type`, `level`). Volumes are the hard part: historically the kubelet
recursively relabelled every file in a volume, which is slow on large volumes.
**`SELinuxMount` is Stable and on by default in Kubernetes 1.37**: the volume
is mounted with a `context=` option instead of being relabelled, when the CSI
driver declares `seLinuxMount: true`. A pod can opt out with
`seLinuxChangePolicy: Recursive`. Related gates graduated earlier —
`SELinuxChangePolicy` and the ReadWriteOncePod case were **GA in 1.36**.

With Docker on an SELinux host, the `:z` and `:Z` bind-mount suffixes do the
same job manually: `:z` relabels the content as shared between containers,
`:Z` as private to one.

### Seeing it on a node

```bash
cat /sys/kernel/security/lsm
cat /proc/<container-pid>/attr/current
```

```console include="captures/foundations/api-lsm-label.txt"
```

The first file lists the LSMs the kernel booted with. If AppArmor and SELinux
are both absent, the container's MAC layer is simply not there — common on
minimal kernels, including some developer VMs. That is worth knowing before
you claim a control exists.

## Basic example

Tasklane does not set an AppArmor profile or SELinux options: it relies on the
runtime default profile where one exists, and on running as a non-root UID with
no capabilities, a read-only root filesystem and a seccomp profile everywhere.
That combination is deliberate, because the LSM in use varies by node
distribution while the other three controls do not.

When you do pin a profile, pin it per container and state which nodes provide
it:

```yaml title="apparmor-localhost-fragment.yaml" fragment
securityContext:
  appArmorProfile:
    type: Localhost
    localhostProfile: k8s-apparmor-tasklane-api
```

A `Localhost` profile must already be loaded into the kernel on every node the
pod may be scheduled to. Kubernetes does not distribute profiles; a DaemonSet,
a node image, or configuration management does.

## Explanation

The two systems trade off differently.

| | AppArmor | SELinux |
|---|---|---|
| Policy keyed on | file paths and executables | labels (types) on processes and objects |
| Per-container separation | one shared profile by default | MCS categories give each container its own |
| Learning curve | lower; profiles are readable | higher; policy modules and booleans |
| Failure mode | denial logged by the kernel, path visible | `avc: denied` in the audit log with types |
| Typical hosts | Debian, Ubuntu, SUSE | RHEL, Fedora, CentOS Stream |
| Rename/bind-mount safety | weaker: paths can be aliased | stronger: the label travels with the inode |

Both are *complementary* to everything else on the node. A container with no
capabilities, a seccomp filter and a MAC label has to defeat three independent
mechanisms to do something unexpected; the mechanisms fail in different ways,
which is the point.

## Common patterns

**Leave the runtime default on.** The single most common mistake is disabling
confinement to fix an unexplained permission error.

**Complain mode first.** AppArmor's `complain` and SELinux's `permissive`
modes log what *would* have been denied. Run there, collect denials, then
enforce.

**Per-workload profiles for high-value services only.** A profile that forbids
a payment service from executing a shell is valuable. The same effort spread
across forty microservices is usually not.

**Treat the LSM as a node property.** Label node pools, and use node selection
if a workload requires a specific profile. A pod that needs an AppArmor profile
will fail to start on a node that does not have it loaded.

## Production considerations

- **Know which LSM your nodes run** before you write policy. Managed
  Kubernetes node images differ: Ubuntu-based images bring AppArmor,
  RHEL-based images bring SELinux, and some minimal images bring neither.
- **SELinux volume relabelling is a real startup cost** for large volumes; the
  `SELinuxMount` work exists because of it. On 1.37 with a CSI driver that
  supports it, mounts get the label instead.
- **Denials are your signal.** Ship kernel audit logs (`avc: denied`,
  `apparmor="DENIED"`) somewhere searchable, and alert on new ones after a
  release.
- **Profiles are part of the node image lifecycle.** Updating a `Localhost`
  profile means rolling nodes, not applying a manifest.

## Security considerations

Threat: a compromised container process tries to read a host file, write a
kernel tunable, or interfere with a neighbouring container.

- **Without an LSM**, the only barriers are file permissions (the process may
  be root in the container), capabilities and seccomp. Namespaces stop it
  seeing host mounts, but any host path bind-mounted into the pod is fair game.
- **With the runtime's default AppArmor profile**, writes to `/proc/sys`,
  mount attempts and `ptrace` of host processes are denied even for UID 0.
- **With SELinux and MCS**, a container also cannot touch another container's
  files on the same node, because their categories differ.
- **Verify** the same way as always: read `/proc/<pid>/attr/current` on the
  node, not the manifest. A label of `unconfined` means the control is not
  there, whatever the YAML says.

:::warning
Annotations and fields are silently ignored on nodes without the corresponding
LSM. "We set an AppArmor profile" is not a control until you have confirmed
the node kernel enforces it.
:::

## Troubleshooting

| Symptom | Diagnosis |
|---|---|
| Permission denied with correct file modes and capabilities | an LSM denial; check kernel logs for `apparmor="DENIED"` or `avc: denied` |
| Pod stuck in `CreateContainerError` mentioning AppArmor | the named `Localhost` profile is not loaded on that node |
| Works on one node pool, fails on another | different node distribution, different LSM |
| Volume mount permission errors on RHEL-family nodes | SELinux labels; check `seLinuxOptions` and the CSI driver's `seLinuxMount` support |
| `/proc/<pid>/attr/current` is `unconfined` | no profile applied: either no LSM, or profile explicitly disabled |

## Common mistakes

- **Disabling SELinux to "fix" a problem.** It removes a whole layer and the
  problem is usually a missing label, not the policy.
- **Assuming a profile applies cluster-wide.** Profiles are node-local and
  must be present before scheduling.
- **Using AppArmor path rules against a container filesystem you then
  bind-mount elsewhere.** Paths are aliasable; labels are not.
- **Writing custom policy before enabling the default one.**
- **Forgetting the volume story.** Most SELinux container problems are volume
  labelling problems.

## Related topics

- [Capabilities](capabilities.md)
- [seccomp](seccomp.md)
- [Overlay filesystems](overlay-filesystems.md)
- [seccomp and AppArmor profiles with Docker](../docker-security/seccomp-and-apparmor-profiles.md)
- [Security context](../k8s-security/security-context.md)
- [Policy engines](../k8s-security/policy-engines.md)
- [Runtime security with Falco](../k8s-security/runtime-security-falco.md)
