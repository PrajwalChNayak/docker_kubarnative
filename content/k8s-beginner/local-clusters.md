---
title: Local clusters
description: Run a real Kubernetes 1.37 cluster on your laptop with kind, and know when minikube, k3d or Docker Desktop is the better choice.
level: beginner
type: tutorial
status: current
versions: Kubernetes 1.37, kind v0.33.0
prerequisites:
  - k8s-beginner/architecture
---

## Overview

Everything in Parts F to L runs on a disposable local cluster. The handbook's
lab is **kind** (Kubernetes IN Docker): one control-plane node and two
workers, all containers on your machine, running the same Kubernetes 1.37.0
build the manifests were validated against.

A local cluster is not a small production cluster. It has no cloud
controller, no real load balancer, one machine's worth of failure domains,
and storage that disappears with the cluster. Knowing which gaps exist is
half the value of running one.

## Choosing a tool

| Tool | What it is | Multi-node | Good for | Watch out for |
|---|---|---|---|---|
| **kind** v0.33.0 | Nodes are Docker containers running kubelet + containerd | Yes, trivially | CI, multi-node behaviour, upstream conformance | No LoadBalancer or storage beyond the local-path provisioner |
| **minikube** v1.39.0 | A VM or container per cluster, many drivers | Yes | Trying add-ons (`minikube addons`), non-Docker drivers | Heavier; `minikube tunnel` needed for LoadBalancer |
| **k3d** v5.9.0 | k3s (v1.37.0+k3s1) in Docker | Yes | Fastest start, low memory, edge-like setup | k3s is a distribution: different defaults (ServiceLB, Traefik, SQLite by default) |
| **Docker Desktop** | Single-node Kubernetes bundled with Docker Desktop | No | Zero extra tooling if you already run it | Licensing: free only for companies with fewer than 250 employees **and** under $10M annual revenue, plus personal, education and non-commercial open-source use |

The handbook uses kind because it gives three nodes, pins the Kubernetes
version by image digest, and throws everything away with one command. Any of
the four can run most exercises; anything that needs two zones or a node
drain needs a multi-node cluster.

## Create the lab cluster

::::tabs
@tab kind (used by this handbook)

```yaml include="examples/lab/kind-config.yaml"
```

```bash
kind create cluster --config examples/lab/kind-config.yaml
kubectl config get-contexts
kubectl get nodes -o wide
```

The context is called `kind-tasklane`. `extraPortMappings` is what makes
`http://localhost:8080` reach the Gateway later: kind publishes the
control-plane container's port 30080 on your host. The two workers carry
`topology.kubernetes.io/zone` labels so the topology-spread examples have
something to spread across.

Load locally built images into the nodes; the nodes have their own image
store and cannot see your Docker daemon:

```bash
kind load docker-image tasklane-api:0.1.0 tasklane-worker:0.1.0 --name tasklane
```

Delete the whole thing with:

```bash
kind delete cluster --name tasklane
```

@tab minikube

```bash
minikube start --nodes 3 --kubernetes-version v1.37.0
minikube image load tasklane-api:0.1.0
minikube addons list
```

The context is `minikube`. Check which Kubernetes versions your minikube
release supports before pinning one. `minikube tunnel` runs a process that
gives `type: LoadBalancer` Services a reachable address, which kind does not
do out of the box.

@tab k3d

```bash
k3d cluster create tasklane --agents 2 --image rancher/k3s:v1.37.0-k3s1
k3d image import tasklane-api:0.1.0 -c tasklane
```

The context is `k3d-tasklane`. k3s is a conformant but opinionated
distribution: it ships its own service load balancer (klipper), Traefik as an
ingress controller, and a local-path storage class. Turn off what you do not
want at cluster creation time, or your results will not match a stock
cluster.

@tab Docker Desktop

Enable Kubernetes in Docker Desktop's settings. The context is
`docker-desktop`. It is a single node, so pods cannot be spread across zones
and a node drain empties the cluster. Images you build locally are already
visible to the cluster, which is convenient and unlike every other
environment you will meet.

::::

## What a local cluster cannot do

- **`type: LoadBalancer` never gets an address.** There is no cloud
  controller to provision one, so `EXTERNAL-IP` stays `<pending>` for ever in
  kind. `sigs.k8s.io/cloud-provider-kind` is a SIG project that runs load
  balancer containers on your host for kind clusters if you need real
  external IPs; the handbook instead exposes traffic through the Gateway on
  `localhost:8080`.
- **Storage is local.** kind's default StorageClass is a local-path
  provisioner: no replication, no snapshots, and data dies with the node
  container.
- **Nodes share one kernel.** Anything kernel-specific (cgroup settings,
  sysctls, kernel version checks) reflects your machine, not a server.
- **Resource pressure is fake.** The nodes share your laptop's CPU and
  memory, so eviction and OOM behaviour is not representative.
- **No real network.** Pod-to-pod traffic never leaves the host, so latency
  and MTU problems stay hidden.

## Add-ons used by the handbook lab

The lab installs three things on top of the bare cluster:

- **metrics-server v0.9.0**, for `kubectl top` and the HPA later. kind's
  kubelets serve self-signed certificates, so the lab patches in
  `--kubelet-insecure-tls` — acceptable in a disposable cluster, never in
  production.
- **Envoy Gateway v1.9.1** plus the Gateway API v1.6.2 standard-channel CRDs,
  which serve [Gateway API](../k8s-intermediate/gateway-api.md).
- **cert-manager v1.21.2**, used in Part G for TLS.

```yaml include="examples/lab/metrics-server/kustomization.yaml"
```

## Verify the cluster

```bash
kubectl version
kubectl cluster-info
kubectl get nodes -o wide
kubectl get pods -n kube-system -o wide
```

```console include="captures/k8s-beginner/kubectl-version.txt"
```

```console include="captures/k8s-beginner/cluster-info.txt"
```

```console include="captures/k8s-beginner/kube-system-pods.txt"
```

Expect `kube-apiserver`, `kube-controller-manager`, `kube-scheduler` and
`etcd` on the control-plane node, `kube-proxy` and the CNI agent on every
node, and two CoreDNS pods.

:::tip Rebuild, do not repair
A local cluster is cattle. If it gets into a strange state, delete and
recreate it — that takes a couple of minutes and teaches you whether your
manifests really are self-contained.
:::

## Common mistakes

- **Forgetting to load the image.** Nodes cannot see your local Docker
  images; without `kind load docker-image` the pod ends in
  `ImagePullBackOff`, because a non-`latest` tag defaults to
  `imagePullPolicy: IfNotPresent` and the node has nothing to find.
- **Using `:latest` so the node "pulls the newest one".** It pulls from a
  registry you did not push to, and the handbook bans the tag for good
  reasons: no immutability, no rollback.
- **Expecting `EXTERNAL-IP` to appear.** In kind it will not. This is the
  single most common "my Service is broken" report.
- **Testing NodePort from the host without a port mapping.** kind only
  publishes the ports listed in `extraPortMappings`.
- **Believing local performance numbers.** Three "nodes" sharing one laptop
  tell you nothing about production capacity.
- **Leaving the cluster running.** It keeps eating CPU and memory; delete it
  when you stop.

## Related topics

- [Architecture](architecture.md)
- [kubectl fundamentals](kubectl-fundamentals.md)
- [kubeconfig and contexts](kubeconfig-and-contexts.md)
- [Services](services.md)
- [Tasklane on Kubernetes](tasklane-on-kubernetes.md)
- [k3s and lightweight distributions](../production/k3s-and-lightweight.md)
