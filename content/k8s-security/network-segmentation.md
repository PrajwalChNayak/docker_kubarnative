---
title: Network segmentation
description: Default-deny NetworkPolicy, how the CNI enforces it, egress control, and the status of AdminNetworkPolicy — with a reachability probe to verify.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-intermediate/network-policy
  - k8s-intermediate/network-model-and-cni
---

## Overview

By default, Kubernetes networking is **flat**: every pod can reach every other
pod, in every namespace, on every port. Nothing about that is malicious — it is
just the absence of rules. **NetworkPolicy** lets you replace that with
**default-deny plus explicit allows**, so a compromised pod cannot freely move
laterally to databases, admin ports and control-plane services. This page is
about doing that per namespace and verifying it actually blocks traffic.

## Why it exists and when to use it

Lateral movement is the step that turns one compromised workload into a cluster
incident. Segmentation is the control that breaks it. Apply default-deny to
every namespace that holds a workload, and add narrow allows for the flows the
application genuinely needs. It is the network half of least privilege.

## How it works underneath

`NetworkPolicy` (`networking.k8s.io/v1`) is a namespaced object that selects
pods and describes allowed **ingress** and/or **egress**. Its semantics have two
subtleties:

- **Additive allow, implicit deny.** As soon as *any* policy selects a pod for a
  direction, that pod is default-deny for that direction, and only the union of
  matching allow rules is permitted. A pod that no policy selects stays fully
  open.
- **Both sides must permit.** For pod A to reach pod B, A's egress rules must
  allow B *and* B's ingress rules must allow A. Segmentation is enforced on both
  ends.

Critically, **NetworkPolicy is enforced by the CNI plugin, not the API server**.
The API server stores the object; the CNI (Calico, Cilium, kind's kindnetd, and
others) programs the actual packet filtering. A CNI that does not implement
NetworkPolicy will happily accept the objects and enforce nothing — a dangerous
silent no-op.

## Basic example

A default-deny for the whole namespace, denying both directions:

```yaml include="examples/security/k8s/missing-networkpolicy/fixed-networkpolicy.yaml" lines="13-22"
```

Then the minimum allows — DNS egress so name resolution still works, and one
explicit path:

```yaml include="examples/security/k8s/missing-networkpolicy/fixed-networkpolicy.yaml" lines="46-63"
```

## Explanation

The empty `podSelector: {}` selects every pod, and listing both `policyTypes`
with no rules denies all ingress and egress. That alone breaks DNS, so
`allow-dns-egress` re-opens UDP/TCP 53 to kube-system. Then
`allow-client-to-server` opens exactly one path: `client-allowed` to `server` on
8080, and nothing else. Every other pod-to-pod flow in the namespace is now
denied. The full set, including the matching egress rule, is in
`examples/security/k8s/missing-networkpolicy/`.

## Egress control

Ingress rules stop others reaching a pod; **egress** rules stop a compromised
pod reaching out — to the cloud metadata endpoint, to the internet for a
second-stage payload, or to services in other namespaces. Egress default-deny is
higher-effort (you must enumerate every legitimate destination, starting with
DNS) but it is the control that most directly contains an active intrusion.
Begin with DNS plus the app's known dependencies and tighten from there.

## AdminNetworkPolicy status

Standard `NetworkPolicy` cannot express cluster-wide, non-overridable rules or
explicit priority-ordered allow/deny, and it has no true "deny" primitive.
**AdminNetworkPolicy** and **BaselineAdminNetworkPolicy** (the
`policy.networking.k8s.io` API from SIG Network) add cluster-scoped, tiered
rules with explicit Allow/Deny/Pass actions for platform teams. They are
delivered as CRDs and depend on CNI support (Cilium, Calico and others are
adding it); treat availability as **CNI- and version-dependent and verify it in
your cluster** rather than assuming it. Standard NetworkPolicy remains the
portable baseline.

## Common patterns

- **Default-deny per namespace first**, then add narrow allows — never the other
  way round.
- **Always allow DNS egress**, or every name lookup breaks.
- **One allow per real dependency**, scoped by pod label and port, so a
  compromised pod reaches nothing extra.
- **Label namespaces consistently** so `namespaceSelector` rules are reliable,
  and generate a default-deny into every new namespace with a policy engine.

## Production considerations

Roll out segmentation namespace by namespace, and **verify with a real probe**
each time — an unenforced CNI turns every policy into a no-op you will not
notice. Watch out for breaking DNS (always allow it), health/metrics scraping
paths (Prometheus needs to reach metrics ports), and cross-namespace
dependencies. Label namespaces consistently so `namespaceSelector` rules are
reliable.

## Security considerations

Segmentation is the direct mitigation for lateral movement
([attack-lateral-movement](attack-lateral-movement.md)). Its blind spot is that
it governs L3/L4 reachability, not identity or encryption — a permitted flow is
fully trusted. For workload-to-workload authentication and encryption in transit,
layer a service mesh (mTLS) on top. And remember it does nothing about a pod that
was never selected by a policy, which is why default-deny per namespace matters.

## Troubleshooting

If a policy is not blocking, first confirm the **CNI enforces NetworkPolicy** —
this is the most common cause of "my policy does nothing". Then check that some
policy actually selects the pod (an unselected pod is open). If legitimate
traffic breaks, you likely denied DNS or forgot the matching rule on the other
side. Probe reachability directly:

```bash
kubectl -n netpol-demo exec client-denied -- \
  wget -qO- --timeout=3 http://server:8080/
```

```console include="captures/k8s-security/netpol-denied-probe.txt"
```

A timeout and non-zero exit on the denied client is the proof the path is
closed.

## Common mistakes

- Assuming a policy works without checking the CNI actually enforces it.
- Applying default-deny and forgetting to allow DNS, breaking everything.
- Writing ingress rules but never egress, so a compromised pod still calls out.
- Leaving some pods unselected by any policy, so they stay fully open.
- Assuming AdminNetworkPolicy is available everywhere — verify per cluster.

## Related topics

- [NetworkPolicy (intermediate)](../k8s-intermediate/network-policy.md)
- [Network model and CNI](../k8s-intermediate/network-model-and-cni.md)
- [Lateral movement, and how to close it](attack-lateral-movement.md)
- [The 4C security model](4c-model.md)
