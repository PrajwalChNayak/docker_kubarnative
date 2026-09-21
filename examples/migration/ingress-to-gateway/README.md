# ingress-to-gateway

A before/after pair for migrating a legacy Ingress to Gateway API.

| File | Role |
|---|---|
| `ingress.yaml` | BEFORE: a legacy `networking.k8s.io/v1` Ingress written for ingress-nginx, with `ssl-redirect` and `rewrite-target` annotations. Frozen API, retired controller. |
| `gateway.yaml` | AFTER: the equivalent `Gateway` + three `HTTPRoute` objects (redirect + application), Gateway API v1. |
| `notes.md` | Field-by-field mapping table and the status conditions to verify. |

These are illustrative migration artifacts, not part of the running lab stack.
The lab's real Gateway lives in `examples/k8s/04-gateway/` and `examples/k8s/05-tls/`.

Validate locally (no cluster needed):

```bash
.tools/kubeconform.exe -strict -summary -kubernetes-version 1.37.0 \
  examples/migration/ingress-to-gateway/ingress.yaml

.tools/kubeconform.exe -strict -summary -kubernetes-version 1.37.0 \
  -schema-location default \
  -schema-location "https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json" \
  examples/migration/ingress-to-gateway/gateway.yaml
```

The full narrative is in `content/migration/ingress-to-gateway-api.md`.
