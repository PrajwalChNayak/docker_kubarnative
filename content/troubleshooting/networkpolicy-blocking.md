---
title: NetworkPolicy blocking traffic
description: The default-deny gotchas — missing DNS egress, namespaceSelector vs podSelector AND/OR semantics, CNI enforcement, and a repeatable order for debugging dropped connections.
level: advanced
type: troubleshooting
status: current
versions: Kubernetes 1.37
prerequisites:
  - troubleshooting/method
  - k8s-intermediate/network-policy
  - k8s-security/network-segmentation
---

## Overview

`NetworkPolicy` is allow-listing: once any policy selects a pod for a direction,
everything not explicitly allowed in that direction is denied. That inversion is
the source of most "it worked until we added the policy" outages. Connections
time out with no error on either end, because a drop is silent. This page covers
the recurring traps — forgetting DNS egress, misreading selector AND/OR
semantics, and assuming enforcement — and gives a fixed debugging order.

## Symptoms

- A connection that worked stops working right after a policy is applied:
  timeouts, not refusals (a drop looks like the peer is not there).
- DNS suddenly fails for pods a new egress policy selects (see
  [DNS failures](dns-failures.md)).
- Traffic works one direction but not the other, or from one namespace but not
  another.
- Nothing in application logs explains it; the packet never arrives.

## How it works underneath

A `NetworkPolicy` (`networking.k8s.io/v1`) selects pods with `podSelector` and
lists `ingress` and/or `egress` rules. The rules that matter most in practice:

- **Selecting a pod switches it to deny-by-default for that direction.** A
  policy with `policyTypes: [Ingress]` and an empty `ingress: []` denies *all*
  ingress to the selected pods. The canonical default-deny is exactly this.
- **Egress and ingress are independent.** Allowing ingress does nothing for
  egress. A default-deny **egress** policy blocks the pod from reaching anything
  — including CoreDNS — until you add egress allows.
- **Policies are additive (OR across policies).** If two policies select a pod,
  a connection is allowed if **any** policy allows it. You cannot "subtract" with
  a second policy.

### The AND/OR trap in a single rule

Within one rule's `from`/`to`, the combination of selectors has subtle
semantics:

```yaml title="peers.yaml" fragment
# One peer element: namespaceSelector AND podSelector
# (pods matching podSelector IN namespaces matching namespaceSelector)
- from:
    - namespaceSelector:
        matchLabels: { kubernetes.io/metadata.name: tasklane }
      podSelector:
        matchLabels: { app.kubernetes.io/name: tasklane-api }
```

```yaml title="peers-or.yaml" fragment
# Two peer elements: namespaceSelector OR podSelector
# (pods in those namespaces, OR pods with that label in the SAME namespace)
- from:
    - namespaceSelector:
        matchLabels: { kubernetes.io/metadata.name: tasklane }
    - podSelector:
        matchLabels: { app.kubernetes.io/name: tasklane-api }
```

When `namespaceSelector` and `podSelector` are **in the same list element** (no
`-` between them) they are **AND**ed. When they are **separate list elements**
(each with its own `-`) they are **OR**ed. Getting this wrong is the difference
between "the API pods in the tasklane namespace" and "everything in the tasklane
namespace, plus any pod anywhere labelled tasklane-api." A bare `podSelector`
with no `namespaceSelector` means the same namespace only.

### DNS egress must be allowed explicitly

A default-deny egress policy blocks port 53 to CoreDNS, so every name lookup
fails. Every default-deny egress needs a companion rule allowing UDP/TCP 53 to
the `kube-system` DNS pods (or namespace). This single omission causes more
NetworkPolicy incidents than anything else.

### Enforcement depends on the CNI

`NetworkPolicy` objects are inert unless the CNI enforces them. Some CNIs ignore
them entirely; others (Calico, Cilium, and the lab's **kindnet**, which enforces
NetworkPolicy) apply them. If policies seem to have no effect, confirm the CNI
enforces them before debugging the rules. Conversely, ordering of rule
evaluation is not something you control — policies are additive allow-lists, not
an ordered firewall.

## Diagnosis

Follow this order every time:

1. **Does the CNI enforce policy?** If not, the policy is not your problem
   (or your protection). In the lab, kindnet enforces it.

2. **What selects the pod?** List policies in the namespace and see which select
   your pod and in which direction:

   ```bash
   kubectl -n <ns> get networkpolicy
   kubectl -n <ns> describe networkpolicy <name>
   ```

3. **Is it egress, ingress, or DNS?** Test name resolution and a raw connection
   separately from inside the pod:

   ```bash
   kubectl -n <ns> debug -it <pod> --image=busybox:1.37 --target=<container> -- \
     nslookup <peer-service>
   kubectl -n <ns> debug -it <pod> --image=busybox:1.37 --target=<container> -- \
     wget -qO- --timeout=3 http://<peer-service>/
   ```

   Name fails but you expected it to resolve ⇒ DNS egress is blocked. Name
   resolves but connect times out ⇒ an ingress/egress allow is missing.

4. **Read the selectors literally**, checking the AND vs OR structure above and
   confirming label values with `kubectl get ns --show-labels` and
   `kubectl get pods --show-labels`.

## Fixes

- **Add DNS egress** to every default-deny egress policy: allow UDP and TCP 53 to
  the kube-system DNS pods.
- **Add the specific allow** the connection needs, on the correct side (ingress
  on the destination, egress on the source — you often need both when both ends
  are policy-selected).
- **Fix AND/OR**: merge selectors into one list element to AND them, or split
  them into separate elements to OR them, to match your intent.
- **Confirm namespace labels** exist; `namespaceSelector` matches namespace
  labels (the built-in `kubernetes.io/metadata.name` is reliable).
- **Verify CNI enforcement** matches your expectation before trusting or blaming
  a policy.

## Prevention

- Template a **default-deny + DNS-allow** pair as the baseline for every
  namespace, then add specific allows. Never ship default-deny egress without the
  DNS allow.
- Keep policies small and named by intent (`allow-api-to-db`), so the additive
  set is readable.
- Test policies in a disposable namespace with the same CNI before rolling them
  to production.
- Document that connectivity needs allows on **both** ends when both ends are
  policy-selected.

## Common mistakes

- Default-deny egress with no DNS allow — the number-one NetworkPolicy outage.
- Misreading AND vs OR for `namespaceSelector`/`podSelector` in one rule.
- Allowing ingress and expecting egress to work too (they are independent).
- Assuming a policy is enforced when the CNI ignores NetworkPolicy.
- Debugging application code for what is a silently dropped packet.

## Related topics

- [A method for debugging Kubernetes](method.md)
- [DNS failures](dns-failures.md)
- [Service has no endpoints](service-no-endpoints.md)
- [Network policy](../k8s-intermediate/network-policy.md)
- [Network segmentation](../k8s-security/network-segmentation.md)
