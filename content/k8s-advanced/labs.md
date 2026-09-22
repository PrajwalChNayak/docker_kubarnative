---
title: Labs - Kubernetes advanced
description: Twelve exercises on the kind lab covering scheduling, autoscaling, in-place resize, Helm 4, Kustomize overlays, GitOps, a CRD and operator, and CEL admission policy, each with a full solution.
level: advanced
type: lab
status: current
versions: Kubernetes 1.37, Helm 4.3
prerequisites:
  - k8s-advanced/helm
  - k8s-advanced/kustomize
  - k8s-advanced/custom-resource-definitions
---

## Overview

Twelve exercises against the handbook's kind cluster, covering the whole of
Part H: where the scheduler puts a Pod, how autoscaling and in-place resize
change a running workload, how Helm 4 and Kustomize each render and ship the
Tasklane stack, how a GitOps controller would apply it, and how a CRD plus a
small operator and a CEL admission policy extend and guard the API.

The cluster is a kind cluster named `tasklane` running Kubernetes **1.37.0**
with one control-plane node and two workers labelled
`topology.kubernetes.io/zone=zone-a` and `zone-b`, with Tasklane stages 1 to 4
applied. The `tasklane` namespace enforces the **restricted** Pod Security
Standard, so every demo workload carries a full security context — a solution
that only works as root is not a solution.

Work through them in order and clean up as each exercise says; several leave
demo objects that the next one does not expect. The client-side tools live in
`.tools/` — `kubectl` 1.37 (with Kustomize v5.8.1 built in) and `helm` v4.3.0.

## Setup

Bring the lab up and confirm the topology and metrics stack the later
exercises need:

```bash
examples/lab/up.sh
kubectl config set-context --current --namespace=tasklane
kubectl get nodes -L topology.kubernetes.io/zone
kubectl top nodes
helm version
```

```console include="captures/k8s-advanced/nodes-zone-labels.txt"
```

The HPA exercise needs metrics-server serving `metrics.k8s.io`; the lab
installs it. The VPA, KEDA and Karpenter manifests in `examples/autoscaling`
need controllers that the lab does not run, so this lab uses only the HPA and
in-place resize, which do work on kind. Tear down demo objects with the
per-exercise cleanup commands, and drop the whole cluster at the end with
`kind delete cluster --name tasklane`.

## Exercises

### 1. Node affinity and weights

Apply `examples/scheduling/node-affinity.yaml` and explain, from the pod
placement alone, the difference between the `required` term and the `preferred`
term with weight 80. Then relabel or cordon a worker and say whether running
pods move. Clean up afterwards.

### 2. Anti-affinity caps replicas at domains

Apply `examples/scheduling/pod-anti-affinity.yaml`, which allows one replica
per node with required anti-affinity. The Deployment asks for three replicas.
How many run, how many are `Pending`, and why is that the *correct* outcome
rather than a bug?

### 3. Taints and tolerations

Taint a worker `NoSchedule`, apply `examples/scheduling/taints-tolerations.yaml`,
and show that the tolerating pods still schedule. Does `NoSchedule` evict pods
already running on the node? What would `NoExecute` do differently? Remove the
taint at the end.

### 4. Topology spread

Apply `examples/scheduling/topology-spread.yaml` (four replicas, `maxSkew: 1`
across zones, `whenUnsatisfiable: DoNotSchedule`). What is the zone
distribution? Scale to five and predict the distribution before you look. Then
cordon one worker's zone and scale to five again — what happens to the extra
replicas, and why?

### 5. Horizontal Pod Autoscaler on CPU

Apply `examples/autoscaling/hpa.yaml`, generate load through the Gateway, and
watch the API scale. Why does `TARGETS` read `<unknown>/70%` for the first
minute? Which API version does the HPA object use, and which version does the
controller talk to metrics-server with?

### 6. Resize a Pod in place

Using `examples/autoscaling/in-place-resize.yaml`, raise a running container's
CPU request without recreating the Pod. Which subresource and which kubectl
version do you need? Confirm from the Pod's status that the change took effect
without a restart. Which maturity is this feature, and since when?

### 7. Helm 4: lint, template and the schema gate

Lint the chart at `examples/helm/tasklane` with `--strict`, render it, and then
try to set a value that the chart's JSON Schema forbids. What stops the bad
value, and does it ever reach the cluster? Render the chart with autoscaling
and NetworkPolicy enabled and confirm both objects appear.

### 8. Helm 4: install, hooks and the first-install ordering trap

Do a server-side dry run of `helm install` into a fresh namespace. Then explain
the chart's migration hook: why does a *first* install with the bundled
PostgreSQL need `--set migrations.enabled=false`, while an upgrade does not?
Which Helm 4 flag replaced `--wait` behaviour, and what does its default do?

### 9. Kustomize overlays

Render the `prod` overlay and the `dev` overlay from
`examples/kustomize`. Where does the API's replica count come from in `prod`,
and why does the dev Secret's name have a hash suffix? Why does every
kustomization use `labels:` with `includeSelectors: false` rather than
`commonLabels:`?

### 10. GitOps: what the controller would apply

Without installing Argo CD or Flux, show the exact set of objects a GitOps
controller would apply for the staging overlay, and read how the Argo CD
`AppProject` and the Flux `Kustomization` each scope and order the deployment.
Why do you never run both controllers against the same objects?

### 11. A CRD and its operator

Apply the `TaskQueue` CRD from `examples/operator/config/crd`, apply the valid
sample, and read its printer columns. Then trigger both validation mechanisms:
the OpenAPI `maximum` on `spec.workers`, and the CEL transition rule that makes
`spec.deploymentName` immutable. Which component rejects each one, and at what
point?

### 12. CEL admission policy

Apply `examples/admission/validatingadmissionpolicy.yaml` and read its
`status.typeChecking`. The binding uses `validationActions: [Warn, Audit]` —
what does that mean for a Deployment that violates the policy, and when would
you flip it to `[Deny]`? Why is a ValidatingAdmissionPolicy preferable to a
validating webhook for this rule?

## Solutions

### 1. Node affinity and weights

```bash
kubectl apply -f examples/scheduling/node-affinity.yaml
kubectl -n tasklane get pods -o wide -l app.kubernetes.io/name=sched-node-affinity
kubectl delete -f examples/scheduling/node-affinity.yaml
```

```console include="captures/k8s-advanced/node-affinity-pods.txt"
```

The `requiredDuringSchedulingIgnoredDuringExecution` term is a hard filter: a
node that fails it is removed from the feasible set, and a pod with no feasible
node stays `Pending`. The `preferredDuringScheduling...` term with weight 80 is
a *score*, added during the scoring phase, so the scheduler biases towards
`zone-a` without forbidding `zone-b`. `IgnoredDuringExecution` is the second
half of both names: affinity is evaluated only at scheduling time, so
relabelling or cordoning a node afterwards does not move a running pod — you get
placement, not continuous enforcement. See
[node selection and affinity](node-selection-and-affinity.md).

### 2. Anti-affinity caps replicas at domains

```bash
kubectl apply -f examples/scheduling/pod-anti-affinity.yaml
kubectl -n tasklane get pods -o wide -l app.kubernetes.io/name=sched-anti-affinity
kubectl -n tasklane describe pod -l app.kubernetes.io/name=sched-anti-affinity | tail -n 15
kubectl delete -f examples/scheduling/pod-anti-affinity.yaml
```

```console include="captures/k8s-advanced/anti-affinity-pods.txt"
```

Two replicas run, one per worker; the third is `Pending` with a
`FailedScheduling` event naming the anti-affinity predicate. That is correct,
not broken: required pod anti-affinity with `topologyKey:
kubernetes.io/hostname` says "at most one of these per node", and the lab has
two schedulable workers, so the required rule caps the achievable replica count
at the number of domains. To run more, add nodes or relax the rule to
`preferred`. See
[pod affinity and anti-affinity](pod-affinity-and-anti-affinity.md).

### 3. Taints and tolerations

```bash
kubectl taint nodes tasklane-worker maintenance=true:NoSchedule --overwrite
kubectl apply -f examples/scheduling/taints-tolerations.yaml
kubectl -n tasklane get pods -o wide -l app.kubernetes.io/name=sched-toleration
kubectl taint nodes tasklane-worker maintenance=true:NoSchedule-
```

```console include="captures/k8s-advanced/taint-toleration-pods.txt"
```

The tolerating pods schedule onto the tainted node because their toleration
matches `maintenance=true:NoSchedule`; a pod without the toleration is repelled
from that node. `NoSchedule` is a scheduling-time filter only — it does **not**
evict pods already running on the node. `NoExecute` is the eviction effect:
applying it evicts running pods that do not tolerate it, and a pod that
tolerates it with `tolerationSeconds: N` is given N seconds before eviction.
Removing the taint (the trailing `-`) is what keeps the lab reusable. See
[taints and tolerations](taints-and-tolerations.md).

### 4. Topology spread

```bash
kubectl apply -f examples/scheduling/topology-spread.yaml
kubectl -n tasklane get pods -o wide -l app.kubernetes.io/name=sched-spread
kubectl -n tasklane scale deploy/sched-spread --replicas=5
kubectl -n tasklane get pods -o wide -l app.kubernetes.io/name=sched-spread
kubectl delete -f examples/scheduling/topology-spread.yaml
```

```console include="captures/k8s-advanced/topology-spread-pods.txt"
```

Four replicas across two zones with `maxSkew: 1` gives 2 and 2 — the maximum
difference in count between any two zones is one. Scaling to five allows 3/2,
which still satisfies `maxSkew: 1`. But `whenUnsatisfiable: DoNotSchedule` is a
hard constraint: cordon one zone's worker so only one zone can take pods, scale
to five, and the replicas that would push the skew past 1 stay `Pending` rather
than pile into the available zone. `whenUnsatisfiable: ScheduleAnyway` would
place them and merely score against the skew. See
[topology spread constraints](topology-spread-constraints.md).

### 5. Horizontal Pod Autoscaler on CPU

```bash
kubectl apply -f examples/autoscaling/hpa.yaml
kubectl -n tasklane get hpa tasklane-api
while true; do curl -s -o /dev/null http://localhost:8080/tasks; done   # Ctrl-C to stop
kubectl -n tasklane describe hpa tasklane-api
kubectl top pods -n tasklane
kubectl delete -f examples/autoscaling/hpa.yaml
```

```console include="captures/k8s-advanced/hpa-apply.txt"
```

```console include="captures/k8s-advanced/hpa-describe.txt"
```

`TARGETS` shows `<unknown>/70%` until metrics-server has collected at least two
samples of every pod, which takes up to a minute after the pods start; with no
metric the controller cannot compute a ratio and does nothing. The HPA object
is `autoscaling/v2` (the version you write), but the controller reads usage
from `metrics.k8s.io/v1beta1` — `v1` of the metrics API is stable in 1.37, yet
the HPA controller still queries `v1beta1`, which is why both are served.
Deleting the HPA leaves the Deployment at whatever replica count it last set;
the HPA never scales back down on its own removal. See
[horizontal pod autoscaler](horizontal-pod-autoscaler.md).

### 6. Resize a Pod in place

```bash
kubectl -n tasklane apply -f examples/autoscaling/in-place-resize.yaml
kubectl -n tasklane wait --for=condition=Ready pod/tasklane-resize-demo --timeout=90s
kubectl -n tasklane patch pod tasklane-resize-demo --subresource resize \
  -p '{"spec":{"containers":[{"name":"demo","resources":{"requests":{"cpu":"200m"}}}]}}'
kubectl -n tasklane get pod tasklane-resize-demo \
  -o jsonpath='{.status.containerStatuses[0].resources}{"\n"}'
kubectl -n tasklane delete pod tasklane-resize-demo
```

```console include="captures/k8s-advanced/in-place-resize.txt"
```

The `resize` subresource is the mechanism, and it needs kubectl 1.32 or newer;
patching `spec.containers[].resources` without `--subresource resize` is
rejected because those fields were immutable before this feature. The status
subresource reflects the new CPU request while the Pod's `RESTARTS` count stays
put — the container is resized in place, not recreated. In-place Pod Resize
(container-level) is **GA in 1.35**; pod-level in-place resize is a separate,
newer feature and is Beta. See [in-place pod resize](in-place-pod-resize.md).

### 7. Helm 4: lint, template and the schema gate

```bash
helm lint examples/helm/tasklane --strict
helm template t examples/helm/tasklane | head -80
helm template t examples/helm/tasklane --set api.replicas=3        # not a real key
helm template t examples/helm/tasklane \
  --set api.autoscaling.enabled=true --set networkPolicy.enabled=true \
  | grep -E '^kind: (HorizontalPodAutoscaler|NetworkPolicy)'
```

```console include="captures/k8s-advanced/helm-lint.txt"
```

```console include="captures/k8s-advanced/helm-template-head.txt"
```

```console include="captures/k8s-advanced/helm-schema-reject.txt"
```

`values.schema.json` validates `--set` and `-f` values before any template is
rendered, so a typo like `api.replicas` (the real key is `api.replicaCount`) is
caught locally and **never reaches the cluster** — the render fails first.
Enabling autoscaling and NetworkPolicy adds a `HorizontalPodAutoscaler` and a
`NetworkPolicy` to the output; both are off by default. `helm lint --strict`
turns warnings into failures, which is what you want in CI. See
[Helm](helm.md) and [Helm chart development](helm-chart-development.md).

### 8. Helm 4: install, hooks and the first-install ordering trap

```bash
kubectl create namespace tasklane-helm
kubectl label --overwrite namespace tasklane-helm \
  pod-security.kubernetes.io/enforce=restricted
kubectl -n tasklane-helm create secret generic tasklane-db \
  --from-literal=password="$(openssl rand -base64 24)"
helm install t examples/helm/tasklane -n tasklane-helm --dry-run=server \
  --set migrations.enabled=false
```

```console include="captures/k8s-advanced/helm-dry-run-server.txt"
```

The migration Job is a `pre-install,pre-upgrade` hook, so on a *first* install
it runs **before** anything in `templates/` is applied — including the bundled
PostgreSQL StatefulSet. There is therefore no database yet for the migration to
reach, so a first install with `postgresql.enabled=true` must pass
`--set migrations.enabled=false`; a later `helm upgrade` is fine because the
database is already running. Install into a separate namespace, because Helm
refuses to adopt the `kubectl apply`-created objects in `tasklane` without
`--take-ownership`. In Helm 4, `--wait` became a strategy
(`--wait=watcher|hookOnly|legacy`, default `hookOnly`), and `--atomic` became
`--rollback-on-failure`. See [Helm](helm.md) and
[Helm 3 to 4](../migration/helm-3-to-4.md).

### 9. Kustomize overlays

```bash
kubectl kustomize examples/kustomize/overlays/prod | head -60
kubectl kustomize examples/kustomize/overlays/dev | grep -A6 'kind: Secret'
```

```console include="captures/k8s-advanced/kustomize-prod-head.txt"
```

```console include="captures/k8s-advanced/kustomize-dev-secret.txt"
```

In `prod` the API Deployment omits `.spec.replicas` entirely: the `hpa`
component patches it out so the HorizontalPodAutoscaler owns the replica count,
and a static `replicas` in the manifest would fight the HPA on every apply. The
dev Secret is built by a `secretGenerator`, which appends a hash of the
contents to the name (`tasklane-db-xxxxxxxxxx`) and rewrites every reference to
it, so editing the secret content rolls the workloads that consume it. Every
kustomization uses `labels:` with `includeSelectors: false` rather than the
deprecated `commonLabels:` because `commonLabels` also writes into
`.spec.selector`, and a Deployment's selector is immutable — adding a common
label to a live workload with `commonLabels` fails the apply. Validate an
overlay without creating anything:

```bash
kubectl apply -k examples/kustomize/overlays/dev --dry-run=server
```

```console include="captures/k8s-advanced/kustomize-dev-dry-run.txt"
```

See [Kustomize](kustomize.md) and [Helm vs Kustomize](helm-vs-kustomize.md).

### 10. GitOps: what the controller would apply

```bash
kubectl kustomize examples/kustomize/overlays/staging | kubectl apply --dry-run=client -f - -o name
```

```console include="captures/k8s-advanced/staging-overlay-dry-run.txt"
```

That list is exactly the object set a GitOps controller reconciles for staging;
neither Argo CD nor Flux is installed on the lab, so the manifests in
`examples/gitops` are validated with kubeconform, not applied. Read how each
tool scopes it:

- The Argo CD [`appproject.yaml`](../../examples/gitops/argocd/appproject.yaml)
  restricts the source repository, the destination namespaces and the kinds an
  `Application` may create, adds a CI role and a weekend deny window; the
  [`applicationset.yaml`](../../examples/gitops/argocd/applicationset.yaml)
  renders one `Application` per overlay from a list generator.
- The Flux
  [`kustomizations.yaml`](../../examples/gitops/flux/kustomizations.yaml) is
  three `Kustomization` objects with `dependsOn` ordering, `healthChecks` and
  `prune: true`, each impersonating a ServiceAccount for tenancy.

You never point both controllers at the same objects, because each claims field
ownership through server-side apply and they would fight, endlessly reverting
each other's writes. Pick one. See [GitOps with Argo CD](gitops-argo-cd.md),
[GitOps with Flux](gitops-flux.md) and
[CI/CD for Kubernetes](cicd-for-kubernetes.md).

### 11. A CRD and its operator

```bash
kubectl apply -f examples/operator/config/crd
kubectl apply -f examples/operator/config/samples/
kubectl -n tasklane get taskqueues
kubectl explain taskqueue.spec --api-version=tasklane.example.com/v1alpha1
```

```console include="captures/k8s-advanced/crd-apply.txt"
```

```console include="captures/k8s-advanced/crd-printer-columns.txt"
```

Now trigger the two validation mechanisms — both are rejected by the API server
before any controller runs:

```bash
kubectl apply --dry-run=server -f examples/operator/config/samples-invalid/taskqueue-too-many-workers.yaml
kubectl apply --dry-run=server -f examples/operator/config/samples-invalid/taskqueue-renamed-deployment.yaml
```

```console include="captures/k8s-advanced/crd-reject-maximum.txt"
```

```console include="captures/k8s-advanced/crd-reject-transition.txt"
```

`spec.workers` has `maximum: 20` from the OpenAPI schema, so the API server's
structural-schema validation rejects the oversized sample. `spec.deploymentName`
carries an `x-kubernetes-validations` CEL rule `self == oldSelf`; because it
references `oldSelf` it is a *transition rule*, skipped on CREATE and enforced
on UPDATE — which is exactly "immutable after creation". Both rejections come
from the API server during admission, which is why `--dry-run=server` surfaces
them without writing anything. The operator itself only patches the target
Deployment's `spec.replicas`; it deliberately does not own that Deployment, so
a missing target leaves the TaskQueue `Ready=False, reason=DeploymentNotFound`.
See [custom resource definitions](custom-resource-definitions.md) and
[controllers and operators](controllers-and-operators.md).

### 12. CEL admission policy

```bash
kubectl apply -f examples/admission/validatingadmissionpolicy.yaml
kubectl get validatingadmissionpolicy \
  tasklane-workload-hygiene.tasklane.example.com -o jsonpath='{.status}{"\n"}'
kubectl delete -f examples/admission/validatingadmissionpolicy.yaml
```

```console include="captures/k8s-advanced/admission-vap-typechecking.txt"
```

A ValidatingAdmissionPolicy (VAP is **GA in 1.30**, group
`admissionregistration.k8s.io/v1`) evaluates CEL expressions inside the API
server process. With `validationActions: [Warn, Audit]` a violating Deployment
still succeeds, but the client gets an HTTP warning and the audit log records
it — the rollout setting that lets you measure impact before enforcing. Flip
the binding to `[Deny]` once the audit log is quiet; `Deny` and `Warn` may not
be combined. `status.typeChecking` reports whether the API server could resolve
every field the CEL references against `apps/v1` — an empty result means no type
errors. A VAP beats a validating webhook here because there is no extra Pod to
build, certify, run and keep available: a webhook with `failurePolicy: Fail`
that stops answering rejects every matching write in the cluster, a failure
mode the in-process policy simply does not have. See
[admission policies (CEL)](admission-policies-cel.md) and
[admission webhooks](admission-webhooks.md).

## Common mistakes

- **Reading required affinity as a preference.** A required term that no node
  satisfies leaves the Pod `Pending`; it does not fall back to a best effort.
- **Expecting anti-affinity to add nodes.** One-per-domain anti-affinity caps
  replicas at the domain count; the surplus stays `Pending` by design.
- **Forgetting to remove a taint.** A `NoSchedule` taint left on a worker
  quietly shrinks the schedulable cluster for every later exercise.
- **Judging the HPA in the first minute.** `<unknown>` means metrics-server has
  no samples yet, not that the HPA is broken.
- **Patching `resources` without `--subresource resize`.** The plain patch is
  rejected; the resize subresource is the whole point.
- **Setting a `.spec.replicas` in a manifest an HPA owns.** The two fight; let
  the autoscaler own the count and patch `replicas` out (the prod overlay does).
- **Using `commonLabels:` on a live workload.** It writes into the immutable
  selector and fails the apply; use `labels:` with `includeSelectors: false`.
- **Installing the Helm chart with `migrations.enabled=true` on a first
  install** with the bundled database; the pre-install hook has no database to
  reach yet.
- **Running Argo CD and Flux against the same objects.** They fight over
  field ownership. Pick one.
- **Applying the illustration webhook for real.** It points at a Service that
  does not exist and, with `failurePolicy: Fail`, would reject matching writes
  cluster-wide.

## Related topics

- [Node selection and affinity](node-selection-and-affinity.md)
- [Taints and tolerations](taints-and-tolerations.md)
- [Topology spread constraints](topology-spread-constraints.md)
- [Priority and preemption](priority-and-preemption.md)
- [Horizontal Pod Autoscaler](horizontal-pod-autoscaler.md)
- [In-place pod resize](in-place-pod-resize.md)
- [Helm](helm.md)
- [Kustomize](kustomize.md)
- [GitOps with Argo CD](gitops-argo-cd.md)
- [Custom resource definitions](custom-resource-definitions.md)
- [Controllers and operators](controllers-and-operators.md)
- [Admission policies (CEL)](admission-policies-cel.md)
</content>
