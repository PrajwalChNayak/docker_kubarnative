---
title: Helm
description: How Helm 4 turns a chart into a release, what it stores in the cluster, and which of its flags matter in production.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37, Helm 4.3
prerequisites:
  - k8s-beginner/deployments-and-replicasets
  - k8s-beginner/configmaps
---

## Overview

Helm packages a set of Kubernetes manifests as a **chart**, renders that chart
with a set of **values**, applies the result, and remembers what it applied as
a **release**. That memory is the whole point: because Helm knows the previous
revision, it can upgrade, diff, roll back and uninstall a group of objects as a
unit.

Helm 4 (v4.3.0 at the time of writing) is a client-side binary. There is no
server component: the Tiller of Helm 2 was removed in Helm 3 and has not come
back. Everything Helm does, it does with your kubeconfig and your RBAC.

## Why it exists and when to use it

Raw manifests do not template. The moment you need the same application in
three namespaces with three replica counts, three image tags and two different
hostnames, you are copying YAML and the copies drift.

Helm answers that with parameterisation plus distribution. A chart is a single
versioned artefact you can publish, sign and pull, and `helm install` is one
command that an operator who has never read your manifests can run. That is why
almost every third-party component — Envoy Gateway, cert-manager, Prometheus —
ships a chart.

Helm is the wrong tool when:

- You only ever deploy your own application into your own clusters and the
  differences between environments are small. [Kustomize](kustomize.md) does
  that with no templating language at all.
- You want YAML that is readable as YAML. Go templates interleaved with
  whitespace-sensitive YAML are genuinely hard to read and easy to break.
- You want a GitOps diff that means something. `helm template` output is
  diffable, but a change to a values file can move a hundred lines somewhere
  deep in the chart.

See [Helm vs Kustomize](helm-vs-kustomize.md) for the honest comparison, and
[Chart development](helm-chart-development.md) for writing charts rather than
using them.

## How it works underneath

### From chart to cluster

1. **Load.** Helm reads the chart directory or `.tgz`, plus any subcharts in
   `charts/`.
2. **Coalesce values.** Defaults from `values.yaml`, then each `-f` file left
   to right, then `--set` flags. The merged result is validated against
   `values.schema.json` if the chart has one.
3. **Render.** Go templates are executed with a context containing `.Values`,
   `.Release` (name, namespace, revision, `IsInstall`/`IsUpgrade`), `.Chart`
   and `.Capabilities` (the cluster's Kubernetes version and API list).
4. **Sort and apply.** Hooks are extracted and run at their event; the
   remaining manifests are sorted into a fixed kind order (namespaces and CRDs
   before the objects that use them) and sent to the API server.
5. **Record.** Helm writes the rendered manifest, the values and the chart
   metadata into the cluster as a release record.

### Where the release lives

By default a release record is a **Secret in the release's namespace**. Its
type is `helm.sh/release.v1` and its name is
`sh.helm.release.v1.<release>.v<revision>` — release `t` at revision 3 is
`sh.helm.release.v1.t.v3`. Helm labels these with `owner=helm`, `name`,
`status` and `version`, which is why `kubectl get secret -l owner=helm` lists
your releases. The payload is the gzipped, base64-encoded release object.

Two consequences follow. Deleting that Secret makes Helm forget the release
while the objects keep running. And anyone who can read Secrets in the
namespace can read every value you passed, including passwords.

### Server-side apply

Helm 4 uses **server-side apply** for new installs (`--server-side` defaults to
true on `helm install`). Field ownership is then tracked by the API server, and
a conflicting change by another controller is reported instead of silently
overwritten; `--force-conflicts` takes the fields anyway. Upgrades and
rollbacks default to `--server-side auto`, which keeps whatever method the
previous revision used, so a release created by Helm 3 stays client-side until
you move it deliberately.

### Waiting

`--wait` in Helm 4 is a **strategy**, not a boolean:

| Value | Behaviour |
|---|---|
| omitted | `hookOnly` — Helm waits for hook resources only |
| `--wait` (bare) | `watcher` — kstatus-based readiness watching for all resources |
| `--wait=watcher` | the same, spelled out |
| `--wait=hookOnly` | the default, spelled out |
| `--wait=legacy` | the Helm 3 polling implementation |

`--wait-for-jobs` additionally waits for Jobs to complete. `--timeout` (default
5m) bounds any single operation.

## Basic example

```bash
helm version
```

```console include="captures/k8s-advanced/helm-version.txt"
```

Install the Tasklane chart into a namespace of its own, without changing
anything, by asking the API server to validate it:

```bash
kubectl create namespace tasklane-helm --dry-run=client -o yaml | kubectl apply -f -
kubectl label --overwrite namespace tasklane-helm pod-security.kubernetes.io/enforce=restricted
helm install t examples/helm/tasklane -n tasklane-helm --dry-run=server
```

```console include="captures/k8s-advanced/helm-dry-run-server.txt"
```

Then the real lifecycle:

```bash
helm install t examples/helm/tasklane -n tasklane-helm --wait --rollback-on-failure
helm upgrade t examples/helm/tasklane -n tasklane-helm --set api.replicaCount=3 --wait
helm history t -n tasklane-helm
helm rollback t 1 -n tasklane-helm --wait
helm test t -n tasklane-helm --logs
helm uninstall t -n tasklane-helm
```

## Explanation

`--dry-run` takes a value in Helm 4: `none`, `client` or `server`. A server dry
run sends the manifests to the API server with `dryRun=All`, so admission
controllers, CEL policies and Pod Security Admission all get a vote. It is the
closest you can get to "would this work" without changing anything. It still
needs a cluster and RBAC.

`--rollback-on-failure` replaces Helm 3's `--atomic`: if the operation fails,
Helm rolls back to the previous successful revision (on install it uninstalls).
Setting it defaults `--wait` to `watcher`, because rolling back on failure is
meaningless if Helm does not wait to find out. `--atomic` still exists as a
deprecated alias and prints a deprecation warning.

`helm history` shows every revision Helm has kept. `--history-max` (default 10)
bounds that list on upgrade; each revision is a Secret, and a chart with large
rendered output plus an unbounded history is a real way to hit etcd's
1.5 MiB object limit.

Helm never watches anything after the command exits. If a Deployment degrades
an hour later, Helm does not know and does not care. That is the difference
between Helm and a GitOps controller such as
[Argo CD](gitops-argo-cd.md) or [Flux](gitops-flux.md), which keep reconciling.

## Common patterns

### Repositories and OCI

Classic HTTP repositories are an `index.yaml` plus `.tgz` files:

```bash
helm repo add example https://charts.example.com
helm repo update
helm search repo example/tasklane --versions
```

OCI registries need no index: a chart is an artefact in the same registry as
your images, with the same authentication and the same retention policy.

```bash
helm registry login registry.example.com
helm push tasklane-0.1.0.tgz oci://registry.example.com/charts
helm install t oci://registry.example.com/charts/tasklane --version 0.1.0
```

`helm registry login` takes a **host**, not a URL. Helm 4 can also install an
OCI chart by digest (`...@sha256:...`), which is the only truly immutable
reference.

### Values layering

```bash
helm upgrade --install t examples/helm/tasklane -n tasklane-prod \
  -f values/common.yaml -f values/prod.yaml \
  --set api.image.digest=sha256:...
```

Later `-f` files win; `--set` beats every file. On upgrade, Helm uses the
chart's defaults plus what you pass — *not* the previous revision's values —
unless you ask for `--reuse-values` or `--reset-then-reuse-values`. Forgetting
this is the most common way to silently drop a setting during an upgrade.

### Post-renderers

A post-renderer receives the rendered manifest on stdin and returns modified
YAML — the escape hatch for charts that do not expose the field you need. In
Helm 4 a post-renderer is a **plugin**, not an arbitrary executable path:
`--post-renderer` names an installed plugin of type post-renderer and
`--post-renderer-args` passes arguments to it.

:::warning
This is the one Helm 3 habit that will break on day one. `--post-renderer
./kustomize-wrapper.sh` no longer works; the script has to be packaged as a
plugin and installed with `helm plugin install`.
:::

### Helm 3 to Helm 4

| Helm 3 | Helm 4 |
|---|---|
| client-side apply by default | **server-side apply** on new installs; `auto` on upgrade |
| `--wait` boolean | `--wait` strategy: `watcher`, `hookOnly` (default), `legacy` |
| `--atomic` | `--rollback-on-failure` (`--atomic` kept as a deprecated alias) |
| `--force` | `--force-replace` (`--force` kept as a deprecated alias) |
| `--dry-run` boolean | `--dry-run` takes `none`, `client` or `server` |
| `--post-renderer <path>` | `--post-renderer <plugin>` |
| `helm version --client` | removed; `helm version` is client-only anyway |
| `helm lint` with no path | removed; the path is required |
| `helm repo add --no-update` | removed |
| `helm status --show-desc/--show-resources` | removed |
| chart `apiVersion: v2` | still the default; chart API v3 is **experimental** and only parsed with `HELM_EXPERIMENTAL_CHART_V3=1` |

Helm 3 reached end of bug fixes on 2026-09-09; security fixes continue until
2027-02-10. New work belongs on Helm 4. The migration details live in
[Helm 3 to 4](../migration/helm-3-to-4.md).

## Production considerations

- **Pin the chart version.** `--version 0.1.0`, or a digest for OCI. A chart
  reference without a version resolves to whatever is newest at that moment.
- **`helm upgrade --install`** is the idempotent form. Use it in CI so the
  first deploy and the hundredth are the same command.
- **Wait deliberately.** `--wait --timeout 10m --rollback-on-failure` gives a
  pipeline a real pass/fail signal. Without `--wait`, `helm upgrade` returns
  as soon as the API server has accepted the objects.
- **Keep releases small.** One release per application. A release that spans
  twenty applications means every rollback is a twenty-application rollback.
- **Ownership.** Helm refuses to adopt objects it did not create. Installing
  the Tasklane chart into the existing `tasklane` namespace fails, because
  those objects came from `kubectl apply`. `--take-ownership` makes Helm claim
  them, which is occasionally the right answer during a migration and usually
  a good way to delete something you meant to keep.
- **Cost.** Every release revision is an object in etcd. Set `--history-max`
  and prefer `helm uninstall` over leaving dead releases around.

## Security considerations

**Threat: a reader of the namespace reads your database password.**
The release record holds the fully rendered manifest *and* the merged values.
If a chart renders a password into a Secret, or if you pass one with `--set`,
that value sits in `sh.helm.release.v1.<release>.v<n>` in plain gzip.

*Exploit:* anyone with `get secret` in the namespace runs
`kubectl get secret sh.helm.release.v1.t.v1 -o jsonpath='{.data.release}' | base64 -d | base64 -d | gunzip` and reads everything.

*Fix:* charts should consume an **existing** Secret rather than create one —
the Tasklane chart takes `database.existingSecret` and never renders a
password. Keep real secrets in an external store with the External Secrets
Operator or a KMS-backed provider, and restrict `get`/`list` on Secrets in the
namespace to the operators who need it. Use `--hide-secret` with `--dry-run` so
CI logs do not leak the values either.

*Verify:* `kubectl -n <ns> get secret -l owner=helm -o yaml | grep -i password`
should find nothing, and `kubectl auth can-i get secrets -n <ns> --as=<user>`
should say no for ordinary users.

**Threat: a tampered chart.** A chart is code that renders privileged objects.
`helm pull --verify` and `helm install --verify` check the chart's provenance
file against your keyring; Helm 4 also supports GnuPG keybox files. For OCI,
install by digest so the tag cannot be moved under you. Helm plugins are code
too: `helm plugin install` verifies plugin signatures by default.

**Threat: over-broad RBAC.** Helm acts as you. A CI service account that can
install any chart into any namespace can create a ClusterRoleBinding and own
the cluster. Scope the account to one namespace, and review charts before
adding them — `helm template` then read the RBAC objects.

## Troubleshooting

**`another operation (install/upgrade/rollback) is in progress`.** A previous
command died leaving the release in `pending-upgrade`. Check `helm history`,
then either `helm rollback <release> <last-good-revision>` or, on Helm 4,
re-run the upgrade after confirming nothing else is running. Do not delete the
release Secret unless you intend to lose the history.

**`Unable to continue with install: ... exists and cannot be imported into the current release`.** The object was created by something other than this
release. Either delete it, or adopt it with `--take-ownership`, knowing the
next `helm uninstall` will then delete it.

**A hook never finishes.** `helm install --wait` waits for hooks even in the
default `hookOnly` strategy. `kubectl get job,pod -n <ns>` while it hangs; the
Job is usually failing to pull an image or failing to reach a dependency.

**Values do not take effect.** Render locally with the same flags:
`helm template t ./chart -f values/prod.yaml --set x=y | grep -n <field>`.
If the field is absent from the output, the chart does not expose it.

**Schema errors.** `values don't meet the specifications of the schema(s)`
means `values.schema.json` rejected the merged values. The message names the
JSON pointer. `--skip-schema-validation` exists; using it in CI defeats the
purpose of having a schema.

## Common mistakes

- Treating `helm upgrade` as additive. Without `--reuse-values`, values you set
  in an earlier upgrade and did not pass again revert to chart defaults.
- Using `--wait` and assuming it is a boolean. `--wait=hookOnly` is the default
  and waits for almost nothing.
- Installing into a namespace that already contains hand-applied objects, then
  reaching for `--take-ownership` without understanding that uninstall will now
  delete them.
- Letting release history grow unbounded and then discovering etcd limits
  during an incident.
- Passing secrets with `--set` in a pipeline, so they land in the CI log, the
  shell history and the release record.
- Assuming Helm reconciles. It runs once. Drift is invisible to it.

## Related topics

- [Chart development](helm-chart-development.md)
- [Kustomize](kustomize.md)
- [Helm vs Kustomize](helm-vs-kustomize.md)
- [GitOps with Argo CD](gitops-argo-cd.md)
- [GitOps with Flux](gitops-flux.md)
- [CI/CD for Kubernetes](cicd-for-kubernetes.md)
- [Secrets management](../k8s-security/secrets-management.md)
- [Helm 3 to 4](../migration/helm-3-to-4.md)
