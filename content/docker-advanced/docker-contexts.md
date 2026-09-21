---
title: Docker contexts
description: Point the CLI at another daemon over SSH or TLS, keep builders straight, and stop running the right command against the wrong machine.
level: advanced
type: concept
status: current
versions: Docker Engine 29, Buildx 0.37
prerequisites:
  - docker-beginner/docker-cli-basics
  - docker-advanced/daemon-configuration
---

## Overview

A context is a named endpoint the Docker CLI talks to. The default one is the
local daemon socket; others can point at a remote daemon over SSH or TLS, or
at a rootless daemon on the same machine. Switching context changes which
machine every subsequent command affects — including `docker rm -f`.

## Why it exists and when to use it

Three recurring needs:

- **A remote build or test host.** An amd64 server, or a machine with more
  memory than a laptop.
- **Several daemons on one machine.** Rootful and rootless side by side.
- **Repeatable scripts.** `docker --context build-host ...` is explicit;
  `DOCKER_HOST` exported in one shell and not another is not.

Contexts replaced the habit of exporting `DOCKER_HOST` and `DOCKER_TLS_*`
variables. They store the same information under a name, in
`~/.docker/contexts`.

## How it works underneath

A context stores an endpoint definition: a host URL plus, for TLS, paths to
a CA certificate, a client certificate and a key. The CLI resolves which
context to use in this order: the `--context` flag, then `DOCKER_HOST` (which
overrides the selected context), then `DOCKER_CONTEXT`, then the current
context set by `docker context use`, then `default`.

An `ssh://` endpoint is not a special protocol. The CLI runs `ssh` to the
host and speaks the ordinary Docker API over the resulting connection to the
remote `/var/run/docker.sock`. Everything that makes SSH work — agent
forwarding, `~/.ssh/config`, `ControlMaster` for connection reuse — applies,
and no daemon port is exposed to the network.

Buildx builders are stored **per context**. A builder created while the
`remote` context is active is not visible from `default`. This surprises
people constantly; it is also the mechanism that lets one machine drive
several independent build environments.

## Basic example

```bash
docker context create build-host --docker "host=ssh://build@build01.example.com"
docker context ls
docker --context build-host info
docker context use build-host
```

```console include="captures/docker-advanced/context-ls.txt"
```

TLS instead of SSH, using the documented form:

```bash
docker context create my-context \
  --description "some description" \
  --docker "host=tcp://myserver:2376,ca=~/ca-file,cert=~/cert-file,key=~/key-file"
```

## Explanation

`--docker` takes a comma-separated set of keys: `host`, `ca`, `cert`, `key`,
`skip-tls-verify`, and `from` to copy another context's endpoint. There is no
separate flag per field.

The SSH form needs nothing on the server except a daemon and an account with
access to the socket — which, on a rootful daemon, means root-equivalent
access. Prefer SSH over exposing `tcp://`: an unauthenticated Docker API port
is a remote root shell, and that has been the root cause of many
cryptomining incidents.

`docker context ls` marks the current context with an asterisk. Get in the
habit of reading it before destructive commands, or put it in your shell
prompt.

## Common patterns

### Never expose tcp:// without TLS

If a remote daemon must listen on a port, it needs `tlsverify` with a client
certificate, and a firewall. SSH avoids the whole problem; use it unless
something makes it impossible.

### One context per environment, with obvious names

`dev-laptop`, `build01`, `rootless`. A context named `prod` should make you
pause before typing anything destructive.

### Use `--context` in scripts and CI

```bash
docker --context build-host buildx build --target api -t tasklane-api:0.1.0 examples/app
```

Explicit beats ambient. A script that relies on the current context does
something different depending on who runs it.

### Remote builds without a remote context

For builds specifically, the buildx `remote` driver talks to a buildkitd
directly and does not need daemon access at all — a smaller privilege grant
than a whole daemon. See
[BuildKit and buildx](buildkit-and-buildx.md#buildx-drivers).

### Contexts and Compose

Compose uses the current context like every other command, so
`docker --context build-host compose up -d` runs the stack on the remote
host. Bind mounts then refer to paths on the **remote** machine, which is the
most common source of confusion when moving a stack to a server.

## Production considerations

Context access is daemon access, and daemon access on a rootful host is root.
Treat the SSH accounts used for contexts as privileged accounts: keys with
passphrases, no shared logins, and an audit trail.

Latency matters more than bandwidth for the API, but bandwidth matters for
builds: the build context is uploaded to the remote daemon. A large context
over a slow link is painful; `.dockerignore` earns its keep here. See
[build context and .dockerignore](../docker-intermediate/build-context-and-dockerignore.md).

For teams, a shared remote builder is usually better done with the buildx
`remote` or `kubernetes` driver than by giving everyone a daemon context.

Kubernetes has its own equivalent with kubeconfig contexts, and the two are
independent. Switching a Docker context does not change your cluster; see
[kubeconfig and contexts](../k8s-beginner/kubeconfig-and-contexts.md).

## Security considerations

- **`tcp://` without TLS is remote code execution as root.** Never, not even
  "just for a minute", not even on a private network.
- `skip-tls-verify` defeats the purpose of TLS. It belongs in a lab.
- SSH agent forwarding into a build or a remote host exposes your agent to
  that host. Prefer per-host keys.
- `DOCKER_HOST` in the environment overrides your selected context silently.
  A stale export in `.bashrc` can point a "local" command at a server.
- Contexts do not carry credentials for registries; those live in
  `~/.docker/config.json` on the machine running the CLI, and the *daemon*
  pulls with them once the CLI passes the auth. Rotating them is a client
  operation.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot connect to the Docker daemon` after switching | Endpoint wrong or daemon down | `docker context inspect <name>`; try `ssh host docker info` |
| Commands hit the wrong host | `DOCKER_HOST` set in the environment | `unset DOCKER_HOST`; it overrides the context |
| Builders vanished | Builders are per context | `docker context use <the other one>`; `docker buildx ls` |
| SSH context very slow | New SSH connection per API call | `ControlMaster auto` and `ControlPersist` in `~/.ssh/config` |
| Bind mount is empty on a remote stack | Paths are resolved on the remote host | Copy the data, or use a volume |
| `permission denied` over SSH | Remote user not allowed on the socket | Add the user to the group, or use a rootless daemon |

## Common mistakes

- Exposing `tcp://0.0.0.0:2375` to make a remote context "easier".
- Forgetting which context is current before `docker system prune -a`.
- Assuming a remote context makes builds faster. It moves them; the context
  upload may eat the gain.
- Expecting a context switch to move images. Images live on the daemon you
  built them on.
- Leaving `DOCKER_HOST` exported from an old experiment.

## Related topics

- [BuildKit and buildx](buildkit-and-buildx.md)
- [Daemon configuration](daemon-configuration.md)
- [Rootless Docker](rootless-docker.md)
- [Docker CLI basics](../docker-beginner/docker-cli-basics.md)
- [Build context and .dockerignore](../docker-intermediate/build-context-and-dockerignore.md)
- [kubeconfig and contexts](../k8s-beginner/kubeconfig-and-contexts.md)
