---
title: Compose fundamentals
description: The Compose file model — services, networks, volumes, project names — and what changed in Compose v5.
level: intermediate
type: concept
status: current
versions: Docker Engine 29, Compose v5
prerequisites:
  - docker-beginner/running-containers
  - docker-intermediate/docker-networking
---

## Overview

Compose turns a declarative file into a set of running containers, networks and
volumes on one Docker host. You describe the desired state in `compose.yaml`
and run `docker compose up`; Compose creates what is missing, recreates what
changed and leaves the rest alone.

The command is `docker compose`, a CLI plugin. The old Python Compose v1 binary
— the hyphenated command — is end-of-life and should not be used. Compose v5 skipped
major versions 3 and 4 so that its version number could never be confused with
the old compose-*file* format versions `2.x` and `3.x`.

## Why it exists and when to use it

A `docker run` command for a real service is unreadable and unreviewable.
Compose gives you the same information as a file you can diff, review and
commit — and it adds the two things that are painful by hand: a private
network with DNS, and dependency ordering.

Use Compose for local development, for CI environments, for demos, and for
small single-host deployments. Stop using it when you need scheduling across
machines, rolling updates with health gates, or autoscaling; that is
Kubernetes.

## How it works underneath

Compose builds an application *model* in three steps and then reconciles it:

1. **Parse and merge.** `compose.yaml` plus `compose.override.yaml` (or the
   files given with `-f`, in order), then top-level `include`s, then
   `extends`.
2. **Interpolate.** `${VAR}` expressions are resolved from the shell
   environment, `--env-file`, or the project's `.env` file.
3. **Reconcile.** Compose creates the project's networks and volumes, then
   containers in dependency order, labelling everything with the project name.

Every object is named and labelled by project: containers
`<project>-<service>-<index>`, networks `<project>_<network>`, volumes
`<project>_<volume>`. That is how `docker compose down` knows what to remove,
and how two projects stay separate on one host.

The project name comes from, highest precedence first: `-p`,
`COMPOSE_PROJECT_NAME`, the top-level `name:` attribute, the base name of the
project directory, the base name of the current directory. It must be
lowercase letters, digits, dashes and underscores, and start with a letter or
digit.

Two Compose v5 changes matter here:

- **Builds are delegated to Bake.** v5.0.0 removed Compose's internal builder;
  `docker compose build` now drives the same code path as `docker build`.
- **Compose is usable as an SDK**, which is how other tools embed it.

The top-level `version:` key is obsolete. The docs describe it as "only
informative", and using it earns a warning. This handbook never writes it.

## Basic example

The Tasklane stack declares four always-on services, two networks, one volume,
a secret and a config:

```yaml include="examples/compose/compose.yaml" lines="1-45"
```

```bash
docker compose -f examples/compose/compose.yaml config
docker compose -f examples/compose/compose.yaml up -d --wait
docker compose -f examples/compose/compose.yaml ps
docker compose -f examples/compose/compose.yaml down
```

The fully resolved model, with every anchor expanded and every variable
substituted:

```console include="captures/docker-intermediate/compose-config.txt"
```

## Explanation

`name: tasklane` fixes the project name, so the stack does not rename itself
when somebody clones the repository into a different directory.

`x-app-security` is a top-level extension field. Anything starting with `x-` is
ignored by Compose and available as a YAML anchor, which is how the same
hardening block is applied to several services with `<<: *app-security`. The
resolved output above shows what it expands to — a useful habit: read
`config`, not the source, when you are debugging.

`db` has no `ports` in the base file. Services reach it as `db:5432` on the
`backend` network; nothing needs to be published for that. Publishing is only
for traffic from outside the host, and the override file adds it for
developers.

The `migrate` service runs to completion and exits. `restart: "no"` makes that
explicit, and other services wait for it via
`condition: service_completed_successfully`.

## Common patterns

**One file, real hardening.** `read_only`, `cap_drop: [ALL]`,
`no-new-privileges`, non-root images, resource limits. Development stacks are
where habits form.

**Anchors and extension fields for repetition.** `x-` blocks plus `<<:` merge
keys keep a long file readable. `config` shows the expansion.

**Dependencies with conditions, not `sleep`.** See
[Compose dependencies and healthchecks](compose-dependencies-and-healthchecks.md).

**Named volumes for state, no bind mounts in the base file.** Bind mounts are
developer conveniences; put them in the override.

**Explicit networks.** Compose creates a `default` network if you declare
none. Declaring `frontend` and an `internal: true` `backend` costs three lines
and gives real segmentation.

**`include` for modular stacks.** Each included file resolves its relative
paths against its own directory, which `-f` merging does not do.

**`--wait` in scripts.** `docker compose up -d --wait` blocks until services
with healthchecks are healthy, which makes CI steps deterministic.

## Production considerations

Compose is a single-host tool. `deploy.replicas` runs N containers on *this*
host; it does not schedule, reschedule or spread across machines. There is no
rolling update with health gating, no node failure handling, and no built-in
way to run one stack across two machines.

For a small internal service on one VM, that can be enough — with `restart:
unless-stopped`, a reverse proxy, backups of the volumes and a documented
restore. Be deliberate about it rather than drifting into production by
accident.

Version drift is a real operational issue: the Compose file format is a
specification, but behaviour depends on the client version. The maintainer's
environment for this handbook is Compose **v5.0.2**, while **v5.5.1** is the
current release; features documented as "introduced in 2.32" or later are
present in both, but newer fixes (lifecycle-hook output, watch on symlinked
directories) are not. Pin the Compose version in CI images and state it in
your README.

Compose stacks in CI should use a unique project name per job (`-p
ci-$BUILD_ID`) so parallel jobs do not share networks and volumes, and should
always end with `down -v` in a cleanup step.

## Security considerations

- Anything in `environment:` is visible in `docker inspect`, `docker compose
  config` and the process environment. Use `secrets` for credentials; see
  [Compose secrets, configs and scaling](compose-secrets-configs-scaling.md).
- `docker compose config` prints resolved values, including interpolated
  secrets from `.env`. Do not paste it into an issue tracker.
- `.env` files are the most common accidental commit in Compose repositories.
  Ignore them in git *and* in `.dockerignore`.
- Compose talks to the Docker daemon, which is root-equivalent. Anyone who can
  run `docker compose up` on a host can take it over.
- Prefer `internal: true` networks for datastores, publish to `127.0.0.1` when
  you must publish at all, and keep the hardening block on every service.

## Troubleshooting

**"services.web Additional property X is not allowed".** A typo, or an
attribute from a newer Compose version than the client. Check
`docker compose version`.

**The stack is recreated when you expected no change.** Compose recreates a
container when its configuration hash changes: a changed image digest, env
var, mount or label. `docker compose up --dry-run` shows what it would do.

**Two projects clash.** Same project name, usually from two clones of the same
directory. Set `name:` in the file.

**`docker compose down` leaves volumes behind.** By design. `down -v` removes
them, and removes your data with them.

**Relative paths resolve unexpectedly with multiple `-f` files.** All paths
resolve against the *first* file. Use `include` if each file should resolve
against its own directory.

**A service is missing entirely.** It has a `profiles:` attribute and the
profile is not active.

## Common mistakes

- Using the hyphenated Compose v1 command instead of the `docker compose` plugin.
- Keeping a top-level `version:` key. It is obsolete.
- Publishing ports for service-to-service traffic that never leaves the host.
- Using `container_name`, which breaks scaling and collides between projects.
- Committing `.env` with real credentials.
- Treating `deploy.replicas` as horizontal scaling across machines.
- Expecting `restart: always` to fix an unhealthy container. Restart policies
  react to exits, not to health status.

## Related topics

- [Compose dependencies and healthchecks](compose-dependencies-and-healthchecks.md)
- [Compose profiles, overrides and environment](compose-profiles-overrides-env.md)
- [Compose watch](compose-watch.md)
- [Compose secrets, configs and scaling](compose-secrets-configs-scaling.md)
- [Tasklane with Compose](tasklane-with-compose.md)
- [Docker networking](docker-networking.md)
- [Compose v1/v2 to v5](../migration/compose-v1-v2-to-v5.md)
