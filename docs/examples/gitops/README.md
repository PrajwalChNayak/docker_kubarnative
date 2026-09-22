# GitOps manifests for Tasklane

Both directories deploy **the same thing**: the Kustomize overlays at
`examples/kustomize/overlays/{dev,staging,prod}` and the Helm chart at
`examples/helm/tasklane`, from
`https://github.com/PrajwalChNayak/docker_kubarnative`, branch `main`.

Pick one. Running Argo CD and Flux against the same objects gives you two
controllers fighting over field ownership.

| File | What it is |
|---|---|
| `argocd/appproject.yaml` | AppProject `tasklane`: source, destination and kind allow-lists, a CI role, a weekend deny window |
| `argocd/application-staging.yaml` | A single Application for the staging overlay, with automated prune + selfHeal |
| `argocd/applicationset.yaml` | An ApplicationSet with a list generator that renders the same Application for dev, staging and prod |
| `flux/gitrepository.yaml` | GitRepository source, sparse-checked-out to the two directories Flux needs |
| `flux/kustomizations.yaml` | Three Flux Kustomizations, one per overlay, with `dependsOn`, `healthChecks` and `prune` |
| `flux/helmrelease-git.yaml` | HelmRelease taking the chart from the Git source via `chart.spec.sourceRef` |
| `flux/helmrelease-oci.yaml` | OCIRepository + HelmRelease taking the chart via `chartRef`, the shape to use once CI pushes the chart |

Nothing here is applied by the lab: neither Argo CD nor Flux is installed on
the kind cluster. The manifests are validated with kubeconform against the
upstream CRD schemas.

## Choosing between Argo CD and Flux

Both are CNCF **graduated**, both pull rather than receive pushes, both
reconcile continuously and correct drift. The differences that actually
change a decision:

| | Argo CD 3.5 | Flux 2.9 |
|---|---|---|
| Unit of deployment | `Application` (one source → one destination) | one custom resource per concern: `GitRepository`, `Kustomization`, `HelmRelease` |
| UI | First-class web UI, resource tree, diffs, manual sync, rollback | None in the project. Use `flux` CLI, `kubectl`, or a third-party dashboard |
| Multi-tenancy model | `AppProject` + Argo CD's own RBAC layer, on top of Kubernetes RBAC | Kubernetes RBAC only, via `spec.serviceAccountName` impersonation per Kustomization |
| Helm | Renders with `helm template`; the release is not tracked by Helm | Real Helm releases, with `helm rollback` semantics, drift detection and test hooks |
| Secrets | Bring your own (Sealed Secrets, ESO, a plugin) | SOPS decryption built into the kustomize-controller |
| Image updates | Argo CD Image Updater, a separate argoproj-labs component | image-reflector-controller + image-automation-controller, part of Flux |
| Footprint | api-server, repo-server, application-controller, applicationset-controller, Redis, optional Dex and notifications controller | source-, kustomize-, helm- and notification-controllers, no database |
| Fits best | Many teams sharing one Argo CD, developers who want to see and click | Platform teams, fleets of clusters, everything expressed as Kubernetes objects |

Rules of thumb:

- Want a dashboard your developers will open, and per-team projects inside
  one installation? **Argo CD.**
- Want your delivery system to be nothing but controllers and CRs, with SOPS
  and image automation included, and no extra RBAC model to learn? **Flux.**
- Running real Helm releases that other people upgrade with `helm` too?
  **Flux**, because it keeps genuine Helm release state.
- Fewer than about five services on one cluster? Neither, yet. A CI job that
  runs `kubectl apply -k` is less machinery, and the honest answer until
  drift and multi-cluster promotion actually hurt.

## Related pages

- `content/k8s-advanced/gitops-argo-cd.md`
- `content/k8s-advanced/gitops-flux.md`
- `content/k8s-advanced/cicd-for-kubernetes.md`
