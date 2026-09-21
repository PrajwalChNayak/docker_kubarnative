# Containers & Kubernetes Handbook

A zero-to-expert documentation site covering Docker, the container ecosystem
beneath it, and running Kubernetes in production. Written and validated against
**Kubernetes 1.37, Docker Engine 29, Docker Compose v5 and Helm 4**, verified
2026-09-21.

- **Read the source:** Markdown in [`content/`](content).
- **Read the built site:** static HTML in [`docs/`](docs) (published to GitHub Pages).
- **Run the example:** [`examples/`](examples) — the Tasklane app and a one-command kind lab.
- **Contribute:** [`CONTRIBUTING.md`](CONTRIBUTING.md) has the authoring conventions and the verified facts every page must agree with.

## Build it yourself

The generator is plain Node (ESM) with **no npm dependencies**, so it runs on a
fresh clone with no install step:

```bash
node scripts/build.mjs   # generate docs/ from content/
node scripts/check.mjs   # validate links, front matter, sections, banned patterns
```

Node 20 or newer is required.

## Validate the examples

The validation harnesses need Docker, and some need a local
[kind](https://kind.sigs.k8s.io) cluster running Kubernetes 1.37:

```bash
node scripts/harness.mjs        # kubeconform + hadolint + compose config + helm lint
./examples/lab/up.sh --addons   # stand up the disposable lab
node scripts/harness.mjs --cluster   # kubectl --dry-run=server + pluto against the lab
```

See [`scripts/README.md`](scripts/README.md) for what each harness does and what
it needs.

## Publish to GitHub Pages

Two supported options:

1. **Serve the committed `docs/` folder (no CI).** Commit `docs/`, then in
   repository **Settings → Pages** set **Source: Deploy from a branch**, branch
   `main`, folder `/docs`. GitHub serves it as-is; a `.nojekyll` file is
   included so Pages does not run Jekyll.
2. **Build in CI.** Set **Settings → Pages → Source: GitHub Actions**. The
   workflow in [`.github/workflows/pages.yml`](.github/workflows/pages.yml)
   validates and builds on every push to `main` and deploys the result, so you
   need not commit `docs/`.

## Layout

```
content/     Markdown source (one topic per file) + nav.json + per-part _part.json
docs/        generated static site (GitHub Pages root)
examples/    the Tasklane running example, manifests, charts and the kind lab
scripts/     build.mjs, check.mjs and the validation harnesses (no npm install)
captures/    real command output captured from the lab (referenced by docs pages)
research/    source-linked fact base the content is checked against
CONTRIBUTING.md   authoring conventions + verified facts
```
