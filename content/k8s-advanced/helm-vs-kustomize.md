---
title: Helm vs Kustomize
description: What each tool actually does, which problems only one of them solves, and the three supported ways of combining them.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37, Helm 4.3
prerequisites:
  - k8s-advanced/helm
  - k8s-advanced/kustomize
---

## Overview

Helm and Kustomize are compared endlessly, usually as though they were rivals
for the same job. They are not. Helm is a **package manager**: it produces a
distributable artefact and remembers what it installed. Kustomize is a
**configuration transformer**: it turns manifests into other manifests and
remembers nothing.

Once you see that, most of the argument dissolves. The question "which one"
almost always resolves to "who is going to install this, and do they have my
repository?"

## Why it exists and when to use it

| Question | Helm | Kustomize |
|---|---|---|
| Ship software to strangers | **yes** — a versioned, signable artefact in a registry | no distribution story |
| Deploy your own app to your own clusters | works, with a templating layer you maintain | **yes**, nothing extra |
| Parameterise for a user who cannot see your repo | **yes**, `values.yaml` + JSON Schema | no |
| Read the YAML as YAML | no, it is a Go template | **yes**, every file is a manifest |
| Roll back a whole application | **yes**, `helm rollback` against a stored revision | no; re-apply an older commit |
| Uninstall as a unit | **yes**, `helm uninstall` | no; delete objects yourself |
| Know what it applied last time | **yes**, the release record | no state at all |
| Conditionals and loops | **yes**, Go templates | no, by design |
| Install with one command, no clone | **yes** | no |
| Extra binary | yes | no, `kubectl` embeds Kustomize v5.8.1 |

A simple rule that holds up in practice:

- **You are the author and the operator** → Kustomize. Overlays per
  environment, everything readable, no chart to version.
- **Someone else will operate it** → Helm. Publish a chart with a values
  schema and a version.
- **You are the operator of someone else's chart** → Helm to install it, and
  one of the combinations below when the chart does not expose what you need.

## How it works underneath

The mechanical differences that cause most of the surprises:

**State.** Helm writes a release record — a Secret named
`sh.helm.release.v1.<release>.v<revision>` of type `helm.sh/release.v1` — into
the release namespace. That record is what makes `helm diff`, `helm rollback`
and `helm uninstall` possible. Kustomize writes nothing; `kubectl apply -k`
leaves only the usual `kubectl.kubernetes.io/last-applied-configuration`
annotation (or server-side apply field ownership), and neither tool deletes
objects you removed from git.

**Substitution.** Helm substitutes *before* the YAML exists: the template is
text, and a missing value produces invalid YAML. Kustomize substitutes *after*:
it parses complete manifests into structured objects and patches them, so a
mistake is a patch that does not match rather than a syntax error.

**Ordering.** Helm sorts resources into a fixed kind order and runs hooks at
install/upgrade events, so it can create a CRD before a custom resource and run
a migration before the new pods. Kustomize emits one stream and relies on the
API server and controllers to converge; `kubectl apply` has no hook concept.

**Change detection.** Helm's convention is a `checksum/config` annotation that
hashes the ConfigMap into the pod template. Kustomize's is a name suffix hash
that changes the generated object's name. Both exist because Kubernetes does
not restart pods when a ConfigMap changes.

## Basic example

The same application, both ways, in this repository:

- [examples/helm/tasklane](../../examples/helm/tasklane/Chart.yaml) — one chart,
  values toggles for PostgreSQL, HPA, NetworkPolicy and the HTTPRoute.
- [examples/kustomize](../../examples/kustomize/base/kustomization.yaml) — one base, three
  overlays, two components.

Count the difference in what each has to express: the chart needs
`{{- if .Values.postgresql.enabled }}` around an entire StatefulSet; the
overlay simply does not list that file.

## Explanation

### Where Helm hurts

Templating YAML with a text templater is the original sin. Indentation bugs
appear at render time, `nindent` is load-bearing, and the error messages point
at a line in a file that does not exist. A chart's values surface grows without
limit, because every user's edge case becomes a new key, and every key is a
promise you must keep forever. Charts you do not control frequently do not
expose the one field you need.

### Where Kustomize hurts

No conditionals means variation is expressed by structure, and structure
duplicates. Four environments that each differ in three ways is fine; twelve
tenants that each differ in nine ways becomes a patch maze. Patches are
positional or merge-key based, so a base change can silently stop matching a
patch — a JSON 6902 `replace` on `/spec/ports/0/port` means something different
after someone reorders the ports. And there is no packaging: consumers need
your repository.

### Neither one deploys

Both tools produce manifests and hand them to the API server once. Neither
watches for drift, neither prunes what you deleted, and neither gives you an
audit trail of who changed what. That is the job of
[Argo CD](gitops-argo-cd.md) or [Flux](gitops-flux.md), both of which render
Helm charts *and* kustomizations natively. Choosing Helm or Kustomize does not
answer the GitOps question; it only chooses the renderer.

## Common patterns

### 1. Kustomize wrapping Helm (`helmCharts`)

Kustomize can call `helm template` and feed the output into its own pipeline:

```yaml include="examples/kustomize/with-helm/kustomization.yaml"
```

```bash
kubectl kustomize --enable-helm --load-restrictor=LoadRestrictionsNone examples/kustomize/with-helm | head -40
```

```console include="captures/k8s-advanced/kustomize-with-helm.txt"
```

`--enable-helm` is required, because the generator shells out to the `helm`
binary and is off by default. What comes out is plain YAML: no release record,
no `helm rollback`, no `helm test`, and hook annotations that nothing will act
on. Use it when you consume a third-party chart and need a change it does not
expose — and know that you have opted out of Helm's lifecycle.

### 2. Piping the render

```bash
helm template t examples/helm/tasklane > rendered/all.yaml
kubectl kustomize rendered-overlay | kubectl apply -f -
```

The crudest combination and occasionally the right one: render once, commit the
output, review it as a diff. It is honest about what will be applied, and it
throws away everything Helm knows about releases.

### 3. Helm post-renderer plugins

Keep the Helm lifecycle and post-process the manifests on their way out:

```bash
helm upgrade --install t examples/helm/tasklane -n tasklane-prod --post-renderer kustomize-renderer
```

In Helm 4 a post-renderer is a **plugin**, not an executable path: you install
it with `helm plugin install` and name it with `--post-renderer`, passing
arguments through `--post-renderer-args`. This is the only combination that
keeps `helm rollback` working, because Helm still owns the release. The cost is
that the release record no longer matches the chart, so what a reviewer reads
in the chart is not what ran.

### 4. GitOps as the outer layer

Argo CD Applications and Flux `HelmRelease`/`Kustomization` objects both take a
chart or a kustomization path and reconcile it continuously. This is the
combination most production clusters converge on, and it makes the Helm versus
Kustomize question local: one repository can hold both.

## Production considerations

- **Pick one per application, not per company.** A platform that installs
  third-party charts with Helm and its own services with Kustomize is normal
  and fine. A single service rendered by both is a maintenance trap.
- **Whatever you choose, render and validate in CI.** `helm template` or
  `kubectl kustomize`, then `kubeconform -strict -kubernetes-version 1.37.0`,
  then a policy check, then a server dry run.
- **Version what you ship.** Chart versions for Helm, git tags for Kustomize.
  "Whatever is on main" is not a deployable artefact.
- **Expect the `helmCharts` generator to be slower.** It forks `helm` for every
  chart on every render, which shows up in a GitOps controller that renders
  frequently.
- **Do not convert a working chart to Kustomize (or back) without a reason.**
  The conversion is mechanical but the review burden is real, and both
  directions lose something.

## Security considerations

**Threat: values that carry secrets.** Helm stores the merged values in the
release record, so a password passed with `--set` is readable by anyone with
`get secret` in that namespace. Kustomize has the mirror-image problem:
`secretGenerator` puts the value in git, where it lives in history forever.

*Fix:* neither tool should hold the secret. Reference an existing Secret from
the chart (`database.existingSecret`) and create it with the External Secrets
Operator (`external-secrets.io/v1`) or Sealed Secrets.
*Verify:* `helm get manifest <release> | grep -i password` and
`kubectl kustomize overlays/prod | grep -c 'kind: Secret'` should both be
empty, and `git log -p` should show no credentials.

**Threat: untrusted input to either renderer.** A chart is code and a remote
base is code. Pin chart versions (ideally OCI digests), verify provenance with
`helm install --verify`, pin every remote `resources:` URL with `?ref=`, and
read the rendered RBAC and pod security fields before installing anything you
did not write.

**Ownership confusion.** Mixing tools on the same objects is a real risk: Helm
refuses to adopt objects it did not create, and `--take-ownership` makes a
later `helm uninstall` delete objects that some other process created. Keep one
owner per object, and let server-side apply field ownership tell you when two
writers disagree.

## Troubleshooting

**`kubectl kustomize` fails with `must specify --enable-helm`.** The
`helmCharts` generator is off by default. Add `--enable-helm`, and make sure a
`helm` binary is on PATH (or point at one with `--helm-command`).

**`security; file ... is not in or below ...` when inflating a chart.** The
chart lives outside the kustomization root. Vendor it underneath, or render
with `--load-restrictor=LoadRestrictionsNone`.

**`helm list` shows nothing after a kustomize build.** Expected: the
`helmCharts` generator only renders. There is no release, so there is nothing
to list, test or roll back.

**A hook Job runs at the wrong time, or not at all.** Hook annotations mean
nothing outside Helm. Rendered through Kustomize, a `pre-install` Job is just a
Job that gets applied with everything else.

**`Error: unknown flag` or "executable not found" from `--post-renderer`.**
Helm 4 expects a plugin name. Install the post-renderer with
`helm plugin install` first.

**Objects flip back and forth.** Two owners are writing the same fields — for
example a Helm release and a kustomization in a GitOps controller. Check
`.metadata.managedFields` to see which manager set each field.

## Common mistakes

- Treating the choice as ideological. The deciding question is who installs it.
- Expecting either tool to prune. Removing a file from git removes nothing from
  the cluster.
- Using the `helmCharts` generator and then wondering why `helm list` is empty.
- Carrying a Helm 3 habit of passing a script to `--post-renderer`; Helm 4 takes
  a plugin name.
- Converting a third-party chart to Kustomize by rendering it once, then losing
  the ability to upgrade it.
- Letting both tools write the same objects, then debugging which one reverted
  the change.

## Related topics

- [Helm](helm.md)
- [Chart development](helm-chart-development.md)
- [Kustomize](kustomize.md)
- [GitOps with Argo CD](gitops-argo-cd.md)
- [GitOps with Flux](gitops-flux.md)
- [CI/CD for Kubernetes](cicd-for-kubernetes.md)
- [Secrets management](../k8s-security/secrets-management.md)
