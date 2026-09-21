---
title: Cluster upgrades
description: Upgrade a kubeadm cluster one minor at a time — control plane before nodes, respecting version skew, PDBs and drain.
level: expert
type: tutorial
status: current
versions: Kubernetes 1.37
prerequisites:
  - operations/version-skew-policy
  - operations/deprecated-api-detection
  - operations/etcd-backup-and-restore
---

## Overview

Upgrading Kubernetes is routine but unforgiving: do it in the wrong order, skip
a minor, or ignore a PodDisruptionBudget and you can take the cluster or an app
down. This tutorial walks a safe **minor** upgrade of a self-managed
(kubeadm) cluster — the model behind CKA and behind most on-prem clusters.
Managed control planes (EKS/GKE/AKS) hide the control-plane steps but keep the
same node and skew rules.

The lab is a kind cluster, which upgrades by recreating nodes from a new image,
so treat the kubeadm/etcd commands here as the real-node shape. The full command
sequence lives in the example:

- [examples/operations/upgrade/README.md](../../examples/operations/upgrade/README.md)

## The non-negotiable rules

- **One minor at a time.** 1.35 → 1.36 → 1.37. The version skew policy forbids
  jumping minors on the control plane.
- **Control plane before nodes.** kube-apiserver is upgraded first; kubelets may
  lag by up to **3** minors and must never be newer. See
  [version skew](version-skew-policy.md).
- **Read every minor's release notes**, especially deprecations and any
  **urgent-upgrade** notes (a release occasionally has a "you must do X before
  upgrading" warning).
- **Back up etcd first.** See [etcd backup and restore](etcd-backup-and-restore.md).

:::warning Containerd 1.x cutoff
Kubernetes **1.35 was the last release to support containerd 1.x**; containerd
**2.0+** is required before upgrading to 1.36. Watch the
`kubelet_cri_losing_support` metric on the way up. This is exactly the kind of
release-note detail that bites clusters that skip the notes.
:::

## Step 1 — Pre-flight: scan for deprecated APIs

Before touching versions, make sure nothing you run calls an API the target
minor removes. No API versions were removed in 1.33–1.37, but the discipline is
what saves you at the minor that finally removes one. Scan manifests and live
objects with Pluto, and watch the apiserver's own deprecation signal:

```bash
pluto detect-files -d examples/
kubectl get --raw /metrics | grep apiserver_requested_deprecated_apis
```

```console include="captures/operations/ops-deprecated-apis-metric.txt"
```

See [deprecated API detection](deprecated-api-detection.md) for the full method.

## Step 2 — Back up etcd

```bash
kubectl -n kube-system exec etcd-<cp-node> -- etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  snapshot save /var/lib/etcd/snapshot.db
```

A snapshot is your rollback if the upgrade corrupts state. Verify it before
proceeding.

## Step 3 — Upgrade the control plane

```bash
# Upgrade the kubeadm binary to the target minor, then:
sudo kubeadm upgrade plan          # shows the component versions it will move to
sudo kubeadm upgrade apply v1.37.0 # upgrades apiserver, controller-manager, scheduler, etcd
```

`kubeadm upgrade apply` also **renews the control-plane certificates**
automatically (they have a 1-year life — see
[certificate rotation](certificate-rotation.md)). On additional control-plane
nodes run `kubeadm upgrade node`. After the binaries move, upgrade the kubelet
and kubectl packages on the control-plane node and restart the kubelet.

## Step 4 — Upgrade nodes, one at a time, respecting PDBs

Drain each worker before upgrading its kubelet. `drain` cordons the node
(marks it unschedulable) and evicts pods, but **honours PodDisruptionBudgets** —
it blocks rather than violate one, which is the safety mechanism:

```bash
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data
```

```console include="captures/operations/ops-cordon-drain-dryrun.txt"
```

`--ignore-daemonsets` is required because DaemonSet pods are recreated on the
node and cannot be gracefully drained. `--delete-emptydir-data` acknowledges
that emptyDir contents are lost. With the node drained, upgrade its kubeadm and
kubelet, restart the kubelet, then return it to service:

```bash
kubectl uncordon <node>
```

Move to the next node only after the previous one is `Ready` and its pods are
rescheduled. Tasklane's API sets `maxUnavailable: 0` and both API and worker run
2 replicas, so a PDB of `minAvailable: 1` lets one replica move at a time
without an outage. See [node maintenance](node-maintenance.md) and
[pod disruption budgets](../k8s-intermediate/pod-disruption-budgets.md).

## Step 5 — Verify

```bash
kubectl get nodes -o wide          # all nodes on the new version, Ready
kubectl -n tasklane get pods       # app healthy and rescheduled
kubeadm certs check-expiration     # certs renewed
```

```console include="captures/operations/ops-nodes-wide.txt"
```

## Rollback thinking

Minor upgrades are **not** cleanly reversible — kubeadm does not "downgrade
apply", and API objects may have been migrated to newer storage versions. Your
real rollback is the etcd snapshot plus rebuilding the control plane at the old
version, which is disruptive. This is why the pre-flight scan, the etcd backup,
and going one minor at a time matter so much: prevention is the strategy, not
undo.

## Node-replacement alternative

Rather than in-place drains, bring up a **new node pool** on the target version,
drain and delete the old pool (surge / blue-green). It rolls back by keeping the
old pool until you are satisfied, and it is the default model on managed
platforms and with tools like Karpenter.

## Common mistakes

- Skipping a minor (1.35 → 1.37) — forbidden by the skew policy and unsupported.
- Upgrading kubelets before the apiserver, producing a kubelet newer than the
  control plane.
- Not reading release notes and missing an urgent-upgrade note (e.g. the
  containerd 2.0 requirement before 1.36).
- Draining with a too-strict or missing PDB, causing either an outage or a
  drain that never completes.
- No etcd backup, so a failed upgrade has no recovery point.
- Forgetting `--ignore-daemonsets`, so drain refuses to proceed.

## Related topics

- [Version skew policy](version-skew-policy.md)
- [Deprecated API detection](deprecated-api-detection.md)
- [etcd backup and restore](etcd-backup-and-restore.md)
- [Certificate rotation](certificate-rotation.md)
- [Node maintenance](node-maintenance.md)
- [Pod disruption budgets](../k8s-intermediate/pod-disruption-budgets.md)
