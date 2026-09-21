---
title: kubectl fundamentals
description: The verbs, selectors, output formats and dry-run modes that turn kubectl from a guessing game into a precise tool.
level: beginner
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/architecture
  - k8s-beginner/local-clusters
---

## Overview

`kubectl` is a REST client with good manners. Every command maps to an HTTP
verb on a resource, which is why the same flags work everywhere: if you can
`get` a Deployment you can `get` a CustomResource, and the output formats,
label selectors and dry-run modes behave identically.

This page covers the parts you use every hour: discovery (`api-resources`,
`explain`), reading (`get` with output formats and selectors), writing
(`apply`, `diff`, `--dry-run`), and the escape hatches (`--raw`, `-o
jsonpath`).

## Why it exists and when to use it

kubectl exists so a human can drive an API designed for controllers. It adds
three things the raw API does not have:

- **Discovery.** It asks the server which resources and versions exist, so
  `kubectl get httproutes` works for a CRD installed five minutes ago.
- **Client-side convenience.** Table printing, label columns, `apply`
  semantics, `rollout` and `describe` are kubectl features, not API
  endpoints. `describe` in particular makes several API calls and joins the
  results with the object's events.
- **Credential plumbing.** kubeconfig, exec credential plugins, and TLS.

kubectl is supported **within one minor version** of the API server, older or
newer. Against a 1.37 cluster, use kubectl 1.36, 1.37 or 1.38.

## How it works underneath

A command like `kubectl -n tasklane get pods -l app.kubernetes.io/name=tasklane-api -o wide`
becomes roughly:

```text title="request shape"
GET /api/v1/namespaces/tasklane/pods?labelSelector=app.kubernetes.io%2Fname%3Dtasklane-api
Accept: application/json;as=Table;g=meta.k8s.io;v=1
```

Two details matter. First, **the label selector is evaluated by the API
server**, not by kubectl: selecting is cheap and does not transfer every
object. So is `--field-selector`, though only indexed fields (such as
`metadata.name`, `metadata.namespace`, `status.phase`,
`spec.nodeName` for pods) are supported. Second, the default table output is
computed **server-side**: the server returns rows and column definitions,
which is why a CRD can define its own `kubectl get` columns.

`-o yaml`, `-o json` and `-o kyaml` skip the table and return the object.
Client-side formats (`custom-columns`, `jsonpath`, `go-template`, `name`)
fetch the objects and format them locally.

## Basic example

```bash
kubectl api-resources --sort-by=name
kubectl explain deployment.spec.strategy
kubectl -n tasklane get pods -o wide
kubectl -n tasklane get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[*].image}{"\n"}{end}'
```

```console include="captures/k8s-beginner/api-resources.txt"
```

```console include="captures/k8s-beginner/explain-deployment-strategy.txt"
```

```console include="captures/k8s-beginner/jsonpath-images.txt"
```

## Explanation

### Discovery: what can I even type?

`kubectl api-resources` lists every resource the server serves, with its
short name, API group, whether it is namespaced, and its kind. Add `-o wide`
to see the **verbs** each resource supports — which is how you learn that
Services support `get,list,watch,create,update,patch,delete` but
`bindings` only supports `create`.

```console include="captures/k8s-beginner/api-resources-wide.txt"
```

`kubectl api-versions` lists group/version pairs; `kubectl explain` documents
fields straight from the server's OpenAPI schema, so it is always correct for
*your* cluster's version:

```bash
kubectl explain pod.spec.securityContext --recursive
kubectl explain deployment.spec.strategy --api-version=apps/v1
```

```console include="captures/k8s-beginner/explain-securitycontext-recursive.txt"
```

`--recursive` prints the whole subtree without descriptions, which is the
fastest way to find the exact spelling of a nested field.

### Reading: output formats

| Format | Use it for |
|---|---|
| (default) | Human table, server-generated columns |
| `-o wide` | Adds node, pod IP, image columns |
| `-o yaml` / `-o json` | The full object, including `status` and defaults |
| `-o kyaml` | KYAML: YAML that is unambiguous to machines, **GA in 1.37** |
| `-o name` | `kind/name`, ideal for shell loops and `xargs` |
| `-o custom-columns=...` | A table you define with JSONPath expressions |
| `-o jsonpath='...'` | One value, or a formatted stream, for scripts |
| `--show-labels`, `-L <label>` | Labels as text, or one column per label |

```bash
kubectl -n tasklane get svc tasklane-api -o kyaml
kubectl -n tasklane get pods -o custom-columns=NAME:.metadata.name,PHASE:.status.phase,NODE:.spec.nodeName,IP:.status.podIP,RESTARTS:.status.containerStatuses[0].restartCount
```

```console include="captures/k8s-beginner/get-svc-kyaml.txt"
```

```console include="captures/k8s-beginner/custom-columns-phase.txt"
```

JSONPath in kubectl is a subset of the original: `{range}`/`{end}` to loop,
`{"\t"}` and `{"\n"}` for literals, and filters such as
`{.status.conditions[?(@.type=="Ready")].status}`. Quoting is the usual
source of pain — on Windows PowerShell, prefer single quotes inside double
quotes, or put the expression in a file and use `-o jsonpath-file`.

### Selecting: labels, fields and namespaces

```bash
kubectl -n tasklane get pods -l app.kubernetes.io/part-of=tasklane
kubectl -n tasklane get pods -l 'app.kubernetes.io/component in (api,worker)'
kubectl get pods -A --field-selector status.phase=Running
kubectl -n tasklane get pods -L app.kubernetes.io/component,pod-template-hash
```

```console include="captures/k8s-beginner/tasklane-pods-selector.txt"
```

Set-based selectors (`in`, `notin`, `!key`) work on the command line and in
most APIs. `-A` (or `--all-namespaces`) is a flag, not a namespace.

### Writing: apply, diff and dry-run

```bash
kubectl create deployment demo --image=tasklane-api:0.1.0 --dry-run=client -o yaml
kubectl diff -f examples/k8s/basics/20-deployment.yaml
kubectl apply -f examples/k8s/basics/
```

```console include="captures/k8s-beginner/dry-run-client.txt"
```

- `--dry-run=client` never contacts the server for the mutation. It is a
  manifest generator; the classic way to start a YAML file.
- `--dry-run=server` sends the real request with the dry-run flag: defaulting,
  admission webhooks and Pod Security Admission all run, then the result is
  thrown away. It is the only way to find out whether the cluster would
  accept the object.

The difference is visible when a namespace enforces the restricted Pod
Security Standard. A client dry-run of a root container prints happily; the
server dry-run rejects it:

```bash
kubectl -n tasklane-basics run psa-test --image=busybox:1.37 --dry-run=server -- sleep 1
```

```console include="captures/k8s-beginner/psa-reject-server-dry-run.txt"
```

`kubectl diff -f` shows what the apply would change, after server-side
defaulting, and exits 1 when there is a difference — useful in CI:

```console include="captures/k8s-beginner/rollout-6-diff.txt"
```

### Imperative helpers

`kubectl run`, `create`, `scale`, `set image`, `set env`, `label`, `annotate`
and `expose` write directly. They are excellent for exploration and for
generating manifests with `--dry-run=client -o yaml`, and a poor way to
manage anything that has to survive. Note that `kubectl run --filename/-f` is
being deprecated in 1.37; generate a manifest and `apply` it instead.

### Escape hatches

```bash
kubectl get --raw '/readyz?verbose'
kubectl auth can-i create deployments -n tasklane
kubectl auth whoami
kubectl wait --for=condition=Available deploy/tasklane-api -n tasklane --timeout=120s
```

```console include="captures/k8s-beginner/auth-can-i.txt"
```

```console include="captures/k8s-beginner/auth-whoami.txt"
```

`kubectl auth whoami` is marked experimental in the CLI help but is the
quickest way to find out which identity your kubeconfig actually presents.

## Common patterns

- **`get` to survey, `describe` to diagnose, `-o yaml` for the truth.**
  `describe` joins events; `-o yaml` shows exactly what is stored.
- **Generate, then edit, then apply**:
  `kubectl create deployment ... --dry-run=client -o yaml > deploy.yaml`.
- **Loop safely with `-o name`**:
  `kubectl -n tasklane get pods -o name |xargs -n1 kubectl -n tasklane logs --tail=5`.
- **Pin the namespace in the context** instead of typing `-n` everywhere:
  `kubectl config set-context --current --namespace=tasklane`.
- **Add `--watch`** to any `get` to follow changes, and
  `--output-watch-events` to see whether each change was ADDED, MODIFIED or
  DELETED.
- **Install shell completion and an alias** (`alias k=kubectl`), then teach
  completion about the alias. It removes a surprising amount of typing.

## Production considerations

- **kubectl is not an interface for production changes.** Anything you type
  by hand is invisible to git and to the next engineer. Use it to read, and
  let a pipeline write.
- **Keep kubectl within one minor of the server.** Mixed fleets mean one
  kubectl per cluster; `kubectl krew`-style version switchers exist for this.
- **`kubectl exec` and `port-forward` are audited API calls**, not SSH. They
  need explicit RBAC (`pods/exec`, `pods/portforward`) and they are the first
  thing to remove from a production role.
- **Large `get` calls are expensive.** `kubectl get pods -A` on a big cluster
  lists everything; use selectors, `--chunk-size`, or a watch.

## Security considerations

- Every kubectl command runs as the identity in your kubeconfig. Before
  assuming you lack permission, check with `kubectl auth can-i`.
- `kubectl get secret -o yaml` prints base64 values to your terminal and your
  shell history. Prefer `kubectl describe secret` (keys only), and see
  [Secrets](secrets.md).
- `--dry-run=server` still requires the full write permission for the verb;
  it is not a way to test with fewer rights.
- Exec credential plugins run arbitrary binaries from your kubeconfig. Treat
  an untrusted kubeconfig file as untrusted code.

## Troubleshooting

- **`error: the server doesn't have a resource type "x"`** — the CRD is not
  installed, or you are on the wrong cluster. `kubectl api-resources |grep x`.
- **`Error from server (Forbidden)`** — RBAC. `kubectl auth can-i` tells you
  precisely, and the message names the verb, resource and namespace.
- **`unable to recognize ...: no matches for kind ... in version ...`** — the
  API version in your manifest is not served. Check
  [removed API versions](../migration/removed-api-versions.md).
- **jsonpath prints nothing** — the path is wrong or the field is absent.
  Test it against `-o json` output, and remember `{.items[*]}` for lists.
- **`kubectl` hangs** — check the cluster is reachable:
  `kubectl get --raw '/readyz?verbose'`, then your context.

## Common mistakes

- **Forgetting `-n`.** Most "it disappeared" reports are a namespace
  mismatch.
- **Reading `describe` for object truth.** It is a formatted summary; fields
  it omits still exist.
- **Using `kubectl edit` for real changes.** No review, no history, and a
  different field manager.
- **Escaping JSONPath for the wrong shell.** The same command differs between
  bash, PowerShell and cmd.
- **Trusting `--dry-run=client` for validation.** It knows nothing about
  admission, Pod Security or webhooks.
- **Running `kubectl delete -f` on a directory that includes a Namespace.**
  It deletes the namespace and everything in it.

## Related topics

- [kubeconfig and contexts](kubeconfig-and-contexts.md)
- [Manifest anatomy](manifest-anatomy.md)
- [Labels, selectors and annotations](labels-selectors-annotations.md)
- [Debugging basics](debugging-basics.md)
- [kubectl cheat sheet](../reference/kubectl-cheat-sheet.md)
