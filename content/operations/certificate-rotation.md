---
title: Certificate rotation
description: The kubeadm PKI, one-year control-plane certs, automatic kubelet cert rotation, and how to renew before expiry.
level: advanced
type: tutorial
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/architecture
  - operations/cluster-upgrades
---

## Overview

Kubernetes is TLS all the way down: the apiserver, etcd, controllers and every
kubelet authenticate to each other with X.509 certificates from a cluster PKI.
Those certificates **expire** — the kubeadm control-plane certs last **one
year** — and an expired apiserver or etcd cert takes the cluster down hard. This
tutorial covers the kubeadm PKI layout, checking expiry, renewing control-plane
certs, and the automatic kubelet cert rotation that handles nodes for you.

## Why it exists

Certificates are how components prove identity without shared passwords. Short
lifetimes limit the damage of a leaked key, but they mean rotation is a
recurring operational duty, not a one-time setup. The classic outage is a
cluster that ran fine for eleven months and then stopped, because nobody renewed
the certs.

## The kubeadm PKI

kubeadm creates a certificate authority and issues leaf certs under
`/etc/kubernetes/pki/` on control-plane nodes:

| Path | For |
|---|---|
| `pki/ca.crt` + `ca.key` | the cluster root CA (usually **10-year** life) |
| `pki/apiserver.crt` | the API server's serving cert |
| `pki/apiserver-kubelet-client.crt` | apiserver → kubelet client auth |
| `pki/front-proxy-*` | the aggregation layer front proxy |
| `pki/etcd/*` | etcd server/peer and the apiserver→etcd client |
| `/etc/kubernetes/*.conf` | embedded client certs for admin, controller-manager, scheduler |

The **CA** is long-lived; the **leaf certs** are the 1-year ones you rotate. The
admin/controller/scheduler kubeconfigs embed client certs that also expire in a
year.

## Step 1 — Check expiry

```bash
kubeadm certs check-expiration
```

```console include="captures/operations/ops-cert-expiration.txt"
```

This lists every managed certificate, its expiry date, and whether the CA that
signed it is externally managed. Check it on a schedule — a monitored calendar
reminder well before the one-year mark is the cheapest outage prevention there
is.

## Step 2 — Renew control-plane certs

`kubeadm upgrade apply` renews all control-plane certs automatically, so a
cluster upgraded at least once a year effectively self-heals. To renew **without**
upgrading:

```bash
kubeadm certs renew all
```

Then **restart the control-plane static pods** (apiserver, controller-manager,
scheduler, etcd) so they load the new certs — moving their manifests out of
`/etc/kubernetes/manifests/` and back, or restarting the kubelet, does this.
Renewing regenerates the leaf certs from the existing CA, so client trust is
preserved.

:::warning Renew before, not after, expiry
Once the apiserver's cert expires, `kubectl` and the controllers can no longer
authenticate, and you may have to renew certs and fix kubeconfigs by hand on the
node. Renew with margin — do not wait for the last week.
:::

## Step 3 — kubelet certificates rotate themselves

Nodes are handled automatically. With `rotateCertificates: true` (the kubelet
default), the kubelet requests a **new client certificate** from the CSR API
before its current one expires, and the cluster's CSR-approving controller signs
it. Serving certs rotate too when `serverTLSBootstrap: true` and the serving
CSRs are approved (relevant for metrics-server verifying kubelets — see
[metrics-server](metrics-server-and-metrics-api.md)).

So in a healthy cluster you rotate the **control plane** by hand (or via upgrade)
and the **kubelets** rotate on their own. Confirm node certs are current by
checking that CSRs are being approved:

```bash
kubectl get csr
```

## Rotating the CA (rare and disruptive)

Rotating the **root CA** is a different, heavier operation: you must distribute
the new CA to every component before switching, or you break all trust at once.
It is rare (10-year life) and out of scope here — plan it as a project, not a
routine task.

## Common mistakes

- Letting the 1-year control-plane certs expire because nobody tracked the date.
- Running `kubeadm certs renew all` but **not restarting** the static pods, so
  the old certs stay loaded.
- Assuming kubelet rotation covers the control plane — it does not; the control
  plane is manual (or via upgrade).
- Forgetting the admin/scheduler/controller **kubeconfig** certs, which also
  expire in a year.
- Treating CA rotation like leaf renewal; it is far more disruptive.

## Related topics

- [Cluster upgrades](cluster-upgrades.md)
- [etcd backup and restore](etcd-backup-and-restore.md)
- [metrics-server and the Metrics API](metrics-server-and-metrics-api.md)
- [High availability control plane](high-availability-control-plane.md)
