---
title: Evicted pods
description: How the kubelet evicts pods under node memory, disk or PID pressure, why ephemeral-storage limits matter, and how QoS and priority decide who goes first.
level: advanced
type: troubleshooting
status: current
versions: Kubernetes 1.37
prerequisites:
  - troubleshooting/method
  - k8s-intermediate/qos-classes
  - k8s-intermediate/resources-requests-limits
---

## Overview

An `Evicted` pod was deleted from a node by the **kubelet** to relieve node-level
resource pressure — memory, disk or process IDs. This is a different mechanism
from a container being `OOMKilled` by its cgroup limit: eviction is the kubelet
reclaiming a whole node, and it chooses victims by QoS class and how far each pod
is over its requests. This page covers the thresholds, the ordering, and the
frequently missed cause: ephemeral-storage.

## Symptoms

- `kubectl get pods` shows pods with `STATUS: Evicted`, often several at once on
  the same node.
- `describe pod` shows `Status: Failed, Reason: Evicted` and a message such as
  `The node was low on resource: memory` or
  `The node was low on resource: ephemeral-storage. Container ... was using ...`.
- The node briefly shows a condition: `MemoryPressure: True`,
  `DiskPressure: True`, or `PIDPressure: True`.
- Evicted pod objects linger in the API (they are not auto-deleted) until you or
  a controller removes them.

## How it works underneath

The kubelet continuously compares node resource availability against configured
**eviction thresholds** and, when a signal crosses its threshold, reclaims
resources — first by garbage-collecting images and dead containers, then by
evicting pods.

Signals and their default-ish thresholds (they are configurable per kubelet):

| Signal | Node condition | Typical hard threshold |
|---|---|---|
| `memory.available` | `MemoryPressure` | `100Mi` |
| `nodefs.available` (root/kubelet disk) | `DiskPressure` | `10%` |
| `imagefs.available` (image/container layers) | `DiskPressure` | `15%` |
| `nodefs.inodesFree` | `DiskPressure` | varies |
| `pid.available` | `PIDPressure` | configurable |

The kubelet distinguishes **soft** eviction (a threshold plus a grace period,
respecting `terminationGracePeriodSeconds`) from **hard** eviction (immediate,
no grace).

### Who is evicted first

For an **incompressible** resource like memory or disk, the kubelet ranks pods:

1. Whether the pod exceeds its **requests** for the starved resource.
2. The pod's **priority** (higher priority is evicted later).
3. How much the pod is using over its request.

By QoS: `BestEffort` pods (no requests/limits) go first, then `Burstable` pods
using more than they requested, and `Guaranteed` pods (requests == limits) last.
System-critical DaemonSets set a high `priorityClassName` so they are near the
end of the line.

### Ephemeral-storage is the surprise

Pods consume node disk through container writable layers, `emptyDir` volumes and
logs. If a pod writes a lot to its container filesystem or an `emptyDir` and the
node crosses the disk threshold, the kubelet evicts pods — and a pod that exceeds
its `ephemeral-storage` **limit** is evicted specifically for that. Setting
`resources.limits.ephemeral-storage` bounds a single pod so one log-spewing
container cannot fill the node and take neighbours down with it. This is the
disk analogue of a memory limit.

## Diagnosis

1. **Confirm eviction and the resource.**

   ```bash
   kubectl -n <ns> get pod <pod> -o jsonpath='{.status.reason}{" "}{.status.message}{"\n"}'
   ```

2. **Find the pressured node and its conditions.**

   ```bash
   kubectl get pods -o wide | grep Evicted
   kubectl describe node <node> | grep -A6 Conditions
   ```

3. **See what is consuming the resource.**

   ```bash
   kubectl top pods --all-namespaces --sort-by=memory
   kubectl describe node <node> | grep -A10 "Allocated resources"
   ```

   For disk, inspect the node filesystem (`kubectl debug node/<node>` then `df -h`
   and `du` under the kubelet and container directories).

4. **Check for a flood of evicted pods** left behind:

   ```bash
   kubectl get pods --all-namespaces --field-selector status.phase=Failed
   ```

## Fixes

- **Right-size requests.** Pods evicted for exceeding memory/disk requests need
  honest requests. `Guaranteed` QoS (requests == limits) protects critical pods.
- **Set `ephemeral-storage` requests and limits** on anything that writes to
  disk, so one pod cannot starve the node.
- **Relieve the node.** Add capacity, spread the workload, or move disk-heavy
  pods to a node pool with more disk.
- **Cap logs and temp data.** Bound application log volume and `emptyDir` sizes
  (`sizeLimit`), and rotate logs.
- **Clean up evicted objects.** Delete lingering `Evicted` pods; a small
  controller or `kubectl delete pods --field-selector status.phase=Failed`
  keeps the list tidy.
- **Protect system pods** with a high `priorityClassName` and appropriate
  tolerations.

## Prevention

- Give every production pod memory and ephemeral-storage **requests and limits**.
- Reserve resources for the system with kubelet `--system-reserved` /
  `--kube-reserved` so node daemons are not starved.
- Alert on node conditions (`MemoryPressure`, `DiskPressure`, `PIDPressure`) and
  on `imagefs`/`nodefs` free space, before eviction cascades.
- Keep image and log growth in check on nodes (see
  [Docker build cache and disk exhaustion](docker-disk-exhaustion.md) for the
  same problem on a build host).

## Common mistakes

- Confusing `Evicted` (kubelet reclaiming the node) with `OOMKilled` (cgroup
  limit on one container).
- Forgetting `ephemeral-storage` limits, so a log flood evicts healthy
  neighbours.
- Running critical pods as `BestEffort`, putting them first in line for
  eviction.
- Leaving hundreds of `Evicted` pod objects around and mistaking them for an
  ongoing outage.
- Raising limits without adding node capacity, so the node just hits pressure
  again.

## Related topics

- [A method for debugging Kubernetes](method.md)
- [OOMKilled](oomkilled.md)
- [Node NotReady](node-notready.md)
- [Docker build cache and disk exhaustion](docker-disk-exhaustion.md)
- [QoS classes](../k8s-intermediate/qos-classes.md)
- [Resources: requests and limits](../k8s-intermediate/resources-requests-limits.md)
