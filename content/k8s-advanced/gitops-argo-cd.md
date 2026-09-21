---
title: GitOps with Argo CD
description: How Argo CD turns a Git repository into the source of truth for a cluster, and how to structure Applications, projects and sync policies for Tasklane.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37, Argo CD 3.5
prerequisites:
  - k8s-advanced/kustomize
  - k8s-beginner/declarative-model-and-reconciliation
---

## Overview

Argo CD is a Kubernetes controller that reads manifests from Git, compares
them with what is actually running, and either reports the difference or
fixes it. You stop running `kubectl apply` against production; you merge a
pull request, and a controller inside the cluster pulls the change.

The unit of work is the `Application` custom resource: one source (a
repository, a revision and a path) and one destination (a cluster and a
namespace). Everything else in Argo CD — projects, ApplicationSets, sync
waves, health checks — exists to manage Applications at scale.

This page uses Argo CD **v3.5.3** against Kubernetes 1.37, deploying the
Tasklane Kustomize overlays from
[`examples/gitops/argocd/`](../../examples/gitops/argocd/application-staging.yaml).

## Why it exists and when to use it

A CI pipeline that ends in `kubectl apply` has three structural problems.
It needs cluster-admin credentials in the CI system, which makes the CI
system the most valuable target in your estate. It only knows about the
cluster at the moment it runs, so anything changed between pipelines is
invisible. And "what is deployed" is answered by reading job logs rather
than by reading a repository.

Argo CD inverts the direction. The controller runs *inside* the target
cluster and pulls. CI never needs a kubeconfig: it builds an image and
opens a pull request against a manifest directory. The cluster's state is a
function of a Git revision, continuously, not just at deploy time.

That continuity is the real payoff. With `selfHeal: true`, someone editing a
Deployment with `kubectl edit` at 03:00 gets their change reverted within a
few minutes, and the incident review has a commit history to read.

Argo CD is the wrong choice when you have one small service and one cluster.
Two controllers, a repo-server, a Redis and an RBAC model of its own is a lot
of machinery to replace `kubectl apply -k`. It is also the wrong choice if
your team is not prepared to stop making manual changes: `selfHeal` reverting
an emergency fix at the worst moment is a genuine operational hazard, and the
answer is a cultural change, not turning `selfHeal` off.

## How it works underneath

Argo CD is not one process. A full installation runs:

| Component | Responsibility |
|---|---|
| `argocd-application-controller` | The reconciler. Compares desired and live state, runs syncs, evaluates health |
| `argocd-repo-server` | Clones repositories and renders manifests (`kustomize build`, `helm template`, plugins). Holds no cluster credentials |
| `argocd-server` | The gRPC/REST API behind the web UI and the `argocd` CLI. Enforces Argo CD's own RBAC and receives Git webhooks |
| `argocd-applicationset-controller` | Expands `ApplicationSet` objects into Applications |
| `argocd-redis` | Cache for rendered manifests and live-state; ephemeral, not a database |
| `argocd-dex-server` | Optional. Bridges external OIDC/SAML identity providers |
| `argocd-notifications-controller` | Optional. Sends Slack, webhook and email events on state changes |

A reconciliation runs roughly like this. The application-controller decides
an Application needs refreshing, either on the timer or because a webhook
arrived. It asks the repo-server for the manifests at the target revision;
the repo-server clones or reuses its cache, runs Kustomize or Helm, and
returns rendered YAML. The controller diffs that against the live objects it
has in its cluster cache, which is kept up to date by watches rather than
polling. The diff produces a **sync status** of `Synced` or `OutOfSync`. If
the sync policy is automated, the controller then applies the difference,
ordered by sync wave, running hooks between phases. Separately it evaluates
**health** for each object and rolls that up to the Application.

Sync status and health are independent. An Application can be `Synced` and
`Degraded` — Git is faithfully deployed and the pods are crash-looping — or
`OutOfSync` and `Healthy`.

The default refresh interval is roughly three minutes: 120 seconds plus up to
60 seconds of jitter, controlled by `timeout.reconciliation` in the
`argocd-cm` ConfigMap. Setting it to `0` disables polling entirely, which
only makes sense when you have reliable webhooks. The live-state side is not
polled at all, so drift is usually noticed within seconds of the watch event.

### Sync waves and hooks

Within one sync, objects are grouped into **waves** by the annotation
`argocd.argoproj.io/sync-wave`, an integer that may be negative. Argo CD
applies the lowest wave first and waits for those objects to become healthy
before starting the next. That is how a CRD gets installed before the custom
resource that uses it.

**Hooks** are objects annotated with `argocd.argoproj.io/hook`, usually
Jobs. The phases are `PreSync`, `Sync`, `PostSync`, `SyncFail`, `PreDelete`,
`PostDelete`, plus `Skip` which tells Argo CD not to apply the manifest at
all. A `PreSync` Job is the canonical place for a database migration.
`argocd.argoproj.io/hook-delete-policy` takes `HookSucceeded`,
`HookFailed` or `BeforeHookCreation` and decides when the hook object is
cleaned up.

### Health checks

Argo CD ships health assessments for the common kinds: Deployment,
ReplicaSet, StatefulSet and DaemonSet compare observed generation and replica
counts, PersistentVolumeClaim checks for `Bound`, Job and CronJob look at
completion. The statuses are `Healthy`, `Progressing`, `Degraded`,
`Suspended`, `Missing` and `Unknown`. For a CRD Argo CD knows nothing about,
you write a Lua script under
`resource.customizations.health.<group>_<kind>` in `argocd-cm`; it receives
the object as `obj` and returns a status and a message.

## Basic example

```yaml include="examples/gitops/argocd/application-staging.yaml"
```

The project it belongs to:

```yaml include="examples/gitops/argocd/appproject.yaml"
```

## Explanation

`syncPolicy.automated` has four fields and three of them default to the
cautious value. `enabled` defaults to true, but `prune` and `selfHeal` both
default to **false**, so an "automated" policy without them applies new
objects and ignores both deletions and drift — which is not what most people
think they configured. `allowEmpty: false` is the safety catch: if a broken
Kustomize build renders zero objects, Argo CD refuses to prune everything.

`ServerSideApply=true` makes Argo CD apply with
`kubectl apply --server-side --force-conflicts`. Field ownership then lives
in the API server's `managedFields` instead of the
`kubectl.kubernetes.io/last-applied-configuration` annotation. That matters
for large CRDs, which can exceed the 262,144-byte annotation limit, and for
any object several controllers write to.

`PrunePropagationPolicy=foreground` makes deletions wait for dependents;
`PruneLast=true` defers all pruning to the end of the sync, so a new object
is in place before the old one is removed.

`ignoreDifferences` on `/spec/replicas` is not optional once a
[HorizontalPodAutoscaler](horizontal-pod-autoscaler.md) is involved. Git says
2 replicas, the HPA scales to 6, `selfHeal` scales back to 2, the HPA scales
up again: a loop that burns API calls and confuses everyone reading events.

Note what the Application does **not** say. There is no
`CreateNamespace=true`, because the overlay ships its own `Namespace` object
carrying the Pod Security Admission labels. A namespace conjured by
`CreateNamespace=true` has no PSA labels at all and silently admits
privileged pods.

:::best-practice Put the namespace in Git
Whenever a namespace needs labels — Pod Security Admission, Istio injection,
a network-policy selector, cost allocation — create it from a manifest.
`CreateNamespace=true` and `managedNamespaceMetadata` exist, but a namespace
that is part of the overlay is reviewed in the same pull request as the
workload it isolates.
:::

## Common patterns

### App-of-apps

One Application whose source directory contains other Application manifests.
Bootstrapping the cluster is then a single `kubectl apply` of the root
Application, and everything else follows.

```yaml title="root-application.yaml" fragment
spec:
  source:
    repoURL: https://github.com/PrajwalChNayak/docker_kubarnative
    targetRevision: main
    path: clusters/lab/apps
    directory:
      recurse: true
```

It works, and it is still the simplest way to bootstrap. Its weakness is
that the child Applications are ordinary objects: deleting one from Git
prunes it only if the root Application has `prune: true`, and there is no
templating, so twelve environments means twelve nearly identical files.

### ApplicationSets

An `ApplicationSet` generates Applications from parameters and owns their
lifecycle: remove an element, the Application goes with it.

```yaml include="examples/gitops/argocd/applicationset.yaml"
```

The generators worth knowing:

| Generator | Parameters come from |
|---|---|
| `list` | Literal elements in the manifest. Explicit, reviewed, best for a fixed set of environments |
| `git` (directories) | Directory names under a path in a repository. Adding a directory adds an environment |
| `git` (files) | Config files discovered in a repository, parsed into parameters |
| `cluster` | Clusters registered in Argo CD, filtered by label. The usual way to fan out across a fleet |
| `matrix` / `merge` | Combine two generators, for example every environment on every cluster |
| `scmProvider` / `pullRequest` | Repositories or open PRs in GitHub/GitLab. The basis of per-PR preview environments |

`goTemplate: true` with `goTemplateOptions: ["missingkey=error"]` is worth
setting on every ApplicationSet. Without it a misspelled parameter renders as
an empty string, and an Application with an empty `path` deploys the whole
repository.

### AppProjects as the tenancy boundary

An `AppProject` restricts which repositories an Application may read, which
cluster and namespaces it may write, and which kinds it may create. It also
carries project-scoped roles whose tokens can sync a named Application and
nothing else, and sync windows that block automated syncs on a schedule.
Give every team a project, and never leave applications in `default`, which
permits everything.

## Production considerations

**High availability.** Argo CD ships an HA installation with a Redis
HAProxy cluster and multiple replicas of the API and repo servers. The
application-controller shards by cluster; with many clusters, raise the
replica count and set `ARGOCD_CONTROLLER_REPLICAS` so sharding is applied.

**Repo-server is the usual bottleneck.** It forks a `kustomize` or `helm`
process per render. Watch its CPU and memory before anything else, and raise
`reposerver.parallelism.limit` deliberately rather than by accident.

**Webhooks over polling.** Configure a Git webhook to `argocd-server`. It
turns a three-minute delay into a second, and removes most of the repo-server
load. Keep the timer as a fallback; do not set `timeout.reconciliation: 0`
unless you are confident in webhook delivery.

**Number of Applications.** Splitting a monolithic Application into one per
component gives finer sync status, faster diffs and blast-radius control. It
also multiplies the object count the controller watches. A few hundred
Applications per instance is unremarkable; tens of thousands needs planning.

**Disaster recovery.** Argo CD's own state is in Kubernetes objects and Git,
except for repository credentials, cluster secrets and Dex configuration,
which are Secrets in the `argocd` namespace. Back those up, or you can
rebuild a cluster and not be able to connect it to anything.

**Cost.** A realistic HA installation is on the order of 2–4 CPU and 4–8 GiB
of memory before it manages anything. That is cheap next to an outage caused
by undetected drift, and expensive next to `kubectl apply -k` for three
services.

## Security considerations

**Threat: CI holds cluster-admin.** A compromised pipeline, or a malicious
pull request that edits the pipeline definition, becomes cluster-admin on
production.

*Exploit:* a PR adds a step to an existing workflow that runs
`kubectl create clusterrolebinding` using the credentials already in the CI
environment.

*Fix:* with Argo CD, CI has no kubeconfig at all. It pushes an image and
opens a PR against the manifest repository. The only identity that can write
to the cluster is the application-controller's ServiceAccount, which lives
in the cluster and cannot be read from CI.

*Verify:* search the CI configuration for kubeconfig secrets and remove
them; then confirm a deploy still works end to end.

**Threat: an Application points somewhere it should not.** `Application` is
just a custom resource. Anyone who can create one in the `argocd` namespace
can name any repository and any destination namespace.

*Exploit:* a PR changes `spec.source.repoURL` to an attacker-controlled fork
containing a DaemonSet that mounts the host filesystem, or changes
`destination.namespace` to `kube-system`.

*Fix:* an `AppProject` with an explicit `sourceRepos` list, a
`destinations` list, and a `clusterResourceWhitelist` that permits only what
the team genuinely creates. Combine it with `sourceIntegrity` GPG policies
if you require signed commits. Separately, restrict who can write
Applications: Kubernetes RBAC on the `argocd` namespace, plus Argo CD's own
RBAC in `argocd-rbac-cm`.

*Verify:* change a test Application's `repoURL` to an unlisted repository
and confirm the sync fails with a project violation, rather than deploying.

**Threat: secrets in Git.** Manifests in a repository are readable by
everyone with repository access, forever, including in the history.

*Fix:* never commit a plain `Secret`. Encrypt with Sealed Secrets
(`bitnami.com/v1alpha1`, v0.40.0), where only the controller's private key
can decrypt and the `SealedSecret` is safe to commit; or keep the value in an
external store and pull it in with the External Secrets Operator (v2.11.0,
`external-secrets.io/v1`). Argo CD has no native decryption of its own — that
is a real difference from [Flux](gitops-flux.md).

*Verify:* run a secret scanner over the repository in CI and fail the build
on a match.

**Threat: the UI is on the internet.** `argocd-server` with
`--insecure` behind a permissive route, or the `admin` account left enabled
with a shared password, is a full cluster takeover.

*Fix:* disable the local `admin` account once SSO works, put the server
behind TLS, and write `argocd-rbac-cm` policies that grant `sync` and
`get` per project rather than `role:admin` to everyone.

## Troubleshooting

**`OutOfSync` that never clears.** Something in the cluster mutates the
object after Argo CD applies it: a defaulting webhook, an autoscaler, a
service mesh injector. Look at the diff in the UI or with
`argocd app diff <app>`, then add a targeted `ignoreDifferences`. The
`managedFieldsManagers` form is the precise tool when server-side apply is
enabled, because it ignores whatever a named controller owns rather than a
fixed path.

**`ComparisonError`.** The repo-server could not render. Usually a Kustomize
error, a missing Helm dependency, or credentials. Reproduce locally:

```bash
kubectl kustomize examples/kustomize/overlays/staging
```

**Stuck `Progressing`.** Health, not sync. A Deployment whose pods never
become ready leaves the Application `Progressing` forever. Look at the pods,
not at Argo CD.

**Application deleted, workloads still running.** The
`resources-finalizer.argocd.argoproj.io` finalizer was missing. Without it,
deleting the Application removes only the Application.

**Sync succeeded, nothing changed.** Check for `argocd.argoproj.io/hook:
Skip` annotations, an empty render, or `ApplyOutOfSyncOnly=true` combined
with a stale cache. `argocd app get <app> --refresh` forces a fresh render.

## Common mistakes

- Setting `automated: {}` and assuming prune and selfHeal are on. They
  default to false.
- Using `CreateNamespace=true` for a namespace that needs Pod Security
  Admission labels, then wondering why a restricted pod was admitted.
- Letting `selfHeal` fight an HPA because `/spec/replicas` is not in
  `ignoreDifferences`.
- Leaving every Application in the `default` project, which allows any
  repository, any cluster and any kind.
- Committing plain `Secret` objects because "the repository is private".
- Putting an Application's manifests and the application source code in the
  same repository and tracking `HEAD`: every code commit re-renders and
  re-syncs, and you lose the ability to roll back manifests independently.
- Pointing several Applications at overlapping paths, so two Applications
  claim the same object and each prunes what the other applies.
- Turning off `selfHeal` after the first time it reverted a manual fix,
  instead of fixing the process that required a manual fix.

## Related topics

- [GitOps with Flux](gitops-flux.md)
- [CI/CD for Kubernetes](cicd-for-kubernetes.md)
- [Kustomize](kustomize.md)
- [Helm](helm.md)
- [Progressive delivery](progressive-delivery.md)
- [Multi-tenancy](multi-tenancy.md)
- [RBAC](../k8s-security/rbac.md)
- [Secrets management](../k8s-security/secrets-management.md)
- [Declarative model and reconciliation](../k8s-beginner/declarative-model-and-reconciliation.md)
