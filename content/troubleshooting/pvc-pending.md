---
title: PVC stuck Pending
description: Why a PersistentVolumeClaim never binds — no matching PV, WaitForFirstConsumer, a missing or wrong StorageClass, a down provisioner, or an access-mode, capacity or topology mismatch.
level: intermediate
type: troubleshooting
status: current
versions: Kubernetes 1.37
prerequisites:
  - troubleshooting/method
  - k8s-intermediate/persistent-volumes-and-claims
  - k8s-intermediate/storage-classes-and-csi
---

## Overview

A `PersistentVolumeClaim` in `Pending` has not been bound to a
`PersistentVolume`, and any pod that mounts it stays Pending too, waiting for
the volume. There are two families of cause: dynamic provisioning failed (bad or
missing StorageClass, provisioner down), or static binding found no matching PV
(access mode, capacity or topology mismatch). One case is not a bug at all —
`WaitForFirstConsumer` PVCs are Pending by design until a pod schedules.

## Symptoms

- `kubectl get pvc` shows `STATUS: Pending` and no `VOLUME`.
- A pod that uses the PVC is `Pending` with a `describe` message about the volume
  not being bound.
- `describe pvc` Events say `storageclass.storage.k8s.io "..." not found`,
  `no persistent volumes available for this claim`, or `waiting for a volume to
  be created`.

Reproducer (a StorageClass name that does not exist):

```yaml include="examples/troubleshooting/pvc-pending.yaml"
```

```console include="captures/troubleshooting/pvc-pending.txt"
```

## How it works underneath

A PVC asks for storage by `accessModes`, `resources.requests.storage`, an
optional `storageClassName`, and optional selectors. Binding happens one of two
ways:

- **Dynamic provisioning.** The named `StorageClass` has a `provisioner`; its
  external CSI provisioner watches for Pending PVCs referencing that class,
  creates a real volume, makes a matching PV, and binds them. The lab uses
  `local-path` (`rancher.io/local-path`).
- **Static binding.** With no dynamic provisioner, the control plane looks for an
  existing PV that satisfies the claim (mode, size, class, selector) and binds
  it. No match ⇒ Pending.

Causes of a Pending PVC:

| Cause | Signal |
|---|---|
| StorageClass does not exist | `storageclass "..." not found` (the reproducer) |
| No default class and none named | claim has empty `storageClassName` and there is no default class |
| Provisioner down | class exists but no PV appears; the provisioner pod is unhealthy |
| `WaitForFirstConsumer` | **normal**: PVC stays Pending until a pod using it is scheduled |
| Access-mode mismatch | no PV/class offers the requested mode (e.g. `ReadWriteMany` on a class that only does `ReadWriteOnce`) |
| Capacity/selector mismatch (static) | no PV is large enough or matches the selector |
| Topology conflict | the volume's zone does not match where the pod can run |

### WaitForFirstConsumer is not a bug

Many CSI drivers, including `local-path`, set `volumeBindingMode:
WaitForFirstConsumer`. Such a PVC **stays Pending on purpose** until a pod that
mounts it is scheduled, so the volume is provisioned in the same topology
(node/zone) as the pod. If your PVC is Pending and has no pod yet, and the class
is `WaitForFirstConsumer`, that is expected — create the consumer pod and watch
it bind. Do not "fix" it.

## Diagnosis

1. **Read the PVC events.**

   ```bash
   kubectl -n <ns> describe pvc <pvc>
   ```

   The message names the exact cause: missing class, no volume, or waiting for a
   consumer.

2. **List StorageClasses** and note the default (marked `(default)`) and each
   class's binding mode:

   ```bash
   kubectl get storageclass
   ```

3. **Check the binding mode** of the referenced class:

   ```bash
   kubectl get storageclass <class> -o jsonpath='{.volumeBindingMode}{"\n"}'
   ```

   `WaitForFirstConsumer` + no pod ⇒ create the pod, not a fix.

4. **Check the provisioner** if the class exists but nothing binds: is the CSI
   controller/provisioner pod healthy?

   ```bash
   kubectl -n kube-system get pods | grep -i provisioner
   ```

## Fixes

- **Missing/wrong StorageClass.** Set `storageClassName` to a class that exists
  (from `kubectl get storageclass`), or leave it unset to use the default class,
  or create the class.
- **No default class.** Mark one class default
  (`storageclass.kubernetes.io/is-default-class: "true"`), or always name a
  class explicitly.
- **Provisioner down.** Restore the CSI provisioner; its logs will show why it
  cannot create volumes.
- **WaitForFirstConsumer.** Create the consuming pod; the PVC binds when the pod
  schedules. This is the fix that is "do nothing to the PVC."
- **Access-mode/capacity/topology mismatch.** Request a mode/size the class
  supports, or provision a PV/class that offers it. `ReadWriteMany` needs a
  driver that supports it (NFS, CephFS); most block storage is `ReadWriteOnce`.

## Prevention

- Always name a StorageClass explicitly, or ensure the cluster has a sensible
  default; do not rely on ambient defaults across clusters.
- Know your class's `volumeBindingMode` so a by-design Pending is not mistaken
  for a fault.
- Request only access modes the underlying storage supports; do not ask for
  `ReadWriteMany` on block storage.
- Monitor the CSI provisioner's health; a Pending PVC storm often means the
  provisioner is down.

## Common mistakes

- Treating a `WaitForFirstConsumer` Pending PVC as broken and deleting it.
- Referencing a StorageClass name that does not exist (a typo, or a name from a
  different cluster).
- Requesting `ReadWriteMany` from a class that only offers `ReadWriteOnce`.
- Assuming a default StorageClass exists when it does not.
- Blaming the pod when the real block is an unbound volume.

## Related topics

- [A method for debugging Kubernetes](method.md)
- [Pending pods](pending-pods.md)
- [Persistent volumes and claims](../k8s-intermediate/persistent-volumes-and-claims.md)
- [Storage classes and CSI](../k8s-intermediate/storage-classes-and-csi.md)
