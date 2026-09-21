---
title: ARG vs ENV
description: Build-time arguments and runtime environment variables look alike, live in different places, and leak differently. Know which one you are holding.
level: advanced
type: concept
status: current
versions: Docker Engine 29, Buildx 0.37
prerequisites:
  - docker-intermediate/dockerfile-instructions
  - docker-beginner/environment-variables
---

## Overview

`ARG` exists during the build. `ENV` exists during the build *and* in every
container started from the image. Both are visible in build output, both are
substituted with `${...}`, and both are recorded somewhere an attacker can
read. The differences decide where configuration belongs and why neither is
a place for secrets.

## Why it exists and when to use it

`ARG` parameterises the build: which base image, which version string, which
target platform. Its value belongs to the *build*, not to the *running
program*, and it should not survive into the container's environment.

`ENV` configures the program: the port it listens on, the log level, the
libpq variables Tasklane reads. Its value belongs to the image only when it
is a sensible default for every deployment. Anything that differs per
environment is better supplied at run time, where you can change it without
rebuilding.

| | `ARG` | `ENV` |
|---|---|---|
| Available during build | yes, after its declaration | yes |
| Available at run time | no | yes |
| Set from the CLI | `--build-arg` | `-e`, `--env-file`, Compose, Kubernetes |
| Stored in the image config | as build metadata / history | as `Config.Env` |
| Visible in `docker history` | yes | yes |
| Visible in `docker inspect` | not as env | yes |
| Visible inside the container | no | yes, to every process and every child |
| Per-stage | yes, must be re-declared | inherited by later stages from the same base |

## How it works underneath

The Dockerfile frontend resolves `ARG` at solve time and substitutes it into
the LLB definition. The value therefore becomes part of the build graph: it
influences cache keys, it appears in the image history entry for the
instruction that used it, and with `mode=max` provenance it is recorded in
the attestation.

`ENV` is different: it compiles into the image configuration's `Env` array,
which the runtime hands to the container's first process. Anything that reads
`/proc/<pid>/environ` — including any process in the container, any debugger,
and anyone running `docker inspect` — sees it.

Scope rules from the Dockerfile reference: "Prior to its definition by an
`ARG` instruction, any use of a variable results in an empty string." An
`ARG` declared before the first `FROM` is global but is only usable in `FROM`
lines unless re-declared inside a stage. That is why the Tasklane Dockerfile
declares the image arguments at the top and re-declares `TARGETOS`,
`TARGETARCH` and `VERSION` inside the build stage.

### The leak

```bash
docker history tasklane-api:0.1.0 --no-trunc
docker image inspect tasklane-api:0.1.0 --format '{{ json .Config }}'
```

```console include="captures/docker-advanced/history-api.txt"
```

The history shows each instruction with its arguments substituted. A
`--build-arg NPM_TOKEN=...` used in a `RUN` line is right there, in the
metadata, in the registry, for anyone who can pull the image. Deleting the
file the token was written to does not help: the history entry is separate
from the filesystem.

The Dockerfile reference is blunt about it: "It isn't recommended to use
build arguments for passing secrets such as user credentials, API tokens,
etc. Build arguments are visible in the `docker history` command." BuildKit
ships a build check, `SecretsUsedInArgOrEnv`, that flags argument and
variable names that look like secrets; `# check=error=true` turns it into a
build failure.

The predefined proxy arguments (`HTTP_PROXY`, `HTTPS_PROXY`, `FTP_PROXY`,
`NO_PROXY`, `ALL_PROXY` and their lowercase forms) are the documented
exception: BuildKit excludes them from the history.

## Basic example

```dockerfile include="examples/app/Dockerfile" lines="12-13"
```

```dockerfile include="examples/app/Dockerfile" lines="26-35"
```

```bash
docker buildx build --target api \
  --build-arg VERSION=0.1.0 \
  -t tasklane-api:0.1.0 examples/app
```

## Explanation

`GO_IMAGE` and `RUNTIME_IMAGE` are global arguments, declared before the
first `FROM` so they can be used in `FROM` lines. They carry digest-pinned
defaults, so a plain build is reproducible, while a bump can be tested with
`--build-arg` without editing the file.

`VERSION` has a default of `dev`, is re-declared inside the build stage, and
ends up in the binary through `-ldflags -X main.version=...`. It is
deliberately *not* an `ENV`: the version is baked into the program, so the
running container cannot be lied to by an environment variable.

Tasklane's runtime configuration goes the other way. There is no `ENV
PGHOST` in the Dockerfile at all — the values come from Compose or from a
Kubernetes ConfigMap, and the password comes from a *file* named by
`PGPASSWORD_FILE`. That pattern exists precisely because environment
variables are readable by everything in the container.

## Common patterns

### Version metadata without cache churn

Put the volatile argument as late as possible. An `ARG VERSION` declared just
before the step that uses it invalidates only that step; declared at the top
of a stage and referenced early, it invalidates everything after it.

### Defaults in the image, overrides at run time

```dockerfile title="Dockerfile" fragment
ENV SHUTDOWN_DELAY_SECONDS=5
```

A sensible default that every deployment can override. Compare with
[`examples/compose/app.env`](../../examples/compose/app.env), which sets the
same knob per environment without touching the image.

### ARG in one stage, value into the next

An `ARG` is scoped to its stage. To reuse a value, either re-declare the
argument in the next stage or write it to a file the next stage copies.
`ENV` set in a stage is inherited only by stages that `FROM` that stage.

### Reading the build arguments of an image you were given

```bash
docker buildx imagetools inspect <ref> --format '{{ json .Provenance.SLSA }}'
```

With `mode=max` provenance, the arguments are in the attestation. This is a
debugging tool and a warning at the same time.

## Production considerations

Build arguments influence cache keys, so a "harmless" argument like a build
timestamp destroys cache for every step after it. If you need a timestamp,
make it `SOURCE_DATE_EPOCH` and let BuildKit treat it specially — see
[reproducible builds](reproducible-builds.md).

Keep the set of arguments small and documented. Every `--build-arg` in a CI
pipeline is a value that must agree between local builds and CI, and a
mismatch shows up as "works on my machine" with a different digest.

`ENV` entries are inherited by every child image. An `ENV NODE_ENV=production`
in a base image surprises downstream users who build a test stage from it.
Prefer explicit configuration in the final stage.

## Security considerations

- **Never** pass a credential as `--build-arg`. Use
  `RUN --mount=type=secret`; see
  [cache, secret and SSH mounts](cache-and-secret-mounts.md).
- **Never** put a credential in `ENV`. It is in the image config, visible to
  `docker inspect`, to every process in the container, and to anyone who can
  read the pod spec in Kubernetes. Mount a file instead, as Tasklane does
  with `PGPASSWORD_FILE`.
- `mode=max` provenance records build-arg values. A pipeline that
  accidentally passes a token as an argument publishes it in an attestation.
- Environment variables are inherited by child processes. A shell-out to a
  helper tool carries your whole environment with it.
- Proxy arguments are excluded from history, which makes them the one safe
  place for a proxy URL that contains credentials — but the URL is still
  visible to the build's processes.

## Troubleshooting

| Symptom | Cause | Check |
|---|---|---|
| `${VAR}` expands to empty | Used before its `ARG`, or not re-declared in this stage | Move the `ARG` above its first use |
| `--build-arg` ignored | No matching `ARG` declaration | BuildKit warns; `--progress=plain` shows it |
| Cache invalidated on every build | A volatile `--build-arg` early in the stage | Move it later, or drop it |
| Variable missing at run time | It was an `ARG` | Set `ENV`, or pass `-e` at run time |
| Token found in a published image | `ARG` or `ENV` | `docker history --no-trunc`, then rotate the token |

## Common mistakes

- `ARG SECRET` plus `ENV SECRET=$SECRET`, which is the worst of both: in the
  history *and* in the runtime environment.
- Believing that a `RUN ... && rm secret` removes the secret. It removes the
  file from the final filesystem, not from the layer or the history.
- Using `ENV` for values that change per environment, then rebuilding the
  image per environment. Build once, configure at run time.
- Redeclaring `ARG` with a different default in a later stage and expecting
  the earlier value. Each declaration stands alone.
- Assuming `--build-arg` without a value is safe. It copies the variable from
  your shell environment, which is how tokens reach images by accident.

## Related topics

- [Cache, secret and SSH mounts](cache-and-secret-mounts.md)
- [Reproducible builds](reproducible-builds.md)
- [SBOMs and provenance](sboms-and-provenance.md)
- [Environment variables](../docker-beginner/environment-variables.md)
- [Dockerfile instructions](../docker-intermediate/dockerfile-instructions.md)
- [Secrets in images](../docker-security/secrets-in-images.md)
