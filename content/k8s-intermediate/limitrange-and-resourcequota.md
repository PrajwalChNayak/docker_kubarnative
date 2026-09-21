---
title: LimitRange and ResourceQuota
description: Namespace-level guardrails - defaults and per-object ceilings with LimitRange, aggregate budgets with ResourceQuota, and the admission behaviour that surprises people.
level: intermediate
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-intermediate/resources-requests-limits
  - k8s-beginner/namespaces
---

## Overview

Two objects, both namespaced, both enforced at admission time, easily confused:

| | `LimitRange` | `ResourceQuota` |
|---|---|---|
| Scope | one object (container, pod or PVC) | the whole namespace, in aggregate |
| Can it mutate? | **yes** — injects defaults | no |
| Typical use | "every container gets 100m/128Mi if it asks for nothing" | "this team may request 20 CPUs total" |
| Failure mode | pod rejected at creation | pod rejected once the budget is full |

Use them together. A ResourceQuota on CPU or memory without a LimitRange is a
trap, for a reason explained below.

## Why it exists and when to use it

Namespaces are the unit of tenancy in a shared cluster, but a namespace by
itself grants unlimited resources. Quotas turn a namespace into a budget, and
LimitRanges stop one pod from eating the entire budget or from carrying no
requests at all.

You need them the moment more than one team shares a cluster — or the moment
you want a promise about how much of a cluster a single environment can consume.

## How it works underneath

Both are implemented as admission plugins in the API server
(`LimitRanger` and `ResourceQuota`), which run on every create and update.

**LimitRanger** is mutating *and* validating. For each container it walks the
LimitRange items whose `type` matches and:

- applies `default` to a missing `limits` entry,
- applies `defaultRequest` to a missing `requests` entry (falling back to the
  applied limit when `defaultRequest` is absent),
- then rejects the object if any value falls outside `min`/`max`, or if
  `limit / request` exceeds `maxLimitRequestRatio`.

Defaults are applied at admission, so they are baked into the stored pod. Change
the LimitRange later and existing pods keep the old numbers until they are
recreated.

**ResourceQuota** is validating, plus a controller that maintains
`status.used`. On create the plugin checks whether the new object would push any
tracked resource past its hard limit. Because usage is recalculated inside the
admission path, quota enforcement is strongly consistent — but it also means
quota is checked against *requests and limits*, never against real consumption.

Quota can track compute resources (`requests.cpu`, `limits.memory`, …), storage
(`requests.storage`, `persistentvolumeclaims`, and per-StorageClass variants
such as `standard.storageclass.storage.k8s.io/requests.storage`) and object
counts (`pods`, `services`, `secrets`, `count/deployments.apps`,
`count/cronjobs.batch`).

`scopes` and `scopeSelector` narrow what a quota applies to: `BestEffort`,
`NotBestEffort`, `Terminating`, `NotTerminating`, `PriorityClass`,
`CrossNamespacePodAffinity` and `VolumeAttributesClass`.

## Basic example

```yaml title="limitrange.yaml"
apiVersion: v1
kind: LimitRange
metadata:
  name: tasklane-defaults
  namespace: tasklane
spec:
  limits:
    - type: Container
      # Injected when a container specifies nothing.
      default:
        cpu: 200m
        memory: 128Mi
      defaultRequest:
        cpu: 50m
        memory: 64Mi
      # Hard bounds per container, checked after defaulting.
      min:
        cpu: 10m
        memory: 16Mi
      max:
        cpu: "2"
        memory: 1Gi
      # limit may be at most 4x the request: caps overcommitment per container.
      maxLimitRequestRatio:
        memory: "4"
    - type: PersistentVolumeClaim
      min:
        storage: 1Gi
      max:
        storage: 10Gi
```

```yaml title="resourcequota.yaml"
apiVersion: v1
kind: ResourceQuota
metadata:
  name: tasklane-budget
  namespace: tasklane
spec:
  hard:
    requests.cpu: "4"
    requests.memory: 8Gi
    limits.memory: 16Gi
    persistentvolumeclaims: "8"
    requests.storage: 40Gi
    count/deployments.apps: "10"
    count/cronjobs.batch: "5"
    pods: "50"
```

## Explanation

With the LimitRange in place, a pod that declares nothing still arrives at the
scheduler with `requests: {cpu: 50m, memory: 64Mi}` and
`limits: {cpu: 200m, memory: 128Mi}`. It can therefore never be BestEffort, and
the quota can account for it.

Without the LimitRange, the ResourceQuota above would reject that same pod
outright. **If a quota constrains `requests.cpu` or `limits.memory`, every new
container in that namespace must set the corresponding value.** There is no
"unlimited" to charge against, so admission fails with a message naming the
missing field. That interaction is the number-one reason a quota "breaks
everything" the day it is applied, and a LimitRange with defaults is the fix.

`maxLimitRequestRatio` deserves a mention: it is the only built-in way to cap
overcommitment per container. A ratio of 4 on memory says a container may have a
128Mi request and a 512Mi limit, but not a 64Mi request and a 1Gi limit.

## Common patterns

**One LimitRange per namespace, shipped with the namespace.** Put it in the
same manifest directory as the Namespace object so a new environment is never
created without guardrails.

**Separate quotas per priority class.** A quota scoped to
`PriorityClass In [high]` lets you reserve headroom for critical workloads and
stop a team from marking everything critical:

```yaml title="high-priority-quota.yaml"
apiVersion: v1
kind: ResourceQuota
metadata:
  name: tasklane-high-priority
  namespace: tasklane
spec:
  hard:
    pods: "4"
    requests.cpu: "2"
    requests.memory: 4Gi
  scopeSelector:
    matchExpressions:
      - scopeName: PriorityClass
        operator: In
        values: ["high"]
```

**Count objects, not just compute.** `count/secrets`, `services.loadbalancers`
and `persistentvolumeclaims` prevent the failure modes that cost real money or
exhaust cloud API quotas.

**Quota the storage class, not just the total.** Charging `requests.storage`
alone lets a team take 40Gi of premium SSD when you meant them to use it for
bulk storage.

## Production considerations

Quotas are checked against requests, so a namespace can be 100% quota-consumed
and 5% utilised. Review both numbers together or you will keep raising quotas
for workloads that are already idle.

Sizing is an ongoing negotiation. Start from observed usage plus headroom, alert
when `used / hard` passes 80%, and expose the numbers to the team that owns the
namespace — `kubectl describe resourcequota` is the whole story:

```bash
kubectl -n tasklane describe resourcequota
kubectl -n tasklane describe limitrange
```

Changing a LimitRange does not touch running pods. Roll the workloads if you
need the new defaults applied.

Beware quota on `pods` combined with a rolling update: `maxSurge` creates extra
pods before the old ones go away, and a quota with no headroom stalls every
deployment in the namespace. Leave at least `maxSurge` worth of slack.

## Security considerations

Quotas are an availability control against noisy neighbours, deliberate or not.
Without them, any tenant with pod-create permission can schedule until the
cluster's nodes are exhausted, which is a denial-of-service against every other
tenant.

Object-count quotas matter for more than resources: a bounded `count/secrets`
limits how much a compromised account can stash in etcd, and
`services.loadbalancers` limits how many public IP addresses someone can conjure
up.

Quota is namespaced, so it only works if the boundary it defends is real:
combine it with RBAC that stops tenants editing their own quota (nobody should
have `resourcequotas` write access in their own namespace) and with
NetworkPolicy for the traffic side. See
[multi-tenancy](../k8s-advanced/multi-tenancy.md).

## Troubleshooting

**`exceeded quota: tasklane-budget, requested: requests.cpu=1, used: ..., limited: ...`** —
the namespace budget is full. `kubectl describe resourcequota` shows used vs
hard for every tracked resource.

**`must specify limits.memory`** — a quota tracks a resource the pod did not
declare. Add a LimitRange default or set the value.

**Pods stuck `Pending` while the Deployment reports quota errors** — look at the
ReplicaSet, not the Deployment. Quota rejections happen when the ReplicaSet
tries to create pods, so the message appears in
`kubectl -n tasklane describe replicaset <name>` and in the namespace events.

**Defaults not applied** — LimitRanger only defaults resources for the item
`type` you configured. A `type: Pod` entry sets bounds on the pod total; it does
not inject container defaults.

## Common mistakes

- **Applying a compute ResourceQuota without a LimitRange**, so every pod that
  omits a request is rejected — including, eventually, someone's critical
  hotfix.
- **Forgetting init containers and sidecars.** They count too, and a sidecar
  without requests blocks admission in a quota'd namespace.
- **No headroom for `maxSurge`**, which freezes rollouts at the quota edge.
- **Quota on `requests.cpu` only.** Teams then set giant limits and the node
  overcommits anyway; add `limits.*` or `maxLimitRequestRatio`.
- **Assuming a LimitRange change is retroactive.** It applies at admission.
- **Using quota as a cost control** without watching utilisation: you get a full
  budget and empty nodes.

## Related topics

- [Requests and limits](resources-requests-limits.md)
- [QoS classes and eviction](qos-classes.md)
- [Namespaces](../k8s-beginner/namespaces.md)
- [Multi-tenancy](../k8s-advanced/multi-tenancy.md)
- [RBAC](../k8s-security/rbac.md)
- [Cost visibility](../operations/cost-visibility.md)
