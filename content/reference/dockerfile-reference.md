---
title: Dockerfile reference
description: Every Dockerfile instruction and the modern BuildKit features, condensed, for frontend 1.x.
level: intermediate
type: reference
status: current
versions: Dockerfile frontend 1.x, Docker Engine 29
prerequisites:
  - docker-intermediate/dockerfile-instructions
---

## Overview

A condensed reference to every Dockerfile instruction plus the BuildKit
extensions worth knowing. Pin the frontend on the first line so builds are
reproducible:

```dockerfile title="syntax directive (fragment)" fragment
# syntax=docker/dockerfile:1
```

`:1` currently resolves to frontend 1.26.0 on Docker Hub (1.27.0 exists but the
`:1` tag has not moved). The minimum frontend for each extension is noted below.

## Instructions

| Instruction | Purpose | Notes |
|---|---|---|
| `FROM <image> [AS <stage>]` | base image / start a stage | `FROM scratch` for an empty base; name stages for multi-stage. |
| `ARG <name>[=default]` | build-time variable | Before the first `FROM` it is global; in a stage it must be re-declared. |
| `ENV <k>=<v>` | environment variable | Persists into the running container; layers cache on it. |
| `RUN <cmd>` | run a command in a layer | Shell form vs exec form (`["…"]`); prefer exec form to avoid a shell. |
| `COPY <src> <dst>` | copy build-context files | Prefer over `ADD`. |
| `ADD <src> <dst>` | copy, with URL/tar/git extras | Use only for its extras; otherwise `COPY`. |
| `CMD ["…"]` | default arguments / command | Overridden by `docker run` args. |
| `ENTRYPOINT ["…"]` | the executable | Exec form recommended; `CMD` becomes its default args. |
| `WORKDIR <dir>` | set working dir | Created if missing. |
| `USER <uid>[:<gid>]` | drop privileges | Prefer a numeric UID (e.g. `65532`) so `runAsNonRoot` can verify it. |
| `EXPOSE <port>` | document a port | Metadata only; does not publish. |
| `VOLUME ["/path"]` | declare a mount point | Anonymous volume at runtime; often better omitted. |
| `LABEL <k>=<v>` | image metadata | Use OCI keys (`org.opencontainers.image.*`). |
| `HEALTHCHECK` | container health probe | `--interval`, `--timeout`, `--retries`, `--start-period`; run the app's own check. |
| `STOPSIGNAL <sig>` | signal for stop | Defaults to SIGTERM. |
| `SHELL ["…"]` | change the shell form's shell | |
| `ONBUILD <instr>` | trigger in child builds | Rare; surprising. |

## Exec form versus shell form

Exec form (`["/app", "serve"]`) runs the binary as PID 1 with no shell, so
signals reach it directly — required for graceful shutdown. Shell form
(`/app serve`) runs under `/bin/sh -c`, which may swallow signals and does not
exist in a distroless image. Use exec form for `ENTRYPOINT` and `CMD`.

## Modern BuildKit features

Minimum frontend version in parentheses (from the Dockerfile release notes).

### RUN mounts

```dockerfile title="RUN mounts (fragment)" fragment
RUN --mount=type=cache,target=/root/.cache go build ./...        # (1.2) persistent cache
RUN --mount=type=bind,source=.,target=/src <cmd>                 # (1.2) read the context
RUN --mount=type=secret,id=token,env=TOKEN <cmd>                 # (1.2; env= 1.10)
RUN --mount=type=ssh <cmd>                                       # (1.2) forward ssh agent
RUN --mount=type=tmpfs,target=/tmp <cmd>                         # (1.2)
```

Secrets mounted this way never land in a layer — the fix for baked-in
credentials. Cache mounts speed up dependency downloads without bloating the
image.

### RUN network, security, device

```dockerfile title="RUN options (fragment)" fragment
RUN --network=none <cmd>       # (1.3) no network in this step
RUN --security=insecure <cmd>  # (1.20) needs an insecure-capable builder
RUN --device=<name> <cmd>      # (1.27) request a build device
```

### COPY / ADD extensions

```dockerfile title="COPY/ADD extensions (fragment)" fragment
COPY --link app /app                 # (1.4) rebuild-friendly layer, order-independent
COPY --chmod=0755 script /usr/bin/   # (1.2; symbolic modes 1.14)
COPY --exclude=*.md src/ /src/       # (1.19)
COPY --parents src/./a/b /out/       # (1.20) keep partial source paths
COPY --from=build /out/app /app      # copy from another stage
ADD --checksum=sha256:... <url> /f   # (1.6) verify a download
ADD --keep-git-dir <git-url> /repo   # (1.1)
ADD --unpack=false <tar-url> /dst    # (1.17) control auto-extract
```

### Heredocs and build checks

```dockerfile title="heredoc + check (fragment)" fragment
# check=error=true
RUN <<EOF
set -eu
echo building
EOF
```

`# check=` (1.8) turns build-lint findings into errors. Heredocs let a `RUN`
span multiple lines without `&&` chains.

## Multi-stage skeleton

```dockerfile title="multi-stage skeleton (fragment)" fragment
# syntax=docker/dockerfile:1
FROM golang:1.27 AS build
WORKDIR /src
RUN --mount=type=bind,target=. --mount=type=cache,target=/root/.cache \
    go build -o /out/app ./cmd/api

FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=build /out/app /app
USER 65532
ENTRYPOINT ["/app"]
```

The real Tasklane build is `examples/app/Dockerfile` with targets `api` and
`worker`.

## Common mistakes

- **Shell-form `ENTRYPOINT`.** Signals do not reach the process and there is no
  shell in distroless; use exec form.
- **`ARG` secrets or `ENV` secrets.** Both persist in the image; use
  `RUN --mount=type=secret`.
- **`ADD` for a local file.** Use `COPY`; reserve `ADD` for checksummed URLs and
  git.
- **Not pinning the base image by digest** in production-grade builds.
- **`USER` with a name instead of a numeric UID**, which Kubernetes'
  `runAsNonRoot` cannot verify.
- **Cache-busting layer order** — copy dependency manifests and install before
  copying the whole source.

## Related topics

- [Dockerfile instructions](../docker-intermediate/dockerfile-instructions.md)
- [Multi-stage builds](../docker-intermediate/multi-stage-builds.md)
- [Cache and secret mounts](../docker-advanced/cache-and-secret-mounts.md)
- [Docker CLI cheat sheet](docker-cli-cheat-sheet.md)
