---
title: Base image patching
description: Keep pinned base images patched by rebuilding on upstream updates and automating digest bumps with Renovate or Dependabot.
level: advanced
type: concept
status: current
versions: Docker Engine 29
prerequisites:
  - docker-security/supply-chain-security
  - docker-intermediate/choosing-base-images
---

## Overview

Pinning a base image by digest is essential for reproducibility and supply chain
integrity, but it freezes the image in time: a pinned digest never receives the
security fixes that later upstream rebuilds contain. Base-image patching is the
discipline of *deliberately* moving the pin forward — rebuilding when the base
publishes a patched image — so you get reproducibility without staleness. This
page covers the cadence and the automation that makes it sustainable.

## Why it exists and when to use it

Most CVEs in a container come from the base image and its OS packages, not your
code. A pinned `golang:1.27-trixie@sha256:...` that was clean at build time
accumulates known vulnerabilities as new CVEs are disclosed against its packages.
Nothing about the image changes; the world's knowledge of it does. Patching
means rebuilding against the upstream's fixed rebuild and re-releasing.

Every project that pins digests needs this. Without it, "we pin for security"
quietly becomes "we run months-old, unpatched bases".

## How it works underneath

An image reference has two parts: a human tag (`golang:1.27-trixie`) and a
content digest (`@sha256:...`). Upstream publishers rebuild tags regularly — to
pull in OS security updates — which produces a *new* digest under the *same* tag.
Your pinned digest keeps pointing at the old bytes until you change it.

The workflow is therefore:

1. **Pin by digest** for reproducibility (tag kept alongside for humans).
2. **Detect** when the tag's digest has moved (a bot compares the live digest to
   your pinned one).
3. **Bump** the pin in a pull request, so the change is reviewed and recorded.
4. **Rebuild and re-scan**, then release the new image.

Digest bumping and vulnerability scanning are complementary: the bot moves the
pin; the scanner tells you whether the move (or the lack of one) leaves known
CVEs.

## Basic example

Re-resolve a base tag's current digest and compare it to your pin:

```bash
docker buildx imagetools inspect golang:1.27-trixie
```

```console include="captures/docker-security/base-image-digest.txt"
```

If the printed digest differs from the one pinned in the Dockerfile, upstream has
rebuilt and there may be fixes to pull in. The Tasklane Dockerfile keeps the tag
and digest together so a bot can update both:

```dockerfile include="examples/app/Dockerfile" lines="9-13"
```

A Renovate configuration that pins and updates Docker digests looks like:

```json title=".github/renovate.json"
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended", "docker:pinDigests"],
  "packageRules": [
    { "matchDatasources": ["docker"], "pinDigests": true }
  ]
}
```

Dependabot achieves the same with a `docker` ecosystem entry that opens PRs when
a base tag's digest changes.

## Explanation

The bot watches each `FROM ...@sha256:...` and each pinned tag. When upstream
publishes a new digest for that tag, it opens a pull request updating the pin.
Your CI then rebuilds, re-scans and, if the gates pass, releases. You keep the
reproducibility of a digest while getting a reviewed, auditable trail of every
base bump — exactly the trail an auditor or an incident responder wants.

This is why pinning and patching are two halves of one practice, not opposites.
Pinning without patching is stale; patching without pinning is unreproducible.
Together they give reproducible *and* current.

## Common patterns

- **`docker:pinDigests` + scheduled runs.** Let Renovate/Dependabot pin and bump
  digests on a schedule (for example weekly, plus immediate for security
  updates), grouping OS/base bumps together.
- **Rebuild on base release, not just on your code change.** A nightly or weekly
  scheduled rebuild picks up base fixes even when your source is unchanged.
- **Scan in the same pipeline.** Gate on Trivy/Grype so a bump that still carries
  a critical CVE is visible, and so a *missing* bump surfaces as new findings.
- **Prefer minimal bases** (distroless, Alpine, Docker Hardened Images) — fewer
  packages means fewer CVEs to patch and a smaller, faster bump cycle.

## Production considerations

Decide a cadence and automate it; manual digest bumping does not survive contact
with a busy team. A common baseline is: weekly scheduled digest PRs, expedited
PRs for security advisories, and a scheduled rebuild-and-rescan even with no
source changes. Group related bumps so review stays manageable.

Treat a base bump like any dependency change: it goes through CI, tests and
scanning before release. Occasionally an upstream rebuild changes behaviour
(a new default, a removed package); the reviewed-PR workflow is what catches
that before production.

Keep SBOMs from releases and re-scan them continuously. A base you cannot bump
today (a breaking change upstream) is still worth knowing about, so you can apply
a package-level mitigation or accept the risk explicitly.

## Security considerations

Automating digest bumps introduces a small supply chain question of its own:
the bot pulls the new digest from the same registry, so combine it with signature
verification and scanning rather than trusting the bump blindly. A digest bump is
still a change of running code and deserves the same gates.

Do not disable pinning to "always get latest" — that reintroduces tag mutability
and non-reproducible builds, and removes the review step. The goal is *pinned and
frequently, deliberately updated*, not unpinned.

## Troubleshooting

- **Scanner reports CVEs on an image we did not change.** New advisories landed
  against the pinned base. Bump the digest to the upstream's patched rebuild and
  rebuild; if no fix exists yet, apply a package mitigation or document
  acceptance.
- **Renovate/Dependabot opens no digest PRs.** Confirm `pinDigests`/the `docker`
  ecosystem is enabled and the schedule is active, and that the `FROM` lines use
  a form the bot recognises (tag plus digest).
- **A base bump broke the build.** The upstream rebuild changed something; that
  is exactly what the PR-and-CI flow exists to catch. Review the diff, adjust the
  Dockerfile, do not revert to an unpinned tag.
- **Digest not found on pull.** The old pinned digest was garbage-collected
  upstream; re-resolve the current digest with `imagetools inspect` and update.

## Common mistakes

- Pinning digests and then never updating them ("secure" but months out of date).
- Switching to mutable tags to get updates, losing reproducibility and review.
- Scanning only at first build and never re-scanning stored SBOMs.
- Bumping the digest but skipping the rebuild/rescan, so the fix never ships.
- Using a large, package-heavy base that needs constant patching.

## Related topics

- [Supply chain security](supply-chain-security.md)
- [Choosing base images](../docker-intermediate/choosing-base-images.md)
- [Vulnerability scanning](../docker-advanced/vulnerability-scanning.md)
- [Reproducible builds](../docker-advanced/reproducible-builds.md)
- [CIS Docker Benchmark](cis-docker-benchmark.md)
