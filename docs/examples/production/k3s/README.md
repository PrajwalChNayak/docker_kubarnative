# k3s install command reference

k3s is a single ~70 MB binary that packages the API server, controller
manager, scheduler, kubelet, containerd, flannel, CoreDNS, a service load
balancer (ServiceLB / Klipper), Traefik and local-path-provisioner. It targets
edge, IoT, CI and small production clusters.

**Do not run these against the kind lab.** They are for a real Linux host or
VM. Versions here target `v1.37.0+k3s1`.

## Single-node server

```bash
# Installs and starts the k3s systemd service, writes a kubeconfig to
# /etc/rancher/k3s/k3s.yaml, and pins the channel to 1.37.
curl -sfL https://get.k3s.io | INSTALL_K3S_CHANNEL=v1.37 sh -

# The bundled kubectl:
sudo k3s kubectl get nodes
```

The datastore defaults to embedded **SQLite** on a single server. That is fine
for edge and single-node, but SQLite cannot form a quorum, so it is not an HA
datastore.

## Disable bundled components

Traefik and ServiceLB are convenient defaults you often replace in production
(for example with a Gateway API implementation and MetalLB, or a cloud load
balancer). Disable them at install time through `INSTALL_K3S_EXEC`:

```bash
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="server \
  --disable traefik \
  --disable servicelb \
  --write-kubeconfig-mode 0644" sh -
```

`--disable` also accepts `local-storage` and `metrics-server`. Disabling a
packaged component after the fact is done the same way, by editing the systemd
unit's `ExecStart` (or the config file at `/etc/rancher/k3s/config.yaml`) and
restarting; k3s reconciles the removed component out.

## High availability with embedded etcd

For an HA control plane, replace SQLite with **embedded etcd** by initialising
the first server with `--cluster-init`, then joining an odd number (3 or 5) of
servers:

```bash
# First server: start an embedded-etcd cluster and set a shared token.
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="server --cluster-init" \
  K3S_TOKEN="a-shared-secret" sh -

# Second and third servers: join the existing etcd quorum.
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="server \
  --server https://<first-server-ip>:6443" \
  K3S_TOKEN="a-shared-secret" sh -
```

An external SQL datastore (PostgreSQL, MySQL, or an external etcd) is the other
HA option: pass `--datastore-endpoint` instead of `--cluster-init`.

## Join an agent (worker) node

```bash
# K3S_URL makes the installer set up an agent (kubelet only), not a server.
curl -sfL https://get.k3s.io | \
  K3S_URL="https://<server-ip>:6443" \
  K3S_TOKEN="a-shared-secret" sh -
```

The node token can also be read on a server from
`/var/lib/rancher/k3s/server/node-token`.

## Uninstall

```bash
# Written by the installer; removes the service, binary and data.
/usr/local/bin/k3s-uninstall.sh        # on a server
/usr/local/bin/k3s-agent-uninstall.sh  # on an agent
```

## k3d: k3s in Docker for local use

For a laptop, `k3d` runs k3s inside Docker containers (each "node" is a
container), which is closer to k3s than kind is:

```bash
# One server, two agents; skip the bundled Traefik so you can install your own.
k3d cluster create tasklane \
  --servers 1 --agents 2 \
  --k3s-arg "--disable=traefik@server:0"
```

## When to reach for a lightweight distro

- **k3s** — edge/IoT, single-node or small HA production, CI runners, appliances.
- **k0s** — single binary, no host dependencies, control plane can run as pods.
- **MicroK8s** — snap-based, add-ons toggled with `microk8s enable`.
- **Talos** — an immutable API-managed OS with no shell; the node *is* the distro.

See `content/production/k3s-and-lightweight.md` for the trade-offs.
