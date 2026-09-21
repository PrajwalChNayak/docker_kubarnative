# examples/supply-chain — signing, SBOMs and scanning

Exact commands for the Tasklane images. Versions used here: **cosign v3.1.3,
syft v1.52.0, grype v0.119.0, Trivy v0.74.0**, against **Docker Engine 29,
Buildx 0.37**.

Every flag below appears in the tool's own reference documentation for that
version. Flags are not interchangeable between tools, and cosign in
particular changed defaults between v2 and v3 — see the last section.

Throughout, `$IMAGE` is a **digest** reference, never a tag:

```bash
IMAGE=ghcr.io/example/tasklane/tasklane-api@sha256:<digest>
```

A tag can be moved after you sign it. A digest cannot. `cosign sign` on a tag
resolves the tag and signs the digest anyway, and then prints a warning,
which is the tool telling you that you asked the wrong question.

---

## 1. Keyless signing (OIDC, Fulcio, Rekor)

Keyless signing means there is no long-lived private key to store, rotate or
leak. cosign proves an identity to Fulcio, which issues a certificate valid
for a few minutes; the signature and that certificate are logged in Rekor.

In CI (GitHub Actions with `id-token: write`) the identity token is picked up
automatically:

```bash
cosign sign --yes "$IMAGE"
```

Interactively, cosign opens a browser for an OIDC provider. `--yes` skips the
confirmation prompt about the transparency log — in a pipeline there is
nobody to answer it.

Verification must state *which* identity is acceptable. A signature alone
proves only that somebody signed:

```bash
cosign verify \
  --certificate-identity-regexp '^https://github.com/example/tasklane/.github/workflows/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "$IMAGE"
```

Exact identity instead of a regular expression:

```bash
cosign verify \
  --certificate-identity 'https://github.com/example/tasklane/.github/workflows/build.yaml@refs/heads/main' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "$IMAGE"
```

Extra constraints on the GitHub claims embedded in the certificate:

```bash
cosign verify \
  --certificate-identity-regexp '^https://github.com/example/tasklane/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-github-workflow-repository example/tasklane \
  --certificate-github-workflow-ref refs/heads/main \
  "$IMAGE"
```

`cosign verify` writes a JSON report to stdout by default (`-o json`; `-o
text` is the alternative). It exits non-zero when verification fails, which
is the part your pipeline should act on.

## 2. Key-pair signing

Use a key pair when there is no OIDC identity to bind to — an air-gapped
build, or a release key held in a KMS.

```bash
COSIGN_PASSWORD='' cosign generate-key-pair
# writes cosign.key (encrypted private key) and cosign.pub
```

`cosign generate-key-pair` prompts for a password interactively;
`COSIGN_PASSWORD` supplies it non-interactively. An empty password is for
demos only. In production put the key in a KMS and never materialise it:

```bash
cosign generate-key-pair --kms awskms:///alias/tasklane-signing
```

Sign and verify:

```bash
cosign sign --key cosign.key "$IMAGE"
cosign verify --key cosign.pub "$IMAGE"
```

KMS and Kubernetes references work in the same place as a file path, for
example `--key awskms:///alias/tasklane-signing`,
`--key gcpkms://projects/<p>/locations/global/keyRings/<r>/cryptoKeys/<k>/versions/1`,
`--key hashivault://tasklane`, or `--key k8s://tasklane/cosign-key`.

Signing every child image of a manifest list, not just the index:

```bash
cosign sign --key cosign.key --recursive "$IMAGE"
```

Signing offline, uploading later:

```bash
cosign sign --key cosign.key --bundle bundle.sigstore.json --upload=false "$IMAGE"
```

## 3. SBOM generation with syft

```bash
syft "$IMAGE" -o spdx-json=sbom.spdx.json
syft "$IMAGE" -o cyclonedx-json=sbom.cdx.json
syft "$IMAGE" -o spdx-json=sbom.spdx.json -o cyclonedx-json=sbom.cdx.json
```

Source schemes decide *what* is inspected. `registry:` pulls from the
registry without a local daemon, which is what CI should use:

```bash
syft registry:ghcr.io/example/tasklane/tasklane-api:0.1.0 -o spdx-json=sbom.spdx.json
syft docker:tasklane-api:0.1.0 -o spdx-json=sbom.spdx.json
```

By default syft describes the squashed filesystem. `--scope all-layers` also
reports packages that a later layer deleted — useful when auditing a
multi-stage build, noisy otherwise:

```bash
syft "$IMAGE" --scope all-layers -o spdx-json=sbom.all-layers.json
```

BuildKit can produce the SBOM at build time instead (`--sbom=true`, or
`attest = [{ type = "sbom" }]` in the Bake file). It uses a Syft-based
scanner and attaches the result as an in-toto SPDX attestation, one per
platform. Read it back with:

```bash
docker buildx imagetools inspect "$IMAGE" --format '{{ json .SBOM.SPDX }}' > sbom.spdx.json
```

For a distroless Go image the SBOM is short: the base image's few files plus
one static binary. That is the point — a small SBOM is a small attack
surface, and it makes the scanner's job unambiguous.

## 4. Attesting the SBOM

An attestation is a signed statement *about* an image: predicate type, the
predicate document, and the image digest as subject.

```bash
cosign attest --yes --type spdxjson --predicate sbom.spdx.json "$IMAGE"
```

With a key instead of an identity:

```bash
cosign attest --key cosign.key --type spdxjson --predicate sbom.spdx.json "$IMAGE"
```

`--type` accepts `slsaprovenance`, `slsaprovenance02`, `slsaprovenance1`,
`link`, `spdx`, `spdxjson`, `cyclonedx`, `vuln`, `openvex` and `custom`
(the default). Use `cyclonedx` for `sbom.cdx.json`.

Verify an attestation, not just a signature:

```bash
cosign verify-attestation --type spdxjson \
  --certificate-identity-regexp '^https://github.com/example/tasklane/.github/workflows/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "$IMAGE"
```

`verify-attestation` can also enforce a policy over the predicate, written in
CUE or Rego:

```bash
cosign verify-attestation --type slsaprovenance --policy builder.cue \
  --certificate-identity-regexp '^https://github.com/example/tasklane/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "$IMAGE"
```

See what is attached to an image:

```bash
cosign tree "$IMAGE"
```

## 5. Scanning

### Trivy

```bash
trivy image --severity HIGH,CRITICAL tasklane-api:0.1.0
trivy image --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 tasklane-api:0.1.0
trivy image --format json --output trivy.json tasklane-api:0.1.0
trivy image --format sarif --output trivy.sarif tasklane-api:0.1.0
```

`--ignore-unfixed` drops findings with no fixed version. It is the difference
between a list you can act on and a list you will learn to ignore.
`--exit-code 1` is what makes a pipeline fail.

Without installing Trivy, using the pinned image (mount the socket only if
you must scan a local image; prefer scanning from the registry):

```bash
docker run --rm -v //var/run/docker.sock:/var/run/docker.sock \
  aquasec/trivy:0.74.0 image --severity HIGH,CRITICAL tasklane-api:0.1.0
```

Other flags worth knowing: `--scanners vuln,misconfig,secret,license`,
`--pkg-types os,library`, `--ignorefile .trivyignore`, `--vex <path|repo|oci>`
and `--sbom-sources oci` to pick up an SBOM attestation from the registry
instead of re-analysing the image.

### Grype

```bash
grype "$IMAGE"
grype sbom:./sbom.spdx.json
grype sbom:./sbom.spdx.json --fail-on high --only-fixed
grype "$IMAGE" -o sarif --file grype.sarif
```

Scanning the SBOM you already produced is faster than re-analysing the image,
and it scans exactly the artefact you attested. `--fail-on high` sets exit
code 2 at or above that severity. `--ignore-states fixed,not-fixed,unknown,wont-fix`,
`--by-cve`, `--vex` and `--scope all-layers` cover triage.

### Docker Scout

```bash
docker scout quickview tasklane-api:0.1.0
docker scout cves --only-severity critical,high --only-fixed tasklane-api:0.1.0
docker scout recommendations tasklane-api:0.1.0
```

`docker scout recommendations` answers the question that matters most often:
which base image update removes these CVEs.

## 6. Triage with VEX

A CVE in an SBOM is not a vulnerability in your service. VEX (Vulnerability
Exploitability eXchange) is the machine-readable way to say "present, not
exploitable, here is why" so that the next scan does not re-raise it.

```bash
docker scout vex --help          # create and attach VEX statements
trivy image --vex ./vex.openvex.json --severity HIGH,CRITICAL tasklane-api:0.1.0
grype "$IMAGE" --vex ./vex.openvex.json
cosign attest --yes --type openvex --predicate vex.openvex.json "$IMAGE"
```

Writing the statement is the easy part. The discipline is re-reviewing it
when the code changes, because an unreachable code path can become reachable
in one commit.

## 7. cosign v2 → v3

cosign v3.0.0 was announced on 2025-10-08 and is described as a minor change
from v2.6.x, with three previously opt-in behaviours now on by default:

- the protobuf **bundle format** (what `--new-bundle-format` did in v2),
- **`--trusted-root`** and signing configuration fetched from TUF
  (`--use-signing-config` defaults to true),
- signatures stored as **OCI 1.1 referring artifacts** rather than only as a
  `sha256-<digest>.sig` tag.

The old behaviour can still be selected with flags. Removal is planned for
v4, so pipelines pinned to v2 flag names should be migrated now rather than
at the v4 bump. Pin the cosign version in CI
(`sigstore/cosign-installer` with `cosign-release`), because a signature
format change that arrives silently is indistinguishable from an outage.

Two consequences worth planning for:

- A registry that does not implement the OCI 1.1 referrers API needs the
  fallback mode. `cosign sign --registry-referrers-mode legacy` selects the
  old tag scheme explicitly.
- Verifiers written against v2 bundle layouts may need updating before you
  flip producers to v3.

## Related handbook pages

- [Image signing with cosign](../../content/docker-advanced/image-signing-cosign.md)
- [SBOMs and provenance](../../content/docker-advanced/sboms-and-provenance.md)
- [Vulnerability scanning](../../content/docker-advanced/vulnerability-scanning.md)
