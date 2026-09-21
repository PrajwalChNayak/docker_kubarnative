# kubeadm cluster-bootstrap reference

kubeadm bootstraps a conformant Kubernetes control plane and joins nodes to it.
It does **not** provision machines, install a CNI, configure a load balancer, or
manage day-2 operations. With kubeadm you own etcd, certificates, upgrades, the
CNI choice, the load balancer in front of the API servers, and OS patching.

**Do not run these against the kind lab.** They are for real Linux hosts. This
reference targets Kubernetes **1.37**.

## Prerequisites on every node

```bash
# Kubernetes requires swap handling to be deliberate; the simplest is off.
sudo swapoff -a

# Kernel modules and sysctls the CNI and kube-proxy rely on.
sudo modprobe br_netfilter
cat <<'EOF' | sudo tee /etc/sysctl.d/k8s.conf
net.bridge.bridge-nf-call-iptables  = 1
net.ipv4.ip_forward                 = 1
EOF
sudo sysctl --system
```

You also need a CRI runtime (containerd or CRI-O) with the systemd cgroup
driver, plus the `kubeadm`, `kubelet` and `kubectl` packages pinned to the
target minor version. Kubernetes runs a CRI runtime directly — there is no
Docker involved, and dockershim was removed in 1.24.

## Initialise the first control-plane node

```bash
# --control-plane-endpoint points at a load balancer (DNS or VIP) in FRONT of
# the API servers, so more control-plane nodes can join later. Set it even for
# a single control-plane node you might grow — you cannot add it afterwards.
# --upload-certs stores the control-plane certs in a Secret so other control
# planes can pull them during join.
sudo kubeadm init \
  --control-plane-endpoint "k8s-api.internal:6443" \
  --upload-certs \
  --pod-network-cidr "10.244.0.0/16"

# Set up kubectl for your user (kubeadm prints these too).
mkdir -p "$HOME/.kube"
sudo cp -i /etc/kubernetes/admin.conf "$HOME/.kube/config"
sudo chown "$(id -u):$(id -g)" "$HOME/.kube/config"
```

kubeadm prints two join commands at the end. Save them; the token expires in
24 hours.

## Install a CNI

The control plane stays `NotReady` until a pod network is installed. kubeadm
does not pick one for you. Install Calico, Cilium, or another CNI whose pod CIDR
matches `--pod-network-cidr`. Only a CNI that implements NetworkPolicy (Calico,
Cilium) can later enforce a default-deny policy — plain flannel cannot.

## Join more control-plane nodes (HA)

```bash
# From `kubeadm init --upload-certs`. Needs the extra --control-plane and
# --certificate-key. Use an ODD number of control-plane nodes (3 or 5) so etcd
# keeps quorum when one is lost.
sudo kubeadm join k8s-api.internal:6443 \
  --token <token> \
  --discovery-token-ca-cert-hash sha256:<hash> \
  --control-plane \
  --certificate-key <certificate-key>
```

Stacked etcd (etcd co-located on each control-plane node) is the kubeadm
default; an external etcd cluster is the alternative for larger clusters.

## Join worker nodes

```bash
sudo kubeadm join k8s-api.internal:6443 \
  --token <token> \
  --discovery-token-ca-cert-hash sha256:<hash>
```

If the token has expired, mint a fresh one and print a ready-made join command
from any control-plane node:

```bash
kubeadm token create --print-join-command
```

## Upgrades (you drive every step)

```bash
# On the first control-plane node, after bumping the kubeadm package:
sudo kubeadm upgrade plan
sudo kubeadm upgrade apply v1.37.0

# Then, one node at a time: drain, upgrade the kubelet/kubectl packages,
# restart the kubelet, uncordon.
kubectl drain <node> --ignore-daemonsets
sudo systemctl restart kubelet
kubectl uncordon <node>
```

Other control-plane nodes use `kubeadm upgrade node` instead of
`upgrade apply`. Respect the version-skew policy: upgrade the control plane
before the kubelets, and never let a kubelet be newer than the API server.

## Certificates

```bash
# kubeadm client/serving certs default to a ONE YEAR lifetime.
kubeadm certs check-expiration
sudo kubeadm certs renew all   # then restart the control-plane static pods
```

A `kubeadm upgrade` renews the control-plane certificates as a side effect, so
clusters upgraded at least yearly rarely hit expiry — but clusters left alone
for a year go dark when the certs lapse. Monitor expiry explicitly.

## When kubeadm makes sense

On-prem or bare metal, air-gapped/regulated environments, edge sites too large
for k3s, or when you need control the managed providers do not expose. The cost
is that every control-plane row of `../readiness-checklist.md` is now yours:
etcd backups, HA, cert rotation, upgrades and OS patching. See
`content/production/kubeadm.md`.
