#!/usr/bin/env node
// build.mjs — zero-dependency static site generator for the handbook.
//
//   node scripts/build.mjs
//
// Reads content/**/*.md + content/nav.json + content/**/_part.json, renders a
// static site into docs/, copies examples/ into docs/examples/, writes assets
// and a search index, and prints a build summary. Robust to partially-written
// content: a malformed page is skipped with a recorded warning rather than
// crashing the whole build. Exit code is 0 even with warnings; non-zero only
// on a real crash.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontMatter } from './lib/frontmatter.mjs';
import { renderMarkdown } from './lib/markdown.mjs';
import { renderPage, CSS, APP_JS } from './lib/template.mjs';
import { buildSearchIndex } from './lib/search.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const CONTENT = path.join(REPO, 'content');
const DOCS = path.join(REPO, 'docs');
const EXAMPLES = path.join(REPO, 'examples');

const warnings = [];
const stats = { includes: 0 };
function warn(file, msg) { warnings.push({ file, msg }); }

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { warn(rel(file), `invalid JSON: ${e.message}`); return null; }
}
function rel(p) { return path.relative(REPO, p).replace(/\\/g, '/'); }
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function writeFile(p, content) { ensureDir(path.dirname(p)); fs.writeFileSync(p, content); }

function walk(dir, pred, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, pred, out);
    else if (!pred || pred(full)) out.push(full);
  }
  return out;
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function copyDir(src, dst) {
  let entries;
  try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch { return; }
  ensureDir(dst);
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// ---------------------------------------------------------------------------
// Load nav + parts
// ---------------------------------------------------------------------------

const nav = readJson(path.join(CONTENT, 'nav.json')) || { site: { title: 'Handbook', repo: '', branch: 'main' }, top: [], sections: [] };
const site = nav.site || { title: 'Handbook', repo: '', branch: 'main' };

// Discover part directories via _part.json
const partFiles = walk(CONTENT, (f) => f.endsWith('_part.json'));
const parts = {}; // partId -> { title, pages: [ids], dir }
for (const pf of partFiles) {
  const partId = path.basename(path.dirname(pf));
  const data = readJson(pf);
  if (!data) continue;
  parts[partId] = { title: data.title || partId, pages: Array.isArray(data.pages) ? data.pages : [], dir: path.dirname(pf) };
}

// Map part -> section
const sectionOfPart = {};
const sectionTitleOfPart = {};
for (const sec of nav.sections || []) {
  for (const p of sec.parts || []) { sectionOfPart[p] = sec.id; sectionTitleOfPart[p] = sec.title; }
}

// ---------------------------------------------------------------------------
// Pass 1: parse every content page for front matter + title
// ---------------------------------------------------------------------------

const mdFiles = walk(CONTENT, (f) => f.endsWith('.md'));
const pages = {}; // id -> { id, part, page, file, data, body, title }

for (const file of mdFiles) {
  const relPath = rel(file); // content/<...>.md
  const parin = relPath.replace(/^content\//, '').replace(/\.md$/, '');
  const segs = parin.split('/');
  let id, partId, pageName;
  if (segs.length === 1) { id = segs[0]; partId = null; pageName = segs[0]; } // top-level (index, learning-path)
  else { partId = segs[0]; pageName = segs.slice(1).join('/'); id = `${partId}/${pageName}`; }

  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { warn(relPath, `cannot read: ${e.message}`); continue; }

  const { data, body, error } = parseFrontMatter(raw);
  if (error && segs.length > 1) {
    // Top-level maintainer pages may legitimately differ; only warn for part pages.
    warn(relPath, `front matter: ${error}`);
  }
  const title = data.title || pageName;
  pages[id] = { id, part: partId, page: pageName, file, relPath, data: data || {}, body: body || '', title };
}

// ---------------------------------------------------------------------------
// Build linear order (flatten nav sections -> parts -> pages)
// ---------------------------------------------------------------------------

const linear = []; // list of page ids that exist, in nav order
for (const sec of nav.sections || []) {
  for (const partId of sec.parts || []) {
    const part = parts[partId];
    if (!part) { warn('nav.json', `section "${sec.id}" references missing part "${partId}"`); continue; }
    for (const pageName of part.pages) {
      const id = `${partId}/${pageName}`;
      if (pages[id]) linear.push(id);
      // pages listed but not yet written are simply skipped from the chain
    }
  }
}
const linearIndex = {};
linear.forEach((id, i) => { linearIndex[id] = i; });

// Orphan detection (build-level info; the checker enforces)
const inSomePart = new Set();
for (const [partId, part] of Object.entries(parts)) {
  for (const pageName of part.pages) inSomePart.add(`${partId}/${pageName}`);
}

// ---------------------------------------------------------------------------
// Nav model for the topbar / drawer
// ---------------------------------------------------------------------------

function pageTitle(id) { return pages[id] ? pages[id].title : null; }
function pageUrl(id) { return `${id}.html`; }

const navModel = (nav.sections || []).map((sec) => ({
  id: sec.id,
  title: sec.title,
  parts: (sec.parts || []).filter((p) => parts[p]).map((partId) => ({
    id: partId,
    title: parts[partId].title,
    pages: parts[partId].pages
      .filter((pn) => pages[`${partId}/${pn}`])
      .map((pn) => ({ id: `${partId}/${pn}`, title: pages[`${partId}/${pn}`].title, url: pageUrl(`${partId}/${pn}`) })),
  })),
}));

const topLinks = (nav.top || [])
  .filter((id) => pages[id] || id === 'index')
  .map((id) => ({ id, title: id === 'index' ? 'Home' : (pageTitle(id) || id), url: `${id}.html` }));

// ---------------------------------------------------------------------------
// Prerequisite resolution
// ---------------------------------------------------------------------------

function resolvePrereqs(list, fromPart) {
  if (!Array.isArray(list)) return [];
  return list.map((pid) => {
    const target = pages[pid];
    if (target) {
      // href relative to this page's output dir (docs/<part>/<page>.html)
      const href = relHref(fromPart, pid);
      return { id: pid, title: target.title, href, ok: true };
    }
    return { id: pid, title: pid, href: '#', ok: false };
  });
}

// href from a page in `fromPart` to page id `toId` (both under docs/)
function relHref(fromPart, toId) {
  // output of fromPart page is docs/<fromPart>/x.html ; target docs/<toId>.html
  const toParts = toId.split('/');
  if (fromPart) return `../${toParts.join('/')}.html`;
  return `${toParts.join('/')}.html`;
}

// ---------------------------------------------------------------------------
// Pass 2: render pages
// ---------------------------------------------------------------------------

let built = 0;
const indexEntries = [];

for (const id of Object.keys(pages)) {
  const pg = pages[id];
  // Skip the top-level index/learning-path here; handled separately below.
  if (!pg.part && (id === 'index' || id === 'learning-path')) continue;

  const pageDir = path.posix.dirname(pg.relPath); // content/<part>
  const depth = pg.part ? 1 : 0;
  const root = '../'.repeat(depth);

  let rendered;
  try {
    rendered = renderMarkdown(pg.body, {
      repoRoot: REPO,
      pageDir,
      site,
      file: pg.relPath,
      warnings,
      stats,
      links: [],
    });
  } catch (e) {
    warn(pg.relPath, `render failed, page skipped: ${e.message}`);
    continue;
  }
  // Record internal links for build-level existence check.
  // (renderMarkdown pushed link records into its own ctx.links, exposed via return? we re-run lightweight.)

  const prev = pg.part && linearIndex[id] > 0 ? linear[linearIndex[id] - 1] : null;
  const next = pg.part && linearIndex[id] < linear.length - 1 && linearIndex[id] >= 0 ? linear[linearIndex[id] + 1] : null;

  const model = {
    site,
    root,
    navModel,
    topLinks,
    title: pg.title,
    description: pg.data.description || '',
    level: pg.data.level || '',
    type: pg.data.type || '',
    status: pg.data.status || 'current',
    versions: pg.data.versions || '',
    prerequisites: resolvePrereqs(pg.data.prerequisites, pg.part),
    breadcrumb: pg.part ? {
      sectionTitle: sectionTitleOfPart[pg.part] || '',
      partTitle: parts[pg.part] ? parts[pg.part].title : pg.part,
    } : null,
    headings: rendered.headings.map((h) => ({ ...h })),
    contentHtml: rendered.html,
    prev: prev ? { url: pageUrl(prev), title: pageTitle(prev) } : null,
    next: next ? { url: pageUrl(next), title: pageTitle(next) } : null,
  };

  const html = renderPage(model);
  const outPath = path.join(DOCS, `${id}.html`);
  writeFile(outPath, html);
  built += 1;

  indexEntries.push({
    id,
    title: pg.title,
    part: pg.part ? (parts[pg.part] ? parts[pg.part].title : pg.part) : '',
    level: pg.data.level || '',
    url: pageUrl(id),
    body: pg.body,
    headings: rendered.headings,
  });
}

// ---------------------------------------------------------------------------
// Home page (index.md) and learning-path.md through the same pipeline
// ---------------------------------------------------------------------------

function renderTopPage(id, landing) {
  const pg = pages[id];
  if (!pg) return false;
  let rendered;
  try {
    rendered = renderMarkdown(pg.body, {
      repoRoot: REPO, pageDir: 'content', site, file: pg.relPath, warnings, stats, links: [],
    });
  } catch (e) { warn(pg.relPath, `render failed: ${e.message}`); return false; }
  const model = {
    site, root: '', navModel, topLinks,
    title: pg.title,
    description: pg.data.description || '',
    level: pg.data.level || '', type: pg.data.type || '', status: pg.data.status || 'current',
    versions: pg.data.versions || '',
    prerequisites: resolvePrereqs(pg.data.prerequisites, null),
    breadcrumb: null,
    headings: rendered.headings,
    contentHtml: rendered.html,
    isLanding: landing,
    prev: null, next: null,
  };
  writeFile(path.join(DOCS, `${id}.html`), renderPage(model));
  built += 1;
  indexEntries.push({ id, title: pg.title, part: '', level: pg.data.level || '', url: `${id}.html`, body: pg.body, headings: rendered.headings });
  return true;
}

// index.md (or a generated landing)
if (pages['index']) {
  renderTopPage('index', false);
} else {
  const cards = navModel.map((sec) => {
    const partLinks = sec.parts.map((part) => {
      const pageLinks = part.pages.slice(0, 6).map((pg) => `<li><a href="${pg.url}">${pg.title}</a></li>`).join('');
      return `<div><p class="menu-group-title">${part.title}</p><ul>${pageLinks}</ul></div>`;
    }).join('');
    return `<div class="section-card"><h2>${sec.title}</h2>${partLinks}</div>`;
  }).join('');
  const contentHtml = `<div class="section-grid">${cards}</div>`;
  const model = {
    site, root: '', navModel, topLinks,
    title: site.title,
    description: 'A verified, offline-first handbook for Docker and Kubernetes, built against current versions.',
    contentHtml, isLanding: true, headings: [], prev: null, next: null,
  };
  writeFile(path.join(DOCS, 'index.html'), renderPage(model));
  built += 1;
  warn('content/index.md', 'absent — generated a landing index from nav.json');
}

// learning-path.md if present
if (pages['learning-path']) renderTopPage('learning-path', false);

// ---------------------------------------------------------------------------
// Build-level internal link check (existence of .md targets)
// ---------------------------------------------------------------------------

// Re-render is expensive; instead scan bodies for markdown links to .md files.
let brokenLinks = 0;
for (const pg of Object.values(pages)) {
  const dir = path.posix.dirname(pg.relPath);
  const re = /\[[^\]]+\]\(([^)\s]+\.md)(#[^)]*)?\)/g;
  let m;
  const bodyNoCode = pg.body.replace(/```[\s\S]*?```/g, '');
  while ((m = re.exec(bodyNoCode)) !== null) {
    const target = m[1];
    if (/^https?:/i.test(target)) continue;
    const repoRel = path.posix.normalize(`${dir}/${target}`);
    if (repoRel.startsWith('examples/')) continue;
    const abs = path.join(REPO, repoRel);
    if (!fs.existsSync(abs)) { warn(pg.relPath, `broken internal link: ${target}`); brokenLinks += 1; }
  }
}

// ---------------------------------------------------------------------------
// Assets, search index, examples copy, .nojekyll
// ---------------------------------------------------------------------------

writeFile(path.join(DOCS, 'assets', 'style.css'), CSS);
writeFile(path.join(DOCS, 'assets', 'app.js'), APP_JS);
const searchIndex = buildSearchIndex(indexEntries.sort((a, b) => a.id.localeCompare(b.id)));
writeFile(path.join(DOCS, 'assets', 'search-index.json'), JSON.stringify(searchIndex));
writeFile(path.join(DOCS, '.nojekyll'), '');

// Copy examples/ so include= references and offline browsing resolve.
rmrf(path.join(DOCS, 'examples'));
if (fs.existsSync(EXAMPLES)) copyDir(EXAMPLES, path.join(DOCS, 'examples'));

// ---------------------------------------------------------------------------
// Build summary
// ---------------------------------------------------------------------------

const missingIncludes = warnings.filter((w) => /missing include:/.test(w.msg)).length;
const unknownPrereqs = new Set();
for (const pg of Object.values(pages)) {
  if (Array.isArray(pg.data.prerequisites)) {
    for (const pid of pg.data.prerequisites) if (!pages[pid]) unknownPrereqs.add(`${pg.relPath} -> ${pid}`);
  }
}

console.log('');
console.log('Build summary');
console.log('=============');
console.log(`  Pages built:        ${built}`);
console.log(`  Includes resolved:  ${stats.includes}`);
console.log(`  Warnings:           ${warnings.length}`);
console.log(`    - missing includes:      ${missingIncludes}`);
console.log(`    - unknown prereq ids:    ${unknownPrereqs.size}`);
console.log(`    - broken internal links: ${brokenLinks}`);
if (warnings.length) {
  console.log('');
  console.log('Warnings:');
  const byFile = {};
  for (const w of warnings) { (byFile[w.file] = byFile[w.file] || []).push(w.msg); }
  for (const f of Object.keys(byFile).sort()) {
    console.log(`  ${f}`);
    for (const msg of byFile[f]) console.log(`    - ${msg}`);
  }
}
console.log('');
console.log(`Output: ${rel(DOCS)}/`);
process.exit(0);
