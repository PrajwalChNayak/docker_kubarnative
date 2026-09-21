# Policy engines: one rule, three implementations

The same admission rule — **no `:latest` (or untagged) container image** —
written for each of the three enforcement mechanisms, so you can compare them
directly. The comparison and "when to use which" live on the
[policy-engines](../../../content/k8s-security/policy-engines.md) page.

| File | Engine | Install? |
|---|---|---|
| `vap-disallow-latest.yaml` | Built-in ValidatingAdmissionPolicy (CEL) | none — API server built-in |
| `kyverno-disallow-latest.yaml` | Kyverno `ClusterPolicy` (YAML patterns) | Kyverno |
| `gatekeeper-disallow-latest.yaml` | OPA Gatekeeper `ConstraintTemplate` + `Constraint` (Rego) | Gatekeeper |

## Notes

- The **VAP** needs no controller and cannot fail open if a webhook pod is
  down, but it can only **validate** (and mutate, via MutatingAdmissionPolicy);
  it cannot generate resources or verify image signatures.
- **Kyverno** adds mutate, generate and `verifyImages` (cosign) and is written
  in YAML. See `examples/k8s/policy/../security/k8s/unsigned-image/` for its
  signature-verification form.
- **Gatekeeper** uses Rego and a template/constraint split; the constraint kind
  (`K8sDisallowedTags`) is a CRD the template generates, so it exists only after
  the template is applied.

## Verify

Applying any of the three, then creating a pod with `image: busybox:latest`,
is rejected at admission; `image: busybox:1.37` is admitted. Capture commands
are in `captures/requests/k8s-security.txt`.

:::note
`gatekeeper-disallow-latest.yaml`'s `Constraint` (`K8sDisallowedTags`) has no
static schema until Gatekeeper generates its CRD, so kubeconform validation
skips that one kind with `-ignore-missing-schemas`.
:::
