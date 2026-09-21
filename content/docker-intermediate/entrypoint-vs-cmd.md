---
title: ENTRYPOINT vs CMD
description: The interaction matrix, why the exec form matters, and how to design an image that behaves like a command-line tool.
level: intermediate
type: concept
status: current
versions: Docker Engine 29, Compose v5
prerequisites:
  - docker-intermediate/dockerfile-instructions
---

## Overview

`ENTRYPOINT` and `CMD` together define the process a container starts. The
short version: `ENTRYPOINT` is the executable, `CMD` is the default arguments,
arguments given to `docker run` replace `CMD`, and `--entrypoint` replaces
`ENTRYPOINT`. Both come in a shell form and an exec form, and the difference
between those forms decides whether your process can be shut down cleanly.

## Why it exists and when to use it

Two instructions exist because images play two roles. Some images *are* a
command (`docker run myimage --verbose`); some are a service with a fixed
start-up and a configurable tail. `ENTRYPOINT` plus `CMD` covers both without a
wrapper script: the entrypoint fixes the program, the CMD supplies defaults a
user can override.

Kubernetes uses the same two fields under different names: `command` in a
container spec overrides `ENTRYPOINT`, and `args` overrides `CMD`. Getting the
image right means manifests stay short.

## How it works underneath

The image config holds two string arrays, `Entrypoint` and `Cmd`. At start,
the runtime concatenates entrypoint + cmd and `execve`s the result in the
container's namespaces. Nothing is interpreted unless the array itself names a
shell.

The shell form wraps the string: `CMD npm start` is stored as
`["/bin/sh", "-c", "npm start"]` (or whatever `SHELL` was set to). So the shell
is the process, your program is its child, and the shell is what the runtime
signals.

The documented interaction matrix:

|  | No ENTRYPOINT | `ENTRYPOINT exec_entry p1_entry` (shell form) | `ENTRYPOINT ["exec_entry", "p1_entry"]` (exec form) |
|---|---|---|---|
| **No CMD** | error, not allowed | `/bin/sh -c exec_entry p1_entry` | `exec_entry p1_entry` |
| **`CMD ["exec_cmd", "p1_cmd"]`** | `exec_cmd p1_cmd` | `/bin/sh -c exec_entry p1_entry` | `exec_entry p1_entry exec_cmd p1_cmd` |
| **`CMD exec_cmd p1_cmd`** | `/bin/sh -c exec_cmd p1_cmd` | `/bin/sh -c exec_entry p1_entry` | `exec_entry p1_entry /bin/sh -c exec_cmd p1_cmd` |

Read the middle column carefully: a shell-form `ENTRYPOINT` **ignores `CMD`
entirely**, and ignores arguments passed to `docker run`. The docs are explicit
that it "starts your `ENTRYPOINT` as a subcommand of `/bin/sh -c`, which does
not pass signals", so "the executable will not be the container's `PID 1`, and
will not receive Unix signals".

Two more rules: only the last `ENTRYPOINT` and the last `CMD` in a Dockerfile
take effect, and setting `ENTRYPOINT` in a child image resets a `CMD` inherited
from the base to empty.

## Basic example

```dockerfile include="examples/app/Dockerfile" lines="46-50"
```

The container runs `/api` with no arguments and serves HTTP. Because the
binary also implements subcommands, the same image runs the migration job:

```bash
docker run --rm tasklane-api:0.1.0 migrate
```

`migrate` replaces the (empty) `CMD` and is appended to the entrypoint. Compose
does the same thing with `command`:

```yaml include="examples/compose/compose.yaml" lines="47-53"
```

## Explanation

The image is a *command*: `/api` is fixed, everything after it is user input.
That is why `docker run tasklane-api:0.1.0 migrate` works and
`docker run tasklane-api:0.1.0 /bin/sh` fails — there is no shell, and even if
there were, the entrypoint would prepend `/api`.

If you want a service with overridable arguments, add a `CMD`:

```dockerfile title="entrypoint-cmd.Dockerfile" fragment
ENTRYPOINT ["/api"]
CMD ["--listen", ":8080"]
```

Now `docker run image` uses the defaults, and `docker run image --listen :9090`
overrides them while keeping `/api`.

To run something else entirely, override the entrypoint:

```bash
docker run --rm --entrypoint /api tasklane-api:0.1.0 healthcheck
```

In Kubernetes:

```yaml title="k8s-command-args.yaml" fragment
# container spec: command overrides ENTRYPOINT, args overrides CMD
command: ["/api"]
args: ["migrate"]
```

## Common patterns

**Service image.** `ENTRYPOINT ["/app"]`, no `CMD`, or `CMD` holding default
flags. Arguments stay overridable, the binary is PID 1.

**Tool image.** `ENTRYPOINT ["/usr/local/bin/mytool"]` and
`CMD ["--help"]`, so a bare `docker run` prints usage.

**Entrypoint script that ends in `exec`.** When start-up really needs shell
logic (render a config template, wait for a socket, fix ownership), use a
script — and make its last line `exec "$@"` so the real process replaces the
shell and becomes PID 1:

```dockerfile title="entrypoint-script.Dockerfile" fragment
COPY --chmod=0755 <<'EOF' /entrypoint.sh
#!/bin/sh
set -e
envsubst < /etc/app/config.tmpl > /etc/app/config.yaml
exec "$@"
EOF
ENTRYPOINT ["/entrypoint.sh"]
CMD ["/app", "--config", "/etc/app/config.yaml"]
```

**Multi-command binary.** One binary with `serve`, `migrate`, `healthcheck`
subcommands, as Tasklane does, avoids extra images and gives the
`HEALTHCHECK` something to call in a shell-less image.

**Never `CMD` alone for a service that takes arguments.** With no
`ENTRYPOINT`, any argument the user passes replaces the whole command, which
is usually not what they meant.

## Production considerations

Keep the exec form everywhere. It is also what BuildKit's
`JSONArgsRecommended` check enforces; with `# check=error=true` in the
Dockerfile, a shell-form `CMD` or `ENTRYPOINT` fails the build. The signal
demo in `examples/dockerfiles/signal-forms/` has to skip that check explicitly
to keep its broken example buildable.

Kubernetes ignores `HEALTHCHECK` but honours `ENTRYPOINT`/`CMD` as
`command`/`args`. Leave the image's own entrypoint in place and override only
what a specific workload needs; a Deployment that repeats the full command
silently stops tracking image changes.

If the process is a shell script that supervises other processes, you also need
an init — see [PID 1 and signals](pid1-signals-graceful-shutdown.md).

## Security considerations

- `--entrypoint` lets anyone who can run the image start any binary in it.
  That is another argument for a base image with nothing else in it.
- Shell-form instructions interpolate environment variables at runtime, which
  means a hostile `ENV` value can change what the shell executes. Exec form
  passes arguments verbatim to `execve` with no parsing.
- An entrypoint script running as root that drops privileges with `su`,
  `gosu` or `setpriv` is a common pattern; prefer `USER` in the Dockerfile so
  no root step exists at all.
- Wrapper scripts that end with `"$@"` without `exec` leave a shell running as
  PID 1 with your process as a child — a signal-handling bug, and one more
  process in the container.

## Troubleshooting

**`docker run image arg` ignores `arg`.** The entrypoint is shell form. Convert
it to exec form.

**The container ignores `docker stop` for ten seconds.** PID 1 is a shell.
Same fix; see the demo in `examples/dockerfiles/signal-forms/`.

**`docker run image /bin/sh` fails with "no such file or directory".** Either
there is no shell in the image, or the entrypoint prepended itself. Use
`--entrypoint /bin/sh` — and if that still fails, the image is distroless.

**Environment variables are not expanded.** Exec form does not invoke a shell.
Either expand inside your program, or use
`ENTRYPOINT ["/bin/sh", "-c", "exec /app --flag \"$VAR\""]`.

**Inspect what the image actually sets:**

```bash
docker image inspect --format '{{json .Config.Entrypoint}} {{json .Config.Cmd}}' tasklane-api:0.1.0
```

## Common mistakes

- Shell-form `ENTRYPOINT`, which breaks arguments *and* signals at once.
- Setting `ENTRYPOINT` in a derived image and forgetting that it clears the
  inherited `CMD`.
- Using `CMD ["sh", "-c", "python app.py"]` where `CMD ["python", "app.py"]`
  would do, adding a shell as PID 1 for no reason.
- An entrypoint script ending in `"$@"` instead of `exec "$@"`.
- Overriding `command` in Kubernetes to repeat what the image already does,
  then forgetting to update it when the image changes.
- Expecting `docker run --entrypoint` to accept arguments in the same
  position: `--entrypoint` takes the executable, arguments still go after the
  image name.

## Related topics

- [Every Dockerfile instruction](dockerfile-instructions.md)
- [PID 1, signals and graceful shutdown](pid1-signals-graceful-shutdown.md)
- [Healthchecks](healthchecks.md)
- [Container lifecycle](../docker-beginner/container-lifecycle.md)
- [Pod lifecycle and termination](../k8s-intermediate/pod-lifecycle-and-termination.md)
