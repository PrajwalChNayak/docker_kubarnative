---
title: OCI specifications
description: The image, runtime and distribution specs — manifests, indexes, configs, digests, bundles and the container lifecycle.
level: foundations
type: concept
status: current
versions: OCI image-spec 1.1, runtime-spec 1.3, distribution-spec 1.1, containerd 2.x, Docker Engine 29
prerequisites:
  - foundations/what-containers-solve
  - foundations/overlay-filesystems
---

## Overview

Three specifications from the Open Container Initiative define everything that
moves between tools:

| Spec | Answers | v1.0 | Latest at the time of writing |
|---|---|---|---|
| **image-spec** | What is an image? | 2017-07-19 | 1.1.0 (2024-02-15) |
| **runtime-spec** | How is a container started from a filesystem bundle? | 2017-07-19 | 1.3.0 (2025-04-29) |
| **distribution-spec** | How are images pushed and pulled? | 2021-05-05 | 1.1.0 (2024-02-15) |

Because these are separate specs, you can build with BuildKit, store in any
conformant registry, and run under containerd, CRI-O or Podman. Nothing in that
sentence mentions a vendor, which was the point.

## Why it exists and when to use it

You need this page when a digest does not match, when a multi-platform pull
picks the wrong architecture, when you sign or scan images, or when you want to
know what `docker run` actually sends to the kernel.

It is also the foundation for supply chain work: signatures, SBOMs and
provenance attestations are all objects stored *next to* the image in a
registry, addressed by the image's digest, and that only works because the
formats are specified.

## How it works underneath

### Content addressing

Everything in an image is a **blob** identified by the digest of its bytes,
usually `sha256:<64 hex chars>`. A manifest lists blobs by digest; an index
lists manifests by digest. Change one byte anywhere and every digest above it
changes.

This is what makes `image@sha256:…` an exact reference, and a tag merely a
mutable pointer. Pull by digest and you either get exactly those bytes or an
error.

### Image index

A multi-platform image is an **index** (media type
`application/vnd.oci.image.index.v1+json`): a list of manifest descriptors,
each with a `platform` object (`os`, `architecture`, `variant`). The client
picks the entry matching the node and pulls that manifest.

```bash
docker buildx imagetools inspect --raw <image>@sha256:<digest>
```

```console include="captures/foundations/image-index-raw.txt"
```

```console include="captures/foundations/image-platforms.txt"
```

Docker's older equivalents (`application/vnd.docker.distribution.manifest.list.v2+json`
and `…manifest.v2+json`) are still served widely; registries and clients handle
both.

### Manifest and config

A **manifest** (`application/vnd.oci.image.manifest.v1+json`) is small. It
contains:

- `config`: a descriptor pointing to the image configuration blob
- `layers`: an ordered list of layer descriptors
  (`application/vnd.oci.image.layer.v1.tar+gzip`, or `+zstd`)
- optionally `subject` and `artifactType` (image-spec 1.1), which is how an
  artifact such as a signature or SBOM attaches itself to an image

The **config** blob holds what the runtime needs to *run* the image:
`Entrypoint`, `Cmd`, `Env`, `User`, `WorkingDir`, `ExposedPorts`, `Labels`,
plus `rootfs.diff_ids` (the digests of the *uncompressed* layers) and the
`history` entries. Note the double identity of every layer: the manifest
records the digest of the compressed blob as stored, and the config records the
`diff_id` of the uncompressed content. Snapshotters chain `diff_id`s to compute
the chain IDs that name unpacked snapshots.

```bash
docker buildx imagetools inspect <image>@sha256:<digest> --format '{{json .Manifest}}'
docker buildx imagetools inspect <image>@sha256:<digest> --format '{{json .Image}}'
```

```console include="captures/foundations/image-manifest-and-config.txt"
```

The structure, with placeholders where the capture has real digests:

```json title="example-manifest.json" fragment
{
  "schemaVersion": 2,
  "mediaType": "application/vnd.oci.image.manifest.v1+json",
  "config": {
    "mediaType": "application/vnd.oci.image.config.v1+json",
    "digest": "sha256:<config digest>",
    "size": 1234
  },
  "layers": [
    {
      "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
      "digest": "sha256:<layer digest>",
      "size": 567890
    }
  ]
}
```

### Distribution: how bytes move

The distribution spec is a small HTTP API rooted at `/v2/`:

| Operation | Request |
|---|---|
| Check support | `GET /v2/` |
| Fetch a manifest or index | `GET /v2/<name>/manifests/<tag or digest>` |
| Fetch a blob | `GET /v2/<name>/blobs/<digest>` |
| Start an upload | `POST /v2/<name>/blobs/uploads/` |
| List tags | `GET /v2/<name>/tags/list` |
| List referrers (1.1) | `GET /v2/<name>/referrers/<digest>` |

A pull is: get the index, choose a manifest by platform, get the manifest, get
the config, then get each layer blob that the node does not already have.
Clients verify every blob's digest, which is why a corrupted or tampered layer
fails rather than runs.

The **referrers API** in 1.1 is how signatures, SBOMs and provenance
attestations are discovered: they are artifacts whose `subject` is the image's
manifest digest. See
[image signing](../docker-advanced/image-signing-cosign.md) and
[SBOMs and provenance](../docker-advanced/sboms-and-provenance.md).

### Runtime: bundles, config.json and lifecycle

The runtime spec knows nothing about images or registries. Its input is a
**filesystem bundle**: a directory containing `config.json` and a root
filesystem. Higher layers (containerd, CRI-O, Docker) turn an image into a
bundle; `runc` consumes it.

`config.json` is the complete description of the container:

- `process`: `args`, `env`, `cwd`, `user`, `capabilities` (all five sets),
  `rlimits`, `noNewPrivileges`, `apparmorProfile`, `selinuxLabel`
- `root`: `path` and `readonly`
- `mounts`: every mount, in order
- `hostname`, `domainname`
- `linux.namespaces`: which namespaces to create or join (by path)
- `linux.resources`: the cgroup limits
- `linux.seccomp`: architectures, default action, syscall rules
- `linux.maskedPaths` and `linux.readonlyPaths`: the `/proc` and `/sys` entries
  that are hidden or forced read-only
- `hooks`: `createRuntime`, `createContainer`, `startContainer`, `poststart`,
  `poststop`

You can read the real thing for a running pod straight from the runtime:

```console include="captures/foundations/api-oci-namespaces.txt"
```

```console include="captures/foundations/runtime-bundle.txt"
```

`maskedPaths` and `readonlyPaths` are visible from the outside as mounts in the
container's mount table — `/proc/kcore` and friends replaced by `/dev/null`,
and parts of `/proc` and `/sys` mounted read-only:

```console include="captures/foundations/api-masked-paths.txt"
```

The **lifecycle** is a small state machine: `create` (namespaces, cgroups,
mounts and the process are set up, but the user process is not started, state
becomes `created`), `start` (the process runs, state `running`), `kill`
(signal), `delete` (state `stopped` → gone), with `state` queryable throughout.
The gap between `create` and `start` is what allows a supervisor to configure
networking before the workload's first instruction — which is exactly what CNI
plugins and hooks use.

## Basic example

The bundle for a running Tasklane container lives under containerd's task
directory on the node; the capture above lists it. The important observation is
what it contains: a `config.json`, a `rootfs` mount point, and the shim's
sockets. There is no image, no registry, no Kubernetes — by the time `runc`
runs, all of that has been resolved into one JSON file and one directory.

## Explanation

Understanding the split explains several everyday behaviours.

**Why `docker export` and `docker save` differ.** `export` flattens a
container's filesystem to a tar: that is a root filesystem, not an image, and
it drops the config (entrypoint, env, user). `save` writes the image with its
manifest, config and layers. The
[from-scratch example](../../examples/foundations/container-from-scratch/README.md)
uses `export` deliberately, because it wants only the filesystem.

**Why the same image has different digests in different registries.** Copying
an image can re-compress layers or convert media types; the *content* is equal
but the *bytes* are not. Use a digest from the registry you pull from, and
prefer copy tools that preserve digests.

**Why "the image did not change but the digest did."** Build timestamps,
attestations and ordering all count as content. Reproducible builds are a
discipline, not a default; see
[reproducible builds](../docker-advanced/reproducible-builds.md).

**Why a signature is not "in" the image.** It is a separate artifact whose
subject is the image digest, discovered through the referrers API.

## Common patterns

| Pattern | Why |
|---|---|
| Deploy by digest, tag for humans | the digest is immutable; the tag is a pointer |
| One index per release covering amd64 and arm64 | nodes pick their own platform |
| Attach SBOM and provenance as referrers | scanning and policy without rebuilding |
| Mirror through a pull-through cache | Docker Hub rate limits are per 6 hours: 100 unauthenticated, 200 Personal |
| Keep the runtime spec in mind when debugging | most "Kubernetes" runtime errors are `config.json` facts |

## Production considerations

- **Registries are a dependency of your deployments.** If the registry is down
  and the node has not cached the image, the pod does not start. Mirrors and
  pre-pulled images are availability features.
- **Media types still vary in the wild.** Older clients, older registries and
  some appliances do not handle every OCI media type; test before standardising
  on zstd layers or artifact manifests.
- **Digest pinning changes your upgrade workflow.** It is strictly better for
  reproducibility and requires automation (Renovate, Dependabot) to stay
  patched.
- **Garbage collection is registry-side too.** Untagged manifests and orphaned
  blobs accumulate; most registries need a scheduled GC.

## Security considerations

- **A digest is an integrity guarantee, not a trust decision.** It says the
  bytes are the ones you named; it says nothing about who built them. Signing
  adds the identity.
- **Tags are mutable by design.** A tag you deployed last week may point
  somewhere else today. Admission policies that require digests exist for this
  reason; see [supply chain admission](../k8s-security/supply-chain-admission.md).
- **The registry is a distribution channel for code.** Treat credentials, push
  access and pull-through caches with the same care as your CI system.
- **`config.json` is where security decisions become real.** A pod spec that
  looks hardened but produces a `config.json` with full capabilities means
  something dropped the setting in between. Read the runtime spec from the node
  when verifying, as the captures on this page do.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `exec format error` | the wrong platform's manifest was pulled; check the index and the node architecture |
| `manifest unknown` | the tag or digest does not exist in that repository |
| `unsupported media type` | old client or registry against a newer artifact type |
| Digest mismatch after copying an image | re-compression during the copy; copy with a digest-preserving tool |
| `ImagePullBackOff` | see [ImagePullBackOff](../troubleshooting/imagepullbackoff.md); usually auth, rate limit, or a wrong name |
| Pull works locally, fails on a node | the node lacks credentials or network to the registry |

## Common mistakes

- **Confusing the index digest with the manifest digest.** A per-platform
  digest is not the multi-platform reference, and pinning the wrong one breaks
  the other architecture.
- **Assuming an image "is" a tar of a filesystem.** It is a manifest, a config
  and a list of compressed layers.
- **Editing an image by hand.** Any change invalidates every digest above it,
  including signatures.
- **Ignoring `diff_id` versus layer digest** when reasoning about caches: one
  is compressed, the other is not.
- **Treating the runtime spec as Docker-specific.** It is the contract every
  OCI runtime implements, including gVisor's `runsc` and Kata's shim.

## Related topics

- [Overlay filesystems](overlay-filesystems.md)
- [The container runtime stack](runtime-stack.md)
- [A history of containers](history-of-containers.md)
- [Images, tags and digests](../docker-beginner/images-tags-digests.md)
- [Registries](../docker-advanced/registries.md)
- [Multi-platform builds](../docker-advanced/multi-platform-builds.md)
- [Image signing with cosign](../docker-advanced/image-signing-cosign.md)
- [SBOMs and provenance](../docker-advanced/sboms-and-provenance.md)
