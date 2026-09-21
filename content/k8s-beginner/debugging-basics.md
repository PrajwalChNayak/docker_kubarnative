---
title: Debugging basics
description: Logs, events, exec, port-forward and ephemeral containers — the five tools that answer almost every "why is this pod broken?" question.
level: beginner
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/pods
  - k8s-beginner/services
---

## Overview

Debugging a workload in Kubernetes is mostly about asking the right component
what it saw. The pod's `status` and events say what the kubelet and scheduler
think, the container logs say what your process thinks, and `exec`,
`port-forward` and ephemeral containers let you go and look.

This page is the beginner toolkit. Part L turns each symptom into a
procedure, starting with [the method](../troubleshooting/method.md).

## Why it exists and when to use it

There is no SSH to a pod and no host to log into. Everything you can do goes
through the API server, which is a feature: each action is authorised and
audited, and it works the same on a laptop cluster and on a managed cluster
where you have no node access at all.

The order that works, nearly always:

1. `kubectl get` — what state is it in?
2. `kubectl describe` — what did the platform try, and what did it say?
3. `kubectl logs` — what did the application say?
4. `kubectl get events` — what happened around it, in time order?
5. `kubectl exec` / `kubectl debug` / `kubectl port-forward` — go and look.

Skipping to step 5 is the most common waste of time.

## How it works underneath

- **`logs`** streams from the kubelet, which reads the container runtime's
  log files on the node. The runtime rotates them, so `logs` shows the
  current container's output and, with `--previous`, the output of the
  previous instance of that container — which is the only way to see why a
  `CrashLoopBackOff` container died. Logs are gone when the pod is deleted;
  shipping them off-node is [Part J's job](../operations/logging-architectures.md).
- **`describe`** is several API calls joined: the object, plus the events
  referring to it. Events live in the `events.k8s.io/v1` API, are namespaced,
  and **expire after about an hour**. An empty event list is not proof that
  nothing happened.
- **`exec`** and **`port-forward`** open a streaming connection through the
  API server to the kubelet, which attaches to the container or forwards a
  TCP port. They require the `pods/exec` and `pods/portforward`
  subresource permissions.
- **`kubectl debug`** adds an **ephemeral container** to a running pod: a
  container with no probes, no resource requests and no restarts, which
  shares the pod's namespaces. It cannot be removed — the pod must be
  recreated — and it does not restart if it exits.

## Basic example

```bash
kubectl -n tasklane get deploy,rs,pods -o wide
kubectl -n tasklane describe pod -l app.kubernetes.io/name=tasklane-api
kubectl -n tasklane logs -l app.kubernetes.io/name=tasklane-api --tail=20 --prefix --timestamps
kubectl -n tasklane get events --sort-by=.lastTimestamp
```

```console include="captures/k8s-beginner/describe-api-pod.txt"
```

```console include="captures/k8s-beginner/logs-api.txt"
```

```console include="captures/k8s-beginner/events-sorted.txt"
```

## Explanation

### Logs

```bash
kubectl -n tasklane logs deploy/tasklane-worker --tail=15
kubectl -n tasklane logs deploy/tasklane-api --previous --tail=5
```

```console include="captures/k8s-beginner/logs-worker.txt"
```

```console include="captures/k8s-beginner/logs-previous.txt"
```

Flags worth memorising:

| Flag | Effect |
|---|---|
| `-f` | Follow |
| `--previous` / `-p` | The previous container instance, after a restart |
| `-c <name>` | A specific container; required when the pod has several |
| `--all-containers` | Every container in the pod |
| `-l <selector>` | Every pod matching a label selector |
| `--prefix` | Prefix each line with pod and container |
| `--timestamps` | Prefix with the kubelet's timestamp |
| `--since=10m` / `--since-time=` | Time window |
| `--tail=N` | Last N lines (the default is everything for a single pod) |

`--previous` fails with a clear message when there is no previous instance,
which is itself information: the container has never restarted.

### Events

```bash
kubectl -n tasklane events --for deploy/tasklane-api --types=Normal,Warning
```

```console include="captures/k8s-beginner/events-for-deployment.txt"
```

`kubectl events --for <kind>/<name>` is the modern, focused form;
`kubectl get events --sort-by=.lastTimestamp` is the "what just happened in
this namespace" view. Because events expire, capture them during an incident
rather than after.

### exec, and images without a shell

```bash
kubectl -n tasklane exec deploy/tasklane-api -- /bin/sh -c 'echo hello'
```

```console include="captures/k8s-beginner/exec-distroless-no-shell.txt"
```

The Tasklane images are distroless: no shell, no `ls`, no `cat`. `exec`
fails, and that is a security feature, not a bug — the same absence that
frustrates you frustrates an attacker. The answer is an ephemeral container.

### Ephemeral containers with `kubectl debug`

```bash
kubectl debug --help |grep -A2 -- '--profile'
```

```console include="captures/k8s-beginner/debug-profile-help.txt"
```

The profiles are `general` (the default), `baseline`, `restricted`,
`netadmin` and `sysadmin`. In a namespace that enforces the **restricted**
Pod Security Standard — which `tasklane` does — a default debug container is
rejected, because it would run as root with default capabilities. Use
`--profile=restricted`, which shapes the debug container to satisfy the
profile:

```bash
POD=$(kubectl -n tasklane get pod -l app.kubernetes.io/name=tasklane-api -o jsonpath='{.items[0].metadata.name}')
kubectl -n tasklane debug "$POD" --image=busybox:1.37 --profile=restricted --target=api -c dbg -- sh -c 'ps -o pid,user,args'
kubectl -n tasklane logs "$POD" -c dbg
```

```console include="captures/k8s-beginner/debug-ephemeral-restricted.txt"
```

```console include="captures/k8s-beginner/debug-ephemeral-spec.txt"
```

Three details make this work:

- `--target=api` points the debug container's process namespace at that
  container, so `ps` can see the application's process.
- The **pod-level** `securityContext` applies to every container in the pod,
  including ephemeral ones, so the busybox container inherits
  `runAsUser: 65532` and starts even though the image defaults to root.
- `-c` names the container. Ephemeral containers are additive and permanent
  for the life of the pod; reusing a name fails, and there is no "remove".

`kubectl debug` has two other modes worth knowing:

- `--copy-to=<name>` makes a **copy** of the pod with changes (a different
  image, a different command, probes removed). Use it when the pod crashes
  too fast to attach to — the copy can run `sleep` instead of the real
  command.
- `kubectl debug node/<node>` starts a pod in the node's host namespaces with
  the node's filesystem at `/host`. That is a privileged operation and lands
  in whatever namespace your context points at, not in the restricted one.

```bash
kubectl debug node/tasklane-worker --image=busybox:1.37 -- sh -c 'ls /host/etc/kubernetes; head -3 /host/etc/os-release'
```

```console include="captures/k8s-beginner/debug-node.txt"
```

Delete the debugger pod when you are done; nothing cleans it up for you.

### port-forward

```bash
kubectl -n tasklane port-forward svc/tasklane-api 18080:80
curl -s http://127.0.0.1:18080/
```

```console include="captures/k8s-beginner/port-forward.txt"
```

`port-forward` tunnels a local port through the API server to a pod — the
Service form simply picks one of its pods, so it is not load balanced. It is
perfect for reaching an admin endpoint that should never be exposed, and
useless for testing anything about ingress, TLS termination or routing.

### Resource usage

```bash
kubectl top nodes
kubectl -n tasklane top pods --containers
```

```console include="captures/k8s-beginner/top-nodes.txt"
```

```console include="captures/k8s-beginner/top-pods.txt"
```

`kubectl top` needs metrics-server, which the lab installs. The Metrics API
became stable as `metrics.k8s.io/v1` in Kubernetes 1.37; `v1beta1` is still
served, and the HPA controller still uses it.

## Common patterns

- **Describe the pod, read the events from the bottom.** The last event is
  usually the answer.
- **`kubectl get pod -o yaml` for `lastState`**, which holds the exit code
  and reason (`OOMKilled`, `Error`) of the previous container.
- **`kubectl logs -l <selector> --prefix`** to read every replica at once.
- **Take a pod out of service without deleting it** by removing the label the
  ReplicaSet selects on; a replacement is created, and you keep the patient.
- **`kubectl debug --copy-to`** for crash loops: same image, different
  command, probes disabled.
- **`kubectl get events -A --field-selector type=Warning`** as a cluster-wide
  "what is unhappy right now".

## Production considerations

- **Logs on a node are ephemeral.** Without a log pipeline, a deleted pod
  takes the evidence with it.
- **Events expire in about an hour** and are dropped under pressure. Ship
  them too; see [Kubernetes events](../operations/kubernetes-events.md).
- **`exec` in production is a change you cannot review.** Many teams remove
  the permission and rely on ephemeral containers plus telemetry.
- **Debug containers cost resources with no requests**, and they persist for
  the life of the pod. Do not leave a dozen behind on a production pod.
- **Node debugging is privileged.** `kubectl debug node/...` gives the host
  filesystem; it should be gated and audited.

## Security considerations

- **`pods/exec`, `pods/portforward`, `pods/attach` and
  `pods/ephemeralcontainers` are separate RBAC subresources.** Grant them
  deliberately; `edit` does not include them by default in the way people
  assume, and `cluster-admin` obviously does.
- **An ephemeral container joins the pod's namespaces.** It can read the
  pod's network traffic, its mounted Secrets and, with `--target`, its
  process memory space through `/proc`. Treat it as equivalent to being the
  application.
- **`--profile=sysadmin` and node debugging are privilege escalation
  primitives.** On a shared cluster, permission to debug nodes is permission
  to read every Secret on them.
- **Debug images are supply chain.** Pulling a random "netshoot" image into a
  production namespace pulls whatever it contains; pin and scan them like any
  other image.
- **Logs leak.** `kubectl logs` is often permitted far more widely than
  `get secrets`, and applications print credentials.

## Troubleshooting

| Symptom | Command |
|---|---|
| Pod `Pending` | `kubectl describe pod` — scheduler events at the bottom |
| `CrashLoopBackOff` | `kubectl logs --previous`, then `-o yaml` for `lastState.terminated` |
| `ImagePullBackOff` | `kubectl describe pod` — registry, tag, pull secret |
| `Running` but no traffic | `kubectl get endpointslices`, readiness probe |
| `exec` fails with `executable file not found` | Distroless image; use `kubectl debug` |
| Nothing in the logs | Wrong container (`-c`), or the app logs to a file instead of stdout |
| `error: Metrics API not available` | metrics-server is not installed or not ready |

## Common mistakes

- **Deleting the broken pod before looking at it.** The evidence goes with
  it. Label it out of the ReplicaSet instead.
- **Forgetting `--previous`** on a crash loop and reading the logs of a
  container that has not started yet.
- **Reading `describe` and ignoring the events section**, which is where the
  actual error is.
- **Using `port-forward` to "test the ingress path".** It bypasses the
  Gateway, the Service load balancing and any policy in between.
- **Assuming an empty event list means nothing happened.** They expire.
- **Leaving ephemeral containers and node debugger pods behind.**

## Related topics

- [Pods](pods.md)
- [Services](services.md)
- [Rolling updates and rollbacks](rolling-updates-and-rollbacks.md)
- [Troubleshooting method](../troubleshooting/method.md)
- [CrashLoopBackOff](../troubleshooting/crashloopbackoff.md)
- [Kubernetes events](../operations/kubernetes-events.md)
- [metrics-server and the Metrics API](../operations/metrics-server-and-metrics-api.md)
