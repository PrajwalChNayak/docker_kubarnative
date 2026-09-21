---
title: CI/CD for Kubernetes
description: The pipeline from commit to running pod - build, test, scan, sign, push by digest, update manifests - and how environments are promoted without branch-per-environment.
level: advanced
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - k8s-advanced/kustomize
  - k8s-advanced/gitops-argo-cd
---

## Overview

A Kubernetes delivery pipeline has two halves that should not be confused.
**CI** turns source code into a signed, immutable image and a manifest change:
it is a build system, it is allowed to fail loudly, and it never touches a
cluster. **CD** turns a manifest change into running pods: it is a
reconciliation loop, it runs inside the target cluster, and it has no idea
what a compiler is.

The joint between them is a single line of YAML — an image reference — and
the discipline of the whole system depends on that reference being a digest
rather than a mutable tag.

This page shows the pipeline for the Tasklane API, ending in the Kustomize
overlays that [Argo CD](gitops-argo-cd.md) or [Flux](gitops-flux.md) then
reconcile.

## Why it exists and when to use it

The tempting shortcut is one pipeline: build, then `kubectl apply`. It works
on day one and fails in three specific ways.

It puts cluster credentials in the CI system, so the CI system becomes the
most valuable target you own. It makes the deployed state unknowable, because
the only record is a job log that expires. And it couples rollback of code to
rollback of configuration: to undo a bad config change you must re-run a
build.

Splitting the halves fixes all three. CI produces artefacts and opens a pull
request. CD is a controller in the cluster that pulls. Rollback of
configuration is `git revert`, and it does not rebuild anything.

The split costs you an extra repository (or at least an extra directory), a
commit between build and deploy, and a few seconds of latency. For a single
developer shipping one service, that overhead is real and the shortcut is
defensible. Past about three services or two environments, it is not.

## How it works underneath

```text title="pipeline.txt"
 commit ──► build ──► test ──► scan ──► sign ──► push by digest
                                                       │
                                                       ▼
                                   update manifest (kustomize edit set image)
                                                       │
                                                       ▼
                                          pull request ──► merge
                                                       │
                       ┌───────────────────────────────┘
                       ▼
   cluster: Argo CD / Flux notices the commit, renders, applies, health-checks
```

Every arrow before the pull request runs in CI with no cluster access. Every
arrow after it runs inside the cluster.

The critical mechanism is the handover. CI resolves the image it just pushed
to a **digest** (`tasklane-api@sha256:…`) and writes that digest into the
manifest. Kubernetes then pulls a specific, immutable set of bytes. A tag can
be moved; a digest cannot. Every later question — "what is running in
production?", "which commit produced it?", "is it signed?" — has exactly one
answer.

## Basic example

The CI half, for the Tasklane API:

```bash
# 1. Build. Provenance attestations are attached by default; SBOM is opt-in.
docker buildx build --target api --sbom=true --provenance=mode=max \
  --tag ghcr.io/prajwalchnayak/tasklane-api:0.2.0 \
  --metadata-file build.json --push examples/app

# 2. Resolve what was actually pushed, as a digest.
DIGEST=$(jq -r '.["containerimage.digest"]' build.json)

# 3. Scan the artefact that will ship, by digest, not the tag.
trivy image --exit-code 1 --severity HIGH,CRITICAL \
  ghcr.io/prajwalchnayak/tasklane-api@"$DIGEST"

# 4. Sign it keylessly with the CI workload identity.
cosign sign --yes ghcr.io/prajwalchnayak/tasklane-api@"$DIGEST"

# 5. Write the digest into the overlay and open a pull request.
cd examples/kustomize/overlays/staging
kustomize edit set image \
  tasklane-api=ghcr.io/prajwalchnayak/tasklane-api@"$DIGEST"
```

Tool versions: Docker Engine 29 with Buildx v0.37.1, Trivy v0.74.0,
cosign **v3.1.3**, Kustomize v5.8.1. `kustomize edit` is in the standalone
Kustomize CLI; `kubectl kustomize` only builds, it cannot edit.

Step 5 leaves a one-line diff in `kustomization.yaml`:

```yaml title="kustomization.yaml" fragment
images:
  - name: tasklane-api
    newName: ghcr.io/prajwalchnayak/tasklane-api
    digest: sha256:<the digest resolved in step 2>
```

Before opening the pull request, prove the overlay still renders and that the
API server accepts every object in it:

```bash
kubectl kustomize examples/kustomize/overlays/staging | kubectl apply --dry-run=client -f - -o name
```

```console include="captures/k8s-advanced/staging-overlay-dry-run.txt"
```

## Explanation

**Why scan after build, by digest.** Scanning the tag you intend to push is a
race: another job can move that tag between scan and deploy. Scanning
`@sha256:…` scans the exact bytes. Note also that a scan is a point-in-time
statement: an image that passed on Monday has new CVEs on Friday, which is
why base-image patching is a scheduled job, not a build-time concern.

**Why sign.** A signature binds "this digest" to "this identity built it".
On its own that proves nothing to the cluster — the value appears when an
admission policy refuses to run unsigned images. Keyless signing with cosign
records the CI workload's OIDC identity in a transparency log, so there is no
private key to leak or rotate.

**Why not a floating tag.** `image: tasklane-api:0.2.0` looks immutable and is
not: whoever can push can re-point it. A rolling tag such as `stable` or
`main` is worse — two pods of the same Deployment can be running different
code, and `kubectl rollout undo` rolls back to the same mutable tag it just
left. The handbook's manifests use explicit version tags for readability and
digests for anything that ships.

**Why a pull request between CI and CD.** The commit is the audit record, the
review is the control, and the revert is the rollback. It also gives you a
place to run policy checks — kubeconform, Pluto, a Kyverno CLI test — on the
rendered manifests before anyone can merge them.

:::best-practice Pin by digest, tag for humans
Push both: a readable tag for `docker pull` and the digest for manifests. A
manifest that names a digest and a comment with the tag is readable *and*
immutable.
:::

## Common patterns

### Automating the manifest commit

Three options, in increasing order of magic:

| Approach | How it works | Trade-off |
|---|---|---|
| CI commits the digest | A pipeline step runs `kustomize edit set image` and opens a PR | Explicit, reviewable, works with any CD tool. Needs a token that can push |
| **Flux image automation** | `ImageRepository` scans the registry, `ImagePolicy` selects a tag, `ImageUpdateAutomation` commits (`image.toolkit.fluxcd.io/v1`) | No CI credentials at all. The cluster writes to Git, which some organisations will not allow |
| **Argo CD Image Updater** | A separate argoproj-labs component that writes back to Git or to Application parameters | Actively developed (v1.3.0), but a distinct project from Argo CD with its own limitations; test it before relying on it |

For production, the first option plus a required review is the least
surprising. Image automation is excellent for dev environments, where the
point is that nobody has to think.

### Environment promotion: directory per environment

The Tasklane layout is a base plus one overlay directory per environment,
all on `main`:

```text title="overlay-layout.txt"
examples/kustomize/
  base/
  overlays/
    dev/
    staging/
    prod/
```

Promotion is a commit that copies one line — the image digest — from
`overlays/staging/kustomization.yaml` to `overlays/prod/kustomization.yaml`.
The diff in the pull request is exactly the change being promoted, and the
history of `overlays/prod` is the deployment history of production.

Automating it is a small script: read the digest from the staging overlay,
write it into the prod overlay, open a PR. Add whatever gate you need —
required reviewers, a green staging soak, a change window — as a branch
protection rule.

### Do not use branch per environment

The other common layout gives each environment a long-lived branch
(`dev`, `staging`, `main`) and promotes by merging. It reads well and goes
wrong for structural reasons:

- **Merges drag unrelated changes.** Merging `staging` into `prod` brings
  every commit on staging, not the one you meant to promote. The usual
  response is cherry-picking, which is a manual, error-prone promotion.
- **Divergence is permanent.** Environment-specific differences live as
  committed differences between branches, so every promotion merge produces
  conflicts in exactly the files that must not be wrong.
- **You cannot see the environments together.** Answering "how does prod
  differ from staging?" needs a cross-branch diff instead of a directory
  diff.
- **Reverting is ambiguous.** Reverting on `prod` and then merging `staging`
  again silently re-applies the reverted change.

Directory-per-environment keeps one branch, one history, and a promotion that
is a visible one-line diff. Use branches for *changes*, not for
*environments*.

:::note What about a separate manifest repository?
A second repository for manifests decouples deploy history from code history
and lets you give CI a narrow push token. It costs you atomic changes: a code
change and its config change land in two pull requests. One repository with
`app/` and `deploy/` directories is a fine middle ground, as long as the CD
tool only watches `deploy/`.
:::

### Preview environments

An ApplicationSet with a `pullRequest` generator, or a Flux Kustomization
created per branch, can stand up a full environment per open pull request and
tear it down on merge. Budget for it: each preview is a real namespace with
real pods, and without a [ResourceQuota](multi-tenancy.md) and a TTL they
accumulate.

## Production considerations

**Pipeline ordering.** Unit tests before the image build if the build is
slow; after, if the tests need the built artefact. Scanning and signing must
be after the push, because both operate on the registry.

**Build caching.** A remote BuildKit cache turns a five-minute Go build into
thirty seconds. Cache backends: `registry` and `local` are stable, `gha` is
beta, `s3` and `azblob` are unreleased.

**Reproducibility.** Pin base images by digest, set `SOURCE_DATE_EPOCH`, and
avoid `apt upgrade` inside builds. Two builds of the same commit producing
different digests makes signatures much less interesting.

**Registry lifecycle.** Digest-pinned manifests mean old images must not be
garbage-collected while any environment still references them. Write a
retention policy that keeps anything referenced by a manifest on `main`.

**Rollback.** With digests in Git, rollback is `git revert` of the promotion
commit, and the CD controller does the rest. Test it; a rollback path nobody
has exercised is a hope, not a plan.

**Cost.** CI minutes and registry storage are the visible costs. The hidden
one is pipeline latency: if commit-to-staging takes forty minutes, people
batch changes, and batched changes are harder to diagnose when they break.

## Security considerations

**Threat: the pipeline is the deployment identity.** Anything that can run in
CI can deploy, and pull requests can modify pipeline definitions.

*Exploit:* a PR from a fork edits the workflow file to add a step that
exfiltrates the kubeconfig or registry token available to the job.

*Fix:* remove cluster credentials from CI entirely (the GitOps split above).
Do not run privileged workflows on pull requests from forks. Scope the
registry token to push only, on one repository.

*Verify:* attempt `kubectl get nodes` from a CI job and expect it to fail for
lack of credentials.

**Threat: an unsigned or substituted image.** Without verification at
admission, anything that reaches the registry path a manifest names will run.

*Exploit:* an attacker with push access re-points the `0.2.0` tag at a
malicious image; the next pod restart runs it.

*Fix:* pin by digest in manifests, and enforce signature verification at
admission with Kyverno v1.19.1 or Sigstore policy-controller so unsigned
digests are rejected regardless.

*Verify:* try to create a Deployment referencing an unsigned digest and
confirm admission rejects it.

**Threat: secrets leaking into images or manifests.** A `COPY . .` that picks
up a `.env`, or a `Secret` committed to the manifest repository.

*Fix:* a `.dockerignore` that excludes credentials, `RUN --mount=type=secret`
for build-time secrets so nothing lands in a layer, and Sealed Secrets
(v0.40.0), SOPS or the External Secrets Operator (v2.11.0) for runtime
secrets.

*Verify:* run a secret scanner over both the repository and the built image
layers in CI, and fail the build on a hit.

**Threat: dependency confusion and unvetted base images.** The supply chain
extends to every layer you did not build.

*Fix:* pin base images by digest, generate an SBOM (`--sbom=true`, Syft
v1.52.0), and scan it. Keep a small allow-list of registries and enforce it
with an admission policy.

## Troubleshooting

**The manifest commit lands but nothing deploys.** The CD tool is watching a
different path, branch or repository than CI is writing to. Check the source
object's `targetRevision`/`ref` and the rendered path.

**`ImagePullBackOff` right after a promotion.** The digest exists in the
build registry but not the one the cluster pulls from, or the node lacks an
imagePullSecret. See [ImagePullBackOff](../troubleshooting/imagepullbackoff.md).

**The pull request renders differently in CI than in the cluster.** Different
Kustomize versions. `kubectl kustomize` embeds a specific Kustomize (v5.8.1
in kubectl 1.37); a standalone binary in CI may differ. Pin both.

**Two pipelines race on the same overlay.** Concurrent merges produce a
conflict in `kustomization.yaml` or, worse, a lost update. Serialise the
promotion job per environment.

**Signature verification fails only in the cluster.** The verifying policy
and the signing identity disagree — usually the wrong issuer or subject
pattern for keyless signing. Reproduce with `cosign verify` using the same
identity constraints the policy uses.

## Common mistakes

- Deploying tags instead of digests, then being unable to say what is
  running.
- Giving the CI system a cluster-admin kubeconfig "just for deploys".
- Branch per environment, discovered to be unworkable after the first
  cherry-picked hotfix.
- Scanning the image before pushing it, so the scanned bytes and the deployed
  bytes are not provably the same.
- Signing an image and never verifying the signature anywhere.
- Letting CI push manifest commits directly to the tracked branch with no
  review, so the audit trail and the control are both gone.
- Treating a passing scan as a permanent property of an image.
- Building in CI and *also* letting image automation rewrite tags, so two
  systems edit the same field and produce commit loops.

## Related topics

- [GitOps with Argo CD](gitops-argo-cd.md)
- [GitOps with Flux](gitops-flux.md)
- [Kustomize](kustomize.md)
- [Helm vs Kustomize](helm-vs-kustomize.md)
- [Progressive delivery](progressive-delivery.md)
- [Image signing with cosign](../docker-advanced/image-signing-cosign.md)
- [SBOMs and provenance](../docker-advanced/sboms-and-provenance.md)
- [Vulnerability scanning](../docker-advanced/vulnerability-scanning.md)
- [Supply chain admission](../k8s-security/supply-chain-admission.md)
- [Docker in CI](../docker-advanced/docker-in-ci.md)
