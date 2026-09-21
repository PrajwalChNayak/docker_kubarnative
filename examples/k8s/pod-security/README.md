# Pod Security Admission demo

`namespace.yaml` labels `psa-demo` to **enforce** the `restricted` profile
(plus `warn` and `audit`), version-pinned to `v1.37`.

| File | Expected result |
|---|---|
| `compliant-pod.yaml` | Admitted. Carries every field `restricted` requires. |
| `noncompliant-pod.yaml` | **Rejected at admission.** Requests `privileged`, runs as root, drops no capabilities. Marked `expect=reject`. |

## Apply

```bash
kubectl apply -f examples/k8s/pod-security/namespace.yaml
kubectl apply -f examples/k8s/pod-security/compliant-pod.yaml     # succeeds
kubectl apply -f examples/k8s/pod-security/noncompliant-pod.yaml  # FAILS, by design
```

The rejection is the verification: the API server refuses to persist the
privileged pod and returns a `violates PodSecurity "restricted:v1.37"` error
naming each field. Nothing reaches the kubelet, so no privileged container is
ever created.

## Audit a namespace before you enforce

Turning `enforce` on in a namespace that already has workloads can break
running deployments. Check first without enforcing anything.

Dry-run a specific pod against the profile with a temporary label, using
server-side dry-run so the admission plug-in actually evaluates it but nothing
is persisted:

```bash
kubectl label --dry-run=server --overwrite ns psa-demo \
  pod-security.kubernetes.io/enforce=restricted
```

Or, less invasively, set only `warn`/`audit` on a busy namespace first and
watch the warnings and audit annotations for a release cycle. Once the
warnings stop, promote the same level to `enforce`. This is the standard
migration path off PodSecurityPolicy.
