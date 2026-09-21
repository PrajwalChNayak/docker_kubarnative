---
title: Chart development
description: Writing a Helm 4 chart that other people can use: layout, values schemas, helpers, hooks, tests, dependencies and library charts.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37, Helm 4.3
prerequisites:
  - k8s-advanced/helm
  - k8s-intermediate/resources-requests-limits
---

## Overview

A chart is a directory with a `Chart.yaml`, a `values.yaml` and a `templates/`
directory of Go templates that render Kubernetes manifests. Anything else —
schemas, helpers, hooks, tests, subcharts — is optional machinery for making
the chart safe to hand to someone who has not read it.

The chart used throughout this page is
[examples/helm/tasklane](../../examples/helm/tasklane/Chart.yaml): the Tasklane
API, worker and an optional lab PostgreSQL.

## Why it exists and when to use it

Write a chart when other people, other teams or other clusters will install
your application and need to change something about it. The chart is the
contract: `values.yaml` lists what is negotiable, and everything else is not.

Do not write a chart to deploy one application into one cluster that you own.
You will spend the next year maintaining a templating layer whose only consumer
is you. [Kustomize](kustomize.md) covers that case without a template language.

## How it works underneath

### Layout

```
tasklane/
  Chart.yaml            name, version, appVersion, apiVersion: v2
  values.yaml           defaults
  values.schema.json    JSON Schema for the merged values
  .helmignore           what packaging leaves out
  charts/               subcharts, vendored by `helm dependency update`
  Chart.lock            resolved dependency versions and digest
  templates/
    _helpers.tpl        named templates; the underscore keeps it out of output
    *.yaml              one file per object or group
    NOTES.txt           printed after install
    tests/              helm.sh/hook: test resources
```

```yaml include="examples/helm/tasklane/Chart.yaml"
```

`version` is the chart's own SemVer and must change on every chart change;
`appVersion` is the software version and is metadata. `apiVersion: v2` is the
current chart format — chart API **v3 is experimental** and only parsed when
`HELM_EXPERIMENTAL_CHART_V3=1` is set, so charts you publish stay on v2.
`kubeVersion` is a constraint Helm checks against the cluster (`>=1.34.0-0`;
the `-0` makes pre-releases compare sensibly).

### Rendering order and context

Every template is executed with a context: `.Values` (merged and
schema-validated), `.Release` (`Name`, `Namespace`, `Revision`, `IsInstall`,
`IsUpgrade`, `Service`), `.Chart` (the `Chart.yaml` fields) and `.Capabilities`
(`.KubeVersion`, `.APIVersions.Has "gateway.networking.k8s.io/v1"`). Files
whose names begin with `_` produce no manifests; they exist to define named
templates.

`include` and `template` both expand a named template. Only `include` returns a
string, so only `include` can be piped — which is why every chart in the wild
is full of `{{ include "x.labels" . | nindent 4 }}`. `nindent` adds a newline
and then indents; `indent` does not add the newline.

## Basic example

```bash
helm lint examples/helm/tasklane --strict
```

```console include="captures/k8s-advanced/helm-lint.txt"
```

```bash
helm template t examples/helm/tasklane | head -80
```

```console include="captures/k8s-advanced/helm-template-head.txt"
```

The helpers that generate those names and labels:

```text include="examples/helm/tasklane/templates/_helpers.tpl" lines="29-73"
```

## Explanation

### Names and labels

Every object name comes from a helper, and every helper truncates to 63
characters, because that is the limit for a DNS label and Kubernetes rejects
longer names. The label set splits in two on purpose:

- `tasklane.labels` — chart, instance, version, `managed-by`. Metadata.
- `tasklane.api.selectorLabels` — `app.kubernetes.io/name` plus
  `app.kubernetes.io/instance`. These go into `spec.selector`.

Selector labels must be a **stable subset** of the pod template labels.
`.spec.selector` on a Deployment or StatefulSet is immutable, so a chart that
puts `app.kubernetes.io/version` into its selector breaks every upgrade that
changes `appVersion`.

### Values and the schema

```json include="examples/helm/tasklane/values.schema.json" lines="1-24"
```

Helm validates the *merged* values against `values.schema.json` on lint,
template, install and upgrade. With `additionalProperties: false`, a typo is an
error rather than a value that silently does nothing:

```bash
helm template t examples/helm/tasklane --set api.replicas=3
```

```console include="captures/k8s-advanced/helm-schema-reject.txt"
```

Two template functions cover what a schema cannot express. `required "msg"
.Values.x` fails the render when a value is empty, and `fail "msg"` fails it
unconditionally — the Tasklane chart uses `fail` when `postgresql.enabled` is
false and no `database.host` was given.

Publish the defaults so people can read them without unpacking the chart:

```bash
helm show values examples/helm/tasklane | head -40
```

```console include="captures/k8s-advanced/helm-show-values.txt"
```

### Rolling pods when configuration changes

A `helm upgrade` that only changes a ConfigMap changes nothing about the
running pods: the Deployment's pod template is byte-identical, so no rollout
happens and the application keeps reading the old values until something
restarts it. The fix is to make the pod template depend on the ConfigMap:

```yaml title="templates/deployment-api.yaml (excerpt)" fragment
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
```

[Kustomize](kustomize.md) solves the same problem by hashing the generated
object's name instead.

## Common patterns

### Hooks

A hook is an ordinary manifest with a `helm.sh/hook` annotation. Helm removes
it from the main manifest, applies it at the right event, waits for it, and
then continues. The Tasklane migration Job:

```yaml include="examples/helm/tasklane/templates/migrate-job.yaml" lines="1-30" fragment
```

- **`helm.sh/hook`** — `pre-install`, `post-install`, `pre-upgrade`,
  `post-upgrade`, `pre-rollback`, `post-rollback`, `pre-delete`, `post-delete`
  and `test`. A comma-separated list runs the same object at each of them.
- **`helm.sh/hook-weight`** — hooks for one event are sorted by weight
  ascending (ties broken by kind, then name) and run in that order, each one
  waited for before the next. Weights are strings, and negative values sort
  first.
- **`helm.sh/hook-delete-policy`** — `before-hook-creation` (default) deletes
  the previous object with that name before recreating it, which matters
  because a Job's `spec.template` is immutable; `hook-succeeded` deletes it
  after success; `hook-failed` deletes it after failure. The combination used
  here, `before-hook-creation,hook-succeeded`, leaves a failed Job behind for
  `kubectl logs` and cleans up successful ones.

:::warning Hooks are not part of the release graph
A `pre-install` hook runs **before** any of the chart's own resources exist.
A migration hook cannot reach a database that the same release is about to
create. Install once with `--set migrations.enabled=false`, or point the chart
at a database that already exists. On upgrade the problem disappears.
:::

### Chart tests

Resources annotated `helm.sh/hook: test` are not applied during install. They
run when someone runs `helm test <release>`, and the pod's exit code is the
result:

```yaml include="examples/helm/tasklane/templates/tests/test-connection.yaml" fragment
```

```bash
helm test t -n tasklane-helm --logs
helm test t -n tasklane-helm --filter name=t-tasklane-test-connection
```

A test pod is a pod: in a `restricted` namespace it needs the same
`runAsNonRoot`, `seccompProfile`, dropped capabilities and read-only root
filesystem as everything else, which is why this one runs busybox pinned by
digest as UID 65534.

For CI, the `chart-testing` tool (`ct`) wraps this: `ct lint` runs
`helm lint` plus version and maintainer checks across changed charts, and
`ct install` installs each changed chart into a throwaway namespace and runs
its tests.

### Dependencies

```yaml title="Chart.yaml (excerpt)" fragment
dependencies:
  - name: common
    version: "2.x.x"
    repository: oci://registry.example.com/charts
    condition: common.enabled
    alias: shared
```

`helm dependency update` resolves the constraints, downloads the charts into
`charts/` and writes `Chart.lock` with the resolved versions and a digest;
`helm dependency build` reinstalls exactly what the lock file names. Commit
`Chart.lock`. `condition` points at a values key that switches the subchart on
or off, and a parent chart can override subchart values under the subchart's
name.

The Tasklane chart deliberately has **no** dependency for PostgreSQL. The
best-known PostgreSQL charts and images are Bitnami's, and Bitnami moved its
versioned images to a `bitnamilegacy` repository in 2025 with no further
updates, so a dependency on them is a dependency on unpatched images. A
database in your application's release is also a lifecycle mistake: `helm
uninstall` should not be able to delete your database.

### Library charts

A chart with `type: library` renders nothing itself. It exists to export named
templates — a house style for labels, security contexts and probes — that
application charts import as a dependency:

```yaml title="Chart.yaml of a library chart" fragment
apiVersion: v2
name: tasklane-common
type: library
version: 1.0.0
```

Application charts then depend on it and call
`{{ include "tasklane-common.securityContext" . }}`. This is how a platform
team keeps fifty charts consistent without fifty copies of `_helpers.tpl`.

### Packaging and publishing

```bash
helm package examples/helm/tasklane
helm registry login registry.example.com
helm push tasklane-0.1.0.tgz oci://registry.example.com/charts
helm show chart oci://registry.example.com/charts/tasklane --version 0.1.0
```

`.helmignore` decides what never enters the `.tgz`. Helm 4 produces
reproducible archives and honours `SOURCE_DATE_EPOCH`, so the same source
yields the same digest.

## Production considerations

- **Bump `version` on every change.** Consumers pin versions; a mutated chart
  at the same version is indistinguishable from the original.
- **Ship a `values.schema.json`.** It turns support questions into error
  messages, and it documents the contract better than comments do.
- **Default to safe.** Off by default for anything that needs a cluster
  feature (`networkPolicy.enabled`, `api.autoscaling.enabled`), and never a
  default password. The Tasklane chart consumes `database.existingSecret` and
  never renders a password, so nothing sensitive reaches the release record.
- **Set resources and a securityContext in the chart, not in the values.**
  Values are what a *user* may change; a chart that ships without requests
  makes every user reinvent them.
- **Lint in CI with `--strict`**, and render with the toggles your users
  actually flip, then pipe the output through `kubeconform` and a policy check.
- **Cost of ownership is real.** Every value you expose is a promise. A chart
  with 200 values is a second Kubernetes API with worse documentation.

## Security considerations

**Threat: a chart that renders a Secret.** Anything a template renders lands in
the release record, which is a Secret in the namespace. A chart that generates
a password with `randAlphaNum` also *rotates* it on every upgrade unless it
guards the value with a lookup, and that password is readable by anyone with
`get secret` in the namespace.

*Exploit:* `kubectl get secret sh.helm.release.v1.<release>.v1 -o jsonpath='{.data.release}'`, base64-decode twice, gunzip, read the value.

*Fix:* consume an existing Secret (`database.existingSecret`), or an
ExternalSecret produced by a secrets operator. If a chart must generate one,
document that the value is visible to namespace readers.

*Verify:* `helm template t ./chart | grep -i -A3 "kind: Secret"` should return
nothing that contains a credential, and `helm get manifest` on a real release
should be equally boring.

**Threat: a chart that escalates privilege.** Charts routinely ship
ClusterRoles, and a chart is code. Read `helm template` output for `kind:
ClusterRoleBinding`, `hostPath`, `privileged: true`, `hostNetwork` and
`automountServiceAccountToken: true` before installing anything from the
internet. Enforce it at the cluster edge with
[Pod Security Admission](../k8s-security/pod-security-standards.md) and
[admission policies](admission-policies-cel.md), so a chart cannot install what
your namespaces forbid.

**Threat: a poisoned dependency.** Subcharts are pulled at build time.
Commit `Chart.lock`, use `helm dependency build` rather than `update` in CI,
prefer OCI references by digest, and sign your own charts
(`helm package --sign`, `helm install --verify`).

## Troubleshooting

**`error converting YAML to JSON: ... did not find expected key`.** Indentation
from a helper. Render with `helm template --debug`, which prints the offending
YAML even when it will not parse.

**`nil pointer evaluating interface {}`.** A template read `.Values.a.b` where
`a` is absent. Guard with `with`, default with `default`, or make the key
required in the schema.

**A label or annotation renders as `map[...]`.** You interpolated a map
directly instead of `toYaml`-ing it.

**Hook Job fails on the second upgrade with "field is immutable".** The Job
still exists from last time. That is exactly what
`helm.sh/hook-delete-policy: before-hook-creation` is for.

**`helm lint` passes but the cluster rejects the manifest.** Lint does not know
your API server. Pipe `helm template` through `kubeconform -strict
-kubernetes-version 1.37.0` and follow it with `helm install --dry-run=server`.

## Common mistakes

- Putting a changing label such as the app version into `spec.selector`.
- Forgetting `checksum/config`, then wondering why a config change did nothing.
- Using `template` where a pipe is needed; only `include` returns a string.
- Writing a `pre-install` hook that depends on a resource the same release
  creates.
- Vendoring a database chart into an application chart, tying the database's
  lifecycle to the application's release.
- Exposing every field "just in case", so the chart becomes unmaintainable.
- Skipping `values.schema.json` and discovering a `--set` typo in production.

## Related topics

- [Helm](helm.md)
- [Helm vs Kustomize](helm-vs-kustomize.md)
- [Kustomize](kustomize.md)
- [CI/CD for Kubernetes](cicd-for-kubernetes.md)
- [Pod Security Standards](../k8s-security/pod-security-standards.md)
- [Admission policies with CEL](admission-policies-cel.md)
- [Secrets management](../k8s-security/secrets-management.md)
