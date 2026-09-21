---
title: Migration labs
description: Modernise a bundle of legacy manifests - removed APIs, a PSP, and an ingress-nginx Ingress - and verify each fix.
level: advanced
type: lab
status: current
versions: Kubernetes 1.37, Gateway API 1.6.2
prerequisites:
  - migration/removed-api-versions
  - migration/ingress-to-gateway-api
  - migration/psp-to-pod-security-admission
---

## Overview

You have inherited a directory of manifests written for an old cluster. Your job
is to bring it to Kubernetes 1.37: swap every removed `apiVersion`, replace a
PodSecurityPolicy with Pod Security Admission, and turn an ingress-nginx Ingress
into Gateway API. Each exercise ends with a local verification you can run
without a cluster.

The input is `examples/migration/removed-apis/legacy-manifests.yaml` (five
objects on removed APIs) plus `examples/migration/ingress-to-gateway/ingress.yaml`
(a legacy Ingress). Solutions follow; try each before reading them.

## Setup

No cluster is needed — everything is validated client-side.

```bash
# The tools live in .tools/ (kubeconform) and via Docker (pluto).
.tools/kubeconform.exe -v
```

Look at what you are migrating:

```bash
cat examples/migration/removed-apis/legacy-manifests.yaml
docker run --rm -v "$PWD:/w" -w /w \
  us-docker.pkg.dev/fairwinds-ops/oss/pluto:v5.24.4 \
  detect-files -d examples/migration/removed-apis --target-versions k8s=v1.37.0
```

Pluto should report each removed version. That report is your worklist.

## Exercises

1. **Deployment.** The legacy `extensions/v1beta1` Deployment will not apply.
   Rewrite it to a 1.37-valid `apps/v1` Deployment. Remember what `apps/v1`
   requires that `extensions/v1beta1` did not.
2. **CronJob.** Move the `batch/v1beta1` CronJob to `batch/v1`.
3. **HorizontalPodAutoscaler.** Move the `autoscaling/v2beta1` HPA to
   `autoscaling/v2`. This one is not just an `apiVersion` swap — the metrics
   field shape changed.
4. **PodSecurityPolicy.** The `policy/v1beta1` PodSecurityPolicy cannot be
   ported to an API; it was removed with no replacement. Express the same
   intent (non-root, restricted volumes) as Pod Security Admission on the
   namespace.
5. **Ingress → Gateway API.** Turn `ingress.yaml` (ingress-nginx annotations
   and all) into a `Gateway` + `HTTPRoute`, preserving the HTTPS redirect and
   the `/api` prefix strip.
6. **Verify.** Run Pluto again on your fixed files and confirm zero findings,
   and run kubeconform against the 1.37 schemas.

## Solutions

### 1. Deployment → apps/v1

The removal to fix is `extensions/v1beta1` → `apps/v1`. `apps/v1` **requires**
`spec.selector`, which the old object omitted, and the selector must match the
pod template labels:

```yaml title="deployment.yaml (fragment)" fragment
apiVersion: apps/v1        # was extensions/v1beta1
kind: Deployment
metadata:
  name: legacy-api
  namespace: tasklane
spec:
  selector:                # newly required, must match template labels
    matchLabels:
      app: legacy-api
  template:
    metadata:
      labels:
        app: legacy-api
    spec:
      containers:
        - name: api
          image: tasklane-api:0.1.0
```

### 2. CronJob → batch/v1

A pure `apiVersion` swap; the schema is otherwise compatible:

```yaml title="cronjob.yaml (fragment)" fragment
apiVersion: batch/v1       # was batch/v1beta1
kind: CronJob
```

### 3. HPA → autoscaling/v2

The `apiVersion` changes **and** the metric moves from the flat
`targetAverageUtilization` to the structured `target` block:

```yaml title="hpa.yaml (fragment)" fragment
apiVersion: autoscaling/v2   # was autoscaling/v2beta1
kind: HorizontalPodAutoscaler
metadata:
  name: legacy-api
  namespace: tasklane
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: legacy-api
  minReplicas: 2
  maxReplicas: 6
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:                    # v2 shape
          type: Utilization
          averageUtilization: 70
```

### 4. PodSecurityPolicy → Pod Security Admission

There is no target API. The `MustRunAsNonRoot` + restricted-volume PSP maps to
the **restricted** PSS level, applied as namespace labels — no per-workload
object at all:

```yaml title="namespace.yaml (fragment)" fragment
apiVersion: v1
kind: Namespace
metadata:
  name: tasklane
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: v1.37
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/audit: restricted
```

Delete the PSP and any `ClusterRole` that granted `use` on
`podsecuritypolicies`. Roll out `warn`/`audit` before `enforce` on a real
cluster (see
[the PSP migration page](psp-to-pod-security-admission.md#migration-steps)).

### 5. Ingress → Gateway API

The full answer is the worked pair in `examples/migration/ingress-to-gateway/`:

```yaml include="examples/migration/ingress-to-gateway/gateway.yaml"
```

The `ssl-redirect` annotation becomes a `RequestRedirect` filter, the
`rewrite-target` becomes a `URLRewrite` filter, `secretName` becomes
`certificateRefs`, and `ingressClassName` splits into `gatewayClassName` plus a
`parentRef`. The mapping table is in
`examples/migration/ingress-to-gateway/notes.md`.

### 6. Verify

```bash
# Pluto should now report no removed or deprecated versions in your fixed dir.
docker run --rm -v "$PWD:/w" -w /w \
  us-docker.pkg.dev/fairwinds-ops/oss/pluto:v5.24.4 \
  detect-files -d <your-fixed-dir> --target-versions k8s=v1.37.0

# kubeconform checks each object against the real 1.37 schemas
# (add the CRD schema-location line for the Gateway objects).
.tools/kubeconform.exe -strict -summary -kubernetes-version 1.37.0 \
  -schema-location default \
  -schema-location "https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json" \
  examples/migration/ingress-to-gateway/gateway.yaml
```

## Common mistakes

- **Swapping only the `apiVersion` on the Deployment** and forgetting the now-
  required `spec.selector`.
- **Treating the HPA as a pure version bump** — the metrics field shape changed
  from `v2beta1` to `v2`.
- **Looking for a PSP replacement API.** There is none; it becomes namespace
  labels plus, if you need mutation or custom rules, a policy engine.
- **Dropping the HTTPS redirect or the prefix strip** when moving the Ingress,
  because they were annotations rather than spec fields.
- **Verifying against the wrong schema version.** Always pass
  `-kubernetes-version 1.37.0`.

## Related topics

- [Removed API versions](removed-api-versions.md)
- [Migrating from Ingress to Gateway API](ingress-to-gateway-api.md)
- [From PodSecurityPolicy to Pod Security Admission](psp-to-pod-security-admission.md)
- [Manifest field reference](../reference/manifest-field-reference.md)
- [Deprecated API detection](../operations/deprecated-api-detection.md)
