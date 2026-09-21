# Bake definition for the Tasklane images.
#
#   docker buildx bake -f examples/build/docker-bake.hcl --print
#   docker buildx bake -f examples/build/docker-bake.hcl            # default group
#   docker buildx bake -f examples/build/docker-bake.hcl api        # one target
#   docker buildx bake -f examples/build/docker-bake.hcl --push
#
# Attribute syntax follows the Bake reference for Buildx 0.37 (object form for
# attest, cache-from and cache-to). Older Buildx releases used CSV strings.

variable "REGISTRY" {
  type        = string
  default     = "ghcr.io/example/tasklane"
  description = "Registry namespace the images are pushed to."
}

variable "VERSION" {
  type        = string
  default     = "0.1.0"
  description = "Image tag and the value of the VERSION build arg."
}

variable "CACHE_REF" {
  type        = string
  default     = "ghcr.io/example/tasklane/buildcache"
  description = "Repository that holds the registry cache manifests."
}

# SOURCE_DATE_EPOCH is read from the environment by BuildKit itself. It is
# declared here only so that `--print` shows whether it is set.
variable "SOURCE_DATE_EPOCH" {
  type    = string
  default = ""
}

# The default group is what plain `docker buildx bake` builds.
group "default" {
  targets = ["api", "worker"]
}

# Everything the two images share. `_common` is never built on its own: a
# target whose name starts with an underscore is still buildable by name, so
# it is kept out of every group instead.
target "_common" {
  context    = "../app"
  dockerfile = "Dockerfile"

  # One build, two architectures, one manifest list per tag. The Dockerfile
  # cross-compiles from $BUILDPLATFORM, so arm64 is not emulated under QEMU.
  platforms = ["linux/amd64", "linux/arm64"]

  args = {
    VERSION = VERSION
  }

  labels = {
    "org.opencontainers.image.source"   = "https://github.com/example/tasklane"
    "org.opencontainers.image.version"  = VERSION
    "org.opencontainers.image.licenses" = "Apache-2.0"
  }

  # BuildKit attaches mode=min provenance on its own. mode=max adds the LLB
  # definition and the base64 Dockerfile, and it also records build-arg
  # values, so never combine it with secrets passed as build args.
  # SBOM generation is opt-in; it runs the Syft-based scanner per platform.
  attest = [
    { type = "provenance", mode = "max" },
    { type = "sbom" },
  ]
}

target "api" {
  inherits = ["_common"]
  target   = "api"
  tags = [
    "${REGISTRY}/tasklane-api:${VERSION}",
  ]

  # Registry cache: the cache manifests live in their own repository, so
  # pulling the image never drags the intermediate layers along.
  cache-from = [
    { type = "registry", ref = "${CACHE_REF}:api" },
    { type = "registry", ref = "${CACHE_REF}:api-main" },
  ]
  cache-to = [
    { type = "registry", ref = "${CACHE_REF}:api", mode = "max" },
  ]
}

target "worker" {
  inherits = ["_common"]
  target   = "worker"
  tags = [
    "${REGISTRY}/tasklane-worker:${VERSION}",
  ]

  cache-from = [
    { type = "registry", ref = "${CACHE_REF}:worker" },
    { type = "registry", ref = "${CACHE_REF}:worker-main" },
  ]
  cache-to = [
    { type = "registry", ref = "${CACHE_REF}:worker", mode = "max" },
  ]
}

# Local development: single platform, loaded into the Engine image store,
# no attestations, no remote cache. `--load` only works for one platform.
target "dev" {
  inherits  = ["_common"]
  target    = "api"
  platforms = ["linux/amd64"]
  tags      = ["tasklane-api:dev"]
  attest    = []
  cache-from = [
    { type = "registry", ref = "${CACHE_REF}:api" },
  ]
  cache-to = []
}

# The secret-mount demo from this directory. It is built on its own because
# it uses a different context and needs a secret.
target "secret-demo" {
  context    = "."
  dockerfile = "Dockerfile.secret-demo"
  tags       = ["tasklane-secret-demo:dev"]
  platforms  = ["linux/amd64"]
  secret = [
    { type = "env", id = "NPM_TOKEN" },
  ]
  attest = []
}
