---
title: The container runtime stack
description: From docker CLI to dockerd, containerd, the shim and runc — and from kubelet through CRI to the same place.
level: foundations
type: concept
status: current
versions: Docker Engine 29, containerd 2.x, runc 1.5, Kubernetes 1.37, CRI-O 1.37
prerequisites:
  - foundations/what-containers-solve
  - foundations/oci-specifications
---

## Overview

"Docker starts a container" hides five processes and three protocols. Knowing
which component does what turns most runtime errors from mysteries into a
question of which log to read, and explains why Kubernetes does not need Docker
at all.

Two paths, converging at the same place:

```text
docker CLI --REST over /var/run/docker.sock--> dockerd
                                                 |  gRPC
                                                 v
kubelet ------CRI, gRPC over a unix socket---> containerd (CRI plugin) / CRI-O
                                                 |  exec
                                                 v
                                        containerd-shim-runc-v2
                                                 |  exec, then exits
                                                 v
                                               runc  --->  your process
```

## Why it exists and when to use it

The split exists so that the pieces can be replaced and restarted
independently. containerd can be upgraded without killing running containers,
because the shims keep them alive. Kubernetes can swap containerd for CRI-O
because the kubelet only speaks CRI. Sandboxed runtimes such as gVisor and Kata
plug in at the OCI runtime layer, because that interface is a specification.

You need this page whenever a container fails before your process runs, when
`kubectl` and the node disagree about what is running, or when you are deciding
what to install on a node.

## How it works underneath

### The Docker path

1. **`docker` CLI** is a thin HTTP client. It talks to the Engine API over the
   unix socket `/var/run/docker.sock` (or a remote endpoint via a context).
   Anything the CLI can do, a `curl` to that socket can do.
2. **`dockerd`** owns builds, networking, volumes, the image store and the
   Engine API. On Engine 29 the **containerd image store is the default for
   fresh installs**, so images live in containerd's content store rather than
   in a legacy graph driver.
3. **containerd** manages images, snapshots and container lifecycle over gRPC,
   organised into *namespaces*. Docker uses the `moby` namespace; Kubernetes
   uses `k8s.io`. They share one daemon and see different sets of containers,
   which is why `docker ps` shows nothing on a kind node while `crictl ps`
   shows everything.
4. **`containerd-shim-runc-v2`** is started per pod sandbox or container. It
   holds the container's stdio, reports exit status, and keeps the container
   alive across a containerd restart.
5. **`runc`** does the actual kernel work: create the namespaces, join the
   cgroup, set up mounts, `pivot_root`, drop capabilities, install the seccomp
   filter, then `execve()` your binary. It **exits immediately afterwards** —
   the process you see running is your program, re-parented to the shim, not to
   runc.

The versions of all four Docker-side components, and the daemon's own view of
its runtimes and drivers:

```bash
docker version
docker info --format 'CgroupDriver={{.CgroupDriver}} CgroupVersion={{.CgroupVersion}}'
```

```console include="captures/foundations/docker-version.txt"
```

```console include="captures/foundations/docker-info-runtime.txt"
```

### The Kubernetes path

The kubelet never talks to Docker. It speaks **CRI**, a gRPC API with two
services: `RuntimeService` (pod sandboxes, containers, exec, logs) and
`ImageService` (pull, list, remove). The endpoint is a unix socket configured
as `containerRuntimeEndpoint`, typically
`unix:///run/containerd/containerd.sock` or `unix:///var/run/crio/crio.sock`.

Starting a pod, in order:

1. The kubelet calls `RunPodSandbox`. The runtime creates the **sandbox**: the
   pod's network namespace plus a placeholder process (the `pause` container)
   that holds the namespaces open.
2. The CNI plugin is invoked to give the sandbox an IP.
3. For each image, `ImageService.PullImage` if it is not present, subject to
   `imagePullPolicy` and pull secrets.
4. `CreateContainer` then `StartContainer`, per init container in order, then
   the main containers. Each becomes a bundle and a `runc` invocation under a
   shim.
5. The kubelet polls `ContainerStatus`, runs probes, and reports back to the
   API server.

:::legacy dockershim
Before Kubernetes 1.24 the kubelet contained an adapter called dockershim that
let it drive Docker Engine. It was removed in 1.24 (2022). A node today runs
containerd or CRI-O directly; `cri-dockerd` exists outside the project for
people who must keep Docker Engine underneath. Images built by Docker are
unaffected: they are OCI images. See
[the dockershim removal](../migration/dockershim-removal.md).
:::

### Who stores what, where

| Component | Location on a node | Contents |
|---|---|---|
| containerd content store | `/var/lib/containerd/io.containerd.content.v1.content` | blobs by digest |
| containerd snapshots | `/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs` | unpacked layers |
| containerd task bundles | `/run/containerd/io.containerd.runtime.v2.task/<ns>/<id>` | `config.json`, `rootfs`, shim sockets |
| runc state | `/run/containerd/runc/<ns>` | one directory per container |
| kubelet pod data | `/var/lib/kubelet/pods/<pod-uid>` | volumes, projected Secrets |
| container logs | `/var/log/pods/<ns>_<pod>_<uid>/<container>/*.log` | what `kubectl logs` reads |
| Docker (legacy graph driver) | `/var/lib/docker` | images, volumes, networks |

### Configuration and cgroup driver

containerd's configuration lives in `/etc/containerd/config.toml`; containerd
2.x uses config `version = 3`. It declares the CRI plugin, the registry
configuration path, the snapshotter, and the runtime handlers — including
whether runc uses the **systemd** cgroup driver. The kubelet must use the same
driver as the runtime.

```bash
docker exec tasklane-control-plane cat /etc/containerd/config.toml
```

```console include="captures/foundations/containerd-config.txt"
```

Extra runtime handlers (`runsc` for gVisor, `kata` for Kata Containers) are
added here and surfaced to Kubernetes as a `RuntimeClass`.

## Basic example

Look at a node from the runtime's side rather than the API server's:

```bash
docker exec tasklane-control-plane crictl pods --namespace tasklane
docker exec tasklane-control-plane crictl ps --namespace tasklane
docker exec tasklane-control-plane ctr namespaces list
```

```console include="captures/foundations/crictl-pods.txt"
```

```console include="captures/foundations/ctr-namespaces.txt"
```

The process tree makes the hierarchy concrete — containerd, one shim per pod
sandbox, and the workload processes parented to their shim:

```console include="captures/foundations/runtime-process-tree.txt"
```

```console include="captures/foundations/runc-list.txt"
```

## Explanation

Several everyday facts fall out of this structure.

**Restarting containerd does not kill your containers.** The shims own them.
Restarting the *shim* does. This is why the shim exists as a separate binary at
all.

**`docker ps` is the wrong tool on a Kubernetes node.** Even when containerd is
shared, the CRI containers live in the `k8s.io` namespace. Use `crictl` (CRI
client) or `ctr -n k8s.io` (containerd client). `crictl` is the one that
understands pods.

**Pod networking is sandbox-level.** The IP belongs to the sandbox's network
namespace, so every container in the pod shares it, and a container restart
keeps the IP because the sandbox survives.

**`kubectl exec` is not a shell in your process.** The kubelet asks the runtime
to `Exec`; the runtime `setns()`es into the container's namespaces and starts a
*new* process there. It gets the container's namespaces and cgroup, but it is
not a child of your PID 1.

**"OCI runtime create failed" is a runc message.** When you see it, the
problem is in `config.json` or in what the kernel refused: a missing binary, a
bad `user`, an unsupported mount, an apparmor profile that is not loaded.

## Common patterns

| Task | Docker host | Kubernetes node |
|---|---|---|
| List containers | `docker ps` | `crictl ps` |
| List images | `docker images` | `crictl images` |
| Inspect the OCI spec | `docker inspect` | `crictl inspect` |
| Logs | `docker logs` | `crictl logs`, or `/var/log/pods/...` |
| Low-level containerd view | `ctr -n moby containers ls` | `ctr -n k8s.io containers ls` |
| Pull an image onto the node | `docker pull` | `crictl pull` |

`crictl images` is the node's real image inventory — the one the kubelet
consults for `imagePullPolicy` decisions and garbage-collects under disk
pressure:

```console include="captures/foundations/crictl-images.txt"
```

:::warning
`ctr` is a debugging client for containerd itself. It bypasses the CRI plugin,
so images pulled with `ctr` may not be visible to the kubelet, and containers
started with it are invisible to Kubernetes. Prefer `crictl` on a node.
:::

## Production considerations

- **Pick one runtime per node pool and keep it standard.** containerd is the
  common default (kind, most managed offerings); CRI-O is the default in some
  OpenShift-derived platforms.
- **containerd 2.x is required for modern Kubernetes.** Kubernetes 1.35 was the
  last release supporting containerd 1.x, and the metric
  `kubelet_cri_losing_support` warns about nodes that are behind.
- **Registry configuration lives on the node.** Mirrors, insecure registries
  and per-registry credentials are containerd configuration, not Kubernetes
  objects. Changing them means rolling nodes.
- **Runtime upgrades are node-disruptive in practice.** Drain, upgrade, reboot;
  see [node maintenance](../operations/node-maintenance.md).
- **Do not install Docker on Kubernetes nodes to "get images".** It adds a
  second image store and a second daemon competing for disk.

## Security considerations

- **The Docker socket is root.** Anything that can write to
  `/var/run/docker.sock` can start a privileged container and own the host.
  Mounting it into a container is granting root; see
  [the Docker socket is root](../docker-security/docker-socket-is-root.md).
- **The CRI socket is the same class of secret.** A pod with
  `/run/containerd/containerd.sock` mounted can create containers outside
  Kubernetes' view, with any security context it likes.
- **The runtime spec is the ground truth for security settings.** Verify
  `capabilities`, `noNewPrivileges` and `seccomp` by reading the container's
  `config.json` through `crictl inspect`, not by re-reading the manifest.
- **runc has had escape CVEs** (the 2019 `/proc/self/exe` overwrite is the
  famous one) and they are patched by upgrading runc on the node. Track the
  node's runc version as carefully as its Kubernetes version.
- **Sandboxed runtimes are a node-level choice.** A `RuntimeClass` is only as
  good as the handler configured in `config.toml` on the nodes that accept the
  workload.

## Troubleshooting

| Symptom | Where to look |
|---|---|
| Pod stuck in `ContainerCreating` | kubelet log, then `crictl pods` / `crictl ps -a`; often CNI or a volume mount |
| "OCI runtime create failed: exec: ... no such file or directory" | the entrypoint path does not exist in the image |
| "failed to create containerd task" | runtime-level failure; check containerd's log and the `config.json` |
| `kubectl logs` empty but the app is writing | the app writes to a file, not stdout, or the log file was rotated |
| Images present with `ctr` but not to the kubelet | wrong containerd namespace |
| Everything hangs after a containerd restart | shims lost; check for orphaned processes and restart the kubelet |

Order of investigation on a node: kubelet log → `crictl` → containerd log →
`config.json` in the bundle → kernel messages.

## Common mistakes

- **Assuming Kubernetes runs Docker.** It runs a CRI runtime; Docker is a build
  and local-run tool.
- **Debugging with `docker` on a node that uses containerd.**
- **Pulling with `ctr` instead of `crictl`** and wondering why the pod still
  reports `ImagePullBackOff`.
- **Treating the shim as overhead to be removed.** It is what keeps containers
  alive across runtime upgrades.
- **Expecting `kubectl exec` to share your process's file descriptors or
  environment.** It is a new process in the same namespaces.

## Related topics

- [OCI specifications](oci-specifications.md)
- [Overlay filesystems](overlay-filesystems.md)
- [Linux namespaces](linux-namespaces.md)
- [Build a container from scratch](container-from-scratch.md)
- [Kubernetes architecture](../k8s-beginner/architecture.md)
- [The dockershim removal](../migration/dockershim-removal.md)
- [Daemon configuration](../docker-advanced/daemon-configuration.md)
- [The Docker socket is root](../docker-security/docker-socket-is-root.md)
