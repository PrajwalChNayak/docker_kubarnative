# Admission examples

Three ways to enforce a rule at write time, in the order you should reach for
them.

| File | Kind | Runs where |
|---|---|---|
| `validatingadmissionpolicy.yaml` | ValidatingAdmissionPolicy + Binding | In the API server process (CEL) |
| `mutatingadmissionpolicy.yaml` | MutatingAdmissionPolicy + Binding | In the API server process (CEL) |
| `webhook-illustration/validatingwebhookconfiguration.yaml` | ValidatingWebhookConfiguration | A pod you have to build, run, certify and keep up |

All of these target namespaces labelled `app.kubernetes.io/part-of: tasklane`,
which the stage-1 `tasklane` namespace already carries.

## What each one does

**`validatingadmissionpolicy.yaml`** (VAP is **GA in 1.30**, group
`admissionregistration.k8s.io/v1`) rejects Deployments and StatefulSets that
have no `app.kubernetes.io/name` label, and Deployments and StatefulSets whose
container images have no tag or digest, or use a floating tag. The floating-tag
string literal lives in this file on purpose: a CEL rule needs it, and the
handbook's pages do not print it.

The binding uses `validationActions: [Warn, Audit]`. That is the rollout
setting: offending writes still succeed, but the client gets an HTTP warning
and the audit log records the failure with the policy's audit annotation. Flip
it to `[Deny]` once the audit log is quiet. `Deny` and `Warn` may not be
combined.

**`mutatingadmissionpolicy.yaml`** (MAP is **GA in 1.36**, enabled by default,
same API group) adds `tasklane.example.com/team: unknown` to Deployments and
StatefulSets created without it, using an `ApplyConfiguration` mutation so the
rest of `metadata.labels` is untouched.

**`webhook-illustration/`** is a ValidatingWebhookConfiguration annotated field
by field: `failurePolicy`, `timeoutSeconds`, `sideEffects`, `matchPolicy`, a
`namespaceSelector` that excludes `kube-system`, and `matchConditions`.

## The webhook file is illustration only

It points at a Service that does not exist. Applying it for real would leave
the API server calling a webhook that never answers; with `failurePolicy: Fail`
that rejects every matching Deployment and StatefulSet write in the cluster.

A server-side dry run of it *succeeds*, because the API server validates the
configuration object without dialling the webhook. That is exactly why it sits
in its own subdirectory: `kubectl apply --dry-run=server -f examples/admission/`
is non-recursive, so it validates the two policy files and leaves the webhook
alone.

## Try them

```bash
kubectl apply --dry-run=server -f examples/admission/
kubectl get validatingadmissionpolicy tasklane-workload-hygiene.tasklane.example.com -o yaml
```

The policies are safe to apply for real in the kind lab, because the binding
only warns. After applying, `status.typeChecking` on the policy shows whether
the API server could resolve every field the CEL expressions reference against
`apps/v1` Deployment and StatefulSet. An empty `typeChecking` means no errors.

To remove them:

```bash
kubectl delete -f examples/admission/
```
