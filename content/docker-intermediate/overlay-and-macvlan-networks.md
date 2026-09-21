---
title: Overlay, macvlan and ipvlan networks
description: The drivers beyond bridge — multi-host overlay networks in Swarm, and giving containers addresses on the physical network.
level: intermediate
type: concept
status: current
versions: Docker Engine 29, Compose v5
prerequisites:
  - docker-intermediate/docker-networking
---

## Overview

`bridge` covers one host. Three other built-in drivers cover the cases it
cannot:

| Driver | Scope | What a container gets |
|---|---|---|
| `overlay` | multiple hosts in a Swarm | an address on a VXLAN network spanning hosts |
| `macvlan` | one host, physical LAN | its own MAC and IP on the physical network |
| `ipvlan` | one host, physical LAN | an IP on the physical network, sharing the parent's MAC |

All three are niche compared with bridge, and all three are things Kubernetes
solves differently. Knowing what they are stops you from reaching for them
when a bridge network or an orchestrator is the right answer.

## Why it exists and when to use it

**Overlay** exists because containers on different hosts cannot see each
other's bridge networks. It gives a group of Docker daemons a shared L2-like
network with its own subnet and DNS.

**macvlan and ipvlan** exist for workloads that must appear on the physical
network: a legacy application that expects a routable address, a monitoring
agent that needs to see broadcast traffic, an appliance that other hosts
discover by IP. They are also the way to avoid NAT entirely — no port
publishing is involved because the container is simply on the LAN.

## How it works underneath

**Overlay.** Traffic is encapsulated in VXLAN and sent between hosts. Docker
hosts must be part of a Swarm to use overlay networks, even for standalone
containers, and these ports must be open between participating hosts:
`2377/tcp` (Swarm control plane), `4789/udp` (overlay data path) and
`7946/tcp` + `7946/udp` (node communication). Networks created without
`--attachable` can only be joined by Swarm services; with it, standalone
containers can join too. `--opt encrypted` turns on IPsec at the VXLAN level,
which the docs describe as carrying "a non-negligible performance penalty", and
which is not supported for Windows containers.

**macvlan.** A parent interface (`-o parent=eth0`) is given multiple MAC
addresses, one per container. Modes are `bridge` (default), `vepa`,
`passthru` and `private`. Constraints from the documentation: Linux only, not
supported in rootless mode or on Docker Desktop; needs kernel 3.9+ (4.0+
recommended); the network equipment must handle promiscuous mode; most cloud
providers block it. The one that surprises everyone: "containers attached to a
macvlan network cannot communicate with the host directly, this is a
restriction in the Linux kernel". The workaround is to also attach the
container to a bridge network, or create a macvlan interface on the host with
the same parent.

**ipvlan.** The same idea without extra MAC addresses: containers share the
parent's MAC and are separated by IP. Modes are `l2` (default), `l3` and
`l3s`, with `ipvlan_flag` of `bridge`, `private` or `vepa`. It needs kernel
4.2+. It avoids the MAC-explosion ("VLAN spread") problem that makes network
teams refuse macvlan, at the cost of needing routing for `l3`.

Note for Engine 29: macvlan and `ipvlan-l2` networks get no default gateway
unless you set `--gateway` explicitly.

## Basic example

An attachable overlay network, on a host that is part of a Swarm:

```bash
docker swarm init
docker network create -d overlay --attachable tasklane-overlay
docker network ls
```

A macvlan network on the LAN `192.168.1.0/24`:

```bash
docker network create -d macvlan --subnet 192.168.1.0/24 --gateway 192.168.1.1 -o parent=eth0 lan
docker run --rm --network lan --ip 192.168.1.60 busybox:1.37-musl ip addr show eth0
```

:::warning
These commands change host networking and need a Swarm or a physical LAN, so
this handbook captures no output for them. Run them on a machine you own, not
on the lab cluster.
:::

## Explanation

The overlay example needs `docker swarm init` first because the overlay driver
depends on Swarm's control plane for key distribution, address management and
gossip. That is the real cost: you are running Swarm, a second orchestrator,
alongside whatever else you use.

The macvlan example takes addresses from the *physical* subnet. Those
addresses must be excluded from the DHCP pool, or you get duplicate-address
incidents that look like random connectivity loss. `--ip` pins one; without
it, Docker allocates from the `--subnet` you declared, which it does not
coordinate with your DHCP server in any way.

## Common patterns

**Overlay for a small multi-host Swarm.** If Swarm is already how you run
things, overlay networks are the natural fabric, and `--attachable` lets debug
containers join.

**macvlan for a legacy appliance.** One container that must own an IP on the
office VLAN, with everything else on ordinary bridge networks.

**ipvlan l2 when the switch objects to extra MACs.** Same result as macvlan
with one MAC per host.

**A second bridge network for host access.** Since macvlan containers cannot
reach the host, attach them to a bridge network as well when they need to call
something local.

**Reserved address ranges.** Configure `--ip-range` inside the physical subnet
so Docker allocates only from a block your DHCP server never hands out.

## Production considerations

Be honest about scope. Overlay networking plus Swarm is a complete multi-host
story for small deployments and is still maintained, but the ecosystem,
documentation and hiring pool have moved to Kubernetes. If you are choosing
today and need multi-host scheduling, a Kubernetes cluster — even a
single-node k3s — is usually the better investment. Compose covers the
single-host case, and this handbook treats Compose then Kubernetes as the
path.

macvlan and ipvlan are operations decisions as much as engineering ones: they
consume addresses from a production subnet, require switch configuration, and
are blocked by most cloud providers. Get the network team involved before
designing around them.

Overlay encryption is not free: IPsec at VXLAN level costs throughput and CPU.
Measure before enabling it fleet-wide, and prefer application-level TLS, which
protects data end to end rather than hop to hop.

In Kubernetes the equivalents are a CNI plugin for the pod network, Multus for
extra interfaces, and macvlan/ipvlan CNI plugins for the same
physical-network cases. The Docker drivers themselves do not carry over.

## Security considerations

- An overlay network without `--opt encrypted` carries traffic between hosts
  in cleartext over whatever the underlay is. Encrypt at the application
  layer, at the overlay, or both.
- Swarm's ports (2377, 4789, 7946) must be reachable between nodes and nowhere
  else. VXLAN on 4789/udp exposed to an untrusted network lets anyone inject
  frames into the overlay.
- A macvlan container sits on the LAN with no NAT and no Docker firewall rules
  in front of it. Everything it listens on is reachable by everything on that
  VLAN. Treat it like a physical host.
- macvlan and ipvlan bypass the `DOCKER-USER` chain that people rely on for
  host-level filtering of container traffic.
- Address collisions with DHCP are a self-inflicted denial of service. Reserve
  the range.

## Troubleshooting

**`docker network create -d overlay` fails with "this node is not a swarm
manager".** Overlay requires Swarm, even for standalone containers.

**Standalone containers cannot join an overlay network.** It was not created
with `--attachable`.

**Overlay traffic works between some hosts only.** 4789/udp or 7946 is
blocked, or a security group allows TCP but not UDP.

**A macvlan container cannot reach its own host.** Expected kernel behaviour.
Add a bridge network or a host-side macvlan interface.

**A macvlan container cannot reach anything.** The parent interface may not
allow promiscuous mode, the switch may block unknown MACs, or the subnet and
gateway do not match the physical network.

**macvlan works and then breaks randomly.** Address conflict with a
DHCP-assigned device. Reserve the range with `--ip-range`.

**macvlan is unavailable.** You are on Docker Desktop, in rootless mode, or on
a cloud instance that blocks it. All three are documented limitations.

## Common mistakes

- Reaching for overlay networks on a single host, where a user-defined bridge
  does the job.
- Running Swarm purely to get one overlay network.
- Using macvlan to avoid learning port publishing.
- Allocating macvlan addresses from the middle of a DHCP pool.
- Assuming encrypted overlay networks are end-to-end encrypted. They protect
  the hop between hosts, not the application path.
- Expecting these drivers to exist in Kubernetes. Pod networking is a CNI
  concern with different tools.

## Related topics

- [Docker networking](docker-networking.md)
- [Compose fundamentals](compose-fundamentals.md)
- [Network model and CNI](../k8s-intermediate/network-model-and-cni.md)
- [Why orchestration](../k8s-beginner/why-orchestration.md)
- [Alternatives](../production/alternatives.md)
