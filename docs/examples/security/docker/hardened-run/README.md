# Hardened runtime for Tasklane

A locked-down way to run `tasklane-api:0.1.0`, as both a `docker run` script
(`hardened-run.sh`) and Compose (`compose.yaml`). The image already runs as
UID 65532; these settings remove what an attacker could use *after*
compromising the process.

## The flags, and what each one buys you

| Setting (`docker run` / Compose) | Effect |
|---|---|
| `--read-only` / `read_only: true` | Root filesystem is immutable. No dropping tools, no tampering with binaries or config. |
| `--tmpfs /tmp:...` / `tmpfs:` | The one writable path, on a tmpfs mounted `noexec,nosuid` and size-capped. |
| `--cap-drop ALL` / `cap_drop: [ALL]` | Removes every Linux capability. The API needs none. |
| `--security-opt no-new-privileges:true` | Sets `PR_SET_NO_NEW_PRIVS`; a setuid binary can no longer raise privileges. |
| `--security-opt seccomp=default` | Keeps the default seccomp profile (blocks ~44 syscalls) explicit. |
| `--user 65532:65532` | Runs as a numeric non-root UID:GID; the runtime cannot silently fall back to root. |
| `--pids-limit 128` | Caps process count; blunts fork bombs. |
| `--memory 128m --memory-swap 128m` | Hard memory ceiling; equal values disable swap for the container. |
| `--cpus 0.50` | CPU quota. |
| `--publish 127.0.0.1:8080:8080` | Publishes only on loopback, never `0.0.0.0`. |
| `PGPASSWORD_FILE` + mounted secret | Password comes from a file, never an image layer or `ENV`. |

## Run it

```sh
# from a host that has built tasklane-api:0.1.0
sh hardened-run.sh
# or
docker compose up
```

## Prove the hardening is on

```sh
# no capabilities in the running container
docker run --rm --cap-drop ALL alpine:3.22 grep Cap /proc/1/status
# writes to the root fs fail
docker run --rm --read-only alpine:3.22 sh -c 'echo x > /root/x' || echo "read-only: write denied"
# security options the daemon reports
docker info --format '{{.SecurityOptions}}'
```

`db_password.txt` here is a dev-only placeholder. In production the secret
comes from a real secret store (Docker/Swarm secrets, a Kubernetes Secret
mounted as a file, or an external manager), never a file in the repo.
