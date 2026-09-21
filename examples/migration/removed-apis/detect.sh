#!/usr/bin/env bash
# Detect removed and deprecated Kubernetes API versions with Pluto v5.24.4.
#
# Pluto is not on the maintainer PATH as a binary, so this script runs it from
# the Fairwinds OSS image. Both modes are shown:
#   1. scan static manifests on disk (pre-apply, in CI, against charts)
#   2. scan what is already live in the cluster
#
# Exit codes: pluto returns non-zero when it finds a REMOVED apiVersion, which
# makes it a usable CI gate. Deprecated-but-served versions warn without failing
# unless you pass --target-versions / -o wide.
set -euo pipefail

DIR="${1:-examples/migration/removed-apis}"
PLUTO_IMAGE="us-docker.pkg.dev/fairwinds-ops/oss/pluto:v5.24.4"

echo "== 1. detect-files: scan manifests on disk =="
docker run --rm -v "$PWD:/w" -w /w "$PLUTO_IMAGE" \
  detect-files -d "$DIR" --target-versions k8s=v1.37.0

echo
echo "== 2. detect: scan live objects (needs a cluster) =="
echo "   kubectl get deployments,ingresses,cronjobs,hpa -A -o yaml \\"
echo "     | docker run --rm -i $PLUTO_IMAGE detect - --target-versions k8s=v1.37.0"
# If pluto is installed as a local binary instead, the same commands are:
#   pluto detect-files -d "$DIR"
#   kubectl get ... -o yaml | pluto detect -
