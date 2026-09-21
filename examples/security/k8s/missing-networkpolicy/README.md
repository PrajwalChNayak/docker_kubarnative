# Missing NetworkPolicy

## Threat

A namespace runs workloads with **no NetworkPolicy** at all.

## Why it is dangerous

The Kubernetes default is a flat network: every pod can open a connection to
every other pod, in every namespace, on every port. Nothing stops lateral
movement. A single compromised pod can then scan the cluster and reach
databases, admin endpoints, metrics ports and the control plane's in-cluster
services that were never meant to be exposed to it. The absence of a policy is
the vulnerability — there is no "allow" to remove, only reachability nobody
intended.

## Control

Adopt **default-deny** per namespace, then add explicit allows for the flows
the application actually needs:

1. A `default-deny` policy selecting all pods, denying both ingress and egress.
2. `allow-dns-egress` so name resolution still works.
3. Narrow allows such as `allow-client-to-server` that open exactly one path.

NetworkPolicy is enforced by the **CNI plugin**, not the API server, so the
cluster's CNI must support it. Deny rules and allow rules are additive: a
connection is permitted only if some policy allows it on both the egress and
ingress side.

## Files

| File | Role |
|---|---|
| `namespace.yaml` | `netpol-demo`, restricted. |
| `workloads.yaml` | `server` (Service + Deployment on :8080), `client-allowed`, `client-denied`. |
| `fixed-networkpolicy.yaml` | default-deny + DNS + the single allowed path. |

## Verify reachability is blocked

Deploy the workloads with **no** policy first and confirm both clients reach
the server (the vulnerable state):

```bash
kubectl apply -f examples/security/k8s/missing-networkpolicy/namespace.yaml
kubectl apply -f examples/security/k8s/missing-networkpolicy/workloads.yaml
kubectl -n netpol-demo wait --for=condition=Ready pod/client-allowed pod/client-denied --timeout=60s
kubectl -n netpol-demo exec client-denied -- wget -qO- --timeout=3 http://server:8080/
```

Now apply default-deny and re-probe. `client-allowed` still works;
`client-denied` times out because no policy permits its traffic:

```bash
kubectl apply -f examples/security/k8s/missing-networkpolicy/fixed-networkpolicy.yaml
kubectl -n netpol-demo exec client-allowed -- wget -qO- --timeout=3 http://server:8080/   # connects
kubectl -n netpol-demo exec client-denied  -- wget -qO- --timeout=3 http://server:8080/   # times out
```

A non-zero exit and a timeout on `client-denied` is the proof the lateral path
is closed.
