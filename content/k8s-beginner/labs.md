---
title: Labs
description: Twelve exercises on the kind lab cluster covering namespaces, pods, Deployments, rollouts, Services, ConfigMaps, Secrets and debugging, with full solutions.
level: beginner
type: lab
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/tasklane-on-kubernetes
---

## Overview

These exercises run against the handbook's kind cluster and the teaching
manifests in `examples/k8s/basics/`. Everything happens in the
`tasklane-basics` namespace, which enforces the **restricted** Pod Security
Standard, so a solution that only works as root is not a solution.

Work through them in order; later exercises assume the objects created by
earlier ones. Each has a full solution at the end.

## Setup

```bash
kind create cluster --config examples/lab/kind-config.yaml
kind load docker-image tasklane-api:0.1.0 --name tasklane
kubectl apply -f examples/k8s/basics/
kubectl -n tasklane-basics rollout status deploy/hello-api
kubectl config set-context --current --namespace=tasklane-basics
```

```console include="captures/k8s-beginner/basics-apply.txt"
```

```console include="captures/k8s-beginner/basics-rollout-status.txt"
```

Tear everything down at the end with:

```bash
kubectl delete namespace tasklane-basics
```

```console include="captures/k8s-beginner/basics-cleanup.txt"
```

## Exercises

### 1. Read the cluster

Without looking at any manifest, answer from the API: how many nodes are
there, which Kubernetes version and container runtime do they run, and which
node is the control plane? Then list the control-plane components.

### 2. Prove that labels, not names, drive selection

Find the pods that the `hello-api` Service sends traffic to, using only the
Service's own selector. Then take one pod out of service **without deleting
it**, confirm that a replacement appears, and confirm that the orphan is
still running.

### 3. Pod phases and conditions

Create a pod that will never become ready, watch where it stops, and explain
which condition is `False` and why. Clean it up afterwards.

Hint: the restricted profile still applies, and `tasklane-api:0.1.0` accepts
a subcommand.

### 4. A rollout you can watch

Roll out a change to `hello-api` that sets `LOG_LEVEL=debug`, with a change
cause recorded, and observe the two ReplicaSets during the transition. How
many pods exist at the peak, and why?

### 5. Break a rollout on purpose

Point the Deployment at an image tag that does not exist. Answer: how many
replicas are still serving, what does the `Progressing` condition say after
the progress deadline, and what is the exit code of
`kubectl rollout status`? Then roll back.

### 6. Service types

For each of the five Services in `examples/k8s/basics/`, state what
`kubectl get svc` shows in the `TYPE`, `CLUSTER-IP` and `EXTERNAL-IP`
columns, and why. Prove the ExternalName Service resolves to the database in
the other namespace.

### 7. Endpoints follow readiness

Scale `hello-api` to 1 replica and watch the EndpointSlice shrink. Then scale
back to 3. Which object changed first, and which controller wrote it?

### 8. ConfigMap: env versus volume

Change `LOG_LEVEL` in `hello-config` to `debug`. Without restarting anything,
determine whether the `config-demo` pod sees the new value (a) in its
environment and (b) in its mounted files. Explain the difference.

### 9. Make a config change take effect

Now make the `hello-api` Deployment actually pick up a configuration change,
using a mechanism that produces a normal rolling update and an entry in
`rollout history`.

### 10. Secrets

Show the `hello-secret` value without printing the whole object, then show
the filesystem type of its mount inside `config-demo`. Explain why the file
form is preferred to an environment variable.

### 11. Debug a distroless pod

The Tasklane API image has no shell. In the `tasklane` namespace, list the
processes inside a running API container, from inside that pod, without
restarting it and without violating the restricted Pod Security Standard.

### 12. Trace a request end to end

Starting from `curl http://localhost:8080/`, name every object and component
the request passes through, in order, and give a command that inspects each
one.

## Solutions

### 1. Read the cluster

```bash
kubectl get nodes -o wide
kubectl get nodes -o custom-columns=NAME:.metadata.name,RUNTIME:.status.nodeInfo.containerRuntimeVersion,KUBELET:.status.nodeInfo.kubeletVersion
kubectl -n kube-system get pods -l tier=control-plane -o wide
```

```console include="captures/k8s-beginner/get-nodes-wide.txt"
```

```console include="captures/k8s-beginner/control-plane-pods.txt"
```

Three nodes: `tasklane-control-plane` carries the
`node-role.kubernetes.io/control-plane` role label, the other two are
workers with `topology.kubernetes.io/zone` labels. The runtime column names
containerd, which is what CRI means in practice. The control-plane pods are
static pods run by the kubelet from `/etc/kubernetes/manifests`.

### 2. Prove that labels, not names, drive selection

```bash
kubectl get svc hello-api -o jsonpath='{.spec.selector}{"\n"}'
kubectl get pods -l app.kubernetes.io/name=hello-api -o wide
POD=$(kubectl get pods -l app.kubernetes.io/name=hello-api -o name |head -1)
kubectl label $POD app.kubernetes.io/name-
kubectl get pods --show-labels
kubectl get endpointslices -l kubernetes.io/service-name=hello-api
```

Removing the selector label orphans the pod: the ReplicaSet counts two
matching pods, creates a third, and the orphan keeps running with no owner
and no traffic. Delete it explicitly when finished:

```bash
kubectl delete $POD
```

This is the standard way to quarantine a misbehaving pod for inspection.

### 3. Pod phases and conditions

```yaml title="never-ready.yaml"
apiVersion: v1
kind: Pod
metadata:
  name: never-ready
  namespace: tasklane-basics
  labels:
    app.kubernetes.io/name: never-ready
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    runAsGroup: 65532
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: api
      image: tasklane-api:0.1.0
      args: ["serve"]
      readinessProbe:
        httpGet:
          path: /readyz          # needs a database; there is none here
          port: 8080
        periodSeconds: 2
      resources:
        requests:
          cpu: 50m
          memory: 32Mi
        limits:
          memory: 64Mi
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
```

```bash
kubectl apply -f never-ready.yaml
kubectl get pod never-ready -o jsonpath='{range .status.conditions[*]}{.type}{"\t"}{.status}{"\n"}{end}'
kubectl describe pod never-ready
kubectl delete pod never-ready
```

`PodScheduled` and `Initialized` are `True`, the phase is `Running`, and
`ContainersReady` and `Ready` are `False`: the readiness probe hits `/readyz`,
which pings a database that does not exist in this namespace. A pod in this
state is healthy from the kubelet's point of view and receives no traffic,
which is exactly the intended behaviour of readiness.

### 4. A rollout you can watch

```bash
kubectl patch deploy/hello-api --type=strategic \
  -p '{"metadata":{"annotations":{"kubernetes.io/change-cause":"LOG_LEVEL=debug"}},"spec":{"template":{"spec":{"containers":[{"name":"api","env":[{"name":"LOG_LEVEL","value":"debug"}]}]}}}}'
kubectl get rs -l app.kubernetes.io/name=hello-api -o wide
kubectl rollout status deploy/hello-api
kubectl rollout history deploy/hello-api
```

```console include="captures/k8s-beginner/rollout-3-rs-after-update.txt"
```

```console include="captures/k8s-beginner/rollout-4-history.txt"
```

At the peak there are **four** pods: `replicas: 3` plus `maxSurge: 1`.
`maxUnavailable: 0` means an old pod is only removed once a new one has been
ready for `minReadySeconds`. Setting the annotation and the template in one
patch keeps the change cause attached to the right revision.

### 5. Break a rollout on purpose

```bash
kubectl set image deploy/hello-api api=tasklane-api:0.9.9-does-not-exist
kubectl get rs,pods -l app.kubernetes.io/name=hello-api
kubectl rollout status deploy/hello-api --timeout=5s; echo "exit: $?"
kubectl describe deploy hello-api
kubectl rollout undo deploy/hello-api
kubectl rollout status deploy/hello-api
```

```console include="captures/k8s-beginner/rollout-8-stuck-state.txt"
```

```console include="captures/k8s-beginner/rollout-9-progressing-condition.txt"
```

```console include="captures/k8s-beginner/rollout-10-undo.txt"
```

All three original replicas keep serving, because `maxUnavailable: 0`. The
new pod sits in `ImagePullBackOff`. After `progressDeadlineSeconds` (60 in
this Deployment) the `Progressing` condition becomes `False` with reason
`ProgressDeadlineExceeded`, and `kubectl rollout status` exits non-zero —
which is how a pipeline detects the failure. Nothing rolls back on its own.

### 6. Service types

```bash
kubectl get svc -o wide
kubectl exec config-demo -- nslookup tasklane-db.tasklane-basics.svc.cluster.local
```

```console include="captures/k8s-beginner/basics-services.txt"
```

```console include="captures/k8s-beginner/dns-externalname.txt"
```

- `hello-api` — `ClusterIP`, a virtual IP, no external IP.
- `hello-api-nodeport` — `NodePort`, a ClusterIP **and** a port in
  30000–32767 on every node.
- `hello-api-lb` — `LoadBalancer`, `EXTERNAL-IP` permanently `<pending>`,
  because kind has no cloud-controller-manager to provision one.
- `hello-api-headless` — `ClusterIP` with `CLUSTER-IP: None`; DNS returns
  pod IPs.
- `tasklane-db` — `ExternalName`, no cluster IP at all; CoreDNS returns a
  CNAME to `postgres.tasklane.svc.cluster.local`, which is how a pod in this
  namespace reaches the database in another.

### 7. Endpoints follow readiness

```bash
kubectl scale deploy/hello-api --replicas=1
kubectl get endpointslices -l kubernetes.io/service-name=hello-api -o wide
kubectl scale deploy/hello-api --replicas=3
kubectl rollout status deploy/hello-api
kubectl get endpointslices -l kubernetes.io/service-name=hello-api -o wide
```

The ReplicaSet controller deletes pods first; the EndpointSlice controller
then removes their addresses, and kube-proxy on every node reprograms the
datapath. Scaling up reverses the order: pods become `Ready`, the
EndpointSlice grows, then traffic arrives. The Service object itself never
changes.

### 8. ConfigMap: env versus volume

```bash
kubectl patch configmap hello-config --type=merge -p '{"data":{"LOG_LEVEL":"debug"}}'
kubectl exec config-demo -- printenv LOG_LEVEL
sleep 90
kubectl exec config-demo -- cat /etc/hello/greeting.txt
kubectl exec config-demo -- printenv LOG_LEVEL
```

```console include="captures/k8s-beginner/configmap-update-propagation.txt"
```

The environment variable never changes: a process's environment is fixed at
`execve` time and Kubernetes has no way to alter it. The mounted files do
change, after the kubelet's sync period plus its cache propagation delay,
via an atomic symlink swap of the `..data` directory.

### 9. Make a config change take effect

Either recycle the pods:

```bash
kubectl rollout restart deploy/hello-api
kubectl rollout status deploy/hello-api
```

or change the pod template so the change itself is the trigger — the pattern
templating tools generate:

```yaml title="checksum annotation" fragment
spec:
  template:
    metadata:
      annotations:
        checksum/config: "sha256-of-the-configmap-contents"
```

`rollout restart` stamps `kubectl.kubernetes.io/restartedAt` on the template,
which is the same mechanism: any template change produces a new ReplicaSet
and therefore a normal, reversible rolling update. Kustomize's
`configMapGenerator` achieves it by hashing the ConfigMap's name.

### 10. Secrets

```bash
kubectl describe secret hello-secret
kubectl get secret hello-secret -o jsonpath='{.data.api-token}' |base64 -d; echo
kubectl exec config-demo -- ls -l /etc/hello-secret
kubectl exec config-demo -- sh -c 'mount |grep hello-secret'
```

```console include="captures/k8s-beginner/secret-describe.txt"
```

```console include="captures/k8s-beginner/secret-volume-tmpfs.txt"
```

`describe` shows key names and sizes only. The mount is `tmpfs`: the value
never touches the node's disk. A file can be given restrictive permissions,
is not inherited by child processes, does not appear in crash dumps, and is
updated when the Secret changes — none of which is true of an environment
variable. base64 in the API is encoding, not encryption.

### 11. Debug a distroless pod

```bash
POD=$(kubectl -n tasklane get pod -l app.kubernetes.io/name=tasklane-api -o jsonpath='{.items[0].metadata.name}')
kubectl -n tasklane exec "$POD" -- /bin/sh   # fails: no shell in the image
kubectl -n tasklane debug "$POD" --image=busybox:1.37 --profile=restricted --target=api -c dbg -- sh -c 'ps -o pid,user,args'
kubectl -n tasklane logs "$POD" -c dbg
```

```console include="captures/k8s-beginner/exec-distroless-no-shell.txt"
```

```console include="captures/k8s-beginner/debug-ephemeral-restricted.txt"
```

`--profile=restricted` shapes the ephemeral container to satisfy the
restricted Pod Security Standard, and the pod-level `securityContext` (UID
65532) applies to it as well, so the busybox image does not start as root.
`--target=api` shares the target container's process namespace so `ps` sees
the application. The ephemeral container cannot be removed; it disappears
when the pod is replaced.

### 12. Trace a request end to end

```bash
curl -s http://localhost:8080/                                   # kind port mapping 8080 -> node 30080
kubectl -n envoy-gateway-system get svc                          # the Envoy data plane NodePort
kubectl -n tasklane get gateway tasklane -o wide                 # listener, addresses, status
kubectl -n tasklane get httproute tasklane-api -o wide           # parentRefs and backendRefs
kubectl -n tasklane get svc tasklane-api -o wide                 # ClusterIP and ports
kubectl -n tasklane get endpointslices -l kubernetes.io/service-name=tasklane-api -o wide
kubectl -n tasklane get pods -l app.kubernetes.io/name=tasklane-api -o wide
kubectl -n tasklane logs deploy/tasklane-api --tail=5
```

```console include="captures/k8s-beginner/tasklane-curl-root.txt"
```

```console include="captures/k8s-beginner/gateway-status.txt"
```

The path: host port 8080 → kind's port mapping to the control-plane node's
port 30080 → the Envoy Gateway data plane Service (NodePort,
`externalTrafficPolicy: Cluster`, so kube-proxy may forward to the Envoy pod
on another node) → the Envoy pod, which matches the HTTPRoute → the
`tasklane-api` Service's ready endpoints, taken from its EndpointSlices →
one API pod's container port 8080 → the Go process, which answers with its
own hostname.

## Common mistakes

- **Solving an exercise as root.** The namespace enforces `restricted`; if
  your pod is rejected, read the message — it names every offending field.
- **Deleting a pod to "reset" an exercise.** The ReplicaSet recreates it from
  the current template, which may not be the state you wanted.
- **Waiting less than the kubelet sync period** in exercise 8 and concluding
  that mounted ConfigMaps do not update.
- **Forgetting the namespace.** Set it in the context; half of the confusing
  results in these labs are `-n` mistakes.
- **Leaving ephemeral containers on the Tasklane pods.** They persist until
  the pod is replaced; `kubectl rollout restart deploy/tasklane-api` clears
  them.
- **Skipping the cleanup.** `kubectl delete namespace tasklane-basics`
  removes everything these labs created, through ownerReference garbage
  collection.

## Related topics

- [Tasklane on Kubernetes](tasklane-on-kubernetes.md)
- [Deployments and ReplicaSets](deployments-and-replicasets.md)
- [Rolling updates and rollbacks](rolling-updates-and-rollbacks.md)
- [Services](services.md)
- [Debugging basics](debugging-basics.md)
- [Troubleshooting method](../troubleshooting/method.md)
