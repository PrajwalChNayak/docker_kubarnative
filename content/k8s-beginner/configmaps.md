---
title: ConfigMaps
description: Keep non-secret configuration out of your images, and know exactly when a change reaches a running pod.
level: beginner
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/pods
  - k8s-beginner/manifest-anatomy
---

## Overview

A ConfigMap is a namespaced object holding key/value pairs that pods consume
as environment variables, command-line arguments or files. It exists so one
image can run in development, staging and production without a rebuild.

It is not a secret store, not a database, and not a place for a megabyte of
data.

## Why it exists and when to use it

Twelve-factor configuration says config lives in the environment, not the
build. In containers that means the image is identical everywhere, and
everything that differs arrives at start-up. Kubernetes needs a place to hold
that difference which is:

- **versioned and reviewable** — it is an API object in git,
- **namespaced** — teams cannot read each other's,
- **mountable** — because plenty of software wants a config *file*, not
  environment variables.

Use a ConfigMap for connection hostnames, feature flags, log levels, tuning
parameters and whole configuration files. Use a
[Secret](secrets.md) for anything whose disclosure matters. Use neither for
data that changes per request.

## How it works underneath

A ConfigMap has `data` (UTF-8 strings) and `binaryData` (base64-encoded
bytes). It has **no `spec` and no `status`**: nothing reconciles it, and it
is inert until a pod references it.

There are four ways a pod can consume one:

| Mechanism | Field | Updates in place? |
|---|---|---|
| One key as an env var | `env[].valueFrom.configMapKeyRef` | No |
| All keys as env vars | `envFrom.configMapRef` | No |
| Keys as files | `volumes[].configMap` | **Yes** |
| A single key as a file in an existing directory | `volumeMounts[].subPath` | No |

**Environment variables are resolved once, at container start.** There is no
mechanism to change a process's environment afterwards, so a ConfigMap change
reaches an env-var consumer only when the pod is recreated.

**Volumes are different.** The kubelet writes the keys into a directory and
refreshes them. The refresh is not instantaneous: the total delay is the
kubelet's sync period (one minute by default) plus its cache propagation
delay. Your application must also re-read the file; most do not, which is why
the checksum-annotation pattern below exists.

The volume is built with an atomic-update trick: the real data lives in a
timestamped directory, `..data` is a symlink to it, and every key is a
symlink through `..data`. Swapping the symlink makes the whole set of files
change at once, so an application never sees a half-updated config.

Other properties:

- **1 MiB limit** per object, imposed by etcd. Large payloads belong in an
  image, a volume or an object store.
- **Same namespace only.** A pod cannot mount a ConfigMap from elsewhere.
- **A missing ConfigMap blocks the pod.** The container stays in
  `CreateContainerConfigError` until it exists, unless the reference is
  marked `optional: true`.
- **`immutable: true`** (stable since 1.21) forbids further changes to
  `data`, which both prevents accidents and lets the kubelet stop watching
  the object — a real scalability win on large clusters. To change an
  immutable ConfigMap you create a new one, usually with a new name.
- **Invalid environment variable names are skipped.** `envFrom` ignores keys
  that are not valid identifiers (`app.properties`, for example) and the
  kubelet records an event saying so.

## Basic example

```yaml include="examples/k8s/basics/40-configmap.yaml"
```

```yaml include="examples/k8s/basics/42-config-demo.yaml"
```

```bash
kubectl -n tasklane-basics get configmap hello-config -o yaml
kubectl -n tasklane-basics logs config-demo
kubectl -n tasklane-basics exec config-demo -- ls -l /etc/hello /etc/hello/..data/
kubectl -n tasklane-basics exec config-demo -- cat /etc/hello/greeting.txt /etc/hello/app.properties
```

```console include="captures/k8s-beginner/configmap-yaml.txt"
```

```console include="captures/k8s-beginner/config-demo-logs.txt"
```

```console include="captures/k8s-beginner/configmap-volume-listing.txt"
```

```console include="captures/k8s-beginner/configmap-volume-content.txt"
```

## Explanation

The pod consumes one ConfigMap three ways at once:

- `envFrom.configMapRef` exports `GREETING` and `LOG_LEVEL`. The
  `app.properties` key is skipped, because it is not a valid environment
  variable name, and the kubelet records an event saying so.
- `env[].valueFrom.configMapKeyRef` exports the same `GREETING` value under a
  different name. Use this form when the key and the variable must differ, or
  when you want exactly one key rather than all of them.
- The volume projects two keys as files. Because `items` is set, only the
  listed keys appear, and `GREETING` is renamed to `greeting.txt`. Without
  `items`, every key becomes a file named after it.

The skipped key is visible in the pod's events:

```console include="captures/k8s-beginner/configmap-invalid-env-event.txt"
```

The directory listing shows the `..data` symlink structure described above —
worth seeing once, because it explains why an application that opens the file
by path and holds the file descriptor never notices an update, while one that
re-opens the path does.

### Watching an update arrive

```bash
kubectl -n tasklane-basics patch configmap hello-config --type=merge -p '{"data":{"GREETING":"hello again from a ConfigMap"}}'
sleep 90
kubectl -n tasklane-basics exec config-demo -- cat /etc/hello/greeting.txt
kubectl -n tasklane-basics exec config-demo -- printenv GREETING
```

```console include="captures/k8s-beginner/configmap-update-propagation.txt"
```

The file changed. The environment variable did not, and never will for this
container. That is the single most useful thing to know about ConfigMaps.

### Making a config change restart the pods

Since a ConfigMap change does not restart anything, teams use one of two
patterns:

```yaml title="checksum annotation (templating tools generate this)" fragment
spec:
  template:
    metadata:
      annotations:
        checksum/config: "b4c9a1..."   # hash of the ConfigMap contents
```

Changing the annotation changes the pod template, which triggers a normal
rolling update. Helm charts do this in one line; Kustomize's
`configMapGenerator` achieves the same by appending a content hash to the
ConfigMap's **name**, which changes the pod template's reference.

The blunt alternative is deliberate: `kubectl rollout restart deploy/x`.

## Common patterns

- **One ConfigMap per application**, named after it, with the same labels as
  the workload. Tasklane uses `tasklane-config` for both the API and the
  worker.
- **Environment variables for scalars, volumes for files.** Do not try to
  smuggle an INI file through an env var.
- **Immutable ConfigMaps plus content-hashed names** for anything
  performance-sensitive or frequently updated.
- **`optional: true`** for genuinely optional configuration, so a missing
  object does not wedge the pod.
- **Keep defaults in the image**, overrides in the ConfigMap. A pod that
  cannot start without 30 environment variables is fragile.
- **Never store credentials here.** Even a "test" password in a ConfigMap
  teaches the wrong habit and is readable by anyone with `view` on the
  namespace.

## Production considerations

- **Config changes are releases.** Review them, roll them out gradually, and
  be able to roll them back — which ConfigMaps do **not** do on their own,
  since they have no revision history.
- **Rolling back a Deployment does not roll back its ConfigMap.** Version the
  configuration with the workload (hashed names) if that matters.
- **Watch the size.** Hundreds of pods watching a large ConfigMap costs API
  server memory and bandwidth; immutable objects remove the watch.
- **Env-var-only consumption is fine** if you accept that every config change
  is a rollout. Most teams should prefer that to surprise live reloads.
- **Mind `subPath`.** It is the usual way to drop one file into `/etc`
  without hiding the directory's other contents, and it silently opts out of
  updates.

## Security considerations

- **ConfigMaps are not protected.** Anyone with `get` on ConfigMaps in the
  namespace reads every value, and they appear in `kubectl describe`, in
  events, in backups and in logs.
- **A pod that can read ConfigMaps can read every ConfigMap in its
  namespace** if its ServiceAccount allows it. Tasklane's workloads do not
  mount a token at all.
- **Do not put connection strings with embedded passwords here.** Split the
  password into a Secret, as Tasklane does with `PGPASSWORD_FILE`.
- **Mounted config is a code path.** Anything that can write to a ConfigMap
  an application parses (a template, a script, an nginx config) can change
  that application's behaviour. Restrict `update` on ConfigMaps in shared
  namespaces.

## Troubleshooting

- **`CreateContainerConfigError`** — the ConfigMap or key does not exist.
  `kubectl describe pod` names it.
- **The variable is missing but the key exists** — the key is not a valid
  environment variable name, or `envFrom` was pointed at the wrong object.
  Check the pod's events.
- **A file change did not appear** — wait a full sync period; check that the
  mount is not a `subPath`; check the application is not caching.
- **The mount hid other files** — mounting a volume at `/etc` replaces the
  directory. Mount into a subdirectory, or use `subPath`.
- **`updates to configMap are forbidden`** — the object is immutable. Create
  a new one.

## Common mistakes

- **Expecting environment variables to update.** They do not.
- **Unquoted numbers and booleans.** `PGPORT: 5432` is invalid; ConfigMap
  values are strings, so write `"5432"`.
- **Putting secrets in a ConfigMap** because it was convenient.
- **A ConfigMap per environment with 90% duplication**, instead of one base
  plus overlays.
- **Mounting over a whole directory** and wondering why the application's own
  files disappeared.
- **Storing binary data in `data`.** Use `binaryData`, or do not store it in
  Kubernetes at all.

## Related topics

- [Secrets](secrets.md)
- [Pods](pods.md)
- [Rolling updates and rollbacks](rolling-updates-and-rollbacks.md)
- [Tasklane on Kubernetes](tasklane-on-kubernetes.md)
- [Kustomize](../k8s-advanced/kustomize.md)
