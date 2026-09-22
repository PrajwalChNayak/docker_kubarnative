# syntax=docker/dockerfile:1
# check=error=true

# Tasklane operator image:
#   docker build -t tasklane-operator:0.1.0 examples/operator
#   kind load docker-image tasklane-operator:0.1.0 --name tasklane
#
# Same shape as examples/app/Dockerfile: pinned digests, cross-compiled from a
# native builder, distroless runtime, non-root numeric UID.

ARG GO_IMAGE=golang:1.27-trixie@sha256:433790e515d27dc6003e847e644cc0af956985cf315c1c58a3b73ee2dd305183
ARG RUNTIME_IMAGE=gcr.io/distroless/static-debian13:nonroot@sha256:e2e927ec666bae08560abb3c55d0659eceabb657f56b6782ab500a9fc7f555e3

FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS build
WORKDIR /src

COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

COPY . .
ARG TARGETOS TARGETARCH
ARG VERSION=dev
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w -buildid= -X main.version=${VERSION}" \
      -o /out/manager ./cmd

FROM ${RUNTIME_IMAGE} AS manager
LABEL org.opencontainers.image.title="tasklane-operator" \
      org.opencontainers.image.source="https://github.com/example/tasklane"
COPY --from=build /out/manager /manager
# distroless :nonroot is UID/GID 65532, declared numerically so Kubernetes
# runAsNonRoot can verify it without reading /etc/passwd.
USER 65532:65532
EXPOSE 8080 8081
# No HEALTHCHECK: this image is only ever run by Kubernetes, which probes
# /healthz and /readyz on :8081 from the Deployment instead.
ENTRYPOINT ["/manager"]
