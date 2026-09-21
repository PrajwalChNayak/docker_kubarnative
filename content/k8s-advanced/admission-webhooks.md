---
title: Admission webhooks
description: Where admission sits in an API request, what each webhook field really controls, and why a webhook is the riskiest thing you can install in a cluster.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-beginner/manifest-anatomy
  - k8s-advanced/custom-resource-definitions
---

## Overview

An admission webhook is an HTTPS endpoint the API server calls, synchronously,
in the middle of handling a write. It is handed an `AdmissionReview` describing
the request and answers "allowed" or "not allowed", optionally with a JSON
patch. Nothing is stored until it replies.

That is enormous power and a matching liability. Every webhook you register is
a distributed system component sitting on the critical path of API writes, with
its own certificate, availability and latency budget. Kubernetes has spent
several releases building in-process CEL alternatives —
[ValidatingAdmissionPolicy and MutatingAdmissionPolicy](admission-policies-cel.md)
— precisely because so many webhooks exist to enforce rules that never needed a
server.

This page covers the mechanism and the fields. Read it to understand webhooks
you already have, and to be sure you need a new one before you write it.

## Why it exists and when to use it

Admission is the only place to enforce a rule on every write, whatever the
client. RBAC answers "may this user touch this resource"; admission answers "is
this particular object acceptable". Defaulting, injection, cross-object checks
and policy all live here.

Use a webhook when the decision needs something the API server does not have:

- state from outside the cluster (an image signature, a licence server, a CMDB)
- expensive or stateful computation
- a mutation too complex to express as an apply configuration

Use an in-process policy when the decision is a function of the object, the
old object, the namespace and the requester. That covers most real policies,
runs with no network hop, and cannot take the cluster down when a pod crashes.

| | Webhook | CEL policy |
|---|---|---|
| Runs in | Your pod | The API server process |
| Can call out to other systems | Yes | No |
| Extra failure domain | Yes | No |
| Certificates to rotate | Yes | No |
| Latency | A network round trip | In-process evaluation |
| Mutation | Arbitrary JSON patch | Apply configuration or JSON patch from CEL |

## How it works underneath

An API write passes through a fixed pipeline:

1. **Authentication.** Who is this?
2. **Authorisation.** May they do this, per RBAC and any other authorizer?
3. **Mutating admission.** Built-in mutating plugins, MutatingAdmissionPolicies
   and mutating admission webhooks may change the object.
4. **Object validation.** The API server validates the resulting object against
   its own schema. The documentation is explicit: "After all object
   modifications are complete and the incoming object is validated by the API
   server, validating admission webhooks are invoked".
5. **Validating admission.** Built-in validating plugins,
   ValidatingAdmissionPolicies and validating admission webhooks may reject the
   request. None of them may change the object.
6. **Storage.** The object is written to etcd.

Two properties of that pipeline drive everything else:

**Mutating webhooks run in an order you do not control, and may run more than
once.** If any webhook mutates the object, webhooks with
`reinvocationPolicy: IfNeeded` are called again with the mutated object. The
documentation's own summary is that "mutations by mutating webhooks cause all
previously called webhooks to be called again". So every mutating webhook must
be idempotent: adding a sidecar must be "ensure this sidecar exists", never
"append this sidecar". `reinvocationPolicy` defaults to `Never`.

**Validating webhooks are called in parallel and none of them can mutate.** By
the time they run, the object is final. A validating webhook that "fixes"
something has no way to say so.

### Matching: which requests reach the webhook

Four filters run before the network call, cheapest first:

- `rules` — apiGroups, apiVersions, operations, resources, `scope`.
- `namespaceSelector` and `objectSelector` — label selectors on the namespace
  and on the object.
- `matchConditions` — CEL expressions evaluated by the API server, with access
  to `object`, `oldObject`, `request` and `authorizer`.
- `matchPolicy` — `Exact` (the default) or `Equivalent`. `Exact` matches only
  the literal group/version in `rules`. `Equivalent` also matches a request
  that arrives under a different served version of the same resource and
  converts it. `Exact` is a classic way to leave a policy hole open.

Everything filtered out here costs zero round trips, which is the cheapest
latency optimisation a webhook has.

### Failure behaviour

- `failurePolicy: Fail` (the default) rejects the request when the webhook
  errors, is unreachable or times out. `Ignore` admits it.
- `timeoutSeconds` defaults to 10 and may not exceed 30.
- `sideEffects` declares whether the webhook changes state outside the
  `AdmissionReview`. Allowed values are `None`, `NoneOnDryRun`, `Some` and
  `Unknown`. Only `None` and `NoneOnDryRun` are compatible with
  `--dry-run=server`; anything else causes the API server to refuse the dry
  run rather than risk the side effect.

There is no safe value of `failurePolicy`. `Fail` turns a webhook outage into a
cluster-wide write outage; `Ignore` turns it into a silent policy bypass. For a
security control, choose `Fail` and then engineer the availability to match.

### Certificates

The API server is the client. It needs to trust the webhook's serving
certificate, which must be valid for `<service>.<namespace>.svc`. The CA that
signed it goes in `clientConfig.caBundle`.

Hand-managed certificates expire at 3 a.m. The normal answer is cert-manager
(v1.21.2 at the time of writing): a Certificate resource issues the serving
cert into a Secret, and the CA injector watches objects annotated with
`cert-manager.io/inject-ca-from` and rewrites `caBundle` whenever the CA
rotates.

## Basic example

An annotated ValidatingWebhookConfiguration. **This file is illustration only**
— it points at a Service that does not exist:

```yaml include="examples/admission/webhook-illustration/validatingwebhookconfiguration.yaml"
```

:::danger Do not apply this to a cluster you care about
The API server will accept the object and then start calling a webhook that is
not there. With `failurePolicy: Fail`, every matching Deployment and
StatefulSet write in the cluster is rejected until you delete the
configuration. A server-side dry run *succeeds*, because the API server
validates the configuration without dialling the webhook — which is exactly why
this file lives in its own directory, outside the `--dry-run=server` sweep over
`examples/admission/`.
:::

What the cluster is already running is worth looking at before you add to it:

```bash
kubectl get validatingwebhookconfigurations,mutatingwebhookconfigurations
```

```console include="captures/k8s-advanced/admission-webhook-configs.txt"
```

And the full set of admission kinds the 1.37 API server serves:

```bash
kubectl api-resources --api-group=admissionregistration.k8s.io
```

```console include="captures/k8s-advanced/admission-api-resources.txt"
```

## Explanation

Read the example from the top down as a series of blast-radius decisions.

`rules` says apps/v1 Deployments and StatefulSets on CREATE and UPDATE. Every
other write in the cluster never touches this webhook. Widening this to
`resources: ["*"]` is how a webhook ends up in the path of Lease renewals and
node heartbeats.

`namespaceSelector` excludes `kube-system` and the webhook's own namespace. The
`kubernetes.io/metadata.name` label is set automatically on every namespace, so
it can be selected on without cooperation from whoever created it. This
exclusion is not a nicety: without it, a webhook that is down cannot be fixed
by redeploying it, because the redeploy is itself a write the dead webhook must
approve.

`matchConditions` skips requests from kube-system service accounts and from the
Tasklane operator. Control-plane controllers rewrite objects during normal
operation, and blocking them converts a label policy into an outage.

`timeoutSeconds: 5`, not the default 10. If the webhook cannot answer in five
seconds it is not healthy, and ten seconds of added latency on every Deployment
write is its own incident.

`sideEffects: None` is a promise, and the API server holds you to it: it is
what allows `kubectl apply --dry-run=server` to consult this webhook at all.

## Common patterns

**Prefer a policy.** Before writing a webhook, check whether the rule is a
function of the object. If it is, write a ValidatingAdmissionPolicy instead and
delete a whole component from your architecture.

**Narrow, then narrow again.** Scope by resource, then namespace label, then
`matchConditions`. Most webhooks match ten to a hundred times more requests
than they need.

**Idempotent mutations only.** Write "ensure X" logic. Set
`reinvocationPolicy: IfNeeded` only if your webhook must see other webhooks'
mutations, and accept that it will then be called repeatedly.

**Ship the webhook with its certificate automation.** A cert-manager
Certificate plus `cert-manager.io/inject-ca-from` on the webhook
configuration, in the same chart.

**Namespace opt-in during rollout.** Start with a `namespaceSelector` matching
one label, apply the label to one namespace, and widen it. A webhook that
matches everything on day one has no rollback smaller than deletion.

## Production considerations

Run at least two replicas across nodes, with a PodDisruptionBudget. A webhook
with one replica has scheduled outages every time its node drains, and with
`failurePolicy: Fail` those are cluster write outages.

Keep the webhook out of its own path. It must not be gated by itself, and
ideally it should not depend on anything in the cluster it gates. The
control-plane namespaces stay excluded permanently.

Budget the latency. Every matching write pays the round trip, and writes are
often in a user's `kubectl apply` or a controller's reconcile loop. Watch
`apiserver_admission_webhook_admission_duration_seconds` and the rejection
counters.

Plan the failure drill. Delete the webhook's Deployment in a test cluster and
observe exactly which operations stop working. If the answer is "we do not
know", you do not have an incident runbook.

Upgrades are your problem. The beta versions of the
`admissionregistration.k8s.io` group were removed back in 1.22 and the
configuration API has been `v1` ever since, so the registration objects are
stable. The objects your webhook *inspects* are not: they change every release,
and a webhook that parses a PodSpec must be rebuilt against new API libraries.

## Security considerations

**Threat.** A webhook is a cluster-wide man-in-the-middle for API writes. An
attacker who can create or edit a `ValidatingWebhookConfiguration` or a
`MutatingWebhookConfiguration` owns the cluster's write path, and an attacker
who can reach an existing webhook's pod owns whatever that webhook decides.

**Exploit.** Two concrete ones.

First, *policy bypass by mutation*: register a mutating webhook matching
`pods` on CREATE that adds `privileged: true` to any container in a namespace
the attacker controls. Pod Security Admission runs as a validating plugin, so
the mutation happens first — but the namespace label is what saves you here,
because a `restricted` namespace still rejects the result. In a namespace with
no PSA label, nothing does.

Second, *exfiltration*: register a validating webhook with `rules` matching
`secrets` on CREATE and UPDATE, `failurePolicy: Ignore` and
`sideEffects: Unknown`, pointing at a URL the attacker controls. It approves
everything, so nobody notices, and it receives the full body of every Secret
written in the cluster. `failurePolicy: Ignore` makes the attack invisible even
when the endpoint is unreachable.

**Fix.**

- Treat `validatingwebhookconfigurations` and
  `mutatingwebhookconfigurations` as cluster-admin resources. `create`,
  `update` and `patch` on them are equivalent to cluster-admin; audit who has
  them.
- Label every namespace with a Pod Security Admission level, so a mutation
  cannot manufacture a privileged pod.
- Use `clientConfig.service`, not `clientConfig.url`. A Service reference keeps
  the call inside the cluster; a URL can point anywhere on the internet.
- Alert on creation of any webhook configuration. In a GitOps cluster there
  should be a short, known list, and an unexpected entry is an incident.

**Verify.**

```bash
kubectl get validatingwebhookconfigurations,mutatingwebhookconfigurations -o custom-columns='KIND:.kind,NAME:.metadata.name'
kubectl auth can-i create mutatingwebhookconfigurations --as=system:serviceaccount:default:default
```

The second must answer `no`. Then check every configuration's `clientConfig`
for a `url` field rather than a `service`, and check `sideEffects` on anything
that touches Secrets.

## Troubleshooting

**Everything I apply fails with "failed calling webhook".** The webhook is
unreachable and `failurePolicy` is `Fail`. Check the backing Service has
endpoints. If the cluster is wedged, deleting the webhook configuration is the
emergency exit; note that deleting it is itself a write, so it must not be
matched by the webhook.

**x509 errors in the API server log.** The `caBundle` does not match the
serving certificate, or the certificate is not valid for
`<service>.<namespace>.svc`. If cert-manager's CA injector manages it, check
the `cert-manager.io/inject-ca-from` annotation names an existing Certificate.

**The webhook is never called.** Usually `matchPolicy: Exact` against a
different served version, a `namespaceSelector` that does not match, or a
`matchConditions` expression that is false. Add a temporary log line in the
webhook, and check the API server's admission metrics for that webhook name.

**`--dry-run=server` refuses to run.** A matching webhook declares
`sideEffects: Some` or `Unknown`. Fix the declaration if it is wrong, or accept
that dry run cannot be offered for those resources.

**Pods take a long time to create.** Sum the webhook timeouts on the pod path.
Several webhooks at the default 10 seconds each add up fast.

**A mutation is applied twice.** The webhook is being reinvoked and is not
idempotent. Make it check before it appends.

## Common mistakes

- Matching `resources: ["*"]` and putting the webhook in the path of Leases,
  Events and node status updates.
- Leaving `matchPolicy` at `Exact` and assuming all versions are covered.
- Forgetting to exclude `kube-system` and the webhook's own namespace, and
  then being unable to redeploy the thing that is down.
- One replica, no PodDisruptionBudget, `failurePolicy: Fail`.
- Declaring `sideEffects: None` while writing to a database.
- A mutating webhook that appends rather than ensures, producing duplicate
  sidecars after reinvocation.
- Hand-issued certificates with no rotation.
- Writing a webhook at all for a rule that is a pure function of the object.

## Related topics

- [Admission policies with CEL](admission-policies-cel.md)
- [Custom Resource Definitions](custom-resource-definitions.md)
- [Controllers and operators](controllers-and-operators.md)
- [Aggregated APIs](aggregated-apis.md)
- [Multi-tenancy](multi-tenancy.md)
- [cert-manager](../k8s-intermediate/cert-manager.md)
