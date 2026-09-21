# tasklane-operator

A deliberately small operator. It exists to make one Kubernetes API real end to
end: a CustomResourceDefinition, a controller-runtime manager, RBAC that grants
only the verbs the code calls, and a manifest that runs it under Pod Security
Admission's `restricted` profile.

The API is `TaskQueue` in group `tasklane.example.com`, version `v1alpha1`,
namespaced. A TaskQueue says "this queue wants N workers". The controller makes
the named Deployment's `spec.replicas` equal N and reports what it observed.

| Path | What it is |
|---|---|
| `api/v1alpha1/types.go` | The Go types, with the kubebuilder markers the CRD is generated from |
| `api/v1alpha1/groupversion_info.go` | Group/version registration for the scheme |
| `api/v1alpha1/zz_generated.deepcopy.go` | Generated. Do not edit |
| `internal/controller/taskqueue_controller.go` | The reconcile loop |
| `cmd/main.go` | Manager setup: cache, metrics, probes, leader election |
| `config/crd/` | The generated CustomResourceDefinition |
| `config/rbac/` | ServiceAccount, ClusterRole, leader-election Role, bindings |
| `config/manager/deployment.yaml` | Namespace `tasklane-system` and the Deployment |
| `config/samples/` | A TaskQueue the API server accepts |
| `config/samples-invalid/` | Two the API server rejects, one per validation mechanism |

## Versions

Pinned against Kubernetes 1.37: `k8s.io/*` v0.37.0 and
`sigs.k8s.io/controller-runtime` v0.25.1. controller-runtime's minor version
tracks the Kubernetes minor, so v0.25.x is the line built against 1.37.
`go.sum` is committed; builds are reproducible without a network resolve.

## Build and run

```bash
docker build -t tasklane-operator:0.1.0 examples/operator
kind load docker-image tasklane-operator:0.1.0 --name tasklane

kubectl apply -f examples/operator/config/crd
kubectl apply -f examples/operator/config/manager     # creates the namespace
kubectl apply -f examples/operator/config/rbac
kubectl apply -f examples/operator/config/samples
```

Apply `config/manager` before `config/rbac`: the RBAC objects live in
`tasklane-system`, and that Namespace object is at the top of
`config/manager/deployment.yaml`.

To regenerate the deepcopy functions and the CRD after editing
`api/v1alpha1/types.go`, without installing anything on the host:

```bash
docker run --rm -v "$PWD/examples/operator:/src" -w /src golang:1.27 sh -c "go run sigs.k8s.io/controller-tools/cmd/controller-gen@v0.22.0 object paths=./api/... && go run sigs.k8s.io/controller-tools/cmd/controller-gen@v0.22.0 crd paths=./api/... output:crd:artifacts:config=config/crd"
```

controller-tools v0.22.0 is the version kubebuilder v4.16.0 ships with.

## Design decisions worth arguing about

**It patches the Deployment; it does not own it.** There is no
`ownerReference` from the Deployment back to the TaskQueue. Tasklane's worker
Deployment is written by the platform repo and applied by GitOps. An
ownerReference would hand the garbage collector the right to delete that
Deployment when someone deletes a TaskQueue, and reconciling the whole spec
would start a fight with the GitOps controller on every other field. A merge
patch writes exactly `spec.replicas` and leaves the rest of the object,
including its managed fields, to its real owner.

The trade-off is honest: because the operator does not own the Deployment, it
cannot create one, and a TaskQueue whose target is missing sits with
`Ready=False, reason=DeploymentNotFound` until somebody creates it.

**There is no finalizer.** A finalizer is for state that outlives the object
and lives outside the API server's own garbage collection: a cloud load
balancer, a database, a row in someone else's system. This operator creates no
such state. Adding a finalizer would only buy a new failure mode, namely
TaskQueues stuck in `Terminating` whenever the operator is down.

**Status is written only when it changes.** `writeStatus` compares against the
status that was read at the top of `Reconcile`. Writing an identical status
every pass bumps `resourceVersion`, which wakes the watch, which reconciles
again: a hot loop that costs API server CPU and looks like someone else's bug.

**Leader election is on by default.** Both replicas run and both keep warm
caches, but only the holder of the `taskqueue.tasklane.example.com` Lease in
`tasklane-system` reconciles. Without it, two replicas would both patch
`spec.replicas` and the writes would interleave during rolling updates.

## Validation lives in the CRD, not in the controller

Two mechanisms, two failure modes, both visible before the controller runs:

- `spec.workers` has `minimum: 0` and `maximum: 20` from OpenAPI. Try
  `config/samples-invalid/taskqueue-too-many-workers.yaml`.
- `spec.deploymentName` has an `x-kubernetes-validations` CEL rule
  `self == oldSelf`. Because it references `oldSelf` it is a *transition rule*:
  it is skipped on CREATE and enforced on UPDATE, which is exactly what
  "immutable after creation" means. Try
  `config/samples-invalid/taskqueue-renamed-deployment.yaml` after applying the
  valid sample.

Both rejections come from the API server, so `kubectl apply --dry-run=server`
shows them without writing anything.

## What this operator is not

It has no webhooks, no conversion, one API version and no `scale` subresource.
Those are all reasonable next steps, and each one is a real cost: a conversion
webhook is a component that can take your CRD offline, and a second served
version is a migration you now own. Add them when a user needs them.
