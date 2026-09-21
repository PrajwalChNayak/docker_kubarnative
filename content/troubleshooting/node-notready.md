---
title: Node NotReady
description: Why a node goes NotReady — a down kubelet, CNI not ready, disk or PID pressure, expired certificates or a dead container runtime — and how to read node conditions and taints.
level: advanced
type: troubleshooting
status: current
versions: Kubernetes 1.37
prerequisites:
  - troubleshooting/method
  - k8s-beginner/architecture
  - operations/node-maintenance
---

## Overview

A `NotReady` node is one the control plane can no longer trust to run pods. The
node's `Ready` condition is set by its **kubelet**; when the kubelet stops
reporting, or reports a problem, the node goes `NotReady`, the scheduler stops
placing new pods there, and after a grace period the node's pods are evicted and
rescheduled. This page maps the causes — kubelet down, CNI not ready, node
pressure, expired certificates, runtime down — to their evidence in node
conditions and taints.

## Symptoms

- `kubectl get nodes` shows `STATUS: NotReady` (or `Unknown`) for a node.
- Pods on that node become `NodeLost`/`Terminating` or are rescheduled after the
  eviction timeout; some may stick `Terminating`.
- `kubectl describe node` shows `Ready: False` or `Ready: Unknown` with a
  message, plus condition flags like `MemoryPressure`, `DiskPressure`,
  `PIDPressure`, or `NetworkUnavailable`.

## How it works underneath

The kubelet posts a heartbeat by updating a `Lease` object
(`coordination.k8s.io/v1`) in `kube-node-lease` and setting the node's `Ready`
condition. The node controller watches these:

- If the kubelet stops updating its lease, after ~40s the node controller marks
  `Ready: Unknown` and adds the taint `node.kubernetes.io/unreachable`.
- After the eviction timeout (default ~5 minutes), pods are evicted/rescheduled.

The `Ready` condition is `False` (kubelet is up but unhealthy) or `Unknown`
(kubelet is not reporting at all). The distinction tells you where to look:

| Cause | Evidence |
|---|---|
| **kubelet down/crashed** | `Ready: Unknown`; node unreachable; `journalctl -u kubelet` on the node |
| **Container runtime down** | kubelet up but `Ready: False`; kubelet log: `container runtime is down`; `crictl` fails |
| **CNI not ready** | `NetworkUnavailable: True` or kubelet log about no CNI config; new pods stuck `ContainerCreating` |
| **Disk pressure** | `DiskPressure: True`; the node evicts pods; imagefs/nodefs full |
| **Memory/PID pressure** | `MemoryPressure`/`PIDPressure: True` |
| **Certificate expiry** | kubelet/API TLS errors in the kubelet log; see [certificate expiry](certificate-expiry.md) |

Kubernetes automatically applies **taints** for these conditions
(`node.kubernetes.io/not-ready`, `.../unreachable`, `.../disk-pressure`,
`.../memory-pressure`, `.../pid-pressure`, `.../network-unavailable`), which is
why pods without the matching tolerations are evicted and not rescheduled there.

## Diagnosis

1. **Read the node conditions and taints.**

   ```bash
   kubectl describe node <node> | grep -A8 Conditions
   kubectl get node <node> -o jsonpath='{.spec.taints}{"\n"}'
   ```

2. **Ready: Unknown ⇒ the node is unreachable.** Get onto it (SSH, or for kind
   `docker exec -it <node-container> sh`) and check the kubelet:

   ```bash
   systemctl status kubelet
   journalctl -u kubelet --no-pager | tail -50
   ```

3. **Check the container runtime** from the node:

   ```bash
   crictl info
   crictl ps
   ```

   Errors here mean the runtime (containerd) is down — the kubelet cannot run
   anything.

4. **Check disk and PIDs** on the node:

   ```bash
   df -h
   ```

   A full `/var/lib/containerd` or `/var/lib/kubelet` drives `DiskPressure`.

5. **CNI**: new pods stuck `ContainerCreating` with `NetworkUnavailable` point at
   the CNI DaemonSet:

   ```bash
   kubectl -n kube-system get pods -o wide | grep -Ei 'cni|kindnet|calico|cilium'
   ```

## Fixes

- **kubelet down.** Restart it (`systemctl restart kubelet`) after reading its
  log; fix the root cause (bad config, expired cert, full disk) rather than
  restarting blindly.
- **Runtime down.** Restart containerd; check its log and disk. The kubelet
  recovers once the runtime is healthy.
- **CNI not ready.** Fix or restart the CNI DaemonSet pod on the node; confirm
  the CNI config is present under `/etc/cni/net.d`.
- **Disk/PID/memory pressure.** Free space (prune images/logs), add capacity, or
  set `ephemeral-storage` limits so pods cannot fill the node — see
  [Evicted pods](evicted-pods.md). Once the signal clears, the condition and
  taint are removed automatically.
- **Certificate expiry.** Renew the kubelet/API certificates — see
  [certificate expiry](certificate-expiry.md).
- **Drain before maintenance.** For planned work, `kubectl drain <node>` moves
  pods off gracefully; `kubectl uncordon <node>` returns it to service. See
  [node maintenance](../operations/node-maintenance.md).

## Prevention

- Monitor node conditions and the kubelet heartbeat/lease; alert on `NotReady`
  and on pressure conditions before they cascade.
- Reserve resources for system components (`--system-reserved`,
  `--kube-reserved`) so node daemons are not starved into failure.
- Keep certificates rotating well before expiry (see certificate rotation in
  operations).
- Bound pod disk usage with `ephemeral-storage` limits and log rotation.
- Use `drain`/`cordon` for maintenance instead of yanking nodes.

## Common mistakes

- Restarting the kubelet without reading its log, so the real cause (full disk,
  expired cert) recurs immediately.
- Confusing `Ready: False` (kubelet up, unhealthy) with `Ready: Unknown` (kubelet
  not reporting) — they lead to different places.
- Ignoring `NetworkUnavailable` and debugging the app instead of the CNI.
- Forgetting that node-condition taints are why pods will not reschedule there.
- Letting node disk fill from images and logs until `DiskPressure` takes the node
  out.

## Related topics

- [A method for debugging Kubernetes](method.md)
- [Evicted pods](evicted-pods.md)
- [Certificate expiry](certificate-expiry.md)
- [Stuck terminating namespace](stuck-terminating-namespace.md)
- [Kubernetes architecture](../k8s-beginner/architecture.md)
- [Node maintenance](../operations/node-maintenance.md)
