# examples/build — Bake, build secrets and CI

Advanced build artefacts for Tasklane. Nothing in this directory is needed to
run the app; it exists to show how the images are produced in a pipeline.

Written against **Docker Engine 29, Buildx 0.37**.

| File | What it is |
|---|---|
| `docker-bake.hcl` | Bake definition: targets `api`, `worker`, `dev`, `secret-demo`, group `default`, multi-platform, registry cache, SBOM and provenance attestations |
| `Dockerfile.secret-demo` | `RUN --mount=type=secret` and `--mount=type=ssh` demonstration; passes hadolint v2.15.1 |
| `github-actions-build.yaml` | Reference GitHub Actions workflow: Bake build, GHCR push, cosign keyless signing, SBOM check |

## Bake

```bash
docker buildx bake -f examples/build/docker-bake.hcl --print
docker buildx bake -f examples/build/docker-bake.hcl --list targets
docker buildx bake -f examples/build/docker-bake.hcl dev --load
```

`--print` resolves variables, inheritance and interpolation and prints the
build plan as JSON without building anything. Run it before every change to a
Bake file; it is the cheapest possible feedback loop.

Variables are overridden from the environment or with `--set`:

```bash
VERSION=0.2.0 docker buildx bake -f examples/build/docker-bake.hcl --print
docker buildx bake -f examples/build/docker-bake.hcl --set '*.platform=linux/amd64'
```

Notes on the definition:

- `_common` holds the shared context, platforms, labels and attestations.
  `api` and `worker` inherit it. It is deliberately absent from `default`.
- `platforms` builds a manifest list. `--load` accepts only one platform,
  which is why the `dev` target narrows it to `linux/amd64`.
- `cache-from` lists two refs: the branch cache and the `main` cache. A first
  build on a new branch still gets a warm cache.
- `cache-to` uses `mode=max`, so intermediate stages are cached too. That is
  the point of a separate cache repository: those layers never reach the
  runtime image.
- `attest` asks for `provenance` at `mode=max` and an SBOM. BuildKit attaches
  `mode=min` provenance on its own; everything else is opt-in.
- The object form of `attest`, `cache-from`, `cache-to` and `secret` is what
  the Bake reference documents for current Buildx. Older releases wrote these
  as CSV strings.

## Build secrets

```bash
export NPM_TOKEN=not-a-real-token
printf 'hunter2' > /tmp/api_token

docker buildx build -f examples/build/Dockerfile.secret-demo \
  --secret id=api_token,src=/tmp/api_token \
  --secret id=NPM_TOKEN \
  --ssh default \
  --output type=local,dest=./out \
  examples/build
```

`./out/proof` then contains a fingerprint and a length, never the secret. A
secret mount is a tmpfs that lives for exactly one `RUN`; the layer records
the command line, not the mounted bytes. Compare that with `ARG`, whose value
is written into the image config and shown by `docker history`.

Lint it:

```bash
docker run --rm -i hadolint/hadolint:v2.15.1 hadolint - < examples/build/Dockerfile.secret-demo
```

## CI

`github-actions-build.yaml` is a workflow file kept outside `.github/` on
purpose. Copy it to `.github/workflows/build.yaml` in a real repository.

It needs three permissions: `contents: read`, `packages: write` to push to
GHCR, and `id-token: write` so cosign can exchange the job's OIDC token for a
Fulcio certificate. Pull requests build but never push and never write cache.

Signing and verification commands live in
[`examples/supply-chain/README.md`](../supply-chain/README.md).
