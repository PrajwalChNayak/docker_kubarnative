---
title: Multi-stage builds
description: Use several FROM stages to keep build tools out of the shipped image, target stages selectively, and build several images from one Dockerfile.
level: intermediate
type: concept
status: current
versions: Docker Engine 29, Compose v5
prerequisites:
  - docker-intermediate/dockerfile-instructions
  - docker-intermediate/layer-caching
---

## Overview

A multi-stage build is a Dockerfile with more than one `FROM`. Each `FROM`
starts a stage with its own filesystem and its own base image. A later stage
can copy files out of an earlier one with `COPY --from=`, and the final stage
is what becomes the image — everything else is discarded unless something
references it.

This is how a 900 MB build environment produces a 10 MB runtime image, and how
one Dockerfile can produce several related images.

## Why it exists and when to use it

Compilers, package managers, test runners and source code are needed to
*produce* an artefact and are liabilities at runtime: attack surface, image
size, pull time and CVE noise that has nothing to do with your application.
Before multi-stage builds, teams either shipped all of it or maintained a
builder image plus a brittle "extract the binary and build a second image"
script.

Use multi-stage whenever the build needs tools the runtime does not, which is
almost always: Go, Rust, Java, C, TypeScript, anything with a `node_modules`
tree of dev dependencies.

## How it works underneath

Each stage is an independent build graph rooted at its `FROM`. BuildKit builds
only the stages the target depends on, and it builds independent stages
concurrently. A stage that nothing references is not built at all.

`COPY --from=<stage|image|context>` reads from the filesystem root of that
stage. `RUN --mount=type=bind,from=<stage>` reads from it without copying.
Naming stages with `AS` keeps references stable when you insert a stage.

`ARG` declared inside a stage is inherited by stages based on it, not by
unrelated stages. Labels behave the same way: labels of a stage you only
`COPY --from=` are not in the final image.

`--target` stops the build at a named stage, which is what makes one Dockerfile
serve `api`, `worker`, `test` and `dev`.

## Basic example

The Tasklane image is one build stage plus two runtime stages:

```dockerfile include="examples/app/Dockerfile"
```

Build either image by target:

```bash
docker build --target api -t tasklane-api:0.1.0 examples/app
docker build --target worker -t tasklane-worker:0.1.0 examples/app
```

## Explanation

The `build` stage compiles both binaries in one step, writing them to `/out`.
`--platform=$BUILDPLATFORM` pins that stage to the architecture of the machine
running the build, and `GOOS`/`GOARCH` come from the automatic platform args,
so an arm64 image is cross-compiled rather than emulated.

The `api` and `worker` stages start from distroless `static-debian13:nonroot`
and copy exactly one file each. They share the base image layers, so pushing
both costs little more than pushing one.

Two properties make this work:

- `CGO_ENABLED=0` produces a statically linked binary with no libc dependency,
  which is what allows a base image that contains no libc at all.
- The final stages contain no shell, so the `HEALTHCHECK` cannot be
  `curl`-based. Instead the binary implements its own `healthcheck`
  subcommand, defined in `internal/probe`.

Compare with the deliberately naive single-stage version in
`examples/dockerfiles/size-naive-vs-optimised/`, which ships the compiler, the
module cache and the sources:

```dockerfile include="examples/dockerfiles/size-naive-vs-optimised/Dockerfile.optimised" lines="1-12"
```

## Common patterns

**Builder plus runtime.** The default: one stage compiles, one stage runs.

**Shared base stage.** Factor common setup into a stage other stages build
`FROM`:

```dockerfile title="shared-base.Dockerfile" fragment
FROM debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a AS base
RUN groupadd -g 10001 app && useradd -u 10001 -g app app

FROM base AS build
# build tooling here

FROM base AS runtime
COPY --from=build /out/app /usr/local/bin/app
USER 10001:10001
```

**Test stage in the same file.** A `test` stage that runs the suite and a CI
step that does `docker build --target test .` gives you tests in the same
environment as the build, cached the same way.

**Dependency stage.** Copy only manifests into a `deps` stage, install there,
and `COPY --from=deps` the resulting tree. Changing source code then cannot
invalidate the install, even if the install and the build must share a
directory.

**Copy from an external image.** `COPY --from=` also accepts an image
reference, which is a clean way to pull a single static binary
(a migration tool, `grpc_health_probe`, CA bundles) into a distroless image
without a package manager. Pin the image by digest: it is a build input like
any other.

**Named contexts.** `docker build --build-context ui=../ui .` plus
`COPY --from=ui /dist /srv` composes two source trees without vendoring.

**Multiple images, one file.** Targets `api` and `worker`, as in Tasklane.
Compose's `build.target` selects them per service.

## Production considerations

Tag and push both targets from the same commit so the pair is always
consistent. In CI that means two `docker build --target` invocations, or one
Bake file with two targets — Compose v5 delegates builds to Bake, so a Bake
file is also what Compose ends up driving.

A "debug" variant is worth having: the same final stage plus a shell and
`busybox`, published as a separate tag. Then production images can stay
shell-less while an on-call engineer still has something to exec into. In
Kubernetes, `kubectl debug` with an ephemeral container removes even that
need.

Build times: stages that do not depend on each other run in parallel, so
splitting a long sequential build into independent stages (compile, lint,
generate) can cut wall-clock time even though the total work is the same.

## Security considerations

- The shipped image should contain the artefact and nothing that produced it.
  Compilers, `git`, `curl` and package managers in a runtime image are all
  useful to an attacker who gets code execution.
- Secrets used in a build stage do not leak into the final image *only* if you
  never copy them forward. They are still in the build stage's layers, which
  end up in the build cache and in any registry you export a cache to. Use
  `RUN --mount=type=secret`.
- `COPY --from=<image>` pulls a third-party image into your supply chain.
  Digest-pin it and scan it like a base image.
- A shell-less final stage is not a security boundary by itself — a compromised
  process can still call `execve` on whatever is there — but it removes the
  easiest path from "code execution" to "interactive access".

## Troubleshooting

**`COPY --from=build /out/app: not found`.** The path is relative to the
*stage's* root, and the artefact may be somewhere else than you think. Add a
temporary `RUN ls -l /out` in the build stage, or build with
`--target build` and inspect the result.

**The final image crashes with "no such file or directory" while the binary
exists.** A dynamically linked binary in a base image without its interpreter
or libc. Build with `CGO_ENABLED=0`, or use `gcr.io/distroless/base-debian13`
(glibc) or `cc-debian13` (glibc + libstdc++).

**A stage rebuilds although nothing in it changed.** Its inputs include
something volatile; see [layer caching](layer-caching.md).

**`--target` builds more than the named stage.** It builds the named stage and
everything it depends on. Independent stages are skipped.

**Labels or `ENV` from the build stage are missing.** Only the final stage's
metadata (and that of its ancestors via `FROM`) reaches the image.

## Common mistakes

- Keeping the build stage as the final stage "temporarily", then shipping it.
- Copying a whole directory out of the build stage (`COPY --from=build /src
  /app`) instead of the artefact, which re-imports the source.
- Forgetting `USER` in the final stage, so the container runs as root although
  the build stage needed root and the runtime does not.
- Assuming `ARG` declared in stage one is visible in stage three.
- Using a `scratch` or `static` base for a cgo-enabled binary.
- Building with `--target` in CI but without it locally, so the two produce
  different images.

## Related topics

- [Every Dockerfile instruction](dockerfile-instructions.md)
- [Layer caching](layer-caching.md)
- [Choosing base images](choosing-base-images.md)
- [Image size optimisation](image-size-optimisation.md)
- [Multi-platform builds](../docker-advanced/multi-platform-builds.md)
- [Cache and secret mounts](../docker-advanced/cache-and-secret-mounts.md)
