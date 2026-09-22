# size-naive-vs-optimised — where the megabytes go

The same eleven-line Go HTTP server, packaged two ways.

| File | Final base | What ships |
|---|---|---|
| `Dockerfile.naive` | `golang:1.27-trixie` | compiler, module cache, source, Debian userland, binary |
| `Dockerfile.optimised` | `gcr.io/distroless/static-debian13:nonroot` | binary, CA certificates, `/etc/passwd`, timezone data |

## Build and compare

```bash
docker build -f examples/dockerfiles/size-naive-vs-optimised/Dockerfile.naive     -t sizedemo-naive:0.1.0     examples/dockerfiles/size-naive-vs-optimised
docker build -f examples/dockerfiles/size-naive-vs-optimised/Dockerfile.optimised -t sizedemo-optimised:0.1.0 examples/dockerfiles/size-naive-vs-optimised
docker image ls sizedemo-naive:0.1.0 sizedemo-optimised:0.1.0
docker history sizedemo-naive:0.1.0
docker history sizedemo-optimised:0.1.0
```

`docker history` is the tool that answers "which instruction added this?".
Read it bottom-up: the base image layers first, then one line per
layer-producing instruction with its size.

Both images serve the same page:

```bash
docker run -d --name size-opt -p 8080:8080 sizedemo-optimised:0.1.0
curl -s localhost:8080
docker rm -f size-opt
```

## What each change buys you

- **Multi-stage** is the single biggest win. The `golang` image is a build
  environment; nothing in it is needed at runtime for a static binary.
- **`CGO_ENABLED=0`** removes the dependency on the dynamic loader and libc,
  which is what makes `static-debian13` (or `scratch`) possible at all. With
  cgo enabled you need at least `gcr.io/distroless/base-debian13`.
- **`-ldflags="-s -w"`** strips the symbol table and DWARF data from the
  binary. It also removes the information that `perf`, `delve` and
  `addr2line` need, so keep an unstripped copy if you symbolise crashes.
  `-trimpath` removes build-machine paths, which helps reproducibility.
- **Cache mounts** (`RUN --mount=type=cache`) keep the Go build cache out of
  the image entirely while making rebuilds fast. A `RUN` that writes to a
  cache mount adds nothing to the layer.

## Notes

- Size numbers depend on the architecture and on the exact base image
  digests, so this README deliberately quotes none. Run the commands above.
- The naive image is not a strawman: a single build-and-run stage is what
  most first Dockerfiles look like, and it works — it is just large, slow to
  pull, and ships a compiler to production.
- Both images run unprivileged (65534 and 65532).
