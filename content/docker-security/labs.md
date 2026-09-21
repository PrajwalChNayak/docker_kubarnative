---
title: Docker security labs
description: Hands-on exercises for secret extraction, the socket escape, capability dropping and a fully hardened run, with solutions.
level: advanced
type: lab
status: current
versions: Docker Engine 29
prerequisites:
  - docker-security/secrets-in-images
  - docker-security/docker-socket-is-root
  - docker-security/dropping-capabilities
  - docker-security/read-only-root-filesystem
---

## Overview

These labs turn Part E into muscle memory. You will leak a secret out of an
image and then stop it, escape a container to host root and then close the hole,
and harden a `docker run` until every control verifies. Everything uses the
Tasklane example and the runnable files under
[`examples/security/docker/`](../../examples/security/docker/hardened-run/README.md).

:::danger Run only in a disposable VM or lab
Exercises 2 gives a container root on its host. Run every exercise on a throwaway
VM or the Docker Desktop VM, never on a workstation, a shared host, or anything
with real data. All "credentials" here are deliberately fake.
:::

## Setup

You need Docker Engine 29 (or Docker Desktop) on a disposable host, and the
handbook repo checked out. Build the Tasklane image once:

```bash
docker build --target api -t tasklane-api:0.1.0 examples/app
```

Work from `examples/security/docker/` for the exercise-specific files. No cluster
is required.

## Exercises

### Exercise 1 — Leak a secret, then seal it

1. Build both vulnerable images in `secret-in-image/` (the COPY-then-`rm` variant
   and the `--build-arg`/`ENV` variant).
2. Recover the fake key **two ways**: from image metadata, and from the layer
   tarball of the COPY variant.
3. Build the `fixed/` image with a build secret mount and prove the same two
   extractions find nothing.
4. Bonus: run a secret scanner against the vulnerable and fixed images and
   compare.

**Goal:** explain in one sentence why the COPY variant's `rm` does not remove the
secret.

### Exercise 2 — Escape via the socket, then remove it

1. Bring up `socket-escape/vulnerable/compose.yaml` and use the mounted socket to
   read the host's `/etc/shadow` from a second, privileged container.
2. Switch to `socket-escape/fixed/compose.yaml` and show the escape now fails.
3. Bring up the socket-proxy alternative and show that a *read* succeeds through
   the proxy but a container *create* is refused.

**Goal:** state why `docker` group membership is equivalent to host root.

### Exercise 3 — Drop capabilities and prove it

1. Print the capability sets of a default container and a `--cap-drop ALL`
   container (`grep Cap /proc/1/status`).
2. Show that `--cap-drop ALL` makes `chown` fail with `EPERM`.
3. Add back exactly the one capability that a process needs to bind port 80, and
   confirm nothing more was granted.

**Goal:** name three dangerous capabilities not in Docker's default set.

### Exercise 4 — Read-only and no-new-privileges

1. Run a container `--read-only` and show a write to `/root` fails with `EROFS`.
2. Add a `--tmpfs /tmp:rw,noexec,nosuid,size=16m` and show `/tmp` is writable.
3. Show `NoNewPrivs: 1` in `/proc/1/status` with
   `--security-opt no-new-privileges:true`, and `0` without it.

**Goal:** explain what `noexec` on the tmpfs buys you.

### Exercise 5 — A fully hardened run

1. Run `tasklane-api:0.1.0` with the full set from
   [`hardened-run/`](../../examples/security/docker/hardened-run/README.md):
   read-only, tmpfs, `--cap-drop ALL`, `no-new-privileges`, non-root user, PID and
   memory limits, loopback-only publish, secret from a file.
2. Verify each control: capabilities empty, rootfs immutable, `NoNewPrivs: 1`,
   and the daemon's reported security options.

**Goal:** map each flag to the attack surface it closes.

## Solutions

### Exercise 1

```bash
cd examples/security/docker/secret-in-image
# 1. build vulnerable
docker build -f vulnerable/Dockerfile -t secret-copy:vuln vulnerable
docker build -f vulnerable/Dockerfile.arg --build-arg FAKE_API_KEY=demo-not-real-passed-at-build -t secret-arg:vuln vulnerable

# 2a. metadata (ARG/ENV variant)
docker history --no-trunc secret-arg:vuln
docker inspect --format '{{json .Config.Env}}' secret-arg:vuln
# 2b. layer tarball (COPY variant)
docker save secret-copy:vuln -o /tmp/img.tar && mkdir -p /tmp/dig && tar -xf /tmp/img.tar -C /tmp/dig
find /tmp/dig -name '*.tar' -exec tar -xf {} \; 2>/dev/null || true
grep -rn 'FAKE_API_KEY' /tmp/dig

# 3. fixed build + verify
docker build --secret id=api_key,src=./vulnerable/fake-credentials.env -f fixed/Dockerfile -t secret:fixed fixed
docker history --no-trunc secret:fixed
docker save secret:fixed -o /tmp/fixed.tar && mkdir -p /tmp/fdig && tar -xf /tmp/fixed.tar -C /tmp/fdig
find /tmp/fdig -name '*.tar' -exec tar -xf {} \; 2>/dev/null || true
grep -rn 'FAKE_API_KEY\|demo-not-real' /tmp/fdig || echo "clean"

# 4. scan
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:0.74.0 image --scanners secret secret-copy:vuln
```

Answer: the `rm` runs in a *later* layer and only adds a whiteout; the earlier
COPY layer is immutable and still ships the plaintext.

### Exercise 2

```bash
cd examples/security/docker/socket-escape
docker compose -f vulnerable/compose.yaml up -d
docker compose -f vulnerable/compose.yaml exec ci-runner docker run --rm -v /:/host --privileged alpine:3.22 chroot /host sh -c 'id; head -n 3 /etc/shadow'

docker compose -f vulnerable/compose.yaml down
docker compose -f fixed/compose.yaml up -d
docker compose -f fixed/compose.yaml exec ci-runner docker -H unix:///var/run/docker.sock info   # fails: no socket

docker compose -f fixed/compose.yaml down
docker compose -f fixed/socket-proxy.compose.yaml up -d
docker compose -f fixed/socket-proxy.compose.yaml exec ci-runner docker -H tcp://dockerproxy:2375 images     # allowed
docker compose -f fixed/socket-proxy.compose.yaml exec ci-runner docker -H tcp://dockerproxy:2375 run --rm alpine:3.22 true  # 403
docker compose -f fixed/socket-proxy.compose.yaml down
```

Answer: the socket is the daemon API, and the daemon runs as root; a `docker`
group member can drive it to bind-mount `/` and `chroot`, i.e. become host root.

### Exercise 3

```bash
docker run --rm alpine:3.22 grep Cap /proc/1/status
docker run --rm --cap-drop ALL alpine:3.22 grep Cap /proc/1/status         # all-zero masks
docker run --rm --cap-drop ALL alpine:3.22 chown nobody /etc/hostname      # EPERM
docker run --rm --cap-drop ALL --cap-add NET_BIND_SERVICE alpine:3.22 grep CapEff /proc/1/status
```

Answer: for example `SYS_ADMIN`, `SYS_PTRACE`, `SYS_MODULE` (also `NET_ADMIN`,
`DAC_READ_SEARCH`) are all outside the default set.

### Exercise 4

```bash
docker run --rm --read-only alpine:3.22 sh -c 'echo x > /root/x'                                   # EROFS
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m alpine:3.22 sh -c 'echo ok > /tmp/ok && cat /tmp/ok'
docker run --rm alpine:3.22 grep NoNewPrivs /proc/1/status                                          # 0
docker run --rm --security-opt no-new-privileges:true alpine:3.22 grep NoNewPrivs /proc/1/status    # 1
```

Answer: `noexec` means a payload written to `/tmp` cannot be executed from there,
removing the easiest "download and run" path (though `memfd`-based execution can
still bypass it, which is why seccomp and cap-drop matter too).

### Exercise 5

```bash
cd examples/security/docker/hardened-run
sh hardened-run.sh    # or: docker compose up
# verify (in separate shells / on the running container)
docker run --rm --cap-drop ALL alpine:3.22 grep Cap /proc/1/status
docker run --rm --read-only alpine:3.22 sh -c 'echo x > /root/x' || echo "read-only OK"
docker run --rm --security-opt no-new-privileges:true alpine:3.22 grep NoNewPrivs /proc/1/status
docker info --format '{{.SecurityOptions}}'
```

Answer: `--read-only`/tmpfs → image (immutability); `--cap-drop ALL` → capability
abuse; `no-new-privileges` → setuid escalation; `--user` → runtime root;
`--pids-limit`/`--memory` → resource exhaustion; loopback publish → network
exposure; file-based secret → image/secret leakage.

## Common mistakes

- Running these exploits outside a disposable VM.
- Concluding the secret is gone because the running container cannot see the file.
- Adding `SYS_ADMIN` or `--privileged` to make an exercise "work" instead of the
  minimal capability.
- Reverting the whole rootfs to writable when one path fails, rather than adding a
  tmpfs for that path.
- Leaving the socket-mounted or proxy containers running after the lab.

## Related topics

- [Secrets in images](secrets-in-images.md)
- [The Docker socket is root](docker-socket-is-root.md)
- [Dropping capabilities](dropping-capabilities.md)
- [Read-only root filesystem and tmpfs](read-only-root-filesystem.md)
- [The container threat model](container-threat-model.md)
