---
title: Kustomize
description: Template-free configuration management with bases, overlays, patches, components, generators and replacements, built into kubectl.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/manifest-anatomy
  - k8s-beginner/labels-selectors-annotations
---

## Overview

Kustomize takes plain Kubernetes manifests and transforms them. There is no
template language and no placeholder syntax: every input file is a valid
manifest you could `kubectl apply` on its own, and a `kustomization.yaml`
declares what to change when you combine them.

It is built into `kubectl` — `kubectl 1.37` embeds **Kustomize v5.8.1** — so
`kubectl kustomize <dir>` renders and `kubectl apply -k <dir>` renders and
applies. The standalone `kustomize` binary exists and moves faster, but
everything on this page works with `kubectl` alone.

## Why it exists and when to use it

The problem is the same one Helm solves: one application, several
environments. Kustomize's answer is to keep the manifests as manifests and
express the differences as patches against them.

That buys three things. Your files stay readable and lintable by every YAML
tool. The output of a render is a straightforward diff against the previous
render. And there is no chart to publish, version or maintain when you are the
only consumer.

It costs you distribution. There is no "install this with one command from a
registry" story, no values schema to validate what a user passed, and no
release record — Kustomize has no idea what it applied last time, so it cannot
roll back or uninstall as a unit. Use [Helm](helm.md) when you are shipping
software to other people, and Kustomize when you are deploying your own
software to your own clusters. [Helm vs Kustomize](helm-vs-kustomize.md) goes
through the trade-off in detail.

## How it works underneath

`kubectl kustomize` runs an in-process pipeline:

1. **Accumulate.** Read `resources:` (files, directories with their own
   `kustomization.yaml`, or remote URLs), then run `configMapGenerator` and
   `secretGenerator`, then fold in each entry under `components:`.
2. **Transform.** Apply the built-in transformers in a fixed order: patches,
   then `images`, `replicas`, `namespace`, `labels`, `annotations`, name
   prefixes and suffixes.
3. **Resolve references.** A name that changed — because a generator added a
   hash, or a prefix was applied — is rewritten everywhere it is *referenced*:
   `configMapRef`, `secretKeyRef`, `volumes[].secret.secretName`,
   `serviceAccountName`, a Service name in an Ingress backend, and so on.
   Kustomize knows these field paths; it does not search for strings.
4. **Run replacements.** `replacements:` copy a value from one rendered object
   into fields of others.
5. **Emit.** Sorted YAML on stdout. Nothing has touched a cluster yet.

Everything a kustomization reads must live at or below its own directory. That
is the **load restrictor** (`LoadRestrictionsRootOnly`), and it is what keeps a
kustomization relocatable. `--load-restrictor=LoadRestrictionsNone` disables
it; needing that flag is usually a sign that a file is in the wrong place.

## Basic example

The Tasklane example in
[examples/kustomize](../../examples/kustomize/base/kustomization.yaml) is one base and three
overlays:

```
base/                     no namespace, no environment, no replica opinions
components/network-policy default-deny plus the flows Tasklane needs
components/hpa            autoscaling/v2 HPA + a patch removing spec.replicas
overlays/dev              1 replica, generated Secret, dev tag
overlays/staging          2 replicas, rc tag, NetworkPolicy, a replacement
overlays/prod             digests, HPA, NetworkPolicy, ExternalSecret
```

```yaml include="examples/kustomize/base/kustomization.yaml"
```

```yaml include="examples/kustomize/overlays/prod/kustomization.yaml"
```

```bash
kubectl kustomize examples/kustomize/overlays/prod | head -60
```

```console include="captures/k8s-advanced/kustomize-prod-head.txt"
```

## Explanation

### Patches

`patches:` is the single modern entry point; `patchesStrategicMerge` and
`patchesJson6902` still work but print a deprecation warning and should be
migrated with `kustomize edit fix`.

A **strategic merge patch** looks like the object it changes. Lists merge by a
per-field merge key — containers by `name`, Service ports by `port`, volumes by
`name` — which is why naming the container is what makes a container patch a
merge instead of a replacement:

```yaml include="examples/kustomize/overlays/dev/patches/api-dev.yaml" fragment
```

`$patch: delete` removes one element of such a list. The prod overlay uses it
to drop the `migrate` initContainer, because production migrations run as a
gated pipeline step rather than on every pod start:

```yaml include="examples/kustomize/overlays/prod/patches/api-prod.yaml" lines="1-20" fragment
```

A **JSON 6902 patch** is a list of operations (`add`, `remove`, `replace`,
`move`, `copy`, `test`) against explicit paths. Use it for what strategic merge
cannot express: removing a field entirely, or addressing a list element by
index. The HPA component removes `spec.replicas` that way, and the staging
overlay replaces `spec.ports/0/port` on a Service — a strategic merge patch
there would *add* a second port, because Service ports merge on `port`.

A patch entry has either a `path` or an inline `patch:`, and an optional
`target:` selecting by group, version, kind, name, namespace, `labelSelector`
or `annotationSelector`. One patch can therefore hit every Deployment in the
build at once.

### Generators and the name suffix hash

`configMapGenerator` and `secretGenerator` build objects from literals, files
or env files and append a hash of the content to the name:

```bash
kubectl kustomize examples/kustomize/overlays/dev | grep -A6 'kind: Secret'
```

```console include="captures/k8s-advanced/kustomize-dev-secret.txt"
```

The hash is the mechanism that makes configuration changes roll pods. Edit
`base/config.env`, and the ConfigMap's name changes, and every pod template
that references it changes, and the Deployment rolls. A hand-written ConfigMap
edited in place changes nothing about running pods.

Two consequences. `behavior: merge` (or `replace`) lets an overlay edit a
generated object from the base, as dev and prod do for `tasklane-config`. And
old hashed objects accumulate: nothing deletes them. `kubectl apply --prune`
still describes itself as Alpha in its own help text, so pruning in practice
means Argo CD or Flux. `generatorOptions.disableNameSuffixHash: true` turns the
hash off, and with it the automatic rollout.

:::warning Generated Secrets live in git
`secretGenerator` with literals puts the value in the repository, base64 is not
encryption, and the dev overlay uses it only because the value is a throwaway.
Staging and prod reference an externally managed Secret, and prod ships an
`ExternalSecret` (`external-secrets.io/v1`) that the External Secrets Operator
turns into `tasklane-db`.
:::

### Labels, namespace and images

`labels:` replaces the deprecated `commonLabels:`. The difference matters:
`commonLabels` always wrote into selectors as well as metadata, and
`.spec.selector` on a Deployment or StatefulSet is **immutable**, so adding a
common label to a live workload with `commonLabels` fails the apply. Every
kustomization in the example sets `includeSelectors: false`.

`namespace:` sets `metadata.namespace` on every namespaced object, and updates
the namespace of RoleBinding subjects. It does **not** reach into custom
resource fields — the HTTPRoute's `parentRefs[].namespace` stays whatever the
base said, which here is deliberate.

`images:` rewrites image references found in pod specs: `newName` for a
registry move, `newTag` for a tag, `digest` for immutability. `replicas:` sets
replica counts by name. Both are ordinary transformers, so a later patch can
still override them.

### Components

A **component** (`apiVersion: kustomize.config.k8s.io/v1alpha1`, `kind:
Component`) is an opt-in slice of configuration. Unlike a base it is not
rendered on its own and it may patch resources it does not own, which is what
makes "switch on autoscaling" or "switch on NetworkPolicy" a single line in an
overlay:

```yaml include="examples/kustomize/components/hpa/kustomization.yaml"
```

Components compose: prod lists both `network-policy` and `hpa`. Because the HPA
component owns the API's replica count, the prod overlay's `replicas:` entry
covers only the worker.

### Replacements

`replacements:` copy a value from one object into fields of others, so two
places cannot drift. The staging overlay copies the API Service's port into the
HTTPRoute's `backendRefs[0].port`. The older `vars:` mechanism is deprecated in
favour of replacements and prints a warning.

## Common patterns

### Applying

```bash
kubectl apply -k examples/kustomize/overlays/dev
kubectl diff -k examples/kustomize/overlays/dev
```

A server-side dry run validates the rendered output against the real API
server, including admission policies and Pod Security Admission. The namespace
must already exist, because a dry run creates nothing:

```bash
kubectl create namespace tasklane-dev --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -k examples/kustomize/overlays/dev --dry-run=server
```

```console include="captures/k8s-advanced/kustomize-dev-dry-run.txt"
```

### Remote bases

`resources:` accepts a Git URL with a ref:
`github.com/example/platform//manifests/base?ref=v1.4.0`. Always pin the ref.
An unpinned remote base is a supply-chain hole and an unreproducible build.

### One overlay per cluster, not per team

The unit that deserves an overlay is a deployment target: dev, staging, prod,
or one per region. Overlays that differ by who owns them, rather than where
they run, turn into duplicated patches that drift.

## Production considerations

- **Render in CI, not on a laptop.** `kubectl kustomize overlays/prod` piped
  through `kubeconform -strict -kubernetes-version 1.37.0` and a policy check
  catches most mistakes before the API server sees them.
- **Let a GitOps controller apply it.** Argo CD and Flux both render
  kustomizations natively, and they also solve the pruning problem that
  `kubectl apply -k` does not.
- **Pin images by digest in prod.** The prod overlay uses `digest:`; CI rewrites
  it with `kustomize edit set image` after pushing.
- **Keep the base honest.** Anything environment-specific in the base — a
  namespace, a hostname, a replica count you actually care about — forces
  every overlay to patch it back out.
- **Watch build time and depth.** Overlays on overlays on components render
  fine but become impossible to reason about. Two levels is usually enough.
- **Understand what you cannot do.** Kustomize has no conditionals and no
  loops. "Only create this object in prod" is expressed by putting the object
  in the prod overlay, not by a flag.

## Security considerations

**Threat: a secret committed to git.** `secretGenerator` makes it one line to
put a password in the repository, and base64 in the rendered output looks
encrypted to the untrained eye.

*Exploit:* anyone with read access to the repository — including every CI job
and every fork — runs `kubectl kustomize overlays/prod | grep -A3 'kind:
Secret' | base64 -d` and has the database password. Git history keeps it after
you delete the line.

*Fix:* generate secrets only for throwaway environments, as the dev overlay
does. Everywhere else, reference an externally managed Secret and let the
External Secrets Operator (`external-secrets.io/v1`) or Sealed Secrets create
it. Add a pre-commit or CI check that fails on `kind: Secret` with inline data
outside `overlays/dev`.

*Verify:* `kubectl kustomize overlays/prod | grep -c 'kind: Secret'` should be
zero, and `git log -p -- overlays | grep -i password` should find nothing.

**Threat: an unpinned remote base.** `resources: - github.com/x/y//base`
without `?ref=` renders whatever is on the default branch at build time.
Whoever can push to that repository can add a privileged DaemonSet to your
cluster. Pin every remote reference to a tag or commit, and prefer vendoring.

**Pod Security still applies.** Kustomize is a text transformer; it enforces
nothing. Every overlay here creates its namespace with `enforce`, `warn` and
`audit` set to `restricted` and pinned to `v1.37`, so the API server rejects a
patch that would make a pod privileged. Verify with a server dry run.

## Troubleshooting

**`may not add resource with an already registered id`.** Two resources in the
build have the same group/kind/name/namespace — usually a base included twice.

**A patch silently does nothing.** The `target:` did not match. Check kind,
name and the group/version, and remember that the target matches the state of
the object *at that point* in the pipeline.

**`no matches for Id ...` on a JSON 6902 patch.** The path does not exist in
the target — a `remove` on an absent field, or an index past the end of a list.

**The namespace was not applied.** Cluster-scoped objects (Namespace,
ClusterRole) are never given one, and fields inside custom resources are not
namespace-transformed.

**`security; file ... is not in or below ...`.** The load restrictor. Move the
file under the kustomization root, or accept
`--load-restrictor=LoadRestrictionsNone` and lose relocatability.

**Deprecation warnings on stdout.** `commonLabels`, `patchesStrategicMerge`,
`patchesJson6902` and `vars` all warn. `kustomize edit fix` rewrites them.

## Common mistakes

- Using `commonLabels` on a live workload and hitting the immutable-selector
  error on apply.
- Expecting `namespace:` to rewrite a namespace embedded in a custom resource's
  spec.
- Putting a password in `secretGenerator` for anything that is not disposable.
- Disabling the name suffix hash and then wondering why a config change did not
  restart anything.
- Pinning replicas in an overlay for a Deployment that an HPA also manages, so
  every apply fights the autoscaler.
- Treating `kubectl apply -k` as complete lifecycle management: it never
  deletes what you removed from git.
- Validating the patch files instead of the rendered output. Patches are
  fragments and will never pass a schema check on their own.

## Related topics

- [Helm](helm.md)
- [Helm vs Kustomize](helm-vs-kustomize.md)
- [GitOps with Argo CD](gitops-argo-cd.md)
- [GitOps with Flux](gitops-flux.md)
- [Horizontal Pod Autoscaler](horizontal-pod-autoscaler.md)
- [Network policy](../k8s-intermediate/network-policy.md)
- [Gateway API](../k8s-intermediate/gateway-api.md)
- [Secrets management](../k8s-security/secrets-management.md)
