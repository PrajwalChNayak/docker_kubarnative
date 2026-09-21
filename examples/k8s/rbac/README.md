# Least-privilege RBAC for the `tasklane` namespace

Two identities that show the two most common non-human access patterns:

| File | Identity | Grant |
|---|---|---|
| `deployer.yaml` | `tasklane-deployer` | A namespaced `Role`: get/list/watch/create/update/patch on Deployments, ReplicaSets, Services, ConfigMaps and HTTPRoutes in `tasklane`. **No** Secrets, **no** pods/exec, **no** RoleBinding/escalate/bind/impersonate. |
| `observer.yaml` | `tasklane-observer` | A `RoleBinding` to the built-in **`view`** ClusterRole, scoped to `tasklane`. `view` deliberately excludes Secrets. |

Both ServiceAccounts set `automountServiceAccountToken: false`; a pipeline mints a short-lived token with `kubectl create token` when it needs one.

## Apply

```bash
kubectl apply -f examples/k8s/rbac/deployer.yaml
kubectl apply -f examples/k8s/rbac/observer.yaml
```

## Verify (this is the point of the exercise)

List everything the deployer may do in the namespace:

```bash
kubectl auth can-i --list \
  --as=system:serviceaccount:tasklane:tasklane-deployer -n tasklane
```

Positive checks — these should print `yes`:

```bash
kubectl auth can-i create deployments \
  --as=system:serviceaccount:tasklane:tasklane-deployer -n tasklane
kubectl auth can-i patch httproutes \
  --as=system:serviceaccount:tasklane:tasklane-deployer -n tasklane
```

Negative checks — these must print `no`. If any prints `yes`, the Role is too broad:

```bash
kubectl auth can-i get secrets \
  --as=system:serviceaccount:tasklane:tasklane-deployer -n tasklane
kubectl auth can-i create pods/exec \
  --as=system:serviceaccount:tasklane:tasklane-deployer -n tasklane
kubectl auth can-i create rolebindings \
  --as=system:serviceaccount:tasklane:tasklane-deployer -n tasklane
```

The observer can list pods but not read Secrets:

```bash
kubectl auth can-i list pods \
  --as=system:serviceaccount:tasklane:tasklane-observer -n tasklane   # yes
kubectl auth can-i get secrets \
  --as=system:serviceaccount:tasklane:tasklane-observer -n tasklane   # no
```

`kubectl auth can-i` asks the API server's authorizer the exact question the
API server would ask on a real request, so it is the authoritative check —
not an approximation.
