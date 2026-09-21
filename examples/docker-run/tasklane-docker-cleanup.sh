#!/usr/bin/env bash
# Remove everything tasklane-docker-run.sh created.
#
#   bash examples/docker-run/tasklane-docker-cleanup.sh             # containers + network
#   bash examples/docker-run/tasklane-docker-cleanup.sh --volumes   # also the data
#
# Without --volumes the database volume survives, so the next run of
# tasklane-docker-run.sh finds the same tasks. That is the whole point of a
# named volume: the container is disposable, its data is not.

set -euo pipefail
export MSYS_NO_PATHCONV=1

REMOVE_VOLUMES=false
if [ "${1:-}" = "--volumes" ]; then
  REMOVE_VOLUMES=true
fi

log() { printf '==> %s\n' "$*"; }

# docker rm -f stops (SIGTERM, then SIGKILL after the stop timeout) and
# deletes in one step. Order matters only for tidiness here.
log "removing containers"
docker rm -f tasklane-worker tasklane-api tasklane-migrate tasklane-db >/dev/null 2>&1 || true

if docker network inspect tasklane-net >/dev/null 2>&1; then
  log "removing network tasklane-net"
  docker network rm tasklane-net >/dev/null
fi

if [ "$REMOVE_VOLUMES" = true ]; then
  for vol in tasklane-db-data tasklane-secrets; do
    if docker volume inspect "$vol" >/dev/null 2>&1; then
      log "removing volume $vol"
      docker volume rm "$vol" >/dev/null
    fi
  done
else
  log "keeping volumes tasklane-db-data and tasklane-secrets (pass --volumes to delete them)"
fi

log "done"
