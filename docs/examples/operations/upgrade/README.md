# Safe minor upgrade of a kubeadm cluster

A runnable outline for upgrading a self-managed (kubeadm) cluster one minor at a
time, with the pre-flight checks that stop an upgrade from taking the cluster
down. Written for **Kubernetes 1.37**. The lab is a kind cluster, so treat the
kubeadm/etcdctl commands as the shape you would run on a real node; kind manages
its own upgrades by recreating nodes.

## The rules

- **One minor at a time.** 1.35 → 1.36 → 1.37. Never skip a minor.
- **Control plane first, then nodes.** kube-apiserver is upgraded before any
  kubelet. A kubelet may lag the apiserver by up to **3 minors** and must never
  be newer; `kubectl` must be within **±1** minor of the apiserver. See the
  version-skew-policy page.
- **Read the release notes** for every minor you pass through, especially the
  deprecations and any urgent-upgrade notes.
- **Back up etcd before you touch the control plane** (see below).

## 1. Scan for deprecated APIs before upgrading

Deprecated (not yet removed) APIs still serve today but may be removed in a
future minor. Find them with **Pluto** (kubent is effectively unmaintained —
its last release was 2024). Scan your manifests on disk:

```bash
.tools/kubectl.exe kustomize examples/k8s > /tmp/rendered.yaml   # optional: render first
pluto detect-files -d examples/
```

Scan what is actually live in the cluster by piping objects through Pluto:

```bash
kubectl get deployments,daemonsets,statefulsets,ingresses,networkpolicies \
  -A -o yaml | pluto detect -
```

Also watch the apiserver's own signal for deprecated calls:

```bash
# apiserver_requested_deprecated_apis is a gauge, one series per deprecated
# group/version/resource that has been requested. Any non-zero series names an
# API something is still calling.
kubectl get --raw '/metrics' | grep apiserver_requested_deprecated_apis
```

No API versions were removed in 1.33–1.37, but the audit log and this metric
are how you catch a caller before the minor that finally removes an API.

## 2. Back up etcd

etcd is a Raft-replicated key-value store; a majority (quorum) of members must
agree, so production runs an odd number (3 or 5). Snapshot it before upgrading.
etcd runs as a static pod, so exec into it and use its own `etcdctl`:

```bash
kubectl -n kube-system exec etcd-<control-plane-node> -- \
  etcdctl \
    --endpoints=https://127.0.0.1:2379 \
    --cacert=/etc/kubernetes/pki/etcd/ca.crt \
    --cert=/etc/kubernetes/pki/etcd/server.crt \
    --key=/etc/kubernetes/pki/etcd/server.key \
    snapshot save /var/lib/etcd/snapshot.db
```

Restore (control plane stopped) is `etcdctl snapshot restore` into a fresh data
dir, then repoint etcd at it:

```bash
etcdctl snapshot restore /var/lib/etcd/snapshot.db \
  --data-dir=/var/lib/etcd-restore
# then update the etcd static-pod manifest's hostPath to the restored dir.
```

Defragment periodically to reclaim space after compaction:

```bash
etcdctl --endpoints=https://127.0.0.1:2379 <certs...> defrag
```

## 3. Upgrade the control plane

```bash
# On the first control-plane node, upgrade the kubeadm binary to 1.37 first.
sudo kubeadm upgrade plan
sudo kubeadm upgrade apply v1.37.0
# Then upgrade kubelet + kubectl packages on that node and restart the kubelet.
```

On additional control-plane nodes use `kubeadm upgrade node`.

## 4. Drain and upgrade each worker

Respect PodDisruptionBudgets so you never take down more replicas than the app
allows:

```bash
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data
# upgrade kubelet + kubeadm on the node, restart kubelet, then:
kubectl uncordon <node>
```

`--ignore-daemonsets` is required because DaemonSet pods are recreated on the
node and cannot be drained. `drain` blocks while a PDB would be violated — that
is the safety mechanism, not an error.

## 5. Certificate rotation

kubeadm issues control-plane certificates with a **1-year** lifetime and renews
them automatically on `kubeadm upgrade`. Check and renew manually:

```bash
kubeadm certs check-expiration
kubeadm certs renew all      # then restart the control-plane static pods
```

kubelet client/serving certs rotate on their own when
`rotateCertificates: true` (the default); the kubelet requests a new cert from
the CSR API before expiry.

## Node-replacement alternative

Instead of in-place drains, many teams do **surge / blue-green node pools**:
bring up new nodes on the target version, cordon and drain the old pool, then
delete it. It is easier to roll back (keep the old pool until you are happy) and
is the default model on managed control planes.
