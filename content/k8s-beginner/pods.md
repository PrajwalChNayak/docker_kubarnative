---
title: Pods
description: The smallest deployable unit in Kubernetes: what containers share inside one, how its phases and conditions work, and why you rarely create one directly.
level: beginner
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/manifest-anatomy
  - k8s-beginner/labels-selectors-annotations
---

## Overview

A pod is one or more containers that share a network namespace, an IPC
namespace, a set of volumes and a lifecycle. Kubernetes schedules pods, not
containers: a pod is placed on exactly one node, gets one IP address, and
lives and dies as a unit.

You will create bare pods perhaps three times in your career — to learn, to
debug, and to run something genuinely one-off. Everything else comes from a
controller that creates pods for you.

## Why it exists and when to use it

Docker gives you a container. Two containers that must share a loopback
interface, a volume and a fate have no Docker-level abstraction; you get
`--network container:x`, a shared volume and a hope. The pod makes that
grouping a first-class object with a defined lifecycle.

Use multiple containers in a pod only when they are genuinely one unit:

- a **sidecar** that ships logs, proxies traffic or refreshes credentials for
  the main container,
- an **init container** that prepares state before the app starts,
- an **adapter** that reshapes the app's output for the platform.

If two containers could be scaled, restarted or released independently, they
belong in different pods. "They talk to each other" is not a reason.

## How it works underneath

### What a pod actually is on the node

The kubelet asks the CRI runtime to create a **pod sandbox** first. On Linux
that is an infrastructure container — conventionally called the **pause
container** — which does nothing but hold the namespaces open and reap
orphaned processes. Every application container in the pod then joins the
sandbox's network and IPC namespaces.

Consequences you can rely on:

- All containers in a pod share **one IP address** and one port space.
  `localhost` inside one container reaches the others. Two containers cannot
  bind the same port.
- They share **IPC** (System V semaphores, shared memory) but **not** the PID
  namespace by default, and **not** the filesystem: each container has its
  own root filesystem, and sharing files needs a volume.
- Killing the sandbox kills the pod. Restarting an application container does
  not change the pod's IP, because the sandbox survives.

A pod's IP comes from the CNI plugin and is **not stable across
recreations**. That is what [Services](services.md) exist for.

### Phases, conditions and container states

`status.phase` is a coarse summary:

| Phase | Meaning |
|---|---|
| `Pending` | Accepted, but not all containers are running: scheduling, image pull or volume mounting |
| `Running` | Bound to a node, all containers created, at least one running or starting |
| `Succeeded` | All containers exited 0 and will not restart |
| `Failed` | All containers terminated, at least one non-zero or killed |
| `Unknown` | The node's status cannot be obtained |

Phase is too coarse for decisions. `status.conditions` is where the detail
is: `PodScheduled`, `PodReadyToStartContainers` (the sandbox and network are
ready), `Initialized`, `ContainersReady` and `Ready`. **`Ready` is the one
that controls traffic**: a pod that is `Running` but not `Ready` stays out of
Service endpoints.

Each container additionally reports a state — `waiting` (with a reason such
as `ContainerCreating`, `ImagePullBackOff`, `CrashLoopBackOff`), `running`,
or `terminated` (with an exit code and reason such as `OOMKilled`) — plus a
`restartCount` and a `lastState` for the previous instance.

### restartPolicy

`spec.restartPolicy` applies to the **containers inside the pod**, not to the
pod itself:

- `Always` (default) — restart a container whenever it exits, with
  exponential back-off up to five minutes. Required for pods managed by a
  Deployment.
- `OnFailure` — restart only on a non-zero exit. Used by Jobs.
- `Never` — never restart. The pod moves to `Succeeded` or `Failed`.

A restarted container is the *same* pod with a higher `restartCount`, a new
container ID, and the same IP. Nothing recreates a deleted pod unless a
controller owns it.

### Init containers and sidecars

`spec.initContainers` run to completion, in order, before the app containers
start. The Tasklane API uses one to run its database migration. An init
container with `restartPolicy: Always` is a **sidecar** (stable since 1.33):
it starts before the app containers, keeps running alongside them, and is
terminated after them — the ordering guarantees a plain sidecar container
never had.

### Pods are (almost) immutable

Most of `spec` cannot be changed after creation. You may change the image of
a container, tolerations (additively), `activeDeadlineSeconds`, and — since
in-place Pod resize went **GA in 1.35** — CPU and memory resources through
the `resize` subresource. Everything else means deleting and recreating,
which is exactly what controllers do on your behalf.

## Basic example

```yaml include="examples/k8s/basics/10-pod.yaml"
```

```bash
kubectl apply -f examples/k8s/basics/10-pod.yaml
kubectl -n tasklane-basics get pod hello-pod -o wide
kubectl -n tasklane-basics describe pod hello-pod
kubectl -n tasklane get pod -l app.kubernetes.io/name=tasklane-api -o jsonpath='{range .items[0].status.conditions[*]}{.type}{"\t"}{.status}{"\n"}{end}'
```

```console include="captures/k8s-beginner/basics-describe-pod.txt"
```

```console include="captures/k8s-beginner/pod-conditions.txt"
```

```console include="captures/k8s-beginner/custom-columns-phase.txt"
```

## Explanation

`describe pod` is laid out in the order things happen: metadata, node
assignment, the containers with their state and restart count, conditions,
volumes, tolerations, and finally **events**. When a pod misbehaves, read the
events from the bottom up; they name the component that complained
(`default-scheduler`, `kubelet`, `multus`/CNI).

The conditions output shows the sequence a healthy pod passes through. In a
failing pod, the first `False` condition tells you where it stopped:
`PodScheduled=False` is a scheduler problem, `Initialized=False` means an
init container has not finished, `ContainersReady=False` with
`Ready=False` means the readiness probe is failing.

The security context in `10-pod.yaml` is the minimum the `restricted` Pod
Security Standard accepts:

| Field | Level | Why |
|---|---|---|
| `runAsNonRoot: true` | pod | UID 0 is refused at container start |
| `runAsUser: 65532` | pod | The distroless `nonroot` UID; also lets the kubelet verify non-root without reading `/etc/passwd` |
| `seccompProfile.type: RuntimeDefault` | pod | Blocks the rarely used syscalls |
| `allowPrivilegeEscalation: false` | container | `no_new_privs`; setuid binaries cannot raise privileges |
| `capabilities.drop: ["ALL"]` | container | No `CAP_NET_RAW`, no `CAP_CHOWN`, nothing |
| `readOnlyRootFilesystem: true` | container | Handbook convention, not required by the profile |

## Common patterns

- **Let a controller own the pod.** Deployment for stateless, StatefulSet for
  stable identity, Job for run-to-completion, DaemonSet for one per node.
- **One process per container, one concern per pod.** Logs go to stdout;
  the platform collects them.
- **Name your container ports** (`name: http`) and refer to the name from
  probes and Services.
- **Set requests on every container.** A pod with no requests is scheduled
  blind and evicted first.
- **Use `kubectl run --dry-run=client -o yaml`** to generate a pod skeleton,
  then move it under a Deployment.
- **Debug with an ephemeral container** (`kubectl debug`) rather than adding
  a shell to your image; see [debugging basics](debugging-basics.md).

## Production considerations

- **Bare pods are not self-healing.** Nothing reschedules them when a node
  drains, which makes a cluster upgrade an outage.
- **Graceful shutdown is a contract.** On deletion the kubelet sends
  SIGTERM, waits `terminationGracePeriodSeconds` (30 by default), then
  SIGKILL. Tasklane fails readiness first, then drains — see
  [pod lifecycle and termination](../k8s-intermediate/pod-lifecycle-and-termination.md).
- **Probes decide traffic and restarts.** Without a readiness probe, a pod
  receives requests the moment its container starts. See
  [probes](../k8s-intermediate/probes.md).
- **Pods are evicted under node pressure** in reverse QoS order; requests and
  limits decide who dies. See [QoS classes](../k8s-intermediate/qos-classes.md).
- **Node failure is not instant.** Pods on an unreachable node are marked for
  deletion only after the node controller's timeouts expire.

## Security considerations

- **Every pod field is a privilege decision.** `hostNetwork`, `hostPID`,
  `hostPath` volumes, `privileged: true` and added capabilities each remove a
  layer of isolation. The restricted profile forbids all of them.
- **Containers in one pod share a network namespace**, so a compromised
  sidecar can read traffic on `localhost` and bind ports the app uses.
- **ServiceAccount tokens are mounted by default.** Set
  `automountServiceAccountToken: false` unless the pod calls the Kubernetes
  API, as both Tasklane workloads do.
- **The pause container is not an attack surface you manage**, but the
  sandbox's namespaces are: `shareProcessNamespace: true` lets every
  container see and signal the others' processes.
- **User namespaces** (`hostUsers: false`, **GA in 1.36**) map container root
  to an unprivileged host UID, which is the strongest of the cheap
  mitigations. Part I covers it.

## Troubleshooting

| Symptom | Likely cause | Command |
|---|---|---|
| `Pending`, no node | No node satisfies requests, selectors or taints | `kubectl describe pod` (scheduler events) |
| `ContainerCreating` | Image pull, volume mount, CNI | `kubectl describe pod`, node events |
| `ImagePullBackOff` | Wrong tag, missing image in kind, no pull secret | `kubectl describe pod` |
| `CrashLoopBackOff` | The process exits; back-off grows to 5 minutes | `kubectl logs --previous` |
| `CreateContainerConfigError` | A referenced ConfigMap or Secret key is missing | `kubectl describe pod` |
| `Running`, never `Ready` | Readiness probe failing | `kubectl describe pod`, probe path and port |
| `OOMKilled` in `lastState` | Memory limit too low or a leak | `kubectl describe pod`, `kubectl top pod` |
| Rejected at creation | Pod Security Admission | Read the rejection message |

Part L has a page per symptom, starting with
[the method](../troubleshooting/method.md).

## Common mistakes

- **Running a bare pod for a real workload.** Use a Deployment.
- **Expecting a pod IP to be stable.** It changes on every recreation.
- **Putting two independently releasable services in one pod** because it
  "reduces latency".
- **Assuming containers in a pod share a filesystem.** They share volumes
  you declare, nothing else.
- **Using `restartPolicy: Always` with a batch job** so a finished job
  restarts for ever. Use a Job.
- **Debugging by `kubectl exec` into a distroless image** that has no shell,
  and concluding the pod is broken.

## Related topics

- [Deployments and ReplicaSets](deployments-and-replicasets.md)
- [Services](services.md)
- [Debugging basics](debugging-basics.md)
- [Probes](../k8s-intermediate/probes.md)
- [Pod lifecycle and termination](../k8s-intermediate/pod-lifecycle-and-termination.md)
- [Init and sidecar containers](../k8s-intermediate/init-and-sidecar-containers.md)
- [Security context](../k8s-security/security-context.md)
