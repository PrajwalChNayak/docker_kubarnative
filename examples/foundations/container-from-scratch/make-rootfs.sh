#!/usr/bin/env bash
# Export an image's root filesystem as a plain tarball, for from-scratch.sh.
#
# Run this on a machine that has Docker (it needs no privileges beyond the
# usual docker access, and it starts no container: `docker create` only
# materialises the writable layer, and `docker export` streams the flattened
# filesystem).
#
#   ./make-rootfs.sh              # -> /tmp/from-scratch/rootfs.tar
#   IMAGE=alpine:3.22 ./make-rootfs.sh
#
# Then:
#   sudo ROOTFS_TAR=/tmp/from-scratch/rootfs.tar ./from-scratch.sh
#
# What you get is the image's *filesystem only*. Everything else an image
# carries (entrypoint, env, user, exposed ports) lives in the image config,
# which `docker export` deliberately drops. That is the difference between an
# image and a root filesystem.
set -euo pipefail

IMAGE=${IMAGE:-busybox:1.37-musl@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23}
OUT=${OUT:-/tmp/from-scratch/rootfs.tar}

mkdir -p "$(dirname "$OUT")"
cid=$(docker create "$IMAGE")
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
docker export "$cid" -o "$OUT"
echo "wrote $OUT ($(wc -c < "$OUT") bytes)"
echo "top level entries:"
tar -tf "$OUT" | awk -F/ 'NF<=2' | head -n 20
