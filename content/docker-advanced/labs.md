---
title: Labs — Docker, advanced
description: Nine exercises on BuildKit, caching, secrets, multi-platform builds, signing, scanning and limits, with full solutions.
level: advanced
type: lab
status: current
versions: Docker Engine 29, Buildx 0.37
prerequisites:
  - docker-advanced/buildkit-and-buildx
  - docker-advanced/cache-and-secret-mounts
  - docker-advanced/multi-platform-builds
  - docker-advanced/image-signing-cosign
---

## Overview

Nine exercises covering the whole part. Each one is small; together they
produce a signed, attested, multi-platform, reproducibly built Tasklane image
with limits and rotation configured.

Work from the repository root. Where an exercise pushes to a registry, use
one you own — GHCR is free for personal accounts — or stop at `--print` and
`--output type=oci` and skip the push.

## Setup

```bash
docker version
docker buildx version
docker buildx ls
docker info --format '{{ .CgroupVersion }} {{ .LoggingDriver }}'
```

You need:

- Docker Engine 29 with buildx.
- A `docker-container` builder for anything involving multi-platform output
  or cache export.
- For exercises 6 and 7: `cosign`, `syft` and either `trivy` or `grype`, or
  the pinned container images for them.
- A registry you can push to, for exercises 5 to 7.

```bash
docker buildx create --name tasklane-lab --driver docker-container --bootstrap
```

Remove it at the end with `docker buildx rm tasklane-lab`.

:::warning
Exercise 9 deliberately breaks a container. Run every exercise on a machine
you can afford to disturb, never on a shared build host.
:::

## Exercises

### 1. Read the build plan before building

Print the resolved Bake plan for `examples/build/docker-bake.hcl` without
building. Then answer, from the output alone: which targets does the default
group contain, which platforms will each produce, and what does the `api`
target inherit from `_common`?

### 2. Prove a cache mount is not a layer

Build the `api` target twice, changing one line of Go source in between.
Explain why the second build does not download modules again, and show that
no layer in the resulting image contains the module cache.

### 3. Find the secret that is not there

Build `examples/build/Dockerfile.secret-demo` with a file secret and an
environment secret. Then demonstrate two things: that the secret value is not
in the image, and that a build argument *would* have been.

### 4. Make arm64 fast

Time a two-platform build of the `api` target. Then remove
`--platform=$BUILDPLATFORM` from the build stage (in a scratch copy of the
Dockerfile), time it again, and explain the difference in one sentence.

### 5. Warm cache on a cold machine

Configure a registry cache for the `api` target so that a builder created
from scratch still gets a cache hit on the dependency layers. Prove it by
pruning the builder and rebuilding.

### 6. Sign and verify by digest

Push the `api` image, take the digest from the build metadata, sign it
keyless, and verify it with an identity constraint. Then verify with a
deliberately wrong identity and observe the failure.

### 7. Attest and scan

Build with an SBOM attestation, read it back with `imagetools`, and scan the
SBOM rather than the image. Compare the finding count against a scan of
`golang:1.27-trixie` and explain the difference.

### 8. Make the build reproducible

Build and push the `api` target twice with `SOURCE_DATE_EPOCH` set from the
last commit, then compare the two registry digests. If they differ, find out
why.

### 9. Break a container with limits, then fix it

Run a container with `--memory 32m` and a workload that allocates 64 MB.
Observe the failure mode, prove it was the OOM killer, and then show the
difference between hitting a memory limit and hitting a CPU limit.

## Solutions

### 1. Read the build plan before building

```bash
docker buildx bake -f examples/build/docker-bake.hcl --print
docker buildx bake -f examples/build/docker-bake.hcl --list targets
```

`--print` resolves variables, `inherits` and interpolation, and emits JSON
without touching a builder. The default group contains `api` and `worker`.
Both inherit `context`, `dockerfile`, `platforms`
(`linux/amd64`, `linux/arm64`), `args`, `labels` and `attest` from
`_common`, and add their own `target`, `tags`, `cache-from` and `cache-to`.
`_common` is not in any group, so a plain `bake` never builds it directly.

Reading the plan first is the cheapest habit in this part: most Bake mistakes
are visible in the JSON.

### 2. Prove a cache mount is not a layer

Work on a scratch copy so the repository's example stays untouched:

```bash
cp -r examples/app /tmp/app-lab
docker buildx build --builder tasklane-lab --target api -t tasklane-api:lab /tmp/app-lab --load
echo '// touch' >> /tmp/app-lab/cmd/api/main.go
docker buildx build --builder tasklane-lab --target api -t tasklane-api:lab /tmp/app-lab --load
docker history tasklane-api:lab --no-trunc
```

The `COPY go.mod go.sum` layer is unchanged, so `go mod download` is a cache
hit. Even when it does re-run — change `go.mod` and try — the `/go/pkg/mod`
cache mount is still populated, so it downloads only what is new.

The history shows the final image's layers: the distroless base plus the
copied binary. The module cache is nowhere, because a `type=cache` mount is
builder state, not a layer. Confirm the state exists separately:

```bash
docker buildx du --builder tasklane-lab --verbose
```

### 3. Find the secret that is not there

```bash
export NPM_TOKEN=not-a-real-token
printf 'hunter2' > /tmp/api_token
docker buildx build -f examples/build/Dockerfile.secret-demo \
  --secret id=api_token,src=/tmp/api_token \
  --secret id=NPM_TOKEN \
  --output type=local,dest=./out examples/build
cat ./out/proof/token.fingerprint ./out/proof/token.length
grep -r hunter2 ./out || echo "secret not present"
```

The build used the secret (the fingerprint proves it) and the value is not in
the output. For the contrast, build a throwaway Dockerfile that takes
`ARG DEMO_TOKEN` and uses it in a `RUN`, then:

```bash
docker history --no-trunc <that-image> | grep DEMO_TOKEN
```

The argument value is right there in the metadata. That is the whole reason
secret mounts exist.

### 4. Make arm64 fast

```bash
time docker buildx build --builder tasklane-lab \
  --platform linux/amd64,linux/arm64 --target api \
  --output type=cacheonly examples/app
```

Then copy the Dockerfile, remove `--platform=$BUILDPLATFORM` from the build
stage, and repeat with `-f`. The second build pulls the arm64 Go toolchain
and runs the compiler under QEMU emulation, which is dramatically slower and
occasionally crashes.

One sentence: `--platform=$BUILDPLATFORM` runs the compiler natively and
cross-compiles via `TARGETOS`/`TARGETARCH`, instead of emulating an entire
foreign toolchain.

### 5. Warm cache on a cold machine

```bash
CACHE=ghcr.io/<you>/tasklane/buildcache
docker buildx build --builder tasklane-lab --target api \
  -t ghcr.io/<you>/tasklane/tasklane-api:lab --push \
  --cache-to type=registry,ref=$CACHE:api,mode=max \
  --cache-from type=registry,ref=$CACHE:api examples/app

docker buildx rm tasklane-lab
docker buildx create --name tasklane-lab --driver docker-container --bootstrap

docker buildx build --builder tasklane-lab --target api \
  -t ghcr.io/<you>/tasklane/tasklane-api:lab --push \
  --cache-from type=registry,ref=$CACHE:api examples/app
```

The second build on the fresh builder reports `CACHED` for the dependency and
compile steps. `mode=max` is what makes the compile stage cacheable at all:
with `mode=min`, only layers that reach the final image are exported, and the
build stage's layers do not.

### 6. Sign and verify by digest

```bash
docker buildx build --builder tasklane-lab --target api \
  -t ghcr.io/<you>/tasklane/tasklane-api:lab --push \
  --metadata-file meta.json examples/app
DIGEST=$(jq -r '."containerimage.digest"' meta.json)
IMAGE=ghcr.io/<you>/tasklane/tasklane-api@$DIGEST

cosign sign --yes "$IMAGE"
cosign verify \
  --certificate-identity-regexp '^https://github.com/<you>/' \
  --certificate-oidc-issuer https://accounts.google.com \
  "$IMAGE"
```

Use the issuer you actually authenticated with — the interactive flow offers
several, and the issuer in the certificate must match the one you pass.
Verifying with a wrong identity fails with `no matching signatures`, which is
the correct and only useful behaviour: a signature without an identity
constraint proves nothing.

Signing the digest rather than the tag closes the window in which the tag
could be moved between push and signature.

### 7. Attest and scan

```bash
docker buildx build --builder tasklane-lab --target api \
  -t ghcr.io/<you>/tasklane/tasklane-api:lab --push \
  --sbom=true --provenance=mode=max examples/app

docker buildx imagetools inspect ghcr.io/<you>/tasklane/tasklane-api:lab \
  --format '{{ json .SBOM.SPDX }}' > sbom.spdx.json
grype sbom:./sbom.spdx.json --fail-on high --only-fixed

syft golang:1.27-trixie -o spdx-json=base.spdx.json
grype sbom:./base.spdx.json
```

The distroless runtime image contains a handful of files and one static
binary; the Go toolchain image contains a full Debian userland plus build
tools. The finding counts differ by orders of magnitude, and none of those
toolchain packages are in your runtime image — which is the entire argument
for multi-stage builds and distroless bases.

### 8. Make the build reproducible

```bash
export SOURCE_DATE_EPOCH="$(git log -1 --pretty=%ct)"
REPO=ghcr.io/<you>/tasklane/tasklane-api

docker buildx build --builder tasklane-lab --target api \
  --output type=image,name=$REPO:repro-a,push=true,rewrite-timestamp=true examples/app
docker buildx build --builder tasklane-lab --target api --no-cache \
  --output type=image,name=$REPO:repro-b,push=true,rewrite-timestamp=true examples/app

docker buildx imagetools inspect $REPO:repro-a --format '{{ .Manifest.Digest }}'
docker buildx imagetools inspect $REPO:repro-b --format '{{ .Manifest.Digest }}'
```

The two digests should match. If they differ, the usual culprits are:
`SOURCE_DATE_EPOCH` not exported to the second build, `rewrite-timestamp`
omitted, a floating base image tag instead of a digest, or compiler flags
that embed paths — which is why the Tasklane build uses `-trimpath` and
`-buildid=`.

`rewrite-timestamp` is an option of the image exporter and requires BuildKit
v0.13 or later. Comparing registry digests is the meaningful test; local
image IDs can differ for packaging reasons that have nothing to do with
reproducibility.

### 9. Break a container with limits, then fix it

```bash
docker run --rm --memory 32m --pids-limit 64 \
  busybox:1.37-musl sh -c 'dd if=/dev/zero of=/dev/shm/fill bs=1M count=64'
echo "exit: $?"
docker run --rm --memory 32m busybox:1.37-musl cat /sys/fs/cgroup/memory.max
```

The container dies with exit code 137 — SIGKILL from the cgroup OOM killer.
On a container you keep, `docker inspect --format '{{.State.OOMKilled}}'`
confirms it.

Now the CPU contrast:

```bash
docker run --rm --cpus 0.2 busybox:1.37-musl \
  sh -c 'cat /sys/fs/cgroup/cpu.max; timeout 5 md5sum /dev/zero; cat /sys/fs/cgroup/cpu.stat'
```

Nothing dies. The workload is throttled: stopped at the end of each quota
period and resumed at the start of the next. Memory limits kill, CPU limits
delay — which is why an OOMKill is a loud failure and CPU throttling is a
silent latency problem you only see in `cpu.stat`.

Clean up:

```bash
docker buildx rm tasklane-lab
rm -f sbom.spdx.json base.spdx.json meta.json
rm -rf ./out /tmp/app-lab
```

## Common mistakes

- Running the multi-platform exercises on the default `docker` builder and
  concluding the flags are broken.
- Forgetting `--load` or `--push`, then looking for an image that was never
  exported anywhere.
- Comparing local image IDs instead of registry digests in exercise 8.
- Signing the `:lab` tag instead of the digest in exercise 6, and then being
  unable to explain what the signature covers.
- Leaving the lab builder and its cache behind. `docker buildx du` will
  remind you eventually, usually when the disk is full.
- Running exercise 9 on a shared machine.

## Related topics

- [BuildKit and buildx](buildkit-and-buildx.md)
- [Cache, secret and SSH mounts](cache-and-secret-mounts.md)
- [Remote build cache](remote-build-cache.md)
- [Multi-platform builds](multi-platform-builds.md)
- [Reproducible builds](reproducible-builds.md)
- [Image signing with cosign](image-signing-cosign.md)
- [Vulnerability scanning](vulnerability-scanning.md)
- [Resource limits](resource-limits.md)
