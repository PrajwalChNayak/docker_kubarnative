---
title: Version skew policy
description: How far apart Kubernetes components may run — apiserver, kubelet, kube-proxy, controllers and kubectl — and why.
level: advanced
type: reference
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/architecture
---

## Overview

Kubernetes components are versioned independently and upgraded at different
times, so for a window they run different minor versions. The **version skew
policy** defines exactly how far apart they may be and still be supported. It is
the rule that dictates upgrade order (control plane first) and forbids skipping
minors. This page is the quick reference; the numbers are from the official
policy for Kubernetes 1.37.

## The rules

Using **kube-apiserver** as the reference point:

| Component | Allowed skew vs kube-apiserver | Never |
|---|---|---|
| **kube-apiserver** (HA, multiple) | newest and oldest within **1** minor of each other | — |
| **kubelet** | up to **3** minors **older** | never **newer** than the apiserver |
| **kube-proxy** | up to **3** minors older | never newer than the apiserver |
| **kube-controller-manager, kube-scheduler, cloud-controller-manager** | may be **1** minor older | never newer than the apiserver |
| **kubectl** | within **±1** minor (older **or** newer) | more than 1 apart |

Worked examples for an apiserver at **1.37**:

- **kubelet** may be 1.37, 1.36, 1.35 or 1.34. Not 1.38.
- **kubectl** may be 1.36, 1.37 or 1.38.
- **controller-manager / scheduler** may be 1.37 or 1.36. Not 1.38.

Additional detail: **kube-proxy** may be up to 3 minors older or newer than the
**kubelet** it runs beside. A kubelet older than 1.25 may be at most **2**
minors older than the apiserver (historical; irrelevant at 1.37).

## Why it exists and why these numbers

Newer clients and nodes may speak API fields the older apiserver does not
understand, so **nothing may be newer than the apiserver** — the apiserver is
the schema authority, and it must be upgraded first. The kubelet is allowed a
generous **3-minor** lag because nodes are numerous and slow to upgrade in
large fleets; the control-plane controllers get only **1** minor because they
are few and upgraded together with the apiserver. `kubectl` gets ±1 because it
is a client that must interoperate with slightly newer or older servers.

The 3-minor kubelet window is precisely why upgrades go **one minor at a time**
on the control plane while nodes can trail: you can upgrade the control plane
1.34 → 1.35 → 1.36 → 1.37 while nodes are still on 1.34, then bring the nodes up.

:::note HA apiserver narrows everything
In an HA cluster with apiservers themselves skewed by a minor (mid-upgrade), the
allowed range for every other component narrows accordingly — measure skew
against the **oldest** apiserver. Keep the apiserver-to-apiserver skew to at
most one minor.
:::

## How this drives upgrades

- **Order:** apiserver → other control-plane components → kubelets/kube-proxy.
- **Cadence:** one minor per control-plane step; never skip.
- **Clients:** upgrade `kubectl` alongside, staying within ±1.

See [cluster upgrades](cluster-upgrades.md) for the full procedure.

## Common mistakes

- Upgrading a kubelet (or `kubectl`) to a version **newer** than the apiserver.
- Skipping a minor on the control plane because "the skew allows 3" — that limit
  is for the **kubelet**, not the apiserver, which moves one minor at a time.
- Running the scheduler or controller-manager a minor **newer** than the
  apiserver after a partial upgrade.
- Assuming a `kubectl` 2+ minors from the server is fine; it is unsupported and
  can misbehave on newer fields.

## Related topics

- [Cluster upgrades](cluster-upgrades.md)
- [Deprecated API detection](deprecated-api-detection.md)
- [High availability control plane](high-availability-control-plane.md)
- [Architecture](../k8s-beginner/architecture.md)
