---
title: kubectl cheat sheet
description: The verbs, output formats, JSONPath, context and debug commands you reach for daily, for kubectl 1.37.
level: beginner
type: reference
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/kubectl-fundamentals
---

## Overview

A dense lookup for `kubectl` 1.37. Commands are grouped by task. Replace
placeholders in angle brackets. Nothing here talks to your cluster until you run
it; read-only verbs (`get`, `describe`, `explain`, `logs`) are safe to explore
with. `kubectl` is supported within one minor of the API server (1.36–1.38 for a
1.37 server).

## Discovery and explain

```bash
kubectl api-resources
kubectl api-versions
kubectl explain deployment.spec.template.spec.containers --recursive
kubectl version
```

`kubectl explain` reads the cluster's OpenAPI, so it always matches the server's
actual API surface. `api-resources` shows short names, apiVersion and whether a
kind is namespaced.

## Get and describe

```bash
kubectl get pods
kubectl get pods -A
kubectl -n tasklane get pods -o wide
kubectl get deploy,svc,httproute -n tasklane
kubectl get pods --show-labels
kubectl get pods -l app.kubernetes.io/name=tasklane-api
kubectl get pods --field-selector status.phase=Running
kubectl get pods --sort-by=.metadata.creationTimestamp
kubectl describe pod <pod> -n tasklane
kubectl get events -n tasklane --sort-by=.lastTimestamp
```

## Output formats and JSONPath

```bash
kubectl get pod <pod> -o yaml
kubectl get pod <pod> -o json
kubectl get pods -o name
kubectl get pods -o kyaml
kubectl get pod <pod> -o jsonpath='{.status.podIP}'
kubectl get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\n"}{end}'
kubectl get nodes -o custom-columns=NAME:.metadata.name,RUNTIME:.status.nodeInfo.containerRuntimeVersion
```

`-o kyaml` (KYAML, KEP-5295) is new in 1.37: YAML that is unambiguous to
machines and still readable. `-o wide` adds node, IP and other columns.

## Apply, edit, delete

```bash
kubectl apply -f examples/k8s/03-app/
kubectl apply -k examples/kustomize/base
kubectl diff -f examples/k8s/03-app/api.yaml
kubectl apply --server-side -f gateway.yaml
kubectl edit deploy/tasklane-api -n tasklane
kubectl delete -f api.yaml
kubectl delete pod <pod> --grace-period=0 --force
```

Prefer `--server-side` for anything with multiple field owners (Gateway API,
CRDs). `kubectl diff` shows what an apply would change without applying it.

## Dry run and validation

```bash
kubectl apply -f api.yaml --dry-run=client
kubectl apply -f api.yaml --dry-run=server
kubectl create deploy demo --image=nginx --dry-run=client -o yaml
```

`--dry-run=server` runs admission and validation on the real API server without
persisting — the honest check that a manifest is acceptable.

## Rollouts and scaling

```bash
kubectl rollout status deploy/tasklane-api -n tasklane
kubectl rollout history deploy/tasklane-api -n tasklane
kubectl rollout undo deploy/tasklane-api -n tasklane
kubectl rollout restart deploy/tasklane-api -n tasklane
kubectl scale deploy/tasklane-api --replicas=3 -n tasklane
kubectl set image deploy/tasklane-api api=tasklane-api:0.2.0 -n tasklane
```

## Logs, exec, port-forward, cp

```bash
kubectl logs <pod> -n tasklane
kubectl logs <pod> -c api -n tasklane --previous
kubectl logs -f deploy/tasklane-api -n tasklane --tail=100
kubectl exec -it <pod> -n tasklane -- sh
kubectl port-forward svc/tasklane-api 8080:80 -n tasklane
kubectl cp tasklane/<pod>:/path/file ./file
```

## Debugging

```bash
kubectl debug <pod> -n tasklane -it --image=busybox:1.37 --target=api
kubectl debug node/<node> -it --image=busybox:1.37
kubectl get pod <pod> -n tasklane -o jsonpath='{.status.containerStatuses[*].state}'
kubectl top pods -n tasklane
kubectl top nodes
```

`kubectl debug` attaches an ephemeral container to a running pod (share the
process namespace with `--target`), so you can debug a distroless container that
ships no shell. `kubectl top` needs metrics-server.

## Contexts and config

```bash
kubectl config get-contexts
kubectl config current-context
kubectl config use-context kind-tasklane
kubectl config set-context --current --namespace=tasklane
kubectl config view --minify
```

Setting `--namespace` on the current context saves typing `-n tasklane` on every
command.

## Auth and RBAC checks

```bash
kubectl auth can-i create deployments -n tasklane
kubectl auth can-i '*' '*' --all-namespaces
kubectl auth can-i list secrets --as=system:serviceaccount:tasklane:tasklane-api -n tasklane
kubectl auth whoami
```

`--as` impersonates a user or service account (if you may impersonate), the
fastest way to test an RBAC binding.

## Common mistakes

- **Forgetting `-n`/namespace.** `get pods` shows only the default namespace;
  use `-A` or set the context namespace.
- **`--dry-run=client` for real validation.** Client dry-run skips admission;
  use `--dry-run=server`.
- **`delete --force --grace-period=0` as a habit.** It removes the API object
  without confirming the container is gone; use it only for genuinely stuck pods.
- **Editing live objects with `kubectl edit`** instead of changing the manifest
  in Git — the change is lost on the next apply.
- **Expecting `kubectl top` to work with no metrics-server.** It needs the
  metrics API.

## Related topics

- [kubectl fundamentals](../k8s-beginner/kubectl-fundamentals.md)
- [kubeconfig and contexts](../k8s-beginner/kubeconfig-and-contexts.md)
- [Debugging basics](../k8s-beginner/debugging-basics.md)
- [Manifest field reference](manifest-field-reference.md)
