#!/usr/bin/env bash
# Tasklane, stage 1: the whole system with nothing but the Docker CLI.
#
#   bash examples/docker-run/tasklane-docker-run.sh
#   curl http://127.0.0.1:8088/
#   bash examples/docker-run/tasklane-docker-cleanup.sh            # keep data
#   bash examples/docker-run/tasklane-docker-cleanup.sh --volumes  # delete data
#
# Prerequisites: Docker Engine 29 (or Docker Desktop), and the images
# tasklane-api:0.1.0 and tasklane-worker:0.1.0 built from examples/app:
#
#   docker build --target api    -t tasklane-api:0.1.0    examples/app
#   docker build --target worker -t tasklane-worker:0.1.0 examples/app
#
# The script is idempotent. Networks and volumes are created only if they are
# missing; the four containers are removed and recreated on every run. Data in
# the tasklane-db-data volume survives re-runs.
#
# Everything here is what Docker Compose does for you in stage 2
# (examples/compose/compose.yaml). Reading both side by side is the point.

set -euo pipefail

# Git Bash on Windows rewrites arguments that look like POSIX paths
# (/run/secrets -> C:/Program Files/Git/run/secrets). Turn that off. It has
# no effect on Linux or macOS.
export MSYS_NO_PATHCONV=1

API_IMAGE="${API_IMAGE:-tasklane-api:0.1.0}"
WORKER_IMAGE="${WORKER_IMAGE:-tasklane-worker:0.1.0}"
# Same pinned digests as examples/compose/compose.yaml.
DB_IMAGE="postgres:18-trixie@sha256:86c951e05bf56c93d95d397747fb8820ac76cc3bedb78f43abd83eedbe3666ae"
HELPER_IMAGE="busybox:1.37-musl@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23"

# 8088, not 8080: the kind lab cluster maps host port 8080 to its Gateway.
API_PORT="${API_PORT:-8088}"

NET=tasklane-net
DB_VOLUME=tasklane-db-data
SECRET_VOLUME=tasklane-secrets
LABEL=org.example.tasklane.stage=docker-run

log() { printf '==> %s\n' "$*"; }

# Wait until `docker inspect` reports the container's health as "healthy".
wait_healthy() {
  local name=$1 tries=${2:-60} status
  for _ in $(seq "$tries"); do
    status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name")
    case "$status" in
      healthy) log "$name is healthy"; return 0 ;;
      none)    echo "error: $name has no healthcheck" >&2; return 1 ;;
    esac
    if [ "$(docker inspect --format '{{.State.Running}}' "$name")" != "true" ]; then
      echo "error: $name stopped. Last log lines:" >&2
      docker logs --tail 20 "$name" >&2
      return 1
    fi
    sleep 1
  done
  echo "error: $name not healthy after ${tries}s (status: $status)" >&2
  docker logs --tail 20 "$name" >&2
  return 1
}

# ---- 0. images ---------------------------------------------------------------
for img in "$API_IMAGE" "$WORKER_IMAGE"; do
  if ! docker image inspect "$img" >/dev/null 2>&1; then
    echo "error: image $img not found. Build it from examples/app first (see the header of this script)." >&2
    exit 1
  fi
done

# ---- 1. network --------------------------------------------------------------
# A user-defined bridge network gives containers DNS: the api reaches the
# database as "tasklane-db". The default bridge network has no such DNS.
if ! docker network inspect "$NET" >/dev/null 2>&1; then
  log "creating network $NET"
  docker network create --label "$LABEL" "$NET" >/dev/null
fi

# ---- 2. volumes --------------------------------------------------------------
for vol in "$DB_VOLUME" "$SECRET_VOLUME"; do
  if ! docker volume inspect "$vol" >/dev/null 2>&1; then
    log "creating volume $vol"
    docker volume create --label "$LABEL" "$vol" >/dev/null
  fi
done

# ---- 3. database password ----------------------------------------------------
# The password is generated once and stored as a file in a volume. Every
# container that needs it mounts that volume read-only at /run/secrets, and
# reads it through POSTGRES_PASSWORD_FILE / PGPASSWORD_FILE. It never appears
# in an environment variable, so `docker inspect` does not show it.
#
# Postgres uses the password only when it initialises an empty data volume,
# so it must not change while tasklane-db-data exists. That is why it is only
# generated when the file is missing.
#
# Stage-1 compromise: the file is world-readable (0444) because postgres
# (UID 999) and the Tasklane images (UID 65532) both read it. Compose secrets
# and Kubernetes Secrets handle this properly in later stages.
if ! docker run --rm --mount "type=volume,src=$SECRET_VOLUME,dst=/secrets" \
      "$HELPER_IMAGE" test -s /secrets/db_password; then
  log "generating database password in volume $SECRET_VOLUME"
  # od reads its input to EOF, so this pipeline cannot fail with SIGPIPE
  # under `set -o pipefail` the way `head -c` would.
  password=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
  printf '%s' "$password" |
    docker run --rm -i --mount "type=volume,src=$SECRET_VOLUME,dst=/secrets" \
      "$HELPER_IMAGE" sh -c 'cat > /secrets/db_password && chmod 0444 /secrets/db_password'
  unset password
fi

# ---- 4. remove old containers (idempotency) ----------------------------------
docker rm -f tasklane-worker tasklane-api tasklane-migrate tasklane-db >/dev/null 2>&1 || true

# Settings shared by migrate, api and worker: the standard libpq variables.
DB_ENV=(
  -e PGHOST=tasklane-db
  -e PGPORT=5432
  -e PGUSER=tasklane
  -e PGDATABASE=tasklane
  -e PGSSLMODE=disable          # local only; production uses TLS
  -e PGPASSWORD_FILE=/run/secrets/db_password
)
SECRET_MOUNT=(--mount "type=volume,src=$SECRET_VOLUME,dst=/run/secrets,readonly")
# Hardening flags, explained in Part E. The images already run as UID 65532.
HARDENING=(--read-only --cap-drop ALL --security-opt no-new-privileges:true)

# ---- 5. database -------------------------------------------------------------
log "starting tasklane-db"
# The official postgres image starts as root and its entrypoint drops to the
# postgres user (UID 999) before running the server. That is why this one
# container gets no --user and no --cap-drop.
# No -p: nothing outside the tasklane-net network can reach port 5432.
docker run -d \
  --name tasklane-db \
  --label "$LABEL" \
  --network "$NET" \
  --restart unless-stopped \
  -e POSTGRES_USER=tasklane \
  -e POSTGRES_DB=tasklane \
  -e POSTGRES_PASSWORD_FILE=/run/secrets/db_password \
  "${SECRET_MOUNT[@]}" \
  --mount "type=volume,src=$DB_VOLUME,dst=/var/lib/postgresql" \
  --health-cmd 'pg_isready -U tasklane -d tasklane' \
  --health-interval 5s --health-timeout 3s --health-retries 10 --health-start-period 10s \
  "$DB_IMAGE" >/dev/null
wait_healthy tasklane-db 90

# ---- 6. migrate (one-shot) ---------------------------------------------------
log "running migration"
# Foreground and --rm: the script waits for the exit code, and the container
# is deleted afterwards. set -e stops the script if migrate exits non-zero.
docker run --rm \
  --name tasklane-migrate \
  --label "$LABEL" \
  --network "$NET" \
  "${DB_ENV[@]}" \
  "${SECRET_MOUNT[@]}" \
  "${HARDENING[@]}" \
  "$API_IMAGE" migrate

# ---- 7. api ------------------------------------------------------------------
log "starting tasklane-api on 127.0.0.1:$API_PORT"
# -p 127.0.0.1:...: only this machine can connect. Without the address Docker
# listens on every interface and bypasses host firewalls such as ufw.
docker run -d \
  --name tasklane-api \
  --label "$LABEL" \
  --network "$NET" \
  --restart unless-stopped \
  -p "127.0.0.1:$API_PORT:8080" \
  "${DB_ENV[@]}" \
  -e SHUTDOWN_DELAY_SECONDS=1 \
  "${SECRET_MOUNT[@]}" \
  "${HARDENING[@]}" \
  --memory 128m --cpus 0.5 \
  "$API_IMAGE" >/dev/null

# ---- 8. worker ---------------------------------------------------------------
log "starting tasklane-worker"
docker run -d \
  --name tasklane-worker \
  --label "$LABEL" \
  --network "$NET" \
  --restart unless-stopped \
  "${DB_ENV[@]}" \
  -e WORK_DURATION_MS=1500 \
  -e POLL_INTERVAL_MS=1000 \
  "${SECRET_MOUNT[@]}" \
  "${HARDENING[@]}" \
  --memory 64m --cpus 0.25 \
  "$WORKER_IMAGE" >/dev/null

# Both images declare a HEALTHCHECK (the binary's own `healthcheck` mode).
wait_healthy tasklane-api 60
wait_healthy tasklane-worker 60

log "Tasklane is running. Try:"
echo "    curl http://127.0.0.1:$API_PORT/"
echo "    curl -X POST -H 'Content-Type: application/json' -d '{\"title\":\"hello\"}' http://127.0.0.1:$API_PORT/tasks"
echo "    curl http://127.0.0.1:$API_PORT/tasks"
