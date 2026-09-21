# Tooling facts — verified 2026-09-21

Method: GitHub `releases/latest` redirects + `releases.atom` + GitHub REST API (dates = `published_at` where fetched, else atom `<updated>`), docs.docker.com / helm.sh / project READMEs via fetch, and Docker Hub / gcr.io registry APIs for digests. Anything not confirmed from a primary source is marked **UNVERIFIED**.

---

## 1. Docker Engine

| Fact | Value | Source |
|---|---|---|
| Latest | **29.8.1, 2026-09-15** (tag `docker-v29.8.1`) | https://docs.docker.com/engine/release-notes/29/ , https://github.com/moby/moby/releases/tag/docker-v29.8.1 |
| 29.x minors | 29.0.0 2025-11-10; 29.1.0 2025-11-27; 29.2.0 2026-01-26; 29.3.0 2026-03-05; 29.4.0 2026-04-07; 29.5.0 2026-05-14; 29.6.0 2026-06-18; 29.7.0 2026-07-30; 29.8.0 2026-09-03 | same |
| Support table | 29: active. 28: security support ended **2026-05-13** (last 28.5.2, 2025-11-05). **25.0: until 2026-12-04** (latest 25.0.17, 2026-07-14). 27, 26.x, 24, 23, 20.10 EOL | https://endoflife.date/docker-engine (the 25.0 extended date is from endoflife.date only; I found no statement of it on docs.docker.com, so treat the reason for it as **UNVERIFIED**) |

Engine 29.0.0 (2025-11-10), quoted or paraphrased from the release notes:
- **containerd image store is the default for fresh installs** only, not for upgraded daemons. It doesn't apply to daemons with `userns-remap` (moby#47377).
- **nftables:** experimental. Enable it with the `firewall-backend: nftables` daemon option (`--firewall-backend=nftables`). The nftables docs page still says it "is experimental, configuration options, behavior and implementation may all change". Under nftables Docker does **not** enable IP forwarding on the host; startup fails if forwarding is needed. https://docs.docker.com/engine/network/firewall-nftables/
- **The daemon's minimum API version is now v1.44 (Docker v25.0+).**
- **cgroup v1 is deprecated.** "Support continues until at least May 2029" (moby#51111).
- Docker Content Trust was **removed from the CLI**. It can be built as a separate plugin.
- The Go module `github.com/docker/docker` is deprecated. Use `github.com/moby/moby/client` and `.../api` instead. Releases are now tagged `docker-vX`.
- No more official Raspbian 32-bit packages. armhf now targets ARMv7.
- containerd 2.1.5 sets `ulimit -n` to systemd's default (**1024 instead of 1048576**) for all containers. Override it with `--ulimit` or `default-ulimits`.
- Env vars from legacy links are no longer injected. The escape hatch is `DOCKER_KEEP_DEPRECATED_LEGACY_LINKS_ENV_VARS=1`.
- `docker image ls` now shows the collapsed tree view by default and hides untagged images unless you pass `--all`. `docker image load/save --platform` now accepts multiple platforms.
- macvlan/ipvlan-l2 networks get no default gateway unless you set `--gateway`.

Later 29.x items worth knowing:
- **29.5.0 (2026-05-14):** in rootless mode, **`gvisor-tap-vsock` is the new default network driver**. slirp4netns is no longer installed by Docker packaging. Containers now get a private time namespace by default on supported kernels.
- **29.8.0 (2026-09-03):** adds `HostConfig.Umask` / `--umask`, AppArmor default-profile template configuration, and RootlessKit v3.1.0.
- **29.8.1:** containerd v2.3.5 in the static binaries.

## 2. Docker Compose

- Latest **v5.5.1, 2026-09-03**. https://github.com/docker/compose/releases/tag/v5.5.1 . It captures and shows lifecycle-hook output, fixes watch for symlinked directories, and uses buildkit v0.33.0 and Go 1.26.8.
- **v5.0.0 "Mont Blanc", published 2025-12-02.** https://github.com/docker/compose/releases/tag/v5.0.0 . From the notes:
  - "Compose can now officially be used as a SDK to be integrated into third-party softwares" (PRs #13312, #13313, #13322: functional options, no Docker CLI required, io.Reader/Writer).
  - "Internal builder has been removed, build is delegated to Docker Bake (same as `docker build` command)" (#13056 "drop support for internal buildkit builder").
  - Why "v5": it skips 3.0.0 and 4.0.0 to avoid confusion with the legacy compose-file versions `2.x`/`3.x`.
  - New in v5.0.0: `build.no_cache_filter`, `start --wait`, `--insecure-registry` (testing only), hooks run on restart, detach keys restored, port ranges fixed, OCI and Git remote resources documented, compose-go v2.10.0.
  - The notes list **no other removed commands**. Anything else "removed in v5" is **UNVERIFIED**.
- The top-level **`version:` is obsolete**. Docs: "only informative and you'll receive a warning message that it is obsolete if used". https://docs.docker.com/reference/compose-file/version-and-name/
- **`develop.watch` actions:** `rebuild`, `restart` (2.32.0+), `sync`, `sync+restart` (2.23.0+), `sync+exec` (2.32.0+). Attributes: `path`, `action`, `target`, `ignore`, `include`, `initial_sync`, `exec`. https://docs.docker.com/reference/compose-file/develop/
- **`depends_on` conditions:** `service_started`, `service_healthy`, `service_completed_successfully`. It also takes `restart` and `required` (default true). https://docs.docker.com/reference/compose-file/services/
- Confirmed spec pages exist for: `profiles`, top-level `include`, `secrets`, `configs`, **`models`** (top-level and service-level, with `endpoint_var`/`model_var`), service `provider`, `post_start`/`pre_stop` hooks, and `gpus`. See https://docs.docker.com/reference/compose-file/{include,models,secrets,configs,profiles}/

## 3. Dockerfile frontend

- **Latest `docker/dockerfile:1.27.0`, 2026-09-02** (buildkit tag `dockerfile/1.27.0`). New: zstd archives as build context and in `ADD`, and **`RUN --device` promoted out of labs**. https://github.com/moby/buildkit/releases/tag/dockerfile/1.27.0
- **Surprise:** Docker Hub `docker/dockerfile:1` and `:latest` still resolve to digest `sha256:ecfaec9e…fc32`, which is the same digest as **1.26.0**. 1.27 is `sha256:bde3983e…372e`. So `# syntax=docker/dockerfile:1` gave 1.26.0 as of this check. https://hub.docker.com/r/docker/dockerfile/tags
- Recent minors: 1.23 (2026-03-31), 1.24 (2026-05-13), 1.25 (2026-06-17), 1.26 (2026-07-29), 1.27 (2026-09-02).
- The page https://docs.docker.com/build/buildkit/dockerfile-release-notes/ now **301-redirects to https://github.com/moby/buildkit/releases/**.

Reference: https://docs.docker.com/reference/dockerfile/ . Minimum frontend versions below are as stated on that page.

| Feature | Anchor | Min |
|---|---|---|
| Heredocs | `#here-documents` | — |
| `RUN --mount=type=bind\|cache\|tmpfs\|secret\|ssh` | `#run---mounttypebind` etc. | 1.2 (secret `env=` 1.10) |
| `RUN --network` | `#run---network` | 1.3 |
| `RUN --security` | `#run---security` | 1.20 |
| `RUN --device` | `#run---device` | 1.27 |
| `COPY --link` / `ADD --link` | `#copy---link` | 1.4 |
| `COPY --chmod` | `#copy---chmod` | 1.2 (symbolic modes 1.14) |
| `COPY/ADD --exclude` | `#copy---exclude` | 1.19 (stable) |
| `COPY --parents` | `#copy---parents` | 1.20 |
| `ADD --checksum` | `#add---checksum` | 1.6 |
| `ADD --keep-git-dir` | `#add---keep-git-dir` | 1.1 |
| `ADD --unpack` | `#add---unpack` | 1.17 |
| `# syntax=` | `#syntax` | — |
| `# check=` (build checks) | `#check` | 1.8 (see https://docs.docker.com/build/checks/) |
| `# escape=` | `#escape` | — |

## 4. BuildKit / buildx

- **buildx v0.37.1, 2026-09-11.** https://github.com/docker/buildx/releases/tag/v0.37.1 . **BuildKit v0.33.0, 2026-09-02.** https://github.com/moby/buildkit/releases/tag/v0.33.0
- Cache backends: `inline` (image exporter only), `registry`, `local`, `gha` (**beta**), `s3` (**"unreleased"**), `azblob` (**"unreleased"**). https://docs.docker.com/build/cache/backends/
- Attestations: "Provenance attestations with the `mode=min` level are added to images by default". SBOM is opt-in with `--sbom=true`. Disable defaults with `--provenance=false` or `BUILDX_NO_DEFAULT_ATTESTATIONS`. https://docs.docker.com/build/metadata/attestations/
- Bake docs: https://docs.docker.com/build/bake/ . Compose v5 now delegates builds to Bake (§2).

## 5. Licensing and Hub limits

- **Docker Desktop** is free for "fewer than 250 employees AND less than $10 million in annual revenue", and for personal use, education, and non-commercial open source. Everyone else needs a paid subscription. https://docs.docker.com/subscription/desktop-license/
- **Docker Hub pulls** are counted per 6 hours: unauthenticated users get **100 per IPv4 address or IPv6 /64**, Personal (authenticated) users get **200**, and Pro/Team/Business are **unlimited**. Fair-use and abuse limits return 429. https://docs.docker.com/docker-hub/usage/
- **Docker Hardened Images:** free under Apache 2.0 as a "Community" tier since the 2025-12-17 announcement. https://www.docker.com/press-release/docker-makes-hardened-images-free-open-and-transparent-for-everyone/

## 6. Scout, rootless, `docker init`

- **Docker Scout:** active, with no deprecation banner on https://docs.docker.com/scout/ . `docker/scout-cli` is at v1.24.0 (2026-07-30). The **free-tier repo allowance is UNVERIFIED**; the plan page didn't show it.
- **Rootless mode** (https://docs.docker.com/engine/security/rootless/):
  - Needs `newuidmap`/`newgidmap` (the `uidmap` package).
  - Needs **at least 65,536** subordinate IDs in `/etc/subuid` and `/etc/subgid`.
  - Resource limits (`--cpus`, `--memory`, `--pids-limit`) work only with **cgroup v2 + systemd**.
  - Use a systemd user unit plus `loginctl enable-linger`. A system-wide unit is not supported.
  - The default network driver is `gvisor-tap-vsock` since 29.5.0. **Pasta** is used when slirp4netns is absent (29.0).
- **`docker init`** generates `.dockerignore`, `Dockerfile`, `compose.yaml`, and `README.Docker.md`. Templates: ASP.NET Core, Go, Java, Node, PHP+Apache, Python, Rust, Other. The docs say "Docker Desktop provides the `docker init` CLI command". **Whether it is GA and whether it works without Desktop is UNVERIFIED.** https://docs.docker.com/reference/cli/docker/init/

## 7. Helm

- **v4.3.0**, published **2026-09-09T23:51Z**. https://github.com/helm/helm/releases/tag/v4.3.0
  - Adds duration template functions, `rollback --description`, an ownership check before uninstall deletes resources, `SOURCE_DATE_EPOCH`, and GnuPG keybox support. Uses k8s libs v0.37.
  - The notes say "no further Helm 3 minor releases".
  - Next scheduled releases: 4.3.1 and 3.22.1 on 2026-10-14, and 4.4.0 on 2027-01-13.
- **v4.0.0, 2025-11-12.** https://github.com/helm/helm/releases/tag/v4.0.0 , https://helm.sh/docs/overview/ , https://helm.sh/docs/changelog/
  - WASM-capable plugin system (HIP-0026). Plugin types are CLI, getter, and **post-renderer**. **Post-renderers are now plugins**: you can no longer pass an executable path to `--post-renderer`.
  - **Server-side apply** is the default for **new installs**. Upgrades and rollbacks keep the release's previous apply method, so Helm 3 releases stay client-side. `--server-side` defaults to true on install. There is also `--force-conflicts`.
  - **kstatus-based waiting.** `--wait` is now a WaitStrategy: `watcher` | `hookOnly` | `legacy`. Omitting it means `hookOnly`. Bare `--wait` means `watcher`.
  - Flag renames: `--atomic` → **`--rollback-on-failure`**. `--atomic` was restored on install as a deprecated alias. `--force` → **`--force-replace`**.
  - `--dry-run` takes `none|client|server`.
  - `helm template` deprecates `--hide-notes` and `--render-subchart-notes`.
  - `helm registry login` accepts a domain only, not a URL. You can install OCI charts by `@sha256` digest.
  - Also from the changelog: `helm version --client` removed, `repo add --no-update` removed, implicit current directory for `helm lint` removed, and `--show-desc`/`--show-resources` removed from status. **These removals are from the changelog summary only and are UNVERIFIED; check each against the CLI docs.**
  - slog logging, reproducible chart archives, content-based local cache.
  - Go SDK is `helm.sh/helm/v4`, with packages `pkg/chart/v2` and `pkg/release/v1`.
  - **Chart apiVersion v2 is still supported.** Chart API **v3 is experimental** and enabled with `HELM_EXPERIMENTAL_CHART_V3=1`.
- **Helm 3 EOL** (blog, 2026-06-02, https://helm.sh/blog/helm-v3-end-of-life/): bug fixes end at the final feature release on **2026-09-09**. **Security fixes end 2027-02-10** (extended from Nov 2026). The final v3 minor exists as tag v3.22.0.

## 8. Licences and project status

| Project | Status | Source |
|---|---|---|
| Linkerd | "As of February 2024, the Linkerd open source project itself no longer provides stable release artifacts." OSS publishes edge releases only (latest `edge-26.9.3`, 2026-09-16). Stable 2.20 is via Buoyant Enterprise. Apache-2.0 | https://linkerd.io/releases/ |
| Grafana / Loki | AGPL-3.0 (GitHub license field). Grafana v13.2.2 (2026-09-15), Loki v3.7.8 (2026-09-17) | https://github.com/grafana/grafana , https://github.com/grafana/loki |
| Sealed Secrets | `bitnami-labs/sealed-secrets` redirects to **github.com/bitnami/sealed-secrets**. v0.40.0 (2026-09-10) | https://github.com/bitnami/sealed-secrets |
| Velero | `vmware-tanzu/velero` redirects to **github.com/velero-io/velero**. Donated by Broadcom to the **CNCF Sandbox**, announced at KubeCon EU 2026. v1.18.2 (2026-06-26) | https://velero.io/blog/velero-joins-cncf-sandbox/ , https://github.com/cncf/sandbox/issues/457 |
| Podman | `containers/podman` redirects to **github.com/podman-container-tools/podman** (the org describes itself as a CNCF Sandbox project). v6.1.2 (2026-09-16, CVE fixes). **v6.0.0 (2026-06-24):** cgroup v1 removed; CNI removed (Netavark only); iptables removed (nftables required); slirp4netns removed (pasta); BoltDB removed (auto-migrates to SQLite); network isolation on by default; Intel Macs and Windows 10 dropped; libkrun is the default macOS provider; Go import path `go.podman.io/podman/v6`; Docker-compat API v1.44; `volume prune` only removes anonymous volumes | https://github.com/podman-container-tools/podman/releases/tag/v6.0.0 |
| Bitnami | Effective **2025-08-28** (deletion postponed to 2025-09-29): versioned images moved to `docker.io/bitnamilegacy` with no updates. The free subset is `bitnamisecure`, **"latest" tags only, for development**. OCI charts at `docker.io/bitnamicharts` get no updates except for community-tier images. Source stays Apache-2.0 on GitHub. The paid tier is Bitnami Secure Images (Photon Linux) | https://github.com/bitnami/containers/issues/83267 , https://github.com/bitnami/charts/issues/35164 |
| Flux | CNCF graduated. After Weaveworks shut down, **ControlPlane** employs the core maintainers and sells "Enterprise for Flux CD". v2.9.5 (2026-08-31) | https://control-plane.io/posts/controlplane-backs-the-cncf-flux-project-by-employing-maintainers/ |
| Karpenter | Core at `kubernetes-sigs/karpenter` v1.14.1 (2026-08-21). AWS provider `aws/karpenter-provider-aws` v1.14.1 (2026-08-27) | GitHub |
| External Secrets Operator | **v2.x**. v2.0.0 (2026-02-06) removed the Alibaba and Device42 providers. Latest v2.11.0 (2026-09-18) | https://github.com/external-secrets/external-secrets/releases/tag/v2.0.0 |
| Kyverno, Falco, Argo, cert-manager, Cilium, KEDA, Istio, Helm, Prometheus, Envoy, Linkerd, Flux, OpenTelemetry | Listed as CNCF **Graduated** on the page I fetched. OTel's and Kyverno's graduation are **UNVERIFIED** against their own announcements | https://www.cncf.io/projects/ |
| Terraform / Vault | **BSL 1.1**. The LICENSE now names **IBM** as Licensor (Terraform ≥1.6.0, Vault ≥1.15.0). Latest Terraform v1.16.3; **Vault v2.1.1** (Vault has a 2.x line) | https://github.com/hashicorp/terraform/blob/main/LICENSE , https://github.com/hashicorp/vault/blob/main/LICENSE |
| OpenTofu / OpenBao | MPL-2.0. v1.12.6 (2026-08-19) / v2.6.2 (2026-08-18) | GitHub |
| Redis | ≤7.2 BSD. 7.4 RSALv2/SSPLv1. **≥8.0 adds AGPLv3** as a third option. Latest 8.10.2 (2026-09-17). **Valkey** (BSD-3) 9.1.2 (2026-09-01) is the permissive alternative | https://redis.io/legal/licenses/ |
| MinIO | **Repo archived 2026-04-25**: "THIS REPOSITORY IS NO LONGER MAINTAINED". The community edition is **source-only, with no binaries**. Last release RELEASE.2025-10-15T17-29-55Z. Pushes you toward AIStor Free/Enterprise. **Do not use it as a handbook example** | https://github.com/minio/minio |
| ingress-nginx | **Retired; repo archived 2026-03-24.** No releases or CVE fixes after March 2026. Last release controller-v1.15.1 (2026-03-19). The README says to use a Gateway API implementation | https://github.com/kubernetes/ingress-nginx |
| Docker Hub | See §5 for limits. DHI is free (Apache-2.0) | — |

## 9. Current versions (GitHub releases, 2026-09-21)

| Tool | Version | Date |
|---|---|---|
| Kubernetes | v1.37.0 | 2026-08-26 |
| kind | **v0.33.0** (published 2026-08-26; atom shows an edit on 2026-09-16) | default node `kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5`. Also v1.36.4@sha256:099e0493…faed, v1.35.8@sha256:07b2536e…23c0, v1.34.11@sha256:44e222ee…d67d |
| minikube | v1.39.0 | 2026-09-02 |
| k3d | v5.9.0 | 2026-06-02 |
| k3s | v1.37.0+k3s1 | 2026-09-14 |
| kubectl | v1.37.0 (same as k8s) | 2026-08-26 |
| kustomize | v5.8.1 | 2026-02-09 |
| Argo CD | v3.5.3 | 2026-09-14 |
| Flux | v2.9.5 | 2026-08-31 |
| Prometheus | v3.14.0 | 2026-08-18 |
| Grafana | v13.2.2 | 2026-09-15 |
| OTel Collector (releases) | v0.161.0 | 2026-09-16 |
| cert-manager | v1.21.2 | 2026-09-11 |
| external-dns | v0.23.0 | 2026-09-18 |
| ESO | v2.11.0 | 2026-09-18 |
| Kyverno | v1.19.1 | 2026-09-10 |
| Gatekeeper | v3.23.1 | 2026-08-27 |
| Falco | 0.44.1 | 2026-06-11 |
| Trivy | v0.74.0 | 2026-08-14 |
| Grype | v0.119.0 | 2026-09-17 |
| Syft | v1.52.0 | 2026-09-17 |
| cosign | v3.1.3 | 2026-08-06 |
| Cilium | v1.20.2 | 2026-09-16 |
| Calico | v3.32.2 | 2026-08-30 |
| Istio | 1.31.0 | 2026-08-31 |
| KEDA | v2.20.2 | 2026-07-31 |
| Karpenter | v1.14.1 | 2026-08-21/27 |
| VPA | **1.7.1** (chart 0.12.0 on 2026-09-05) | 2026-07-26 |
| Cluster Autoscaler | **1.36.1**. **No 1.37.x yet** | 2026-07-23 |
| Velero | v1.18.2 | 2026-06-26 |
| metrics-server | v0.9.0 (supports K8s **1.34+**, `metrics.k8s.io/v1beta1`) | 2026-07-13 |
| hadolint | v2.15.1 | 2026-07-31 |
| kubeconform | v0.8.0 | 2026-06-04 |
| pluto | v5.24.4 | 2026-09-15 |
| kube-no-trouble (kubent) | 0.7.3. **Last release 2024-08-30**; last nightly 2025-01-12. The repo isn't archived but releases are stale, so treat it as **effectively unmaintained** (my judgement) | — |
| kube-prometheus | v0.18.0. The README matrix lists release-0.18 as supporting **K8s 1.33–1.36**, with **no 1.37 column** | 2026-06-18 |
| Envoy Gateway | v1.9.1 | 2026-08-28 |
| Traefik | v3.7.13 | 2026-09-10 |
| Argo Rollouts | v1.10.0 | 2026-08-27 |
| Flagger | v1.45.0 | 2026-09-01 |
| kube-bench | v0.16.0 | 2026-08-05 |
| Podman | v6.1.2 | 2026-09-16 |

cosign v2 → v3: v3.0.0 was announced on 2025-10-08. From https://github.com/sigstore/cosign/blob/main/CHANGELOG.md and https://blog.sigstore.dev/cosign-3-0-available/ :
- It "is a minor change from Cosign v2.6.x", with the new features **on by default**:
  - protobuf **bundle format** (the `--new-bundle-format` behaviour becomes the default)
  - `--trusted-root` / signing config fetched from TUF by default (`--use-signing-config`)
  - signatures stored as **OCI 1.1 referring artifacts**
- The old behaviour can still be turned on. Removal of the old flags is planned for v4.

Istio ambient mode reached **GA in 1.24** (2024-11-07). https://istio.io/latest/blog/2024/ambient-reaches-ga/

Maintained ingress alternatives to ingress-nginx:
- F5 NGINX Ingress Controller `nginx/kubernetes-ingress` v5.6.3 (2026-09-16)
- Traefik v3.7.13
- HAProxy `haproxytech/kubernetes-ingress` v3.2.15 (2026-09-11)
- Contour v1.33.7 (2026-09-07; CNCF incubating)
- Kong KIC v3.5.13 (2026-08-07)
- Envoy Gateway v1.9.1 (Gateway API)

## 10. Pinned base images

These are multi-arch index digests from the registry API (HEAD manifest, OCI index), checked 2026-09-21. python:3.14-slim, for example, includes amd64, arm64/v8, arm/v5, arm/v7, 386, ppc64le, riscv64, s390x.

| Image | Resolves to | Index digest |
|---|---|---|
| `python:3.14-slim` (= `3.14-slim-trixie`) | 3.14.7-slim | `sha256:caaf356f40667c496d405780745b9ac25771c189a51dfcc42430d531ea09f8a2` |
| `python:3.13-slim` (= trixie) | 3.13.15-slim | `sha256:8d9d0b8bcf6506481eae4907c18f5e3e7902e629f5f6d684f9e7c32e85e3ddf0` |
| `node:24-slim` (= `24-bookworm-slim` = `lts-slim`) | 24.21.0 | `sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6` |
| `node:24-trixie-slim` | — | `sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe` |
| `node:24-alpine` | — | `sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1` |
| `node:26-slim` (current, not LTS) | — | `sha256:3a771f83944bb763050c23c0225c260638c4b7899e7a72485ef75e5e570499e5` |
| `golang:1.27` (= `latest`) | 1.27.1 | `sha256:3680233e3204827fbdc66088528ae6d4b3d034f51d03a99d454f6de034888244` |
| `golang:1.26` | 1.26.8 | `sha256:6c2a5538f964f1c82f97ad14988bf05de100d922d159d0e398b54c7b0ca0c6c9` |
| `golang:1.26-alpine` | — | `sha256:51a7c389a5ddaf82f527191a1e9bff9928655130a44e4975dd1d7e0acf59f1ae` |
| `postgres:18` (= `18-trixie`) | 18.6 | `sha256:86c951e05bf56c93d95d397747fb8820ac76cc3bedb78f43abd83eedbe3666ae` |
| `postgres:18-alpine` | — | `sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873` |
| `gcr.io/distroless/static-debian13:nonroot` | — | `sha256:e2e927ec666bae08560abb3c55d0659eceabb657f56b6782ab500a9fc7f555e3` |
| `gcr.io/distroless/static-debian13:latest` | — | `sha256:58133991db06659feaabe0f4e97a35cebf15ef4ea08f8a4c6d2ee5f75e4aa6a0` |
| `gcr.io/distroless/base-debian13:nonroot` | — | `sha256:0896741ba5bafd3ac87ea025a5f578952f2d238ddc3614cb368acc983a687aa2` |
| `gcr.io/distroless/cc-debian13:nonroot` | — | `sha256:54df941ed0d06a1bd95ef5e0ce391fd8d9f94b64782dc9a60062727849ee3f97` |
| `gcr.io/distroless/python3-debian13:nonroot` | — | `sha256:8ee214843129f43e2ebf5e0ca9f2e4e6d8292143d1b8a6787f169b5898578884` |
| `gcr.io/distroless/nodejs24-debian13:nonroot` | — | `sha256:bb6b03d81066993293a10feda7250e8e1cc034035fe9b61cfceededa7c8bf04d` |
| `gcr.io/distroless/static-debian12:nonroot` | **deprecated** | `sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab` |

Notes:
- `python:3.15-slim` and `postgres:19` do not exist (404).
- The distroless README now lists **only `-debian13`** images. It says "Any other tags are considered deprecated and are no longer updated", which covers `-debian12`. https://github.com/GoogleContainerTools/distroless
- Digests change on every rebuild. Re-resolve them just before publishing, with `docker buildx imagetools inspect <ref>`.
