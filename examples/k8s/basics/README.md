# Kubernetes basics: standalone teaching manifests

Small, single-purpose manifests for Part F (Kubernetes, beginner). They are
deliberately *not* part of the running Tasklane stack: everything here lives
in its own namespace, `tasklane-basics`, so you can delete pods, break a
rollout and recreate the namespace without touching the stack in `tasklane`.

Validated with `kubeconform -strict -kubernetes-version 1.37.0`.

## Prerequisites

* The lab cluster from `examples/lab/kind-config.yaml` (kind, Kubernetes
  1.37.0, one control plane and two workers).
* The image `tasklane-api:0.1.0` built from `examples/app` and loaded into
  the cluster:

  ```
  kind load docker-image tasklane-api:0.1.0 --name tasklane
  ```

  Without it the pods end in `ImagePullBackOff`: the tag is not `:latest`, so
  the default pull policy is `IfNotPresent`, and the node has nothing to find
  because the image exists only in your local Docker.
* `busybox:1.37` is pulled from Docker Hub by `42-config-demo.yaml`.

## Apply

```
kubectl apply -f examples/k8s/basics/
kubectl -n tasklane-basics rollout status deploy/hello-api
kubectl -n tasklane-basics get all
```

`kubectl apply -f <dir>` reads files in lexical order, which is why the
namespace is `00-`.

## What is here

| File | Object | Teaches |
|---|---|---|
| `00-namespace.yaml` | Namespace `tasklane-basics` | namespaces, Pod Security Admission labels (restricted) |
| `10-pod.yaml` | Pod `hello-pod` | the Pod object with no controller above it |
| `20-deployment.yaml` | Deployment `hello-api` (3 replicas) | ReplicaSets, rolling updates, rollbacks |
| `30-service-clusterip.yaml` | Service `hello-api` | ClusterIP, named `targetPort` |
| `31-service-nodeport.yaml` | Service `hello-api-nodeport` | NodePort, `externalTrafficPolicy` |
| `32-service-loadbalancer.yaml` | Service `hello-api-lb` | LoadBalancer, and why `EXTERNAL-IP` stays `<pending>` in kind |
| `33-service-headless.yaml` | Service `hello-api-headless` | `clusterIP: None`, DNS per pod |
| `34-service-externalname.yaml` | Service `tasklane-db` | ExternalName as a CNAME alias |
| `40-configmap.yaml` | ConfigMap `hello-config` | scalar keys versus file-shaped keys |
| `41-secret.yaml` | Secret `hello-secret` | `stringData`, base64 is not encryption |
| `42-config-demo.yaml` | Pod `config-demo` | ConfigMap as env and as volume, Secret as a file; also the lab toolbox |

## Pod Security

`tasklane-basics` enforces the **restricted** Pod Security Standard, so every
pod sets:

```yaml
securityContext:            # pod level
  runAsNonRoot: true
  runAsUser: 65532
  seccompProfile:
    type: RuntimeDefault
```

```yaml
securityContext:            # container level
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: ["ALL"]
```

`readOnlyRootFilesystem` is not required by the restricted profile; it is a
handbook convention. Everything else is.

A pod that violates the profile is rejected at admission time, before it is
stored. Try it:

```
kubectl -n tasklane-basics run psa-test --image=busybox:1.37 --dry-run=server -- sleep 1
```

## Exercises that change state

`31-` to `34-` all select the same pods, so you can compare five Service
types against one backend:

```
kubectl -n tasklane-basics get svc
kubectl -n tasklane-basics get endpointslices
```

Rolling update and rollback:

```
kubectl -n tasklane-basics set image deploy/hello-api api=tasklane-api:0.9.9-does-not-exist
kubectl -n tasklane-basics rollout status deploy/hello-api --timeout=90s   # fails
kubectl -n tasklane-basics rollout history deploy/hello-api
kubectl -n tasklane-basics rollout undo deploy/hello-api
```

`maxUnavailable: 0` means the three old pods keep serving the whole time.

## Clean up

```
kubectl delete namespace tasklane-basics
```

Deleting the namespace deletes everything in it, including the Deployment's
ReplicaSets and pods, through ownerReference garbage collection.
