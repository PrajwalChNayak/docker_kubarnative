# signal-forms — shell form swallows SIGTERM, exec form does not

Two images that run the same script. The only difference is the form of the
`ENTRYPOINT` instruction.

| File | ENTRYPOINT | PID 1 in the container |
|---|---|---|
| `Dockerfile.shell` | shell form | `/bin/sh -c ...` |
| `Dockerfile.exec` | exec form (JSON array) | `/app/sleeper.sh` |

Why it matters: the Linux kernel does not apply the *default* action of a
signal to PID 1. A process that is PID 1 and has installed no handler for
SIGTERM simply ignores it. `docker stop` sends SIGTERM, waits for the stop
timeout (10 seconds by default), then sends SIGKILL, which PID 1 cannot
ignore. So the shell-form container takes about ten seconds to stop and loses
whatever it had not flushed; the exec-form container stops in well under a
second.

## Build

```bash
docker build -f examples/dockerfiles/signal-forms/Dockerfile.shell -t sigdemo-shell:0.1.0 examples/dockerfiles/signal-forms
docker build -f examples/dockerfiles/signal-forms/Dockerfile.exec  -t sigdemo-exec:0.1.0  examples/dockerfiles/signal-forms
```

## Run and time the stop

```bash
docker run -d --name sig-shell sigdemo-shell:0.1.0
docker run -d --name sig-exec  sigdemo-exec:0.1.0
time docker stop sig-shell
time docker stop sig-exec
docker logs sig-exec
docker rm sig-shell sig-exec
```

`docker logs sig-exec` prints the "SIGTERM received" line. `docker logs
sig-shell` does not, because that process was killed, not asked to stop.

`docker inspect --format '{{.State.ExitCode}}'` tells the same story: 0 for the
exec-form container, 137 (128 + SIGKILL) for the shell-form one.

## Notes

- The shell-form entrypoint here is deliberately two commands separated by
  `;`. With a single simple command, some shells (`ash`, `dash`) replace
  themselves with it via `exec`, so the script *does* become PID 1 and the
  bug disappears. That inconsistency between base images is exactly why the
  exec form is the rule rather than a preference.
- If you must use the shell form, start the real process with `exec`:
  `ENTRYPOINT exec /app/sleeper.sh`. Then the shell is replaced and signals
  reach your process.
- The base image is pinned by multi-arch index digest. Re-resolve digests with
  `docker buildx imagetools inspect busybox:1.37-musl` before publishing.
- Both images run as UID 65534. Nothing here needs root.
