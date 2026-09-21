---
title: Build context and .dockerignore
description: What the build context actually is, how BuildKit transfers it, and how to keep it small and free of secrets.
level: intermediate
type: concept
status: current
versions: Docker Engine 29, Compose v5
prerequisites:
  - docker-intermediate/dockerfile-instructions
---

## Overview

The build context is the set of files the builder can read while it builds.
`docker build .` does not "build the current directory": it makes the current
directory available to the builder, and the Dockerfile decides what to copy out
of it. A context can be a local directory, a local tarball on stdin, a remote
Git repository, a remote tarball or a plain text file.

Everything in the context is a candidate for transfer to the builder, and
everything transferred is a candidate for ending up in a layer. Both are
reasons to keep it small.

## Why it exists and when to use it

The builder may not be on your machine. BuildKit runs in the daemon, and with
`docker buildx` it may run in a container, on a remote host or in a cloud
builder. The context exists so that the build is explicit about which files
cross that boundary, rather than reading arbitrary paths on your disk.

That boundary is also a security boundary. A `.env` file, an SSH key or a
`.git` directory in the context can be copied into an image by a careless
`COPY . .`, and then shipped to a registry.

## How it works underneath

1. The client walks the context directory, applying the ignore rules.
2. The files that survive are sent to the builder, then cached there; later
   builds send only what changed.
3. During the build, `COPY`/`ADD` and `RUN --mount=type=bind` read from that
   snapshot. Nothing else in the build can see the host filesystem.

For `COPY`, `ADD` and bind mounts, BuildKit computes a cache checksum from the
file contents and metadata of the files actually referenced. `mtime` is
excluded, so a `touch` does not invalidate the cache.

Ignore rules are applied by the client, before transfer. That is why a good
`.dockerignore` speeds up builds even when the Dockerfile never copies the
excluded files, and it is why excluded files cannot leak into an image by
accident.

Context types:

| Context | Example | Notes |
|---|---|---|
| Local directory | `docker build .` | most common |
| Local tarball | `docker build - < ctx.tar.gz` | Dockerfile comes from the tarball |
| Dockerfile on stdin, no context | `docker build -f- . ` / `docker build - < Dockerfile` | with no context only `ADD` of remote sources works |
| Git repository | `docker build https://github.com/user/repo.git#main:sub` | fragment is `#<ref>:<dir>`; `.git` is not kept unless `BUILDKIT_CONTEXT_KEEP_GIT_DIR=1` |
| Remote tarball | `docker build https://example.com/ctx.tar.gz` | downloaded and extracted by the builder |
| Named contexts | `docker build --build-context docs=./docs .` | referenced with `COPY --from=docs` |

## Basic example

The Tasklane application's ignore file excludes everything and then re-admits
exactly what the Dockerfile needs:

```text include="examples/app/.dockerignore"
```

The Dockerfile copies `go.mod`/`go.sum` first and the sources second, so it
only ever reads files that survived those rules:

```dockerfile include="examples/app/Dockerfile" lines="19-26"
```

## Explanation

`**` at the top of the file excludes everything, including dotfiles and
directories. Each `!` line is an exception. The last matching line wins, so
`**/*_test.go` after the `!cmd/` exception removes the test files again.

This deny-by-default shape is worth copying. The alternative — listing things
to exclude — fails open: a new `secrets/` directory added next month is in the
context until somebody remembers to exclude it.

`.dockerignore` syntax:

- Newline-separated patterns matched with Go's `filepath.Match`, plus `**`
  for "any number of path components".
- Leading and trailing slashes are ignored, so `/foo/bar`, `foo/bar/` and
  `foo/bar` are the same rule.
- `#` in column 1 is a comment. The pattern `.` is ignored for historical
  reasons.
- `!` negates, and placement matters: the last line that matches a file
  decides.
- The `Dockerfile` and `.dockerignore` themselves can be excluded from the
  context. They are still sent to the builder, because it needs them, but they
  can no longer be `COPY`ed into the image.

Per-Dockerfile ignore files exist: put `build.Dockerfile.dockerignore` next to
`build.Dockerfile` and it takes precedence over the root `.dockerignore` for
that build. This is the clean way to give a test image and a production image
different contexts.

## Common patterns

**Deny by default.** Start with `**`, then re-admit. Used by
`examples/app/.dockerignore`.

**Exclude the build output and the VCS metadata.** `.git`, `node_modules`,
`target/`, `dist/`, `*.tfstate`, `.venv`. A `.git` directory in a monorepo is
frequently the largest thing in the context.

**Exclude secrets even if nothing copies them.** `.env`, `*.pem`, `*.key`,
`id_rsa`, `.npmrc`, `.netrc`, `kubeconfig`.

**Use a subdirectory as the context.** `docker build -f docker/api.Dockerfile
./services/api` is often simpler than a large ignore file. Compose does this
per service with `build.context`.

**Use named contexts instead of one big tree.** `--build-context
proto=../proto` keeps a shared directory out of every service's context while
staying copyable with `COPY --from=proto`.

**Use `COPY --exclude`** (frontend 1.19+) for the last mile, when the ignore
file cannot express "copy the tree but not the fixtures".

## Production considerations

A large context costs time on every build, including CI runs where the
BuildKit cache is cold and the whole context is uploaded. Measure it: the
first line of build output reports the context transfer.

Remote Git contexts are attractive in CI because the builder clones directly
and the runner never holds the source. The default clone drops `.git`, so a
build that derives a version from `git describe` needs
`--build-arg BUILDKIT_CONTEXT_KEEP_GIT_DIR=1`, or, better, an explicit
`--build-arg VERSION=` computed outside the build.

With Compose, `build.context` is resolved relative to the Compose file, and
with multiple `-f` files, relative to the *first* one. That surprises people in
monorepos; `include` resolves each file against its own directory instead.

## Security considerations

- Anything in the context can be read by any instruction in the Dockerfile,
  including instructions added by a dependency-bumping bot. Ignore rules are
  the enforcement point.
- Secrets that reach a layer are permanent: deleting the file in a later
  `RUN` leaves it in the earlier layer, and anyone who pulls the image can
  extract it. Use `RUN --mount=type=secret`, whose contents never enter a
  layer and never participate in the cache checksum.
- A build context sent to a *remote* builder leaves your machine. Treat a
  shared or cloud builder as an untrusted destination for anything you would
  not push to a registry.
- `ADD` of a remote URL or Git repository pulls code into the build. Pin it
  with `--checksum` (SHA-256 for HTTP, commit SHA for Git); a tag or branch is
  not immutable.

## Troubleshooting

**"failed to compute cache key: ... not found"** — the path is excluded by the
ignore file, or it is outside the context. `COPY ../shared /app` cannot work:
parent-directory navigation is stripped from source paths.

**The build is slow before the first step runs.** The context is large. Check
what is being sent:

```bash
du -sh .
du -sh .git node_modules
```

**A file you excluded is in the image anyway.** A later `!` line re-admitted
it, or the file is produced inside the build by a `RUN`.

**`docker build` from a different directory copies the wrong files.** The
context is the path argument, not the directory holding the Dockerfile. `-f`
sets the Dockerfile, the final argument sets the context.

**Compose builds behave differently from a plain `docker build`.** Compose v5
delegates builds to Bake, and `build.context` is relative to the Compose file;
confirm what it resolved with `docker compose config`.

## Common mistakes

- `COPY . .` with no `.dockerignore`, which ships `.git`, local caches and
  editor state into the image.
- Assuming `.gitignore` is used. It is not; only `.dockerignore` is.
- Excluding files in `.dockerignore` and then wondering why `COPY` fails.
- Trying to copy from outside the context with `../`.
- Using `ADD` with an unpinned URL and treating the result as trustworthy.
- Putting the ignore file next to the Dockerfile in a subdirectory and
  expecting it to apply — it must be at the root of the *context*, unless you
  use the `<dockerfile>.dockerignore` naming convention.

## Related topics

- [Every Dockerfile instruction](dockerfile-instructions.md)
- [Layer caching](layer-caching.md)
- [Image size optimisation](image-size-optimisation.md)
- [Secrets in images](../docker-security/secrets-in-images.md)
- [Compose fundamentals](compose-fundamentals.md)
