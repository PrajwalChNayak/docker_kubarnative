---
title: Network model and CNI
description: The four rules every Kubernetes network must satisfy, how a CNI plugin wires a pod up, and what the plugin choice actually changes.
level: intermediate
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/services
  - foundations/linux-namespaces
---

## Overview

Kubernetes does not implement pod networking. It specifies a model and requires
a plugin to satisfy it:

1. Every pod gets its own IP address.
2. Pods on a node can reach all pods on all nodes **without NAT**.
3. Agents on a node (the kubelet, a node agent) can reach all pods on that node.
4. A pod sees its own IP as the same address everybody else sees.

This is the "flat network" or "IP-per-pod" model. It is a strong requirement —
no port mapping, no address translation between pods — and it is why Kubernetes
networking feels so different from Docker's default bridge with published ports.

## Why it exists and when to use it

The alternative, which Docker's default networking uses, is port mapping: many
containers share a host IP and are distinguished by port. That forces every
application to be configurable to a dynamic port, breaks any protocol that
embeds its address, and makes service discovery a port registry.

The flat model means every pod can use its natural port. Tasklane's API listens
on 8080 in every replica, on every node, with no conflicts.

## How it works underneath

**CNI** (Container Network Interface) is a thin contract: the container runtime
executes a plugin binary with `ADD`, `DEL` or `CHECK` and a JSON config, and the
plugin returns an IP allocation. The kubelet asks the CRI runtime (containerd,
CRI-O) to create the pod sandbox, and the runtime invokes CNI.

The sequence when a pod starts:

1. The runtime creates a network namespace for the sandbox (the "pause"
   container holds it, which is why every node runs dozens of pause containers).
2. It invokes the CNI plugin configured in `/etc/cni/net.d/`.
3. The plugin creates a veth pair, moves one end into the namespace as `eth0`,
   attaches the other end to a bridge or to the plugin's own datapath, assigns
   an IP from the node's pod CIDR, and installs routes.
4. All containers in the pod join that one namespace, which is why they share an
   IP and can talk over `localhost`.

**Getting packets between nodes** is where plugins differ:

| Approach | How | Cost |
|---|---|---|
| Layer 2 / host routes | each node routes to its peers' pod CIDRs directly | fastest; needs nodes on one L2 segment or a cooperative fabric |
| Encapsulation (VXLAN, Geneve) | wrap pod packets in UDP between nodes | works anywhere; adds header overhead and reduces effective MTU |
| BGP | nodes advertise their pod CIDRs to the network | native performance, needs network cooperation |
| Cloud-native (ENI/alias IPs) | pod IPs come from the VPC | integrates with cloud security groups; bounded by per-instance IP limits |

**eBPF-based plugins** (Cilium) replace much of the iptables datapath with eBPF
programs attached to the kernel's networking hooks, which also lets them
implement Services and NetworkPolicy without kube-proxy.

**IP address management.** The node's `spec.podCIDR` is carved out of the
cluster CIDR by the controller manager; the plugin allocates from it. A node's
pod capacity is bounded by that prefix — a `/24` per node is 254 pods,
regardless of `maxPods`.

**Dual-stack** is supported end to end: nodes and pods get IPv4 and IPv6
addresses, and Services carry `ipFamilies` and `ipFamilyPolicy`.

The lab uses kindnet, kind's own plugin: simple, routed, and it ships
`kube-network-policies` so that NetworkPolicy is actually enforced. That last
detail is the entire reason [NetworkPolicy](network-policy.md) works in this
handbook's lab.

## Basic example

Look at the wiring from inside a pod:

```bash
kubectl -n tasklane exec netcheck -- cat /etc/resolv.conf
kubectl -n tasklane get pods -o wide
```

```console include="captures/k8s-intermediate/resolv-conf.txt"
```

The `-o wide` output shows each pod's IP and the node it is on; pods on
different nodes have addresses from different node CIDRs, and they reach each
other with no translation.

## Explanation

Two things follow from the model that surprise people.

**Pod IPs are not stable.** A pod that restarts gets a new address. Nothing
should ever be configured with one — Services and DNS exist precisely so nothing
has to be.

**There is no NAT between pods, but there is NAT leaving the cluster.** Traffic
from a pod to the outside world is usually masqueraded behind the node's IP, so
an external firewall sees node addresses, not pod addresses. That is why "allow
our cluster's pod range" rarely works on an external system, and why egress
gateways exist.

## Common patterns

**Choose the plugin for what you need beyond connectivity.** Every plugin
satisfies the four rules. They differ in NetworkPolicy support, observability,
encryption (WireGuard or IPsec), performance at scale, and whether they can
replace kube-proxy.

**Check MTU when things are slow, not broken.** Encapsulation reduces the usable
MTU (VXLAN takes 50 bytes). A mismatch produces the classic symptom: small
requests work, large responses hang.

**Plan the address space before the cluster.** Cluster CIDR, service CIDR and
per-node prefix are hard to change afterwards, and they must not collide with
anything the cluster peers with.

**One plugin per cluster.** Installing two CNI plugins produces a cluster where
some pods cannot reach others, diagnosed slowly.

## Production considerations

The CNI plugin is a cluster-critical DaemonSet: if it fails on a node, new pods
on that node stay in `ContainerCreating` with
`failed to set up sandbox ... plugin type=...`. Upgrade it deliberately, one
node pool at a time, and read its release notes properly.

Pod IP exhaustion is a real limit. With a `/24` per node you get 254 pods per
node; with cloud ENI-based plugins the limit is per instance type and is often
much lower. Both show up as unschedulable pods with plugin-specific errors.

Encryption between nodes is a plugin feature. If the requirement is "pod traffic
must be encrypted in transit", the answer is a plugin with WireGuard/IPsec or a
service mesh with mTLS, not anything in core Kubernetes.

kube-proxy replacement (Cilium and others) removes a moving part and changes how
you debug Services; make sure your runbooks match the datapath you actually run.

## Security considerations

**The flat network is a flat trust domain by default.** Any pod can connect to
any other pod, in any namespace, on any port. The database is one TCP connection
away from every workload in the cluster until you say otherwise. That is the
threat, and [NetworkPolicy](network-policy.md) is the fix — but only if the
plugin enforces it, which is a property of the plugin, not of Kubernetes.

Node-level access defeats pod-level policy: a pod with `hostNetwork: true` uses
the node's namespace and is not subject to pod selectors in the same way, and a
privileged pod can reprogram the datapath entirely. Pod Security Admission is
the control for that.

The cloud metadata endpoint (`169.254.169.254`) is reachable from pods unless
you block it, and on some clusters it hands out node credentials. Blocking it
with an egress policy or a plugin-level rule is standard hardening.

Encryption between nodes protects against someone on the underlay network. If
your nodes share a network with anything you do not control, assume that is a
real adversary.

## Troubleshooting

```bash
kubectl get pods -A -o wide | grep -v Running
kubectl -n kube-system get daemonset
kubectl -n kube-system logs -l app=kindnet --tail=50
```

**`ContainerCreating` with a sandbox error** — the plugin failed on that node.
Its DaemonSet pod's logs on that node are the place to look.

**Pods on one node cannot reach pods on another** — inter-node routing or
encapsulation. Test node-to-node first, then pod-to-pod across nodes.

**Intermittent hangs on large payloads** — MTU.

**A pod cannot reach an external service** — remember the masquerade: the
external side sees the node's IP, so check firewalls against node addresses.

## Common mistakes

- **Configuring anything with a pod IP.**
- **Assuming the network is segmented** because namespaces exist. They are not a
  network boundary.
- **Assuming NetworkPolicy works.** Some plugins ignore it silently.
- **Overlapping the cluster CIDR with an on-premises range** you later need to
  reach.
- **Ignoring MTU** after adding an overlay or a VPN.
- **Two CNI plugins**, half-installed.
- **Expecting `hostPort` to behave like a Service.** It bypasses the model and
  conflicts across pods.

## Related topics

- [kube-proxy and EndpointSlices](kube-proxy-and-endpointslices.md)
- [DNS and CoreDNS](dns-and-coredns.md)
- [NetworkPolicy](network-policy.md)
- [Services](../k8s-beginner/services.md)
- [Docker networking](../docker-intermediate/docker-networking.md)
- [Linux namespaces](../foundations/linux-namespaces.md)
- [Network segmentation](../k8s-security/network-segmentation.md)
