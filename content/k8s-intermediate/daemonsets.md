---
title: DaemonSets
description: One pod per node - how the DaemonSet controller schedules, updates and tolerates its way onto every node, and why node agents are a privilege problem.
level: intermediate
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/pods
  - k8s-beginner/deployments-and-replicasets
---

## Overview

A DaemonSet (`apps/v1`) runs one copy of a pod on every node that matches its
node selector, and it adds or removes copies as nodes join and leave the
cluster. There is no `replicas` field: the node list is the replica count.

This is the shape of every node-level agent — the CNI plugin, kube-proxy, a log
shipper, a metrics exporter, a CSI node plugin, a security agent.

## Why it exists and when to use it

Some software must be *on* the node to do its job: it reads the node's
filesystem, watches its network namespace, or talks to a local socket. A
Deployment with `replicas: <number of nodes>` cannot express that — the
scheduler is free to put two replicas on one node and none on another.

Use a DaemonSet when the answer to "how many should run?" is "exactly one per
node, whatever the node count is". Use a Deployment for everything else,
including things people often make DaemonSets by habit, like a reverse proxy
that does not need node access.

## How it works underneath

The DaemonSet controller watches nodes and pods. For each node whose labels
match `spec.template.spec.nodeSelector` (and `affinity`), it creates a pod with
a `nodeAffinity` term pinning it to that node — the controller does not bypass
the scheduler, it hands the scheduler a pod that can only land in one place.
The scheduler then applies the normal rules, including taints.

That taint interaction is the part to internalise. DaemonSet pods get a set of
tolerations added automatically so that node agents keep running on nodes that
are unhealthy or shutting down — including `node.kubernetes.io/not-ready`,
`unreachable`, `disk-pressure`, `memory-pressure`, `pid-pressure`,
`unschedulable`, and `network-unavailable` for host-network pods. They do **not**
automatically tolerate your own taints: a control-plane node with
`node-role.kubernetes.io/control-plane:NoSchedule` needs an explicit toleration
in your DaemonSet, which is why a log shipper so often covers every node except
the ones you most want logs from.

Updates use `updateStrategy`:

- `RollingUpdate` (default) with `maxUnavailable` (default 1) and
  `maxSurge` (default 0). Surge above 0 briefly runs two pods on one node, which
  only works if the pod does not claim an exclusive resource such as a host
  port.
- `OnDelete`, where nothing happens until you delete a pod. This is the safe
  choice for agents that would break the node while restarting.

`kubectl drain` evicts DaemonSet pods only with `--ignore-daemonsets`, which is
why every drain example carries that flag: the controller would immediately
recreate them anyway.

## Basic example

```yaml title="node-log-collector.yaml"
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-log-collector
  namespace: tasklane
  labels:
    app.kubernetes.io/name: node-log-collector
    app.kubernetes.io/part-of: tasklane
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: node-log-collector
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
  template:
    metadata:
      labels:
        app.kubernetes.io/name: node-log-collector
        app.kubernetes.io/part-of: tasklane
    spec:
      # Node agents usually need to run where nothing else may.
      tolerations:
        - key: node-role.kubernetes.io/control-plane
          operator: Exists
          effect: NoSchedule
      priorityClassName: system-node-critical
      terminationGracePeriodSeconds: 30
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532
        runAsGroup: 65532
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: collector
          # Stand-in for whichever agent you run; pin it by digest in reality.
          image: registry.example.com/node-log-collector:1.4.2
          volumeMounts:
            - name: varlog
              mountPath: /var/log/tasklane
              readOnly: true
          resources:
            requests:
              cpu: 20m
              memory: 32Mi
            limits:
              memory: 64Mi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
      volumes:
        - name: varlog
          hostPath:
            path: /var/log/tasklane
            type: DirectoryOrCreate
```

## Explanation

This is a deliberately modest agent: it reads one host directory read-only, runs
as a non-root user, drops every capability and mounts nothing else. Most
real-world agents ask for far more — and most of them ask for more than they
need.

`priorityClassName: system-node-critical` keeps the agent from being evicted
before the workloads it observes. `maxUnavailable: 1` means a fleet-wide upgrade
walks the cluster one node at a time; on a 500-node cluster that is slow, and
raising it is a deliberate risk decision, not a default to copy.

The lab cluster already runs several DaemonSets you can inspect:

```bash
kubectl -n kube-system get daemonset -o wide
```

```console include="captures/k8s-intermediate/daemonsets.txt"
```

## Common patterns

**Restrict by node label.** `nodeSelector` on a label such as
`node.kubernetes.io/instance-type` or your own `gpu: "true"` runs the agent only
where it is relevant, and the DaemonSet still tracks nodes joining and leaving.

**Host network only when required.** `hostNetwork: true` gives the pod the
node's network namespace and the node's ports. CNI plugins and kube-proxy need
it. A metrics exporter usually does not, and taking it removes a whole class of
port conflicts.

**One config per node class.** Two DaemonSets with different selectors beats one
DaemonSet with a config file full of conditionals.

**`OnDelete` for dangerous agents.** Anything that reprograms the node's
networking should not roll itself across the fleet unattended.

## Production considerations

A DaemonSet's blast radius is the cluster. A bad image rolls out to every node
in turn, and if the agent breaks the node, `maxUnavailable: 1` means you break
your cluster one node at a time until someone stops it. Stage node agents in a
test cluster and use a node-label selector to canary a handful of nodes first.

Resource requests multiply by node count: 100m × 500 nodes is 50 cores of
allocatable capacity gone before a single workload is scheduled. Measure agents
on a busy node, not an idle one.

DaemonSet pods respect PodDisruptionBudgets for voluntary eviction, but their
pods are recreated by the controller regardless, so a PDB on a DaemonSet is
rarely useful. Node upgrades are what actually restart them.

Logs and metrics from node agents belong outside the node they run on; an agent
that only logs locally is useless in exactly the incident it exists for.

## Security considerations

A node agent is the most privileged workload most clusters run, and it is a
standing invitation. Typical asks — `hostPath` on `/`, `hostPID`, `hostNetwork`,
`privileged: true`, `CAP_SYS_ADMIN` — each convert "compromise a pod" into
"compromise the node", and from there into "compromise the cluster" via the
kubelet's credentials.

Concretely: a `hostPath` mount of `/var/run/docker.sock` or the containerd
socket is root on the node. A `hostPath` mount of `/` read-write lets a
container write a systemd unit or replace a kubelet binary. A `hostPath` of
`/var/lib/kubelet` exposes every mounted Secret of every pod on that node.

So:

- Run node agents in their own namespace with `privileged` Pod Security
  Admission, and keep every other namespace `restricted`. A privileged agent in
  a shared namespace forces that namespace open for everyone.
- Scope the ServiceAccount to exactly what the agent reads. A DaemonSet whose
  ServiceAccount can `get secrets` cluster-wide is a cluster-wide credential
  theft primitive.
- Prefer read-only `hostPath` mounts of specific directories over `/`.
- Pin the image by digest and verify its signature; a compromised agent image is
  a compromised fleet.

See [attack: privileged pod escape](../k8s-security/attack-privileged-pod-escape.md)
for the exploit in the lab, and
[pod security standards](../k8s-security/pod-security-standards.md) for the
enforcement.

## Troubleshooting

`DESIRED` in `kubectl get daemonset` is the number of matching, schedulable
nodes. If it is lower than your node count, the selector or a taint is the
reason:

```bash
kubectl get nodes --show-labels
kubectl -n kube-system describe daemonset <name> | sed -n '/Events/,$p'
```

Pods `Pending` on specific nodes usually means an untolerated taint, an already
occupied `hostPort`, or insufficient allocatable resources on those nodes — the
same `FailedScheduling` messages as any other pod.

A rollout that never finishes is normally one node whose pod cannot become
Ready; with `maxUnavailable: 1` the controller waits for it forever. Find it
with `kubectl get pods -o wide` and look at that node.

## Common mistakes

- **Forgetting control-plane tolerations**, then discovering the monitoring
  agent never ran there.
- **Using a DaemonSet as a "one replica per node" load balancer** for something
  that does not need node access. Use a Deployment with topology spread.
- **`hostPath: /` read-write** because the agent "might need something".
- **Ignoring the multiplication**: requests, log volume and API calls all scale
  with node count.
- **`maxSurge > 0` with a `hostPort`**, so the surging pod can never start.
- **Draining without `--ignore-daemonsets`** and concluding the drain is broken.

## Related topics

- [Requests and limits](resources-requests-limits.md)
- [Pod disruption budgets](pod-disruption-budgets.md)
- [Network model and CNI](network-model-and-cni.md)
- [Taints and tolerations](../k8s-advanced/taints-and-tolerations.md)
- [Pod security standards](../k8s-security/pod-security-standards.md)
- [Logging architectures](../operations/logging-architectures.md)
- [Node maintenance](../operations/node-maintenance.md)
