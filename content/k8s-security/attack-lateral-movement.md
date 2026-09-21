---
title: Lateral movement, and how to close it
description: A defensive analysis of pod-to-pod lateral movement in a flat cluster network, and how default-deny NetworkPolicy contains it.
level: expert
type: reference
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-security/network-segmentation
  - k8s-intermediate/network-policy
---

## Overview

This page analyses **lateral movement** — how one compromised pod reaches others
across the cluster's flat network — and how default-deny NetworkPolicy contains
it. It is defensive: the focus is the reachability an attacker inherits and the
control that removes it, verified with a simple connectivity probe.

:::danger
Everything here runs only in the disposable local **kind** lab. The probe pods
exist to demonstrate that segmentation blocks reachability. Never run these
against a shared or production cluster.
:::

## Threat model

- **Precondition.** A namespace (or cluster) has **no NetworkPolicy**, so the
  default flat network applies: every pod can reach every other pod on every
  port.
- **Adversary.** A compromised workload — the entry point, however it was
  breached.
- **Asset at risk.** Every service reachable over the network: databases, admin
  and metrics ports, other tenants' workloads, and in-cluster control-plane
  services.

## The path, at the level of capability

Once an attacker controls one pod, the flat network is their map. Without
policies, that pod can open a connection to **anything** — scan the namespace and
neighbouring namespaces, reach a database that trusts in-cluster traffic, hit an
unauthenticated admin or metrics endpoint, or call the cloud metadata service.
The single compromised pod becomes a launch point for reaching the assets that
actually matter. Nothing here is an exploit; it is simply reachability nobody
intended, because the absence of a policy *is* the vulnerability.

## Controls that break the path

1. **Default-deny per namespace.** A policy selecting all pods and denying both
   ingress and egress turns the flat network into deny-by-default. This is the
   primary control.
2. **Narrow explicit allows.** Re-open only the flows the application needs — DNS
   egress, and one path per real dependency — so the compromised pod can reach
   nothing else.
3. **Egress control** specifically, to stop a compromised pod calling out to the
   metadata endpoint or the internet for a second stage.
4. **A CNI that actually enforces NetworkPolicy** — verify this, because an
   unenforcing CNI turns every policy into a silent no-op.

The default-deny baseline:

```yaml include="examples/security/k8s/missing-networkpolicy/fixed-networkpolicy.yaml" lines="13-22"
```

## Verify reachability is blocked

Deploy the workloads, apply default-deny, and probe from a pod the policy does
**not** allow. It should time out:

```bash
kubectl apply -f examples/security/k8s/missing-networkpolicy/namespace.yaml
kubectl apply -f examples/security/k8s/missing-networkpolicy/workloads.yaml
kubectl apply -f examples/security/k8s/missing-networkpolicy/fixed-networkpolicy.yaml
kubectl -n netpol-demo exec client-denied -- \
  wget -qO- --timeout=3 http://server:8080/
```

```console include="captures/k8s-security/netpol-denied-probe.txt"
```

A timeout and non-zero exit on `client-denied`, while `client-allowed` still
connects, is the proof the lateral path is closed. If `client-denied` *can* still
reach the server, the CNI is not enforcing NetworkPolicy — the first thing to
check.

## Common mistakes

- Assuming the cluster is segmented when no policy exists — the default is fully
  open.
- Applying policies on a CNI that does not enforce them and never probing.
- Writing ingress rules but no egress, leaving outbound movement open.
- Leaving some pods unselected by any policy, so they stay reachable.
- Forgetting to allow DNS and breaking the app instead of just the attacker.

## Related topics

- [Network segmentation](network-segmentation.md)
- [NetworkPolicy (intermediate)](../k8s-intermediate/network-policy.md)
- [Network model and CNI](../k8s-intermediate/network-model-and-cni.md)
- [Common attack paths](common-attack-paths.md)
