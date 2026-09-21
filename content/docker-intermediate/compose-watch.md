---
title: Compose watch
description: Automatic sync, rebuild and restart on file changes — the four actions, their requirements, and when a bind mount is still better.
level: intermediate
type: concept
status: current
versions: Docker Engine 29, Compose v5
prerequisites:
  - docker-intermediate/compose-fundamentals
---

## Overview

`docker compose watch` (or `up --watch`) monitors paths on the host and reacts
to changes according to rules in a service's `develop.watch` section. It is the
supported way to get an edit-and-see-it loop for containerised development
without bind-mounting your whole working tree.

`develop` has been available since Compose 2.22.0.

## Why it exists and when to use it

Bind-mounting the source directory works for interpreted languages and breaks
down everywhere else: compiled languages need a rebuild, `node_modules` must
not be shared between host and container because native modules are not
portable, and on Docker Desktop a large bind mount is slow because it crosses
a VM boundary.

Watch fixes this by making the reaction explicit per path: sync this
directory, rebuild on that manifest, restart when the config changes. The docs
put it plainly: watch "allows for greater granularity than is practical with a
bind mount", and it is designed for services built from local source with
`build`, not for pre-built images.

## How it works underneath

Each rule has a `path` (relative to the project directory) and an `action`:

| Action | What Compose does | Since |
|---|---|---|
| `sync` | copies changed files into the container at `target` | 2.22.0 |
| `rebuild` | rebuilds the image and recreates the service | 2.22.0 |
| `restart` | restarts the container | 2.32.0 |
| `sync+restart` | syncs, then restarts the container | 2.23.0 |
| `sync+exec` | syncs, then runs `exec.command` in the container | 2.32.0 |

Other attributes: `target` (where synced files land), `ignore` and `include`
(same pattern syntax as `.dockerignore`, and `ignore` patterns are relative to
the rule's `path`), `initial_sync` (bring containers up to date when a watch
session starts), and `exec` (`command`, `user`, `privileged`, `working_dir`,
`environment`) for `sync+exec`.

Requirements that are easy to miss:

- The image must contain `stat`, `mkdir` and `rmdir`. A distroless runtime
  image has none of them, so `sync` cannot work there — `rebuild` still can.
- The container's `USER` must be able to write to the target path. The docs
  suggest `COPY --chown` so the initial content is owned by that user.
- `.dockerignore` rules apply, plus common editor temp files and `.git`, which
  are ignored automatically.
- After a `rebuild`, the previous image becomes dangling and Compose prunes it
  by default; `docker compose watch --prune=false` keeps it.

## Basic example

Tasklane is Go, so every source change means a new binary and therefore a new
image:

```yaml include="examples/compose/compose.yaml" lines="89-98"
```

```bash
docker compose -f examples/compose/compose.yaml up --watch
```

Edit `examples/app/cmd/api/main.go`, save, and Compose rebuilds the `api`
image and recreates only that service. The database, the volume and the worker
are untouched.

## Explanation

Three rules, all `rebuild`, covering `cmd/`, `internal/` and `go.mod`. There
is no `sync` rule because syncing Go source into a distroless image would
achieve nothing: there is no compiler in there, and no shell for watch to use.

The worker has the same rules minus `go.mod`. Both services are rebuilt from
`examples/app`, so a change under `cmd/` triggers both — Compose rebuilds each
service whose rules matched.

This is the honest trade for compiled languages: a rebuild takes as long as a
build, and the layer cache is what makes it bearable. The dependency layer
(`go mod download`) and the cache mounts mean a rebuild compiles changed
packages only.

For an interpreted stack, the same file would use `sync` for source and
`rebuild` only for the dependency manifest:

```yaml title="watch-interpreted.yaml" fragment
# service fragment for an interpreted app
develop:
  watch:
    - action: sync
      path: ./src
      target: /app/src
      ignore:
        - node_modules/
    - action: rebuild
      path: ./package.json
    - action: sync+restart
      path: ./config/app.yaml
      target: /etc/app/app.yaml
```

## Common patterns

**Compiled language: `rebuild` only.** Go, Rust, Java. Make the build cache
good; that is what determines the loop time.

**Interpreted language: `sync` for source, `rebuild` for the manifest.** The
canonical pattern from the documentation.

**`sync+restart` for configuration.** A config file that the process reads at
start-up: copy it in, restart the process, skip the rebuild.

**`sync+exec` for a reload command.** Where the server can reload without a
restart (`nginx -s reload`, a framework's dev command), `sync+exec` keeps
connections alive.

**`ignore` for generated output.** Build artefacts inside a watched path
otherwise trigger loops: the build writes a file, watch sees it, rebuild,
repeat.

**`initial_sync: true`** when containers are already running and you want them
in a known state at the start of a session.

## Production considerations

Watch is a development tool. It has no place in CI or on a server: images
there are built once, tagged and run.

Its cost is CPU and file-system watches on the developer machine. Large
watched trees on macOS and Windows are the slow case, which is another reason
to scope `path` narrowly rather than watching the repository root.

Compose version matters for this feature more than most: `restart` and
`sync+exec` need 2.32.0 or later, and the client used for this handbook
(v5.0.2) predates fixes in v5.5.1 for watching symlinked directories. If your
team has mixed versions, keep the rules to `sync` and `rebuild` — the two
actions that have been there since 2.22.0.

The Kubernetes equivalent is a different toolchain — Skaffold, Tilt or
`devspace` — with the same model: sync for interpreted code, rebuild for
everything else.

## Security considerations

- Watch copies files from your machine into a running container. Anything it
  syncs is content the container process can read; keep `.env`, keys and
  credentials out of watched paths, and rely on `.dockerignore` plus `ignore`.
- `sync+exec` runs a command in the container on every change. Treat that
  command as production-equivalent code: it runs automatically, on file save,
  with the container's privileges. `privileged: true` in an `exec` block is
  the sort of thing that survives into a shared file.
- Watch requires a writable target path, which conflicts with
  `read_only: true`. Relaxing the hardening for development is reasonable;
  relaxing it in the base file that CI also uses is not. Put it in the
  override.
- Rebuilds pull and build automatically as you type. On a shared machine, that
  is a lot of automated execution triggered by file changes.

## Troubleshooting

**Nothing happens when a file changes.** The path is not covered by a rule, or
it is excluded by `.dockerignore` or by an `ignore` pattern. Watch paths are
resolved relative to the project directory — the Tasklane rules point at
`../app`, a sibling of the Compose file, and `docker compose config` shows the
absolute paths Compose resolved them to.

**`sync` fails on a distroless or scratch image.** No `stat`, `mkdir` or
`rmdir`. Use `rebuild`, or sync into a development image that has them.

**Permission denied during sync.** The container user cannot write to
`target`. Use `COPY --chown` for the initial content, or run the development
container as a user that owns the path.

**An endless rebuild loop.** The build writes into a watched path. Add an
`ignore` rule for the output directory.

**Rebuilds are slow.** The Dockerfile invalidates the dependency layer on
every source change. Fix the ordering; see [layer caching](layer-caching.md).

**Watch works for one service and not another.** Only services with a `build`
section and `develop.watch` rules participate.

**Symlinked directories are not watched.** A known issue fixed in a later
Compose release than the one used here; check `docker compose version`.

## Common mistakes

- Watching the repository root, so every `git status` or editor temp file
  triggers work.
- Using `sync` for a compiled language and wondering why nothing changes.
- Syncing `node_modules` between host and container.
- Adding a bind mount *and* watch rules for the same path, so both mechanisms
  fight.
- Leaving development-only `develop` sections plus relaxed security settings in
  the file CI uses.
- Assuming watch restarts the process after a `sync`. It does not; that is
  `sync+restart`.

## Related topics

- [Compose fundamentals](compose-fundamentals.md)
- [Compose profiles, overrides and environment](compose-profiles-overrides-env.md)
- [Layer caching](layer-caching.md)
- [Volumes, bind mounts and tmpfs](volumes-bind-mounts-tmpfs.md)
- [Tasklane with Compose](tasklane-with-compose.md)
