---
title: Stuck terminating namespace and finalizers
description: What finalizers do, why a namespace or resource hangs in Terminating, how to find the blocker via the object's status, and the real risk of force-removing finalizers.
level: advanced
type: troubleshooting
status: current
versions: Kubernetes 1.37
prerequisites:
  - troubleshooting/method
  - k8s-beginner/namespaces
  - k8s-advanced/custom-resource-definitions
---

## Overview

An object stuck in `Terminating` is almost always waiting on a **finalizer** —
a marker that says "run cleanup before you actually delete me." Deletion sets a
`deletionTimestamp` and then blocks until every finalizer is removed. For a
namespace, it also blocks until every resource inside it is gone. When the
controller that owns a finalizer is missing or broken, the object hangs forever.
This page explains the mechanism, how to find the specific blocker, and why
force-removing finalizers is a last resort that can orphan real resources.

## Symptoms

- `kubectl get ns` shows a namespace stuck in `Terminating` for a long time.
- `kubectl delete pod/<x>` (or any resource) hangs, and `get` shows it
  `Terminating` with a `deletionTimestamp` set but the object still present.
- `kubectl describe ns <ns>` shows a `NamespaceDeletionContentFailure` or lists
  remaining resources it cannot remove.

Reproducer (a pod with a finalizer nothing removes):

```yaml include="examples/troubleshooting/stuck-terminating.yaml"
```

```console include="captures/troubleshooting/stuck-terminating.txt"
```

## How it works underneath

**Finalizers** are strings in `metadata.finalizers`. When you delete an object
that has any, the API server does not remove it; it sets
`metadata.deletionTimestamp` and leaves the object in place. A controller that
owns a finalizer is expected to notice the timestamp, do its cleanup (detach a
volume, deregister a load balancer, delete cloud resources), then remove its
finalizer. Only when the list is empty does the API server delete the object.
This is how Kubernetes guarantees external cleanup happens before an object
vanishes. If the owning controller is gone or wedged, nothing removes the
finalizer and the object is stuck.

**Namespace deletion** has two layers:

1. The namespace controller deletes every resource in the namespace. Any resource
   with a stuck finalizer blocks this step — the namespace waits for its
   contents.
2. The namespace object itself has a `spec.finalizers` list (typically
   `kubernetes`) and a `status.conditions` set. The namespace is not removed
   until its contents are gone and its own finalizers are cleared.

The most common real cause of a stuck namespace is an **orphaned APIService or
admission webhook**: the namespace contains (or the controller must list) a
custom resource whose API is served by an aggregated `APIService` that is now
unavailable, or a `ValidatingWebhookConfiguration` that points at a deleted
service. The namespace controller cannot enumerate or delete those resources, so
deletion stalls. `kubectl get apiservice` showing an `APIService` with
`AVAILABLE: False` is the classic tell.

## Diagnosis

1. **Find the finalizer on a stuck resource.**

   ```bash
   kubectl -n <ns> get pod <pod> -o jsonpath='{.metadata.finalizers}{"\n"}'
   ```

2. **For a stuck namespace, read its status.** The `status` lists what is
   blocking deletion:

   ```bash
   kubectl get namespace <ns> -o json | jq '.status'
   kubectl get namespace <ns> -o jsonpath='{.spec.finalizers}{"\n"}'
   ```

   `NamespaceContentRemaining` / `NamespaceFinalizersRemaining` conditions name
   what is left.

3. **Look for a broken API surface**, the usual culprit:

   ```bash
   kubectl get apiservice | grep -iv "True"
   kubectl get validatingwebhookconfigurations
   kubectl get mutatingwebhookconfigurations
   ```

   An unavailable `APIService` or a webhook pointing at a dead service blocks
   listing/deleting resources.

4. **Identify which resources still exist** in the namespace:

   ```bash
   kubectl api-resources --verbs=list --namespaced -o name \
     | xargs -n1 kubectl -n <ns> get --show-kind --ignore-not-found
   ```

## Fixes

- **Let the controller finish.** The safe fix is to restore whatever owns the
  finalizer — restart the operator/controller, or make the aggregated API/webhook
  available again — so it completes cleanup and removes the finalizer itself.
  This preserves the external cleanup the finalizer exists to guarantee.
- **Fix a broken APIService/webhook.** Delete or repair the unavailable
  `APIService` or the webhook config pointing at a dead service, then the
  namespace deletion proceeds on its own.
- **Remove a finalizer manually — last resort.** Only when you have confirmed
  nothing still needs it (the owning controller and its external resources are
  truly gone):

  ```bash
  kubectl -n <ns> patch pod <pod> --type=merge -p '{"metadata":{"finalizers":null}}'
  ```

  :::danger Force-removing finalizers can orphan real resources
  A finalizer usually guards external cleanup — a cloud load balancer, a disk, a
  DNS record, a database. Stripping it lets Kubernetes forget the object while
  the external resource lives on, leaking cost and creating security debris. For
  a namespace, editing `spec.finalizers` to `[]` (historically via the
  `/finalize` subresource) forces removal but abandons whatever its contents
  were cleaning up. Do this only when you understand exactly what will be
  orphaned, and clean those resources up yourself.
  :::

## Prevention

- Do not add custom finalizers without a controller that reliably removes them;
  an unowned finalizer is a guaranteed future hang.
- Delete CRDs and their operators in the right order — remove custom resources
  (letting their finalizers run) before removing the controller that services
  them.
- Keep aggregated `APIService`s and admission webhooks healthy, or scope them so
  a dead backing service does not block unrelated namespace deletions
  (`failurePolicy`, `namespaceSelector`).
- Treat a long `Terminating` as a signal to investigate, not to reflexively force
  — the block is information.

## Common mistakes

- Force-removing a finalizer and orphaning a cloud resource the finalizer was
  meant to delete.
- Blaming the namespace when the block is a single resource inside it with a
  stuck finalizer, or an unavailable APIService.
- Not reading `namespace ... -o json` `status`, which names the blocker.
- Deleting an operator before its custom resources, stranding their finalizers.
- Assuming `Terminating` means "almost done" — without progress it means blocked.

## Related topics

- [A method for debugging Kubernetes](method.md)
- [Node NotReady](node-notready.md)
- [Namespaces](../k8s-beginner/namespaces.md)
- [Custom Resource Definitions](../k8s-advanced/custom-resource-definitions.md)
- [Admission webhooks](../k8s-advanced/admission-webhooks.md)
