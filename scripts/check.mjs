#!/usr/bin/env node
// check.mjs — read-only content validator for the handbook (CONTRIBUTING §8).
//
//   node scripts/check.mjs
//
// No cluster, no network. Validates front matter, required sections and order,
// internal links + anchors, prerequisite ids, part membership, code-block
// attribute rules, and the "no 2021-era Kubernetes" bans. Prints a grouped
// report with file:line and a final PASS/FAIL. Exits non-zero on any error;
// warnings do not fail the build.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontMatter } from './lib/frontmatter.mjs';
import { getHeadings, parseFenceAttrs } from './lib/markdown.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const CONTENT = path.join(REPO, 'content');

const LEVELS = new Set(['foundations', 'beginner', 'intermediate', 'advanced', 'expert']);
const TYPES = new Set(['concept', 'tutorial', 'lab', 'troubleshooting', 'migration', 'reference']);
const STATUS = new Set(['current', 'beta', 'alpha', 'legacy', 'deprecated']);

const REQUIRED = {
  concept: ['Overview', 'Why it exists and when to use it', 'How it works underneath', 'Basic example', 'Explanation', 'Common patterns', 'Production considerations', 'Security considerations', 'Troubleshooting', 'Common mistakes', 'Related topics'],
  troubleshooting: ['Overview', 'Symptoms', 'How it works underneath', 'Diagnosis', 'Fixes', 'Prevention', 'Common mistakes', 'Related topics'],
  lab: ['Overview', 'Setup', 'Exercises', 'Solutions', 'Common mistakes', 'Related topics'],
};
const LOOSE = new Set(['tutorial', 'migration', 'reference']); // Overview + end with the two

const REMOVED_APIS = [
  'extensions/v1beta1', 'apps/v1beta1', 'apps/v1beta2', 'networking.k8s.io/v1beta1',
  'policy/v1beta1', 'batch/v1beta1', 'autoscaling/v2beta1', 'autoscaling/v2beta2',
  'discovery.k8s.io/v1beta1', 'events.k8s.io/v1beta1', 'node.k8s.io/v1beta1',
  'storage.k8s.io/v1beta1', 'rbac.authorization.k8s.io/v1beta1', 'scheduling.k8s.io/v1beta1',
  'admissionregistration.k8s.io/v1beta1', 'apiextensions.k8s.io/v1beta1',
  'apiregistration.k8s.io/v1beta1', 'authentication.k8s.io/v1beta1',
  'authorization.k8s.io/v1beta1', 'certificates.k8s.io/v1beta1', 'coordination.k8s.io/v1beta1',
  'flowcontrol.apiserver.k8s.io/v1beta1', 'flowcontrol.apiserver.k8s.io/v1beta2',
  'flowcontrol.apiserver.k8s.io/v1beta3',
];

const errors = [];
const warns = [];
function err(file, line, msg) { errors.push({ file, line, msg }); }
function warn(file, line, msg) { warns.push({ file, line, msg }); }
function rel(p) { return path.relative(REPO, p).replace(/\\/g, '/'); }

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
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

// ---------------------------------------------------------------------------
// Load nav + parts + pages
// ---------------------------------------------------------------------------

const nav = readJson(path.join(CONTENT, 'nav.json')) || { top: [], sections: [] };
const topIds = new Set(nav.top || []);

const parts = {}; // partId -> { pages: [], file }
for (const pf of walk(CONTENT, (f) => f.endsWith('_part.json'))) {
  const partId = path.basename(path.dirname(pf));
  const data = readJson(pf);
  if (!data) { err(rel(pf), 0, 'invalid _part.json'); continue; }
  parts[partId] = { pages: Array.isArray(data.pages) ? data.pages : [], file: rel(pf) };
}

// pageId -> { file, data, body, headings, anchors, part }
const pages = {};
for (const file of walk(CONTENT, (f) => f.endsWith('.md'))) {
  const relPath = rel(file);
  const idPath = relPath.replace(/^content\//, '').replace(/\.md$/, '');
  const segs = idPath.split('/');
  const partId = segs.length > 1 ? segs[0] : null;
  const id = idPath;
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { err(relPath, 0, `cannot read: ${e.message}`); continue; }
  const { data, body, error } = parseFrontMatter(raw);
  if (error) err(relPath, 1, `front matter: ${error}`);
  const bodyNorm = (body || '').replace(/\r\n?/g, '\n');
  const rawNorm = raw.replace(/\r\n?/g, '\n');
  const lineOffset = Math.max(0, rawNorm.split('\n').length - bodyNorm.split('\n').length);
  const headings = getHeadings(bodyNorm);
  pages[id] = {
    id, file, relPath, partId, lineOffset,
    data: data || {}, body: bodyNorm,
    headings, anchors: new Set(headings.map((h) => h.slug)),
  };
}

// membership map for orphan detection
const inPart = new Set();
for (const [partId, part] of Object.entries(parts)) {
  for (const pn of part.pages) inPart.add(`${partId}/${pn}`);
}

// ---------------------------------------------------------------------------
// Code-block extraction
// ---------------------------------------------------------------------------

function extractBlocks(body) {
  const lines = body.split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const fm = lines[i].match(/^(\s*)(```+|~~~+)(.*)$/);
    if (fm) {
      const marker = fm[2];
      const ch = marker[0];
      const attrs = parseFenceAttrs(fm[3].trim());
      const startLine = i + 1;
      const buf = [];
      i += 1;
      while (i < lines.length) {
        if (new RegExp(`^\\s*${ch === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(lines[i])) { i += 1; break; }
        buf.push(lines[i]); i += 1;
      }
      blocks.push({ ...attrs, content: buf.join('\n'), line: startLine });
      continue;
    }
    i += 1;
  }
  return blocks;
}

// Track line ranges that are inside :::legacy / :::deprecated callouts.
function skipRanges(body) {
  const lines = body.split('\n');
  const ranges = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^(:{3,})\s*(\S+)/);
    if (m && /^(legacy|deprecated)$/i.test(m[2])) {
      const colons = m[1].length;
      const start = i;
      i += 1;
      while (i < lines.length) {
        const c = lines[i].match(/^(:{3,})\s*(.*)$/);
        if (c && c[1].length === colons && c[2].trim() === '') { i += 1; break; }
        i += 1;
      }
      ranges.push([start, i - 1]);
      continue;
    }
    i += 1;
  }
  return ranges;
}

// ---------------------------------------------------------------------------
// Per-page validation
// ---------------------------------------------------------------------------

function validateFrontMatter(pg) {
  const d = pg.data;
  const f = pg.relPath;
  if (!d.title) err(f, 1, 'front matter: missing title');
  if (!d.description) err(f, 1, 'front matter: missing description');
  if (!d.level || !LEVELS.has(d.level)) err(f, 1, `front matter: level "${d.level ?? ''}" not in ${[...LEVELS].join('|')}`);
  if (!d.type || !TYPES.has(d.type)) err(f, 1, `front matter: type "${d.type ?? ''}" not in ${[...TYPES].join('|')}`);
  const status = d.status || 'current';
  if (!STATUS.has(status)) err(f, 1, `front matter: status "${status}" not in ${[...STATUS].join('|')}`);
  if (!d.versions) err(f, 1, 'front matter: missing versions');
  if (d.prerequisites !== undefined && !Array.isArray(d.prerequisites)) {
    err(f, 1, 'front matter: prerequisites must be a list (use [] for none)');
  } else if (Array.isArray(d.prerequisites)) {
    for (const pid of d.prerequisites) {
      if (!pages[pid]) err(f, 1, `prerequisite id does not resolve: ${pid}`);
    }
  }
}

function validateSections(pg) {
  if (topIds.has(pg.id)) return; // maintainer landing pages are exempt
  const type = pg.data.type;
  const h2 = pg.headings.filter((h) => h.level === 2).map((h) => h.text);
  const f = pg.relPath;
  if (h2.length === 0) { err(f, 1, 'no h2 sections found'); return; }

  const endOk = h2[h2.length - 2] === 'Common mistakes' && h2[h2.length - 1] === 'Related topics';
  if (!endOk) err(f, 1, `last two sections must be "Common mistakes" then "Related topics" (found "${h2[h2.length - 2] || ''}" / "${h2[h2.length - 1] || ''}")`);

  if (REQUIRED[type]) {
    const req = REQUIRED[type];
    // required sequence must be a subsequence of the actual h2 list, in order
    let j = 0;
    for (const r of req) {
      const at = h2.indexOf(r, j);
      if (at === -1) { err(f, 1, `missing or out-of-order required section: "${r}" (type ${type})`); }
      else j = at + 1;
    }
  } else if (LOOSE.has(type)) {
    if (!h2.includes('Overview')) err(f, 1, `type ${type} requires an "## Overview" section`);
  }
}

function validateLinks(pg) {
  const f = pg.relPath;
  const off = pg.lineOffset;
  const dir = path.posix.dirname(pg.relPath);
  const lines = pg.body.split('\n');
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fm = line.match(/^(\s*)(```+|~~~+)/);
    if (fm) { const ch = fm[2][0]; if (fence === null) fence = ch; else if (line.trim().startsWith(ch.repeat(3))) fence = null; continue; }
    if (fence !== null) continue;
    const re = /\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const href = m[1];
      if (/^(https?:|mailto:|tel:)/i.test(href)) continue;
      const hashIdx = href.indexOf('#');
      const pathPart = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
      const anchor = hashIdx >= 0 ? href.slice(hashIdx + 1) : '';
      const ln = i + 1 + off;
      if (pathPart === '') {
        if (anchor && !pg.anchors.has(anchor)) err(f, ln, `broken anchor #${anchor} (same page)`);
        continue;
      }
      if (!/\.md$/i.test(pathPart)) {
        const repoRel = path.posix.normalize(`${dir}/${pathPart}`);
        if (repoRel.startsWith('examples/') && !fs.existsSync(path.join(REPO, repoRel))) {
          err(f, ln, `link to missing example file: ${pathPart}`);
        }
        continue;
      }
      const repoRel = path.posix.normalize(`${dir}/${pathPart}`);
      const targetId = repoRel.replace(/^content\//, '').replace(/\.md$/, '');
      const target = pages[targetId];
      if (!target) { err(f, ln, `broken internal link: ${pathPart}`); continue; }
      if (anchor && !target.anchors.has(anchor)) err(f, ln, `broken anchor: ${pathPart}#${anchor}`);
    }
  }
}

function validateCodeBlocks(pg) {
  const f = pg.relPath;
  const off = pg.lineOffset;
  const blocks = extractBlocks(pg.body);
  // map char offset -> line: block.line is the fence line
  for (const b of blocks) {
    const lang = (b.lang || 'text').toLowerCase();
    const hasTitleOrInclude = !!(b.title || b.include);
    const isFragment = b.flags.has('fragment');
    const c = b.content;

    // console/output blocks must use include="captures/..."
    if (lang === 'console') {
      if (!b.include || !/^captures\//.test(b.include)) {
        err(f, b.line + off, 'console/output block must use include="captures/..."');
      }
    }

    // Dockerfile blocks with FROM need title/include unless fragment
    if (lang === 'dockerfile' && /^\s*FROM\s/mi.test(c)) {
      if (!hasTitleOrInclude && !isFragment) err(f, b.line + off, 'Dockerfile block needs title= or include= (or flag `fragment`)');
    }
    // YAML manifests (kind:) or compose (services:) need title/include unless fragment
    if (lang === 'yaml') {
      const isManifest = /^\s*kind:\s*\S/m.test(c);
      const isCompose = /^\s*services:\s*$/m.test(c);
      if ((isManifest || isCompose) && !hasTitleOrInclude && !isFragment) {
        err(f, b.line + off, 'manifest/compose block needs title= or include= (or flag `fragment`)');
      }
    }
  }
}

function validateBans(pg) {
  const f = pg.relPath;
  const off = pg.lineOffset;
  // Page-level skip: migration part, or legacy/deprecated status
  const status = pg.data.status || 'current';
  const pageSkip = pg.partId === 'migration' || status === 'legacy' || status === 'deprecated';
  if (pageSkip) return;

  const lines = pg.body.split('\n');
  const legacyCallouts = skipRanges(pg.body);
  const inCallout = (idx) => legacyCallouts.some(([a, b]) => idx >= a && idx <= b);

  // Track code-fence state + flags to skip legacy/fragment code blocks.
  let fence = null; // { ch, len, skip }
  const banMatch = (idx, line) => {
    if (inCallout(idx)) return;

    // docker-compose (hyphenated command), excluding the -plugin package name
    if (/(?<![\w-])docker-compose(?!-)/.test(line)) err(f, idx + 1 + off, 'banned: `docker-compose` (use `docker compose`)');

    // removed API versions
    for (const api of REMOVED_APIS) {
      if (line.includes(api)) { err(f, idx + 1 + off, `banned removed API version: ${api}`); break; }
    }
    // PodSecurityPolicy
    if (/\bPodSecurityPolicy\b/.test(line)) err(f, idx + 1 + off, 'banned: PodSecurityPolicy (removed in 1.25)');
    // kind: Endpoints
    if (/^\s*kind:\s*Endpoints\b/.test(line)) err(f, idx + 1 + off, 'banned: `kind: Endpoints` (use EndpointSlice)');
    // dockershim as current
    if (/dockershim/i.test(line) && !/remov|deprecat|1\.24|predate/i.test(line)) {
      err(f, idx + 1 + off, 'dockershim referenced without noting it was removed in 1.24');
    }
    // installing ingress-nginx
    if (/ingress-nginx/i.test(line) && /(install|helm\s+(install|repo|upgrade)|kubectl\s+apply|kubernetes\/ingress-nginx)/i.test(line)) {
      err(f, idx + 1 + off, 'banned: installing ingress-nginx (retired 2026-03-24; use Gateway API)');
    }
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const fm = line.match(/^(\s*)(```+|~~~+)(.*)$/);
    if (fm) {
      if (fence && new RegExp(`^\\s*${fm[2][0] === '`' ? '`' : '~'}{${fm[2].length},}\\s*$`).test(line) && fm[3].trim() === '') {
        fence = null; continue;
      }
      if (!fence) {
        const at = parseFenceAttrs(fm[3].trim());
        fence = { skip: at.flags.has('legacy') || at.flags.has('fragment'), titled: !!(at.title || at.include), lang: at.lang };
        continue;
      }
    }
    if (fence) {
      if (!fence.skip) {
        // bans that apply inside code blocks
        if (!inCallout(idx)) {
          for (const api of REMOVED_APIS) { if (line.includes(api)) { err(f, idx + 1 + off, `banned removed API version: ${api}`); break; } }
          if (/\bPodSecurityPolicy\b/.test(line)) err(f, idx + 1 + off, 'banned: PodSecurityPolicy (removed in 1.25)');
          if (/^\s*kind:\s*Endpoints\b/.test(line)) err(f, idx + 1 + off, 'banned: `kind: Endpoints` (use EndpointSlice)');
          // :latest only in titled/included manifest or Dockerfile blocks
          if (fence.titled && (fence.lang === 'yaml' || fence.lang === 'dockerfile') && /:latest(?=["'\s]|$)/.test(line)) {
            err(f, idx + 1 + off, 'banned: `:latest` tag in a titled/included manifest or Dockerfile');
          }
        }
      }
      continue;
    }
    banMatch(idx, line);
  }

  // runAsNonRoot / runAsUser!=0 requirement for titled/included container manifests
  for (const b of extractBlocks(pg.body)) {
    if ((b.lang || '').toLowerCase() !== 'yaml') continue;
    if (b.flags.has('fragment') || b.flags.has('legacy')) continue;
    if (!(b.title || b.include)) continue;
    if (!/^\s*containers:/m.test(b.content)) continue;
    const hasNonRoot = /runAsNonRoot:\s*true/.test(b.content);
    const hasNonZeroUser = /runAsUser:\s*[1-9]\d*/.test(b.content);
    const rootComment = /^\s*#.*\broot\b/mi.test(b.content);
    if (!hasNonRoot && !hasNonZeroUser && !rootComment) {
      err(f, b.line + off, 'container manifest without runAsNonRoot:true or runAsUser!=0 (add a comment explaining root if intended)');
    }
  }
}

// compose top-level version: ban (needs the whole block, checked separately)
function validateComposeVersion(pg) {
  const off = pg.lineOffset;
  const status = pg.data.status || 'current';
  if (pg.partId === 'migration' || status === 'legacy' || status === 'deprecated') return;
  for (const b of extractBlocks(pg.body)) {
    if ((b.lang || '').toLowerCase() !== 'yaml') continue;
    if (b.flags.has('legacy') || b.flags.has('fragment')) continue;
    const isCompose = /^\s*services:\s*$/m.test(b.content) || (b.include && /compose/i.test(b.include)) || (b.title && /compose/i.test(b.title));
    if (!isCompose) continue;
    const cl = b.content.split('\n');
    for (let k = 0; k < cl.length; k++) {
      if (/^version:\s*['"]?\d/.test(cl[k])) err(pg.relPath, b.line + 1 + k + off, 'banned: top-level `version:` key in a Compose file');
    }
  }
}

// ---------------------------------------------------------------------------
// Structural checks (orphans, part page existence)
// ---------------------------------------------------------------------------

for (const pg of Object.values(pages)) {
  if (topIds.has(pg.id)) continue;
  if (!pg.partId) { warn(pg.relPath, 0, 'top-level page not referenced by nav.top'); continue; }
  if (!inPart.has(pg.id)) err(pg.relPath, 0, `orphan: not listed in any _part.json`);
}
for (const [partId, part] of Object.entries(parts)) {
  for (const pn of part.pages) {
    const id = `${partId}/${pn}`;
    if (!pages[id]) warn(part.file, 0, `_part.json lists a page with no file yet: ${pn}`);
  }
}

for (const pg of Object.values(pages)) {
  validateFrontMatter(pg);
  validateSections(pg);
  validateLinks(pg);
  validateCodeBlocks(pg);
  validateBans(pg);
  validateComposeVersion(pg);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function group(items) {
  const byFile = {};
  for (const it of items) { (byFile[it.file] = byFile[it.file] || []).push(it); }
  for (const f of Object.keys(byFile).sort()) {
    console.log(`\n  ${f}`);
    byFile[f].sort((a, b) => a.line - b.line);
    for (const it of byFile[f]) console.log(`    ${String(it.line).padStart(4)}  ${it.msg}`);
  }
}

console.log('Handbook content check');
console.log('======================');
console.log(`Pages: ${Object.keys(pages).length}  Parts: ${Object.keys(parts).length}`);

if (warns.length) { console.log(`\nWarnings (${warns.length}):`); group(warns); }
if (errors.length) { console.log(`\nErrors (${errors.length}):`); group(errors); }

console.log('');
if (errors.length === 0) {
  console.log(`PASS — 0 errors, ${warns.length} warning(s).`);
  process.exit(0);
} else {
  console.log(`FAIL — ${errors.length} error(s), ${warns.length} warning(s).`);
  process.exit(1);
}
