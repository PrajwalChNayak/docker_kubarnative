---
title: ImagePullBackOff and ErrImagePull
description: Why the kubelet cannot pull an image — wrong tag or digest, registry auth, rate limits, architecture mismatch, private registries and kind load.
level: intermediate
type: troubleshooting
status: current
versions: Kubernetes 1.37, Docker Engine 29
prerequisites:
  - troubleshooting/method
  - docker-beginner/images-tags-digests
  - k8s-beginner/local-clusters
---

## Overview

`ErrImagePull` means the kubelet tried to pull an image and failed;
`ImagePullBackOff` means it has failed enough times that it is now backing off
before retrying. The container never starts, so there are no application logs —
the whole story is in the pod's Events. This page walks the causes from most to
least common: wrong reference, auth, rate limits, architecture and the kind
loading trap.

## Symptoms

- `kubectl get pods` shows `STATUS: ErrImagePull`, then `ImagePullBackOff`.
- `describe pod` Events include `Failed to pull image "..."` with a reason:
  `not found`, `unauthorized`, `no match for platform`, or `toomanyrequests`.
- `RESTARTS` stays at 0 — nothing ran to restart.

Reproducer (an image tag that does not exist):

```yaml include="examples/troubleshooting/imagepullbackoff.yaml"
```

```console include="captures/troubleshooting/imagepull.txt"
```

## How it works underneath

When the kubelet needs an image, it asks the container runtime (containerd) to
pull it, subject to `imagePullPolicy`:

- **`IfNotPresent`** (the default for any tag that is not `:latest`): pull only
  if the node has no image with that reference.
- **`Always`** (the default for `:latest`, and settable explicitly): contact the
  registry every time to check the digest.
- **`Never`**: use only what is already on the node; never pull.

The runtime resolves the reference to a registry, repository and tag or digest,
authenticates if needed, downloads the manifest, and selects the matching
platform from a multi-arch index. Any step can fail, and the message names
which:

| Message fragment | Cause |
|---|---|
| `not found` / `manifest unknown` | wrong repository or tag; the tag was deleted |
| `unauthorized` / `authentication required` | private registry, missing or wrong `imagePullSecrets` |
| `toomanyrequests` | registry rate limit (Docker Hub: 100 pulls / 6h unauthenticated per IPv4 or IPv6 /64) |
| `no match for platform` | image has no variant for the node's CPU architecture |
| `dial tcp ... connect: connection refused` | registry unreachable from the node (network/DNS/proxy) |

### Tag versus digest

A tag is a mutable pointer; a digest (`@sha256:...`) is immutable content. If
you reuse a tag after rebuilding, nodes with the old image cached under
`IfNotPresent` keep running the old bytes and never pull the new ones — a
"fixed" bug that will not go away. Pin by digest for anything that must be
reproducible, exactly as the Tasklane manifests pin `postgres:18-trixie@sha256:...`.

### The kind loading trap

A local image you built with `docker build` exists only in your workstation's
Docker, not on the kind nodes. kind nodes are separate containers with their own
image store. If a manifest references a locally built tag that was never loaded,
the kubelet cannot find it on the node and falls back to pulling it from the
default registry, where it does not exist — `ImagePullBackOff`. The fix is to
load it into the nodes:

```bash
kind load docker-image tasklane-api:0.1.0 --name tasklane
```

This is why the reproducer's `9.9.9-nope` tag fails: no node has it, and Docker
Hub has no such image.

## Diagnosis

1. **Read the exact pull error.**

   ```bash
   kubectl -n <ns> describe pod <pod>
   ```

   The `Events` at the bottom quote the registry's own message. Read it
   literally — it already says not-found vs unauthorized vs rate-limited.

2. **Confirm the reference resolves** from a machine that can reach the
   registry:

   ```bash
   docker manifest inspect <image-ref>
   ```

   A `manifest unknown` here confirms a wrong repository/tag rather than a
   cluster problem.

3. **Check what the node has**, for the kind case:

   ```bash
   docker exec tasklane-control-plane crictl images | grep tasklane
   ```

4. **Check auth.** For a private registry, verify the pod's ServiceAccount or
   pod spec references a working `imagePullSecret`:

   ```bash
   kubectl -n <ns> get secret <pull-secret> -o jsonpath='{.type}'
   ```

   It must be `kubernetes.io/dockerconfigjson`.

## Fixes

- **Wrong tag/repo.** Correct the reference. For a local image, `kind load` it
  (or push it to a registry the nodes can reach).
- **Private registry / unauthorized.** Create a pull secret and attach it:

  ```bash
  kubectl -n <ns> create secret docker-registry regcred \
    --docker-server=<registry> --docker-username=<user> --docker-password=<token>
  ```

  Then reference it via `imagePullSecrets` in the pod spec, or attach it to the
  ServiceAccount so every pod inherits it.
- **Rate limited (`toomanyrequests`).** Authenticate to the registry (a
  Personal Docker Hub login raises the limit to 200/6h; paid plans are
  unlimited), mirror the image into your own registry, or pin and pre-load it.
- **Architecture mismatch (`no match for platform`).** The image has no variant
  for the node's CPU. Build a multi-arch image or the right single arch — see
  [architecture mismatch](architecture-mismatch.md).
- **Registry unreachable.** Fix node DNS/egress or the registry mirror/proxy
  configuration; test with `crictl pull` on the node.

## Prevention

- Reference images by **digest** in production, or at least by a stable,
  immutable tag; never `:latest`.
- Put images in a registry the cluster can actually reach, with credentials
  provisioned before the workload.
- Authenticate pulls to avoid anonymous rate limits, or run a pull-through
  cache/mirror.
- In CI for kind, `kind load` (or push to a local registry) as an explicit step
  before `kubectl apply`.
- Match image architecture to node architecture, and build multi-arch when your
  fleet is mixed.

## Common mistakes

- Rebuilding and reusing the same tag, so `IfNotPresent` nodes keep the old
  image.
- Forgetting `kind load`, then debugging the cluster instead of the missing load.
- Attaching a pull secret of the wrong type, or to the wrong namespace (pull
  secrets are namespaced).
- Blaming the cluster for a `manifest unknown` that is a typo in the tag.
- Ignoring `no match for platform` on an Apple Silicon workstation pushing to an
  amd64 cluster.

## Related topics

- [A method for debugging Kubernetes](method.md)
- [Architecture mismatch](architecture-mismatch.md)
- [CrashLoopBackOff](crashloopbackoff.md)
- [Images, tags and digests](../docker-beginner/images-tags-digests.md)
- [Local clusters](../k8s-beginner/local-clusters.md)
