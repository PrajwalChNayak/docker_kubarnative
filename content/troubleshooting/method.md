---
title: A method for debugging Kubernetes
description: A systematic way to turn "my pod is broken" into a named failure with a known fix, following the reconcile chain from API server to runtime.
level: intermediate
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/architecture
  - k8s-beginner/declarative-model-and-reconciliation
  - k8s-beginner/debugging-basics
---

## Overview

Most Kubernetes debugging goes wrong in the same way: someone jumps straight to
`kubectl logs` on a pod that never started a process, or edits a Deployment
before knowing whether the problem is scheduling, image, config or the app. A
method fixes that. This page gives you one: classify the symptom, walk the same
short chain of commands every time, and read the answer off the object's own
status and events.

Every other page in this part is a leaf of the tree on this page. Learn the
method here; use the symptom pages for the exact mechanism and fix of one
failure.

## Why it exists and when to use it

Kubernetes is a set of controllers driving observed state toward desired state.
When something is "broken", one link in that chain is stuck, and the stuck link
almost always reports *why* in its object status or in an Event. The method
exists to take you to that report quickly instead of guessing.

Use it whenever a workload is not doing what the manifest says: a pod that will
not start, a Service nobody can reach, a volume that never binds, a node that
went away. It works because the failure is observable — the controller that
could not make progress leaves a record.

## How it works underneath

### The reconcile chain

An `apply` does not "create a pod". It writes desired state to the API server,
which persists it to etcd, and then a relay of controllers acts:

1. **kube-apiserver** validates and admits the object (schema, then admission
   webhooks and Pod Security), and stores it. A rejection here means the object
   never existed — the failure is at submit time, not runtime.
2. **controllers** (in kube-controller-manager) turn high-level objects into
   pods: a Deployment makes a ReplicaSet, the ReplicaSet makes Pods.
3. **kube-scheduler** watches for pods with no `nodeName` and binds each to a
   node, or records `FailedScheduling` if none fits.
4. **kubelet** on the chosen node sees the bound pod, pulls images, asks the
   container runtime to create and start containers, and runs probes.
5. **container runtime** (containerd in kind) and **CNI/CSI** plug in
   networking and storage.

A failure is "which link stopped, and what did it say?" That single question is
the whole method. Each link writes to a different place:

| Link | Where it reports |
|---|---|
| API server / admission | the error from `kubectl apply` itself |
| Controller | Events on the owning object (Deployment, ReplicaSet, Job) |
| Scheduler | `FailedScheduling` Event on the Pod; `status.conditions` |
| kubelet / runtime | Pod `status.containerStatuses[].state`; Events on the Pod |
| CNI / CSI | Events on the Pod; kubelet log on the node |

### Classify the symptom first

Before any command, put the failure in one of five buckets. The bucket picks
the tools:

- **Schedule** — the pod is `Pending` and has no node. Read the scheduler.
- **Start** — the pod has a node but no running container: `ImagePullBackOff`,
  `CreateContainerConfigError`, `CrashLoopBackOff` before the app logs anything.
  Read image, config and the container runtime.
- **Run** — the container ran and then misbehaved: crash loops with app logs,
  `OOMKilled`, failing probes. Read logs and resource use.
- **Network** — the pod is `Running` and `Ready` but traffic does not flow:
  Service with no endpoints, DNS failures, NetworkPolicy drops.
- **Storage** — a PVC never binds, or a pod is `Pending`/`ContainerCreating`
  waiting on a volume.

## Basic example

The universal first three commands, in order, for any workload symptom:

```bash
kubectl -n <ns> get pods -o wide
kubectl -n <ns> describe pod <pod>
kubectl -n <ns> logs <pod> --previous
```

`get -o wide` tells you the bucket at a glance: the `STATUS` column names the
failure and `NODE` tells you whether it was scheduled. `describe` prints the
container states and the recent Events — this is where the scheduler, kubelet
and runtime leave their reasons. `logs --previous` reads the *last terminated*
container, which is the only place a crash loop's real error survives.

Then widen to Events, which carry timestamps and cover objects that are not
pods (PVCs, nodes, Services):

```bash
kubectl -n <ns> get events --sort-by=.lastTimestamp
```

## Explanation

### describe → events → logs → exec

Work outside-in, cheapest first:

1. **describe** the object. It shows `State`, `Last State` (with exit code and
   reason such as `OOMKilled`), `Reason`/`Message`, and Events. Ninety percent
   of failures are named right here.
2. **events** for the timeline and for non-pod objects. Events expire (about an
   hour by default), so a quiet Event list can just mean you are late.
3. **logs**, and specifically `--previous` for anything that restarted. Add
   `-c <container>` for multi-container pods, `--all-containers` to sweep, and
   `--tail` to bound the output.
4. **exec** into a *running* container to test from inside: `kubectl exec -it
   <pod> -- sh`. This only works if the container is up and has a shell — the
   Tasklane images are distroless and have none, which is what ephemeral debug
   containers are for.

### Debugging containers that have no shell

`kubectl debug` attaches an **ephemeral container** (GA since 1.25) to a
running pod, sharing its namespaces, so you can bring your own tools into a
distroless or scratch pod without rebuilding it:

```bash
kubectl -n <ns> debug -it <pod> --image=busybox:1.37 --target=<container>
```

`--target` shares the target container's process namespace so you can see its
PIDs. A copy variant, `kubectl debug <pod> --copy-to=<new> --image=...`, is for
pods that crash too fast to attach to.

To debug the **node** itself (kubelet, disk, the runtime socket), open a
privileged pod in the host namespaces:

```bash
kubectl debug node/<node> -it --image=busybox:1.37
```

That container mounts the node root filesystem at `/host` and shares the host
network and PID namespaces.

### On the node: crictl and component logs

When the kubelet and runtime disagree with the API server, drop to the node.
`crictl` (the CRI debugging CLI) talks straight to containerd, below
Kubernetes:

```bash
crictl ps -a
crictl logs <container-id>
crictl inspectp <pod-id>
```

The kubelet's own log is the source of truth for start, mount and CNI failures:
`journalctl -u kubelet` on a systemd node. In kind, the node is a container, so
`docker exec -it tasklane-control-plane crictl ps` and
`docker exec -it tasklane-control-plane journalctl -u kubelet` reach it. The
control-plane components run as static pods, so `kubectl -n kube-system logs`
covers the API server, scheduler and controller-manager when the API server is
still up; when it is not, read their static-pod logs on the node.

## Common patterns

### The decision tree

```text
Pod not doing what the manifest says
│
├─ STATUS = Pending?  ──────────────► SCHEDULE
│     describe pod → FailedScheduling message
│     (insufficient cpu/mem, taint, affinity, unbound PVC, no nodes)
│     → pending-pods.md ; pvc-pending.md
│
├─ STATUS = ImagePullBackOff / ErrImagePull?  ─► START (image)
│     describe pod → Failed to pull image "..."
│     → imagepullbackoff.md
│
├─ STATUS = CreateContainerConfigError?  ──────► START (config)
│     describe pod → missing ConfigMap/Secret/key
│     → createcontainerconfigerror.md
│
├─ STATUS = CrashLoopBackOff / repeated restarts?  ─► RUN
│     logs --previous ; Last State exit code
│     exit 137 → OOMKilled → oomkilled.md
│     restarts with no crash in logs → failing-probes.md (liveness)
│     otherwise → crashloopbackoff.md
│
├─ STATUS = Running but 0/1 READY?  ───────────► RUN (readiness)
│     describe pod → Readiness probe failed
│     → failing-probes.md
│
├─ STATUS = Evicted?  ─────────────────────────► node pressure
│     → evicted-pods.md ; node-notready.md
│
├─ Pod Running & Ready but traffic fails?  ────► NETWORK
│     endpoints empty? → service-no-endpoints.md
│     name resolution fails? → dns-failures.md
│     connection blocked? → networkpolicy-blocking.md
│
├─ Node NotReady / pods stuck Terminating on it? ─► node-notready.md
│
└─ Object stuck Terminating?  ─────────────────► finalizers
      → stuck-terminating-namespace.md
```

### Change one thing, then re-observe

Once the method names the failure, resist changing three fields at once. Change
the one the evidence points at, re-run `get`/`describe`, and confirm the state
moved. Debugging is a loop of observe → hypothesise → change one thing →
observe, not a broadcast of fixes.

## Production considerations

In production the same method runs against richer data. Events are shipped to a
store before they expire (see `operations/kubernetes-events`), metrics answer
"was this OOM the node or the container?" (`operations/metrics-server-and-metrics-api`),
and `kubectl debug` may be restricted by policy, so ephemeral-container images
and node-debug rights are part of your break-glass runbook, not an afterthought.

Keep a fixed triage order written down. Under pressure, people skip `describe`
and start editing. A one-page runbook that says "get, describe, events, logs
--previous, *then* think" prevents most self-inflicted outages.

## Security considerations

`kubectl debug` node access and privileged ephemeral containers are powerful:
`kubectl debug node/<node>` gives a root shell on the host with the node
filesystem mounted. Treat these rights as production break-glass, grant them
through RBAC, and audit their use. See `k8s-security/rbac` and
`k8s-security/audit-logging`. The debug image is code you are injecting next to
a workload — pin it and pull it from a trusted registry.

## Troubleshooting

If the method itself seems to give nothing:

- **Empty Events.** They expired. Reproduce and look immediately, or read a
  shipped Event store.
- **`describe` shows a healthy pod but traffic still fails.** You are in the
  network bucket, not the pod bucket — go to endpoints, DNS and NetworkPolicy.
- **The API server itself is unreachable.** Nothing above works; this is a
  control-plane or certificate problem. See `node-notready.md` and
  `certificate-expiry.md`.

## Common mistakes

- Running `logs` (current) instead of `logs --previous` on a crash loop, and
  seeing only the restarting attempt's first line.
- Reading pod logs for a pod that never ran a process
  (`ImagePullBackOff`, `CreateContainerConfigError`): there are no logs, the
  answer is in `describe`.
- Skipping classification and treating a scheduling failure as an app bug.
- Editing the workload before confirming which link in the chain is stuck.
- Forgetting that control-plane components and the kubelet have their own logs
  off to the side of `kubectl`.

## Related topics

- [CrashLoopBackOff](crashloopbackoff.md)
- [ImagePullBackOff and ErrImagePull](imagepullbackoff.md)
- [Pending pods](pending-pods.md)
- [Service has no endpoints](service-no-endpoints.md)
- [Debugging basics](../k8s-beginner/debugging-basics.md)
- [Declarative model and reconciliation](../k8s-beginner/declarative-model-and-reconciliation.md)
- [Kubernetes architecture](../k8s-beginner/architecture.md)
- [The break-and-fix lab](labs.md)
