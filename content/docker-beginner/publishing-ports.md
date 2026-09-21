---
title: Publishing ports
description: How -p turns into DNAT rules and a userland proxy, why binding to 0.0.0.0 bypasses your firewall, and how containers reach each other without publishing anything.
level: beginner
type: concept
status: current
versions: Docker Engine 29
prerequisites:
  - docker-beginner/running-containers
---

## Overview

A container has its own network namespace: its own interfaces, routing table
and port space. A server listening on port 8080 inside a container is not
listening on port 8080 on the host, and nothing outside that namespace can
reach it until you say so.

`-p` (publish) is how you say so. It maps a host address and port onto a
container port, by programming a destination-NAT rule on the host and, in the
default configuration, by also running a small userland proxy process.

Container-to-container traffic needs none of this. Two containers on the same
user-defined network reach each other directly by name.

## Why it exists and when to use it

Publishing exists to let traffic from outside the container's network — your
browser, a load balancer, another machine — reach a process inside it.

Publish only what humans or external systems must reach. In the Tasklane
stack, that is exactly one port: the API. PostgreSQL is never published,
because only the API and the worker talk to it, and they are on the same
network. A published database port is one of the most reliably exploited
mistakes on the internet.

## How it works underneath

For `-p 127.0.0.1:8088:8080` the daemon does four things:

1. **Allocates the host port.** If something already holds it, the container
   fails to start with `port is already allocated`.
2. **Adds a DNAT rule** in the host's `nat` table: packets arriving for
   `127.0.0.1:8088` have their destination rewritten to the container's
   address on the bridge network, port 8080. Return traffic is un-NATted by
   conntrack. With the iptables backend (the default; nftables is
   experimental in Engine 29) these land in Docker's own chains.
3. **Starts `docker-proxy`**, one process per published port, when the
   userland proxy is enabled — it is on by default (`--userland-proxy=true`).
   It accepts connections the NAT rules cannot handle on their own, notably
   connections from the host itself to `localhost`, and forwards them into the
   container.
4. **Records the mapping** so `docker port` and `docker ps` can show it.

The filtering rules are not in the `INPUT` chain, which is the root of the
firewall surprise below: "When you publish a container's ports using Docker,
traffic to and from that container gets diverted before it goes through the
ufw firewall settings."

Docker provides a `DOCKER-USER` chain as "a placeholder for user-defined rules
that will be processed before rules in the `DOCKER-FORWARD` and `DOCKER`
chains". Note where in the path it sits: "When packets arrive to the
`DOCKER-USER` chain, they have already passed through a Destination Network
Address Translation (DNAT) filter", so you match on the container's address,
not the address the client dialled. With firewalld, Docker creates a zone
called `docker` with target `ACCEPT` and puts its bridges in it.

Inside the network namespace nothing special happens: the process binds
0.0.0.0:8080 as usual, and packets arrive over `eth0`, which is one end of a
veth pair whose other end is on the bridge.

:::note Docker Desktop
On macOS and Windows there is a VM in the middle. Docker Desktop forwards the
host port into the VM, and the daemon there does the DNAT. `localhost` on your
host still works, which is why the distinction between `127.0.0.1` and
`0.0.0.0` is easy to forget on a laptop and expensive to forget on a server.
:::

## Basic example

```bash
docker run -d --name port-demo -p 127.0.0.1:8089:8080 tasklane-api:0.1.0
docker port port-demo
curl -s http://127.0.0.1:8089/
```

```console include="captures/docker-beginner/port-publish.txt"
```

The syntax is `[host-ip:][host-port:]container-port`, and the parts are read
from the right:

| Flag | Meaning |
|---|---|
| `-p 8080` | Container port 8080 → a random host port on all addresses |
| `-p 8088:8080` | Host 8088 on **all** addresses → container 8080 |
| `-p 127.0.0.1:8088:8080` | Host 8088 on loopback only → container 8080 |
| `-p 8088:8080/udp` | The same for UDP |
| `-p 8000-8005:8000-8005` | A range |
| `-P` | Every port the image `EXPOSE`s → random host ports |

`EXPOSE` in a Dockerfile publishes nothing. It is metadata that documents the
port and feeds `-P`:

```console include="captures/docker-beginner/port-publish-all.txt"
```

## Explanation

**The default is every interface.** "By default, when a container's ports are
mapped without any specific host address, the Docker daemon publishes ports to
all host addresses (`0.0.0.0` and `[::]`)." On a laptop behind NAT that feels
harmless. On a cloud instance with a public IP, `-p 5432:5432` puts your
database on the internet.

**And the host firewall may not save you.** Because published traffic is
DNATted before the chains ufw manages, a `ufw deny 5432` rule does not stop
it. The documentation is explicit about the mechanism. The fixes:

- Publish to `127.0.0.1` whenever the consumer is on the same host.
- Put deny rules in the `DOCKER-USER` chain, matching the container's address.
- Do not publish at all when containers only talk to each other.

**Containers talk to each other without publishing.** On a user-defined
network, Docker runs an embedded DNS resolver that maps container names to
addresses:

```bash
docker network create tasklane-net
docker run -d --name tasklane-db --network tasklane-net postgres:18-trixie
docker run --rm --network tasklane-net busybox:1.37-musl nslookup tasklane-db
```

```console include="captures/docker-beginner/tasklane-network.txt"
```

On the **default** bridge network this does not work: "Containers on the
default bridge network can only access each other by IP addresses". Always
create a network.

**Localhost inside a container is the container.** `PGHOST=localhost` in the
API container means "connect to this container", not to the database. This is
the single most common networking mistake for newcomers, and it also explains
why a service bound to `127.0.0.1` *inside* the container cannot be published:
the DNAT'd packets arrive on `eth0`, and nothing is listening there. Bind to
`0.0.0.0` inside the container and restrict the address on the host side.

## Common patterns

**Loopback plus a reverse proxy**

```bash
docker run -d --name tasklane-api -p 127.0.0.1:8088:8080 tasklane-api:0.1.0
```

Terminate TLS and authenticate in a proxy on the host or in another container,
and never expose the application port directly.

**A dev-only database port**, which is exactly what the Compose override file
does for Tasklane:

```yaml include="examples/compose/compose.override.yaml"
```

**Random host port for parallel test runs**

```bash
docker run -d --name test-api -P tasklane-api:0.1.0
docker port test-api 8080
```

**Check what is published**

```bash
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```

A mapping shown as `0.0.0.0:8088->8080/tcp` is reachable from the network; one
shown as `127.0.0.1:8088->8080/tcp` is not.

## Production considerations

- Publish the minimum, bound to the narrowest address that works.
- Remember that the host port is a singleton: two containers cannot both take
  8080, which is one of the reasons single-host deployments stop scaling.
- Health and metrics ports (the Tasklane worker's 9090) usually should not be
  published at all; scrape them from inside the network.
- Under Kubernetes this whole page changes shape: Services and Gateways
  replace `-p`, and a NodePort is the closest analogue. See
  [Services](../k8s-beginner/services.md).
- If you must use `--network host` for performance, understand that you have
  given up network isolation entirely and `-p` no longer applies.

## Security considerations

- **Assume `-p 5432:5432` means "the internet".** Bind explicitly to
  `127.0.0.1` or do not publish.
- **Published ports bypass ufw and similar tools.** Verify from another
  machine (`nmap`, or simply `curl http://<host>:<port>`), not from the host
  itself.
- **`--network host` removes the network namespace**, so the container can
  reach services bound to the host's `127.0.0.1` — including a database or an
  agent that trusted localhost.
- **Do not publish the Docker API.** `-H tcp://0.0.0.0:2375` without TLS hands
  the machine to anyone who can reach it; see
  [The Docker socket is root](../docker-security/docker-socket-is-root.md).
- Prefer internal networks for backends. Compose marks the Tasklane backend
  network `internal: true`, which removes its route out entirely.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `port is already allocated` | Another container or host process holds it. `docker ps` and `ss -ltnp` |
| `curl: (7) Connection refused` from the host | Nothing is listening in the container, or it binds `127.0.0.1` inside |
| Works from the host, not from another machine | You published to `127.0.0.1`. That is usually correct |
| Works from outside, should not | You published to `0.0.0.0`, and ufw is not protecting it |
| Container cannot resolve another container | Default bridge network, or different networks |
| Container cannot reach the host's database | Use the host's LAN address, not `127.0.0.1` |

## Common mistakes

- **Reversing the mapping.** `-p 8080:8088` publishes host 8080 to container
  8088. Host first.
- **Expecting `EXPOSE` to publish.** It documents; `-p` publishes.
- **Publishing a database or a Redis port "temporarily".**
- **Binding the application to `127.0.0.1` inside the container** and then
  wondering why the published port refuses connections.
- **Using the default bridge network and container names together.**
- **Assuming `-p` is needed for container-to-container traffic.** It is not.

## Related topics

- [Running containers](running-containers.md)
- [Tasklane with docker run](tasklane-with-docker-run.md)
- [Docker networking](../docker-intermediate/docker-networking.md)
- [Compose fundamentals](../docker-intermediate/compose-fundamentals.md)
- [The Docker socket is root](../docker-security/docker-socket-is-root.md)
- [Services](../k8s-beginner/services.md)
