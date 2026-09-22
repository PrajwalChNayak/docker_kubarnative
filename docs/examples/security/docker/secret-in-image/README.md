# Secret-in-image: threat, exploit, fix, verify

**Run only in a disposable lab.** Nothing here is a real secret, but treat the
extraction technique as something you use only on images you own.

`fake-credentials.env` holds obviously fake values (`FAKE_API_KEY=demo-not-real`).
The lesson is about *where the bytes end up*, not the value.

## What is here

| Path | Role |
|---|---|
| `vulnerable/Dockerfile` | COPYs the credential, then `rm`s it in a later layer (still recoverable) |
| `vulnerable/Dockerfile.arg` | passes the secret as `--build-arg` and bakes it into an `ENV` |
| `fixed/Dockerfile` | uses `RUN --mount=type=secret` so the secret never lands in a layer |

## 1. Build the vulnerable images

Run from this directory (`examples/security/docker/secret-in-image`).

```sh
# COPY-then-rm variant
docker build -f vulnerable/Dockerfile -t secret-copy:vuln vulnerable

# build-arg variant
docker build -f vulnerable/Dockerfile.arg \
  --build-arg FAKE_API_KEY=demo-not-real-passed-at-build \
  -t secret-arg:vuln vulnerable
```

## 2. Exploit A — read it straight out of the history

```sh
# The build-arg / ENV value is in the image config verbatim.
docker history --no-trunc secret-arg:vuln
docker inspect --format '{{json .Config.Env}}' secret-arg:vuln
```

`docker history --no-trunc` prints the full `created_by` for every layer;
`docker inspect` prints the baked `FAKE_API_KEY` environment variable.

## 3. Exploit B — unpack the layer tarball

The COPY-then-rm image hides the file from a running container but keeps the
layer that added it. Export the image and walk the layers.

```sh
mkdir -p /tmp/secret-dig && cd /tmp/secret-dig
docker save secret-copy:vuln -o image.tar
tar -xf image.tar
# OCI/Docker save writes each layer as blobs/sha256/<digest> or <layer>/layer.tar.
# Unpack every layer tarball, then grep the whole tree for the marker.
find . -name '*.tar' -exec tar -xf {} \; 2>/dev/null || true
grep -rn 'FAKE_API_KEY' . || echo "not found"
```

`grep` finds `FAKE_API_KEY=demo-not-real` inside the COPY layer even though the
final image has no such file. Deleting a file never rewrites history.

## 4. (Optional) scan instead of digging by hand

```sh
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  aquasec/trivy:0.74.0 image --scanners secret secret-copy:vuln
```

Trivy's secret scanner reports the credential and the layer it lives in.
(Only mount the socket for tooling you trust, on a disposable host.)

## 5. Build the fixed image and verify

```sh
docker build --secret id=api_key,src=./vulnerable/fake-credentials.env \
  -f fixed/Dockerfile -t secret:fixed fixed
```

Re-run the same extractions against `secret:fixed`:

```sh
docker history --no-trunc secret:fixed
docker inspect --format '{{json .Config.Env}}' secret:fixed

docker save secret:fixed -o /tmp/secret-dig/fixed.tar
cd /tmp/secret-dig && rm -rf fixed && mkdir fixed && tar -xf fixed.tar -C fixed
find fixed -name '*.tar' -exec tar -xf {} \; 2>/dev/null || true
grep -rn 'FAKE_API_KEY\|demo-not-real' fixed || echo "clean: nothing found"
```

The history has no secret, `.Config.Env` has no key, and the layer grep finds
nothing. Only the derived, non-sensitive `build-marker` survives.

## Cleanup

```sh
docker image rm secret-copy:vuln secret-arg:vuln secret:fixed
rm -rf /tmp/secret-dig
```
