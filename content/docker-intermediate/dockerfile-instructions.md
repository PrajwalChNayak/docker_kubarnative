---
title: Every Dockerfile instruction
description: What each Dockerfile instruction does, which flags it takes, and which ones change the image at build time versus at run time.
level: intermediate
type: reference
status: current
versions: Docker Engine 29, Compose v5
prerequisites:
  - docker-beginner/images-tags-digests
  - docker-beginner/running-containers
---

## Overview

A Dockerfile is a small, ordered program. BuildKit reads it, builds a graph of
steps, runs the steps it cannot reuse from cache, and writes an OCI image: a
stack of filesystem layers plus a JSON config that says which process to start,
as which user, with which environment.

Only some instructions produce a layer. `RUN`, `COPY` and `ADD` change the
filesystem. `ENV`, `LABEL`, `USER`, `WORKDIR`, `EXPOSE`, `ENTRYPOINT`, `CMD`,
`STOPSIGNAL`, `HEALTHCHECK`, `VOLUME`, `SHELL` and `ONBUILD` only write image
metadata. `ARG` and the parser directives affect the build and never reach the
image. Knowing which is which explains most cache behaviour and most surprises.

This page is the reference for the instruction set as of the
`docker/dockerfile:1` frontend. Minimum frontend versions are quoted from
[the Dockerfile reference](https://docs.docker.com/reference/dockerfile/).

## Parser directives

Parser directives are comments of the form `# directive=value` that must come
before anything else in the file. A directive may appear only once, line
continuations are not allowed inside one, and after the first comment, blank
line or instruction BuildKit stops looking for them.

```dockerfile title="parser-directives.Dockerfile" fragment
# syntax=docker/dockerfile:1
# check=error=true
# escape=\
```

- `syntax` selects the Dockerfile frontend image. `docker/dockerfile:1` pulls
  the latest stable 1.x frontend at build time, so a new feature works without
  upgrading the daemon. Every Dockerfile in this handbook starts with it.
- `check` configures [build checks](https://docs.docker.com/build/checks/):
  `# check=skip=JSONArgsRecommended`, `# check=error=true`, or both separated
  by a semicolon. By default a failed check is a warning and the build still
  exits 0; `error=true` turns warnings into failures. The docs recommend
  pinning the syntax version to an exact release when you use `error=true`,
  because a later frontend can add checks that fail your build.
- `escape` changes the escape character from `\` to a backtick. It exists for
  Windows paths and you will almost never need it.

Directive keys are case-insensitive, values are case-sensitive.

## FROM

```dockerfile title="from.Dockerfile" fragment
FROM [--platform=<platform>] <image>[:<tag>|@<digest>] [AS <name>]
```

`FROM` starts a stage and clears all state from the previous one. `ARG` is the
only instruction allowed before it. Each `FROM` may name the stage with `AS`,
which `COPY --from=`, `RUN --mount=from=` and a later `FROM` can reference.

Pin by digest. A tag is a moving pointer; the digest is the content address of
the image index. The handbook's convention is to keep the tag for humans and
append the digest for the builder, as `examples/app/Dockerfile` does:

```dockerfile include="examples/app/Dockerfile" lines="12-18"
```

`--platform=$BUILDPLATFORM` pins a stage to the machine doing the build so a
cross-compiler runs natively instead of under QEMU emulation.

## RUN

`RUN` executes a command in a new layer. It has a shell form
(`RUN command`, executed through `/bin/sh -c`) and an exec form
(`RUN ["cmd", "arg"]`, no shell, no variable expansion). Heredocs make long
scripts readable:

```dockerfile title="run-heredoc.Dockerfile" fragment
RUN <<EOF
set -eux
apt-get update
apt-get install -y --no-install-recommends ca-certificates
rm -rf /var/lib/apt/lists/*
EOF
```

Options, with their minimum frontend versions:

| Option | Min | Purpose |
|---|---|---|
| `--mount=type=bind` | 1.2 | mount a stage, image or context read-only into the step |
| `--mount=type=cache` | 1.2 | persistent build cache directory, not stored in the layer |
| `--mount=type=tmpfs` | 1.2 | scratch space in memory |
| `--mount=type=secret` | 1.2 | secret file or env var (`env=` since 1.10), never in a layer |
| `--mount=type=ssh` | 1.2 | forwarded SSH agent socket |
| `--network` | 1.3 | `default`, `none` or `host` for this step |
| `--security` | 1.20 | `sandbox` (default) or `insecure` |
| `--device` | 1.27 | expose a device to the step |

The cache for a `RUN` is keyed on the instruction text and the parent layer,
nothing else. `RUN apt-get update` will happily return a month-old cache. See
[layer caching](layer-caching.md).

## CMD and ENTRYPOINT

`ENTRYPOINT` is the executable, `CMD` is its default arguments; arguments to
`docker run` replace `CMD`, never `ENTRYPOINT`. Only the last of each counts,
and setting `ENTRYPOINT` resets a `CMD` inherited from the base image. Use the
exec form for both. Full matrix and reasoning: [ENTRYPOINT vs CMD](entrypoint-vs-cmd.md).

## COPY and ADD

`COPY` copies files from the build context, a build stage, a named context or
an image. `ADD` does that too, and additionally understands remote URLs, Git
repositories and tar archives. Use `COPY` unless you need one of those.

| Flag | On | Min | Notes |
|---|---|---|---|
| `--from=<stage\|image\|context>` | COPY | — | source resolved from the filesystem root of that stage |
| `--chown=<user>:<group>` | both | — | without it, files are owned by UID/GID 0. Names are resolved from the image's `/etc/passwd`; numeric IDs need no lookup |
| `--chmod=<perms>` | both | 1.2 | octal, or symbolic (`u=rwX,go=rX`) since 1.14 |
| `--link` | both | 1.4 | copy into an empty layer that is linked on top, so the layer survives changes to earlier instructions |
| `--parents` | COPY | 1.20 | keep parent directories of the sources |
| `--exclude=<pattern>` | both | 1.19 | exclude paths matching a `filepath.Match` pattern; repeatable |
| `--keep-git-dir` | ADD | 1.1 | keep `.git` when the source is a repository |
| `--checksum=<hash>` | ADD | 1.6 | verify a remote source before using it |
| `--unpack=<bool>` | ADD | 1.17 | force or suppress tar extraction |

Details worth knowing:

- `--link` is the flag that makes `COPY` layers reusable. The docs describe it
  as equivalent to building `FROM scratch` plus your `COPY` and merging the
  result on top. The cost: the copy cannot read the previous state, so a
  symlink in the destination path is not followed, and the destination path is
  always made of plain directories.
- With `--link`, `--chown` must use numeric IDs, because there is no
  `/etc/passwd` in the empty layer to resolve names against.
- `ADD --checksum` accepts a SHA-256 content digest for HTTP sources
  (`sha256:...`) and a commit SHA, full or prefixed, for Git sources. That is
  the only way to make `ADD` of a remote artefact tamper-evident.
- Local tar archives are unpacked by default; remote ones are not. `--unpack`
  overrides both directions. Recognised compressions are gzip, bzip2, xz and
  zstd, detected from content rather than from the filename.
- A remote file added by URL lands with mode 0600, and `ADD` cannot
  authenticate — use `RUN --mount=type=secret` with `curl` for that.
- Git sources take URL fragments: `ADD https://github.com/moby/buildkit.git#v0.14.1:docs /docs`
  is `#<ref>:<subdir>`.

```dockerfile title="add-examples.Dockerfile" fragment
ADD --checksum=sha256:24454f830cdb571e2c4ad15481119c43b3cafd48dd869a9b2945d1036d1dc68d \
    https://mirrors.edge.kernel.org/pub/linux/kernel/Historic/linux-0.01.tar.gz /src/
COPY --link --chown=65532:65532 --exclude=*.md ./dist /app/
```

## ENV, ARG and LABEL

`ENV` sets a variable for the rest of the stage *and* for the running
container. `ARG` sets a build-time variable only: it is not in the final image,
but it is visible in `docker history` and in `max`-mode provenance
attestations, so it is not a way to pass secrets.

Scope rules that trip people up:

- An `ARG` before the first `FROM` is global: it can be used in `FROM` lines,
  but not inside a stage unless you redeclare `ARG NAME` (no value) in that
  stage.
- A variable is empty before its `ARG` line, and an `ENV` of the same name
  always wins over an `ARG`.
- The automatic platform args `TARGETPLATFORM`, `TARGETOS`, `TARGETARCH`,
  `TARGETVARIANT`, `BUILDPLATFORM`, `BUILDOS`, `BUILDARCH` and `BUILDVARIANT`
  exist in the global scope and must be redeclared inside a stage to be used
  there.
- Predefined proxy args (`HTTP_PROXY`, `NO_PROXY`, ...) are excluded from
  `docker history` output by default.

`LABEL` writes key–value metadata. Prefer the OCI keys
(`org.opencontainers.image.source`, `.title`, `.revision`, `.created`). Labels
are inherited from the base image; labels from stages you only `COPY --from=`
are not.

```dockerfile include="examples/app/Dockerfile" lines="38-41"
```

## WORKDIR, USER, EXPOSE, VOLUME

- `WORKDIR` sets the directory for the instructions that follow and creates it
  if missing. Relative paths stack. Always set it explicitly rather than
  inheriting whatever the base image chose.
- `USER <uid>[:<gid>]` sets the user for later `RUN` steps and for the
  container's process. Use numbers: name lookup needs `/etc/passwd`, which a
  distroless or scratch image may not have, and Kubernetes `runAsNonRoot` can
  only verify a numeric UID. Specifying a group replaces *all* group
  membership with that single group; if the user has no primary group, the
  process runs with the root group.
- `EXPOSE <port>[/tcp|/udp]` is documentation plus a hint for `docker run -P`.
  It publishes nothing.
- `VOLUME /path` marks a path as externally mounted. `docker run` creates an
  anonymous volume there and seeds it with whatever the image has at that path.
  Under BuildKit, later build steps that write into the path are kept (the
  legacy builder discarded them). `VOLUME` in a base image is mostly a
  nuisance: it forces anonymous volumes on every `docker run` and cannot be
  undone in a child image.

## STOPSIGNAL, HEALTHCHECK, SHELL, ONBUILD

`STOPSIGNAL SIGTERM` (the default) sets the signal `docker stop` sends. It
takes `SIG<NAME>` or a number, and `docker run --stop-signal` overrides it.
Ctrl-C is unaffected: that sends SIGINT directly.

`HEALTHCHECK [OPTIONS] CMD ...` defines the in-container health probe. Options
and defaults: `--interval=30s`, `--timeout=30s`, `--start-period=0s`,
`--start-interval=5s` (Engine 25.0+), `--retries=3`. Exit 0 means healthy,
1 unhealthy, 2 is reserved. Only the last `HEALTHCHECK` counts, and
`HEALTHCHECK NONE` disables one inherited from the base image. See
[healthchecks](healthchecks.md).

`SHELL ["executable", "params"]` changes the shell used by shell-form `RUN`,
`CMD` and `ENTRYPOINT`. The default is `["/bin/sh", "-c"]` on Linux. A common
Linux use is `SHELL ["/bin/bash", "-o", "pipefail", "-c"]` so a failing command
in a pipeline fails the build.

`ONBUILD <INSTRUCTION>` registers a trigger that runs immediately after `FROM`
in a *downstream* build. Triggers are cleared after they fire, so they are not
inherited by grandchildren. `ONBUILD ONBUILD` is not allowed, and a trigger
cannot be `FROM` or `MAINTAINER`. Since frontend 1.11 `ONBUILD COPY --from=`
and `ONBUILD RUN --mount=from=` work, provided the referenced stage or context
exists in the downstream build. ONBUILD makes builds act at a distance; prefer
a shared base stage or a template.

`MAINTAINER` is deprecated. Use `LABEL org.opencontainers.image.authors`.

## Heredocs

Heredocs work with `RUN` and `COPY`. `<<EOF` expands variables, `<<'EOF'`
does not, and `<<-EOF` strips leading tabs. A heredoc that starts with a
shebang runs under that interpreter. `COPY <<EOF /path` writes an inline file,
which is how the demos in `examples/dockerfiles/` create scripts without extra
files in the context.

```dockerfile include="examples/dockerfiles/signal-forms/Dockerfile.exec" lines="10-19"
```

## Variable substitution

Substitution happens in `ADD`, `COPY`, `ENV`, `EXPOSE`, `FROM`, `LABEL`,
`STOPSIGNAL`, `USER`, `VOLUME`, `WORKDIR` and in `ONBUILD` combined with one of
those. In `RUN`, `CMD` and `ENTRYPOINT` the *shell* does the substitution, so
the exec form does none at all: `CMD ["echo", "$HOME"]` prints a literal
`$HOME`.

The `${var:-default}`, `${var-default}`, `${var:+alt}` and `${var+alt}`
modifiers are supported. Within one instruction a variable has a single value;
changes take effect only in later instructions.

## Common mistakes

- Using the shell form of `ENTRYPOINT`, so the process is not PID 1 and never
  sees SIGTERM. See [PID 1 and signals](pid1-signals-graceful-shutdown.md).
- Expecting `EXPOSE` to publish a port, or `VOLUME` to bind a host directory.
  Neither can: `VOLUME` deliberately has no host-path argument so that images
  stay portable.
- Passing secrets through `ARG` or `ENV`. Both are readable from image
  metadata; use `RUN --mount=type=secret`.
- `USER myapp` in an image with no `/etc/passwd` entry, or forgetting that a
  group argument drops every other group membership.
- Assuming `ADD` of a remote tarball unpacks it. It does not, unless you pass
  `--unpack=true`.
- Writing `# syntax=` after a comment or an instruction, where it is silently
  treated as a comment.
- Leaving `# check=error=true` with a floating `docker/dockerfile:1`: a new
  check in a future frontend can fail a build that used to pass.

## Related topics

- [Build context and .dockerignore](build-context-and-dockerignore.md)
- [Layer caching](layer-caching.md)
- [Multi-stage builds](multi-stage-builds.md)
- [ENTRYPOINT vs CMD](entrypoint-vs-cmd.md)
- [Healthchecks](healthchecks.md)
- [Running as non-root](running-as-non-root.md)
- [Dockerfile reference (handbook)](../reference/dockerfile-reference.md)
