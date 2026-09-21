---
title: Security context
description: The pod and container securityContext fields that make a workload restricted — non-root, no privilege escalation, dropped capabilities, seccomp and a read-only root.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - foundations/capabilities
  - foundations/seccomp
---

## Overview

`securityContext` is where a pod declares how confined its containers are. It is
the container layer of the [4C model](4c-model.md) expressed in YAML, and it is
what makes a pod satisfy the `restricted` [Pod Security
Standard](pod-security-standards.md). The fields map onto Linux primitives —
users, capabilities, seccomp, no-new-privileges — covered in Part A; here we
focus on the exact set `restricted` requires and why each one matters.

## Why it exists and when to use it

Containers share the host kernel. `securityContext` narrows what a container can
ask that kernel to do, so that a compromise of the process is not a compromise
of the node. Set it on **every** workload, not just sensitive ones — the fields
are cheap, and an unset `securityContext` inherits the image's defaults, which
are frequently "root, all capabilities".

## How it works underneath

Fields exist at two levels. **Pod-level** `securityContext` sets defaults for
all containers (user, groups, seccomp, fsGroup). **Container-level**
`securityContext` sets per-container controls and overrides the pod level. The
kubelet passes these to the runtime (containerd/CRI-O → runc), which configures
the kernel: the user the process runs as, the capability set, the seccomp
filter, the mount as read-only, and the `no_new_privs` bit.

The fields `restricted` requires:

| Field | Set to | Effect |
|---|---|---|
| `runAsNonRoot` | `true` | Kubelet refuses to start the container if the image would run as UID 0 |
| `runAsUser` / `runAsGroup` | non-zero | Runs the process as an unprivileged user |
| `allowPrivilegeEscalation` | `false` | Sets `no_new_privs`; a child process cannot gain more privileges than its parent (blocks setuid escalation) |
| `capabilities.drop` | `["ALL"]` | Removes every Linux capability; add back only the few genuinely needed |
| `seccompProfile.type` | `RuntimeDefault` | Applies the runtime's default syscall filter, blocking dangerous syscalls |
| `readOnlyRootFilesystem` | `true` (strongly recommended) | The container cannot write to its image filesystem; mount an `emptyDir` for the few paths it must write |

`privileged: true`, host namespaces and `hostPath` are the opposite of all of
this and are forbidden by `restricted`.

## Basic example

Tasklane's API container carries the container-level set:

```yaml include="examples/k8s/03-app/api.yaml" lines="123-127"
```

and the pod-level set that applies to every container:

```yaml include="examples/k8s/03-app/api.yaml" lines="42-47"
```

## Explanation

Read the two blocks together. Pod-level `runAsNonRoot`/`runAsUser` and the
seccomp profile establish the identity and syscall filter for the whole pod.
Container-level `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem:
true` and `capabilities.drop: ["ALL"]` lock down what that specific process can
do. Together they satisfy `restricted`: a non-root process, unable to escalate,
with no capabilities, a default seccomp filter and an immutable root filesystem.
Even a remote-code-execution bug in the app now lands in a heavily confined box.

`readOnlyRootFilesystem` deserves emphasis: it defeats a large class of
attacks that rely on writing a payload to disk. When the app needs a writable
path (a cache, `/tmp`), mount a small `emptyDir` there rather than opening the
whole filesystem.

## Common patterns

- **Drop ALL, then add back the minimum.** If a container truly needs to bind a
  low port, add `NET_BIND_SERVICE` — never leave the default set.
- **Non-root images.** Build images with a numeric non-root `USER` (Tasklane
  uses 65532) so `runAsNonRoot` is satisfied without guessing a UID.
- **`readOnlyRootFilesystem` + `emptyDir` for scratch.** Make the exceptions
  explicit and small.
- **Set the whole set on every workload**, including init and sidecar
  containers, which are easy to forget.

## Production considerations

The commonest breakage is an image that expects to run as root or write to its
filesystem. The fix is almost always to change the image, not to relax the
`securityContext`: give it a non-root `USER`, and redirect writes to a mounted
volume. A handful of legacy images cannot be fixed; run those in a `baseline`
namespace with a comment explaining why, rather than weakening a `restricted`
one.

## Security considerations

`securityContext` is enforced by the runtime, and PSA checks it at admission,
so the two reinforce each other: PSA guarantees the fields are present, the
runtime guarantees they take effect. Note the gaps it does **not** close: it
does not stop a container from reaching the network (that is
[NetworkPolicy](network-segmentation.md)), and dropping capabilities still
leaves the shared kernel as attack surface — [user
namespaces](user-namespaces.md) and seccomp narrow that further.

## Troubleshooting

A container that `CrashLoopBackOff`s immediately with a permission error is
usually fighting `readOnlyRootFilesystem` (it wants to write somewhere) or
`runAsNonRoot` (the image's entrypoint assumes root). Check the logs for the
exact path or operation, then mount an `emptyDir` or fix the image's `USER`. A
pod rejected at admission with `violates PodSecurity` is missing one of the
required fields — the message names which.

## Common mistakes

- Omitting `securityContext` and inheriting the image's root defaults.
- Setting the pod level but forgetting container-level `allowPrivilegeEscalation`
  and `capabilities.drop`.
- Relaxing `readOnlyRootFilesystem` instead of mounting a scratch volume.
- Forgetting init and sidecar containers, which need the same fields.
- Adding capabilities back "just in case" rather than only when a failure
  proves one is needed.

## Related topics

- [Pod Security Standards](pod-security-standards.md)
- [User namespaces](user-namespaces.md)
- [Linux capabilities](../foundations/capabilities.md)
- [seccomp](../foundations/seccomp.md)
