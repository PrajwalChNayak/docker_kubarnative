---
title: CreateContainerConfigError
description: Why a container never starts because the kubelet cannot assemble its configuration — a missing ConfigMap, Secret, key or mount.
level: intermediate
type: troubleshooting
status: current
versions: Kubernetes 1.37
prerequisites:
  - troubleshooting/method
  - k8s-beginner/configmaps
  - k8s-beginner/secrets
---

## Overview

`CreateContainerConfigError` is a *pre-start* failure: the kubelet has the image
but cannot build the container's configuration because something the spec
references — a ConfigMap, a Secret, a specific key, or a volume source — does not
exist. The container never runs, so there are no logs. The answer is always in
`describe pod`. It is closely related to `CreateContainerError` (a container
runtime creation failure) and easy to confuse with `CrashLoopBackOff`, which is
a container that *did* run and then exited.

## Symptoms

- `kubectl get pods` shows `STATUS: CreateContainerConfigError` and `READY 0/1`.
- `RESTARTS` is 0 — nothing started.
- `describe pod` Events name the missing object:
  `Error: configmap "..." not found`, `Error: secret "..." not found`, or
  `couldn't find key ... in ConfigMap ...`.
- `kubectl logs` returns `container ... is waiting to start` — there is no log.

Reproducer (an env var referencing a key that does not exist):

```yaml include="examples/troubleshooting/createcontainerconfigerror.yaml"
```

```console include="captures/troubleshooting/cce.txt"
```

## How it works underneath

Before the runtime can create a container, the kubelet resolves everything the
container config needs: environment variables from `env`/`envFrom`, projected
files from `secret`/`configMap` volumes, image pull secrets, and so on. If a
referenced source object or key is absent, the kubelet cannot produce a valid
container config and stops with `CreateContainerConfigError`. Because this
happens before `containerd` creates the container, no process runs and no log
exists.

The usual triggers:

- **Missing ConfigMap or Secret.** `envFrom` or a volume references an object
  that does not exist in the pod's namespace. ConfigMaps and Secrets are
  namespaced — a reference resolves only within the pod's own namespace.
- **Missing key.** The object exists but a `configMapKeyRef`/`secretKeyRef`
  names a key it does not contain (the reproducer's case).
- **Wrong mount.** A `secret`/`configMap` volume names a source that is absent,
  or `items` list a key that is not there.

`optional: true` on a key or object reference changes the behaviour: a missing
optional source is tolerated and the variable is simply left unset or the file
omitted, rather than blocking the container. That is useful for genuinely
optional config and dangerous when the value is actually required.

### CreateContainerConfigError vs CreateContainerError

- **`CreateContainerConfigError`** — the kubelet could not assemble config
  (missing ConfigMap/Secret/key). Fix the reference or create the object.
- **`CreateContainerError`** — the runtime rejected creating the container
  (for example a bad `command` path, or a read-only-rootfs conflict). Read the
  Event message; it usually quotes the runtime error.

## Diagnosis

1. **Read the Event.** It names the exact object or key.

   ```bash
   kubectl -n <ns> describe pod <pod>
   ```

2. **Verify the object and its keys exist** in the pod's namespace:

   ```bash
   kubectl -n <ns> get configmap <name> -o jsonpath='{.data}'
   kubectl -n <ns> get secret <name> -o jsonpath='{.data}' | tr ',' '\n'
   ```

   Compare the keys present against the keys the pod references.

3. **Check the namespace.** A ConfigMap in `default` is invisible to a pod in
   `tasklane`:

   ```bash
   kubectl get configmap --all-namespaces | grep <name>
   ```

## Fixes

- **Missing object.** Create it in the pod's namespace:

  ```bash
  kubectl -n <ns> create configmap <name> --from-literal=KEY=value
  kubectl -n <ns> create secret generic <name> --from-literal=KEY=value
  ```

- **Missing key.** Add the key to the object, or point the reference at a key
  that exists. In the reproducer, changing `key: MISSING_KEY` to `key: GREETING`
  fixes it.
- **Genuinely optional value.** Mark the reference `optional: true` so a missing
  source does not block the container — but only when the app can run without it.
- **Wrong namespace.** Recreate the object in the pod's namespace, or move the
  workload; there is no cross-namespace reference for ConfigMaps/Secrets.

## Prevention

- Apply config objects **before** the workloads that consume them, or bundle
  them in the same Kustomize/Helm release so ordering is guaranteed.
- Keep the key names in the manifest and in the ConfigMap/Secret in sync;
  templating (Kustomize `configMapGenerator`, Helm values) removes the drift.
- Use `configMapGenerator`/`secretGenerator` hash suffixes so a changed config
  forces a rollout and stale references are caught.
- In CI, `kubectl apply --dry-run=server` catches many missing references before
  they reach a live cluster.

## Common mistakes

- Running `kubectl logs` and being confused that there is nothing — the
  container never started.
- Creating the ConfigMap/Secret in the wrong namespace.
- A typo in a key name between the manifest and the object.
- Assuming `CreateContainerConfigError` is the same as `CrashLoopBackOff`; one
  is pre-start config, the other is a process that ran and exited.
- Using `optional: true` to silence the error on a value the app actually needs,
  turning a clear failure into a subtle misbehaviour.

## Related topics

- [A method for debugging Kubernetes](method.md)
- [CrashLoopBackOff](crashloopbackoff.md)
- [ConfigMaps](../k8s-beginner/configmaps.md)
- [Secrets](../k8s-beginner/secrets.md)
