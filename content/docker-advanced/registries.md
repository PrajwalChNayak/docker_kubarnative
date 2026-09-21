---
title: Registries
description: How OCI registries store images, what Docker Hub's limits actually are, and how GHCR, ECR, Artifact Registry, ACR and Harbor differ on auth, immutability and retention.
level: advanced
type: concept
status: current
versions: Docker Engine 29, Buildx 0.37
prerequisites:
  - docker-beginner/pulling-and-pushing
  - docker-beginner/images-tags-digests
---

## Overview

A registry is a content-addressed blob store with a thin HTTP API on top. Push
uploads blobs, then a manifest that references them by digest, then a tag that
points at the manifest. Everything interesting about registries — caching,
immutability, signatures, attestations, retention — follows from that shape.

This page covers the API model, the pull limits that break builds, and the
operational differences between the registries a team actually chooses
between.

## Why it exists and when to use it

You need a registry the moment more than one machine runs your images. The
choice is rarely about features — they all implement the same distribution
spec — and almost always about where your compute is, who can authenticate,
and what the egress costs.

| Registry | Fits when | Watch out for |
|---|---|---|
| Docker Hub | Public images, open source | Pull limits, which are per 6 hours |
| GHCR (`ghcr.io`) | Code is on GitHub; CI is Actions | Package visibility and permissions are separate from repo access |
| Amazon ECR | Workloads on AWS | Auth tokens expire every 12 hours; needs a credential helper |
| Artifact Registry (`*-docker.pkg.dev`) | Workloads on Google Cloud | Container Registry (`gcr.io`) is shut down; see below |
| Azure Container Registry | Workloads on Azure | Feature tiers differ; geo-replication is Premium |
| Harbor | Self-hosted, on-prem, air-gapped | You operate it, including storage and GC |

## How it works underneath

A push is three kinds of request:

1. **Blobs.** Each layer and the config are uploaded by digest. If the
   registry already has a blob, the client skips it — this is why pushing a
   rebuilt image is fast when only one layer changed.
2. **Manifest.** A JSON document listing the config and layer digests, plus
   the media type. For a multi-platform build, an **index** lists several
   manifests with their platforms.
3. **Tag.** A mutable name pointing at a manifest digest.

Signatures and attestations are stored as further objects in the same
repository. Cosign v3 stores signatures as OCI 1.1 **referring artifacts**,
discovered through the referrers API; BuildKit's SBOM and provenance
attestations are extra manifests inside the image index.

A digest reference, `repo@sha256:...`, addresses content. A tag reference
addresses whatever the tag points at *now*. Deployments should use digests;
humans use tags.

```bash
docker buildx imagetools inspect gcr.io/distroless/static-debian13:nonroot
```

```console include="captures/docker-advanced/imagetools-distroless.txt"
```

## Basic example

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io --username "$GITHUB_ACTOR" --password-stdin
docker buildx build --push \
  -t ghcr.io/example/tasklane/tasklane-api:0.1.0 \
  --target api examples/app
docker buildx imagetools inspect ghcr.io/example/tasklane/tasklane-api:0.1.0
```

## Explanation

`--password-stdin` keeps the token out of shell history and process lists.
Credentials land in `~/.docker/config.json`, base64-encoded, which the Docker
documentation notes is "less secure than configuring and using a credential
store".

Configure a credential store instead:

```json title="~/.docker/config.json"
{
  "credsStore": "secretservice",
  "credHelpers": {
    "123456789012.dkr.ecr.eu-west-1.amazonaws.com": "ecr-login",
    "europe-west1-docker.pkg.dev": "gcloud"
  }
}
```

`credsStore` sets one default helper; `credHelpers` maps registry hosts to
specific helpers. Helpers exist for macOS Keychain, Windows Credential
Manager, `pass` and the D-Bus Secret Service. Cloud registries have their own
(`docker-credential-ecr-login`, `gcloud auth configure-docker`), which
refresh short-lived tokens transparently — the only sane way to use ECR,
whose tokens expire twelve hours after issue.

## Docker Hub limits

Per the Docker documentation, pulls are counted **per 6 hours**:

| Account | Limit per 6 hours |
|---|---|
| Unauthenticated | 100 per IPv4 address or IPv6 /64 |
| Personal (authenticated) | 200 |
| Pro, Team, Business | unlimited |

Fair-use and abuse limits return HTTP 429 on top of that.

The practical consequences are sharp. A shared CI egress IP is one
"unauthenticated user", so a dozen pipelines exhaust 100 pulls quickly, and
the failure mode is `toomanyrequests` in the middle of a build. Every kind
node that pulls an image counts. Authenticate in CI even for public images,
mirror what you depend on into your own registry, and pin digests so that a
retry does not re-resolve a tag.

:::tip
A pull-through cache (Harbor proxy cache, ECR pull-through cache, Artifact
Registry remote repositories) turns hundreds of Hub pulls into one. On a
shared build host it pays for itself in a week.
:::

## Immutability and retention

Immutable tags are the cheapest supply-chain control available, because they
remove the "someone re-pushed `1.2.3`" class of incident entirely.

| Registry | Mechanism |
|---|---|
| ECR | Repository setting `IMMUTABLE`, or `IMMUTABLE_WITH_EXCLUSION` with wildcard filters; pushing an existing tag returns `ImageTagAlreadyExistsException` |
| Artifact Registry | Repository-level immutable image tags (`--immutable-tags`); tags cannot be moved or deleted and tagged images cannot be deleted |
| ACR | Per-image or per-repository attributes via `az acr repository update --write-enabled false` / `--delete-enabled false` |
| Harbor | Tag immutability rules per project, matching or excluding repositories and tags; up to 15 rules per project |
| GHCR | No per-tag immutability setting; rely on digests and signatures |

```bash
aws ecr create-repository --repository-name tasklane-api --image-tag-mutability IMMUTABLE
gcloud artifacts repositories create tasklane --repository-format=docker --location=europe-west1 --immutable-tags
az acr repository update --name myregistry --image tasklane-api:0.1.0 --write-enabled false
```

Retention is the other half. Cache repositories and CI builds accumulate
quickly; every registry offers lifecycle or retention rules, and none of them
are on by default. Two rules cover most teams: delete untagged manifests
after a week, and keep the last N tags per repository. Be careful with the
first — untagged does not mean unused, because a signature or an attestation
references a manifest by digest, and a deployment may run a digest whose tag
was moved.

## Common patterns

- **One repository per image, one namespace per team.** Fine-grained access
  control follows repository boundaries everywhere.
- **A separate repository for build cache**, so `mode=max` cache layers never
  attach to the shipped image. See
  [remote build cache](remote-build-cache.md).
- **Mirror third-party images** you depend on. A base image that disappears
  upstream should not stop your builds.
- **Deploy by digest, tag for humans.** `tasklane-api:0.1.0` in the release
  notes, `tasklane-api@sha256:...` in the manifest.
- **`docker buildx imagetools create`** to add a tag to an existing manifest
  without pulling and pushing the bytes again.

## Production considerations

Registry availability is deployment availability if nodes pull on start.
Cache images on nodes where you can, keep a pull-through cache close to the
cluster, and know what happens during a registry outage — usually "existing
pods keep running, new pods do not start".

Storage grows monotonically without garbage collection. On self-hosted
Harbor, GC is a scheduled job that must actually be scheduled, and it needs
the registry in read-only mode for part of the run in some configurations.

Egress costs surprise people. Pulling a 200 MB image onto 50 nodes across
regions is 10 GB per rollout. Smaller images are an availability and cost
feature, not only a security one.

## Security considerations

- **Credentials in `config.json` are plaintext-equivalent.** Use a credential
  helper on developer machines, and short-lived tokens in CI.
- **Registry write access is code execution in production.** Treat push
  credentials as production credentials: scoped, short-lived, audited.
- **Immutable tags plus digest deployment** removes the most common
  tampering path. Signature verification at admission closes the rest; see
  [supply-chain admission](../k8s-security/supply-chain-admission.md).
- **Private registries still need scanning.** "Internal" images inherit CVEs
  from their base images exactly like public ones.
- **`insecure-registries` in `daemon.json` disables TLS verification** for
  the listed hosts. It is a lab-only setting.
- `gcr.io` is now served by Artifact Registry: Container Registry is shut
  down and writing to it was disabled on 2025-03-18, while existing `gcr.io`
  URLs hosted on Artifact Registry keep working. Do not write new pipelines
  that push to Container Registry.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `toomanyrequests: You have reached your pull rate limit` | Docker Hub 6-hour limit | Authenticate, mirror, or use a pull-through cache |
| `unauthorized: authentication required` after 12 hours | Expired ECR token | Use `docker-credential-ecr-login` |
| `denied: requested access to the resource is denied` on GHCR | Package permissions, not repo permissions | Grant the workflow `packages: write`; check package settings |
| `manifest unknown` | Tag deleted or never pushed for this platform | `docker buildx imagetools inspect` |
| Push succeeds, pull says `unsupported media type` | Registry does not understand OCI indices | `image-manifest=true` on cache; check registry version |
| Disk full on a self-hosted registry | GC never scheduled | Schedule garbage collection |

## Common mistakes

- Running CI unauthenticated against Docker Hub and treating the 429 as a
  flake.
- Deploying tags and assuming they are stable.
- Deleting untagged manifests aggressively, breaking signatures and running
  deployments.
- Storing build cache in the image repository, so consumers download
  intermediate layers.
- Using one registry credential everywhere, with push access, including in
  jobs that only need to pull.

## Related topics

- [Remote build cache](remote-build-cache.md)
- [Image signing with cosign](image-signing-cosign.md)
- [SBOMs and provenance](sboms-and-provenance.md)
- [Docker in CI](docker-in-ci.md)
- [Pulling and pushing](../docker-beginner/pulling-and-pushing.md)
- [Images, tags and digests](../docker-beginner/images-tags-digests.md)
