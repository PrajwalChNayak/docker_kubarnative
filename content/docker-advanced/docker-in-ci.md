---
title: Docker in CI
description: Build a signed, attested, cached multi-platform image in GitHub Actions, and understand which parts transfer to any other CI system.
level: advanced
type: tutorial
status: current
versions: Docker Engine 29, Buildx 0.37
prerequisites:
  - docker-advanced/remote-build-cache
  - docker-advanced/multi-platform-builds
  - docker-advanced/image-signing-cosign
---

## Overview

Building images in CI is mostly the same four problems everywhere: get a
builder, make the cache warm, push with the right credentials, and produce
the metadata (digests, attestations, signatures) that later stages need.

This page walks through a complete GitHub Actions workflow for Tasklane and
names the parts that are specific to GitHub. The workflow lives at
[`examples/build/github-actions-build.yaml`](../../examples/build/github-actions-build.yaml)
and is included below in pieces.

:::note
Every action input used here appears in that action's documented input list.
Where something is not documented, the workflow does it in a `run:` step
instead. Copying inputs from blog posts is the fastest way to a workflow that
fails on an unknown key.
:::

## The pipeline, step by step

### 1. Permissions

```yaml include="examples/build/github-actions-build.yaml" lines="17-20"
```

The job then widens them to exactly what it needs:

```yaml include="examples/build/github-actions-build.yaml" lines="22-31"
```

`packages: write` is GHCR push access. `id-token: write` is what lets cosign
mint an OIDC identity; without it, keyless signing fails with an error about
getting an ID token. Keep both scoped to the one job that needs them.

### 2. A builder that can do the job

```yaml include="examples/build/github-actions-build.yaml" lines="46-52"
```

The default `docker` driver on a runner cannot export registry cache or build
a manifest list unless the containerd image store is enabled, so the workflow
asks for a `docker-container` builder explicitly.

There is no QEMU step. The Tasklane Dockerfile cross-compiles from
`$BUILDPLATFORM`, so arm64 output is produced by a native amd64 compiler. A
workflow that does need emulation adds `docker/setup-qemu-action`, and pays
for it in minutes.

### 3. Credentials

```yaml include="examples/build/github-actions-build.yaml" lines="54-60"
```

`secrets.GITHUB_TOKEN` is minted per job and expires with it — short-lived
credentials for free. Other registries need a stored secret or, better, an
OIDC-federated cloud role.

Pull requests skip the login entirely, because they do not push.

### 4. Build with cache, attestations and platforms

```yaml include="examples/build/github-actions-build.yaml" lines="62-76"
```

Everything about *what* to build lives in the Bake file, not in the workflow:
platforms, tags, labels, cache references and attestations. The workflow
supplies variables through the environment and decides whether to push.

The `--set '*.cache-to='` trick clears cache export for pull requests. A fork
PR must never write to your cache, because whatever it writes, your next main
build imports and trusts.

### 5. Digests, not tags

```yaml include="examples/build/github-actions-build.yaml" lines="78-89"
```

`bake-action` exposes the build metadata as JSON keyed by target;
`containerimage.digest` is the digest of the pushed manifest list. Everything
downstream — signing, attesting, deploying — uses that digest. A tag can move
between the push and the signature; a digest cannot.

### 6. Sign, attest, verify

```yaml include="examples/build/github-actions-build.yaml" lines="91-106"
```

```yaml include="examples/build/github-actions-build.yaml" lines="126-134"
```

Verification in the same pipeline that signs is not redundant. It catches a
misconfigured identity immediately, in the workflow that caused it, instead
of in an admission controller next month.

## Running it

```bash
cp examples/build/github-actions-build.yaml .github/workflows/build.yaml
git add .github/workflows/build.yaml && git commit -m "ci: build and sign images"
```

Locally, the same build without any CI:

```bash
docker buildx bake -f examples/build/docker-bake.hcl --print
docker buildx bake -f examples/build/docker-bake.hcl dev --load
```

```console include="captures/docker-advanced/buildx-bake-print.txt"
```

## What transfers to other CI systems

| Concern | GitHub Actions | Elsewhere |
|---|---|---|
| Builder | `docker/setup-buildx-action` | `docker buildx create --driver docker-container --bootstrap` |
| Cache | `type=gha` (beta) | `type=registry,mode=max` — works everywhere |
| Credentials | `GITHUB_TOKEN`, OIDC | Registry secret, or the platform's OIDC federation |
| Identity for signing | `id-token: write` | GitLab `id_tokens`, Buildkite OIDC, or a KMS key |
| Definition of the build | Bake file | The same Bake file |

Keeping the build definition in `docker-bake.hcl` rather than in workflow
YAML is what makes a CI migration a day rather than a quarter. It also means
a developer can run exactly what CI runs.

## Runner strategy

**Ephemeral runners** are the safe default: each job gets a clean machine, so
a compromised build cannot persist. The cost is a cold cache, which is
exactly what a registry cache backend fixes.

**Persistent self-hosted runners** keep local cache and cache mounts, which
is fast and dangerous: one job can leave artefacts, environment variables or
a poisoned cache for the next. If you use them, run builds rootless, prune
the builder on a schedule, and never run untrusted pull requests on them.

**Native arm64 runners** beat emulation when cross-compilation is not
possible. Build each platform on its own runner and merge with
`docker buildx imagetools create`.

## Cost and speed

The biggest wins, in order:

1. A registry cache with `mode=max` for multi-stage builds.
2. Cross-compilation instead of QEMU.
3. A small final image, because push and pull time is real time.
4. Not building at all on documentation-only changes (path filters).
5. Separate jobs that can run in parallel, rather than one long job.

Measure total wall-clock time of the workflow, not cache hit rates. A cache
that takes 90 seconds to import and saves 60 is a loss.

## Common mistakes

- Letting forked pull requests write build cache or hold registry
  credentials.
- Signing a tag, or deploying a tag that CI has since moved.
- Adding `docker/setup-qemu-action` reflexively when the build
  cross-compiles anyway.
- Using `type=gha` cache without per-target `scope`, so two images overwrite
  each other's cache.
- Mounting the Docker socket into the job to "make Docker work" — see
  [DinD vs socket mounting](dind-vs-socket-mounting.md).
- Putting build configuration in workflow YAML, so the build cannot be
  reproduced locally.
- Pinning actions to a floating major version and being surprised by a
  behaviour change; pin to a tag you reviewed, or to a commit SHA.

## Related topics

- [Remote build cache](remote-build-cache.md)
- [Multi-platform builds](multi-platform-builds.md)
- [Image signing with cosign](image-signing-cosign.md)
- [SBOMs and provenance](sboms-and-provenance.md)
- [DinD vs socket mounting](dind-vs-socket-mounting.md)
- [Registries](registries.md)
- [CI/CD for Kubernetes](../k8s-advanced/cicd-for-kubernetes.md)
