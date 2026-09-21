---
title: GitOps with Flux
description: How Flux's controllers turn Git, OCI and Helm sources into reconciled cluster state, and how to wire sources, Kustomizations and HelmReleases for Tasklane.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37, Flux 2.9
prerequisites:
  - k8s-advanced/kustomize
  - k8s-advanced/helm
---

## Overview

Flux is a set of small Kubernetes controllers, collectively the GitOps
Toolkit, that fetch manifests from a source and reconcile them into a
cluster. Where [Argo CD](gitops-argo-cd.md) gives you one `Application`
object and a web UI, Flux gives you a handful of narrow custom resources —
`GitRepository`, `OCIRepository`, `Kustomization`, `HelmRelease` — and
nothing else. Everything you do with Flux, you do with `kubectl` or the
`flux` CLI against those objects.

This page uses Flux **v2.9.5** on Kubernetes 1.37, deploying the Tasklane
Kustomize overlays and the Tasklane Helm chart from
[`examples/gitops/flux/`](../../examples/gitops/flux/gitrepository.yaml).

## Why it exists and when to use it

The design idea is separation of concerns. Fetching an artefact is one
problem; templating it is another; applying it and watching it become
healthy is a third. Flux gives each to a different controller with its own
custom resource, its own RBAC and its own status conditions. When something
fails you know which controller failed, because the failure is a condition
on a specific object.

That shape suits platform teams. A source is a shared object a platform team
owns; twenty `Kustomization` objects in twenty tenant namespaces can read
from it, each impersonating its own ServiceAccount, and Kubernetes RBAC is
the only authorisation model involved. There is no second RBAC system to
learn or to keep in sync.

Flux also does two things Argo CD does not do natively. It decrypts
SOPS-encrypted files in the kustomize-controller, so encrypted Secrets can
live in Git without an extra operator. And it ships image automation: the
image-reflector-controller watches a registry, the
image-automation-controller commits the new tag back to Git.

Choose Flux when you want delivery expressed entirely as Kubernetes objects,
when you manage many clusters from a platform team, or when SOPS and image
automation matter. Choose Argo CD when a visible dashboard and per-team
projects matter more. Choose neither for a single small service: a CI job
running `kubectl apply -k` is honest and much less machinery.

## How it works underneath

| Controller | Custom resources | Job |
|---|---|---|
| source-controller | `GitRepository`, `OCIRepository`, `HelmRepository`, `HelmChart`, `Bucket` | Fetch, verify and store artefacts. The only controller that talks to the outside world |
| kustomize-controller | `Kustomization` | Build with Kustomize, decrypt SOPS, server-side apply, health-check, garbage-collect |
| helm-controller | `HelmRelease` | Perform real Helm installs, upgrades, rollbacks and tests |
| notification-controller | `Provider`, `Alert`, `Receiver` | Outbound events to Slack and friends; inbound webhooks that trigger reconciliation |
| image-reflector-controller | `ImageRepository`, `ImagePolicy` | Scan registry tags, pick the tag a policy selects |
| image-automation-controller | `ImageUpdateAutomation` | Write the selected tag back into Git and push |

The flow for a Kustomization is: the source-controller clones the repository
on its `interval`, packages the checkout as a tarball in its own storage, and
publishes the commit SHA in `.status.artifact.revision`. The
kustomize-controller notices the revision changed, downloads the artefact
over the cluster network, runs `kustomize build`, decrypts anything SOPS
protected, and applies the result server-side using a field manager of its
own. Then it waits on health, and finally reconciles its inventory: objects
it previously applied that are no longer in the build are deleted, provided
`prune: true`.

Two independent clocks matter. The source `interval` decides how quickly a
new commit is noticed. The Kustomization `interval` decides how often the
apply is repeated even when nothing changed — which is what corrects drift.
Minimum interval is 60 seconds.

Reconciliation is **pull-based**: no credential for the cluster exists
outside the cluster. A `Receiver` plus a Git webhook can trigger an immediate
reconciliation, but that webhook only says "look now"; it carries no
manifests and grants no access.

### Drift detection and correction

Because the kustomize-controller re-applies on every interval with
server-side apply, a manual `kubectl edit` to a field Flux owns is reverted
at the next tick. Fields Flux does not own — an HPA's `replicas`, a mutating
webhook's injection — are left alone, which is usually what you want.

The helm-controller behaves differently by default: Helm only acts when the
chart or values change. Setting `driftDetection.mode: enabled` on a
`HelmRelease` makes it compare the cluster against the last release manifest
and correct differences. `mode: warn` reports them without acting.

## Basic example

A source, shared by every environment:

```yaml include="examples/gitops/flux/gitrepository.yaml"
```

Three Kustomizations reading it:

```yaml include="examples/gitops/flux/kustomizations.yaml"
```

A `HelmRelease` for the Tasklane chart in the same repository:

```yaml include="examples/gitops/flux/helmrelease-git.yaml"
```

## Explanation

`sparseCheckout` limits the clone to the directories Flux needs. Without it
every commit anywhere in the repository — documentation, Go source — produces
a new artefact revision and re-triggers every downstream Kustomization.

`prune: true` is what makes deletion work. It is off by default, and a Flux
installation without it accumulates objects that were removed from Git
months ago. The controller tracks an inventory in the `Kustomization` status,
so pruning is bounded by what this object created; it cannot delete something
it never applied.

`wait: true` runs health checks against every object in the build.
`healthChecks` names specific objects instead, which is cheaper on a large
overlay and documents what "this environment is up" actually means. You want
one or the other whenever something downstream uses `dependsOn`, because
`dependsOn` waits for the dependency to be **Ready**, and without health
checks Ready means only "applied without error".

`dependsOn` orders reconciliation. It is not a promotion gate. In the
example, `tasklane-prod` will not reconcile while `tasklane-staging` is
failing, but prod still tracks whatever is in `overlays/prod` on `main`.
Promotion is a Git operation — see
[CI/CD for Kubernetes](cicd-for-kubernetes.md).

For the `HelmRelease`, `chart.spec.chart` is a path from the repository root
when the source is a `GitRepository`. `reconcileStrategy: Revision` tells the
source-controller to rebuild the chart whenever the commit changes; the
default, `ChartVersion`, only reacts to a version bump in `Chart.yaml`, which
silently ignores template edits.

`install.createNamespace: true` is convenient and slightly dangerous: the
namespace it creates carries no labels, so no Pod Security Admission profile
applies to it. For anything real, ship the `Namespace` from Git through a
Kustomization and leave `createNamespace` false.

:::warning A HelmRelease is a real Helm release
Flux runs Helm itself and stores release state in Secrets in
`storageNamespace`. `helm list -n flux-system` sees Flux's releases, and a
human running `helm upgrade` on one will be fought by the helm-controller.
Argo CD renders with `helm template` and creates no release at all, so the
two tools behave differently after `helm rollback`.
:::

## Common patterns

### OCI artefacts instead of Git

Flux can treat an OCI registry as the source. CI builds the manifests, runs
`flux push artifact` (or `helm push` for a chart), and the cluster pulls a
digest-pinned artefact. `OCIRepository` (`source.toolkit.fluxcd.io/v1`)
supports cosign or Notation verification, so the cluster can refuse anything
unsigned.

```yaml include="examples/gitops/flux/helmrelease-oci.yaml"
```

This removes the cluster's dependency on Git availability and gives you an
immutable, signed, versioned deployment artefact. It costs you the ability to
read the live desired state as plain files in a browser.

### Image automation

`ImageRepository` scans a registry; `ImagePolicy` picks a tag by semver,
numerical order or a regex filter; `ImageUpdateAutomation` rewrites the
manifest and pushes a commit. All three are `image.toolkit.fluxcd.io/v1`.
The marker in the manifest looks like:

```yaml title="deployment-with-image-marker.yaml" fragment
spec:
  template:
    spec:
      containers:
        - name: api
          image: tasklane-api:0.1.0 # {"$imagepolicy": "flux-system:tasklane-api"}
```

Push the commit to a branch and require a pull request if you want a human in
the loop; push straight to the tracked branch if you do not. Automation that
commits to `main` unreviewed is fine for dev and a poor idea for prod.

### SOPS

`spec.decryption.provider: sops` with a `secretRef` lets the
kustomize-controller decrypt files encrypted with age, GPG or a cloud KMS.
The convention is a Secret named `sops-age` holding a key file whose name
ends in `.agekey`, or `sops-gpg` holding `sops.asc`. Only the values are
encrypted, so a diff of an encrypted Secret still shows which keys changed.
This is a genuine advantage over Argo CD, which needs Sealed Secrets, the
External Secrets Operator or a config-management plugin for the same job.

### Multi-tenancy by impersonation

Set `spec.serviceAccountName` on a `Kustomization` and the controller
impersonates that ServiceAccount for every apply. A tenant's Kustomization
then has exactly the permissions of the tenant's ServiceAccount, enforced by
the API server rather than by Flux. Combine it with
[tenant namespaces](multi-tenancy.md) and the platform never has to trust the
tenant's manifests.

## Production considerations

**Intervals cost money.** Every `interval` on every object is a clone, an
artefact download and a server-side apply. A hundred Kustomizations at `1m`
is a very different load from a hundred at `10m`. Use short intervals on
sources plus webhooks, and longer intervals on Kustomizations, whose job is
drift correction rather than change detection.

**Controller resources.** The source-controller holds artefacts on disk and
needs a PersistentVolume or a generous `emptyDir` in a real installation.
The kustomize-controller's memory scales with the size of the largest build.

**`flux` CLI is not the source of truth.** `flux bootstrap` writes manifests
into your repository and then those manifests manage Flux itself. Treat
Flux's own installation as just another Kustomization; upgrading is a commit.

**Observability.** Every object carries standard conditions (`Ready`,
`Reconciling`, `Stalled`) and Flux exports Prometheus metrics for them.
Alert on `Ready=False` for longer than one interval — not on individual
reconciliation errors, which are frequently transient.

**No UI.** Plan for it. `flux get all -A` and `flux logs` cover operations;
if developers need to see deployment state, budget for a dashboard or accept
that they will ask you.

## Security considerations

**Threat: a tenant's Kustomization applies cluster-admin objects.** The
kustomize-controller's own ServiceAccount is powerful; by default a
`Kustomization` applies with those rights, so any manifest a tenant can get
into a watched path runs with them.

*Exploit:* a tenant commits a `ClusterRoleBinding` granting their
ServiceAccount `cluster-admin`; the controller applies it faithfully.

*Fix:* set `spec.serviceAccountName` on every tenant Kustomization and give
that ServiceAccount a namespaced Role. The apply is then authorised as the
tenant. Run the multi-tenancy lockdown Flux documents, which disables
cross-namespace source references.

*Verify:* commit a `ClusterRoleBinding` into a tenant path and confirm the
Kustomization goes `Ready=False` with a forbidden error.

**Threat: unsigned artefacts.** If the cluster pulls whatever is at a tag,
anyone who can push to that tag can deploy.

*Fix:* pin `OCIRepository` to a digest or a semver range plus
`spec.verify` with cosign, and sign in CI with cosign v3.1.3. For Git, use
`spec.verify` with GPG-signed tags.

*Verify:* push an unsigned artefact and confirm the source goes
`Ready=False` rather than reconciling.

**Threat: secrets in Git.** Same threat as anywhere else; Flux's answer is
SOPS. The decryption key lives in the cluster as a Secret, so protect it with
RBAC — anyone who can read the `sops-age` Secret can decrypt the entire
repository, including its history.

*Verify:* `kubectl auth can-i get secret/sops-age -n flux-system --as=...`
for each non-platform identity, and expect `no`.

**Threat: a stale Receiver token.** A `Receiver` exposes an HTTP endpoint
that triggers reconciliation. The token in its Secret is the only
authentication. Rotate it, and remember that a triggered reconciliation only
re-reads the source — it cannot inject manifests.

## Troubleshooting

```bash
flux get sources git -A
flux get kustomizations -A
flux get helmreleases -A
flux logs --level=error --all-namespaces
```

**Source `Ready=False`, "failed to checkout".** Credentials, a wrong branch
name, or a host-key mismatch for SSH. The condition message names the cause.

**Kustomization `Ready=False`, "dry-run failed".** The build produced
something the API server rejects: a removed API version, a missing CRD, an
invalid field. Reproduce with `flux build kustomization <name> --path ./...`
or locally with `kubectl kustomize`.

**Kustomization stuck `Reconciling`.** Health checks never pass. Look at the
object the health check names, not at Flux.

**HelmRelease `install retries exhausted`.** Helm failed and remediation gave
up. `kubectl describe helmrelease` shows the Helm error; after fixing it,
`flux reconcile helmrelease <name> --force` resets the retry counter.

**Objects not deleted after removal from Git.** `prune` is false, or the
object was adopted rather than created by this Kustomization and is not in
its inventory.

**Everything reconciles constantly.** Something in the build is
non-deterministic — a generated name, a timestamp, a `configMapGenerator`
hash that changes on every build — or two Kustomizations own the same object
and fight over it.

## Common mistakes

- Leaving `prune: false` and discovering months of orphaned objects.
- Using `dependsOn` without `wait` or `healthChecks`, so "Ready" means only
  "applied" and the ordering guarantees nothing.
- Setting every `interval` to `1m` and then wondering why the
  source-controller is the busiest pod in the cluster.
- Two Kustomizations whose paths overlap, each pruning the other's objects.
- `chart.spec.reconcileStrategy` left at `ChartVersion` for a chart in Git,
  so template edits are never picked up.
- `install.createNamespace: true` for a namespace that needs Pod Security
  Admission labels.
- Pointing a `Kustomization` at a directory with no `kustomization.yaml` and
  assuming it will fail. It will not: Flux builds plain manifests from the
  directory, including any file you did not mean to deploy.
- Treating `flux bootstrap` as a one-off command rather than as the
  generator of manifests you now own and review.

## Related topics

- [GitOps with Argo CD](gitops-argo-cd.md)
- [CI/CD for Kubernetes](cicd-for-kubernetes.md)
- [Helm](helm.md)
- [Helm chart development](helm-chart-development.md)
- [Kustomize](kustomize.md)
- [Multi-tenancy](multi-tenancy.md)
- [Secrets management](../k8s-security/secrets-management.md)
- [Supply chain admission](../k8s-security/supply-chain-admission.md)
