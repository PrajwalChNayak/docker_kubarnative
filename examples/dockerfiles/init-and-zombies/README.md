# init-and-zombies — who reaps orphaned processes?

When a process dies, its parent has to call `wait()` to collect the exit
status. Until that happens the dead process stays in the process table as a
zombie (state `Z`). If a parent exits first, its children are re-parented to
PID 1, so PID 1 inherits the reaping duty. A normal application process makes
a poor PID 1: it never expected to adopt anyone's children.

`spawner.sh` abandons a `sleep` every second, which the kernel re-parents to
PID 1.

| File | PID 1 | Result |
|---|---|---|
| `Dockerfile.noinit` | `/app/spawner.sh` | zombies accumulate |
| `Dockerfile.tini` | `/sbin/tini` | zombies are reaped immediately |

`docker run --init` gives you the same thing without changing the image. The
docs say: "The default init process used is the first `docker-init` executable
found in the system path of the Docker daemon process", and that binary "is
backed by tini". The daemon mounts it into the container and runs your
entrypoint as its child.

## Build

```bash
docker build -f examples/dockerfiles/init-and-zombies/Dockerfile.noinit -t initdemo-noinit:0.1.0 examples/dockerfiles/init-and-zombies
docker build -f examples/dockerfiles/init-and-zombies/Dockerfile.tini   -t initdemo-tini:0.1.0   examples/dockerfiles/init-and-zombies
```

## Observe

```bash
docker run -d --name z-noinit initdemo-noinit:0.1.0
docker run -d --name z-tini   initdemo-tini:0.1.0
docker run -d --name z-init --init initdemo-noinit:0.1.0
sleep 20
docker exec z-noinit ps -o pid,ppid,stat,args
docker exec z-tini   ps -o pid,ppid,stat,args
docker exec z-init   ps -o pid,ppid,stat,args
docker rm -f z-noinit z-tini z-init
```

In `z-noinit` you see a growing list of `sleep` processes in state `Z`. In
`z-tini` and `z-init` the list stays empty, and PID 1 is `tini` or
`docker-init` instead of the script.

## When you need an init

- The container runs something that forks and does not reap: a shell script
  that backgrounds jobs, a process supervisor, `npm start`-style wrappers.
- The container's main process is a shell that starts the real program in the
  background.

You do **not** need one for a single, well-behaved process that handles
SIGTERM and spawns no children — that describes `tasklane-api` and
`tasklane-worker`, which is why `examples/app/Dockerfile` has no init.

In Kubernetes there is no `--init` flag. Either bake tini into the image, or
set `shareProcessNamespace: true` on the Pod, which makes the pause container
PID 1 for the whole Pod and lets it reap.

## Notes

- Zombies consume a PID and a small kernel structure each. They are harmless
  in small numbers and fatal when you hit the PID limit
  (`--pids-limit`, or the cgroup `pids.max` Kubernetes sets).
- Both images run as UID 65534.
