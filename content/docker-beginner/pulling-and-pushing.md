---
title: Pulling and pushing images
description: Move images between your machine and a registry, understand Docker Hub's pull limits, and push to a registry you control.
level: beginner
type: tutorial
status: current
versions: Docker Engine 29
prerequisites:
  - docker-beginner/images-tags-digests
---

## Overview

A registry is an HTTP API that stores manifests and blobs. `docker pull`
fetches them, `docker push` uploads them, and `docker login` obtains a token
for the ones that need authentication. Nothing else about the format is
Docker-specific: the same registry serves containerd, Podman, Kubernetes and
Buildx, because they all speak the OCI distribution specification.

This page covers the everyday operations, the Docker Hub rate limits that
stop CI pipelines at the worst possible moment, and a full push round trip
against a registry running locally.

## Pulling

```bash
docker pull alpine:3.22
docker pull busybox:1.37-musl@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23
```

```console include="captures/docker-beginner/pull-tag.txt"
```

What happens: the daemon resolves the reference, requests the manifest (or
index) for your platform, compares the layer digests against what it already
has, and downloads only the missing blobs. Layers shared with another image
are not downloaded again, and each layer is verified against its digest.

Pulling by digest is the same operation with the tag lookup skipped:

```console include="captures/docker-beginner/pull-digest.txt"
```

You rarely need `docker pull` explicitly. `docker run` pulls when the image is
missing (`--pull missing`, the default). Pull explicitly when you want the
download to happen at a predictable time — before a maintenance window, or in
a CI step whose failure is easy to read.

To force a refresh of a moving tag:

```bash
docker pull alpine:3.22
docker run --rm --pull always alpine:3.22 true
```

## Docker Hub rate limits

Docker Hub counts pulls per **6 hours**:

| Who | Limit per 6 hours |
|---|---|
| Unauthenticated | **100**, per IPv4 address or IPv6 /64 subnet |
| Personal (authenticated) | **200** |
| Pro, Team, Business | Unlimited |

Two details decide whether this hurts you:

- "A Docker pull includes both a version check and any download that occurs as
  a result of the pull", and version checks do not count towards usage
  pricing.
- "A pull for a multi-arch image will count as one pull for each different
  architecture."

The failure looks like `toomanyrequests: You have reached your pull rate
limit`. On a shared network — an office, a CI runner pool, a NAT gateway —
every machine shares one IPv4 address, so 100 pulls disappear quickly.

You can query your remaining allowance from the registry's own headers:

```bash
TOKEN=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:ratelimitpreview/test:pull" | sed -E 's/.*"token":"([^"]+)".*/\1/')
curl -s --head -H "Authorization: Bearer $TOKEN" https://registry-1.docker.io/v2/ratelimitpreview/test/manifests/latest | grep -i '^ratelimit'
```

```console include="captures/docker-beginner/hub-ratelimit.txt"
```

The headers are `ratelimit-limit` and `ratelimit-remaining`, both with a
`;w=21600` window in seconds. An account on an unlimited plan returns no such
headers at all.

:::tip Fixes, in order of effort
1. `docker login` on every machine and CI runner. Authenticated pulls double
   the allowance and are attributed to the account, not the IP address.
2. Cache: run a pull-through mirror, or host the images you depend on in a
   registry you control.
3. Pin by digest and pull once per build, not once per job step.
:::

## Logging in

```bash
docker login
docker login registry.example.com
docker logout registry.example.com
```

`docker login` stores a token (or a reference to a credential helper) in
`~/.docker/config.json`. On a shared or CI machine, prefer a short-lived
token or a registry-specific credential helper over a personal password, and
remember that `sudo docker` reads root's config file, not yours.

:::warning `docker login` in CI logs
Passing a password with `--password` puts it in the process list and often in
the build log. Use `--password-stdin`:

```bash
echo "$REGISTRY_TOKEN" | docker login registry.example.com --username ci --password-stdin
```
:::

## Pushing

A push needs three things: a tag that names the destination registry and
repository, credentials for it, and the right to create that repository.

```bash
docker image tag tasklane-api:0.1.0 registry.example.com/team/tasklane-api:0.1.0
docker push registry.example.com/team/tasklane-api:0.1.0
```

The tag *is* the destination. `docker push tasklane-api:0.1.0` would try
Docker Hub under your account, which is almost never what you meant.

The whole round trip works against a registry running on your own machine,
which is also the easiest way to see what a push does without publishing
anything:

```bash
docker run -d --name hb-registry -p 127.0.0.1:5000:5000 registry:3
docker image tag alpine:3.22 localhost:5000/handbook/alpine:3.22
docker push localhost:5000/handbook/alpine:3.22
docker image rm localhost:5000/handbook/alpine:3.22
docker pull localhost:5000/handbook/alpine:3.22
docker rm -f hb-registry
```

```console include="captures/docker-beginner/push-local-registry.txt"
```

The push uploads each blob the registry does not already have, then the
manifest, and prints the manifest digest. That digest is the one to record and
deploy.

Registries on `localhost` are treated as insecure-by-default, which is why
plain HTTP works here. Any other host needs TLS, or an explicit
`insecure-registries` entry in `daemon.json` — a setting to avoid outside a
lab.

## Where images actually live

| Reference | Registry |
|---|---|
| `alpine:3.22` | `docker.io/library/alpine:3.22` (Docker Hub, official image) |
| `bitnamisecure/postgresql` | Docker Hub, that namespace |
| `gcr.io/distroless/static-debian13:nonroot` | Google Container Registry |
| `ghcr.io/org/app:1.2.3` | GitHub Container Registry |
| `localhost:5000/handbook/alpine:3.22` | Your own registry |

Registry choice, retention policies, garbage collection and pull-through
caching are covered in [Registries](../docker-advanced/registries.md).

## Common mistakes

- **Pushing without tagging for the destination.** The tag carries the
  registry host; there is no `--registry` flag.
- **`docker login` without a registry argument** when you meant a private one:
  that logs you into Docker Hub.
- **Hitting the rate limit in CI and blaming the network.** Read the error;
  `toomanyrequests` is unmistakable.
- **Using `--password` on the command line.** Use `--password-stdin`.
- **Pushing `:latest` as the only tag.** You lose the ability to roll back.
- **Expecting `docker push` to push every tag.** It pushes the one reference
  you name, unless you pass `--all-tags`.
- **Adding a registry to `insecure-registries` to make an error go away.**
  That disables TLS verification for every pull from that host.

## Related topics

- [Images, tags and digests](images-tags-digests.md)
- [Cleanup and disk usage](cleanup-and-disk-usage.md)
- [Registries](../docker-advanced/registries.md)
- [Docker in CI](../docker-advanced/docker-in-ci.md)
- [Supply chain security](../docker-security/supply-chain-security.md)
- [ImagePullBackOff](../troubleshooting/imagepullbackoff.md)
