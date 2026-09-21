---
title: User namespaces
description: hostUsers false (GA in 1.36) maps container root to an unprivileged host UID, so a container breakout lands as nobody rather than node root.
level: expert
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-security/security-context
  - foundations/linux-namespaces
---

## Overview

A pod **user namespace** remaps the user IDs inside the container to a
different, unprivileged range on the host. Root in the container (UID 0) becomes
some high, harmless UID on the node. It is enabled per pod with
`hostUsers: false` and went **GA in Kubernetes 1.36** (`UserNamespacesSupport`).
It closes the gap that `runAsNonRoot` cannot: even a process that *is* root in
the container is not root on the host.

## Why it exists and when to use it

`securityContext` narrows what a container can do; user namespaces change **who
it is** from the kernel's point of view. Use it for workloads that legitimately
need to be root inside the container (some system tools, images that cannot be
made non-root) and for defence in depth on anything sensitive. It is the strong
mitigation for the class of container-escape and capability bugs where the
attacker relies on being real root on the node.

## How it works underneath

With `hostUsers: false`, the kubelet allocates a range of subordinate UIDs/GIDs
on the node and maps the container's 0–65535 onto that range. Inside the
container everything looks normal — the process sees itself as root and can
`chown`, use its (namespaced) capabilities, and so on. Outside, on the node,
that same process owns files as an unprivileged UID and its capabilities are
scoped to the user namespace, so they do not apply to host-owned resources.

What this mitigates:

- **Container breakout to node root.** A process that escapes its container
  lands as an unprivileged host user, not UID 0, dramatically shrinking what it
  can touch.
- **Capability-based escapes.** Capabilities held inside the namespace do not
  grant power over resources owned outside it.
- **hostPath and shared-file risks** where root-in-container would otherwise map
  to root-on-host.

It does **not** replace the rest of the `securityContext`: it composes with
non-root, dropped capabilities and seccomp rather than substituting for them.

## Basic example

```yaml title="pod-userns.yaml" fragment
apiVersion: v1
kind: Pod
metadata:
  name: userns-demo
  namespace: tasklane
spec:
  hostUsers: false          # remap container UIDs to unprivileged host UIDs
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: app
      image: busybox:1.37
      command: ["sleep", "3600"]
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
```

## Explanation

`hostUsers: false` is the only new field; everything else is the standard
`restricted` set. The point is that the two layers stack: if some bug let this
container regain privileges *inside* its namespace, the user-namespace mapping
still keeps those privileges from meaning anything on the node. This snippet is
a fragment for illustration — the runnable, harness-checked manifests live in
`examples/`.

## Common patterns

- **Pair it with the full `securityContext`.** User namespaces are a backstop,
  not a reason to relax non-root or capability dropping.
- **Use it to run legitimately-root images safely** rather than granting them a
  `baseline`/`privileged` namespace.
- **Roll it out gradually**, since some volume types and workloads have specific
  requirements around ID mapping.

## Production considerations

The feature is GA, but it interacts with storage: volumes must support ID
mapping for the remapped UIDs to own files correctly, and the node needs enough
subordinate ID space allocated. Test stateful workloads carefully. A related but
**separate** feature, **kubelet-in-userns** (`KubeletInUserNamespace`, Beta and
on by default in 1.37), lets the kubelet itself run inside a user namespace for
rootless Kubernetes; enabling that gate does **not** by itself make the kubelet
rootless, and it is not the same thing as pod `hostUsers: false`.

## Security considerations

User namespaces meaningfully reduce breakout blast radius, which is why they are
worth enabling on sensitive tenants even when pods are already non-root — a
kernel bug that grants root-in-container is neutralised. They are not a
substitute for keeping the kernel patched, dropping capabilities, or network
segmentation; they shrink one specific and severe failure mode.

## Troubleshooting

If a pod with `hostUsers: false` cannot write to a volume, the volume driver
likely does not support ID mapping for the remapped range, or `fsGroup` is
fighting the mapping — test with an `emptyDir` first to isolate storage from the
namespace change. If the field appears to be ignored, confirm the cluster is
1.36+ (GA) so the feature is available without a gate.

## Common mistakes

- Treating `hostUsers: false` as a replacement for `runAsNonRoot` and dropped
  capabilities rather than an addition to them.
- Enabling it for stateful workloads without testing volume ID mapping.
- Confusing pod user namespaces with the separate kubelet-in-userns feature.

## Related topics

- [Security context](security-context.md)
- [Linux namespaces](../foundations/linux-namespaces.md)
- [Privileged pod escape, and how to close it](attack-privileged-pod-escape.md)
- [Pod Security Standards](pod-security-standards.md)
