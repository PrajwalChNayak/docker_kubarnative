---
title: Docker networking
description: docker0, veth pairs, user-defined bridges, embedded DNS at 127.0.0.11, port publishing and the firewall rules underneath.
level: intermediate
type: concept
status: current
versions: Docker Engine 29, Compose v5
prerequisites:
  - docker-beginner/publishing-ports
---

## Overview

Every container gets a network namespace: its own interfaces, routing table,
`/etc/resolv.conf` and firewall rules. Docker's network drivers decide how that
namespace is wired to everything else. The default, `bridge`, connects
containers to a Linux bridge on the host and NATs their outbound traffic.

Three things account for most of what you need day to day: user-defined
bridge networks give you DNS by container name, published ports are firewall
rules rather than anything inside the container, and an `internal` network has
no route out.

## Why it exists and when to use it

Containers need to talk to each other, to the host and to the internet, without
colliding on ports or trusting each other by default. Docker's answer is one
namespace per container plus a driver that models a specific topology.

Use a user-defined bridge for anything with more than one container. Use
`host` when you need the host's stack and no isolation. Use `none` for
containers that must not have a network. `overlay`, `macvlan` and `ipvlan`
belong to [the next page](overlay-and-macvlan-networks.md).

## How it works underneath

When a container joins a bridge network:

1. Docker creates a **veth pair** — a virtual cable with two ends. One end
   goes into the container's namespace as `eth0`, the other stays on the host
   and is enslaved to the bridge device.
2. The container gets an address from the network's subnet, and a default
   route via the bridge's address.
3. Outbound packets are masqueraded (SNAT) to the host's address. Inbound
   traffic reaches the container only through a published port or from another
   container on the same network.

The default bridge is `docker0`. It is explicitly "considered a legacy detail
of Docker and is not recommended for production use": containers on it can
only reach each other by IP address unless you use the legacy `--link` flag,
and every container without a `--network` lands on it together, so unrelated
stacks can talk to each other.

**DNS.** Containers on the default bridge get a copy of the host's
`/etc/resolv.conf`. Containers on a user-defined network use Docker's embedded
DNS server at **127.0.0.11**, which resolves container names, network aliases
and service names, and forwards anything else upstream. There is no IPv6
equivalent; the IPv4 address works even in IPv6-only containers. On a custom
network the embedded server queries upstream servers in order and stops at the
first success or NXDOMAIN.

**Published ports.** `-p 8080:80` installs NAT rules in the host firewall.
The container is unaware. By default Docker blocks access to ports that are
not published, and a published port is reachable from outside the host unless
you bind it to a specific address: `-p 127.0.0.1:8080:80` keeps it on
loopback. Since Engine 28.0.0, hosts on the same L2 segment can no longer
reach ports published to localhost.

**Firewall backend.** Docker programs iptables (nftables support exists but is
experimental in Engine 29, enabled with `firewall-backend: nftables`; under
nftables Docker does not enable IP forwarding itself and startup fails if
forwarding is needed). Docker's rules live in its own chains
(`DOCKER`, `DOCKER-USER`); custom rules belong in `DOCKER-USER`, which is
evaluated before Docker's own.

**Internal networks.** `--internal` (Compose `internal: true`) creates a
network with no route to the outside. Containers on it can reach each other and
nothing else.

**Multiple networks.** A container can join several: the typical shape is a
frontend network with external access and an internal backend network, which
is exactly what the Tasklane stack does.

## Basic example

```yaml include="examples/compose/compose.yaml" lines="163-168"
```

The API joins both networks; the database joins only `backend`:

```yaml include="examples/compose/compose.yaml" lines="88-88"
```

Inspect the resulting network:

```bash
docker network ls
docker network inspect tasklane_backend
```

```console include="captures/docker-intermediate/network-inspect-backend.txt"
```

Name resolution from another container on the same network:

```console include="captures/docker-intermediate/dns-resolution.txt"
```

## Explanation

`backend` is `internal: true`, so the database has no route to the internet
and nothing outside the host can reach it even if a port were published. The
API is on both networks because it needs to accept published traffic *and*
reach the database.

Compose names networks `<project>_<network>`, so the networks above appear as
`tasklane_frontend` and `tasklane_backend`. Containers resolve each other by
*service* name, and with multiple replicas the embedded DNS returns one
address per replica — which is why the Prometheus config in the example uses
DNS service discovery for the worker.

The `api` service publishes `${API_PORT:-8080}:8080`. That is a host firewall
rule; inside the container the process still listens on 8080, and other
containers reach it as `api:8080` without any publishing at all.

## Common patterns

**Two networks: frontend and internal backend.** The database is unreachable
except from services that need it. This is the single most valuable
network-level control on a single host.

**Publish to loopback in development.** `127.0.0.1:5432:5432` for a database
you want to open in a GUI client, as `compose.override.yaml` does, so the port
is not exposed to the local network.

**Do not publish at all when you do not have to.** Containers on the same
network reach each other on any port. Publishing is for traffic from outside.

**Aliases for compatibility.** `networks: {backend: {aliases: [postgres]}}`
lets a service be reached under more than one name during a migration.

**`--network host` for host-level tooling only.** No port mapping, no
service-name DNS, full visibility of host traffic. It removes network
isolation entirely.

**`--network none` for untrusted batch work** that must not reach anything.

**`--network container:<name>` / Compose `network_mode: service:x`** to share
one namespace between containers — the mechanism a Kubernetes Pod uses for all
its containers.

## Production considerations

Docker's networking is single-host. The moment you need containers on
different hosts to address each other, you are choosing between overlay
networks (Swarm) and an orchestrator with a real network model. Kubernetes
replaces all of this: every Pod gets an IP, a CNI plugin implements the
fabric, Services provide stable names, and NetworkPolicy replaces "put it on
an internal network".

Address space is finite and easy to exhaust on a busy host: every
user-defined bridge consumes a subnet from the daemon's default address
pools, and once they are used up network creation fails with "could not find
an available, non-overlapping IPv4 address pool". Configure
`default-address-pools` in `daemon.json` to widen or move the ranges, and
prune networks you no longer use.

Published ports plus a cloud firewall is a common misconfiguration: Docker's
rules are evaluated before many host firewall setups, so a port you believed
was blocked by `ufw` may be open. Bind to a specific address, use
`DOCKER-USER`, or do not publish.

## Security considerations

- Publishing a port is "insecure by default" in the sense the docs mean:
  without an explicit host address it is reachable from outside the machine.
  Bind to `127.0.0.1` for anything that should stay local.
- Containers on the same network can reach *all* of each other's ports, not
  just the documented ones. Network segmentation between tiers is what limits
  that; there is no per-port policy on a bridge network.
- The default bridge places unrelated containers together. Always create
  networks explicitly; Compose does it for you.
- `--network host` gives the container access to every port the host can
  reach, including services bound to 127.0.0.1, and lets it observe host
  traffic. Treat it as close to privileged.
- Docker's iptables rules can silently bypass host firewalls. Verify from
  another machine, not from theory.
- Embedded DNS at 127.0.0.11 also resolves names of containers on the same
  network — useful for service discovery, and useful to an attacker enumerating
  neighbours.

## Troubleshooting

**"Could not resolve host: db".** The containers are not on the same
user-defined network, or one of them is on the default bridge, where name
resolution does not exist. Check with `docker inspect` and
`docker network inspect`.

**A published port is not reachable.** Confirm the container is listening on
`0.0.0.0` inside (a process bound to 127.0.0.1 inside the container is
unreachable from outside), then check the mapping:

```bash
docker port <container>
docker ps --format '{{.Names}}\t{{.Ports}}'
```

**Two stacks can see each other.** They share a network, probably the default
bridge.

**Outbound traffic fails from one network only.** That network is `internal`.

**"address pool" errors when creating networks.** Too many networks; prune
unused ones (`docker network prune`) or configure `default-address-pools`.

**Everything works on Linux and not on Docker Desktop.** The daemon runs in a
VM there: `host` networking, published ports on non-loopback host addresses
and raw interface access all behave differently.

## Common mistakes

- Relying on the default bridge and `--link`. Both are legacy.
- Publishing a database port to `0.0.0.0` so "the GUI client can reach it",
  and exposing it to the office network.
- Believing `EXPOSE` publishes anything.
- Using container IP addresses in configuration. They change on every
  recreate; names do not.
- Using `--network host` to avoid thinking about ports.
- Assuming a host firewall protects published ports.

## Related topics

- [Publishing ports](../docker-beginner/publishing-ports.md)
- [Overlay and macvlan networks](overlay-and-macvlan-networks.md)
- [Compose fundamentals](compose-fundamentals.md)
- [Tasklane with Compose](tasklane-with-compose.md)
- [Network model and CNI](../k8s-intermediate/network-model-and-cni.md)
- [Network policy](../k8s-intermediate/network-policy.md)
