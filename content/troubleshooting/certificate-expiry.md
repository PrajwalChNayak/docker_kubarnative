---
title: Certificate expiry
description: How expired kubeadm PKI, kubelet client certs or the API server certificate break a cluster, the symptoms, and using kubeadm certs check-expiration and renew.
level: advanced
type: troubleshooting
status: current
versions: Kubernetes 1.37
prerequisites:
  - troubleshooting/method
  - k8s-beginner/architecture
  - operations/certificate-rotation
---

## Overview

Kubernetes authenticates its components with TLS client and serving
certificates. Most are issued with a **one-year** lifetime by `kubeadm`, and a
cluster that is not upgraded or rotated within that year can wake up unable to
talk to itself: `kubectl` is rejected, the API server will not start, or nodes
go `NotReady` because the kubelet's client certificate expired. This page
covers which certificates expire, the symptoms, and `kubeadm certs
check-expiration` / `renew`.

## Symptoms

- `kubectl` fails with `x509: certificate has expired or is not yet valid`.
- The API server (a static pod) crash-loops; its log shows an expired serving or
  client certificate.
- Nodes go `NotReady`; the kubelet log shows it cannot authenticate to the API
  server (expired kubelet client cert) — see [Node NotReady](node-notready.md).
- Aggregated APIs or webhooks fail with TLS validation errors.

## How it works underneath

`kubeadm` builds a PKI under `/etc/kubernetes/pki`: a cluster CA, the API server
serving cert, the API server's client cert to the kubelet, the
controller-manager and scheduler client certs (embedded in their kubeconfigs
under `/etc/kubernetes`), the front-proxy CA and cert, and the etcd CA and
certs. Almost all leaf certificates are issued for **one year**; the CAs are
issued for **ten years**.

Two rotation paths matter:

- **Control-plane certs are not auto-renewed at runtime.** `kubeadm` renews them
  on every `kubeadm upgrade apply`. A cluster upgraded at least yearly therefore
  rotates them as a side effect. A cluster left alone for over a year hits
  expiry. You renew manually with `kubeadm certs renew`.
- **The kubelet client cert usually auto-rotates.** With
  `rotateCertificates: true` (the kubeadm default) and
  `RotateKubeletServerCertificate`, the kubelet requests a fresh client cert from
  the API server before expiry via the CSR API. This normally just works — but it
  fails to bootstrap if the cluster CA or the API server itself has already
  expired, producing a chicken-and-egg outage.

When a leaf cert expires, the component presenting it is rejected by its peer:
`kubectl` (using an expired admin cert) is rejected by the API server; the API
server (presenting an expired serving cert, or an expired client cert to the
kubelet/etcd) fails its own connections and crash-loops; the kubelet (with an
expired client cert that could not rotate) is rejected and the node goes
`NotReady`.

:::note kind and managed clusters
Managed control planes (EKS, GKE, AKS) rotate control-plane certificates for
you — this page is about self-managed `kubeadm` clusters. In the kind lab the
control plane is a `kubeadm` cluster inside a container, so the same commands
apply if you exec into the node.
:::

## Diagnosis

1. **Check expirations across the PKI.** On a control-plane node:

   ```bash
   kubeadm certs check-expiration
   ```

   It lists every managed certificate, its expiry date, residual time, and
   whether the CA that signs it is still valid.

2. **Confirm the symptom is a cert.** An expired-cert error is explicit: the
   command fails with an `x509: certificate has expired or is not yet valid`
   message naming the certificate and the times.

   ```bash
   kubectl get nodes
   ```

3. **Inspect a specific certificate** if you need detail:

   ```bash
   openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -enddate
   ```

4. **Kubelet cert** on a `NotReady` node — check the kubelet log and the client
   cert under `/var/lib/kubelet/pki/`:

   ```bash
   journalctl -u kubelet --no-pager | grep -i certificate | tail
   ```

## Fixes

- **Renew control-plane certificates** on each control-plane node:

  ```bash
  kubeadm certs renew all
  ```

  Then restart the control-plane static pods (the kubelet recreates them when you
  move their manifests, or restart the kubelet). Renewing also refreshes the
  admin kubeconfig certs; regenerate operator kubeconfigs if needed.

- **Prefer an upgrade** where possible: `kubeadm upgrade apply` renews certs as
  part of the upgrade, keeping the cluster on a supported version at the same
  time.

- **Recover an expired kubelet client cert.** If auto-rotation failed because the
  cluster CA/API server was also expired, renew the control-plane PKI first, then
  let the kubelet re-bootstrap (it may need its bootstrap kubeconfig or a fresh
  CSR approval).

- **Never let the CA expire.** A ten-year CA expiry is a full re-issue of the
  cluster PKI and every kubeconfig — plan CA rotation long before then.

## Prevention

- **Upgrade at least yearly.** Supported Kubernetes minors last about 14 months;
  staying current keeps you inside the one-year cert window and rotates certs
  automatically.
- **Monitor certificate expiry.** Alert weeks ahead on the API server serving
  cert and the kubeadm PKI (`check-expiration`, or a cert-expiry exporter).
- **Keep kubelet auto-rotation on** (`rotateCertificates: true`) so node certs
  renew themselves.
- **Back up `/etc/kubernetes/pki`** (especially the CAs) so you can recover, and
  document the renew runbook before you need it.

## Common mistakes

- Letting a lab or a rarely-touched cluster sit for more than a year and hitting
  a total control-plane outage.
- Renewing leaf certs but forgetting to restart the static-pod control-plane
  components that still present the old ones.
- Assuming the kubelet cert will auto-rotate even after the cluster CA/API server
  has expired — it cannot bootstrap then.
- Ignoring CA expiry until it happens, turning a routine renew into a cluster
  rebuild.
- Debugging a `NotReady` node's app when the cause is an expired kubelet cert.

## Related topics

- [A method for debugging Kubernetes](method.md)
- [Node NotReady](node-notready.md)
- [Kubernetes architecture](../k8s-beginner/architecture.md)
- [Certificate rotation](../operations/certificate-rotation.md)
- [Cluster upgrades](../operations/cluster-upgrades.md)
