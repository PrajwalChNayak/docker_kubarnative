# Part K: production artifacts

These are reference artifacts for Part K (Production and managed Kubernetes).
They are **command references and checklists**, not applied by the lab. The
Tasklane manifests they describe live in the other parts' example
directories, referenced by relative path, never copied here.

| File | What it is |
|---|---|
| `readiness-checklist.md` | The production-readiness checklist, mirrored from `content/production/production-readiness-checklist.md`. |
| `k3s/README.md` | k3s install command reference (single binary, bundled components, HA). |
| `kubeadm/README.md` | kubeadm cluster-bootstrap reference (control plane + join). |
| `tasklane-in-production/README.md` | How the pieces from Parts B–J compose into a production Tasklane deployment. |

Nothing here talks to a cluster. The kubeadm and k3s commands are for a real
Linux host or VM, not the disposable kind lab, and are shown for reference.
