---
title: Daemon configuration
description: What belongs in daemon.json on Engine 29, which options reload with SIGHUP, and the settings worth changing on a real host.
level: advanced
type: reference
status: current
versions: Docker Engine 29, Buildx 0.37
prerequisites:
  - docker-beginner/install-docker
---

## Overview

`dockerd` is configured from two places: command-line flags in the systemd
unit, and a JSON file. The file is `/etc/docker/daemon.json` on Linux and
`~/.config/docker/daemon.json` in rootless mode. Every option in the file has
a flag equivalent, and the documentation is explicit about mixing them: "The
Docker daemon fails to start if an option is duplicated between the file and
the flags, regardless of their value."

That failure mode — daemon refuses to start after a config change — is the
main risk of editing this file, so validate before restarting.

:::warning
Every key below is taken from the `dockerd` reference for Engine 29. Do not
copy option names from blog posts; several older keys have been renamed or
removed, and an unknown key prevents the daemon from starting.
:::

## A starting point

```json title="/etc/docker/daemon.json"
{
  "log-driver": "local",
  "log-opts": {
    "max-size": "20m",
    "max-file": "5"
  },
  "default-ulimits": {
    "nofile": { "Name": "nofile", "Soft": 64000, "Hard": 64000 }
  },
  "live-restore": true,
  "default-address-pools": [
    { "base": "172.30.0.0/16", "size": 24 }
  ],
  "builder": {
    "gc": {
      "enabled": true,
      "defaultReservedSpace": "10GB",
      "policy": [
        { "maxUsedSpace": "512MB", "keepDuration": "48h", "filter": ["type=source.local"] },
        { "reservedSpace": "10GB", "maxUsedSpace": "100GB", "keepDuration": "1440h" }
      ]
    }
  }
}
```

Validate and apply:

```bash
python3 -m json.tool /etc/docker/daemon.json > /dev/null
sudo systemctl reload docker     # SIGHUP: reloadable options only
sudo systemctl restart docker    # everything else
docker info
```

## What each of those does

**`log-driver` and `log-opts`.** The single most valuable change on any host:
rotation. See [logging drivers](logging-drivers.md). Applies to newly created
containers only.

**`default-ulimits`.** Engine 29 inherits containerd's change to a **1024**
open-file soft limit for all containers, down from 1048576. Services that
open many sockets need this raised here or per container with `--ulimit`.

**`live-restore`.** Containers keep running while the daemon restarts. It is
what makes a daemon upgrade a non-event for running workloads. Incompatible
with Swarm mode, and it does not cover every daemon change.

**`default-address-pools`.** Docker's default bridge networks come from
172.17–172.31. On a corporate network that overlaps real routes, and the
symptom is "some internal hosts are unreachable from containers". Set a pool
you own.

**`builder.gc`.** Bounds BuildKit's state on the host. Without it, build
cache grows until the disk is full. `defaultReservedSpace`, `maxUsedSpace`,
`minFreeSpace`, `keepDuration` and `filter` are the documented knobs.

## Reloadable options

On Linux the daemon reloads configuration on **SIGHUP**
(`systemctl reload docker`). The documented reloadable set is:

`debug`, `labels`, `live-restore`, `max-concurrent-downloads`,
`max-concurrent-uploads`, `max-download-attempts`, `default-runtime`,
`runtimes`, `authorization-plugin`, `insecure-registries`,
`registry-mirrors`, `shutdown-timeout`, `features`.

Everything else needs a restart. In particular, changing the storage driver,
the data root, `userns-remap` or the firewall backend restarts containers.

## Options worth knowing on Engine 29

| Key | Why it matters |
|---|---|
| `features.containerd-snapshotter` | The containerd image store. Default on **fresh** installs of Engine 29, not on upgraded daemons. Needed for multi-platform builds and cache export on the default builder |
| `firewall-backend` | `nftables` is **experimental** in Engine 29. Under nftables, Docker does not enable IP forwarding on the host, and startup fails if forwarding is needed |
| `registry-mirrors` | A pull-through cache for Docker Hub; the cheapest fix for rate limits |
| `insecure-registries` | Disables TLS verification for the listed hosts. Lab only |
| `userns-remap` | Container user namespaces with a root daemon. Note the containerd image store does not apply to daemons using it |
| `data-root` | Move `/var/lib/docker` to a dedicated filesystem so a full disk does not take the OS with it |
| `default-runtime`, `runtimes` | Register alternative runtimes such as gVisor or Kata |
| `no-new-privileges` | Daemon-wide default for the `no-new-privileges` security option |
| `default-cgroupns-mode` | `private` by default; controls whether containers see the host cgroup hierarchy |
| `shutdown-timeout` | How long the daemon waits for containers to stop on shutdown |
| `default-shm-size` | 64 MB by default; some databases and browsers need more |
| `proxies` | `http-proxy`, `https-proxy`, `no-proxy` for the daemon's own pulls |

Other Engine 29 behaviour changes that configuration cannot undo: Docker
Content Trust was removed from the CLI, environment variables from legacy
links are no longer injected (the escape hatch is
`DOCKER_KEEP_DEPRECATED_LEGACY_LINKS_ENV_VARS=1`), `docker image ls` shows a
collapsed tree view and hides untagged images unless `--all` is passed, and
macvlan/ipvlan-l2 networks get no default gateway unless `--gateway` is set.

## Client configuration is a different file

`~/.docker/config.json` belongs to the CLI, not the daemon. It holds
registry credentials (or credential helper names), CLI plugin settings and
aliases. Changing it never requires a daemon restart. See
[registries](registries.md).

## Inspecting the running configuration

```bash
docker info
docker info --format '{{ .LoggingDriver }} {{ .CgroupDriver }} {{ .CgroupVersion }}'
docker system df -v
```

```console include="captures/docker-advanced/system-df.txt"
```

`docker info` reports the *effective* configuration, which is what you want
during an incident: it reflects flags, file and defaults together, and it
prints warnings about missing kernel features.

## Production considerations

Manage the file with configuration management, and validate JSON in CI. A
trailing comma is enough to prevent the daemon from starting, and on a node
that is a full outage rather than a warning.

Keep the daemon's storage on its own filesystem. Images, containers, volumes
and build cache all live under `data-root`, and they grow. Combine with
`builder.gc` and log rotation.

Roll changes like any other production change: one node, observe, then the
rest. `live-restore` reduces the blast radius of a daemon restart but does
not eliminate it.

Prefer the file over unit-file flags. Mixing them is how you get a daemon
that refuses to start with a message about a duplicated option, usually while
someone is waiting.

## Common mistakes

- Editing the file and running `systemctl reload` for an option that is not
  reloadable, then assuming it took effect. Check `docker info`.
- Setting both a flag in the unit and the same key in the file. The daemon
  will not start.
- Copying a `daemon.json` from an old tutorial with removed keys.
- Editing `/etc/docker/daemon.json` on a rootless installation, where the
  file is `~/.config/docker/daemon.json`.
- Adding `insecure-registries` to work around a certificate problem and
  leaving it there.
- Assuming the containerd image store is enabled everywhere. It is the
  default for fresh Engine 29 installs only.

## Related topics

- [Logging drivers](logging-drivers.md)
- [Resource limits](resource-limits.md)
- [Rootless Docker](rootless-docker.md)
- [Docker contexts](docker-contexts.md)
- [Registries](registries.md)
- [Install Docker](../docker-beginner/install-docker.md)
