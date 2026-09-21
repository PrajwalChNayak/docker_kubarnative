---
title: Self-managed Kubernetes with kubeadm
description: What you own when you run Kubernetes yourself with kubeadm — etcd, certificates, HA, upgrades, the CNI choice and OS patching — and when that ownership is worth it.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - operations/high-availability-control-plane
  - operations/etcd-backup-and-restore
  - operations/certificate-rotation
---

## Overview

kubeadm is the official tool for bootstrapping a conformant Kubernetes control
plane and joining nodes to it. It is what the CKA exam tests and what most
on-prem and bare-metal clusters are built on. kubeadm gives you a real,
upstream, un-opinionated cluster — and hands you the entire control plane to
operate. Where a managed provider owns etcd, HA, certificates and upgrades, with
kubeadm **you own all of it**.

This page is about that ownership: what moves onto your plate, how the pieces
fit, and when self-managing is the right call rather than a nostalgic one. The
command reference lives in
[`examples/production/kubeadm/README.md`](../../examples/production/kubeadm/README.md).

## Why it exists and when to use it

Managed control planes are excellent, but they require a cloud that offers one,
they cost a per-cluster fee, and they constrain what you can change (etcd
tuning, API-server flags, admission configuration, the audit backend). kubeadm
exists for the cases where those constraints do not fit:

- **On-prem and bare metal**, where there is no managed control plane to buy.
- **Air-gapped or regulated environments** that cannot use a public cloud.
- **Edge sites larger than k3s comfortably serves** but still self-operated.
- **Deep customisation** — custom API-server flags, a specific etcd topology, a
  particular audit or encryption backend the managed service will not expose.

If none of those apply and a managed cluster is available, a managed cluster is
almost always the better use of your team's time. kubeadm is a deliberate choice
to trade money for control and accept the operational bill.

## How it works underneath

`kubeadm init` performs a fixed sequence on the first control-plane node:

1. **Preflight checks** — swap, kernel modules, ports, CRI socket, and the
   `kubelet`/`kubeadm` versions.
2. **Certificate authority and PKI** — generates the cluster CA and issues the
   API-server, etcd, and client certificates into `/etc/kubernetes/pki`.
3. **kubeconfig files** — writes `admin.conf`, `controller-manager.conf`,
   `scheduler.conf` and the kubelet's.
4. **Static Pod manifests** — drops manifests for the API server, controller
   manager, scheduler and (for stacked etcd) etcd into
   `/etc/kubernetes/manifests`. The kubelet, watching that directory, starts
   them as static pods. The control plane *is* pods managed by the kubelet.
5. **Bootstrap tokens and add-ons** — installs CoreDNS and kube-proxy and sets
   up the bootstrap-token flow that lets other nodes join.

The control plane stays `NotReady` until you install a CNI, because kubeadm
deliberately does not choose one. From there, `kubeadm join` on other machines
either pulls the uploaded certs to become another control-plane node or
registers a kubelet as a worker.

The mechanism worth internalising: kubeadm configures components as **static
pods driven by the kubelet**, and etcd (in the default stacked topology) lives
on the control-plane nodes. Your HA and your data durability are therefore a
property of how many control-plane nodes you run and how you back up etcd —
both entirely your responsibility.

## Basic example

A minimal single-control-plane bootstrap (run on a prepared Linux host, never
against the kind lab):

```bash
# Front the API server with a load-balancer endpoint even for one node, so you
# can add control-plane nodes later — it cannot be added retroactively.
sudo kubeadm init \
  --control-plane-endpoint "k8s-api.internal:6443" \
  --upload-certs \
  --pod-network-cidr "10.244.0.0/16"

mkdir -p "$HOME/.kube"
sudo cp -i /etc/kubernetes/admin.conf "$HOME/.kube/config"
sudo chown "$(id -u):$(id -g)" "$HOME/.kube/config"

# Install a CNI that enforces NetworkPolicy (Calico or Cilium), then:
kubectl get nodes
```

Print a fresh worker join command from a control-plane node whenever the
24-hour bootstrap token has expired:

```bash
kubeadm token create --print-join-command
```

## Explanation

`--control-plane-endpoint` is the single most important flag. It points at a
load balancer (DNS name or virtual IP) in front of the API servers. Set it and
you can grow to an HA control plane by joining more nodes with `--control-plane`;
omit it and you are locked to a single control-plane node forever. `--upload-certs`
stores the control-plane certificates in a Secret so joining control-plane nodes
can fetch them, rather than you copying PKI by hand.

`--pod-network-cidr` must match the CIDR your chosen CNI expects. kubeadm does
not install a CNI because the CNI is a genuine architectural choice — Calico and
Cilium enforce NetworkPolicy, flannel does not, and that decision affects your
whole security posture.

## Common patterns

- **HA with stacked etcd.** Three (or five) control-plane nodes, each running
  etcd co-located, behind the load balancer. An odd count keeps quorum when one
  node is lost. This is the kubeadm default and is fine for most clusters.
- **External etcd.** For large clusters, run etcd as its own cluster and point
  kubeadm at it. More moving parts, better blast-radius isolation.
- **Immutable-ish node images.** Bake the CRI, kubelet and kubeadm into a golden
  image so `kubeadm join` is the only runtime step; this keeps nodes uniform.
- **GitOps for everything above the control plane.** Bootstrap with kubeadm,
  then hand the cluster to Argo CD or Flux so workloads are declarative even
  though the control plane was imperatively created.

## Production considerations

Self-managing means you own every `[M]` row of the [readiness
checklist](production-readiness-checklist.md):

- **etcd backups.** Snapshot etcd on a schedule, store snapshots off-cluster,
  and **rehearse a restore** — an untested backup is a hope, not a plan. See
  [etcd backup and restore](../operations/etcd-backup-and-restore.md).
- **HA.** An odd number of control-plane nodes across failure domains, a real
  load balancer, and etcd on fast disks with fsync latency monitored.
- **Upgrades.** You run `kubeadm upgrade plan`/`apply` on the first control-plane
  node, `kubeadm upgrade node` on the others, then drain and upgrade kubelets one
  at a time, control plane before nodes, within the skew policy. See [cluster
  upgrades](../operations/cluster-upgrades.md).
- **OS patching.** The nodes are yours: kernel CVEs, container-runtime updates
  and reboots are your runbook, not the provider's.

## Security considerations

- **Certificate lifetime.** kubeadm client and serving certificates default to a
  **one-year** lifetime. A `kubeadm upgrade` renews them as a side effect, so
  clusters upgraded yearly rarely lapse — but a cluster left untouched for a year
  goes dark. Monitor expiry with `kubeadm certs check-expiration` and rotate with
  `kubeadm certs renew all`. See [certificate
  rotation](../operations/certificate-rotation.md).
- **etcd encryption at rest.** kubeadm does not encrypt Secrets at rest by
  default. Configure an `EncryptionConfiguration` with a KMS provider; `identity`
  (the default) is plaintext in etcd.
- **API-server hardening.** Audit logging, admission plugins and authorization
  modes are yours to configure — the managed providers set sane defaults you now
  must reproduce.
- **Harden the CIS way.** Run kube-bench against your control plane; the managed
  providers pass most of it for you, self-managed clusters do not by default. See
  [CIS benchmark and kube-bench](../k8s-security/cis-benchmark-kube-bench.md).

## Troubleshooting

- **Nodes stay `NotReady` after init.** You have not installed a CNI, or its pod
  CIDR does not match `--pod-network-cidr`.
- **`kubeadm join` fails with a token error.** The bootstrap token expired after
  24 hours; mint a new one with `kubeadm token create --print-join-command`.
- **API server unreachable after ~a year.** Certificates expired; renew with
  `kubeadm certs renew all` and restart the control-plane static pods.
- **etcd quorum lost.** You ran an even number of control-plane nodes, or lost
  more than `(n-1)/2`; restore from an etcd snapshot.
- **Upgrade blocked by skew.** You tried to jump the control plane more than one
  minor at a time, or a kubelet is newer than the API server.

## Common mistakes

- **Forgetting `--control-plane-endpoint`**, locking yourself out of ever adding
  control-plane nodes.
- **Treating the etcd backup as done once it runs** — without a rehearsed
  restore you do not have a backup.
- **Running an even number of control-plane nodes**, which cannot improve etcd
  fault tolerance and can worsen it.
- **Never touching a working cluster** until the one-year certificates expire.
- **Choosing flannel and later needing NetworkPolicy** it cannot enforce.
- **Self-managing on a cloud that offers a managed control plane** for no reason
  beyond habit — you are paying in engineering time for control you may not use.

## Related topics

- [Managed Kubernetes compared](managed-kubernetes-compared.md)
- [k3s and lightweight distributions](k3s-and-lightweight.md)
- [Production-readiness checklist](production-readiness-checklist.md)
- [High-availability control plane](../operations/high-availability-control-plane.md)
- [etcd backup and restore](../operations/etcd-backup-and-restore.md)
- [Certificate rotation](../operations/certificate-rotation.md)
- [Cluster upgrades](../operations/cluster-upgrades.md)
