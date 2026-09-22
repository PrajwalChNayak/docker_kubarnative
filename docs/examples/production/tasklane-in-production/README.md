# Tasklane in production

This is the map, not new code. It ties together the artifacts the earlier
parts already built and shows how they compose into a production deployment of
Tasklane. Every path below is a relative reference to another part's example
directory — nothing is copied here, so there is one source of truth per concern.

The lab (kind) is a stand-in for the real thing. In production the same objects
run on a managed control plane (see `content/production/eks.md`, `gke.md`,
`aks.md`) or a self-managed one (`../kubeadm/README.md`).

## The pipeline, concern by concern

| Concern | Artifact (relative path) | Owning part |
|---|---|---|
| Hardened image, digest-pinned | `../../app/Dockerfile` (distroless `static-debian13:nonroot`, UID 65532, exec-form ENTRYPOINT) | Part C/D |
| Supply chain: scan, SBOM, sign, verify | `../../security/` and `content/docker-advanced/{vulnerability-scanning,sboms-and-provenance,image-signing-cosign}.md` | Part D/E |
| Raw manifests (the desired state) | `../../k8s/01-namespace` … `../../k8s/04-gateway` | Part F |
| Probes, PDB, resources, topology spread | `../../k8s/03-app/api.yaml` | Part F/G |
| Environment overlays (dev/stage/prod) | `../../kustomize/` | Part H |
| Packaged release | `../../helm/` | Part H |
| Autoscaling (HPA + node autoscaler) | `content/k8s-advanced/{horizontal-pod-autoscaler,cluster-autoscaler-and-karpenter}.md` | Part H |
| Default-deny NetworkPolicy | `content/k8s-security/network-segmentation.md` | Part I |
| PSA restricted, RBAC, admission policy | `../../k8s/01-namespace/namespace.yaml` (PSA labels) + Part I | Part F/I |
| TLS via Gateway + cert-manager | `../../k8s/04-gateway/gateway.yaml` + `content/k8s-intermediate/cert-manager.md` | Part G |
| Observability | `content/operations/{prometheus-and-kube-prometheus,logging-architectures,slos-and-error-budgets}.md` | Part J |
| Backups / DR | `content/operations/{etcd-backup-and-restore,velero-backup-and-restore}.md` | Part J |
| GitOps delivery | `content/k8s-advanced/{gitops-argo-cd,gitops-flux}.md` | Part H |

## What "production" changes versus the lab

The lab manifests are already close to production-shaped — that was the point
of building them the strict way from Part F on. The differences are:

1. **Image references become digests.** `tasklane-api:0.1.0` in the lab becomes
   `registry.example.com/tasklane-api@sha256:...` in the prod overlay, and
   admission refuses anything unsigned. The tag-to-digest swap belongs in the
   Kustomize/Helm prod overlay, not in the base.
2. **`imagePullPolicy` and a real registry.** The lab side-loads images with
   `kind load`; production pulls from a registry with pull credentials and a
   pull-through cache.
3. **Postgres leaves the cluster (usually).** The lab runs `postgres:18` as a
   StatefulSet; most production Tasklane deployments point `PGHOST` at a managed
   database (RDS/Cloud SQL/Azure Database) and delete the in-cluster Postgres.
   If it stays in-cluster, it needs a tested backup and a real storage class.
4. **The Gateway terminates real TLS.** The lab's HTTP listener becomes an HTTPS
   listener with a `cert-manager` Certificate; `http` redirects to `https`.
5. **Secrets come from a manager.** `tasklane-db` is synced by External Secrets
   or sealed, never applied from a plaintext file, and the API server encrypts
   Secrets at rest.
6. **Scale and disruption budgets are real.** `replicas` ≥ 2 per zone, an HPA on
   a meaningful signal, a PodDisruptionBudget, and node headroom for a zone loss.

## Gate before you ship

Walk `../readiness-checklist.md` top to bottom. On a managed control plane the
provider owns the `[M]` rows; you still own everything else. The checklist is
the definition of done for this directory.
