---
title: Secrets in images
description: Why a secret copied into an image survives deletion, how to extract it, and how build secret mounts keep it out of every layer.
level: advanced
type: concept
status: current
versions: Docker Engine 29
prerequisites:
  - docker-intermediate/dockerfile-instructions
  - docker-advanced/cache-and-secret-mounts
---

## Overview

A container image is an ordered stack of read-only layers. Adding a file in one
layer and deleting it in a later layer does **not** remove it: the earlier layer
still contains the bytes, and anyone with the image can read them back. This
makes "COPY the secret, then `rm` it" one of the most common and most dangerous
mistakes in Dockerfiles. This page follows the full threat → exploit → fix →
verify cycle and shows the build-secret mount that fixes it.

:::danger Run only in a disposable lab
The extraction commands below are demonstrated on **deliberately fake**
credentials (`FAKE_API_KEY=demo-not-real`) in a throwaway lab. Use the same
techniques only on images you own. The runnable example is in
[`examples/security/docker/secret-in-image/`](../../examples/security/docker/secret-in-image/README.md).
:::

## Why it exists and when to use it

Secrets end up in images through honest shortcuts: `COPY .env .` to configure a
build, `ARG NPM_TOKEN` to fetch a private package, `RUN echo $KEY > /app/key`.
Each feels temporary. None is. Understanding *why* the secret persists is what
makes you reach for the correct tool — a build secret mount — instead of a
delete that does nothing.

## How it works underneath

Each Dockerfile instruction that changes the filesystem creates a layer, stored
as a tarball and identified by a content digest. Layers are immutable and
stacked with a union filesystem. A later layer can add a *whiteout* entry that
hides a file from the merged view, which is what a `RUN rm` produces — but the
layer that first added the file is unchanged and still shipped with the image.

Two extraction paths follow from this:

1. **Image metadata.** `docker history --no-trunc` prints the `created_by`
   command for every layer. A `--build-arg` value promoted to `ENV`, or a secret
   echoed in a `RUN`, shows up here, and `docker inspect` prints baked
   environment variables verbatim.
2. **Layer contents.** `docker save` exports the image as a tar of layer
   tarballs. Unpacking every layer and grepping the tree recovers any file that
   was ever added, including one a later layer "deleted".

## Basic example

### Threat: two vulnerable Dockerfiles

The COPY-then-`rm` variant adds the credential, uses it, then deletes it:

```dockerfile include="examples/security/docker/secret-in-image/vulnerable/Dockerfile"
```

The ARG variant passes the secret at build time and bakes it into an `ENV`:

```dockerfile include="examples/security/docker/secret-in-image/vulnerable/Dockerfile.arg"
```

### Exploit: read it back

Build both, then read the ARG/ENV secret straight out of the image config:

```bash
docker build -f vulnerable/Dockerfile.arg --build-arg FAKE_API_KEY=demo-not-real-passed-at-build -t secret-arg:vuln vulnerable
docker history --no-trunc secret-arg:vuln
docker inspect --format '{{json .Config.Env}}' secret-arg:vuln
```

```console include="captures/docker-security/secret-history.txt"
```

Recover the "deleted" file from the COPY variant's layer tarball:

```bash
docker build -f vulnerable/Dockerfile -t secret-copy:vuln vulnerable
docker save secret-copy:vuln -o image.tar
mkdir dig && tar -xf image.tar -C dig
find dig -name '*.tar' -exec tar -xf {} \;
grep -rn 'FAKE_API_KEY' dig
```

```console include="captures/docker-security/secret-layer-find.txt"
```

The grep finds `FAKE_API_KEY=demo-not-real` inside the COPY layer even though the
final image's running filesystem has no such file.

## Explanation

Both extractions succeed because the secret was written into a *layer*. The
`rm`, and the fact that `ARG` is not persisted as a filesystem entry, are
irrelevant: history metadata and layer tarballs preserve the bytes. The only
robust fix is to never let the secret enter a layer in the first place.

### Fix: a build secret mount

`RUN --mount=type=secret` bind-mounts the secret onto a tmpfs for the duration
of a single `RUN`. It is readable at `/run/secrets/<id>`, never written to a
layer, and gone when the step finishes:

```dockerfile include="examples/security/docker/secret-in-image/fixed/Dockerfile"
```

Build it by passing the secret as data, not as build context or an arg:

```bash
docker build --secret id=api_key,src=./vulnerable/fake-credentials.env -f fixed/Dockerfile -t secret:fixed fixed
```

### Verify: the same extractions find nothing

```bash
docker history --no-trunc secret:fixed
docker inspect --format '{{json .Config.Env}}' secret:fixed
docker save secret:fixed -o fixed.tar && mkdir fixedig && tar -xf fixed.tar -C fixedig
find fixedig -name '*.tar' -exec tar -xf {} \;
grep -rn 'FAKE_API_KEY\|demo-not-real' fixedig || echo "clean"
```

```console include="captures/docker-security/secret-fixed-verify.txt"
```

History has no secret, `.Config.Env` has no key, and the layer grep finds
nothing. Only the derived, non-sensitive `build-marker` survives.

## Common patterns

- **Build-time secrets → `--mount=type=secret`.** Private package registries,
  git credentials for a `go mod`/`npm` fetch, an API key needed during build.
- **Run-time secrets → not the image at all.** Inject at runtime via a mounted
  file (Tasklane's `PGPASSWORD_FILE`), Docker/Swarm secrets, a Kubernetes Secret
  mounted as a volume, or an external secret manager. Never `ENV SECRET=...`.
- **Scan images in CI.** Add a secret scanner as a gate so a leaked credential
  fails the build:

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:0.74.0 image --scanners secret secret-copy:vuln
```

Trivy's secret scanner reports the credential and the layer it lives in. Gitleaks
and other scanners do the same in the source repo.

## Production considerations

If a real secret ever reaches a pushed image, treat it as compromised: **rotate
it**, do not just rebuild. The leaked image may already be pulled, cached in a
registry, or in someone's `docker save` archive. Removing the tag does not
un-leak the bytes.

Wire secret scanning into CI for both source (pre-commit, Gitleaks) and built
images (Trivy `--scanners secret`) so leaks fail fast. Prefer runtime injection
over build-time secrets wherever possible; the safest secret is the one the
image never sees.

## Security considerations

Build secret mounts require BuildKit, which is the default builder in Engine 29.
The secret is available only inside the `RUN` that mounts it, so a malicious base
image or a later stage cannot read it. Do not then defeat the mount by writing
the secret to a file (`cat /run/secrets/x > /app/x`) — that puts it back in a
layer. Use it in place.

Provenance and SBOM attestations describe an image but do not scrub secrets;
scanning does. Keep the two concerns separate.

## Troubleshooting

- **"secret not found" during build.** The `id` in `--mount=type=secret,id=X`
  must match `--secret id=X,src=...`. Check both spellings.
- **Secret still shows in history after switching to a mount.** A `RUN` is
  probably still writing it to a file, or an old `ENV`/`ARG` line remains. Grep
  the built image's layers to confirm.
- **Scanner flags an old tag.** The layer is cached; rebuild `--no-cache` and,
  if the secret was real, rotate it and purge the old image from registries.

## Common mistakes

- Believing a later `RUN rm` removes a COPY'd secret (it does not).
- Passing secrets as `--build-arg` and assuming they are ephemeral.
- Promoting an `ARG` secret to `ENV`, baking it into the image config.
- "Fixing" a leak by deleting the tag instead of rotating the credential.
- Reading a mounted build secret into a file, re-introducing it to a layer.

## Related topics

- [Cache and secret mounts](../docker-advanced/cache-and-secret-mounts.md)
- [Dockerfile instructions](../docker-intermediate/dockerfile-instructions.md)
- [Vulnerability scanning](../docker-advanced/vulnerability-scanning.md)
- [Supply chain security](supply-chain-security.md)
- [Compose secrets, configs and scaling](../docker-intermediate/compose-secrets-configs-scaling.md)
