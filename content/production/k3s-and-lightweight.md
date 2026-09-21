---
title: k3s and lightweight distributions
description: k3s and the lightweight Kubernetes family — single binary, embedded datastore, bundled components, and where k0s, MicroK8s and Talos fit.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - production/kubeadm
  - k8s-beginner/local-clusters
---

## Overview

Not every cluster needs a full kubeadm control plane on beefy nodes. A whole
family of lightweight distributions packages conformant Kubernetes into a small
footprint for edge, IoT, CI and small production. The best known is **k3s**: a
single ~70 MB binary that bundles the control plane, kubelet, containerd and a
set of batteries-included components, and can run on a Raspberry Pi.

This page explains how k3s achieves that, what it bundles and how to strip it
back, and where the other lightweight distros — k0s, MicroK8s, Talos — fit. The
install command reference lives in
[`examples/production/k3s/README.md`](../../examples/production/k3s/README.md).

## Why it exists and when to use it

Standard Kubernetes assumes a certain minimum: several nodes, gigabytes of RAM,
a separate etcd, a CNI you install. That is overkill for a factory-floor
appliance, a retail-store edge box, a CI runner or a homelab. Lightweight distros
target exactly those:

- **Edge and IoT** — one binary, small memory footprint, runs on ARM.
- **CI and ephemeral clusters** — fast to create and destroy.
- **Small production** — a single-node or 3-node HA cluster for a modest service.
- **Local development** — k3d (k3s in Docker) as a lighter alternative to kind.

If you are running a large multi-tenant platform, a lightweight distro is the
wrong tool — you want a managed control plane or kubeadm HA. Lightweight shines
when the *whole cluster* is small.

## How it works underneath

k3s makes Kubernetes small through several deliberate choices:

- **One binary, one process tree.** The API server, scheduler, controller
  manager, kubelet and kube-proxy are compiled into a single binary and launched
  as one supervised process, instead of separate static pods.
- **A pluggable datastore via kine.** Standard Kubernetes stores state in etcd.
  k3s inserts a shim (**kine**) that lets the API server talk to alternative
  datastores. The default on a single server is **embedded SQLite** — tiny, but
  it cannot form a quorum, so it is not HA. For HA, k3s switches to **embedded
  etcd** (`--cluster-init`) or an external SQL database.
- **Trimmed and modern defaults.** Legacy, in-tree and alpha cruft is removed;
  containerd is embedded rather than requiring a separate install.
- **Batteries included.** flannel (CNI), CoreDNS, a service load balancer
  (**ServiceLB**, aka Klipper), **Traefik** as ingress, `local-path-provisioner`
  and metrics-server ship on by default so a fresh single-node cluster can serve
  traffic immediately.

The mental model: k3s trades the modular, assemble-it-yourself nature of kubeadm
for a curated, single-artifact distribution — the same API, far less to stand up.

## Basic example

Install a single-node server and use the bundled kubectl (on a real Linux host,
not the kind lab):

```bash
curl -sfL https://get.k3s.io | INSTALL_K3S_CHANNEL=v1.37 sh -
sudo k3s kubectl get nodes
```

The kubeconfig is written to `/etc/rancher/k3s/k3s.yaml`. That is the entire
control plane: one command, one binary, one node.

## Explanation

The `curl | sh` installer is doing a lot: it downloads the pinned binary,
installs a systemd service, generates certificates, starts the single-process
control plane on embedded SQLite, and applies the bundled add-ons. What you get
is a conformant cluster that behaves like any other to `kubectl` and to your
manifests — the Tasklane manifests from Part F run on k3s unchanged.

The `INSTALL_K3S_CHANNEL` variable pins the Kubernetes minor so you are not
silently moved across versions. Configuration can also live declaratively in
`/etc/rancher/k3s/config.yaml` rather than in the systemd `ExecStart`, which is
the GitOps-friendly way to manage a fleet of k3s nodes.

## Common patterns

- **Disable the bundled ingress/LB in production.** Many teams replace Traefik
  with a Gateway API implementation and ServiceLB with MetalLB or a cloud LB.
  Disable them at install: `--disable traefik --disable servicelb`.
- **HA with embedded etcd.** Initialise the first server with `--cluster-init`,
  then join an odd number (3 or 5) of servers sharing a token, so etcd keeps
  quorum. This is production-grade HA without a separate etcd cluster.
- **Agent (worker) nodes.** Setting `K3S_URL` makes the installer configure a
  kubelet-only agent instead of a server.
- **k3d for local dev.** `k3d cluster create` runs each k3s node as a Docker
  container — closer to real k3s than kind, and quick to throw away.

```bash
# Production-shaped single server: strip the bundled ingress and load balancer.
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="server \
  --disable traefik --disable servicelb" sh -
```

## Production considerations

- **SQLite is not HA.** A single-server k3s on the default datastore has no
  control-plane redundancy. For anything you care about, use embedded etcd
  (odd-sized) or an external database, and back it up.
- **The bundled components are opinions, not requirements.** Traefik and
  ServiceLB are conveniences; in production you usually want your own ingress,
  load balancing and storage class, chosen deliberately.
- **The lightweight footprint does not remove day-2 work.** You still own
  upgrades (k3s has its own upgrade flow and a system-upgrade controller),
  backups of the datastore, and OS patching on the host.
- **k3s is production-grade** — it is CNCF-hosted and widely run on real edge
  fleets — but "lightweight" describes the footprint, not the operational rigour
  you still apply.

## Security considerations

- **`curl | sh` executes remote code as root.** For fleets, verify the installer
  and pin versions, or mirror the binary internally rather than piping the
  network into a shell.
- **flannel does not enforce NetworkPolicy.** If you need default-deny
  segmentation, install a policy-capable CNI (Calico, Cilium) instead of the
  bundled flannel.
- **Datastore secrets.** The node token and datastore live on the server's disk;
  protect `/var/lib/rancher/k3s` and encrypt Secrets at rest as you would on any
  cluster.
- **Small does not mean exempt.** PSA restricted, RBAC least-privilege and image
  supply-chain controls apply to a k3s edge box exactly as to a cloud cluster.

## Troubleshooting

- **Traefik or ServiceLB you did not want keeps coming back.** They are
  reconciled from manifests in `/var/lib/rancher/k3s/server/manifests`; disable
  them via `--disable` (or the config file) rather than deleting the objects.
- **Second server will not join / etcd errors.** The first server was started
  without `--cluster-init` (so it is on SQLite, which cannot cluster), or the
  shared `K3S_TOKEN` differs between nodes.
- **Agent will not register.** `K3S_URL` or `K3S_TOKEN` is wrong, or the server's
  `:6443` is not reachable from the agent.

## Common mistakes

- **Running single-server SQLite in production** and discovering there is no
  control-plane HA when the node dies.
- **Leaving Traefik and ServiceLB in place** and fighting them instead of
  disabling them and installing your chosen ingress and LB.
- **Assuming flannel enforces NetworkPolicy** — it does not.
- **Piping the installer to root shell on a fleet** without pinning or mirroring.
- **Treating "lightweight" as "no operations"** — datastore backups and upgrades
  are still yours.

## The rest of the family

- **k0s** — a single binary with zero host dependencies; its control plane can
  even run as pods, and it leans toward a more "vanilla" upstream feel than k3s.
- **MicroK8s** — Canonical's snap-based distro; components are toggled with
  `microk8s enable <addon>`. Convenient on Ubuntu, tied to snap.
- **Talos** — an immutable, API-managed Linux OS purpose-built for Kubernetes
  with **no shell and no SSH**. You configure nodes declaratively over an API;
  the node *is* the distribution. Excellent for security and fleet uniformity,
  a mindset shift from a general-purpose OS.

All are conformant Kubernetes. The choice is about the footprint, the datastore
model, and how much the distro decides for you.

## Related topics

- [Self-managed with kubeadm](kubeadm.md)
- [Managed Kubernetes compared](managed-kubernetes-compared.md)
- [When not to use Kubernetes](when-not-to-use-kubernetes.md)
- [Local clusters](../k8s-beginner/local-clusters.md)
- [Production-readiness checklist](production-readiness-checklist.md)
