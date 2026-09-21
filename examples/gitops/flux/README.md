# Flux manifests for Tasklane

- `gitrepository.yaml` — the shared `GitRepository` source, sparse-checked-out.
- `kustomizations.yaml` — one `Kustomization` per overlay, with `dependsOn` and `healthChecks`.
- `helmrelease-git.yaml` — `HelmRelease` taking `examples/helm/tasklane` from the Git source.
- `helmrelease-oci.yaml` — `OCIRepository` + `HelmRelease` using `chartRef`, for a chart published to a registry.

Apply the source before anything that references it. Written against Flux v2.9.5.
See `../README.md` for how to choose between Argo CD and Flux, and
`content/k8s-advanced/gitops-flux.md` for the explanation.
