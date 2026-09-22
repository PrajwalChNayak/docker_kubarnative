# examples/autoscaling

Manifests for Part H's autoscaling pages: the Horizontal Pod Autoscaler, the
Vertical Pod Autoscaler, in-place pod resize, KEDA, and node autoscaling with
Karpenter. They all target the Tasklane workloads in the `tasklane` namespace
(stages 1 to 4 of `examples/k8s`).

| File | Needs | Runs in the kind lab? |
|---|---|---|
| `hpa.yaml` | metrics-server only | yes |
| `hpa-custom-metric.yaml` | an adapter serving `custom.metrics.k8s.io` | accepted, but never scales |
| `hpa-scale-to-zero.yaml` | an adapter serving `external.metrics.k8s.io` | accepted, but never scales |
| `in-place-resize.yaml` | Kubernetes 1.35+ | yes |
| `vpa.yaml` | the Vertical Pod Autoscaler and its CRDs | no |
| `keda-scaledobject.yaml` | KEDA 2.20 and its CRDs | no |
| `karpenter-nodepool.yaml` | Karpenter plus a cloud provider | **no — reference only** |

## Apply the CPU HPA

```bash
kubectl apply -f examples/autoscaling/hpa.yaml
kubectl -n tasklane get hpa tasklane-api --watch
```

`TARGETS` shows `<unknown>/70%` until metrics-server has two samples of every
pod, which takes up to a minute after the pods start.

Generate load from the host: kind maps the Gateway to `localhost:8080`, and
the `tasklane` namespace is PSA restricted, so a throwaway in-cluster load
generator would need a full security context anyway.

```bash
while true; do curl -s -o /dev/null http://localhost:8080/tasks; done
```

Remove it again with `kubectl delete -f examples/autoscaling/hpa.yaml`; the
Deployment keeps whatever replica count the HPA last set.

## Resize a pod in place

```bash
kubectl -n tasklane apply -f examples/autoscaling/in-place-resize.yaml
kubectl -n tasklane patch pod tasklane-resize-demo --subresource resize \
  -p '{"spec":{"containers":[{"name":"demo","resources":{"requests":{"cpu":"200m"}}}]}}'
kubectl -n tasklane get pod tasklane-resize-demo -o jsonpath='{.status.containerStatuses[0].resources}'
kubectl -n tasklane delete pod tasklane-resize-demo
```

`--subresource resize` needs kubectl 1.32 or newer. Patching
`spec.containers[].resources` without it is rejected.

## Validation

Every file here is checked with kubeconform against Kubernetes 1.37 schemas
plus the CRD catalogue:

```bash
.tools/kubeconform.exe -strict -summary -kubernetes-version 1.37.0 \
  -schema-location default \
  -schema-location "https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json" \
  examples/autoscaling/*.yaml
```

The VPA, KEDA and Karpenter files are validated against those CRD schemas
only. Nothing in the lab cluster serves those APIs, so do not expect
`kubectl apply --dry-run=server` to accept them there.
