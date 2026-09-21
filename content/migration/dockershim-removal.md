---
title: Life after dockershim
description: Why removing dockershim did not remove Docker from your workflow, and what actually broke when Kubernetes dropped it.
level: intermediate
type: migration
status: current
versions: Kubernetes 1.37
prerequisites:
  - foundations/oci-specifications
  - foundations/runtime-stack
  - k8s-beginner/architecture
---

## Overview

"Kubernetes is deprecating Docker" was the most misread headline in the
project's history. dockershim — the kubelet's built-in shim for talking to the
Docker daemon — was deprecated in 1.20 and **removed in 1.24**. That changed how
the kubelet starts containers on a node. It did **not** stop Docker-built images
from running, and it did **not** stop you using `docker build`. This page
separates the myth from the small set of things that genuinely broke, and shows
how to check what your nodes actually run.

## The myth: "Kubernetes needs Docker"

It never did, at the level that matters. Kubernetes schedules **containers**,
and a container is an OCI runtime spec plus an OCI image — standards, not a
product. Docker was one way for the kubelet to create those containers, through
a shim, but it was always the odd one out: every other runtime spoke the
Container Runtime Interface (CRI) directly, and the kubelet had to carry
special-case Docker code to bridge the gap.

Removing dockershim removed that special case. The node now talks to a CRI
runtime — **containerd** or **CRI-O** — the same way it already talked to every
other runtime. Docker Engine itself is built on containerd, so on many nodes the
same containerd that Docker used is now driven directly by the kubelet, with
Docker's daemon simply out of the path.

## How it works underneath

The kubelet does not run containers itself. It calls a runtime over CRI, a gRPC
API with two services (`RuntimeService`, `ImageService`):

```text title="the node runtime path"
kubelet --CRI--> containerd (or CRI-O) --> runc (or crun) --> your container
```

Under dockershim the path had an extra hop: `kubelet -> dockershim -> dockerd ->
containerd -> runc`. Removing the shim deleted the first two hops. Nothing about
the *image* changed: the image containerd pulls and unpacks is the same OCI
image `docker build` produced.

## Why Docker images still run

Images built by Docker are **OCI images**. containerd and CRI-O consume OCI
images natively. So:

- `docker build` — **fine.** It produces an OCI image.
- Images on Docker Hub or any OCI registry — **fine.** Pulled by the CRI runtime
  directly.
- `docker run` on your laptop — **fine.** Unrelated to how a cluster node runs
  containers.
- The image you tested locally and the image the cluster runs — **the same
  artifact.**

The only thing that left is the kubelet's dependency on the Docker *daemon* being
installed on every node.

## What actually broke

A short, specific list — worth checking, not worth panicking over:

| Broke | Why | Fix |
|---|---|---|
| Node tooling that shelled out to `docker ps` / `docker inspect` on nodes | The Docker daemon may not be installed on a node any more | Use `crictl` (CRI) or `ctr` (containerd); scripts move from `docker` to `crictl` |
| Mounting `/var/run/docker.sock` into a Pod to build or inspect images | No Docker socket on the node | Use a daemonless builder (BuildKit, Buildah, Kaniko) or a rootless build service |
| Kubelet `--docker` / dockershim flags and config | The code is gone | Remove them; configure the CRI runtime instead |
| Logging/monitoring agents reading the Docker JSON log driver directly | Logs are written by the CRI runtime in the CRI log format | Read CRI logs, or the files under `/var/log/pods` |
| `cri-dockerd` users | dockershim is gone, but Mirantis' external `cri-dockerd` shim keeps Docker as a CRI runtime if you truly need it | Prefer containerd/CRI-O; `cri-dockerd` is a bridge, not a goal |

Note what is **not** on that list: your Deployments, your images, your registries
and your `docker build` pipeline. Application manifests never referenced the node
runtime.

## How to check your runtime

The runtime is reported per node:

```bash
kubectl get nodes -o wide
```

The `CONTAINER-RUNTIME` column shows, for example, `containerd://2.3.4` or
`cri-o://1.37.0`. If it says `docker://…`, that node is still using an external
Docker CRI bridge (`cri-dockerd`); plan to move it.

On a node itself, use `crictl` (which talks CRI, so it works regardless of the
runtime):

```bash
crictl info
crictl ps
crictl images
```

kind, minikube and every managed provider already run containerd or CRI-O, so a
current lab or cloud cluster has nothing to migrate — the removal is behind you.

## Common mistakes

- **Believing images must be rebuilt.** OCI images are runtime-agnostic; nothing
  to rebuild.
- **Believing `docker build` is dead.** It builds OCI images that run fine on
  CRI nodes.
- **Building images by mounting the Docker socket in-cluster.** That pattern
  depended on a node daemon and is a security risk regardless; use a daemonless
  builder.
- **Running `docker` commands in node debug scripts.** Use `crictl`/`ctr`; the
  Docker CLI may not be present.
- **Reaching for `cri-dockerd` by default.** It keeps Docker as a CRI shim, but
  containerd or CRI-O is the mainstream, supported path.

## Related topics

- [OCI specifications](../foundations/oci-specifications.md)
- [The runtime stack](../foundations/runtime-stack.md)
- [Kubernetes architecture](../k8s-beginner/architecture.md)
- [BuildKit and buildx](../docker-advanced/buildkit-and-buildx.md)
- [DinD versus socket mounting](../docker-advanced/dind-vs-socket-mounting.md)
