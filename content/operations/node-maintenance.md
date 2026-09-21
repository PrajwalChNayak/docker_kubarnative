---
title: Node maintenance
description: Cordon, drain with PodDisruptionBudgets and --ignore-daemonsets, uncordon, and surge/blue-green node replacement.
level: advanced
type: tutorial
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-intermediate/pod-disruption-budgets
  - operations/cluster-upgrades
---

## Overview

Nodes need maintenance — kernel patches, kubelet upgrades, hardware fixes — and
doing it without dropping the apps on them is a core operational skill. The tools
are **cordon** (stop scheduling new pods), **drain** (evict the pods that are
there, safely), and **uncordon** (return the node to service). The safety comes
from **PodDisruptionBudgets**, which cap how much of an app may be down at once.

## Why it exists

Deleting a pod is easy; deleting *the right number at the right time* is not. If
you evict all of an app's replicas at once, you cause an outage. Drain plus PDBs
turn "take this node down" into "take it down without violating any app's
availability guarantee", and the machinery blocks you rather than let you break
it.

## How cordon and drain work

- **Cordon** sets `.spec.unschedulable: true` on the Node. The scheduler places
  no new pods there; existing pods keep running.
- **Drain** cordons the node *and* evicts its pods using the **Eviction API**,
  which respects PodDisruptionBudgets. If evicting a pod would push an app below
  its PDB's `minAvailable`, the eviction is **denied** and drain **waits** and
  retries. That blocking is the safety feature, not a bug.
- DaemonSet pods cannot be drained (they are recreated on the node immediately),
  so drain refuses unless you pass `--ignore-daemonsets`.

## Step 0 — Check the PDBs first

```bash
kubectl -n tasklane get pdb
```

```console include="captures/operations/ops-pdb.txt"
```

A PDB like `minAvailable: 1` on a 2-replica Deployment means drain moves **one**
replica at a time. If no PDB exists, drain will happily evict every replica at
once — so define PDBs for every app that matters *before* you need to drain.

## Step 1 — Drain the node

```bash
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data
```

Preview what it would do without touching anything:

```console include="captures/operations/ops-cordon-drain-dryrun.txt"
```

- `--ignore-daemonsets` — required; DaemonSet pods stay.
- `--delete-emptydir-data` — required if any pod uses an `emptyDir`, and
  acknowledges that its contents are lost.
- Drain streams evictions and blocks while a PDB would be violated. If it hangs,
  a PDB is doing its job (or is too strict — see troubleshooting).

Tasklane's API and worker each run 2 replicas; with a `minAvailable: 1` PDB,
drain relocates one replica, waits for its replacement to become Ready
elsewhere, then relocates the second — no outage.

## Step 2 — Do the maintenance

The node is now cordoned and empty of movable pods. Patch the OS, upgrade the
kubelet (see [cluster upgrades](cluster-upgrades.md)), reboot — whatever the task
is. The scheduler will not place work here while it is cordoned.

## Step 3 — Uncordon

```bash
kubectl uncordon <node>
```

This clears `unschedulable`, and the scheduler starts placing pods on the node
again. Note existing pods do **not** automatically rebalance back; the node fills
as new pods are scheduled or as other nodes are drained.

## Surge / blue-green node replacement

For OS or kubelet upgrades at scale, in-place drains are often replaced by
**node replacement**: add fresh nodes on the new version (surge), drain and
delete the old ones, so capacity never dips. **Blue-green** goes further —
stand up a whole new node pool, shift workloads, keep the old pool until you are
confident, then delete it. Advantages:

- No capacity dip during the operation (surge adds before removing).
- Easy rollback: keep the old pool until verified.
- It is the default model on managed platforms and with node autoscalers like
  Karpenter, which routinely replace nodes rather than patch them in place.

The trade-off is transient extra cost (running both sets briefly) and needing
the automation to move workloads cleanly — which is exactly what PDBs and
graceful termination provide.

## Troubleshooting

- **Drain hangs forever:** a PDB with `minAvailable` equal to the replica count
  (or `maxUnavailable: 0`) can never allow an eviction. Relax the PDB or add
  replicas.
- **Drain refuses immediately:** DaemonSet pods without `--ignore-daemonsets`,
  or emptyDir pods without `--delete-emptydir-data`.
- **Pods reschedule to the same node:** you drained but did not cordon (use
  `drain`, which cordons), or the node was uncordoned too early.
- **Evicted pods can't start elsewhere:** the cluster lacks capacity for the
  relocated pods; add a node first (this is why surge exists).

## Common mistakes

- Draining with no PDB, evicting every replica at once and causing an outage.
- Setting a PDB so strict (`maxUnavailable: 0`) that drain can never proceed.
- Forgetting `--ignore-daemonsets` / `--delete-emptydir-data` and being confused
  when drain refuses.
- `kubectl delete pod` or `kubectl delete node` instead of draining, bypassing
  PDBs and graceful termination.
- Uncordoning before maintenance is finished, so the scheduler places work on a
  node about to reboot.

## Related topics

- [Pod disruption budgets](../k8s-intermediate/pod-disruption-budgets.md)
- [Cluster upgrades](cluster-upgrades.md)
- [Capacity planning](capacity-planning.md)
- [Pod lifecycle and termination](../k8s-intermediate/pod-lifecycle-and-termination.md)
