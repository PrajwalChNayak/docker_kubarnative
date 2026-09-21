---
title: Installing Docker
description: Install Docker Engine or Docker Desktop on Linux, macOS or Windows, understand the licence rules, and know what the docker group really grants.
level: beginner
type: tutorial
status: current
versions: Docker Engine 29
prerequisites:
  - foundations/what-containers-solve
---

## Overview

There are two different products with similar names. **Docker Engine** is the
daemon (`dockerd`) plus the `docker` CLI; it runs natively on Linux and is
free software. **Docker Desktop** is a commercial application for macOS,
Windows and Linux that ships a Linux virtual machine, Docker Engine inside it,
a GUI, and extras such as Kubernetes and Docker Scout.

On Linux you normally want Docker Engine. On macOS and Windows a Linux VM is
unavoidable — Linux containers need a Linux kernel — so the question is only
which product manages that VM.

This page installs Docker Engine 29 from Docker's own package repositories,
covers the licence rules for Docker Desktop, and finishes with the one
post-install step that people most often get wrong: adding yourself to the
`docker` group.

## Licence facts you need before you install

Docker Desktop is free for companies with **fewer than 250 employees AND less
than $10 million annual revenue**, and for personal use, education and
non-commercial open source. Everyone else needs a paid subscription.

That is a licensing question, not a technical one, and it applies to the
Desktop application — not to Docker Engine on Linux, which is unaffected.

Alternatives that run Linux containers on a developer machine include Docker
Engine on Linux, Podman, Colima and Rancher Desktop. Each has different
trade-offs in daemon architecture, VM management and CLI compatibility; Part D
compares them in [Podman and alternatives](../docker-advanced/podman-and-alternatives.md).

## Install

::::tabs
@tab Linux

Install **Docker Engine** from Docker's official repository. Distribution
packages named `docker.io` or `docker` are usually older and are maintained by
the distribution, not by Docker.

If the machine already has distribution packages such as `docker.io`,
`podman-docker`, `containerd`, `runc`, `docker-doc`, `docker-buildx` or an old
Compose package, remove them first; docs.docker.com gives a one-liner for that
on the Ubuntu install page.

Ubuntu 26.04 LTS, 24.04 LTS and 22.04 LTS are supported:

```bash title="install-docker-ubuntu.sh"
sudo apt update
sudo apt install ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update
sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Fedora (43 and 44 are supported):

```bash title="install-docker-fedora.sh"
sudo dnf config-manager addrepo --from-repofile https://download.docker.com/linux/fedora/docker-ce.repo
sudo dnf install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
```

The five packages matter: `docker-ce` is the daemon, `docker-ce-cli` the
client, `containerd.io` the container runtime the daemon delegates to, and the
two plugins add `docker buildx` and `docker compose`. Installing only
`docker-ce` leaves you without Compose.

Verify, then do the post-install step below:

```bash
sudo systemctl status docker
sudo docker run hello-world
```

@tab macOS

Docker Desktop is supported on the current and two previous major macOS
releases, and needs at least 4 GB of RAM. Download the disk image from
docs.docker.com and install it in the usual way, or from a script:

```bash title="install-docker-desktop-macos.sh"
sudo hdiutil attach Docker.dmg
sudo /Volumes/Docker/Docker.app/Contents/MacOS/install
sudo hdiutil detach /Volumes/Docker
```

On Apple silicon, Rosetta 2 is no longer strictly required, but some
command-line tools still need it for Darwin/AMD64 binaries. Install it with:

```bash
softwareupdate --install-rosetta
```

Docker Desktop's file sharing uses VirtioFS by default on macOS; the docs
state it "reduced the time taken to complete filesystem operations by up to
98%". Bind mounts still cross a VM boundary, so they remain slower than
container-native storage. See
[Volumes and bind mounts](volumes-and-bind-mounts-basics.md#production-considerations).

Other options on macOS, all of which also run a Linux VM: Colima, Rancher
Desktop and Podman Desktop. Check the Docker Desktop licence rules above
before choosing.

@tab Windows (WSL 2)

Two supported shapes, with different trade-offs.

**Docker Desktop with the WSL 2 backend.** Requirements: Windows 11
Enterprise, Pro or Education 23H2 (build 22631) or higher, or Windows 10
22H2 (build 19045), and WSL version 2.1.5 or later.

```text title="install-wsl.ps1"
wsl --install
wsl --update
```

Then run the installer, or install it from the command line:

```text title="install-docker-desktop.ps1"
Start-Process 'Docker Desktop Installer.exe' -Wait -ArgumentList 'install', '--user'
```

`install --user` installs for the current user without administrator rights;
plain `install` installs for all users and needs administrator rights.

**Docker Engine inside a WSL 2 distribution.** No Desktop licence applies,
and the Linux install instructions work unchanged inside, say, Ubuntu on WSL.
Docker Engine expects systemd, which WSL enables per distribution:

```ini title="/etc/wsl.conf"
[boot]
systemd=true
```

Then `wsl.exe --shutdown` from PowerShell and start the distribution again.
The trade-off is that you get no GUI, no automatic Windows integration, and
`docker` works only from inside that distribution.

:::warning Keep your files in the Linux filesystem
Docker's WSL guidance is explicit: "Performance is much higher when files are
bind-mounted from the Linux filesystem, rather than accessed from the Windows
host filesystem." Bind mounting `/mnt/c/...` into a container crosses a 9p
translation layer and is slow. Linux containers also only receive inotify
file-change events for files stored in the Linux filesystem, which breaks
hot-reload tooling.
:::

::::

## Post-install on Linux: the docker group

By default the daemon socket is owned by `root`, so every command needs
`sudo`. The documented fix is a group:

```bash
sudo groupadd docker
sudo usermod -aG docker $USER
newgrp docker
docker run hello-world
```

:::danger The docker group is root
Docker's own post-install page says: "The `docker` group grants root-level
privileges to the user." This is not a caveat, it is the literal security
model. A single `docker run` that bind-mounts the host's `/` into a container
is enough to read or rewrite any file on the machine as root, without ever
typing `sudo`.

Docker's security page puts it the same way: "you can start a container where
the `/host` directory is the `/` directory on your host; and the container can
alter your host filesystem without any restriction." Adding a user to the
`docker` group is equivalent to giving them passwordless root. On a shared or
production machine, either keep `sudo docker` or use
[rootless mode](../docker-advanced/rootless-docker.md).
[The Docker socket is root](../docker-security/docker-socket-is-root.md)
develops the attack in full.
:::

Start the daemon on boot (already done by the Fedora command above):

```bash
sudo systemctl enable docker.service
sudo systemctl enable containerd.service
```

## Verify the installation

```bash
docker version
docker info
docker context ls
```

`docker version` prints client and server sections. Two sections means the CLI
reached a daemon; a client-only section plus an error means it did not.

```console include="captures/docker-beginner/version.txt"
```

`docker info` describes the daemon: storage driver, cgroup driver and version,
logging driver, runtime and kernel.

```console include="captures/docker-beginner/info.txt"
```

`docker context ls` shows which daemon the CLI talks to. Docker Desktop
installs a `desktop-linux` context and makes it current, so the CLI on your
Mac or Windows host is talking to the daemon inside the VM over a socket or
named pipe.

```console include="captures/docker-beginner/context-ls.txt"
```

Finally, the traditional smoke test. `hello-world` is a tiny image whose only
job is to prove the pull-create-start-exit path works:

```bash
docker run --rm hello-world
```

```console include="captures/docker-beginner/run-hello.txt"
```

## What changed in Engine 29

Worth knowing on a fresh install, from the 29.0.0 release notes:

| Change | Consequence |
|---|---|
| The **containerd image store** is the default for fresh installs | Multi-platform images can be stored locally; it does not apply to upgraded daemons or to daemons using `userns-remap` |
| The daemon's minimum API version is **v1.44** (Docker v25.0+) | Very old clients and SDKs are refused |
| Containers default to a **1024 open-file soft limit** | Servers that expect 1048576 file descriptors need `--ulimit nofile=...` or `default-ulimits` in `daemon.json` |
| **nftables** support is experimental (`--firewall-backend=nftables`) | The default remains iptables; under nftables Docker does not enable IP forwarding for you |
| **cgroup v1 is deprecated** | Support continues until at least May 2029, but treat cgroup v2 as the baseline |
| Docker Content Trust was **removed from the CLI** | Use [cosign](../docker-advanced/image-signing-cosign.md) for signing |
| `docker image ls` shows a collapsed tree view and hides untagged images unless `--all` is given | Output looks different from older tutorials |

## Common mistakes

- **Installing the distribution's `docker.io` package and expecting Engine 29.**
  Distribution packages lag, sometimes by years. Check with `docker version`.
- **Forgetting the Compose plugin package.** Then `docker compose` does not
  exist, and people reach for the long-EOL Python Compose v1 instead.
- **Adding a service account to the `docker` group on a server.** That is
  passwordless root for that account. See the callout above.
- **Running `sudo docker` after adding yourself to the group.** `sudo` uses
  root's environment, so your context and `~/.docker/config.json` are ignored
  and you may end up talking to a different daemon.
- **Assuming Docker Desktop is free at work.** The threshold is fewer than 250
  employees *and* under $10 million revenue. Both conditions must hold.
- **Bind mounting Windows paths into WSL 2 containers** and then blaming Docker
  for slow builds.

## Related topics

- [Docker CLI basics](docker-cli-basics.md)
- [Running containers](running-containers.md)
- [The Docker socket is root](../docker-security/docker-socket-is-root.md)
- [Rootless Docker](../docker-advanced/rootless-docker.md)
- [Podman and alternatives](../docker-advanced/podman-and-alternatives.md)
- [Daemon configuration](../docker-advanced/daemon-configuration.md)
- [Docker CLI cheat sheet](../reference/docker-cli-cheat-sheet.md)
