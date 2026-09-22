# Argo CD manifests for Tasklane

- `appproject.yaml` — the `AppProject` tenancy boundary every Application below belongs to.
- `application-staging.yaml` — a single `Application` for `examples/kustomize/overlays/staging`.
- `applicationset.yaml` — the same Application generated for dev, staging and prod from a list generator.

Apply the AppProject first; an Application referencing a missing project does not sync.
Written against Argo CD v3.5.3. See `../README.md` for how to choose between Argo CD and Flux,
and `content/k8s-advanced/gitops-argo-cd.md` for the explanation.
