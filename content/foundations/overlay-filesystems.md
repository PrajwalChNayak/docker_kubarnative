---
title: Overlay filesystems
description: How lowerdir, upperdir and workdir turn image layers into a container root filesystem, and what copy-up and whiteouts cost you.
level: foundations
type: concept
status: current
versions: Linux kernel 6.x, Docker Engine 29, containerd 2.x, Kubernetes 1.37
prerequisites:
  - foundations/what-containers-solve
  - foundations/linux-namespaces
---

## Overview

An image is a stack of read-only layers. A container needs a writable root
filesystem. Overlayfs is the kernel feature that reconciles those two facts:
it presents several directories as one merged tree, where reads fall through
to the layers below and writes land in a single writable directory on top.

That is why a hundred containers from the same image cost one copy of the image
on disk, why the first write to a large file inside a container is slow, and
why anything you write inside a container disappears when it is deleted.

## Why it exists and when to use it

Without a union filesystem, starting a container would mean copying the whole
image's filesystem — hundreds of megabytes, every time. Overlayfs makes
container start-up independent of image size once the layers are unpacked, and
makes layer reuse across images automatic: if two images share a base, the
shared layers are unpacked once per node.

You do not choose to use it; the runtime does. You need to understand it when
you care about image size, container start-up time, write performance, disk
consumption on nodes, or where a file actually lives.

## How it works underneath

### The four directories

An overlay mount has:

- **`lowerdir`** — one or more read-only directories, searched left to right.
  These are the image layers.
- **`upperdir`** — the single writable directory. This is the container's
  writable layer.
- **`workdir`** — an empty directory on the same filesystem as `upperdir`, used
  by the kernel for atomic internal operations. It is not part of the merged
  view.
- **`merged`** — the mount point where the union appears.

Reads resolve top-down: upper first, then each lower in order. The first match
wins, so a file in a higher layer shadows the same path lower down.

### Copy-up

Overlayfs is **copy-on-write at file granularity**. Open a file from a lower
layer for writing and the kernel copies the *entire* file to `upperdir` first,
then applies the write. A one-byte change to a 2 GiB file copies 2 GiB.

The consequences are practical: databases and other write-heavy workloads
should write to a volume, not to the container's writable layer; and a
container that modifies large image files at start-up pays for it every start.

### Whiteouts and opaque directories

Deleting a file that exists in a lower layer cannot delete it — the layer is
read-only. Instead overlayfs creates a **whiteout**: a character device with
device number 0/0 at that path in `upperdir`, which hides the lower entry.
Removing a whole directory creates an **opaque directory**, marked with the
extended attribute `trusted.overlay.opaque=y`.

Image layers encode the same idea on the wire with filenames: an OCI layer tar
marks a deletion with a `.wh.<name>` entry, and an opaque directory with
`.wh..wh..opq`. That is why deleting files in a later Dockerfile layer never
shrinks the image: the bytes are still in the earlier layer, and you have added
a whiteout on top.

### Seeing it work

```bash
mkdir -p /tmp/o/{lower,upper,work,merged}
echo "from the image layer" > /tmp/o/lower/file.txt
mount -t overlay overlay \
  -o lowerdir=/tmp/o/lower,upperdir=/tmp/o/upper,workdir=/tmp/o/work \
  /tmp/o/merged
```

```console include="captures/foundations/overlay-copy-up.txt"
```

The capture writes through the merged view, shows the copy in `upperdir`, shows
`lowerdir` untouched, then deletes the file and shows the whiteout device that
replaces it.

### Where the runtime puts all this

**containerd** does not mount overlays directly from image layers; it goes
through a **snapshotter**. The snapshotter turns layer content into snapshots
and hands the runtime a list of mounts. The default is `overlayfs`; others
include `native` (full copies), `btrfs`, `zfs`, `devmapper`, and remote
snapshotters (stargz, SOCI, Nydus) that start a container before the layers are
fully downloaded.

```bash
docker exec tasklane-control-plane ctr -n k8s.io snapshots list
docker exec tasklane-control-plane ls /var/lib/containerd
```

```console include="captures/foundations/ctr-snapshots.txt"
```

```console include="captures/foundations/containerd-image-store.txt"
```

Content-addressed blobs live in the content store; unpacked snapshots live
under the snapshotter's directory. On Docker Engine 29 with the containerd
image store — the default on fresh installs — the same structure holds, in
containerd's `moby` namespace rather than the `k8s.io` one Kubernetes uses.

And this is what the mount looks like for a running container:

```console include="captures/foundations/api-rootfs-mount.txt"
```

## Basic example

Tasklane's final image is a distroless base plus one binary, so its layer stack
is short and its writable layer should stay empty. The manifests make that
explicit:

```yaml include="examples/k8s/03-app/api.yaml" lines="123-127"
```

`readOnlyRootFilesystem: true` mounts the merged view read-only. Any write the
process attempts fails immediately rather than silently filling the node's
disk, and anything that genuinely needs to be writable has to be declared as a
volume — usually an `emptyDir` for scratch space.

## Explanation

Three properties follow directly from the design.

**Layer sharing is per node, not per image.** Two images that share a base
share the unpacked snapshots on any node that has both. This is why pinning a
common base image across your fleet is a real cost saving, and why a "small"
image built on a base nobody else uses can cost more disk than a larger one on
a shared base.

**Layer order dictates cache behaviour.** Changing a file invalidates its layer
and every layer after it, both at build time and at pull time. Dependencies
before source code, always. See
[layer caching](../docker-intermediate/layer-caching.md).

**Writable layers are invisible in your image inventory.** They are created per
container, not tracked as artifacts, and they grow until the container dies. A
logging application that writes to a file inside the container will fill the
node's disk and take down every workload on it.

## Common patterns

| Goal | Mechanism |
|---|---|
| Scratch space that can be large | `emptyDir` volume (optionally `medium: Memory`) |
| Durable data | PersistentVolumeClaim; see [PVs and PVCs](../k8s-intermediate/persistent-volumes-and-claims.md) |
| Config files the app rewrites | write into an `emptyDir`, seed it from a ConfigMap |
| Smaller images | multi-stage builds, distroless bases, fewer and better-ordered layers |
| Faster cold starts on big images | shared bases, image pre-pull, or a remote snapshotter |

## Production considerations

- **Node disk is a shared resource.** Image layers, writable layers, logs and
  `emptyDir` volumes all consume the same filesystem. When it fills, the
  kubelet starts evicting pods and image garbage collection kicks in.
- **Image garbage collection is threshold-driven.** The kubelet deletes unused
  images when disk usage crosses its high threshold. A node that pulls many
  distinct images will thrash; standardise bases.
- **Docker's disk usage grows quietly.** Build cache, dangling images, stopped
  containers and volumes all persist; see
  [cleanup and disk usage](../docker-beginner/cleanup-and-disk-usage.md).
- **Overlayfs has filesystem-specific quirks.** `upperdir` and `workdir` must
  live on the same filesystem, some backing filesystems do not support the
  required extended attributes, and inode exhaustion is a real failure mode on
  nodes with many layers.
- **Never bind-mount a path from one container's writable layer into another.**
  It is an implementation detail and it moves.

## Security considerations

- **A read-only root filesystem is cheap and effective.** It stops an attacker
  dropping tools into the container, blocks in-place modification of binaries,
  and turns "download and run this payload" into an error. Pair it with
  `emptyDir` for the paths that must be writable. See
  [read-only root filesystem](../docker-security/read-only-root-filesystem.md).
- **Deleted files are still in the image.** Removing a file in a later build
  step removes it from the merged view only; the blob still contains it and
  anyone who pulls the image can extract it. Use build secrets instead; see
  [secrets in images](../docker-security/secrets-in-images.md).
- **Layer contents are content-addressed and therefore verifiable.** The
  digests in the image manifest cover the exact bytes of each layer, which is
  what makes pinning by digest meaningful; see
  [OCI specifications](oci-specifications.md).
- **Snapshot directories on the node are root-owned for a reason.** Anything
  that can write into them can modify what every container on that node sees.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Container disk usage grows without bound | the application writes to the writable layer instead of a volume |
| First write to a big file is very slow | copy-up of the whole file from a lower layer |
| Image "deleted" files still discoverable | whiteouts hide, they do not remove; the lower layer still has the bytes |
| `no space left on device` with free space showing | inodes exhausted, or a different filesystem than you think |
| Pods evicted with `DiskPressure` | node filesystem full: images, logs, writable layers or `emptyDir` |
| Permission errors writing to a mounted path | read-only root filesystem, or an SELinux label; see [AppArmor and SELinux](apparmor-and-selinux.md) |

## Common mistakes

- **Deleting files in a later layer to shrink an image.** Use a multi-stage
  build so the bytes never enter the final image.
- **Treating the writable layer as storage.** It is scratch space with no
  lifecycle guarantees.
- **Assuming `docker system df` covers everything on a Kubernetes node.** The
  kubelet's images live in containerd's store, not Docker's.
- **Building images with dozens of tiny layers "for caching".** Every layer has
  overhead at pull and mount time; order matters more than count.
- **Copying a whole build context into the image.** See
  [build context and .dockerignore](../docker-intermediate/build-context-and-dockerignore.md).

## Related topics

- [OCI specifications](oci-specifications.md)
- [The container runtime stack](runtime-stack.md)
- [What containers actually solve](what-containers-solve.md)
- [Layer caching](../docker-intermediate/layer-caching.md)
- [Multi-stage builds](../docker-intermediate/multi-stage-builds.md)
- [Volumes, bind mounts and tmpfs](../docker-intermediate/volumes-bind-mounts-tmpfs.md)
- [Read-only root filesystem](../docker-security/read-only-root-filesystem.md)
- [Storage classes and CSI](../k8s-intermediate/storage-classes-and-csi.md)
