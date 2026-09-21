---
title: Running containers
description: What docker run actually does, from the CLI request to the daemon down to runc, namespaces, cgroups and the veth pair on the bridge.
level: beginner
type: concept
status: current
versions: Docker Engine 29
prerequisites:
  - docker-beginner/docker-cli-basics
  - foundations/linux-namespaces
---

## Overview

`docker run` looks like one action and is really about eight. It resolves an
image reference, pulls what is missing, prepares a filesystem, writes a
container configuration, asks a runtime to create a process in new kernel
namespaces with a cgroup attached, wires a network interface into it, and
starts it.

Knowing the order matters because every failure mode you will meet in Part L
lives at one of those steps: a bad reference fails at resolve, a rate limit or
typo fails at pull, a missing binary fails at create, a wrong `ENTRYPOINT`
fails at exec, and a busy host port fails at network attach.

```bash
docker run --rm alpine:3.22 echo hello
```

## Why it exists and when to use it

`docker run` is `docker create` plus `docker start` plus, unless you detach,
an attach to the container's streams. It exists to make the common case one
command.

Use it directly for one-off commands, for exploring an image, and for the
first stage of a project — the stage this part of the handbook is about. Stop
using it as soon as you have more than one container that must start in a
particular order or share configuration: that is what
[Compose](../docker-intermediate/compose-fundamentals.md) is for, and past
that, Kubernetes.

There is no state in a `docker run` command line. If you need to change a
flag, you delete the container and create a new one. Systems built on
`docker run` drift, because the only record of how a container was created is
your shell history.

## How it works underneath

Step by step, for `docker run --rm -p 8080:8080 tasklane-api:0.1.0`:

1. **The CLI builds an API request.** It does not create anything itself. It
   posts to the Engine API endpoint of the current context: `POST
   /containers/create`, then `POST /containers/{id}/start`. Everything below
   happens inside `dockerd`.
2. **Reference resolution.** `tasklane-api:0.1.0` expands to
   `docker.io/library/...` only if it has no registry prefix and no local
   match. A local image satisfies the default pull policy `missing`;
   `--pull always` forces a registry round trip and `--pull never` fails if
   the image is absent.
3. **Pull, if needed.** The daemon fetches the manifest for your platform,
   then the missing layer blobs. Layers already present are reused — that is
   why the second `docker run` of the same image starts immediately. With the
   containerd image store (the default on fresh Engine 29 installs), blobs
   land in containerd's content store.
4. **Snapshot.** The image's read-only layers are unpacked into a snapshotter
   (overlayfs on Linux). The daemon then creates a new writable snapshot for
   this container and prepares a mount of image layers plus that writable
   layer. This is why containers start in milliseconds: nothing is copied.
5. **Container configuration.** The daemon stores your flags as container
   config and translates them into an OCI runtime specification: the root
   filesystem path, the command, environment, mounts, namespace list, cgroup
   limits, capability set, seccomp profile and so on.
6. **Runtime create.** The daemon asks containerd to create a task. containerd
   starts a shim (`containerd-shim-runc-v2`) which invokes `runc create`.
   `runc` applies the OCI spec: it creates new **namespaces** (mount, PID,
   UTS, IPC, network; user namespaces only if configured), attaches the
   process to a **cgroup v2** directory carrying `--memory`, `--cpus` and
   `--pids-limit`, pivots to the prepared root filesystem, drops capabilities,
   applies seccomp and AppArmor, and stops just before exec.
7. **Network attach.** The daemon's networking layer creates a **veth pair**:
   one end becomes `eth0` inside the container's network namespace, the other
   is attached to the bridge for the chosen network (`docker0` for the default
   bridge, `br-<id>` for a user-defined one). IPAM assigns an address from the
   network's subnet, and the daemon programs packet-filtering rules —
   MASQUERADE so outbound traffic leaves with the host's address, and a DNAT
   rule for each published port. See
   [Publishing ports](publishing-ports.md#how-it-works-underneath).
8. **Start.** `runc start` lets the container's PID 1 `execve` your command.
   `runc` itself exits; the shim stays as the parent so containers survive a
   daemon restart. The daemon streams stdout and stderr into the configured
   logging driver.

`docker events` shows the daemon's own view of this sequence:

```bash
docker run --rm --name events-demo alpine:3.22 true
docker events --since 1m --filter container=events-demo --format '{{.Time}} {{.Type}} {{.Action}}'
```

```console include="captures/docker-beginner/run-events.txt"
```

:::note Docker Desktop adds a VM
On macOS and Windows every step above happens inside a Linux VM. The CLI on
your host talks to the daemon in that VM, published ports are forwarded from
the host into it, and bind mounts cross a file-sharing boundary. The mental
model is unchanged; the performance characteristics are not.
:::

## Basic example

```bash
docker run --rm alpine:3.22 id
docker run --rm alpine:3.22 cat /etc/os-release
docker run --rm alpine:3.22 sh -c 'hostname; ls /'
```

```console include="captures/docker-beginner/run-alpine.txt"
```

Three separate containers ran and were deleted. Each got its own hostname (the
UTS namespace), its own root filesystem from the image (the mount namespace),
and its own process tree in which the command is PID 1 (the PID namespace).

## Explanation

The flags you will use in nearly every `docker run`:

| Flag | Effect |
|---|---|
| `--name` | A stable name. Without it the daemon invents one |
| `-d` | Detach: print the ID and return. Without it the CLI attaches to the streams |
| `--rm` | Delete the container and its anonymous volumes when it exits |
| `-it` | Interactive session: keep stdin open and allocate a TTY |
| `-e` / `--env-file` | [Environment variables](environment-variables.md) |
| `-p` | [Publish a port](publishing-ports.md) |
| `-v` / `--mount` | [Volumes and bind mounts](volumes-and-bind-mounts-basics.md) |
| `--network` | Which network to attach to |
| `--restart` | [Restart policy](container-lifecycle.md#restart-policies) |
| `--pull` | `missing` (default), `always` or `never` |
| `--platform` | Pick one platform out of a multi-platform image |
| `--memory`, `--cpus` | cgroup limits |
| `--read-only`, `--cap-drop`, `--security-opt` | Hardening, covered in Part E |

Two ideas trip people up early.

**The command replaces `CMD`, not `ENTRYPOINT`.** Anything after the image
name becomes the container's command. If the image has an `ENTRYPOINT`, your
words are passed to it as arguments. That is why
`docker run tasklane-api:0.1.0 migrate` runs the API binary's `migrate`
subcommand rather than a program called `migrate`. Part C covers
[ENTRYPOINT vs CMD](../docker-intermediate/entrypoint-vs-cmd.md).

**A container lives exactly as long as its PID 1.** There is no such thing as
a container that is "running but idle" with nothing inside it. `alpine:3.22`
with no command exits immediately because its default command ends. Servers
stay up because their process does not return.

## Common patterns

**Throwaway shell in an image**

```bash
docker run --rm -it alpine:3.22 sh
```

**One-off command against a network**

```bash
docker run --rm --network tasklane-net busybox:1.37-musl nslookup tasklane-db
```

**Long-running service**

```bash
docker run -d --name tasklane-api --restart unless-stopped -p 127.0.0.1:8088:8080 tasklane-api:0.1.0
```

**Run something as a different user**

```bash
docker run --rm --user 65534:65534 alpine:3.22 id
```

**Pin the platform on an Apple silicon or ARM machine**

```bash
docker run --rm --platform linux/amd64 alpine:3.22 uname -m
```

Emulated platforms are slow and occasionally subtly broken; see
[architecture mismatch](../troubleshooting/architecture-mismatch.md).

## Production considerations

`docker run` is a fine deployment mechanism for exactly one class of system:
a single host, where the flags live in a checked-in script or a systemd unit
and nothing scales. Beyond that:

- **Always pin the image.** A tag can be repointed at any time; a digest
  cannot. See [Images, tags and digests](images-tags-digests.md).
- **Always set a restart policy** for services, and remember it is not a
  scheduler: if the host is down, nothing restarts anywhere else.
- **Set limits.** Without `--memory` a runaway container can take the host
  down. With it, the kernel OOM-kills the container instead.
- **Publish deliberately**, ideally to `127.0.0.1` plus a reverse proxy.
- **Keep the command in version control.** A script like
  `examples/docker-run/tasklane-docker-run.sh` is auditable; shell history is
  not.

## Security considerations

- Anyone who can run `docker run` can become root on the host, because they
  can bind-mount the host filesystem or run `--privileged`. The daemon socket
  is the security boundary, not the container. See
  [The Docker socket is root](../docker-security/docker-socket-is-root.md).
- Containers run as the image's `USER`, which is root unless the image says
  otherwise. The Tasklane images declare `USER 65532:65532`.
- `--privileged` disables nearly every isolation feature at once: it grants
  all capabilities, relaxes the device cgroup and drops the default seccomp
  filter. Never use it to "make something work"; find the one capability or
  mount you actually need.
- `--network host` puts the container in the host's network namespace, so
  `-p` stops meaning anything and the container can reach anything the host
  can, including localhost-only services.
- Start from the hardening set used by the example script:
  `--read-only --cap-drop ALL --security-opt no-new-privileges:true`. Part E
  explains each one.

## Troubleshooting

| Symptom | Likely step that failed | First move |
|---|---|---|
| `pull access denied` / `manifest unknown` | Reference resolution | Check the registry, repository and tag spelling |
| `toomanyrequests` | Pull, Docker Hub rate limit | Authenticate; see [Pulling and pushing](pulling-and-pushing.md) |
| `exec ... no such file or directory` (exit 127) | Start | The binary or its interpreter is missing in the image |
| `exec format error` | Start | Wrong architecture; check `--platform` |
| Container exits immediately, code 0 | Start | The command ended. That is not an error |
| `port is already allocated` | Network attach | Another container or host process holds it |
| `OCI runtime create failed` | Runtime create | Usually a bad mount path, device or security option |

`docker ps -a` plus `docker logs` and `docker inspect --format '{{.State.ExitCode}}'`
answers most of these; see [Inspect, logs and exec](inspect-logs-exec.md).

## Common mistakes

- **Expecting `docker run` to update a container.** It always creates a new
  one. `docker start` restarts an existing container with its original config.
- **Putting flags after the image name**, where they become arguments to the
  process inside.
- **Using `-it` in scripts or CI.** There is no TTY there; use neither flag.
- **Assuming `--rm` removes the image.** It removes the container.
- **Relying on the default bridge network.** Containers on it have no DNS for
  each other. Create a user-defined network.
- **Believing a container is a VM.** No init system, no cron, no syslog, no
  second process unless you start one.

## Related topics

- [Container lifecycle](container-lifecycle.md)
- [Publishing ports](publishing-ports.md)
- [Environment variables](environment-variables.md)
- [Tasklane with docker run](tasklane-with-docker-run.md)
- [Linux namespaces](../foundations/linux-namespaces.md)
- [cgroups v2](../foundations/cgroups-v2.md)
- [The runtime stack](../foundations/runtime-stack.md)
- [Resource limits](../docker-advanced/resource-limits.md)
