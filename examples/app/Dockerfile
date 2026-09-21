# syntax=docker/dockerfile:1
# check=error=true

# Tasklane — one Dockerfile, two final images:
#   docker build --target api    -t tasklane-api:dev    .
#   docker build --target worker -t tasklane-worker:dev .
#
# Base images are pinned by multi-arch index digest. The tag stays for humans;
# the digest is what BuildKit actually pulls. Bump both together (Renovate or
# Dependabot can automate this).

ARG GO_IMAGE=golang:1.27-trixie@sha256:433790e515d27dc6003e847e644cc0af956985cf315c1c58a3b73ee2dd305183
ARG RUNTIME_IMAGE=gcr.io/distroless/static-debian13:nonroot@sha256:e2e927ec666bae08560abb3c55d0659eceabb657f56b6782ab500a9fc7f555e3

# ---- build stage -----------------------------------------------------------
# --platform=$BUILDPLATFORM runs the compiler natively on the build machine
# and cross-compiles for the target, instead of emulating arm64 under QEMU.
FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS build
WORKDIR /src

# Dependencies first: this layer is reused until go.mod or go.sum changes.
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

COPY . .
ARG TARGETOS TARGETARCH
ARG VERSION=dev
# CGO_ENABLED=0 gives static binaries that need no libc in the final image.
# -trimpath and -buildid= make the output independent of the build machine.
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w -buildid= -X main.version=${VERSION}" \
      -o /out/ ./cmd/api ./cmd/worker

# ---- api -------------------------------------------------------------------
FROM ${RUNTIME_IMAGE} AS api
LABEL org.opencontainers.image.title="tasklane-api" \
      org.opencontainers.image.source="https://github.com/example/tasklane"
COPY --from=build /out/api /api
# distroless :nonroot runs as UID/GID 65532. Declared numerically so
# Kubernetes runAsNonRoot can verify it without reading /etc/passwd.
USER 65532:65532
EXPOSE 8080
# Exec form: the binary is PID 1 and receives SIGTERM directly. Go's runtime
# handles signals, and the process spawns no children, so no init is needed.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/api", "healthcheck"]
ENTRYPOINT ["/api"]

# ---- worker ----------------------------------------------------------------
FROM ${RUNTIME_IMAGE} AS worker
LABEL org.opencontainers.image.title="tasklane-worker" \
      org.opencontainers.image.source="https://github.com/example/tasklane"
COPY --from=build /out/worker /worker
USER 65532:65532
EXPOSE 9090
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/worker", "healthcheck"]
ENTRYPOINT ["/worker"]
