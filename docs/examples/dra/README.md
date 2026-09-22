# Dynamic Resource Allocation examples

Manifests for [dynamic-resource-allocation.md](../../content/k8s-advanced/dynamic-resource-allocation.md).
They use the `resource.k8s.io/v1` API, which is GA since Kubernetes 1.34
and locked on since 1.35.

## These manifests need a DRA driver

DRA is an API for drivers, not a driver. Kubernetes itself never discovers
or configures hardware. A third-party DRA driver has to:

1. publish `ResourceSlice` objects describing the devices on each node,
2. answer the kubelet's gRPC calls to prepare and unprepare those devices
   for a pod, usually through CDI.

Without such a driver installed, the objects below are valid and accepted
by the API server, but the scheduler finds no candidate device: the
`DynamicResources` plugin filters out every node and the pod stays
`Pending` with a `FailedScheduling` event.

These examples use the driver name of the upstream example driver,
[kubernetes-sigs/dra-example-driver](https://github.com/kubernetes-sigs/dra-example-driver)
(`gpu.example.com`), which fabricates GPU-like devices for testing. The
handbook lab does **not** install it, so treat everything here as
server-side validated only:

```bash
kubectl apply --dry-run=server -f examples/dra/deviceclass.yaml
kubectl apply --dry-run=server -f examples/dra/resourceclaimtemplate.yaml
```

For real hardware, install the vendor's DRA driver (for example NVIDIA's
DRA driver for GPUs) and replace the driver name, attribute names and
capacity names in the CEL selectors with the ones that driver publishes.
Read them from the cluster with:

```bash
kubectl get resourceslices -o yaml
```

## Files

| File | Kind | Scope |
|---|---|---|
| [deviceclass.yaml](deviceclass.yaml) | `DeviceClass` (two of them) | cluster |
| [resourceclaim.yaml](resourceclaim.yaml) | `ResourceClaim` | namespace `tasklane` |
| [resourceclaimtemplate.yaml](resourceclaimtemplate.yaml) | `ResourceClaimTemplate` | namespace `tasklane` |
| [pod-with-claim.yaml](pod-with-claim.yaml) | `Pod` | namespace `tasklane` |

The second DeviceClass sets `extendedResourceName: example.com/gpu`.
Extended resource allocation by DRA is GA in 1.37 (feature gate
`DRAExtendedResource`, on by default): a pod that asks for
`example.com/gpu: 1` in `resources.limits` is satisfied either by a device
plugin on one node or by DRA devices from that class on another, without
the pod author writing a claim.

## Which API objects exist in your cluster

```bash
kubectl api-resources --api-group=resource.k8s.io
```

## Order of application

DeviceClasses first (cluster-scoped, usually admin- or driver-owned), then
the claim or template, then the workload:

```bash
kubectl apply -f examples/dra/deviceclass.yaml
kubectl apply -f examples/dra/resourceclaim.yaml
kubectl apply -f examples/dra/resourceclaimtemplate.yaml
kubectl apply -f examples/dra/pod-with-claim.yaml
```

Then follow the allocation:

```bash
kubectl -n tasklane get resourceclaims
kubectl -n tasklane describe resourceclaim shared-gpu
kubectl -n tasklane describe pod dra-demo
```

`status.allocation` on the ResourceClaim is written by kube-scheduler, and
`status.reservedFor` lists the pods currently allowed to use it. A claim
generated from the template is named after the pod, owned by it, and
deleted with it.

## Clean up

```bash
kubectl delete -f examples/dra/pod-with-claim.yaml --ignore-not-found
kubectl delete -f examples/dra/resourceclaimtemplate.yaml --ignore-not-found
kubectl delete -f examples/dra/resourceclaim.yaml --ignore-not-found
kubectl delete -f examples/dra/deviceclass.yaml --ignore-not-found
```
