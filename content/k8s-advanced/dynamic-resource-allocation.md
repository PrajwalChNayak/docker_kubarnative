---
title: Dynamic resource allocation
description: Claiming devices such as GPUs with resource.k8s.io, how structured parameters and CEL selectors drive allocation, and where DRA differs from device plugins.
level: expert
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-advanced/scheduler-internals
  - k8s-intermediate/resources-requests-limits
---

## Overview

Dynamic resource allocation (DRA) is the API through which pods claim
**devices** — GPUs, FPGAs, NICs, accelerators — instead of asking for an
opaque counter. Core DRA is **GA since Kubernetes 1.34** and the
`DynamicResourceAllocation` feature gate has been locked on since 1.35; the
API group is `resource.k8s.io/v1`.

```console include="captures/k8s-advanced/dra-api-resources.txt"
```

Four kinds do the work:

| Kind | Scope | Written by | Purpose |
|---|---|---|---|
| `DeviceClass` | cluster | admin or driver | A category of devices plus the CEL selectors that define it |
| `ResourceClaim` | namespace | workload owner | A request for devices, with its own lifetime |
| `ResourceClaimTemplate` | namespace | workload owner | A stencil from which one claim per pod is generated |
| `ResourceSlice` | cluster | **driver only** | The inventory: which devices exist, on which nodes, with which attributes |

:::warning DRA needs a driver
Kubernetes does not discover, configure or attach hardware. A third-party
DRA driver publishes ResourceSlices and prepares devices for the kubelet
over gRPC and CDI. Without one, the manifests on this page are accepted by
the API server and the pods stay `Pending` for ever. The handbook lab has
no driver installed, so the examples here are validated with
`--dry-run=server` only.
:::

## Why it exists and when to use it

Before DRA, special hardware was exposed by a **device plugin** as an
[extended resource](../k8s-intermediate/resources-requests-limits.md): the
node advertises `nvidia.com/gpu: 4` and a container asks for
`limits: {nvidia.com/gpu: 1}`. That model is simple and still fully
supported, but it only carries a number.

| | Device plugin (extended resources) | DRA (`resource.k8s.io`) |
|---|---|---|
| Request | Integer count in `resources.limits` | Reference to a claim |
| Selection | One resource name per device type | CEL over device attributes and capacity |
| Sharing | Whole devices, one container each | Several containers or pods per claim |
| Configuration | Per node, in the plugin | Per workload, in the claim |
| Lifetime | Tied to the container | Claim object, independent of any pod |
| Allocation | kubelet picks a device on the node | kube-scheduler picks the device, then the node |

Use DRA when the *choice* of device matters: model, memory size, NUMA
locality, a partition of a card, a device attached over a fabric rather
than to a node. Stay with the device plugin when every device is
interchangeable and each pod takes whole ones — it is simpler, and the
ecosystem tooling still assumes it.

You do not have to choose cluster-wide. Extended resource allocation by DRA
(**GA in 1.37**, gate `DRAExtendedResource`, on by default) lets a
DeviceClass carry an `extendedResourceName`: pods keep writing
`limits: {example.com/gpu: 1}` and the scheduler satisfies them from a
device plugin on one node and from DRA devices on another.

## How it works underneath

1. **Inventory.** The driver's controller creates ResourceSlices, each
   describing a pool of devices with attributes (`model`, `uuid`,
   `driverVersion`), capacity (`memory: 80Gi`) and the nodes that can reach
   them. Slices are driver-owned; edits you make are overwritten.
2. **Claim creation.** If a pod references a ResourceClaimTemplate, the
   `resourceclaim-controller` in kube-controller-manager generates a
   ResourceClaim, sets the pod as its owner and records the name in
   `pod.status.resourceClaimStatuses`. A directly referenced ResourceClaim
   must already exist in the pod's namespace.
3. **Allocation.** In the scheduling cycle, the `DynamicResources` plugin
   evaluates the DeviceClass selectors and then the request's own selectors
   against every candidate device — this is what "structured parameters"
   means: the scheduler itself understands the data, instead of asking a
   vendor controller. It uses a first-fit strategy, walking pools and
   slices in lexicographic name order, then writes
   `status.allocation` on the claim and adds the pod to
   `status.reservedFor`.
4. **Binding and preparation.** The pod is bound to a node that can reach
   the allocated device. The kubelet calls the driver's node plugin to
   prepare it, and the driver returns CDI device edits that the runtime
   applies to the container.
5. **Release.** When the last pod in `reservedFor` terminates, the
   allocation is released. A generated claim is deleted with its pod; a
   standalone claim is yours to delete.

The `reservedFor` list holds at most **256** entries, which caps how many
pods can share one claim.

## Basic example

A DeviceClass — cluster-scoped, usually shipped by the driver:

```yaml include="examples/dra/deviceclass.yaml"
```

A template that produces one private device per pod:

```yaml include="examples/dra/resourceclaimtemplate.yaml"
```

And a pod that consumes both a generated claim and a shared one:

```yaml include="examples/dra/pod-with-claim.yaml"
```

```bash
kubectl apply --dry-run=server -f examples/dra/deviceclass.yaml -f examples/dra/resourceclaim.yaml -f examples/dra/resourceclaimtemplate.yaml
```

```console include="captures/k8s-advanced/dra-dry-run.txt"
```

## Explanation

**Selectors compose.** A device must satisfy every CEL expression from the
DeviceClass *and* from the request. The expression sees `device.driver`,
`device.attributes[<domain>]` and `device.capacity[<domain>]`; attribute
names published without a domain are qualified by the driver's own name,
which is why the examples index by `"gpu.example.com"`. Capacity values are
Kubernetes quantities, so `quantity("40Gi")`, `isGreaterThan`, `isLessThan`
and `compareTo` from the CEL quantity library are available.

**`exactly` versus `firstAvailable`.** A request either names one device
class with `allocationMode: ExactCount` and a `count` (or
`allocationMode: All` for every matching device on a node), or lists
alternatives under `firstAvailable` — the *prioritized list* feature
(**GA in 1.36**), where the scheduler takes the first subrequest it can
satisfy and prefers nodes that can serve a higher-ranked alternative. The
choice is made per pod, so replicas of one Deployment may end up with
different alternatives.

**Constraints tie requests together.** `constraints[].matchAttribute` makes
two requests resolve to devices sharing an attribute value — the usual way
to demand a GPU and a NIC on the same NUMA node — and `distinctAttribute`
demands the opposite.

**Template versus claim.** A ResourceClaimTemplate gives each pod its own
device and disappears with the pod; a ResourceClaim is a shared, long-lived
object that several pods can reserve. Referencing a generated claim by name
from another pod works but is a trap: it vanishes when its owner pod does.

## Common patterns

**One GPU per worker pod.** A ResourceClaimTemplate in the workload's
namespace, referenced from the pod template of a Job or Deployment. This is
the DRA equivalent of `limits: {nvidia.com/gpu: 1}`, with attribute-based
selection on top.

**Shared inference device.** One ResourceClaim per model server, reserved
by several pods, so a large card is not idle between requests. Combine with
**consumable capacity** (Beta and on by default since 1.36,
`DRAConsumableCapacity`), where a device declares a shareable capacity and
each claim consumes a slice of it, and with **partitionable devices**
(Beta, on by default since 1.36) for cards that expose several logical
devices backed by the same silicon.

**Fabric-attached hardware.** Devices that must be attached before a pod
can start use **binding conditions** (Beta, on by default since 1.36): the
scheduler waits in `PreBind` until the driver reports readiness on the
claim, up to 600 seconds by default, configurable through
`DynamicResourcesArgs.bindingTimeout` in the scheduler configuration.

**Taking a broken device out of service.** `DeviceTaintRule` plus device
tolerations (**GA in 1.37**, gates `DRADeviceTaints` and
`DRADeviceTaintRules`) taint a single device rather than the whole node, so
the rest of the machine keeps working. See
[taints and tolerations](taints-and-tolerations.md).

**Debugging and maintenance access.** A request with `adminAccess: true`
(**GA in 1.36**) can attach to devices that are already in use. It works
only in namespaces labelled
`resource.kubernetes.io/admin-access: "true"`, which is the authorisation
boundary — treat that label as a privileged grant.

Newer capabilities to know about but not to build on yet: gang-shared
claims for PodGroups (`DRAWorkloadResourceClaims`, **Beta in 1.37 but off
by default**), list-type and derived attributes, node-allocatable resource
accounting, device compatibility groups and resource-pool status — all
**alpha, off by default, and not for production** in 1.37.

## Production considerations

- **Version skew and drivers.** The driver, its CDI support and the
  Kubernetes version must line up. Pin driver versions and upgrade them
  with the cluster; a driver built against `resource.k8s.io/v1beta1`
  objects will not see the v1 API the same way.
- **No preemption.** kube-scheduler does not preempt pods that hold DRA
  claims. A high-priority GPU job waits for the low-priority one to finish;
  [priority and preemption](priority-and-preemption.md) does not help.
  Model this with queueing (Kueue) rather than priority.
- **No opportunistic batching.** The scheduler's cached-result batching
  explicitly skips pods with resource claims, so large DRA workloads pay
  full scheduling cost per pod.
- **Quota.** Devices are not CPU: ResourceQuota cannot limit "GPUs" through
  a claim directly, so limit the objects —
  `count/resourceclaims.resource.k8s.io` — and control who may create them
  with RBAC. Give each team its own DeviceClass if you want different
  hardware pools per tenant.
- **Autoscaling.** Cluster autoscalers must simulate DRA to scale a node
  pool for a pending claim. Verify that your autoscaler version supports it
  before assuming a pending GPU pod will create a node.
- **Observability.** `ResourceClaim.status.devices` (**GA in 1.37**)
  carries per-device state from the driver, including standardised network
  interface data; `kubectl describe resourceclaim` is the first stop when a
  pod is pending. The scheduler also exposes
  `scheduler_dra_bindingconditions_wait_duration_seconds` for the binding
  wait.
- **Cost.** A shared claim keeps a device allocated while any pod reserves
  it. Idle reservations are as expensive as idle nodes and much harder to
  see.

## Security considerations

**Threat.** A device is a shared kernel-level resource with its own memory.
Two pods that share a ResourceClaim share the card: unless the driver wipes
device memory between consumers, one workload can read what the other left
behind. Worse, `adminAccess` grants access to devices **already in use** by
other workloads, which is a cross-tenant read primitive.

**Exploit.** In the lab, label a namespace
`resource.kubernetes.io/admin-access=true`, create a claim with
`adminAccess: true` and schedule a pod against a device another namespace
is using. The pod attaches to the live device.

**Fix.** Keep the `resource.kubernetes.io/admin-access` label off every
tenant namespace and restrict who may set labels on namespaces; grant
`create` on `resourceclaims` and `resourceclaimtemplates` per namespace
through RBAC, never cluster-wide; never expose `resourceslices` for write
to anyone but the driver's own ServiceAccount, because a forged slice
invents devices and steers claims onto an attacker's node; and only share a
claim between pods of the same trust domain, unless the vendor documents
that the driver clears device state between consumers.

**Verify.**

```bash
kubectl get namespaces -l resource.kubernetes.io/admin-access
kubectl auth can-i create resourceclaims --as=system:serviceaccount:tasklane:tasklane-api -n tasklane
kubectl auth can-i update resourceslices --as=system:serviceaccount:tasklane:tasklane-api
```

The first should list only namespaces you intend to be privileged; the last
two should answer `no`.

## Troubleshooting

Work down the chain: pod → claim → slices → driver.

```bash
kubectl -n tasklane describe pod dra-demo
kubectl -n tasklane get resourceclaims
kubectl -n tasklane describe resourceclaim shared-gpu
kubectl get resourceslices
kubectl get deviceclasses
```

| Symptom | Cause |
|---|---|
| Pod `Pending`, `FailedScheduling` mentioning resource claims | No driver, no matching device, or every matching device already allocated |
| `must specify one of: resourceClaimName, resourceClaimTemplateName` | A malformed `spec.resourceClaims` entry, or an old mutating webhook rewriting pods |
| Claim exists but `status.allocation` is empty | The scheduler has not allocated it yet: no candidate device, or the pod is gated |
| Pod scheduled but stuck in `ContainerCreating` | The kubelet plugin is not running on that node, or device preparation failed; check the driver's logs |
| `kubectl get resourceslices` is empty | The driver is not running or lacks RBAC to publish slices |
| Pod bypassed the scheduler (`spec.nodeName` set) | The kubelet retries and fails until the claim happens to be allocated; never pre-schedule DRA pods |

## Common mistakes

- Expecting DRA to work without a driver. It is an API, not an
  implementation.
- Referencing a ResourceClaim that lives in another namespace, or one that
  was generated for another pod.
- Forgetting `resources.claims` on the container: the claim is allocated
  and reserved, but the device never appears inside the container.
- Assuming a high-priority pod can preempt a device holder. It cannot.
- Sharing one claim across tenants because "it is only a GPU".
- Using `adminAccess` for ordinary workloads, or leaving the admin-access
  label on a shared namespace.
- Hard-coding attribute names from one vendor's documentation; read them
  from `kubectl get resourceslices -o yaml` in your own cluster.
- Building on the alpha pieces — derived attributes, list-type attributes,
  node-allocatable accounting — in a production cluster.

## Related topics

- [Scheduler internals](scheduler-internals.md)
- [Priority and preemption](priority-and-preemption.md)
- [Taints and tolerations](taints-and-tolerations.md)
- [Node selection and node affinity](node-selection-and-affinity.md)
- [Requests and limits](../k8s-intermediate/resources-requests-limits.md)
- [Cluster Autoscaler and Karpenter](cluster-autoscaler-and-karpenter.md)
- [Part H labs](labs.md)
