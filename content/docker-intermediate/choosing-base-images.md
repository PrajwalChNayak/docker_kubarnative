---
title: Choosing base images
description: Distroless, Alpine, slim, scratch and hardened images compared, with the musl and glibc caveats that decide most of it.
level: intermediate
type: concept
status: current
versions: Docker Engine 29, Compose v5
prerequisites:
  - docker-intermediate/multi-stage-builds
  - docker-beginner/images-tags-digests
---

## Overview

The base image decides what a container has before your code arrives: which C
library, which shell, which package manager, which CA bundle, which user
accounts, and how many CVEs a scanner will report next month. For a runtime
stage the useful question is not "which distribution do I like" but "what is
the minimum my binary needs to run".

## Why it exists and when to use it

Every file in the base image is a file you maintain, patch and pull. A full
`debian:trixie` runtime gives you a familiar environment, `apt`, a shell and a
few hundred packages you never call. A distroless image gives you libc, CA
certificates and nothing else. Both are valid; the trade is convenience and
debuggability against attack surface, size and patch load.

The choice is only easy once you know what your artefact links against.

## How it works underneath

Three properties matter.

**The C library.** glibc (Debian, Ubuntu, RHEL) and musl (Alpine) are not
binary compatible. A Go binary built with `CGO_ENABLED=0` needs neither. A
Python wheel with native code, a .NET runtime, an Oracle client or anything
shipping prebuilt `.so` files usually needs glibc. Docker's own guidance for
hardened images is blunt: glibc "is widely supported and typically considered
the most compatible option", and musl "is not always fully compatible with
software that expects glibc".

**What else is in the filesystem.** A shell and a package manager make
debugging easy and post-exploitation easy. CA certificates, `/etc/passwd`,
`/etc/nsswitch.conf` and timezone data are small but their absence produces
confusing failures (TLS verification errors, `user: unknown userid`, UTC
timestamps).

**Who maintains it and how fast.** Rebuild cadence decides how long a fixed
CVE stays in your image. Pinning by digest means you choose when to take a
rebuild, which is only an advantage if something actually bumps the pin.

## Basic example

Tasklane's runtime base, pinned by index digest:

```dockerfile include="examples/app/Dockerfile" lines="12-13"
```

`gcr.io/distroless/static-debian13:nonroot` contains a minimal Debian 13
userland: CA certificates, `/etc/passwd` with a `nonroot` user at UID 65532,
timezone data — and no shell, no package manager, no libc-dependent runtime.
It suits a static Go binary exactly.

## Explanation

The families you will actually choose between:

| Base | Size class | Contains | Use when |
|---|---|---|---|
| `scratch` | 0 | nothing | fully static binary, and you provide CA certs and `/etc/passwd` yourself |
| `gcr.io/distroless/static-debian13` | very small | CA certs, tzdata, `/etc/passwd`, no libc | static Go/Rust binaries |
| `gcr.io/distroless/base-debian13` | small | + glibc, libssl | cgo-enabled or dynamically linked binaries |
| `gcr.io/distroless/cc-debian13` | small | + libstdc++ | C++ programs |
| `gcr.io/distroless/<runtime>-debian13` | medium | language runtime (Python, Node) | interpreted apps without a package manager at runtime |
| `alpine:3.24` | ~5–10 MB | musl, busybox, `apk` | small images where musl is proven fine for your stack |
| `debian:trixie-slim` / `ubuntu` | ~30–80 MB | glibc, coreutils, `apt` | maximum compatibility, familiar debugging |
| Docker Hardened Images | very small | distroless-style, signed metadata | supply-chain requirements, VEX/SBOM, CIS/FIPS variants |

Notes that change decisions:

- **`-debian12` distroless tags are deprecated.** The distroless project's
  README now lists only `-debian13` images and says any other tags "are
  considered deprecated and are no longer updated". Move pins to
  `-debian13`.
- **`:nonroot` variants** of distroless set `USER` to 65532 and own
  `/home/nonroot`. Use them, and still declare `USER 65532:65532` explicitly so
  the intent survives a base-image change.
- **`:debug` variants** of distroless add a busybox shell. Never as the
  production tag; useful as a separately published debug image.
- **Docker Hardened Images** are "minimal, secure, and production-ready
  container base and application images maintained by Docker", built to SLSA
  Build Level 3, shipped with signed SBOMs, VEX documents and provenance, and
  available in both glibc (Debian) and musl (Alpine) variants. Since the
  announcement of 2025-12-17 they are free under Apache-2.0 as a Community
  tier. They exclude shells and package managers, so the debugging story is
  `docker debug` or an ephemeral container.

### The Alpine question

Alpine is small and well maintained. The caveats are real but specific:

- **musl vs glibc.** Binaries built against glibc do not run. Wheels,
  prebuilt JARs with native parts, proprietary agents and anything using
  glibc-only symbols need a glibc image or a rebuild from source.
- **DNS.** musl's resolver historically could not fall back to TCP, so
  responses larger than a UDP packet failed. That was fixed in **musl 1.2.4**
  (2023-05-01), whose notes say it "adds TCP fallback to the DNS stub
  resolver, fixing the longstanding inability to query large DNS records".
  Alpine releases since then carry the fix; images built on older Alpine lines
  do not. musl also queries configured nameservers in parallel, which behaves
  differently from glibc's sequential order when servers disagree.
- **No NSS.** musl does not load glibc NSS plugins, so host resolution
  integrations that rely on `nsswitch.conf` modules simply are not there.
- **Performance.** musl's allocator and some libc paths differ from glibc.
  Allocation-heavy workloads can be slower on musl; this varies by workload
  and by musl version, so benchmark rather than assume in either direction.
- **Wheels and prebuilt artefacts.** Python has a separate `musllinux` wheel
  tag, and coverage is thinner than `manylinux`: where a wheel is missing,
  `pip` compiles from source, which needs a toolchain in the image and turns a
  20-second install into minutes.

If you want small *and* glibc, use distroless or a hardened glibc image rather
than fighting musl.

## Common patterns

**Static binary on distroless static.** Go or Rust with `CGO_ENABLED=0`
(`RUSTFLAGS` for musl targets), copied into `static-debian13:nonroot`. This is
the Tasklane pattern.

**Interpreted app on a slim base.** `python:3.14-slim` or `node:24-slim` in the
build stage; copy the virtualenv or `node_modules` into the same slim base in
the runtime stage, with `USER` set. Faster to debug than distroless, still far
smaller than a full distribution image.

**Scratch for a single file.** Works, but you must add CA certificates and an
`/etc/passwd` entry yourself, or TLS and `runAsNonRoot` break. Distroless
`static` exists precisely so you do not have to.

**One base image per organisation.** A curated, digest-pinned base per
language, rebuilt weekly by CI, is worth more than every team picking
individually.

**Pin by digest, automate the bump.** Keep the human-readable tag and append
the digest, as `examples/app/Dockerfile` does, and let Renovate or Dependabot
raise the pull request.

## Production considerations

Rebuild cadence beats scanner counts. An image with three known low-severity
CVEs that is rebuilt weekly is in better shape than a zero-CVE image frozen six
months ago. Base-image patching is a scheduled job, not an incident response.

Debuggability has to be planned for. If production images have no shell,
decide in advance how you will inspect a misbehaving container: `docker debug`,
a debug image tag, or `kubectl debug --image=busybox` with an ephemeral
container. Document it before you need it at 03:00.

Multi-arch matters if any developer is on arm64. Prefer base images with a
multi-platform index (the digests in this handbook are index digests), and
build with `--platform` plus cross-compilation rather than emulation.

Registry pull limits are a base-image decision too: Docker Hub allows 100 pulls
per six hours unauthenticated (per IPv4 address or IPv6 /64), 200
authenticated, unlimited on paid plans. CI that pulls `alpine` on every job
will meet that ceiling.

## Security considerations

- Fewer files means fewer CVEs to triage and fewer tools for an attacker. No
  shell, no `curl`, no `apt` is a meaningful reduction in post-exploitation
  options.
- A missing CA bundle silently breaks certificate verification, and the usual
  "fix" is to disable verification. Ship `ca-certificates`.
- `:nonroot` image variants encode a non-root UID in the image config, which
  makes Kubernetes `runAsNonRoot: true` enforceable without every manifest
  repeating `runAsUser`.
- Hardened images ship signed provenance, SBOMs and VEX. Those are only
  valuable if something verifies them: policy in CI, or admission control in
  the cluster.
- Pin by digest. A tag can be moved by whoever controls the repository; a
  digest cannot.

## Troubleshooting

**`exec /app: no such file or directory`** on a `scratch` or `static` image —
the binary is dynamically linked. Check with `ldd` or `file` in the build
stage, or set `CGO_ENABLED=0`.

**`x509: certificate signed by unknown authority`** — no CA bundle. Copy
`/etc/ssl/certs/ca-certificates.crt` from the build stage or use a base that
includes it.

**`user: unknown userid 65532`** — the image has no `/etc/passwd` entry for
the UID. Either use a `:nonroot` base or copy an `/etc/passwd` you generate.

**A Python install on Alpine suddenly compiles C code** — the project publishes
no `musllinux` wheel for that version. Add the build toolchain to a build
stage, or move to a slim glibc image.

**Timestamps are all UTC** — no tzdata. Add it, or keep UTC deliberately
(usually the better choice for servers).

**Intermittent DNS failures for large records on old Alpine images** — musl
before 1.2.4 with no TCP fallback. Move to a current Alpine release.

## Common mistakes

- Choosing Alpine for a Python or Java service to save 40 MB, then losing more
  in build time, debugging and performance.
- Using `-debian12` distroless tags, which are deprecated and no longer
  updated.
- Using a `:debug` or `:dev` variant in production because it was convenient
  during development.
- `FROM someimage:latest`, which the checker rejects anyway.
- Believing "distroless" means "no vulnerabilities". It means fewer packages;
  your application dependencies are untouched.
- Picking a base image once and never revisiting it, so a fixed upstream CVE
  never reaches production.

## Related topics

- [Multi-stage builds](multi-stage-builds.md)
- [Image size optimisation](image-size-optimisation.md)
- [Running as non-root](running-as-non-root.md)
- [Images, tags and digests](../docker-beginner/images-tags-digests.md)
- [Base image patching](../docker-security/base-image-patching.md)
- [Vulnerability scanning](../docker-advanced/vulnerability-scanning.md)
