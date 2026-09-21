# Contributing to the Docker & Kubernetes Handbook

Read this whole file before writing a single page. It holds the authoring
conventions, the verified facts every page must agree with, the page
inventory, and the rules that stop 2021-era Kubernetes from leaking in.

The detailed, source-linked fact base is in `research/k8s-facts.md` and
`research/tooling-facts.md`. **Read both.** When this file and the research
files disagree, the research files win. Tell the maintainer about the conflict.

---

## 1. Baseline versions (verified 2026-09-21)

Every page states the version it was written against in front matter
(`versions:`). Document these as **current**:

| Component | Current | Notes |
|---|---|---|
| Kubernetes | **1.37** (1.37.0, 2026-08-26, "Garhwal") | Document against 1.37. Every manifest must use API versions served by 1.37. |
| Supported K8s minors | 1.37 (EOL 2027-10-28), 1.36 (1.36.4, EOL 2027-06-28), 1.35 (1.35.8, EOL 2027-02-28), 1.34 (1.34.11, **EOL 2026-10-27: ends within weeks, say so**) | 1.33 and older are unsupported. Three minors a year, about 14 months of patches each. |
| Docker Engine | **29** (29.8.1, 2026-09-15) | Cycle 28 was EOL 2026-05-13. 25.0 is supported to 2026-12-04 per endoflife.date only (docs.docker.com does not state it). |
| Docker Compose | **v5** (v5.5.1, 2026-09-03) | Always `docker compose` (plugin). Never a top-level `version:` key. |
| Dockerfile frontend | `# syntax=docker/dockerfile:1` | `:1` currently resolves to 1.26.0 on Docker Hub, although 1.27.0 exists. |
| Buildx | v0.37.1 | BuildKit is the default builder. |
| Helm | **4** (v4.3.0, 2026-09-09) | Helm 3: bug fixes ended 2026-09-09, security fixes until 2027-02-10. |
| containerd | 2.4.0 (2.3 is LTS to 2028-04-30) | kind 1.37 nodes run containerd 2.3.4. |
| runc | 1.5.1 | |
| CRI-O | 1.37.0 | |
| kind | v0.33.0 | Node image `kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5` |
| minikube / k3d / k3s | v1.39.0 / v5.9.0 / v1.37.0+k3s1 | |
| Kustomize | v5.8.1 (built into kubectl 1.37) | |
| Gateway API | **v1.6.2** | Implementation used in the lab: Envoy Gateway v1.9.1 |
| cert-manager | v1.21.2 | |
| Argo CD / Flux | v3.5.3 / v2.9.5 | |
| Prometheus / Grafana / Loki | v3.14.0 / v13.2.2 / v3.7.8 | Grafana and Loki are AGPLv3. |
| OpenTelemetry Collector | v0.161.0 | |
| kube-prometheus | v0.18.0 | Compatibility table lists K8s 1.33 to 1.36 only. Say so. |
| metrics-server | v0.9.0 | |
| KEDA / Karpenter / VPA / Cluster Autoscaler | v2.20.2 / v1.14.1 / 1.7.1 / 1.36.1 | Cluster Autoscaler has no 1.37 release yet. |
| Velero | v1.18.2 | Repo moved to `github.com/velero-io/velero`. CNCF Sandbox. |
| Kyverno / Gatekeeper / Falco | v1.19.1 / v3.23.1 / 0.44.1 | |
| Trivy / Grype / Syft / cosign | v0.74.0 / v0.119.0 / v1.52.0 / v3.1.3 | |
| Cilium / Calico / Istio / Linkerd | v1.20.2 / v3.32.2 / 1.31.0 / edge-26.9.3 | Linkerd open-source publishes **edge** releases only. Stable builds come from Buoyant. |
| Sealed Secrets / External Secrets | v0.40.0 / v2.11.0 | Sealed Secrets moved to `github.com/bitnami/sealed-secrets`. |
| Podman | v6.1.2 | Repo moved to `github.com/podman-container-tools/podman`. Podman 6 removed cgroup v1, CNI, iptables, slirp4netns. |
| hadolint / kubeconform / Pluto / kube-bench | v2.15.1 / v0.8.0 / v5.24.4 / v0.16.0 | kubent is effectively unmaintained (last release 0.7.3, 2024). Recommend Pluto. |
| Argo Rollouts / Flagger | v1.10.0 / v1.45.0 | |
| MinIO | **archived 2026-04-25** | Do not use MinIO as an example object store. |

### Kubernetes release facts. Use exactly this maturity.

Full detail and sources: `research/k8s-facts.md` sections 1 to 3.

- **1.35**: In-place Pod Resize (container-level, `InPlacePodVerticalScaling`) **GA**. Job `managedBy` GA. kubelet config drop-in directory GA. Fine-grained SupplementalGroups control GA (the feature-gate docs page still says Beta; the release post and KEP say GA). **cgroup v1 is deprecated**: `failCgroupV1` defaults to true since 1.35. cgroup v1 is **not removed**, but document **cgroup v2 as the baseline**.
- **1.36**: User Namespaces GA. **Pod-level** in-place resize (`InPlacePodLevelResourcesVerticalScaling`) Beta, on by default. This is a different feature from the 1.35 container-level GA. PSI metrics GA. Volume Group Snapshots GA (`groupsnapshot.storage.k8s.io/v1`). Declarative Validation GA. Fine-grained kubelet API authorisation GA. SELinux: `SELinuxChangePolicy` and the ReadWriteOncePod part GA in 1.36; `SELinuxMount` GA in **1.37**. **Service `externalIPs` is deprecated in 1.36, not removed.** kube-proxy support is disabled no earlier than 1.40 and removed no earlier than 1.43. Server-side sharded list/watch is **Alpha** (off by default).
- **1.37**: Storage Version Migration GA and on by default (per release post and KEP; the gate docs page lags). Metrics API `metrics.k8s.io/v1` stable. v1beta1 is still served, and **the HPA controller still uses v1beta1**. HPA scale-to-zero **Beta** (`HPAScaleToZero`, on by default). kubelet in user namespace Beta (`KubeletInUserNamespace`, on by default). It does *not* by itself make the kubelet rootless. Memory QoS Beta, on. **Pod-level resource managers Beta but OFF by default** (`PodLevelResourceManagers`). Native histograms Beta. Pod certificates and ClusterTrustBundles **GA** (`certificates.k8s.io/v1`); no in-tree signer ships. DRA improvements (see research file). etcd RangeStream **Beta**, on, needs etcd 3.7+.
- Other: **Endpoints is deprecated since 1.33** in favour of `discovery.k8s.io/v1` EndpointSlice. Sidecar containers (restartable init containers) stable since 1.33. ValidatingAdmissionPolicy GA since 1.30; **MutatingAdmissionPolicy GA since 1.36**, both `admissionregistration.k8s.io/v1`. Version skew: kubelet may be up to **3** minors older than kube-apiserver and never newer; kubectl within ±1.
- **No API versions were removed in 1.33 to 1.37.** The last removal was 1.32 (flowcontrol v1beta3).

### Removed API versions (never present as current)

`extensions/v1beta1` (all kinds); `apps/v1beta1`, `apps/v1beta2`;
`networking.k8s.io/v1beta1` (Ingress, IngressClass); `policy/v1beta1`
(PodDisruptionBudget, PodSecurityPolicy); `batch/v1beta1` (CronJob);
`autoscaling/v2beta1`, `autoscaling/v2beta2`; `discovery.k8s.io/v1beta1`;
`events.k8s.io/v1beta1`; `node.k8s.io/v1beta1`; `storage.k8s.io/v1beta1`
(CSIDriver, CSINode, StorageClass, VolumeAttachment, CSIStorageCapacity);
`rbac.authorization.k8s.io/v1beta1`; `scheduling.k8s.io/v1beta1`;
`admissionregistration.k8s.io/v1beta1`; `apiextensions.k8s.io/v1beta1`;
`apiregistration.k8s.io/v1beta1`; `authentication.k8s.io/v1beta1`;
`authorization.k8s.io/v1beta1`; `certificates.k8s.io/v1beta1`;
`coordination.k8s.io/v1beta1`; `flowcontrol.apiserver.k8s.io/v1beta1|v1beta2|v1beta3`.
`scripts/check.mjs` flags these outside the migration section.

### ingress-nginx is retired. This is critical.

- Announced 2025-11-11. Retired and the repo archived **2026-03-24**. The last release is controller v1.15.1. There will be **no** further releases, bug fixes or security patches. Existing installs keep running and the artifacts stay downloadable.
- **Gateway API is the primary way to expose HTTP traffic in this handbook.** Standard channel v1: GatewayClass, Gateway, HTTPRoute, GRPCRoute, ReferenceGrant (serves v1), BackendTLSPolicy, TLSRoute, TCPRoute, UDPRoute and ListenerSet. See `research/k8s-facts.md` section 8 for exact versions and channels.
- The **Ingress API** (`networking.k8s.io/v1`) still exists and is GA and frozen. Teach it only as **Legacy**, with maintained controllers (F5 NGINX Ingress Controller, Traefik, HAProxy, Contour, Kong, Envoy Gateway). **Never** recommend installing `kubernetes/ingress-nginx` for new work.

### Long-removed things that tutorials still show

- **dockershim** was removed in 1.24. Kubernetes runs a CRI runtime (containerd, CRI-O), not Docker. Docker-built images run fine because they are OCI images.
- **PodSecurityPolicy** was removed in 1.25. Use Pod Security Admission and admission policies.
- **Compose v1** (`docker-compose`, Python) is long EOL. Compose v5 skipped v3 and v4 to avoid confusion with old compose-*file* versions. v5.0.0 removed the internal builder; builds are delegated to Bake. See `research/tooling-facts.md` section 2.
- **Helm 3 to 4**: server-side apply is the default on new installs. `--wait` became a strategy (`watcher|hookOnly|legacy`, default `hookOnly`). `--atomic` became `--rollback-on-failure`. `--force` became `--force-replace`. Post-renderers are plugins now. Chart `apiVersion: v2` still works; chart API v3 is experimental. Some flag removals are UNVERIFIED (see research). Do not state them as fact.

### Docker facts

- Docker Desktop is free for companies with **fewer than 250 employees AND less than $10 million annual revenue**, and for personal, education and non-commercial open-source use. Everyone else needs a paid subscription. State this factually. Mention Docker Engine on Linux, Podman, Colima and Rancher Desktop as alternatives without advocacy.
- Docker Hub pull limits are counted per 6 hours: 100 unauthenticated (per IPv4 or IPv6 /64), 200 Personal, unlimited on paid plans.
- Engine 29: containers default to a 1024 open-file soft limit. The containerd image store is the default on fresh installs. nftables is experimental. Rootless uses `gvisor-tap-vsock` by default since 29.5.0.
- Default attestations: only minimal provenance is attached by default; SBOM is opt-in (`--sbom=true`).
- `gcr.io/distroless/*-debian12` tags are deprecated. Use `-debian13`.
- Docker Hardened Images have been free (Apache-2.0 "Community" tier) since 2025-12-17.

---

## 2. The rule against invented output. Non-negotiable.

- **Never write command output by hand.** Output shown on a page must come from a real run, stored as a file under `captures/`, and included with `include=`. See section 5.
- You (a writing agent) **must not run** `docker build`, `docker run`, `kind`, `helm install` or any `kubectl` command that talks to a cluster. The maintainer owns the single lab cluster and runs every capture at the end.
- To show output, add a capture request (section 5.4) and reference the capture file. Until the maintainer runs it, the page renders "output not captured yet". That is honest. A made-up output is not.
- Do not describe specific values from output you have not seen, such as IPs, ages or hashes. Describing the known *shape* of output is fine, for example which columns `kubectl get pods` prints.
- **Never invent a flag, field, API version, annotation or CLI command.** If you cannot verify it, leave it out and list it in your final report under "Unverified".

Tools you **may** run, because they are local and need no cluster:
- `.tools/kubeconform.exe -strict -summary -kubernetes-version 1.37.0 <files>` (downloads schemas from GitHub raw). For CRDs add `-schema-location default -schema-location "https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json"`.
- `.tools/kubectl.exe <cmd> --help`, `.tools/kubectl.exe kustomize <dir>`, `.tools/helm.exe <cmd> --help`, `.tools/helm.exe lint|template <chart>`. These are client-side only.
- `docker <cmd> --help`, `docker compose -f <file> config` (parse only), and `docker run --rm -i hadolint/hadolint:v2.15.1 hadolint - < Dockerfile`.
- `node scripts/check.mjs` (read-only lint) when it exists.
- WebFetch or WebSearch against primary sources to verify a fact.

---

## 3. Repository layout

```
content/                     Markdown source (you write here)
  index.md                   home (maintainer)
  learning-path.md           (maintainer)
  nav.json                   sections and parts order (maintainer)
  <part>/_part.json          page order for one part (part owner)
  <part>/<page>.md           one topic per file, kebab-case
examples/                    runnable examples; docs include from here
  app/                       Tasklane source + Dockerfile (maintainer)
  compose/                   Compose dev stack (maintainer)
  lab/                       kind config + up.sh (maintainer)
  k8s/01-namespace ... 04-gateway   core manifests (maintainer)
  <your dirs>/               see your assignment; each has a README.md
captures/                    real command output (maintainer runs)
  requests/<part>.txt        capture requests (you write)
research/                    verified facts (read-only)
scripts/                     build.mjs, check.mjs, harnesses (maintainer)
docs/                        GENERATED. Never edit.
```

---

## 4. The running example: Tasklane

Every Part builds on the same system. **Read `examples/` before writing.**

- **tasklane-api**: Go HTTP API on :8080. `GET /healthz` is liveness and does not touch the DB. `GET /readyz` is readiness and pings the DB. `GET /metrics`, `GET /tasks`, `POST /tasks {"title": "..."}` and `GET /` (version, host). Subcommands: `migrate`, `healthcheck`. On SIGTERM it fails readiness, waits `SHUTDOWN_DELAY_SECONDS`, then drains.
- **tasklane-worker**: claims pending tasks with `FOR UPDATE SKIP LOCKED`. It serves `/healthz` and `/metrics` on :9090. On SIGTERM it hands an in-flight task back to the queue.
- **PostgreSQL 18** (`postgres:18-trixie@sha256:86c951e0...`). Its volume mounts at `/var/lib/postgresql`, because the 18.x image uses `PGDATA=/var/lib/postgresql/18/docker`.
- Configuration uses the libpq env vars (`PGHOST`, `PGUSER`, `PGDATABASE`, `PGSSLMODE`...). The password comes from a **file**, `PGPASSWORD_FILE`.
- Images: one `examples/app/Dockerfile` with targets `api` and `worker`, distroless `static-debian13:nonroot` pinned by digest, UID 65532, exec-form ENTRYPOINT, and a HEALTHCHECK through the binary's own `healthcheck` subcommand.
- Image tags: `tasklane-api:0.1.0` and `tasklane-worker:0.1.0`, loaded into kind with `kind load docker-image`. **Never** use `:latest` in production-grade examples.
- Kubernetes conventions: namespace `tasklane`, which is **PSA restricted** (enforce, warn, audit). Labels: `app.kubernetes.io/name` (`tasklane-api` | `tasklane-worker` | `postgres`), `app.kubernetes.io/component` (`api` | `worker` | `database`), `app.kubernetes.io/part-of: tasklane`. Secret `tasklane-db`, key `password`. ConfigMap `tasklane-config`. Services `tasklane-api` (port 80 → `http`), `postgres` (headless, 5432) and `tasklane-worker-metrics` (9090). ServiceAccounts `tasklane-api` and `tasklane-worker`, with `automountServiceAccountToken: false`.
- Gateway: GatewayClass `eg` (Envoy Gateway), Gateway `tasklane/tasklane` with listener `http` on :80, and HTTPRoute `tasklane-api`. On the host, `http://localhost:8080` reaches it through kind port mapping 30080.
- Every pod in the examples runs **non-root**, `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true` where possible, `capabilities.drop: ["ALL"]` and `seccompProfile: RuntimeDefault`. If an example deliberately runs as root, put a comment right there explaining why. The checker enforces this.
- Journey: `docker run` (docker-beginner) → Compose (docker-intermediate) → hardened images and supply chain (docker-advanced/security) → raw manifests (k8s-beginner) → probes, storage, Gateway, NetworkPolicy (k8s-intermediate) → Kustomize, Helm, GitOps, autoscaling (k8s-advanced) → RBAC, PSA, policy, signing (k8s-security) → observability and backup (operations) → production (production).

---

## 5. Markdown dialect

### 5.1 Front matter (required on every page)

```
---
title: Pods
description: One sentence that says what the reader will learn.
level: beginner            # foundations | beginner | intermediate | advanced | expert
type: concept              # concept | tutorial | lab | troubleshooting | migration | reference
status: current            # current | beta | alpha | legacy | deprecated
versions: Kubernetes 1.37  # e.g. "Docker Engine 29, Compose v5" or "Kubernetes 1.37, Helm 4.3"
prerequisites:
  - k8s-beginner/architecture
  - k8s-beginner/kubectl-fundamentals
---
```

`prerequisites` are page ids (`<part>/<page>`, no `.md`). Use `[]` for none.
Do **not** repeat the title as a `# H1`. The generator renders the title,
level badge, description, prerequisites and version line.

### 5.2 Required sections (h2, exact text, in this order)

`type: concept`:
`## Overview`, `## Why it exists and when to use it`, `## How it works underneath`,
`## Basic example`, `## Explanation`, `## Common patterns`,
`## Production considerations`, `## Security considerations`,
`## Troubleshooting`, `## Common mistakes`, `## Related topics`.

`type: troubleshooting`: `## Overview`, `## Symptoms`, `## How it works underneath`,
`## Diagnosis`, `## Fixes`, `## Prevention`, `## Common mistakes`, `## Related topics`.

`type: lab`: `## Overview`, `## Setup`, `## Exercises`, `## Solutions`,
`## Common mistakes`, `## Related topics`.

`type: tutorial | migration | reference`: at least `## Overview`,
`## Common mistakes` and `## Related topics`. The last two must be the final two h2s.

You may add h3s freely, and extra h2s between the required ones.
"Related topics" is a bullet list of links.

### 5.3 Code blocks

Fenced blocks take attributes after the language:

````
```yaml title="examples/k8s/03-app/api.yaml"
...
```
```yaml include="examples/k8s/03-app/api.yaml"
```
```yaml include="examples/k8s/03-app/api.yaml" lines="20-48"
```
````

- **Every** manifest, Dockerfile, compose file and config block **must** carry `title="<filename>"`, or use `include=` (the title defaults to the path).
- **Prefer `include=`** from `examples/` over pasting. Docs must not drift from runnable files. Paste inline only for short illustrative snippets. Inline Kubernetes manifests are still validated by the harness, so they must be complete and valid (`apiVersion`, `kind`, `metadata.name`, and `metadata.namespace` for namespaced kinds).
- A deliberately partial snippet gets the attribute `fragment` (```` ```yaml title="..." fragment ````). Fragments are not sent to the API server. Keep them short.
- A manifest that must be **rejected** (for example a privileged pod in a restricted namespace) gets `expect="reject"`.
- An old manifest shown only for migration or legacy purposes gets `legacy`. It is allowed only in `migration/` pages or inside a `:::legacy` / `:::deprecated` callout.
- Languages with highlighting: `yaml`, `dockerfile`, `bash`, `console`, `json`, `go`, `hcl`, `toml`, `ini`, `text`, `diff`.
- Commands you expect readers to type go in `bash` blocks, one command per line, **no `$ ` prefix**.
- Output blocks: ```` ```console include="captures/<part>/<id>.txt" ````. Nothing else may show output.

### 5.4 Capture requests

Append one line per capture to `captures/requests/<part>.txt`:

```
<id> | <command run from repo root in bash, lab cluster up, tasklane stages 1-4 applied>
```

Example: `k8s-beginner/get-pods | kubectl -n tasklane get pods -o wide`

Then reference it: ```` ```console include="captures/k8s-beginner/get-pods.txt" ````.
Use read-only commands where you can. If state must change first, put the
setup commands in the same line joined with `&&` and make them idempotent.
The maintainer runs every request against the lab and writes the file. A
capture that cannot run here is reported, not faked.

### 5.5 Callouts

```
:::note Optional title
Body in Markdown.
:::
```

Types: `note`, `tip`, `best-practice`, `warning`, `danger`, `deprecated`,
`legacy`. Anything Legacy (Ingress, ingress-nginx, PSP, removed APIs,
Compose v1, Helm 3-only behaviour, dockershim) belongs in `migration/` or
inside `:::legacy` / `:::deprecated`.

### 5.6 Tabs

```
::::tabs
@tab Linux
...markdown...
@tab macOS
...markdown...
@tab Windows (WSL 2)
...markdown...
::::
```

Use tabs for OS-specific install steps and for kind / minikube / k3d differences.

### 5.7 Links and anchors

- Relative Markdown links to `.md` files: `[Pods](../k8s-beginner/pods.md)`, `[probes](../k8s-intermediate/probes.md#readiness-probes)`. The build rewrites them to `.html`.
- Heading anchors: lowercase the text, drop characters other than `a-z 0-9 space -`, and turn spaces into `-`. So `## How it works underneath` becomes `#how-it-works-underneath`.
- Link only to pages in the inventory (section 7) or pages you create. The checker fails broken links and anchors.
- Links to `examples/` files: `[api.yaml](../../examples/k8s/03-app/api.yaml)`. The build maps these to GitHub source URLs.

### 5.8 Maturity labels inline

Kubernetes features must state maturity and the version it was reached, for
example: "In-place Pod Resize (**GA in 1.35**)". Alpha features must say they
are **off by default and not for production**. Beta features must say whether
they are on by default.

---

## 6. Writing style

- Explain the **mechanism**: which component acts, in what order, and what state changes. Tracing API server → etcd → controller → scheduler → kubelet → runtime beats "kubectl apply creates a Deployment".
- Short paragraphs of 2 to 5 sentences. No filler, no marketing, no "In today's fast-paced world". Explain **why**.
- Use British or American spelling consistently within a page. The codebase leans British ("authorisation") in headings, but API field names keep their exact spelling.
- Tables for comparisons. Callouts sparingly, at most about 4 per page.
- Security content follows **threat → concrete exploit → fix → how to verify the fix**. Exploits run only in the disposable kind lab, and every exploit page says so in a `:::danger` callout.
- Be honest about cost and complexity. Say when a tool is the wrong choice.
- Page length: concept pages are usually 900 to 2,500 words. Do not pad. Depth beats breadth within a page, and breadth comes from having many pages.

---

## 7. Page inventory

Parts, directories and planned page ids. **Create every listed page in
your part.** You may add pages if your part needs them; add them to your
`_part.json`. Never rename listed pages, because other parts link to them.
Every part ends with `labs` (type `lab`).

`_part.json` format: `{"title": "Part F: Kubernetes, beginner", "pages": ["why-orchestration", ...]}`

**foundations/** (Part A: Foundations): what-containers-solve, containers-vs-vms,
history-of-containers, linux-namespaces, cgroups-v2, capabilities, seccomp,
apparmor-and-selinux, overlay-filesystems, oci-specifications, runtime-stack,
container-from-scratch, labs

**docker-beginner/** (Part B): install-docker, docker-cli-basics,
running-containers, container-lifecycle, images-tags-digests,
pulling-and-pushing, inspect-logs-exec, publishing-ports,
environment-variables, volumes-and-bind-mounts-basics, cleanup-and-disk-usage,
tasklane-with-docker-run, labs

**docker-intermediate/** (Part C): dockerfile-instructions,
build-context-and-dockerignore, layer-caching, multi-stage-builds,
choosing-base-images, entrypoint-vs-cmd, pid1-signals-graceful-shutdown,
healthchecks, running-as-non-root, image-size-optimisation,
volumes-bind-mounts-tmpfs, docker-networking, overlay-and-macvlan-networks,
compose-fundamentals, compose-dependencies-and-healthchecks,
compose-profiles-overrides-env, compose-watch, compose-secrets-configs-scaling,
tasklane-with-compose, labs

**docker-advanced/** (Part D): buildkit-and-buildx, cache-and-secret-mounts,
remote-build-cache, multi-platform-builds, build-args-vs-env,
reproducible-builds, registries, image-signing-cosign, sboms-and-provenance,
vulnerability-scanning, rootless-docker, resource-limits, logging-drivers,
daemon-configuration, docker-contexts, docker-in-ci, dind-vs-socket-mounting,
podman-and-alternatives, labs

**docker-security/** (Part E): container-threat-model, docker-socket-is-root,
dropping-capabilities, read-only-root-filesystem, no-new-privileges,
seccomp-and-apparmor-profiles, user-namespaces-docker, secrets-in-images,
supply-chain-security, base-image-patching, cis-docker-benchmark, labs

**k8s-beginner/** (Part F): why-orchestration, architecture,
declarative-model-and-reconciliation, local-clusters, kubectl-fundamentals,
kubeconfig-and-contexts, manifest-anatomy, namespaces,
labels-selectors-annotations, pods, deployments-and-replicasets,
rolling-updates-and-rollbacks, services, configmaps, secrets, debugging-basics,
tasklane-on-kubernetes, labs

**k8s-intermediate/** (Part G): probes, resources-requests-limits, qos-classes,
limitrange-and-resourcequota, statefulsets, daemonsets, jobs-and-cronjobs,
init-and-sidecar-containers, pod-lifecycle-and-termination,
pod-disruption-budgets, volumes, persistent-volumes-and-claims,
storage-classes-and-csi, volume-snapshots, network-model-and-cni,
kube-proxy-and-endpointslices, dns-and-coredns, gateway-api,
gateway-api-tls-and-traffic, ingress-legacy, network-policy, cert-manager,
external-dns, labs

**k8s-advanced/** (Part H): node-selection-and-affinity,
pod-affinity-and-anti-affinity, taints-and-tolerations,
topology-spread-constraints, priority-and-preemption, scheduler-internals,
horizontal-pod-autoscaler, vertical-pod-autoscaler, in-place-pod-resize, keda,
cluster-autoscaler-and-karpenter, helm, helm-chart-development, kustomize,
helm-vs-kustomize, gitops-argo-cd, gitops-flux, cicd-for-kubernetes,
progressive-delivery, multi-tenancy, custom-resource-definitions,
controllers-and-operators, admission-webhooks, admission-policies-cel,
aggregated-apis, dynamic-resource-allocation, labs

**k8s-security/** (Part I): 4c-model, authentication-and-authorisation, rbac,
service-accounts-and-tokens, pod-security-standards, security-context,
user-namespaces, policy-engines, secrets-management, network-segmentation,
supply-chain-admission, runtime-security-falco, audit-logging,
cis-benchmark-kube-bench, attack-privileged-pod-escape, attack-rbac-token-abuse,
attack-lateral-movement, attack-unsigned-image, common-attack-paths, labs

**operations/** (Part J): metrics-server-and-metrics-api,
prometheus-and-kube-prometheus, grafana-dashboards, actionable-alerting,
logging-architectures, distributed-tracing-opentelemetry, kubernetes-events,
slos-and-error-budgets, cost-visibility, cluster-upgrades, version-skew-policy,
deprecated-api-detection, etcd-backup-and-restore, certificate-rotation,
node-maintenance, velero-backup-and-restore, capacity-planning,
high-availability-control-plane, multi-cluster, labs

**production/** (Part K): managed-kubernetes-compared, eks, gke, aks, kubeadm,
k3s-and-lightweight, production-readiness-checklist, cost-of-kubernetes,
when-not-to-use-kubernetes, alternatives, tasklane-in-production, labs

**troubleshooting/** (Part L): method, crashloopbackoff, imagepullbackoff,
pending-pods, oomkilled, createcontainerconfigerror, evicted-pods,
failing-probes, service-no-endpoints, dns-failures, networkpolicy-blocking,
pvc-pending, node-notready, stuck-terminating-namespace, certificate-expiry,
docker-disk-exhaustion, architecture-mismatch, labs

**migration/** (Part M, migration): ingress-to-gateway-api,
ingress-nginx-retirement, psp-to-pod-security-admission, dockershim-removal,
helm-3-to-4, compose-v1-v2-to-v5, removed-api-versions, labs

**reference/** (Part M, reference): kubectl-cheat-sheet, docker-cli-cheat-sheet,
dockerfile-reference, compose-file-reference, manifest-field-reference,
glossary, certification-map, version-matrix, coverage-map (maintainer)

Top level (maintainer): `index`, `learning-path`.

---

## 8. What the checker enforces

`node scripts/check.mjs` fails on:
- missing or invalid front matter, level, type, status or versions
- missing required sections or wrong order, or pages that don't end with Common mistakes then Related topics
- broken internal links, anchors or prerequisite ids; pages not in any `_part.json` (orphans)
- manifest, Dockerfile or compose blocks without `title=` or `include=`
- output blocks that are not `include="captures/..."`
- outside `migration/`, `status: legacy|deprecated` pages and `:::legacy`/`:::deprecated` callouts: `docker-compose` (hyphenated command); a top-level `version:` in compose files; any removed API version from section 1; `PodSecurityPolicy`; dockershim presented as current; installing ingress-nginx; `kind: Endpoints`; `:latest` image tags; containers without `runAsNonRoot: true` or a `runAsUser` other than 0, unless a comment on the preceding line says why root is needed.

Then the harnesses run every manifest through kubeconform (1.37 schemas +
CRDs), `kubectl apply --dry-run=server` against the kind 1.37 cluster, and
Pluto. A manifest is not correct until the real API server has accepted it.
