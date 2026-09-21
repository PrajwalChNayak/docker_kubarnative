---
title: Service has no endpoints
description: Why a Service resolves but nothing answers — selector and label mismatch, pods not Ready, port-name mismatch — and how to read EndpointSlices in 1.37.
level: intermediate
type: troubleshooting
status: current
versions: Kubernetes 1.37
prerequisites:
  - troubleshooting/method
  - k8s-beginner/services
  - k8s-intermediate/kube-proxy-and-endpointslices
---

## Overview

A Service that "cannot be reached" while its pods are healthy almost always has
**no endpoints**: nothing is behind it. The Service's ClusterIP and DNS name
exist, but the set of pod IPs it forwards to is empty, so connections are refused
or time out. The cause is a mismatch between what the Service selects and what
the pods are (labels), or pods that are running but not `Ready`. This page shows
how to confirm an empty endpoint set and find the mismatch.

## Symptoms

- Requests to the Service name/ClusterIP get `connection refused` or hang, but
  the backing pods are `Running` and `Ready`.
- `kubectl get endpointslices` for the Service shows no addresses (or none
  `ready`).
- DNS resolves the Service fine (it is a selector/endpoint problem, not a name
  problem).

Reproducer (a Service selector that matches no pod):

```yaml include="examples/troubleshooting/service-no-endpoints.yaml"
```

```console include="captures/troubleshooting/service-no-endpoints.txt"
```

## How it works underneath

A `Service` with a selector does not forward to pods directly. The
**EndpointSlice controller** watches for pods whose labels match the Service's
`selector` **and** that are `Ready`, and writes their IPs and ports into
`EndpointSlice` objects (`discovery.k8s.io/v1`). `kube-proxy` (or the CNI's
service implementation) programs the dataplane from those slices. If the slice is
empty, there is nothing to forward to.

So an empty endpoint set has a short list of causes:

| Cause | What to check |
|---|---|
| **Selector ≠ pod labels** | the Service `selector` does not equal the labels on the pods (the reproducer) |
| **Pods not Ready** | pods match but fail readiness, so they are excluded from `ready` endpoints |
| **Port name mismatch** | `targetPort` names a port the container does not expose under that name |
| **No pods at all** | the Deployment scaled to 0, or its own selector matches nothing |
| **Wrong namespace** | the Service and pods are in different namespaces |

:::note EndpointSlice, not Endpoints
The older `v1 Endpoints` API has been **deprecated since Kubernetes 1.33** in
favour of `discovery.k8s.io/v1` EndpointSlice. `kubectl get endpoints` still
works for now, but inspect `endpointslices` — they are what the controllers and
kube-proxy actually use, and they scale to large Services.
:::

## Diagnosis

1. **Confirm the endpoint set is empty.**

   ```bash
   kubectl -n <ns> get endpointslices -l kubernetes.io/service-name=<svc> -o wide
   ```

   No `ENDPOINTS`/addresses listed confirms it.

2. **Compare selector to pod labels.**

   ```bash
   kubectl -n <ns> get svc <svc> -o jsonpath='{.spec.selector}{"\n"}'
   kubectl -n <ns> get pods --show-labels
   ```

   The selector must be a subset of the labels on the target pods. In the
   reproducer, the Service selects `app.kubernetes.io/name=sample-app-typo` while
   the pods carry `app.kubernetes.io/name=sample-app`.

3. **If labels match, check readiness.** Running-but-not-Ready pods are excluded:

   ```bash
   kubectl -n <ns> get pods -o wide
   ```

   `0/1 READY` means a probe is failing — see [failing probes](failing-probes.md).

4. **Check the port mapping.** A named `targetPort` must match a container port
   name:

   ```bash
   kubectl -n <ns> get svc <svc> -o jsonpath='{.spec.ports}{"\n"}'
   kubectl -n <ns> get pod <pod> -o jsonpath='{.spec.containers[*].ports}{"\n"}'
   ```

## Fixes

- **Selector mismatch.** Make the Service `selector` equal the pods' labels (fix
  the typo). Selectors are exact-match; a single wrong character breaks them.
- **Pods not Ready.** Fix the readiness probe or the app so pods become Ready and
  are added to the slice.
- **Port name mismatch.** Align the Service `targetPort` (name or number) with a
  container port. Named ports are safest when both sides agree on the name.
- **No pods.** Scale the workload up, or fix the Deployment's own selector so it
  actually owns pods.
- **Cross-namespace.** A selector Service only picks pods in its own namespace;
  put them together, or use a Service of type `ExternalName`/manual EndpointSlice
  for a genuinely external target.

## Prevention

- Keep one canonical label set (`app.kubernetes.io/name`, `.../component`) and
  reuse it for the Deployment selector, pod template labels and Service
  selector, so they cannot drift. The Tasklane manifests do this throughout.
- Use **named ports** end to end (`http`) so a renumbering does not silently
  break the mapping.
- Add a smoke test after deploy that hits the Service and asserts a non-empty
  endpoint set, not just that pods are Running.
- Template labels (Kustomize `commonLabels`, Helm) so selector and labels come
  from one source.

## Common mistakes

- A one-character selector typo, invisible until you diff selector against
  labels.
- Assuming DNS resolution proves reachability — an empty Service resolves fine.
- Forgetting that not-Ready pods are excluded, and chasing the Service when the
  bug is a readiness probe.
- A `targetPort` name that does not match any container port.
- Looking only at `Endpoints` and missing that EndpointSlice is the source of
  truth in 1.37.

## Related topics

- [A method for debugging Kubernetes](method.md)
- [Failing probes](failing-probes.md)
- [DNS failures](dns-failures.md)
- [Services](../k8s-beginner/services.md)
- [kube-proxy and EndpointSlices](../k8s-intermediate/kube-proxy-and-endpointslices.md)
