---
title: Custom Resource Definitions
description: How a CRD turns a Go struct into a first-class Kubernetes API, and where its schema, versioning and validation machinery bites.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/manifest-anatomy
  - k8s-beginner/declarative-model-and-reconciliation
---

## Overview

A CustomResourceDefinition is a manifest that asks the API server to start
serving a new kind. Apply one and, within a second or two, `kubectl get
taskqueues` works, the object is stored in etcd, RBAC rules can name it, label
selectors and watches work on it, and `kubectl explain` documents it. You wrote
no server code.

That is the trade. A CRD gives you the whole Kubernetes API machinery for the
price of a schema, and in exchange you accept the storage, the request
handling, the validation model and the versioning model that the API server
already has. When those fit, a CRD is the cheapest extension point in
Kubernetes. When they do not, no amount of schema will help and you need an
[aggregated API](aggregated-apis.md).

CRDs use `apiextensions.k8s.io/v1`, which has been GA since 1.16. The
`v1beta1` version was removed in 1.22 and must never appear in new manifests.

## Why it exists and when to use it

The question is not "CRD or nothing". It is "CRD, ConfigMap, or a real API
server", and the answer follows from who reads the data.

| You want | Use |
|---|---|
| A config file a process reads at startup, in one blob | A ConfigMap |
| An object users create with `kubectl`, that something watches and acts on | A CRD |
| An object with `.spec`/`.status` conventions, RBAC, label selectors, printer columns | A CRD |
| Custom storage (not etcd), protobuf clients, or subresources beyond status and scale | An aggregated API |
| Objects created at a rate or volume that would strain etcd | Neither; use your own datastore |

The Kubernetes documentation's own guidance is blunt: prefer a ConfigMap when
there is an existing, well-documented configuration file format that a process
in a pod reads for itself. Reach for a custom resource when you want client
libraries and `kubectl` support, and when automation will watch the object and
act on changes.

:::warning A CRD is an API, and APIs are forever
The moment somebody else writes a TaskQueue, you owe them compatibility. A
served version can be deprecated but not casually deleted, and every field you
add is a field you will be asked to keep. Start with one `v1alpha1` version,
say out loud that it is alpha, and do not promote it until the shape stops
changing.
:::

## How it works underneath

The CRD object is handled by `apiextensions-apiserver`, which runs inside
kube-apiserver. Applying a CRD does not restart anything; it registers a new
REST handler.

1. The CRD is validated and stored. The API server sets `status.conditions`
   with `NamesAccepted` and then `Established`.
2. A discovery entry appears under `/apis/tasklane.example.com/v1alpha1`.
   `kubectl` refreshes its discovery cache and learns the kind exists.
3. Requests to that path are served by a generic handler that validates the
   body against the OpenAPI v3 schema in the CRD, applies defaults, prunes
   unknown fields, and writes to etcd under the CRD's own key prefix.
4. Nothing acts on the object. A CRD is storage plus validation. Behaviour
   comes from a [controller](controllers-and-operators.md) you also write.

### Structural schemas and pruning

Every `apiextensions.k8s.io/v1` CRD must carry a **structural schema**. The
definition has three rules, quoted from the Kubernetes documentation. A
structural schema:

1. "specifies a non-empty type (via `type` in OpenAPI) for the root, for each
   specified field of an object node (via `properties` or
   `additionalProperties` in OpenAPI) and for each item in an array node (via
   `items` in OpenAPI)"
2. "for each field in an object and each item in an array which is specified
   within any of `allOf`, `anyOf`, `oneOf` or `not`, the schema also specifies
   the field/item outside of those logical junctors"
3. "does not set `description`, `type`, `default`, `additionalProperties`,
   `nullable` within an `allOf`, `anyOf`, `oneOf` or `not`, with the exception
   of the two pattern for `x-kubernetes-int-or-string: true`"

The payoff is **pruning**: any field in a submitted object that the schema does
not mention is silently dropped before storage. A typo in a field name does not
produce an error, it produces an object missing that field, which is the single
most common "my CRD ignores my setting" bug.

`x-kubernetes-preserve-unknown-fields: true` turns pruning off at one node, so
arbitrary JSON can be stored there. Use it for genuinely opaque blobs, such as
an embedded pod template you pass straight through, and nowhere else: fields
under it get no validation, no defaulting, and no CEL.

### Defaulting and versions

The `default` keyword in the schema is applied by the API server during
admission, on both read and write paths. The stored object therefore contains
the default, which is why removing a default later does not un-default
existing objects.

`spec.versions` is a list. Exactly one entry has `storage: true` and that is
the version written to etcd; every entry with `served: true` is available over
HTTP. Objects written under an older version are converted on read.

`spec.conversion.strategy` is either `None` or `Webhook`. `None` means the API
server changes only `apiVersion` and hands the same body back, which is correct
only when the versions are structurally identical. Anything else needs a
conversion webhook: a service the API server calls on every read of a
non-storage version. That webhook is now on the critical path of every
`kubectl get` for your kind.

`status.storedVersions` lists every version any object has ever been stored
under. You cannot remove a version from the CRD while it is still in that list.
Clearing it is what **Storage Version Migration** is for: the
`storagemigration.k8s.io/v1` StorageVersionMigration resource, **GA and on by
default in 1.37**, asks the control plane to read and rewrite every object of a
resource so it lands in the current storage version.

:::note The 1.37 documentation lags here
The Storage Version Migration task page and the feature-gate table still
describe `StorageVersionMigrator` as beta and off by default. The 1.37 release
material and the KEP both say GA and default-on. Trust the release material,
and check `kubectl api-resources --api-group=storagemigration.k8s.io` on your
own cluster.
:::

### Validation rules: CEL in the schema

`x-kubernetes-validations` attaches CEL expressions to a schema node. They have
been **stable since 1.29**. Inside a rule, `self` is the value at that node,
and a rule that mentions `oldSelf` is implicitly a **transition rule**:
evaluated only on update, skipped on create. That is how immutability is
expressed.

Rules cost CPU on the write path, so the API server both estimates their worst
case when the CRD is written and enforces a runtime budget per request. An
expression that iterates an unbounded list is the usual way to blow it; the
fix is to put `maxItems`, `maxProperties` and `maxLength` on the fields the
rule touches, which lets the estimator bound the work.

### Subresources and printer columns

`subresources.status: {}` splits `/status` into its own endpoint. Two things
follow, and both matter: writes to the main resource ignore `status`
entirely, and writes to `/status` ignore everything else. It also makes the API
server bump `metadata.generation` only when `spec` changes, which is what makes
`observedGeneration` meaningful.

`subresources.scale` exposes `/scale` with `specReplicasPath`,
`statusReplicasPath` and `labelSelectorPath`, so `kubectl scale` and the
[HorizontalPodAutoscaler](horizontal-pod-autoscaler.md) can drive your object.

`additionalPrinterColumns` decides what `kubectl get` shows. Each entry has
`name`, `type`, `jsonPath`, and optionally `description`, `format` and
`priority`. A column with `priority` greater than zero only appears under
`-o wide`.

## Basic example

The TaskQueue API used throughout this part. Header, names and the columns
`kubectl get` will print:

```yaml include="examples/operator/config/crd/tasklane.example.com_taskqueues.yaml" lines="1-36"
```

The spec schema, with a default, OpenAPI bounds and one CEL transition rule:

```yaml include="examples/operator/config/crd/tasklane.example.com_taskqueues.yaml" lines="58-89"
```

And the tail, which is where the version is declared served and stored and the
status subresource is switched on:

```yaml include="examples/operator/config/crd/tasklane.example.com_taskqueues.yaml" lines="172-175"
```

An object the API server accepts:

```yaml include="examples/operator/config/samples/taskqueue.yaml"
```

```bash
kubectl apply -f examples/operator/config/crd
kubectl apply -f examples/operator/config/samples/
kubectl -n tasklane get taskqueues
```

```console include="captures/k8s-advanced/crd-printer-columns.txt"
```

## Explanation

Note what the sample does *not* say: `deploymentName`. The CRD defaults it
during admission, so the stored object has it set. That is worth proving rather
than believing:

```bash
kubectl -n tasklane get taskqueue tasklane-worker -o jsonpath='{.spec}'
```

```console include="captures/k8s-advanced/crd-defaulted-object.txt"
```

The two validation mechanisms fail differently, and the difference is the whole
reason both exist. `maximum: 20` is a static bound the API server checks on
every write:

```bash
kubectl apply --dry-run=server -f examples/operator/config/samples-invalid/taskqueue-too-many-workers.yaml
```

```console include="captures/k8s-advanced/crd-reject-maximum.txt"
```

The CEL rule `self == oldSelf` cannot be expressed in OpenAPI at all, because
it is a statement about two versions of the object. Applying the valid sample
and then changing `deploymentName` gets it rejected:

```bash
kubectl apply -f examples/operator/config/samples/
kubectl apply --dry-run=server -f examples/operator/config/samples-invalid/taskqueue-renamed-deployment.yaml
```

```console include="captures/k8s-advanced/crd-reject-transition.txt"
```

Both rejections come from the API server, so `--dry-run=server` shows them
without writing anything. That is also the honest way to test a CRD schema:
client-side dry run does not run any of this.

Because the schema is published, `kubectl explain` works on your kind the same
way it works on Pods:

```bash
kubectl explain taskqueue.spec --api-version=tasklane.example.com/v1alpha1
```

```console include="captures/k8s-advanced/crd-explain.txt"
```

## Common patterns

**Generate the CRD, do not write it.** Hand-maintained CRD YAML drifts from the
Go types within a sprint. `controller-gen` reads kubebuilder markers on the
struct and emits the schema; the file in `config/crd/` should be a build
artefact you commit, not a document you edit. `examples/operator/README.md`
gives the exact command, which runs in a container so nothing is installed on
the host.

**One version until you are forced.** Add `v1beta1` when you actually need a
shape change, and plan the conversion webhook and the storage version
migration at the same time. Serving two versions with `strategy: None` and
different fields is silent data loss.

**Put the constraint in the schema, not the controller.** A controller that
rejects bad input does so after the object is stored, so the user sees a
`Ready=False` condition minutes later. A schema rejects it in the `kubectl
apply` that created it. Every bound you can express in OpenAPI or CEL is an
error message moved from a log to a terminal.

**Status is the controller's, spec is the user's.** With the status subresource
on, this is enforced rather than agreed.

## Production considerations

Installing a CRD is a cluster-wide, cluster-admin act. There is one CRD per
kind for the whole cluster, so two tenants cannot have different versions of
`taskqueues.tasklane.example.com`. That single fact shapes
[multi-tenancy](multi-tenancy.md) more than any namespace policy.

Deleting a CRD deletes every object of that kind, cluster-wide, immediately and
without a confirmation prompt. `kubectl delete -f crd.yaml` during a Helm
uninstall has destroyed production data at more than one company. Helm's own
answer is that CRDs in `crds/` are never deleted on uninstall, which is a
sensible default and a surprise if you expected cleanup.

CRD objects live in the same etcd as everything else and count against the same
request budget. Custom resources that are created per request, per build or per
event will hurt: etcd is a strongly consistent datastore for control-plane
configuration, not a queue.

Watch the write-path cost of your schema. Deep `properties` trees, large
`maxItems`, and CEL rules over lists all run on every write, and the API server
is the one paying.

## Security considerations

**Threat.** `x-kubernetes-preserve-unknown-fields: true` on a node that ends up
in a pod template. An attacker with permission to create your custom resource
writes fields your schema never declared. They are stored verbatim, and your
controller copies that subtree into a PodSpec.

**Exploit.** The preserved subtree carries `hostPID: true`, a `hostPath` volume
mounting `/`, or `privileged: true`. The custom resource passed validation
because nothing under a preserved node is validated. The pod is then created by
the controller's ServiceAccount, not the attacker's, so the attacker's own RBAC
and any object-level policy on them never applies.

**Fix.** Three layers, all of them cheap:

- Declare the fields. If you must accept a pod template, accept the specific
  fields you support, not an opaque blob.
- Never let a controller act as a privilege bridge. The controller's RBAC is a
  ceiling on what any user of the CRD can cause, so keep it minimal, and see
  [controllers and operators](controllers-and-operators.md#security-considerations).
- Let Pod Security Admission have the last word. The namespace the controller
  creates pods in should be `restricted`, so a smuggled `privileged: true` is
  rejected at pod-creation time regardless of what the CRD allowed.

**Verify.** Create a custom resource with a deliberately unknown field under
the preserved node, read the stored object back, and confirm it is gone:

```bash
kubectl -n tasklane get taskqueue tasklane-worker -o jsonpath='{.spec}'
```

If the field survives, that node is not being pruned and the schema is wrong.
Then check the resulting pod: a namespace labelled
`pod-security.kubernetes.io/enforce: restricted` should have rejected it.

Separately: `taskqueues/status` is a distinct RBAC resource. Grant it to the
controller and to nobody else. A user who can write status can lie to every
other controller that reads it.

## Troubleshooting

**`kubectl get taskqueues` says the server doesn't have a resource type.**
Either the CRD is not `Established` yet, or your kubectl discovery cache is
stale. Check `kubectl get crd taskqueues.tasklane.example.com -o
jsonpath='{.status.conditions}'` first.

**A field I set disappears.** Pruning. The schema does not declare it, or
declares it at a different nesting level. Compare what you applied with
`kubectl get -o yaml`, and remember the API server will not warn you.

**`updates to this version are not allowed` on a CEL rule.** A transition rule
fired. Look for `self == oldSelf` in the schema; the object is immutable in
that field by design.

**The CRD will not accept a new schema.** The API server rejects structural
schema violations at write time and the message names the offending path. The
most common cause is a `properties` block with no `type`.

**I cannot remove an old version.** `status.storedVersions` still lists it. Run
a StorageVersionMigration for the resource, then re-check.

**CEL rule rejected as too expensive.** The estimator ran over budget. Add
`maxItems`/`maxLength` to the fields the rule walks, or narrow the rule.

## Common mistakes

- Treating a CRD as behaviour. Applying a CRD gives you storage. Nothing
  happens until a controller exists.
- Copying a tutorial that uses the long-removed beta version of the
  `apiextensions.k8s.io` group. The only version that exists now is `v1`.
- Hand-editing generated CRD YAML, then regenerating it and losing the edit.
- Using `status` without the status subresource, so every user `apply` wipes
  the controller's status and `metadata.generation` never moves.
- Setting `storage: true` on two versions, or on none. Exactly one.
- Putting a required field with no default into `v1alpha1` after users exist.
  Every existing object becomes invalid on its next write.
- Deleting and recreating a CRD to "reset" it during a debugging session,
  taking every object with it.
- Using a preserved-unknown-fields blob because the schema was tedious to
  write, and inheriting the security hole in the section above.

## Related topics

- [Controllers and operators](controllers-and-operators.md)
- [Aggregated APIs](aggregated-apis.md)
- [Admission policies with CEL](admission-policies-cel.md)
- [Admission webhooks](admission-webhooks.md)
- [Helm chart development](helm-chart-development.md)
- [Multi-tenancy](multi-tenancy.md)
- [Declarative model and reconciliation](../k8s-beginner/declarative-model-and-reconciliation.md)
