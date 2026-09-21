# tasklane chart

A Helm 4 chart for the Tasklane API, worker and (optionally) a lab PostgreSQL.
Chart API `v2`, tested against Helm **v4.3.0** and Kubernetes **1.37**.

```
Chart.yaml            apiVersion: v2, chart version + appVersion
values.yaml           defaults, all of them documented inline
values.schema.json    JSON Schema; a typo in --set fails before the cluster sees it
templates/
  _helpers.tpl        names, labels, image refs, shared securityContext
  configmap.yaml      tasklane-config equivalent
  serviceaccounts.yaml  two accounts, automountServiceAccountToken: false
  deployment-api.yaml   + checksum/config annotation
  deployment-worker.yaml
  statefulset-postgres.yaml   only when postgresql.enabled
  services.yaml         api, worker metrics, headless postgres
  httproute.yaml        Gateway API v1
  networkpolicy.yaml    default-deny + allows (off by default)
  hpa.yaml              autoscaling/v2 (off by default)
  pdb.yaml              policy/v1
  migrate-job.yaml      pre-install,pre-upgrade hook running `tasklane-api migrate`
  NOTES.txt             printed after install
  tests/test-connection.yaml   `helm test` pod
```

## Try it without a cluster

```bash
helm lint examples/helm/tasklane --strict
helm template t examples/helm/tasklane
helm template t examples/helm/tasklane --set api.autoscaling.enabled=true --set networkPolicy.enabled=true
helm show values examples/helm/tasklane
```

Validate the rendered output:

```bash
helm template t examples/helm/tasklane | kubeconform -strict -summary -kubernetes-version 1.37.0 -schema-location default -schema-location "https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json" -
```

## Install it

The chart needs a Secret called `tasklane-db` (key `password`) in the release
namespace, and it never creates one: a chart that renders a password puts that
password into the release record, which is a Secret any reader of the
namespace can decode.

```bash
kubectl create namespace tasklane-helm
kubectl label --overwrite namespace tasklane-helm pod-security.kubernetes.io/enforce=restricted
kubectl -n tasklane-helm create secret generic tasklane-db --from-literal=password="$(openssl rand -base64 24)"
helm install t examples/helm/tasklane -n tasklane-helm --set migrations.enabled=false --wait
helm test t -n tasklane-helm --logs
```

Use a separate namespace: the `tasklane` namespace already holds objects
created by `kubectl apply`, and Helm refuses to adopt resources it does not
own unless you pass `--take-ownership`.

## Values worth knowing

| Value | Default | Notes |
|---|---|---|
| `api.replicaCount` | `2` | Ignored when `api.autoscaling.enabled` is true; the Deployment then omits `replicas` |
| `api.image.digest` | `""` | Wins over `tag`. Production should set it |
| `database.existingSecret` | `tasklane-db` | Must exist. The chart never creates it |
| `database.host` | `""` | Required when `postgresql.enabled` is false; the template calls `fail` otherwise |
| `postgresql.enabled` | `true` | Lab only. See below |
| `migrations.enabled` | `true` | `pre-install,pre-upgrade` hook Job |
| `httpRoute.parentRef.namespace` | `tasklane` | The lab Gateway's namespace |
| `networkPolicy.enabled` | `false` | Needs a CNI that enforces NetworkPolicy |

## Two honest caveats

**The bundled PostgreSQL is not production.** One replica, no backups, no
failover, and its lifecycle is tied to the release: `helm uninstall` deletes
the StatefulSet (the PVC survives, because `volumeClaimTemplates` PVCs are not
owned by Helm). Production should use a managed database or an operator such
as CloudNativePG, with `postgresql.enabled=false` and `database.host` set.
This chart deliberately has **no chart dependency** on a third-party
PostgreSQL chart: the widely used Bitnami charts and images moved to a
"legacy" repository with no updates in 2025, so depending on them now means
depending on unpatched images.

**Hooks do not see the release's own resources.** A `pre-install` hook runs
before Helm applies anything in `templates/`, so on a *first* install with
`postgresql.enabled=true` there is no database for the migration Job to reach.
Install once with `--set migrations.enabled=false`, then upgrade with it on;
or point the chart at a database that already exists. `helm upgrade` is not
affected, because by then the database is running.

## Pod Security

Every pod the chart renders — api, worker, postgres, the migration hook and
the `helm test` pod — satisfies the *restricted* Pod Security Standard:
`runAsNonRoot: true` with a non-zero UID, `seccompProfile: RuntimeDefault`,
`allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`,
`capabilities.drop: ["ALL"]`, `automountServiceAccountToken: false`, and CPU
and memory requests plus a memory limit on every container.
