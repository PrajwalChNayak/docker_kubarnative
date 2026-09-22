# cache-ordering — instruction order decides your rebuild time

Two Dockerfiles for the same tiny app. They differ only in where the `COPY`
of the application source sits relative to the expensive dependency step.

| File | Order | Rebuild after editing `app.py` |
|---|---|---|
| `Dockerfile.unordered` | `COPY . .` then install | install runs again |
| `Dockerfile.ordered` | `COPY requirements.txt`, install, `COPY app.py` | install is cached |

The "install" here is `sleep 10`, so the demo is deterministic and needs no
network. A real `pip install`, `npm ci` or `go mod download` behaves the same
way and usually costs more than ten seconds.

## Measure it

```bash
docker build -f examples/dockerfiles/cache-ordering/Dockerfile.unordered -t cacheorder-unordered:0.1.0 examples/dockerfiles/cache-ordering
docker build -f examples/dockerfiles/cache-ordering/Dockerfile.ordered   -t cacheorder-ordered:0.1.0   examples/dockerfiles/cache-ordering
echo "# touched $(date -Is)" >> examples/dockerfiles/cache-ordering/app.py
time docker build -f examples/dockerfiles/cache-ordering/Dockerfile.unordered -t cacheorder-unordered:0.1.0 examples/dockerfiles/cache-ordering
time docker build -f examples/dockerfiles/cache-ordering/Dockerfile.ordered   -t cacheorder-ordered:0.1.0   examples/dockerfiles/cache-ordering
git checkout -- examples/dockerfiles/cache-ordering/app.py
```

The second pair of builds is the interesting one: the unordered build pays the
ten seconds again, the ordered one prints `CACHED` for the `RUN` step.

## Why

For `COPY` and `ADD` (and `RUN --mount=type=bind`), BuildKit computes a cache
key from the *contents and metadata* of the files involved, not from the
instruction text alone. `mtime` is excluded, so touching a file without
changing it does not invalidate anything. For every other instruction, the
key is the instruction string plus the parent layer's key — which is why
`RUN apt-get update` happily reuses a cache from last month.

Once a step misses, every later step misses too: each cache key includes the
parent's. So the rule is to put what rarely changes first.

## Notes

- `docker build --no-cache-filter <stage>` forces one stage to rebuild
  without discarding the rest of the cache.
- The `.dockerignore` file matters here as well: if `COPY . .` drags in
  `.git/` or a local virtualenv, the dependency layer is invalidated by files
  that have nothing to do with the build.
- Both images run as UID 65534 and need no root at runtime.
