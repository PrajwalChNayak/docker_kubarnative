---
title: Admission policies with CEL
description: ValidatingAdmissionPolicy and MutatingAdmissionPolicy — enforcing and defaulting inside the API server, with no webhook to run.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-advanced/admission-webhooks
  - k8s-advanced/custom-resource-definitions
---

## Overview

An admission policy is a rule written in CEL and evaluated inside the API
server process. There is no pod, no Service, no certificate and no network hop.
You apply two objects — a policy and a binding — and the rule is live.

Two kinds exist, both in `admissionregistration.k8s.io/v1`:

- **ValidatingAdmissionPolicy**, **GA since 1.30**. Rejects, warns about, or
  audits writes.
- **MutatingAdmissionPolicy**, **GA since 1.36 and enabled by default**.
  Changes writes, using a server-side-apply configuration or a JSON patch
  expressed in CEL.

They cover the large majority of what organisations install
[admission webhooks](admission-webhooks.md) for, at a fraction of the
operational cost. Where they cannot help is anything needing outside
information: a policy cannot call a signature service or read a database.

## Why it exists and when to use it

The honest motivation is that admission webhooks are a bad deal for simple
rules. "Every Deployment must have an owner label" does not need a highly
available HTTPS service with a rotating certificate, yet that is what it used
to cost.

| Question about the write | Policy can answer |
|---|---|
| Is this field set? Is it in range? Consistent with that field? | Yes |
| Did this field change from its old value? | Yes, via `oldObject` |
| What labels does the namespace have? | Yes, via `namespaceObject` |
| Who is the requester, and what may they do? | Yes, via `request.userInfo` and `authorizer` |
| Is this image signed? Does this licence exist? Is this IP in our CMDB? | No — use a webhook |
| Does it need state from a previous request? | No — use a webhook |

Reach for a policy first. Fall back to a webhook only when the rule genuinely
needs something outside the request.

## How it works underneath

### Three objects, not one

A complete policy is up to three resources:

1. The **policy** holds the abstract logic: "the replica count must not exceed
   the limit".
2. An optional **parameter resource** makes it concrete: "the limit is 3". It
   is any API object — a ConfigMap, or a custom resource whose kind the policy
   names in `spec.paramKind`.
3. The **binding** ties them together and scopes them: which namespaces, which
   parameter, and what a failure does.

A policy with no binding does nothing at all. That separation is the feature:
one policy, many bindings, different parameters and different enforcement per
environment.

### Where they run

Policies run in the same two phases as webhooks. MutatingAdmissionPolicies
run in the mutating phase, before the API server validates the object against
its schema; ValidatingAdmissionPolicies run in the validating phase, after it.
Because the API server evaluates them in process, there is no timeout, no
`sideEffects` declaration and no certificate.

Certain kinds are exempt, to stop a policy locking the cluster out of its own
control path: ValidatingAdmissionPolicies, ValidatingAdmissionPolicyBindings,
MutatingAdmissionPolicies and MutatingAdmissionPolicyBindings cannot be
intercepted by policies created through the REST API. Virtual authentication
and authorisation kinds — TokenReview, SubjectAccessReview and their
self-subject relatives — are exempt from all policies, and **starting with
1.37 admission webhooks exclude them by default too**.

### The CEL environment

Every expression has the same variables available:

| Variable | Meaning |
|---|---|
| `object` | The incoming object. `null` on DELETE. |
| `oldObject` | The existing object. `null` on CREATE. |
| `request` | Attributes of the admission request, including `request.userInfo`. |
| `params` | The bound parameter resource. `null` if the policy has no `paramKind` or the binding no `paramRef`. |
| `namespaceObject` | The namespace as an object. `null` for cluster-scoped resources. |
| `variables` | Named expressions from `spec.variables`, evaluated lazily and memoised. |
| `authorizer` | An authorisation checker for the requester. |

`object` is strongly typed against the matched schema, so `object.spec.replicas`
is an integer, and `spec.matchConstraints` is what the type checker checks
against.

### validationActions

The binding's `validationActions` list decides what a failed validation does:

- `Deny` — the request is rejected.
- `Warn` — the client receives an HTTP warning; the write succeeds.
- `Audit` — the failure is recorded in the audit event for the request.

`Deny` and `Warn` may not be combined, because that would report the same
failure twice. `[Warn, Audit]` is the rollout setting and `[Deny]` is the
enforcement setting; moving between them is a one-line change to the binding,
with the policy untouched.

Failures caused by `failurePolicy` — that is, errors rather than a rule
returning false — are only enforced when `failurePolicy` is `Fail`, which is
the default.

### Type checking

When a policy is created or updated, the API server parses every expression and
rejects syntax errors outright. It then type-checks the expressions against the
types in `spec.matchConstraints` and records the result in
`status.typeChecking`. An empty `status.typeChecking` means no errors were
found; a populated `expressionWarnings` list names the field and the CEL error.

Type checking is advisory: a policy with warnings is still stored and still
evaluated. It also has limits worth knowing — wildcards in `matchConstraints`
are not checked, at most 10 matched types are checked, and custom resources are
not type-checked at all.

## Basic example

A validating policy for Tasklane workloads, and its binding:

```yaml include="examples/admission/validatingadmissionpolicy.yaml"
```

A mutating policy that stamps a default ownership label on workloads created
without one:

```yaml include="examples/admission/mutatingadmissionpolicy.yaml"
```

Both are safe to check against the live API server without writing anything:

```bash
kubectl apply --dry-run=server -f examples/admission/
```

```console include="captures/k8s-advanced/admission-dry-run.txt"
```

## Explanation

### Variables earn their keep

`spec.variables` are named expressions, evaluated lazily on first reference and
memoised, so their cost is counted once however many validations use them. The
validating policy uses three: one that concatenates containers and init
containers, one that maps them to image strings, and one that extracts the last
slash-separated component of each image.

That last one is not fussiness. The tag or digest can only appear in the final
component of an image reference, so splitting on `/` and looking at the end is
what stops `registry.example.com:5000/tasklane-api` being read as a tagged
image because of the port.

### Conditions before validations

`matchConditions` excludes requests from kube-system service accounts. Match
conditions are filters, not rules: if one is false the policy is skipped
entirely. This matters because control-plane controllers rewrite workloads
during normal operation, and a label policy that blocks them is an outage
wearing a policy's clothes.

If a match condition *errors*, the policy is not evaluated, and whether the
request is rejected depends on `failurePolicy`: `Fail` rejects it without
evaluating the policy, `Ignore` lets it through.

### messageExpression

`message` is a fixed string. `messageExpression` is CEL that must evaluate to a
string, and it takes precedence when both are set, falling back to `message` if
it fails to evaluate or produces a multi-line result. The difference in a
terminal is the difference between "image not allowed" and a message naming the
offending images. Error messages are a user interface.

### Audit annotations

`auditAnnotations` attach key/value pairs to the audit event, prefixed with the
policy name. They are how you answer "who would this policy have denied?"
before you switch the binding to `Deny`: run with `[Warn, Audit]`, query the
audit log for the annotation, fix the offenders, then enforce.

### Type checking in practice

After applying the policy, the API server reports what it made of the
expressions:

```bash
kubectl get validatingadmissionpolicy tasklane-workload-hygiene.tasklane.example.com -o jsonpath='{.status}'
```

```console include="captures/k8s-advanced/admission-vap-typechecking.txt"
```

### Mutations must be idempotent

The mutating policy uses `patchType: ApplyConfiguration`, which merges with
server-side apply semantics: writing one key into `metadata.labels` leaves
every other label alone. The alternative, `JSONPatch`, needs the path to exist
and is the right choice for list operations and conditional patches, which
CEL's `JSONPatch` type supports with `op`, `from`, `path` and `value`.

`reinvocationPolicy: IfNeeded` asks the API server to run the policy again if a
later mutation changed the object. That is only safe because this mutation
always writes the same value. The rule for mutating policies is identical to
the rule for mutating webhooks: ensure, never append.

Note what the mutating binding does *not* have: `validationActions`. There is
nothing to warn about in a mutation.

### Parameters

Neither example uses `paramKind`, deliberately — a policy without parameters is
simpler and this one needs none. When you do use them, two details bite:

- `paramRef.parameterNotFoundAction` is required. `Allow` treats "no parameter
  found" as a pass; `Deny` subjects it to the policy's `failurePolicy`.
- If the binding's `paramRef` sets no `namespace` and the parameter kind is
  namespaced, the API server looks in the namespace of the object being
  admitted. That enables per-namespace limits from a single binding, and
  surprises people who expected a cluster-wide lookup.

Because `params` is `null` when nothing is bound, policies that require a
parameter should start with a validation of `params != null`.

## Common patterns

**Warn, then deny.** Ship every new policy with `[Warn, Audit]`. Let it run for
a release. Query the audit annotations. Then change the binding to `[Deny]`.
The policy object never changes, so the diff under review is one line.

**One policy, several bindings.** Bind the same policy to `test` namespaces
with a permissive parameter and to `prod` namespaces with a strict one. The
rule is written once.

**Replace webhooks incrementally.** Take the rules out of an existing
validating webhook one at a time, express each as a policy, and shrink the
webhook's `rules` as you go. When it matches nothing, delete it.

**Use policies as guardrails around operators.** A policy is a good way to stop
an [operator](controllers-and-operators.md) or a GitOps controller writing
something it should not, without modifying either.

**Let the CRD do CRD work.** If the rule is about your own custom resource,
`x-kubernetes-validations` in the
[CRD schema](custom-resource-definitions.md#how-it-works-underneath) is closer
to the data and does not need a binding. Policies are for resources you do not
own.

## Production considerations

Policies cost API server CPU on every matching write, in the same process that
serves every other request. That is cheaper than a network hop but not free.
Keep `matchConstraints` narrow and prefer `matchConditions` over long
validations, because a skipped policy costs nothing.

A policy with `failurePolicy: Fail` that errors on every request will reject
every matching write, exactly as a dead webhook would. In-process does not mean
risk-free; it means one fewer moving part.

What you lose compared with a webhook is a place to put logs. A policy has no
stdout. Your observability is the audit log, the HTTP warnings and
`status.typeChecking`, so instrument with `auditAnnotations` from the start.

Policies are cluster-scoped objects and should be managed by GitOps like any
other cluster configuration. `kubectl get validatingadmissionpolicies` should
match what is in the repository; anything else is drift or an intrusion.

The lab cluster already has policies in it, because the Gateway API standard
bundle ships one:

```bash
kubectl get validatingadmissionpolicies,validatingadmissionpolicybindings
```

```console include="captures/k8s-advanced/admission-existing-policies.txt"
```

## Security considerations

**Threat.** Policies are cluster-wide security controls stored as ordinary API
objects. Whoever can write them can rewrite the rules — or, with a mutating
policy, rewrite the objects.

**Exploit.** A user with `update` on `mutatingadmissionpolicies` changes the
Tasklane label-defaulting policy so that its apply configuration also sets a
field of their choosing on every Deployment created in the cluster. Nothing in
the audit log looks like an attack: the writes come from the users creating the
Deployments, and the policy's own change is a single innocuous-looking patch.
The mirror-image attack on a validating policy is quieter still: flip the
binding from `[Deny]` to `[Audit]` and the control is gone while the object
still exists, so an inventory check that only looks for the policy's presence
still passes.

**Fix.**

- Treat `validatingadmissionpolicies`, `mutatingadmissionpolicies` and both
  binding kinds as cluster-admin resources. Nobody outside the platform team
  gets `create`, `update` or `patch`.
- Manage them from Git and alert on drift. The check must compare
  `validationActions`, not just the object's existence.
- Use the `authorizer` variable rather than reimplementing authorisation in
  CEL. It asks the real authoriser.
- Do not put secrets in `messageExpression` or `auditAnnotations`. Both are
  returned to clients or written to the audit log, and both can read the whole
  object — including a Secret's `data` if the policy matches Secrets.
- Remember that policies cannot protect the policy API from itself, by design.
  Protect it with RBAC.

**Verify.**

```bash
kubectl auth can-i create validatingadmissionpolicies --as=system:serviceaccount:tasklane:tasklane-api
kubectl get validatingadmissionpolicybindings -o custom-columns='NAME:.metadata.name,POLICY:.spec.policyName,ACTIONS:.spec.validationActions'
```

The first must answer `no`. The second shows, for every binding in the
cluster, whether it actually denies anything.

## Troubleshooting

**The policy does nothing.** Almost always a missing or mis-scoped binding.
Check the binding exists, that `policyName` matches exactly, and that the
`namespaceSelector` matches the namespace you are testing in.

**It denies things it should not.** Check `matchConstraints` first — a
`resources: ["*"]` entry matches subresources too. Then check whether
`matchConditions` is doing less filtering than you think.

**"failed expression" with no useful message.** No `message` or
`messageExpression` is set, so the API server echoes the expression. Add a
`messageExpression`.

**`status.typeChecking` has warnings.** A field reference does not exist on one
of the matched types, usually `object.replicas` where `object.spec.replicas`
was meant. The policy still runs and will fail at evaluation time.

**A rule works on CREATE and errors on UPDATE, or vice versa.** `oldObject` is
`null` on CREATE and `object` is `null` on DELETE. Guard with `oldObject !=
null` or restrict `operations`.

**"no such key" errors on optional fields.** Use `has()` before reading an
optional field, and `in` to test map membership. `has(object.metadata.labels)
&& 'x' in object.metadata.labels` is the idiom.

**A mutation is applied repeatedly or conflicts with another.** Check
`reinvocationPolicy` and make the mutation idempotent.

## Common mistakes

- Writing the policy and forgetting the binding.
- Going straight to `[Deny]` in production without an audit period.
- Trying to combine `Deny` and `Warn`, which is rejected.
- Omitting `paramRef.parameterNotFoundAction`, which is required.
- Reading a field without `has()` and getting evaluation errors on objects
  that omit it.
- Assuming a policy sees custom resources' types — type checking does not cover
  CRDs.
- Reimplementing a rule in CEL that `x-kubernetes-validations` on your own CRD
  would have enforced closer to the data.
- Expecting logs. There are none; use audit annotations.
- Leaving `matchConstraints` wide and paying API server CPU on every write in
  the cluster.

## Related topics

- [Admission webhooks](admission-webhooks.md)
- [Custom Resource Definitions](custom-resource-definitions.md)
- [Controllers and operators](controllers-and-operators.md)
- [Aggregated APIs](aggregated-apis.md)
- [Multi-tenancy](multi-tenancy.md)
- [GitOps with Argo CD](gitops-argo-cd.md)
