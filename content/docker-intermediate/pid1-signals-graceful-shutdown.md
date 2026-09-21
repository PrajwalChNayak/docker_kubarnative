---
title: PID 1, signals and graceful shutdown
description: Why PID 1 ignores SIGTERM by default, what an init process actually does, and how to make containers stop in under a second.
level: intermediate
type: concept
status: current
versions: Docker Engine 29, Compose v5
prerequisites:
  - docker-intermediate/entrypoint-vs-cmd
  - docker-beginner/container-lifecycle
---

## Overview

`docker stop` sends SIGTERM to PID 1 of the container, waits for the stop
timeout (10 seconds by default), then sends SIGKILL. Kubernetes does the same
thing with `terminationGracePeriodSeconds` (30 by default). Whether that is a
clean shutdown or a data-losing kill depends on two things inside the
container: which process is PID 1, and whether it installed a signal handler.

## Why it exists and when to use it

A container is a process tree in its own PID namespace, and the first process
in a PID namespace is PID 1. The kernel treats PID 1 specially: it is the init
process for that namespace, so the usual default actions for signals do not
apply to it. A process that would normally die on SIGTERM survives it if it is
PID 1 and has no handler installed.

That single rule explains the two most common container shutdown bugs:
ten-second `docker stop`s, and connections cut mid-request during a rolling
update.

## How it works underneath

Three mechanisms interact.

**Signal delivery to PID 1.** For a normal process, a signal with no handler
takes its default action (terminate, for SIGTERM). For PID 1, the kernel
delivers only signals for which a handler is installed. SIGKILL and SIGSTOP
cannot be caught by anyone, so they always work — which is why the timeout
path always succeeds and always loses in-flight work.

**Orphan re-parenting and reaping.** When a process exits, its parent must
call `wait()` to collect the status; until then the entry stays as a zombie.
When a parent exits first, its children are re-parented to PID 1, so PID 1
inherits the duty of reaping them. Application processes do not expect to
adopt anyone's children, so zombies accumulate and eventually exhaust the PID
limit.

**The stop sequence.** `docker stop` sends the image's `STOPSIGNAL`
(SIGTERM unless changed, overridable per container with `--stop-signal`),
waits `--stop-timeout`/`--time` seconds, then SIGKILLs. Compose calls the wait
`stop_grace_period`, default 10 seconds. Kubernetes runs preStop hooks first,
then SIGTERM, then waits the grace period, then SIGKILL.

## Basic example

Two images running the same script, one with a shell-form entrypoint and one
with the exec form:

```dockerfile include="examples/dockerfiles/signal-forms/Dockerfile.shell"
```

```dockerfile include="examples/dockerfiles/signal-forms/Dockerfile.exec"
```

Timing the stops shows the difference:

```bash
docker build -f examples/dockerfiles/signal-forms/Dockerfile.shell -t sigdemo-shell:0.1.0 examples/dockerfiles/signal-forms
docker build -f examples/dockerfiles/signal-forms/Dockerfile.exec -t sigdemo-exec:0.1.0 examples/dockerfiles/signal-forms
docker run -d --name sig-shell sigdemo-shell:0.1.0
docker run -d --name sig-exec sigdemo-exec:0.1.0
time docker stop sig-shell
time docker stop sig-exec
```

Shell form, killed after the timeout:

```console include="captures/docker-intermediate/signal-stop-shell.txt"
```

Exec form, which handles the signal:

```console include="captures/docker-intermediate/signal-stop-exec.txt"
```

## Explanation

In the shell-form image, PID 1 is `/bin/sh -c 'echo ...; /app/sleeper.sh'`.
The shell has no SIGTERM handler, so the kernel discards the signal; the script
is a child and is never signalled at all. Ten seconds later SIGKILL ends both,
and the container exits with code 137 (128 + 9).

In the exec-form image, the script itself is PID 1, `trap ... TERM` installs a
handler, and the container exits with code 0 almost immediately.

One subtlety the demo deliberately works around: with a *single simple
command*, `ash` and `dash` replace themselves with it (`exec`), so the script
does become PID 1 and the bug disappears. `bash` in many configurations does
not. "Shell form sometimes works" is exactly why the rule is "always exec
form" rather than "usually".

The graceful shutdown that follows the signal is application work. Tasklane's
API does it properly:

```go include="examples/app/cmd/api/main.go" lines="56-59"
```

and on shutdown fails readiness first, waits, then drains:

```go include="examples/app/cmd/api/main.go" lines="157-169"
```

Failing readiness before closing listeners is the part everybody forgets. Load
balancers and Kubernetes EndpointSlices take a moment to notice that a backend
is going away; if you close the listener immediately, requests routed during
that window are refused. `SHUTDOWN_DELAY_SECONDS` is that moment, and it must
be shorter than the grace period.

The worker does the equivalent for jobs: on SIGTERM it hands an in-flight task
back to the queue instead of leaving it marked as processing.

## Common patterns

**Exec-form entrypoint, signal handler in the application.** The default.
Nothing else is needed for a single process that spawns no children.

**`exec "$@"` at the end of a wrapper script.** Keeps the shell out of the
final process tree.

**An init when you fork.** `tini` baked into the image, or `docker run
--init`, which the daemon implements with its bundled `docker-init` binary,
"backed by tini". Both make PID 1 a process whose entire job is forwarding
signals and reaping orphans:

```dockerfile include="examples/dockerfiles/init-and-zombies/Dockerfile.tini"
```

**`STOPSIGNAL` for programs with other conventions.** nginx reloads on SIGHUP
and shuts down gracefully on SIGQUIT; `STOPSIGNAL SIGQUIT` makes `docker stop`
do the right thing without a wrapper.

**A stop timeout that matches reality.** If draining takes 45 seconds, set
`--stop-timeout 60`, Compose `stop_grace_period: 60s`, or Kubernetes
`terminationGracePeriodSeconds: 60`. A grace period shorter than the drain is
a scheduled data loss.

## Production considerations

Shutdown is part of the availability budget. Every rolling update, node drain,
autoscaler scale-in and spot reclamation runs this code path. A service that
loses requests on SIGTERM loses them dozens of times a day.

Budget the numbers so they nest: readiness-fail delay < drain timeout < grace
period. Tasklane uses `SHUTDOWN_DELAY_SECONDS=1` in the local Compose stack
and a 15-second HTTP shutdown timeout inside the process; production values
are larger, and the Kubernetes grace period must exceed their sum.

Watch exit codes as a health signal: 143 (128 + SIGTERM) means the process
died *from* SIGTERM without handling it, 137 (128 + SIGKILL) means it was
killed after the timeout. A clean handler produces 0.

Jobs and consumers need more than HTTP draining: stop claiming new work at the
first signal, finish or release what is in flight, commit offsets, then exit.

## Security considerations

- A PID-limit exhaustion caused by unreaped zombies is a denial of service
  that looks like a mysterious "cannot fork" error. Set `--pids-limit` (or
  the Kubernetes equivalent) *and* reap properly.
- `--init` adds a small, well-audited binary as PID 1 rather than a full
  process supervisor. Resist the temptation to run `systemd` or `supervisord`
  in a container: both expand the attack surface and hide failures from the
  orchestrator.
- SIGKILL cannot be trapped, so a compromised process cannot refuse to die —
  as long as the orchestrator's timeout is enforced. Never disable it.
- Signal handling bugs are how "graceful shutdown" silently becomes "kill",
  which is how audit logs and buffered telemetry get lost exactly when they
  matter.

## Troubleshooting

**`docker stop` always takes the full timeout.** PID 1 is not handling
SIGTERM. Check what PID 1 is:

```bash
docker exec <container> ps -o pid,ppid,stat,args
docker inspect --format '{{json .Config.Entrypoint}} {{json .Config.Cmd}}' <image>
```

**Exit code 137 after a stop.** The container was SIGKILLed — either the
timeout expired or the kernel OOM killer intervened. `docker inspect --format
'{{.State.OOMKilled}}'` tells them apart.

**Zombie processes accumulate.** PID 1 is not reaping. Compare the two images
in `examples/dockerfiles/init-and-zombies/`:

```console include="captures/docker-intermediate/init-ps-noinit.txt"
```

```console include="captures/docker-intermediate/init-ps-tini.txt"
```

**Ctrl-C behaves differently from `docker stop`.** Ctrl-C sends SIGINT
directly to the process; `STOPSIGNAL` only affects the stop path.

**The process handles SIGTERM but still loses requests.** It is closing
listeners before load balancers stop sending traffic. Fail readiness first,
then wait, then drain.

## Common mistakes

- Shell-form `ENTRYPOINT` or `CMD`.
- A wrapper script that runs the application as a background job and then
  `wait`s, without forwarding signals.
- Running a process supervisor in a container to get "systemd-like"
  behaviour, and inheriting its PID 1 semantics without its correctness.
- Assuming Kubernetes needs no init because it has a pause container — it
  only shares PID 1 with your container if `shareProcessNamespace: true`.
- Setting a grace period shorter than the drain, so the graceful path never
  completes.
- Trapping SIGTERM in a shell that is blocked in a foreground `sleep`: the
  trap only runs between commands, so use `sleep 1 & wait $!`.

## Related topics

- [ENTRYPOINT vs CMD](entrypoint-vs-cmd.md)
- [Healthchecks](healthchecks.md)
- [Container lifecycle](../docker-beginner/container-lifecycle.md)
- [Compose dependencies and healthchecks](compose-dependencies-and-healthchecks.md)
- [Pod lifecycle and termination](../k8s-intermediate/pod-lifecycle-and-termination.md)
- [Probes](../k8s-intermediate/probes.md)
