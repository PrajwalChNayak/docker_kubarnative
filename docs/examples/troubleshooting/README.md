# Troubleshooting reproducers (Part L)

Small, deliberately **broken** manifests. Each one reproduces exactly one of
the failures covered in `content/troubleshooting/`, so you can see the real
symptom, read the real diagnostic output, apply the fix and confirm it.

Everything lives in a disposable namespace, `troubleshoot`, which enforces the
**restricted** Pod Security Standard just like the real `tasklane` namespace.
Every reproducer pod is therefore hardened (non-root, no privilege escalation,
all capabilities dropped, `seccompProfile: RuntimeDefault`). **The injected
fault is always runtime or logical — never a Pod Security or schema violation.**
The API server accepts every file; the object then misbehaves once it runs.
All ten files validate with `kubeconform -strict -kubernetes-version 1.37.0`.

## Prerequisites

- The lab cluster from `examples/lab/kind-config.yaml` (kind `tasklane`,
  Kubernetes 1.37.0, one control plane and two workers).
- `tasklane-api:0.1.0` built from `examples/app` and loaded with
  `kind load docker-image tasklane-api:0.1.0 --name tasklane`.
- `busybox:1.37` is pulled from Docker Hub by most reproducers.

## Create the namespace

```
kubectl apply -f examples/troubleshooting/00-namespace.yaml
```

## The reproducers

| File | `case=` label | Symptom | Injected fault | Fix |
|---|---|---|---|---|
| `crashloopbackoff.yaml` | `crashloop` | CrashLoopBackOff | process exits 1 at start | keep the process up; fix config/dependency |
| `imagepullbackoff.yaml` | `imagepull` | ImagePullBackOff / ErrImagePull | image tag `9.9.9-nope` does not exist | use a real tag; `kind load` the local image |
| `pending-unschedulable.yaml` | `pending` | Pending (FailedScheduling) | requests 900Gi memory, more than any node | request a realistic amount / add capacity |
| `oomkilled.yaml` | `oomkilled` | OOMKilled (exit 137) | 16Mi limit + a memory hog | raise the limit to the real working set / fix the leak |
| `createcontainerconfigerror.yaml` | `cce` | CreateContainerConfigError | env refers to a missing ConfigMap key | create the key / fix the reference |
| `failing-probes.yaml` | `failing-probes` | 0/1 Ready, out of endpoints | readiness probe path is `/not-ready` (404) | point the probe at `/readyz` |
| `service-no-endpoints.yaml` | `service-no-endpoints` | Service reachable but no backends | Service selector has a typo | make the selector match the pod labels |
| `pvc-pending.yaml` | `pvc-pending` | PVC (and any consumer) Pending | `storageClassName` does not exist | use a class from `kubectl get storageclass` |
| `stuck-terminating.yaml` | `stuck-terminating` | Pod stuck in Terminating | a custom finalizer nothing removes | let the controller finish, or remove the finalizer |

## Apply one, watch it fail, then fix it

Example, CrashLoopBackOff:

```
kubectl apply -f examples/troubleshooting/crashloopbackoff.yaml
kubectl -n troubleshoot get pods -l case=crashloop -w
kubectl -n troubleshoot describe pod -l case=crashloop
kubectl -n troubleshoot logs -l case=crashloop --previous
```

`captures/requests/troubleshooting.txt` runs each of these end to end (apply →
capture diagnostics → clean up) so the pages can show real output.

## Clean up

Each capture request deletes its own reproducer. To remove everything at once:

```
kubectl delete namespace troubleshoot
```

Deleting the namespace deletes every reproducer in it. If the namespace itself
sticks in `Terminating`, that is the `stuck-terminating` lesson — a finalizer
is still set on a resource inside it; find and clear it as
`content/troubleshooting/stuck-terminating-namespace.md` describes.
