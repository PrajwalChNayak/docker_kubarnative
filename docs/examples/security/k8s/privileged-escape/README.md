# Privileged pod escape

## Threat

A workload in the cluster requests `privileged: true`, `hostPID: true` and a
`hostPath` mount of the node root filesystem.

## Why it is dangerous

A privileged container runs with all Linux capabilities and essentially no
isolation from the node. That is **node-level root**. The blast radius is the
whole node and everything scheduled on it:

- It can read every other pod's mounted Secrets and volumes on that node.
- It can reach the **kubelet's credentials** and the node's client
  certificate, then act against the API server with the node's identity.
- `hostPID` exposes and lets it signal every process on the node; the
  `hostPath` mount of `/` exposes the entire node disk.

One over-permissioned pod therefore becomes a foothold on the node and a
pivot toward the rest of the cluster. (No breakout command sequence is shown
here; the point is the capability an attacker gains, not how to drive it.)

## Control

Two layers:

1. **Pod Security Admission, `restricted`** on every application namespace.
   `restricted` forbids `privileged`, host namespaces and `hostPath`, so the
   pod is rejected at admission before it is ever scheduled.
2. **A policy engine rule** (`policy-kyverno.yaml`) as defence in depth:
   it blocks privileged and host-namespace pods cluster-wide, catching
   namespaces that were never labelled and giving a central, audited denial.

That a namespace needs `enforce=privileged` (as `escape-vuln` does) to admit
this pod at all is itself the warning: if you find that label on an
application namespace, treat it as a finding.

## Files

| File | Role |
|---|---|
| `namespaces.yaml` | `escape-vuln` (enforce=privileged) and `escape-safe` (enforce=restricted). |
| `vulnerable-pod.yaml` | The privileged/hostPID/hostPath pod. Only admitted in `escape-vuln`. |
| `fixed-pod.yaml` | The hardened equivalent, admitted in `escape-safe`. |
| `reject-check.yaml` | The vulnerable pod aimed at `escape-safe`; must be rejected. |
| `policy-kyverno.yaml` | Cluster-wide Kyverno backstop. Requires Kyverno. |

## Verify

Show that the hardened namespace **rejects** the privileged pod:

```bash
kubectl apply -f examples/security/k8s/privileged-escape/namespaces.yaml
kubectl apply -f examples/security/k8s/privileged-escape/reject-check.yaml
```

The second command fails with a `violates PodSecurity "restricted:v1.37"`
error listing `privileged`, `hostPID` and the `hostPath` volume. The hardened
pod, by contrast, is admitted:

```bash
kubectl apply -f examples/security/k8s/privileged-escape/fixed-pod.yaml
```
