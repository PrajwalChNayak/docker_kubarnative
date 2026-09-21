---
title: Multi-tenancy
description: How far a namespace really isolates a tenant, what to apply on top of it, and when namespace-per-tenant stops being enough.
level: expert
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-intermediate/limitrange-and-resourcequota
  - k8s-intermediate/network-policy
---

## Overview

Multi-tenancy is the practice of running workloads belonging to different
parties on shared Kubernetes infrastructure. The parties may be teams inside
one company, or customers of a SaaS product, and the difference between those
two cases decides almost everything else.

Kubernetes' own documentation is unusually careful here: it describes
isolation as "a broad spectrum" rather than a binary, and says explicitly
that "hard" and "soft" multi-tenancy "can often be confusing, as there is no
single definition that will apply to all users". That is the honest framing.
A namespace is not a security boundary by default; it becomes something
close to one only after you add five or six other objects, and even then it
shares a kernel, an API server and an etcd with every other tenant.

This page builds the namespace-per-tenant pattern completely, shows what it
does and does not contain, and then says when to stop using it.

## Why it exists and when to use it

The alternative to sharing is a cluster per tenant, and clusters are
expensive. A control plane, a monitoring stack, an ingress data plane, a
certificate manager and a CNI per tenant is a large fixed cost repeated N
times, plus N upgrade cycles. For forty internal teams that is usually
indefensible; for four hostile customers it is usually correct.

Sharing is the right default when tenants are **mutually non-hostile**: they
might starve each other by accident, deploy something that crash-loops, or
consume more CPU than they should, but they are not actively trying to escape
their namespace. That is the case for almost every internal platform, and
namespace-per-tenant with quotas, RBAC, network policy and Pod Security
Admission handles it well.

It is the wrong default the moment a tenant is untrusted — arbitrary
customer-supplied code, a free tier, a security boundary that appears in a
contract. Then you are relying on the Linux kernel's container isolation to
separate parties who benefit from breaking it, and that is a bet with a long
history of CVEs on the other side.

## How it works underneath

A namespace, by itself, does exactly two things: it scopes the names of
namespaced objects, and it gives RBAC something to bind to. It does not limit
CPU, restrict networking, constrain what a pod may do, or isolate the kernel.
Every one of those needs a separate object, enforced by a separate mechanism:

| Concern | Object | Enforced by | When |
|---|---|---|---|
| Who may act | `Role` + `RoleBinding` | kube-apiserver authorisation | Every request |
| How much | `ResourceQuota` | `ResourceQuota` admission plugin | Object create/update |
| How much, per object | `LimitRange` | `LimitRanger` admission plugin (mutating, then validating) | Pod/PVC create |
| What a pod may do | namespace PSA labels | `PodSecurity` admission plugin | Pod create/update |
| Who may talk to whom | `NetworkPolicy` | The CNI plugin's dataplane | Every packet |
| Where it runs | taints, affinity, `RuntimeClass` | kube-scheduler and kubelet | Scheduling and start |

The ordering inside admission matters and explains a common surprise.
`LimitRanger` runs in the mutating phase and injects default requests and
limits; the `ResourceQuota` plugin runs in the validating phase and counts
what is left. That is why a namespace with a quota on `requests.cpu` but no
`LimitRange` rejects every pod that forgets to set requests — the quota
requires the field, and nothing supplied it.

Pod Security Admission is a built-in admission plugin configured by
**namespace labels** (`pod-security.kubernetes.io/enforce|warn|audit` with
optional `-version`). PSA has been stable since 1.25 and the Pod Security
Standards since 1.26. Pinning `enforce-version` matters for tenants: without
it, a cluster upgrade can change what `restricted` means underneath a
running tenant.

`NetworkPolicy` is different from all the others: the API server stores it,
but the *CNI plugin* enforces it. Applying a default-deny policy to a cluster
whose CNI ignores NetworkPolicy succeeds silently and isolates nothing.

## Basic example

The platform team's package for tenant `team-a`
([`examples/multi-tenancy/`](../../examples/multi-tenancy/00-namespace.yaml)):

```yaml include="examples/multi-tenancy/00-namespace.yaml"
```

```yaml include="examples/multi-tenancy/10-resourcequota.yaml"
```

```yaml include="examples/multi-tenancy/20-limitrange.yaml"
```

```yaml include="examples/multi-tenancy/40-networkpolicy.yaml"
```

Applying the directory and inspecting the quota:

```bash
kubectl apply -f examples/multi-tenancy/
kubectl -n team-a describe resourcequota team-a-compute
```

```console include="captures/k8s-advanced/tenant-apply-quota.txt"
```

## Explanation

**Three quotas, not one.** The compute quota bounds CPU and memory. The
object-count quota bounds things that cost money or capacity without costing
CPU: `services.loadbalancers: "0"` prevents a tenant provisioning cloud load
balancers, `services.nodeports: "0"` prevents them claiming host ports on
every node, and `requests.storage` bounds the storage backend. The
`scopeSelector` quota caps how many pods may run at an elevated
`PriorityClass`, because priority is a cross-namespace mechanism: without
it, one tenant can preempt another tenant's pods.

**The LimitRange is doing two jobs.** `default`/`defaultRequest` mutate — they
make the quota usable. `max`/`min` validate — they stop one pod swallowing
the namespace. `maxLimitRequestRatio` is the underrated one: it stops a
tenant reserving 128Mi and bursting to 16Gi, which is how a node's memory
disappears and unrelated pods get OOM-killed. Watch what admission does to a
pod that declares nothing:

```console include="captures/k8s-advanced/tenant-limitrange-defaults.txt"
```

and to one that asks for too much:

```console include="captures/k8s-advanced/tenant-limitrange-reject.txt"
```

**The Role is an allow-list, and the omissions are the design.** The tenant
can create Deployments, Services, HTTPRoutes and Secrets. It cannot touch
`resourcequotas`, `limitranges`, `networkpolicies`, `roles` or
`rolebindings` beyond reading the first three. Binding the built-in `admin`
ClusterRole instead — which is what most tutorials do — would hand the tenant
`rolebindings`, and a tenant who can create a RoleBinding can grant itself
every permission any ClusterRole in the cluster offers, scoped to its
namespace. That includes whatever a platform ServiceAccount can do there.

```console include="captures/k8s-advanced/tenant-can-i.txt"
```

**Default-deny is the only NetworkPolicy posture that scales.** Kubernetes'
default is that every pod can reach every other pod in the cluster. A policy
selecting all pods with both policy types and no rules denies everything;
subsequent policies are additive. The two easy mistakes are forgetting DNS
egress to `kube-system`, which makes every application look broken for
reasons that have nothing to do with the application, and writing
`egress to 0.0.0.0/0` without `except` blocks — which re-opens every other
namespace, the API server and the cloud metadata endpoint at `169.254.169.254`.

:::warning A namespace is not a sandbox
Everything above is enforced by the API server and the CNI. None of it
touches the kernel. Two tenants' pods on the same node share one kernel, and
a container-escape vulnerability crosses every namespace on that node.
If your threat model includes that, you need node isolation plus a sandboxed
runtime, or separate clusters.
:::

## Common patterns

### Soft and hard, as a spectrum

| Level | What you get | What it costs | Suitable for |
|---|---|---|---|
| Namespace + quota + RBAC | Name scoping, fair share, least privilege | One object set per tenant | Internal teams |
| ...plus NetworkPolicy + PSA | Traffic isolation, no privileged pods | CNI that enforces policy; workloads that fit `restricted` | Internal teams handling sensitive data |
| ...plus dedicated nodes | No shared kernel between tenants | Wasted capacity, node pool per tenant | Regulated workloads |
| ...plus sandboxed runtime (`RuntimeClass` → gVisor, Kata) | A kernel boundary per pod | Syscall compatibility limits, 10-30% overhead | Untrusted code |
| Virtual control plane per tenant | Tenant-owned CRDs, cluster-scoped objects, API server | An API server per tenant | Tenants who need cluster-scoped objects |
| Cluster per tenant | Everything separate | N control planes, N upgrades, N of every add-on | Hostile tenants, contractual isolation |

The mistake is treating this as a ladder you must climb. Most organisations
belong on rung two and should spend their effort making rung two airtight.

### The cluster-scoped leak

Everything namespace-based fails the same way: cluster-scoped objects. A
tenant who can create any of these is not confined:

- `CustomResourceDefinition` — adds API surface for everyone
- `ValidatingWebhookConfiguration` / `MutatingWebhookConfiguration` — can
  intercept, or block, every request in the cluster
- `ValidatingAdmissionPolicy` and `MutatingAdmissionPolicy`
  (`admissionregistration.k8s.io/v1`; **GA in 1.30** and **GA in 1.36**
  respectively) — same reach, without a webhook
- `PriorityClass` — preempt other tenants' pods
- `StorageClass`, `IngressClass`, `GatewayClass` — affect other tenants'
  provisioning and routing
- `ClusterRole` / `ClusterRoleBinding` — the obvious one
- `PersistentVolume` — can bind to another tenant's data

None of these appear in the tenant `Role`. Audit for them regularly, because
they are usually granted accidentally, by binding a convenient ClusterRole.

### Virtual control planes

A virtual cluster runs a tenant's own API server and controller manager as
pods inside a host namespace, syncing the pods it schedules down to the host.
The tenant gets what looks like cluster-admin: their own CRDs, their own
`ClusterRole` objects, their own API versions, their own upgrade cadence.
The host cluster sees ordinary pods in one namespace.

**vCluster** (v0.37.1) is the mature implementation. The open-source project
is Apache-2.0 and requires no licence or platform connection; a free tier
adds features but requires connecting to the vendor's platform for licence
validation, and paid tiers add sleep mode, external datastores, SSO and
air-gapped support. Check which tier the feature you want lives in before
designing around it.

This is a genuine middle ground: much cheaper than a cluster per tenant,
much stronger than a namespace, and it solves the cluster-scoped-object
problem completely. It does **not** solve kernel isolation — the pods still
run on shared host nodes unless you also isolate nodes.

### Cluster per tenant

The strongest and the most expensive. It is the right answer for hostile
tenants, for compliance regimes that require it in writing, and for tenants
with genuinely divergent Kubernetes versions. The operational cost is not the
control plane; it is that every add-on, policy, dashboard and upgrade is now
an N-times problem, which is why fleet management (a shared GitOps repo,
ApplicationSets or Flux across clusters) becomes mandatory rather than nice.

### Tooling, honestly assessed

- **Hierarchical Namespace Controller (HNC)** — do not adopt it. The repo
  moved to `kubernetes-retired/hierarchical-namespaces`, is **archived**, and
  was last pushed in April 2025. The idea (policy inheritance down a
  namespace tree) was good; the implementation is no longer maintained.
- **Capsule** (`projectcapsule/capsule`, v0.14.6, September 2026) — actively
  released. It adds a `Tenant` custom resource that owns a set of namespaces,
  lets tenant owners self-serve new namespaces, and propagates quotas and
  policies across them. Worth evaluating if self-service namespace creation
  is the thing you are missing.
- A policy engine (Kyverno v1.19.1, Gatekeeper v3.23.1) or built-in
  [admission policies](admission-policies-cel.md) is usually a better
  investment than a tenancy framework: "every namespace must have a quota",
  "no tenant may create a ClusterRoleBinding", "images must come from our
  registry" are three rules that close most of the gaps above.

## Production considerations

**Provision tenants as code.** The five objects in
`examples/multi-tenancy/` are a template. Render them per tenant with
Kustomize components or a Helm chart, and apply them through GitOps, so a new
tenant is a pull request and a removed tenant is a revert. Hand-applied
tenant namespaces drift within weeks.

**Quotas need a feedback loop.** A quota that is always full is an outage
waiting to happen, and a quota nobody ever hits is not doing anything.
Alert on `kube_resourcequota` usage crossing 80%, and give tenants a
self-service path to ask for more.

**Node pressure is not covered by quota.** Quota bounds *requests*; the
kubelet evicts on actual usage. A tenant with generous limits and small
requests can still trigger evictions of another tenant's pods on the same
node. `maxLimitRequestRatio`, Guaranteed
[QoS](../k8s-intermediate/qos-classes.md) for anything important, and
[PriorityClasses](priority-and-preemption.md) you control are the mitigations.

**Shared add-ons are shared failure domains.** One ingress data plane, one
CoreDNS, one metrics pipeline, one CSI driver. A tenant that floods DNS
degrades everyone. Rate limits and per-tenant data planes cost money; decide
deliberately rather than discovering it during an incident.

**Cost attribution.** Namespace labels are the unit of chargeback. Put the
tenant label on the namespace from day one — retrofitting cost data is
impossible.

**Upgrades.** Pin `pod-security.kubernetes.io/enforce-version` per namespace
so a cluster upgrade does not change the rules for tenants without warning,
and audit with `warn`/`audit` at a stricter level than `enforce` before
tightening.

## Security considerations

**Threat: a tenant escalates through RBAC it was given.** The classic path is
the built-in `admin` ClusterRole bound with a RoleBinding.

*Exploit:* the tenant creates a `RoleBinding` in its own namespace binding
the `cluster-admin` ClusterRole to its own ServiceAccount. Kubernetes' own
privilege-escalation prevention blocks this *only* if the tenant does not
already hold those permissions or the `escalate` verb — but `admin` includes
`bind` on a set of roles, and the details are subtle enough that the safe
answer is not to grant it.

*Fix:* an explicit allow-list `Role`, as in
[`30-rbac.yaml`](../../examples/multi-tenancy/30-rbac.yaml), with no verbs on
`roles`, `rolebindings` or `serviceaccounts` you did not intend.

*Verify:* `kubectl auth can-i create rolebindings -n team-a --as=<tenant>`
must say `no`.

**Threat: a tenant reaches the cloud metadata endpoint.** From a pod,
`169.254.169.254` often returns node IAM credentials.

*Exploit:* `curl http://169.254.169.254/...` from any tenant pod, then use
the node's cloud role — frequently far broader than the tenant's.

*Fix:* the `except` blocks in the egress NetworkPolicy, plus IMDSv2 with a
hop limit of 1 on the cloud side. Do not rely on either alone.

*Verify:* from a tenant pod, confirm the request times out.

**Threat: a container escape crosses tenants.** A kernel vulnerability, or a
pod that PSA would have blocked running in a namespace that was created
without PSA labels.

*Exploit:* a privileged pod mounts the host filesystem and reads every
other tenant's Secrets from the kubelet's directories.

*Fix:* `restricted` PSA enforced on every tenant namespace, an admission
policy that requires the labels to exist on any new namespace, dedicated
nodes per trust level, and a sandboxed `RuntimeClass` for untrusted code.

*Verify:* create a privileged pod in the tenant namespace and confirm
admission rejects it; then confirm that creating a namespace *without* PSA
labels is itself rejected by policy.

**Threat: cross-namespace references.** A tenant's `HTTPRoute` naming another
namespace's Service, or a PVC binding a PV another tenant used.

*Fix:* Gateway API requires a `ReferenceGrant` in the target namespace for
cross-namespace backends — keep that default. Set `persistentVolumeReclaimPolicy: Delete`
or ensure reclaimed volumes are wiped.

*Verify:* create a cross-namespace `HTTPRoute` backend without a
`ReferenceGrant` and confirm the route reports `ResolvedRefs=False`.

## Troubleshooting

**"must specify requests.cpu" on every pod.** A quota on `requests.cpu` with
no `LimitRange` supplying defaults.

**"exceeded quota" but `describe resourcequota` shows room.** A different
quota in the same namespace, a scoped quota the pod matched, or the pod's
*limits* exceeding `limits.memory` rather than its requests exceeding
`requests.memory`. `describe` all of them.

**Pods rejected with a PSA message naming a field you did not set.** The
`restricted` profile requires `runAsNonRoot`, `allowPrivilegeEscalation:
false`, `capabilities.drop: ["ALL"]` and `seccompProfile: RuntimeDefault`
explicitly — absent is not the same as compliant.

**NetworkPolicy applied, nothing blocked.** The CNI does not implement
NetworkPolicy, or the policy's `podSelector` matches nothing. Check the CNI
first; the API server accepts the object either way.

**DNS fails in the tenant namespace.** Default-deny egress without a
`kube-system` DNS exception, or a `namespaceSelector` that does not match —
the reliable label is `kubernetes.io/metadata.name`, which the API server
sets automatically.

**A tenant can see other namespaces' pods.** Something bound a ClusterRole
with a ClusterRoleBinding. `kubectl get clusterrolebindings -o wide` and look
for the tenant's subjects.

## Common mistakes

- Treating a namespace as a security boundary without adding quota, PSA,
  NetworkPolicy and a narrow Role.
- Binding the `admin` ClusterRole to tenants, which hands them RoleBindings.
- A quota without a LimitRange, so nothing can be scheduled.
- Forgetting DNS egress after a default-deny policy, and spending a day
  debugging the application instead.
- `egress to 0.0.0.0/0` with no `except`, which re-opens the cluster and the
  metadata endpoint.
- Omitting `pod-security.kubernetes.io/enforce-version`, so a cluster upgrade
  silently changes the rules.
- Granting a tenant any cluster-scoped verb, most often through a convenient
  built-in ClusterRole.
- Adopting the Hierarchical Namespace Controller, which is archived.
- Assuming namespace isolation protects against untrusted code. It does not:
  the kernel is shared.
- Creating tenants by hand instead of from a template in Git.

## Related topics

- [LimitRange and ResourceQuota](../k8s-intermediate/limitrange-and-resourcequota.md)
- [Network policy](../k8s-intermediate/network-policy.md)
- [Pod Security Standards](../k8s-security/pod-security-standards.md)
- [RBAC](../k8s-security/rbac.md)
- [Policy engines](../k8s-security/policy-engines.md)
- [Admission policies with CEL](admission-policies-cel.md)
- [Priority and preemption](priority-and-preemption.md)
- [QoS classes](../k8s-intermediate/qos-classes.md)
- [Taints and tolerations](taints-and-tolerations.md)
- [GitOps with Argo CD](gitops-argo-cd.md)
- [Multi-cluster](../operations/multi-cluster.md)
