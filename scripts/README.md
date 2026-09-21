# Handbook build scripts

Zero-dependency tooling for the Docker & Kubernetes handbook. Everything here
runs on plain Node 20+ (ESM) with **no `npm install`** — a fresh clone can run
the build immediately.

```bash
node scripts/build.mjs     # generate the static site into docs/
node scripts/check.mjs     # validate content (read-only, no cluster)
```

## `build.mjs` — static site generator

Reads `content/**/*.md`, `content/nav.json` and every `content/**/_part.json`,
and writes a complete static site to `docs/` (GitHub Pages serves `/docs`).

What it does:

- **Parses front matter** (`lib/frontmatter.mjs`) and renders Markdown with a
  hand-written parser (`lib/markdown.mjs`): headings with slug ids + anchor
  links, bold/italic/code/links/images, nested lists, blockquotes, GFM pipe
  tables, fenced code blocks with the CONTRIBUTING §5.3 attribute grammar,
  horizontal rules, hard breaks, `:::callouts` and `::::tabs`.
- **Resolves `include=`** by reading the referenced file from the repo at build
  time and inlining its contents (optionally sliced with `lines="A-B"`). A
  missing include renders a visible box and records a warning — it never
  crashes the build.
- **Rewrites links**: relative `*.md` links → `.html`; `examples/…` file links →
  the GitHub source URL built from `nav.json` (`site.repo` + `/blob/` +
  `branch` + path).
- **Highlights code** server-side (`lib/highlight.mjs`) for yaml, dockerfile,
  bash, console, json, go, hcl, toml, ini, diff and text. Unknown languages
  fall back to escaped plain text. The tokenizer never throws.
- **Renders the page shell** (`lib/template.mjs`): sticky 56px top bar with
  section dropdowns, theme toggle (light/dark/system, no-flash), search box and
  a mobile drawer; a centered content + TOC layout with scroll-spy; page header
  built from front matter (breadcrumb, level/status/type badges, description,
  version line, resolved prerequisites); auto TOC; prev/next from the flattened
  nav order; footer; print styles; skip link, focus rings and ARIA.
- **Builds a search index** (`lib/search.mjs`) at
  `docs/assets/search-index.json`; `docs/assets/app.js` implements instant
  search with `/`, arrow and Enter keys.
- Copies `examples/` into `docs/examples/` and writes `docs/.nojekyll`.

Output: `docs/index.html`, `docs/<part>/<page>.html`, `docs/assets/*`. If
`content/index.md` is absent, a landing page is generated from `nav.json`.

The build is deterministic and **robust to partially-written content**: a
malformed page is skipped with a recorded warning. It prints a summary (pages
built, includes resolved, warnings grouped by file) and **exits 0 even with
warnings** — non-zero only on a real crash.

## `check.mjs` — content validator

Read-only. No cluster, no network. Implements CONTRIBUTING §8:

- Front matter: `title`, `description`, `level`, `type`, `status`, `versions`
  present and in their allowed sets; `prerequisites` is a list of resolvable
  page ids.
- Required `##` sections present, in order, per `type`; the last two must be
  `Common mistakes` then `Related topics`.
- Every internal `.md` link and `#anchor` resolves (anchors are built from each
  target page's headings using the same slug algorithm as the build).
- Every page is listed in some `_part.json` (else orphan); every `_part.json`
  page has a file (warning until written).
- Manifest / Dockerfile / compose blocks carry `title=` or `include=` (unless
  flagged `fragment`); `console` output blocks use `include="captures/…"`.
- The §1/§8 bans, **skipped** inside `content/migration/**`, `status:
  legacy|deprecated` pages, `:::legacy`/`:::deprecated` callouts, and code
  blocks flagged `legacy`/`fragment`: `docker-compose`, a top-level `version:`
  in compose YAML, any removed API version, `PodSecurityPolicy`,
  dockershim-as-current, installing ingress-nginx, `kind: Endpoints`, `:latest`
  in a titled/included manifest or Dockerfile, and a container manifest without
  `runAsNonRoot`/`runAsUser != 0` unless a preceding comment explains root.

Prints a grouped report with `file:line` and a final `PASS`/`FAIL` with counts.
**Exits non-zero on any error; warnings are separate** and do not fail.

## `lib/` modules

| Module | Responsibility |
|---|---|
| `frontmatter.mjs` | Tiny YAML front-matter subset parser. |
| `markdown.mjs` | Block + inline Markdown renderer; also exports `slugify`, `getHeadings`, `parseFenceAttrs` used by the checker. |
| `highlight.mjs` | Regex syntax highlighter + `escapeHtml`. |
| `template.mjs` | Page HTML shell, `CSS`, `APP_JS`, no-flash theme script. |
| `search.mjs` | Compact search-index builder. |

## How the harnesses fit (added later)

`check.mjs` is the first gate: it is static and fast, and it must pass before the
cluster-backed harnesses run. The maintainer's harnesses (added later) then take
the manifests the checker approved and run them through **kubeconform** (1.37
schemas + CRDs), `kubectl apply --dry-run=server` against the kind 1.37 lab, and
**Pluto**, plus execute the capture requests in `captures/requests/<part>.txt`
and write the real output into `captures/`. A page's `console` includes stay as
"missing include" warnings in the build until those captures exist. Writing
agents never run cluster commands; they add capture requests and reference them.

Typical loop: `node scripts/check.mjs` → fix errors → `node scripts/build.mjs`
→ review `docs/` → commit. CI can run both; the build is safe to run on every
push because it never fails on content warnings.
