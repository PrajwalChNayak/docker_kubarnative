# A tenant namespace: team-a

Everything a platform team applies when it hands a namespace to a tenant.
Apply the whole directory; the numeric prefixes are the order that matters.

```bash
kubectl apply -f examples/multi-tenancy/
kubectl -n team-a describe resourcequota
kubectl auth can-i create deployments -n team-a --as=system:serviceaccount:team-a:team-a-deployer
kubectl auth can-i delete resourcequota -n team-a --as=system:serviceaccount:team-a:team-a-deployer
```

`kubectl apply -f <dir>` is not recursive, so the `verify/` pods are not
created by that command. They exist to prove the boundary works:

```bash
kubectl apply -f examples/multi-tenancy/verify/oversized-pod.yaml --dry-run=server
kubectl apply -f examples/multi-tenancy/verify/no-resources-pod.yaml --dry-run=server -o yaml
```

The first is rejected by the LimitRange. The second is admitted, with
requests and limits the manifest never declared.

| File | Boundary it enforces |
|---|---|
| `00-namespace.yaml` | Pod Security Admission `restricted`, pinned to v1.37, with a tenant label |
| `10-resourcequota.yaml` | Compute quota, object-count quota, and a PriorityClass-scoped quota |
| `20-limitrange.yaml` | Defaults (mutating) and per-container / per-pod / per-PVC caps (validating) |
| `30-rbac.yaml` | A ServiceAccount, an allow-list `Role`, and `view` bound namespace-scoped |
| `40-networkpolicy.yaml` | Default deny both ways, plus DNS, same-namespace, and internet-minus-RFC1918 |

## What this does not give you

This is **soft** multi-tenancy. It is the right answer for teams inside one
organisation that already trust each other not to attack the cluster. It is
not the right answer for hostile tenants, because all of them still share:

- one kube-apiserver, and one etcd, so an API-server-level denial of service
  by one tenant affects all of them
- one set of CRDs and admission webhooks, which are cluster-scoped
- one kernel per node, so a container escape crosses every namespace on that
  node unless you also pin tenants to their own nodes and use a sandboxed
  runtime
- one node pool's kubelet and CNI

Cluster-scoped objects are the leak that catches people out. A tenant who
can create a `CustomResourceDefinition`, a `ValidatingWebhookConfiguration`,
a `PriorityClass` or a `StorageClass` is not confined by its namespace. None
of those verbs are in `30-rbac.yaml`, and none of them should be added.

See `content/k8s-advanced/multi-tenancy.md` for the harder options: node
isolation, sandboxed runtimes, virtual control planes and cluster-per-tenant.
