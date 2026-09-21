# Stage 6: NetworkPolicy for the tasklane namespace

Kubernetes 1.37, `networking.k8s.io/v1`.

Default-deny both directions, then five narrow allow rules. The result: the
Gateway can reach the API, Prometheus can scrape both workloads, the API, the
worker and the nightly maintenance Job can reach PostgreSQL, everything can
resolve DNS, and nothing else in the namespace can talk to anything.

| File | Effect |
|---|---|
| `00-default-deny.yaml` | every pod, both directions, no rules |
| `10-allow-dns.yaml` | every pod → CoreDNS in kube-system, 53/UDP + 53/TCP |
| `20-postgres.yaml` | api, worker, maintenance → database, 5432/TCP (ingress side) |
| `30-api.yaml` | envoy-gateway-system Envoy pods and namespace monitoring → api :8080; api → database |
| `40-worker.yaml` | monitoring → worker :9090; worker → database |
| `50-maintenance.yaml` | maintenance CronJob (stage 7) → database |
| `debug-pod.yaml` | unlabelled pod used by the tests below |

## The CNI has to enforce it

NetworkPolicy objects are inert unless the network plugin implements them. The
lab's kind cluster runs kindnet, which ships `kube-network-policies` and does
enforce them. On a cluster whose plugin ignores NetworkPolicy the API server
still accepts every object here, `kubectl get netpol` still lists them, and
nothing at all is blocked. Test, never assume.

## Apply

```bash
kubectl apply -f examples/k8s/06-network-policy/00-default-deny.yaml
kubectl apply -f examples/k8s/06-network-policy/10-allow-dns.yaml
kubectl apply -f examples/k8s/06-network-policy/20-postgres.yaml
kubectl apply -f examples/k8s/06-network-policy/30-api.yaml
kubectl apply -f examples/k8s/06-network-policy/40-worker.yaml
kubectl apply -f examples/k8s/06-network-policy/50-maintenance.yaml
kubectl -n tasklane get networkpolicy
```

Applying `00-` on its own cuts DNS for the whole namespace, so apply the set
together. If you want to watch the outage, apply `00-` alone, run the first
test below, then apply the rest.

## Test

Nothing here needs to be true on faith. Start a pod that no policy selects:

```bash
kubectl apply -f examples/k8s/06-network-policy/debug-pod.yaml
kubectl -n tasklane wait --for=condition=Ready pod/netcheck --timeout=60s
```

DNS works for every pod in the namespace, because `10-allow-dns.yaml` selects
all of them:

```bash
kubectl -n tasklane exec netcheck -- getent hosts postgres
```

The database does not, because `20-postgres.yaml` only admits three
components, and `netcheck` is none of them:

```bash
kubectl -n tasklane exec netcheck -- pg_isready -h postgres -t 5
```

A blocked connection times out — `pg_isready` prints `no response` and exits
non-zero. That distinction matters when debugging: a *rejected* connection
fails immediately, a *dropped* one hangs until the timeout. NetworkPolicy
drops.

Now give the pod an identity the policy does admit, and try again:

```bash
kubectl -n tasklane label pod netcheck app.kubernetes.io/component=api --overwrite
kubectl -n tasklane exec netcheck -- pg_isready -h postgres -t 5
```

It now prints `accepting connections`. Labels, not IP addresses, are the
identity NetworkPolicy works with — which is also why a typo in a label is a
silent outage.

Confirm the real paths still work end to end:

```bash
curl -s http://localhost:8080/            # Gateway -> api, allowed by 30-api.yaml
kubectl -n tasklane logs deploy/tasklane-worker --tail=5
```

Clean up:

```bash
kubectl -n tasklane delete pod netcheck
```

## Reading a policy that is already in place

```bash
kubectl -n tasklane describe networkpolicy api-ingress
kubectl -n tasklane get networkpolicy -o yaml | grep -c 'kind: NetworkPolicy'
```

`kubectl describe` prints the effective rules, including the "allowing ingress
traffic" / "not affecting egress traffic" summary lines that tell you which
directions a policy actually constrains.

## Gotchas encoded in these files

- **`namespaceSelector` + `podSelector` in the same list item is an AND.** Two
  separate list items are an OR, and that difference has leaked more clusters
  than any other NetworkPolicy mistake. Compare `10-allow-dns.yaml` (one item,
  both selectors) with the two items in `30-api.yaml`.
- **Ports are the destination pod's ports**, not Service ports: 8080, not 80.
- **DNS egress is mandatory** once you deny egress by default.
- **Policies are additive.** There is no deny rule and no ordering; the union
  of everything that selects a pod is what is allowed.
- **Existing connections.** Enforcement applies to new connections; a
  long-lived connection open before the policy landed can survive. Restart the
  client when testing changes.
