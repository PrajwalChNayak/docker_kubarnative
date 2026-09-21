---
title: Architecture
description: Every component of a Kubernetes cluster, what it watches, what it writes, and how a container ends up running on a node.
level: beginner
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/why-orchestration
---

## Overview

A Kubernetes cluster is a small number of processes that all talk to one
place: the API server. The control plane decides *what* should exist, the
nodes make it exist, and nothing in either group talks to anything else
directly. Learning which process owns which decision turns most Kubernetes
debugging from guesswork into reading the right log.

This page walks the components in the order a request meets them, then walks
a pod from "created" to "running" in the other direction.

## Why it exists and when to use it

The split exists so that every actor is replaceable and every action is
auditable. The scheduler does not start containers; it writes a node name
into a Pod object. The Deployment controller does not talk to nodes; it
creates ReplicaSets. Each component reads and writes API objects, which means
each one can crash, restart and catch up from the current state without a
queue to replay or a peer to synchronise with.

You use this knowledge constantly:

- A pod stuck in `Pending` is a **scheduler** story.
- A pod stuck in `ContainerCreating` is a **kubelet**, CNI or CRI story.
- A Deployment whose `status` never moves is a **controller-manager** story.
- A rejected `kubectl apply` is an **admission** story and never reaches etcd.
- A Service with endpoints that still refuses traffic is a **kube-proxy**
  story.

## How it works underneath

### Control plane

**kube-apiserver** is the only component that talks to etcd, and the only
component the others talk to. It is a REST server for a set of typed,
versioned resources. Every request runs the same pipeline:

1. **Authentication.** Who is this? Client certificates, bearer tokens,
   ServiceAccount tokens, OIDC or a webhook. Failure is 401. Kubernetes has
   no user objects; identity comes from outside.
2. **Authorisation.** May this identity perform this verb on this resource in
   this namespace? Normally RBAC. Failure is 403.
3. **Admission.** Mutating admission plugins, webhooks and
   MutatingAdmissionPolicy (**GA in 1.36**) may change the object; then
   validating plugins, webhooks, ValidatingAdmissionPolicy (**GA in 1.30**)
   and Pod Security Admission may reject it. This is where namespace
   defaults, ServiceAccount injection and the `restricted` Pod Security
   profile are applied.
4. **Schema validation** of the resulting object, including the
   declarative validation rules that became **GA in 1.36**.
5. **Persistence** to etcd, which assigns a new `resourceVersion`, and a
   **watch event** to every client watching that resource.

Steps 1 to 4 are synchronous: if `kubectl apply` returns an error, nothing
was stored. Everything after step 5 is asynchronous.

**etcd** is the only stateful part of the cluster. It is a Raft-replicated
key-value store: an odd number of members (3 or 5) elect a leader, writes go
through the leader and commit when a quorum acknowledges them. Losing quorum
makes the cluster read-only at best. Two properties matter to you:

- Every object has a monotonically increasing `resourceVersion`, so a client
  can ask "send me everything that changed after X" and reconnect without
  missing events. That is what makes watches, and therefore controllers,
  reliable.
- etcd stores object bodies as written. Secrets are only encrypted at rest if
  you configure an [encryption provider](../k8s-security/secrets-management.md);
  see [Secrets](secrets.md).

**kube-scheduler** watches for pods with no `spec.nodeName`. For each one it
filters nodes that cannot run the pod (insufficient allocatable resources,
unmatched node selectors, untolerated taints, unavailable volumes), scores
the survivors, picks the best and **binds** the pod by writing the node name
through the `pods/binding` subresource. It never contacts the node. Part H
opens the box in [scheduler internals](../k8s-advanced/scheduler-internals.md).

**kube-controller-manager** is one binary running dozens of control loops:
Deployment, ReplicaSet, Job, StatefulSet, DaemonSet, node lifecycle,
ServiceAccount, EndpointSlice, garbage collection and more. Each loop watches
some objects and writes others. They share a client and leader election, so
exactly one instance is active in an HA control plane.

**cloud-controller-manager** holds the loops that talk to a cloud provider:
labelling nodes with region and zone, deleting Node objects for deleted
instances, and provisioning external load balancers for `type: LoadBalancer`
Services. A kind or bare-metal cluster has no cloud-controller-manager, which
is exactly why a LoadBalancer Service in the lab never gets an external
address.

### Node components

**kubelet** is the agent on every node. It watches the API server for pods
bound to *its* node and drives them to the described state:

- It calls the **CRI** (Container Runtime Interface) over a Unix socket to
  create the pod sandbox and containers, pull images, and stream logs and
  `exec` sessions.
- It creates the **cgroup v2** hierarchy that enforces CPU and memory limits,
  and reports node capacity and allocatable resources.
- It runs the **PLEG** (Pod Lifecycle Event Generator), which relists
  container state from the runtime and turns differences into pod lifecycle
  events. Without it, a container that died would not be noticed.
- It executes probes, mounts volumes (with the help of CSI plugins), writes
  the pod's `status`, and renews the node `Lease` that proves the node is
  alive.

The kubelet is the only component that runs the pods, and it trusts the API
server, not the other way around. A node that cannot reach the API server
keeps its existing pods running.

**kube-proxy** implements Services. It watches Services and EndpointSlices
and programs the node's packet-filtering rules so that traffic to a
ClusterIP is rewritten to a pod IP. On Linux it has three modes:

| Mode | Status in 1.37 | Notes |
|---|---|---|
| `iptables` | Default | Recommended default; rule updates get slower as Services grow |
| `nftables` | **GA since 1.33** (alpha 1.29, beta 1.31) | Fixes the iptables scaling problems. The docs say a future version will make it the default |
| `ipvs` | **Deprecated in 1.35** | Logs a warning at startup; expected to be disabled by default around 1.40 and removed around 1.43 (KEP-5495) |

Some CNI plugins (Cilium, Calico with eBPF) replace kube-proxy entirely.
Details are in
[kube-proxy and EndpointSlices](../k8s-intermediate/kube-proxy-and-endpointslices.md).

**Container runtime.** The kubelet speaks CRI to containerd or CRI-O, which
in turn uses an OCI runtime (`runc`) to create the container. Images built
with `docker build` are OCI images and run unchanged; only the node-side
daemon differs.

:::deprecated Docker as a runtime
Docker Engine is not a CRI implementation. The in-tree adapter that made it
look like one, **dockershim, was removed in Kubernetes 1.24**, so a node runs
containerd or CRI-O and `crictl`, not `docker`, is the node-level tool. See
[dockershim removal](../migration/dockershim-removal.md).
:::

:::note kind nodes
Each kind "node" is a container running systemd, a kubelet and containerd.
The control plane runs as static pods, which the kubelet reads from
`/etc/kubernetes/manifests` on disk rather than from the API server. That is
how the API server can be started by a kubelet that needs an API server.
:::

**Add-ons** are ordinary workloads that happen to be essential: CoreDNS for
cluster DNS, a CNI plugin (kindnet in the lab) for pod networking,
metrics-server for `kubectl top`, and in this lab Envoy Gateway and
cert-manager.

### What happens when a pod runs

1. A controller creates a Pod object. The API server authenticates,
   authorises, admits, validates and persists it.
2. The scheduler sees a pod with no node, scores nodes, binds it.
3. The kubelet on that node sees the bound pod, pulls images if needed, and
   asks the CRI runtime to create the sandbox (the `pause` container, which
   holds the network and IPC namespaces) and then the containers.
4. The CNI plugin gives the sandbox an IP.
5. The kubelet reports `status.phase: Running` and, once probes pass, the
   `Ready` condition.
6. The EndpointSlice controller sees a ready pod matching a Service selector
   and adds its IP to an EndpointSlice.
7. kube-proxy on every node programs rules for the new endpoint.

## Basic example

The lab cluster, as the API reports it:

```bash
kubectl get nodes -o wide
kubectl get nodes -o custom-columns=NAME:.metadata.name,RUNTIME:.status.nodeInfo.containerRuntimeVersion,KUBELET:.status.nodeInfo.kubeletVersion
kubectl -n kube-system get pods -l tier=control-plane -o wide
```

```console include="captures/k8s-beginner/get-nodes-wide.txt"
```

```console include="captures/k8s-beginner/node-runtime.txt"
```

```console include="captures/k8s-beginner/control-plane-pods.txt"
```

## Explanation

`kubectl get nodes -o wide` prints the kubelet version, the OS image, the
kernel and the container runtime of each node. The runtime column is the
honest answer to "does Kubernetes use Docker?": it names containerd and its
version.

The control-plane pods listed in `kube-system` are the static pods described
above: `kube-apiserver`, `kube-controller-manager`, `kube-scheduler` and
`etcd`, all on the control-plane node, plus `kube-proxy` and the CNI agent as
DaemonSets on every node. In a managed cluster (EKS, GKE, AKS) those first
four are invisible; the provider runs them, and `kubectl get pods -n
kube-system` shows only the node-side pieces.

The API server publishes its own health, broken down by check:

```bash
kubectl get --raw '/livez?verbose'
```

```console include="captures/k8s-beginner/livez-verbose.txt"
```

```console include="captures/k8s-beginner/readyz-verbose.txt"
```

Each line is one health check, including `etcd`. `livez` failing means the
process should be restarted; `readyz` failing means it should be removed from
the load balancer. Both are more useful than guessing from a timeout.

Node labels are the other half of the picture: roles, zones, architecture and
OS all live there, and the scheduler reads them.

```bash
kubectl get nodes --show-labels
```

```console include="captures/k8s-beginner/node-labels.txt"
```

kube-proxy announces its mode on startup:

```bash
kubectl -n kube-system logs ds/kube-proxy --tail=25
```

```console include="captures/k8s-beginner/kube-proxy-log.txt"
```

and its mode is set in its ConfigMap, which is where you change it:

```bash
kubectl -n kube-system get configmap kube-proxy -o jsonpath='{.data.config\.conf}'
```

```console include="captures/k8s-beginner/kube-proxy-mode.txt"
```

## Common patterns

- **Read the component that owns the field.** If `status` is wrong, find the
  controller that writes it; if `spec` is wrong, find the client that wrote
  it (`kubectl get -o yaml` and look at `metadata.managedFields`).
- **Use `kubectl get --raw`** for endpoints that have no kubectl verb:
  `/livez?verbose`, `/readyz?verbose`, `/version`, `/metrics`.
- **Expect three failure domains on every node**: the kubelet, the runtime
  and the network plugin. `kubectl describe node` and `kubectl describe pod`
  name which one complained.
- **Treat control-plane logs as a last resort in managed clusters.** You
  cannot read them; you read API objects and events instead.

## Production considerations

- **etcd is the cluster.** Back it up, watch its disk latency, keep an odd
  number of members, and never run it on the same disk as anything noisy.
  See [etcd backup and restore](../operations/etcd-backup-and-restore.md).
- **Version skew is bounded.** A kubelet may be up to **three** minor
  versions older than kube-apiserver and never newer; kubectl is supported
  within one minor version either way. Details in
  [version skew policy](../operations/version-skew-policy.md).
- **HA means three control-plane nodes**, an external load balancer in front
  of the API servers, and leader election doing its job for the controllers.
- **Static pods are invisible to the scheduler.** They are bound to their
  node by the kubelet, so control-plane resource pressure is your problem to
  plan for.

## Security considerations

- The API server is the only front door, which is why
  [authentication and authorisation](../k8s-security/authentication-and-authorisation.md)
  and [audit logging](../k8s-security/audit-logging.md) are so effective: every
  mutation passes through one auditable pipeline.
- **etcd holds Secrets in the clear unless you configure encryption at rest.**
  Anyone with etcd access, or an etcd backup, has every Secret.
- The kubelet exposes an authenticated API of its own (logs, exec, metrics).
  Fine-grained kubelet API authorisation became **GA in 1.36**.
- Node compromise is pod compromise for every pod on that node. That is the
  reasoning behind
  [pod security standards](../k8s-security/pod-security-standards.md) and
  [user namespaces](../k8s-security/user-namespaces.md).

## Troubleshooting

| Symptom | Component to look at | First command |
|---|---|---|
| `Pending` pod | scheduler | `kubectl describe pod` (events show why no node fits) |
| `ContainerCreating` for minutes | kubelet, CNI, CSI | `kubectl describe pod`, node events |
| `ImagePullBackOff` | kubelet and registry | `kubectl describe pod` |
| Object accepted but nothing happens | controller-manager | `kubectl get <kind> -o yaml`, check `status` and `observedGeneration` |
| `kubectl` hangs or 5xx | apiserver, etcd | `kubectl get --raw '/readyz?verbose'` |
| Service resolves but connections fail | kube-proxy, EndpointSlices | `kubectl get endpointslices` |
| Node `NotReady` | kubelet, node Lease | `kubectl describe node` |

## Common mistakes

- **Thinking the scheduler starts containers.** It writes a node name; the
  kubelet does the rest.
- **Looking for a Docker daemon on the nodes.** CRI runtimes have replaced it
  since 1.24; `crictl`, not `docker`, is the node-level tool.
- **Restarting the kubelet to fix an API object.** Nothing about a rejected
  manifest or a wrong `replicas` count lives on a node.
- **Assuming a healthy control plane means healthy workloads.** `livez` says
  the API server is fine, not that your pods are.
- **Treating a control-plane outage as an outage.** Running pods keep
  running; you just cannot change anything, and Services stop tracking new
  endpoints.

## Related topics

- [Declarative model and reconciliation](declarative-model-and-reconciliation.md)
- [Pods](pods.md)
- [Services](services.md)
- [kube-proxy and EndpointSlices](../k8s-intermediate/kube-proxy-and-endpointslices.md)
- [Network model and CNI](../k8s-intermediate/network-model-and-cni.md)
- [Version skew policy](../operations/version-skew-policy.md)
- [dockershim removal](../migration/dockershim-removal.md)
