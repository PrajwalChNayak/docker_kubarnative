---
title: Intermediate Kubernetes labs
description: Hands-on exercises for probes, storage, Gateway API, TLS, DNS and NetworkPolicy against the Tasklane cluster, each with a full solution that proves the behaviour.
level: intermediate
type: lab
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-intermediate/probes
  - k8s-intermediate/gateway-api
  - k8s-intermediate/network-policy
---

## Overview

These labs exercise Part G against the Tasklane cluster. Each has a goal, steps,
and a full solution. The theme throughout is the same as the chapters:
**understand the mechanism and verify it** — every exercise ends by proving the
behaviour rather than assuming it.

:::danger
Run every exercise **only** in the disposable local **kind** lab (cluster
`tasklane`, Kubernetes 1.37). Several steps deliberately break things —
default-deny that cuts DNS, a probe that fails on purpose — so never point them
at a shared or production cluster.
:::

Output blocks reference capture files the maintainer runs against the lab. Until
then they render "not captured yet", which is expected.

## Setup

All manifests referenced here already exist under `examples/`. From the repo
root, with the lab cluster up and stages 1–4 applied:

```bash
kubectl config current-context
kubectl -n tasklane get pods -o wide
```

Stages beyond 4 are applied by the exercises that need them: stage 5
(`examples/k8s/05-tls`), stage 6 (`examples/k8s/06-network-policy`) and stage 7
(`examples/k8s/07-reliability`), in that order. cert-manager and Envoy Gateway
are installed by `examples/lab/up.sh`.

## Exercises

### Exercise 1 — Readiness redirects, liveness restarts

Prove that a failing readiness probe removes a pod from its Service without
restarting it.

1. Confirm the API pods are `Ready` and the Service has endpoints.
2. Break readiness by making the database unreachable (scale PostgreSQL to zero),
   and watch the API pods stay `Running` but lose their endpoints.
3. Restore the database and watch the endpoints return with no restart.

### Exercise 2 — StatefulSet storage survives a pod delete

Prove that a StatefulSet pod keeps its data across a delete because its PVC is
retained.

1. Inspect the `postgres` StatefulSet, its pod, and its PersistentVolumeClaim.
2. Write a row through the API, then delete the PostgreSQL pod.
3. Confirm the replacement pod re-binds the same PVC and the row is still there.

### Exercise 3 — Expose the API and read the Gateway's status

Apply the Gateway stage and use `status.conditions`, not logs, to confirm it
worked.

1. Apply `examples/k8s/04-gateway/gateway.yaml` (already applied at stage 4).
2. Read `Accepted`/`Programmed` on the Gateway and `Accepted`/`ResolvedRefs` on
   the HTTPRoute.
3. Reach the API through the Gateway at `http://localhost:8080/`.

### Exercise 4 — DNS names and the search-list tax

Explore the records CoreDNS serves and see the `ndots:5` search behaviour.

1. Start the `netcheck` debug pod and read its `/etc/resolv.conf`.
2. Resolve `postgres`, the fully qualified Service name, and the headless
   per-pod name `postgres-0.postgres...`.
3. Explain why the short name takes more lookups than the fully qualified one.

### Exercise 5 — Default-deny, then prove it

Take the namespace dark and prove that only the intended paths survive.

1. Apply the full `examples/k8s/06-network-policy/` set.
2. With an **unlabelled** `netcheck` pod, confirm DNS still resolves but the
   database connection is dropped.
3. Relabel the pod as `component=api` and confirm the database now answers.
4. Confirm the Gateway → API path still works end to end.

### Exercise 6 — TLS, HTTP→HTTPS redirect and a weighted split

Apply the TLS stage and verify termination, the redirect and the 90/10 split.

1. Apply `examples/k8s/05-tls/` in the prescribed order.
2. Confirm the certificate is `Ready` and the HTTPS listener serves it.
3. Confirm plain HTTP 301-redirects to HTTPS, and that 20 requests split roughly
   9:1 between the stable and canary backends.

### Exercise 7 — A PodDisruptionBudget and a CronJob

Apply the reliability stage and observe a PDB and a scheduled Job.

1. Apply `examples/k8s/07-reliability/10-pdb.yaml` and read the budget.
2. Apply `examples/k8s/07-reliability/20-cronjob.yaml` and trigger it manually.
3. Confirm the manual Job completes.

## Solutions

### Solution 1

Start from a healthy state and look at the pod and its endpoints:

```bash
kubectl -n tasklane describe pod -l app.kubernetes.io/name=tasklane-api
```

```console include="captures/k8s-intermediate/api-pod-describe.txt"
```

```bash
kubectl -n tasklane get endpointslices -l kubernetes.io/service-name=tasklane-api -o wide
```

```console include="captures/k8s-intermediate/endpointslices.txt"
```

Now break readiness by removing the database the `/readyz` probe pings:

```bash
kubectl -n tasklane scale statefulset postgres --replicas=0
kubectl -n tasklane get pods -l app.kubernetes.io/name=tasklane-api
kubectl -n tasklane get endpointslices -l kubernetes.io/service-name=tasklane-api -o wide
```

The API pods stay `Running` with a `Ready` condition of `False`, and the
EndpointSlice drops them — callers get a fast connection failure, not a slow 500.
Crucially the restart count does **not** climb, because `/readyz` (readiness)
redirects while `/healthz` (liveness) still answers from the process. Restore the
database and the endpoints return on their own:

```bash
kubectl -n tasklane scale statefulset postgres --replicas=1
kubectl -n tasklane rollout status statefulset/postgres
```

This is the whole point of [probes](probes.md): dependencies belong in readiness,
never liveness, so a database blip does not restart every replica at once.

### Solution 2

Inspect the StatefulSet, its pod and its claim:

```bash
kubectl -n tasklane get pods -l app.kubernetes.io/name=postgres -o wide
```

```console include="captures/k8s-intermediate/statefulset-pods.txt"
```

```bash
kubectl -n tasklane get pvc -o wide && kubectl get pv -o wide
```

```console include="captures/k8s-intermediate/pvc.txt"
```

Create a row through the API, delete the pod, and confirm persistence:

```bash
curl -s -X POST -H 'content-type: application/json' -d '{"title":"lab-2 survives"}' http://localhost:8080/tasks
kubectl -n tasklane delete pod postgres-0
kubectl -n tasklane rollout status statefulset/postgres
curl -s http://localhost:8080/tasks
```

The replacement `postgres-0` re-binds the **same** PVC — a StatefulSet pod's
identity and its `volumeClaimTemplate` claim are stable across reschedules — so
the row is still there. Deleting the PVC (not just the pod) is what would lose
the data; see [persistent volumes and claims](persistent-volumes-and-claims.md).

### Solution 3

The Gateway objects are applied at stage 4. Read the status, not the logs:

```bash
kubectl get gatewayclass,gateway -A
```

```console include="captures/k8s-intermediate/gatewayclass.txt"
```

```bash
kubectl -n tasklane describe gateway tasklane
```

```console include="captures/k8s-intermediate/gateway-describe.txt"
```

```bash
kubectl -n tasklane get httproute -o wide && kubectl -n tasklane describe httproute tasklane-api
```

```console include="captures/k8s-intermediate/httproutes.txt"
```

A working Gateway shows `Accepted=True` and `Programmed=True`, and the route
shows `Accepted=True` and `ResolvedRefs=True` for its parent. Then reach it:

```bash
curl -s http://localhost:8080/
```

kind maps host port 8080 to the Envoy data plane's NodePort 30080. If the
Gateway is `Programmed=False`, the controller has not provisioned the data plane
— see [Gateway API](gateway-api.md#troubleshooting).

### Solution 4

```bash
kubectl apply -f examples/k8s/06-network-policy/debug-pod.yaml
kubectl -n tasklane wait --for=condition=Ready pod/netcheck --timeout=120s
kubectl -n tasklane exec netcheck -- cat /etc/resolv.conf
```

```console include="captures/k8s-intermediate/resolv-conf.txt"
```

```bash
kubectl -n tasklane exec netcheck -- getent hosts postgres tasklane-api postgres.tasklane.svc.cluster.local postgres-0.postgres.tasklane.svc.cluster.local
```

```console include="captures/k8s-intermediate/dns-names.txt"
```

`postgres` has 0 dots, which is fewer than `options ndots:5`, so the resolver
walks the `search` list — `postgres.tasklane.svc.cluster.local` first — before
trying the bare name. The fully qualified form resolves in one query. The
headless per-pod record `postgres-0.postgres...` returns the specific
StatefulSet pod, which is how [DNS and CoreDNS](dns-and-coredns.md) makes stable
per-pod names work.

### Solution 5

Apply the whole set together so DNS is never cut in isolation:

```bash
kubectl apply -f examples/k8s/06-network-policy/00-default-deny.yaml -f examples/k8s/06-network-policy/10-allow-dns.yaml -f examples/k8s/06-network-policy/20-postgres.yaml -f examples/k8s/06-network-policy/30-api.yaml -f examples/k8s/06-network-policy/40-worker.yaml -f examples/k8s/06-network-policy/50-maintenance.yaml
kubectl -n tasklane get networkpolicy
```

```console include="captures/k8s-intermediate/netpol-apply.txt"
```

With `netcheck` unlabelled, DNS works (the DNS rule selects every pod) but the
database is dropped (no policy admits `netcheck`):

```bash
kubectl -n tasklane label pod netcheck app.kubernetes.io/component=netcheck --overwrite
kubectl -n tasklane exec netcheck -- getent hosts postgres
kubectl -n tasklane exec netcheck -- pg_isready -h postgres -t 5
```

```console include="captures/k8s-intermediate/netpol-blocked.txt"
```

The connection **hangs** to the timeout — dropped, not rejected. Give it an
identity the policy admits and it succeeds:

```bash
kubectl -n tasklane label pod netcheck app.kubernetes.io/component=api --overwrite
kubectl -n tasklane exec netcheck -- pg_isready -h postgres -t 5
```

```console include="captures/k8s-intermediate/netpol-allowed.txt"
```

Confirm the real path still works:

```bash
curl -sS -o /dev/null -w 'gateway->api HTTP %{http_code}\n' http://localhost:8080/
```

```console include="captures/k8s-intermediate/netpol-gateway-still-works.txt"
```

Identity is the **label**, not the IP — which is also why a label typo is a
silent outage. See [NetworkPolicy](network-policy.md).

### Solution 6

Apply the TLS stage in order (Gateway before the EnvoyProxy patch, for the
[port-patch reason](gateway-api.md#explanation)):

```bash
kubectl apply -f examples/k8s/05-tls/10-issuers.yaml && kubectl -n cert-manager wait --for=condition=Ready certificate/tasklane-ca --timeout=180s && kubectl apply -f examples/k8s/05-tls/20-certificate.yaml && kubectl -n tasklane wait --for=condition=Ready certificate/tasklane-tls --timeout=180s && kubectl apply -f examples/k8s/05-tls/30-gateway.yaml && kubectl -n tasklane wait --for=condition=Programmed gateway/tasklane --timeout=180s && kubectl apply -f examples/k8s/05-tls/40-envoyproxy.yaml && kubectl apply -f examples/k8s/05-tls/50-canary.yaml && kubectl -n tasklane rollout status deployment/tasklane-api-canary --timeout=180s && kubectl apply -f examples/k8s/05-tls/60-routes.yaml
```

```console include="captures/k8s-intermediate/tls-apply.txt"
```

Confirm the redirect and the split:

```bash
curl -sS -o /dev/null -D - --resolve tasklane.localhost:8080:127.0.0.1 http://tasklane.localhost:8080/
```

```console include="captures/k8s-intermediate/curl-redirect.txt"
```

```bash
kubectl -n tasklane get secret tasklane-tls -o jsonpath='{.data.ca\.crt}' | base64 -d > /tmp/tasklane-ca.crt
for i in $(seq 1 20); do curl -s --cacert /tmp/tasklane-ca.crt --resolve tasklane.localhost:8443:127.0.0.1 https://tasklane.localhost:8443/; echo; done | sort | uniq -c
```

```console include="captures/k8s-intermediate/curl-split.txt"
```

Roughly nine of ten responses name a stable pod and one names the canary,
because `weight: 9` and `weight: 1` are relative, not percentages. Pin the canary
with a header to see match-precedence beat the split:

```bash
curl -sS -i -H 'x-tasklane-track: canary' --cacert /tmp/tasklane-ca.crt --resolve tasklane.localhost:8443:127.0.0.1 https://tasklane.localhost:8443/
```

```console include="captures/k8s-intermediate/curl-canary-header.txt"
```

See [Gateway API: TLS and traffic management](gateway-api-tls-and-traffic.md).

### Solution 7

```bash
kubectl apply -f examples/k8s/07-reliability/10-pdb.yaml && kubectl -n tasklane get poddisruptionbudget
```

```console include="captures/k8s-intermediate/pdb.txt"
```

```bash
kubectl apply -f examples/k8s/07-reliability/20-cronjob.yaml && kubectl -n tasklane get cronjob -o wide
```

```console include="captures/k8s-intermediate/cronjob.txt"
```

Trigger the CronJob manually and wait for it to finish:

```bash
kubectl -n tasklane delete job cleanup-manual --ignore-not-found && kubectl -n tasklane create job --from=cronjob/tasklane-cleanup cleanup-manual && kubectl -n tasklane wait --for=condition=Complete job/cleanup-manual --timeout=180s && kubectl -n tasklane get job cleanup-manual -o wide && kubectl -n tasklane logs job/cleanup-manual
```

```console include="captures/k8s-intermediate/cronjob-run.txt"
```

A PDB caps how many pods a **voluntary** disruption (a drain) may take down at
once; it does not protect against a node crash. See
[pod disruption budgets](pod-disruption-budgets.md) and
[jobs and CronJobs](jobs-and-cronjobs.md).

## Common mistakes

- **Putting a dependency check in the liveness probe** (Exercise 1). When the
  database blips, every replica restarts at once — the probe causes the outage.
- **Deleting a PVC to "reset" a StatefulSet** (Exercise 2). That is the one
  action that loses the data; deleting the pod does not.
- **Reading controller logs instead of `status.conditions`** (Exercise 3). The
  conditions already say exactly what is wrong.
- **Applying `00-default-deny.yaml` alone** (Exercise 5). It cuts DNS for the
  whole namespace; apply the set together.
- **Expecting the split to be exact** (Exercise 6). Weights are relative and a
  keep-alive connection stays on one backend; measure with fresh connections.
- **Assuming a NetworkPolicy is enforced** without testing. On a plugin that
  ignores it, every object applies and nothing is blocked.
- **Treating a PDB as protection against node failure** (Exercise 7). It only
  bounds voluntary disruptions.

## Related topics

- [Probes](probes.md)
- [Persistent volumes and claims](persistent-volumes-and-claims.md)
- [Gateway API](gateway-api.md)
- [Gateway API: TLS and traffic management](gateway-api-tls-and-traffic.md)
- [DNS and CoreDNS](dns-and-coredns.md)
- [NetworkPolicy](network-policy.md)
- [Pod disruption budgets](pod-disruption-budgets.md)
- [Jobs and CronJobs](jobs-and-cronjobs.md)
