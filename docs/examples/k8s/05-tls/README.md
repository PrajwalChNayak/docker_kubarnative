# Stage 5: TLS, redirects and traffic splitting

Kubernetes 1.37, Gateway API v1.6.2 (standard channel), Envoy Gateway v1.9.1,
cert-manager v1.21.2.

This stage puts an HTTPS listener on the Gateway from stage 4, issues its
certificate from a private CA built by cert-manager, redirects plain HTTP to
HTTPS, and splits traffic between a stable and a canary backend.

It **replaces** two objects from `examples/k8s/04-gateway/gateway.yaml` — the
`Gateway` `tasklane/tasklane` and the `EnvoyProxy` `kind-nodeport` — by
applying objects with the same names. The `GatewayClass` is unchanged.

## What is in here

| File | Contents |
|---|---|
| `10-issuers.yaml` | self-signed `ClusterIssuer` → CA `Certificate` → CA `ClusterIssuer` |
| `20-certificate.yaml` | `Certificate` for `tasklane.localhost`, into Secret `tasklane-tls` |
| `30-gateway.yaml` | `Gateway` with the stage-4 `http` listener plus an `https` listener (`tls.mode: Terminate`) |
| `40-envoyproxy.yaml` | `EnvoyProxy` patch pinning NodePort 30443 for port 443 |
| `50-canary.yaml` | `tasklane-api-canary` Deployment + Service |
| `60-routes.yaml` | HTTP→HTTPS redirect route, plus the app route with header matching and weighted backends |

## Prerequisites

Stages 1 to 4 applied, and cert-manager installed with its CRDs:

```bash
helm repo add jetstack https://charts.jetstack.io
helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace \
  --version v1.21.2 --set crds.enabled=true
```

cert-manager can also watch Gateways directly and create Certificates from
annotations. That needs `--set config.gatewayAPI.enabled=true` on the chart and
is not used here: this stage writes the `Certificate` object explicitly, which
works on any cert-manager 1.21 install.

## Apply

Order matters for the first two Gateway objects. Envoy Gateway creates a
Service port only for a port that a listener asks for, and the strategic-merge
patch in `40-envoyproxy.yaml` matches Service ports by number. Patching 443
before the HTTPS listener exists appends a port with no name, the API server
rejects the whole Service, and the data plane silently keeps its old config.

```bash
kubectl apply -f examples/k8s/05-tls/10-issuers.yaml
kubectl -n cert-manager wait --for=condition=Ready certificate/tasklane-ca --timeout=120s
kubectl apply -f examples/k8s/05-tls/20-certificate.yaml
kubectl -n tasklane wait --for=condition=Ready certificate/tasklane-tls --timeout=120s
kubectl apply -f examples/k8s/05-tls/30-gateway.yaml
kubectl -n tasklane wait --for=condition=Programmed gateway/tasklane --timeout=120s
kubectl apply -f examples/k8s/05-tls/40-envoyproxy.yaml
kubectl apply -f examples/k8s/05-tls/50-canary.yaml
kubectl apply -f examples/k8s/05-tls/60-routes.yaml
kubectl -n tasklane rollout status deployment/tasklane-api-canary
```

## Verify

```bash
kubectl -n tasklane get certificate,gateway,httproute
kubectl -n tasklane describe gateway tasklane
kubectl -n envoy-gateway-system get svc   # the Envoy Service should now list 80:30080 and 443:30443
```

A healthy Gateway has `Accepted=True` and `Programmed=True`, and each listener
reports `ResolvedRefs=True`; a certificate Secret that does not exist yet shows
up as `ResolvedRefs=False` with reason `InvalidCertificateRef`. Each HTTPRoute's
`status.parents[].conditions` must show `Accepted=True` and `ResolvedRefs=True`
for every parent it names.

Export the CA and call the endpoint. The CA issuer copies its own certificate
into the `ca.crt` key of the leaf Secret, which is exactly what `curl --cacert`
needs:

```bash
kubectl -n tasklane get secret tasklane-tls -o jsonpath='{.data.ca\.crt}' | base64 -d > /tmp/tasklane-ca.crt
curl --cacert /tmp/tasklane-ca.crt --resolve tasklane.localhost:8443:127.0.0.1 \
  https://tasklane.localhost:8443/
```

`--resolve` is belt and braces: curl already maps `*.localhost` to the loopback
address, but this makes the mapping explicit.

Check the redirect, the split and the header override:

```bash
# 301 to https://tasklane.localhost:8443/
curl -sS -o /dev/null -D - --resolve tasklane.localhost:8080:127.0.0.1 \
  http://tasklane.localhost:8080/

# ~9 of 10 responses name a tasklane-api pod, ~1 names the canary pod
for i in $(seq 1 20); do
  curl -s --cacert /tmp/tasklane-ca.crt --resolve tasklane.localhost:8443:127.0.0.1 \
    https://tasklane.localhost:8443/
  echo
done | sort | uniq -c

# pin a request to the canary
curl -s -H 'x-tasklane-track: canary' --cacert /tmp/tasklane-ca.crt \
  --resolve tasklane.localhost:8443:127.0.0.1 https://tasklane.localhost:8443/
```

Inspect the certificate the listener actually serves:

```bash
openssl s_client -connect 127.0.0.1:8443 -servername tasklane.localhost \
  -CAfile /tmp/tasklane-ca.crt </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -dates
```

## Rolling back to stage 4

Reverse the order for the same reason: shrink the patch before removing the
listener, or the Service keeps a port no listener owns.

```bash
kubectl delete -f examples/k8s/05-tls/60-routes.yaml -f examples/k8s/05-tls/50-canary.yaml
kubectl apply -f examples/k8s/04-gateway/gateway.yaml   # EnvoyProxy back to port 80 only
kubectl -n tasklane delete certificate tasklane-tls
kubectl -n tasklane delete secret tasklane-tls
```

Applying `04-gateway/gateway.yaml` also restores the stage-4 HTTPRoute
`tasklane-api`, which is attached to the `http` listener only.

## Notes

- The certificate is issued by a private CA, so browsers show a warning unless
  you import `ca.crt`. That is correct behaviour, not a bug.
- `duration: 2160h` / `renewBefore: 360h` mirror a public ACME certificate's
  90-day life. cert-manager renews on its own; nothing here needs a cron job.
- `privateKey.rotationPolicy: Always` generates a fresh key on every renewal.
  The alternative, `Never`, keeps the key and only re-signs it.
- Traffic splitting here is manual. Progressive delivery tools (Argo Rollouts,
  Flagger) drive the same `backendRefs` weights automatically; see Part H.
