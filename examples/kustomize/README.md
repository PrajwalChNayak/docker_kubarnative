# Tasklane with Kustomize

A base plus three overlays, rendered entirely by the Kustomize that ships
inside `kubectl` 1.37 (Kustomize **v5.8.1**). No extra binary is needed.

```
base/                     namespace-agnostic Tasklane: api, worker, postgres,
                          services, HTTPRoute, generated ConfigMap
components/
  network-policy/         default-deny + the four flows Tasklane needs
  hpa/                    autoscaling/v2 HPA, and a patch that removes
                          .spec.replicas from the API Deployment
overlays/dev/             1 replica, generated Secret, dev image tag
overlays/staging/         2 replicas, rc image tag, NetworkPolicy component
overlays/prod/            digests, HPA + NetworkPolicy, ExternalSecret
with-helm/                the helmCharts generator: kustomize wrapping the
                          Helm chart in examples/helm/tasklane
```

## Render it

```bash
kubectl kustomize examples/kustomize/base
kubectl kustomize examples/kustomize/overlays/dev
kubectl kustomize examples/kustomize/overlays/staging
kubectl kustomize examples/kustomize/overlays/prod
```

Apply with `kubectl apply -k examples/kustomize/overlays/dev` (add
`--dry-run=server` to validate without creating anything; the namespace has to
exist already for a server dry run, because a dry run creates nothing).

Validate every overlay against the 1.37 schemas plus the CRD catalog:

```bash
kubectl kustomize examples/kustomize/overlays/prod | kubeconform -strict -summary -kubernetes-version 1.37.0 -schema-location default -schema-location "https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json" -
```

## What each overlay demonstrates

| | dev | staging | prod |
|---|---|---|---|
| namespace | `tasklane-dev` | `tasklane-staging` | `tasklane-prod` |
| image selection | `newTag: 0.1.0-dev` | `newTag: 0.1.0-rc.3` | `newName` + `digest` |
| replicas | api 1, worker 1 | api 2, worker 2 | worker 3, api owned by the HPA |
| database password | `secretGenerator` (dev only) | external Secret `tasklane-db` | `ExternalSecret` creates `tasklane-db` |
| components | none | network-policy | network-policy, hpa |
| patches | strategic merge + JSON 6902 | strategic merge + JSON 6902 + replacement | strategic merge (`$patch: delete`) + JSON 6902 |

The image tags in dev and staging (`0.1.0-dev`, `0.1.0-rc.3`) and the prod
digests are **placeholders**: the lab only builds `tasklane-api:0.1.0` and
`tasklane-worker:0.1.0`. A pipeline rewrites them with
`kustomize edit set image`. Server-side dry runs never pull an image, so the
overlays validate anyway.

## Things worth knowing

**`labels:`, not `commonLabels:`.** `commonLabels` is deprecated in Kustomize
v5 and always writes the label into selectors as well as metadata. Deployment
and StatefulSet `.spec.selector` is immutable, so adding a common label to a
live workload with `commonLabels` fails the apply. Every kustomization here
uses `labels:` with `includeSelectors: false`, so the labels are metadata and
the pod template only.

**The ConfigMap and the dev Secret are generated.** Kustomize appends a hash of
the contents to the name (`tasklane-config-475672479c`) and rewrites every
`configMapRef`, `secretKeyRef` and `volumes[].secret.secretName` that points at
it. Editing `base/config.env` therefore produces a new ConfigMap name, which
changes the pod template, which rolls the Deployment. That is the point: a
plain `kubectl edit configmap` changes nothing about the running pods.
The flip side is garbage: old hashed objects stay behind until something
prunes them. `kubectl apply --prune` still calls itself Alpha in its own help
text, so in practice pruning is a job for Argo CD or Flux.

**Patch files are fragments.** `overlays/*/patches/*.yaml` are strategic merge
patches, not manifests, so they fail `kubeconform` on their own (no
`spec.selector`, and `$patch: delete` is not a Kubernetes field). Validate the
rendered output, never the patch.

**Cross-namespace routes.** The lab Gateway is `tasklane/tasklane` and its
`http` listener sets `allowedRoutes.namespaces.from: Same`, so an HTTPRoute
that lives in `tasklane-dev` will be reported as *not accepted*. The overlays
are honest about this: the route's `parentRefs` names the `tasklane` namespace
explicitly, every overlay namespace carries the label
`tasklane.example.com/gateway: tasklane`, and the Gateway owner has to opt in
once:

```bash
kubectl -n tasklane patch gateway tasklane --type=merge -p '{"spec":{"listeners":[{"name":"http","protocol":"HTTP","port":80,"allowedRoutes":{"namespaces":{"from":"Selector","selector":{"matchLabels":{"tasklane.example.com/gateway":"tasklane"}}}}}]}}'
```

The alternative is one Gateway per environment namespace, which is cleaner for
tenancy but costs one data plane (and, in this kind cluster, one NodePort) per
environment.

**PostgreSQL is in every overlay** so the example runs end to end. A real
production overlay would point `PGHOST` at a managed database or an operator
(CloudNativePG) and drop the StatefulSet and its Service:

```yaml
patches:
  - target:
      kind: StatefulSet
      name: postgres
    patch: |-
      $patch: delete
      apiVersion: apps/v1
      kind: StatefulSet
      metadata:
        name: postgres
```

**Wrapping the Helm chart.** `with-helm/` renders
`examples/helm/tasklane` through the `helmCharts` generator:

```bash
kubectl kustomize --enable-helm --load-restrictor=LoadRestrictionsNone examples/kustomize/with-helm
```

`--enable-helm` is mandatory (the generator is off by default) and the relaxed
load restrictor is needed only because the chart sits outside the
kustomization root. The result is plain YAML: Helm's hook annotations survive
but nothing acts on them, and there is no release record, so `helm rollback`,
`helm test` and `helm uninstall` are gone. Use it when you consume someone
else's chart and need a change the chart does not expose.

**Pod Security.** Every rendered pod satisfies the *restricted* profile:
`runAsNonRoot: true`, a non-zero `runAsUser`, `seccompProfile: RuntimeDefault`,
`allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`,
`capabilities.drop: ["ALL"]` and `automountServiceAccountToken: false`. The
namespaces in each overlay carry `enforce`, `warn` and `audit` labels pinned to
`v1.37`.
