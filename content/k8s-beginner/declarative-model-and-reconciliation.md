---
title: Declarative model and reconciliation
description: How controllers turn a written desired state into a running system, and what kubectl apply really does from your keyboard to etcd and back.
level: beginner
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/architecture
---

## Overview

Kubernetes has no "deploy" verb. You write down the state you want, the API
server stores it, and independent control loops work to make observed state
match desired state, for ever. That single idea explains self-healing,
rollouts, garbage collection, and most of the surprises beginners hit.

This page separates the two halves of every object — `spec` (what you want)
and `status` (what is) — then follows `kubectl apply -f deployment.yaml`
through the whole system.

## Why it exists and when to use it

Imperative systems execute commands. If the command is lost, the effect is
lost; if the effect is undone, nobody notices. That is fine when a human
watches the terminal, and untenable across hundreds of machines.

Kubernetes controllers are **level-triggered**, not edge-triggered. They do
not react to "a pod was deleted"; they repeatedly compare "three replicas
wanted" against "two pods exist" and act on the difference. A missed event,
a controller restart, or a manual `kubectl delete pod` all converge to the
same place, because the loop only ever looks at the current level.

Use the declarative path for everything that should survive: manifests in
git, applied by a pipeline. Use imperative commands (`kubectl run`, `kubectl
scale`, `kubectl set image`) for exploration and emergencies, knowing that
the next apply will overwrite what you did by hand.

## How it works underneath

### spec, status and generation

Nearly every object has:

- `spec` — written by you (or a controller above it). Desired state.
- `status` — written by the controller that owns the object. Observed state.
  You never write it, and it is a separate subresource so RBAC can separate
  the two.
- `metadata.generation` — incremented by the API server whenever `spec`
  changes, but not when labels, annotations or `status` change.
- `status.observedGeneration` — written by the controller with the
  `generation` it has finished processing.

`generation != observedGeneration` therefore means "the controller has not
caught up with your latest change yet" — an exact answer to a question that
`kubectl get` cannot otherwise give you.

### Watches and resourceVersion

Controllers do not poll. They **list** the objects they care about, then
**watch** from the `resourceVersion` the list returned. etcd's monotonic
revision counter guarantees no gap: a controller that reconnects resumes from
its last known version, or, if the server has discarded that history, gets a
`410 Gone` and re-lists. The shared informer cache inside every controller is
an in-memory copy of that stream, which is why a busy cluster with thousands
of objects does not melt the API server.

A controller loop is therefore: watch event arrives → the affected key is
added to a work queue → a worker reads the *current* state from the cache →
it computes the difference against `spec` → it issues API writes. Nothing in
that loop depends on which event woke it up.

### ownerReferences and garbage collection

Controllers do not remember what they created. They set
`metadata.ownerReferences` on the children they create — with the owner's
UID, not just its name — and find those children again with a label
selector. A Deployment owns its ReplicaSets; a ReplicaSet owns its pods.

The garbage collector watches for objects whose owners no longer exist (or
whose owner UID no longer matches) and deletes them. That is why deleting a
Deployment deletes its pods, and why deleting a namespace empties it. Three
propagation policies exist: `Background` (the default for `kubectl delete`),
`Foreground` (dependents first, owner blocked by a finalizer until they are
gone) and `Orphan` (children survive, adopted by nobody).

### Server-side apply and field managers

Two ways exist to say "make the object look like this file".

**Client-side apply** (`kubectl apply`, the historical default) stores your
file in the `kubectl.kubernetes.io/last-applied-configuration` annotation and
computes a three-way merge between that annotation, your new file and the
live object. It works, but the annotation is a second copy of the truth, and
two tools editing one object cannot see each other.

**Server-side apply** (`kubectl apply --server-side`) sends the object to the
API server as an intent. The server records, per field, which **field
manager** owns it, in `metadata.managedFields`. Removing a field from your
file removes it from the object, because you still own it. Changing a field
another manager owns is a **conflict**: the request fails with a list of the
contested fields, and you either negotiate or pass `--force-conflicts`.
`--field-manager` names the manager; kubectl uses
`kubectl-client-side-apply` for the classic path and `kubectl` for
server-side apply.

Field management is what lets an HPA own `spec.replicas` while your pipeline
owns the rest of the Deployment, without either one fighting the other.

### What `kubectl apply -f deployment.yaml` actually does

1. **kubectl** reads the file and your kubeconfig, and resolves the
   `apps/v1 Deployment` kind against the server's discovery document
   (cached under `~/.kube/cache`).
2. It builds a request: server-side apply (`PATCH` with
   `application/apply-patch+yaml`) or the classic path (`GET`, then `PATCH`
   with a three-way merge, or `POST` if the object does not exist).
3. **Authentication.** The API server identifies you from your client
   certificate or token.
4. **Authorisation.** RBAC checks `patch`/`create` on `deployments` in that
   namespace.
5. **Mutating admission.** Defaults are applied, a ServiceAccount is
   injected, mutating webhooks and policies may rewrite the object.
6. **Validating admission.** Schema validation, declarative validation,
   validating webhooks, Pod Security Admission. A violation here is where
   `kubectl apply` returns an error and nothing is stored.
7. **Persistence.** etcd stores the object; `resourceVersion` increases and
   `metadata.generation` increments because `spec` changed. kubectl prints
   `deployment.apps/tasklane-api configured`. **Your command is now done,
   and nothing has been deployed yet.**
8. The **Deployment controller** receives the watch event, computes the
   pod-template hash, and creates or scales ReplicaSets.
9. The **ReplicaSet controller** creates Pod objects with
   `ownerReferences` pointing at the ReplicaSet.
10. The **scheduler** binds each pod to a node.
11. The **kubelet** on that node pulls images and starts containers through
    the CRI runtime, then writes pod `status`.
12. The **EndpointSlice controller** adds ready pod IPs to the Service's
    EndpointSlices, and **kube-proxy** programs the datapath.
13. Controllers write `status` back up the chain until the Deployment reports
    `observedGeneration` equal to `generation` and the `Available` and
    `Progressing` conditions settle.

Steps 3 to 7 are synchronous and take milliseconds. Steps 8 to 13 are the
rollout, and `kubectl rollout status` simply watches step 13.

## Basic example

```bash
kubectl -n tasklane get deploy tasklane-api -o jsonpath='generation={.metadata.generation} observedGeneration={.status.observedGeneration}{"\n"}'
kubectl -n tasklane get rs -l app.kubernetes.io/name=tasklane-api -o custom-columns=RS:.metadata.name,OWNER_KIND:.metadata.ownerReferences[0].kind,OWNER:.metadata.ownerReferences[0].name,CONTROLLER:.metadata.ownerReferences[0].controller,BLOCK_DELETION:.metadata.ownerReferences[0].blockOwnerDeletion
kubectl -n tasklane get deploy tasklane-api -o jsonpath='{range .metadata.managedFields[*]}{.manager}{"\t"}{.operation}{"\t"}{.apiVersion}{"\n"}{end}'
```

```console include="captures/k8s-beginner/generation-observedgeneration.txt"
```

```console include="captures/k8s-beginner/owner-references.txt"
```

```console include="captures/k8s-beginner/field-managers.txt"
```

## Explanation

The first command answers "has the controller seen my change?". During a
rollout the two numbers differ for a moment; if they stay different, the
controller is wedged or not running.

The second shows the ownership chain: each ReplicaSet lists the Deployment as
its owner, with `controller: true` (only one owner may be the controller) and
`blockOwnerDeletion: true`, which makes foreground deletion wait for the
child. Follow the chain one level further and each pod names its ReplicaSet.

The third lists every client that has written to the object and what API
version it used. On a Deployment that a pipeline applies and an HPA scales,
you would see both, each owning different fields.

Server-side apply can be rehearsed without writing anything:

```bash
kubectl apply --server-side --dry-run=server --field-manager=handbook-demo -f examples/k8s/03-app/config.yaml
```

```console include="captures/k8s-beginner/server-side-apply-dry-run.txt"
```

`--dry-run=server` runs the entire pipeline — admission included — and then
discards the result. It is the only reliable way to find out whether an
object would be accepted, because client-side validation cannot know about
webhooks or Pod Security Admission.

## Common patterns

- **Manifests in git, applied by a pipeline.** The repository is the desired
  state; the cluster is a projection of it. That idea grows into
  [GitOps with Argo CD](../k8s-advanced/gitops-argo-cd.md).
- **`kubectl diff -f` before `kubectl apply -f`.** It shows the change the
  server would make, including defaulting.
- **`--server-side` for anything more than one writer touches**, especially
  CRDs and large objects where the last-applied annotation gets unwieldy.
- **Wait on conditions, not on sleeps**: `kubectl rollout status`,
  `kubectl wait --for=condition=Available deploy/x`.
- **Never edit `status`.** If you find yourself wanting to, you are looking
  for a controller that is not running.

## Production considerations

- **Field ownership is a contract.** Decide once whether replicas are owned
  by your manifest or by an autoscaler; a manifest that pins `replicas` and
  an HPA that changes it will fight on every sync.
- **Reconciliation is eventually consistent.** Alert on
  `generation != observedGeneration` persisting, not on a snapshot.
- **`kubectl apply --prune` deletes objects missing from your files.** It is
  blunt; prefer a GitOps controller that tracks its own inventory.
- **Deleting a namespace triggers mass garbage collection.** Finalizers on
  any object in it can stall the whole delete: see
  [stuck terminating namespace](../troubleshooting/stuck-terminating-namespace.md).

## Security considerations

- `status` is a separate subresource; a controller can be granted
  `patch` on `deployments/status` without being able to change `spec`.
- Mutating admission runs before validating admission, so a webhook can
  rewrite an object into something you did not write. `kubectl get -o yaml`
  after the fact shows the truth, and `managedFields` names who did it.
- Server-side apply conflicts are a safety feature. Reflexively adding
  `--force-conflicts` in CI removes the guard rail that tells you two systems
  are editing the same field.
- Anyone who can create an object with an `ownerReference` can arrange for it
  to be garbage collected, or, with the wrong RBAC, cause the deletion of an
  object they cannot delete directly.

## Troubleshooting

- **Applied, nothing happened.** Compare `generation` and
  `observedGeneration`, then read `status.conditions`.
- **A field keeps reverting.** Another manager owns it. Check
  `metadata.managedFields`, or a controller (HPA, an operator) is writing it.
- **A deleted object comes back.** A controller owns it. Delete the owner.
- **A delete hangs.** Look for `metadata.finalizers` and for a
  `deletionTimestamp` that is set while the object still exists.
- **`kubectl apply` fails with a conflict message.** That is server-side
  apply telling you which fields another manager owns.

## Common mistakes

- **Reading `kubectl apply`'s output as success.** It means the object was
  stored, not that the workload is healthy.
- **Mixing imperative edits with applied manifests.** `kubectl scale` then
  `kubectl apply` puts the replica count back; the surprise is yours.
- **Using `kubectl edit` in production.** It writes as a different field
  manager, and there is no record of why.
- **Expecting ordering between objects.** Applying a directory does not
  sequence its contents; controllers retry until dependencies exist.
- **Deleting pods to "restart" a Deployment.** Use `kubectl rollout restart`,
  which changes the pod template and produces an ordered, observable rollout.

## Related topics

- [Architecture](architecture.md)
- [Manifest anatomy](manifest-anatomy.md)
- [Deployments and ReplicaSets](deployments-and-replicasets.md)
- [kubectl fundamentals](kubectl-fundamentals.md)
- [GitOps with Argo CD](../k8s-advanced/gitops-argo-cd.md)
