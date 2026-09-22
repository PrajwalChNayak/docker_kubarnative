#!/usr/bin/env sh
# The same hardening as compose.yaml, as a raw `docker run`. Each flag is
# annotated. Run from a host that has built tasklane-api:0.1.0.
set -eu

docker run --rm \
  --name tasklane-api \
  `# --- filesystem ---` \
  --read-only \
  `# only writable path the process needs; noexec/nosuid harden it` \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  `# --- privileges ---` \
  `# drop every capability: the API needs none` \
  --cap-drop ALL \
  `# block setuid escalation (prctl PR_SET_NO_NEW_PRIVS)` \
  --security-opt no-new-privileges:true \
  `# keep the default seccomp profile explicit (~44 syscalls blocked)` \
  --security-opt seccomp=default \
  `# run as a numeric non-root UID:GID so runtime cannot fall back to root` \
  --user 65532:65532 \
  `# --- resource bounds ---` \
  `# cap process count to blunt fork bombs` \
  --pids-limit 128 \
  `# hard memory ceiling; equal --memory-swap disables swap` \
  --memory 128m --memory-swap 128m \
  --cpus 0.50 \
  `# --- network / config ---` \
  `# publish only on loopback, never 0.0.0.0` \
  --publish 127.0.0.1:8080:8080 \
  --env PGHOST=db \
  --env PGUSER=tasklane \
  --env PGDATABASE=tasklane \
  --env PGSSLMODE=require \
  `# secret comes from a mounted file, not baked into the image or ENV` \
  --env PGPASSWORD_FILE=/run/secrets/db_password \
  --mount type=bind,src="$(pwd)/db_password.txt",dst=/run/secrets/db_password,ro \
  tasklane-api:0.1.0
