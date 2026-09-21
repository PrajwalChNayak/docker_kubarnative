#!/usr/bin/env bash
# Delete the Tasklane lab cluster. This destroys everything in it.
set -euo pipefail
CLUSTER=tasklane
if kind get clusters | grep -qx "$CLUSTER"; then
  kind delete cluster --name "$CLUSTER"
  echo "deleted kind cluster '$CLUSTER'"
else
  echo "no kind cluster '$CLUSTER'"
fi
