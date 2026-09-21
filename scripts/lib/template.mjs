// template.mjs — page shell, stylesheet and client script for the handbook.
// Implements the UI spec in CONTRIBUTING section 6. No external assets beyond
// the system font stack; all icons are inline SVG.

import { escapeHtml } from './highlight.mjs';

const FOOTER_LINE =
  'Written against Kubernetes 1.37, Docker Engine 29, Compose v5, Helm 4 · verified 2026-09-21';

const LEVELS = ['foundations', 'beginner', 'intermediate', 'advanced', 'expert'];

// No-flash theme script — runs in <head> before first paint.
export const NOFLASH_JS =
  "(function(){try{var t=localStorage.getItem('theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}else{document.documentElement.setAttribute('data-theme','system');}}catch(e){}})();";

function icon(name) {
  const s = (p) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  switch (name) {
    case 'sun': return s('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>');
    case 'moon': return s('<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>');
    case 'search': return s('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>');
    case 'menu': return s('<path d="M3 6h18M3 12h18M3 18h18"/>');
    case 'close': return s('<path d="M18 6L6 18M6 6l12 12"/>');
    case 'chevron': return s('<path d="M6 9l6 6 6-6"/>');
    default: return '';
  }
}

function navMenus(navModel, root) {
  return navModel.map((sec) => {
    const groups = sec.parts.map((part) => {
      const links = part.pages.map((pg) =>
        `<li><a href="${root}${pg.url}">${escapeHtml(pg.title)}</a></li>`
      ).join('');
      return `<div class="menu-group"><p class="menu-group-title">${escapeHtml(part.title)}</p><ul>${links}</ul></div>`;
    }).join('');
    return `<details class="nav-menu"><summary aria-haspopup="true" aria-expanded="false">${escapeHtml(sec.title)} ${icon('chevron')}</summary><div class="menu-panel">${groups}</div></details>`;
  }).join('');
}

function drawerNav(navModel, root, topLinks) {
  const top = topLinks.map((l) => `<li><a href="${root}${l.url}">${escapeHtml(l.title)}</a></li>`).join('');
  const secs = navModel.map((sec) => {
    const parts = sec.parts.map((part) => {
      const links = part.pages.map((pg) => `<li><a href="${root}${pg.url}">${escapeHtml(pg.title)}</a></li>`).join('');
      return `<div class="drawer-part"><p class="drawer-part-title">${escapeHtml(part.title)}</p><ul>${links}</ul></div>`;
    }).join('');
    return `<section class="drawer-section"><h2>${escapeHtml(sec.title)}</h2>${parts}</section>`;
  }).join('');
  return `<nav id="drawer" class="drawer" aria-label="Sections" hidden><ul class="drawer-top">${top}</ul>${secs}</nav>`;
}

function tocHtml(headings) {
  const tops = headings.filter((h) => (h.level === 2 || h.level === 3) && h.top !== false);
  if (tops.length === 0) return '';
  const li = tops.map((h) =>
    `<li class="toc-l${h.level}"><a href="#${h.slug}">${escapeHtml(h.text)}</a></li>`
  ).join('');
  return `<nav class="toc" aria-label="On this page"><p class="toc-title">On this page</p><ul>${li}</ul></nav>`;
}

function badges(model) {
  const out = [];
  if (model.level && LEVELS.includes(model.level)) {
    out.push(`<span class="badge badge-level badge-${model.level}">${escapeHtml(model.level)}</span>`);
  } else if (model.level) {
    out.push(`<span class="badge badge-level">${escapeHtml(model.level)}</span>`);
  }
  if (model.status && model.status !== 'current') {
    out.push(`<span class="badge badge-status badge-${escapeHtml(model.status)}">${escapeHtml(model.status)}</span>`);
  }
  if (model.type) {
    out.push(`<span class="badge badge-type">${escapeHtml(model.type)}</span>`);
  }
  return out.join(' ');
}

function prereqs(list) {
  if (!list || list.length === 0) return '';
  const items = list.map((p) => {
    if (p.ok) return `<li><a href="${p.href}">${escapeHtml(p.title)}</a></li>`;
    return `<li><span class="prereq-missing" title="unresolved prerequisite">${escapeHtml(p.id)}</span></li>`;
  }).join('');
  return `<div class="prereqs"><p class="prereqs-title">Prerequisites</p><ul>${items}</ul></div>`;
}

function breadcrumb(model, root) {
  const parts = [];
  parts.push(`<a href="${root}index.html">Home</a>`);
  if (model.breadcrumb) {
    if (model.breadcrumb.sectionTitle) parts.push(`<span>${escapeHtml(model.breadcrumb.sectionTitle)}</span>`);
    if (model.breadcrumb.partTitle) parts.push(`<span>${escapeHtml(model.breadcrumb.partTitle)}</span>`);
    parts.push(`<span aria-current="page">${escapeHtml(model.title)}</span>`);
  }
  return `<nav class="breadcrumb" aria-label="Breadcrumb">${parts.join('<span class="sep" aria-hidden="true">›</span>')}</nav>`;
}

function prevNext(model, root) {
  const p = model.prev ? `<a class="pn pn-prev" href="${root}${model.prev.url}"><span>Previous</span><strong>${escapeHtml(model.prev.title)}</strong></a>` : '<span></span>';
  const n = model.next ? `<a class="pn pn-next" href="${root}${model.next.url}"><span>Next</span><strong>${escapeHtml(model.next.title)}</strong></a>` : '<span></span>';
  return `<nav class="prevnext" aria-label="Pagination">${p}${n}</nav>`;
}

/**
 * Render a complete HTML page.
 * @param {object} model
 */
export function renderPage(model) {
  const root = model.root || '';
  const title = model.title || 'Handbook';
  const siteTitle = model.site.title;
  const desc = model.description || siteTitle;

  const header = model.isLanding ? '' : `<header class="page-header">
    ${breadcrumb(model, root)}
    <h1>${escapeHtml(title)}</h1>
    <div class="badges">${badges(model)}</div>
    ${desc ? `<p class="lede">${escapeHtml(desc)}</p>` : ''}
    ${model.versions ? `<p class="version-line"><span>Version:</span> ${escapeHtml(model.versions)}</p>` : ''}
    ${prereqs(model.prerequisites)}
  </header>`;

  const toc = model.isLanding ? '' : tocHtml(model.headings || []);
  const asideClass = toc ? '' : ' no-toc';

  const bodyMain = model.isLanding
    ? `<main id="main" class="landing"><h1>${escapeHtml(title)}</h1>${desc ? `<p class="lede">${escapeHtml(desc)}</p>` : ''}${model.contentHtml}</main>`
    : `<div class="layout${asideClass}">
        <main id="main" class="content">
          ${header}
          <article class="prose">${model.contentHtml}</article>
          ${prevNext(model, root)}
        </main>
        ${toc ? `<aside class="toc-rail">${toc}</aside>` : ''}
      </div>`;

  const repoLink = model.site.repo ? `<a href="${model.site.repo}" rel="noopener noreferrer">Source on GitHub</a>` : '';

  return `<!DOCTYPE html>
<html lang="en" data-theme="system">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ${escapeHtml(siteTitle)}</title>
<meta name="description" content="${escapeHtml(desc)}">
<script>${NOFLASH_JS}</script>
<link rel="stylesheet" href="${root}assets/style.css">
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<div class="topbar">
  <div class="topbar-inner">
    <button class="hamburger" aria-label="Open menu" aria-controls="drawer" aria-expanded="false">${icon('menu')}</button>
    <a class="brand" href="${root}index.html">${escapeHtml(siteTitle)}</a>
    <nav class="nav-menus" aria-label="Main">${navMenus(model.navModel, root)}</nav>
    <div class="topbar-tools">
      <div class="search" role="search">
        <button class="search-btn" aria-label="Search">${icon('search')}</button>
        <input type="search" id="search-input" class="search-input" placeholder="Search  /" aria-label="Search the handbook" autocomplete="off">
        <div class="search-results" id="search-results" role="listbox" aria-label="Search results" hidden></div>
      </div>
      <button class="theme-toggle" aria-label="Toggle colour theme" title="Theme: system">
        <span class="theme-icon theme-light">${icon('sun')}</span>
        <span class="theme-icon theme-dark">${icon('moon')}</span>
      </button>
    </div>
  </div>
</div>
${drawerNav(model.navModel, root, model.topLinks || [])}
<div class="drawer-scrim" hidden></div>
${bodyMain}
<footer class="site-footer">
  <p class="footer-verify">${FOOTER_LINE}</p>
  <p class="footer-links">${repoLink}</p>
  ${model.isLanding ? '' : prevNext(model, root)}
</footer>
<script src="${root}assets/app.js" defer></script>
<script>window.__SEARCH_URL__=${JSON.stringify(root + 'assets/search-index.json')};</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Stylesheet
// ---------------------------------------------------------------------------

export const CSS = `/* Handbook stylesheet — hand-written, no external fonts. */
:root {
  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, "DejaVu Sans Mono", monospace;
  --prose: 48rem;
  --toc-w: 13rem;
  --gap: 2.25rem;
  --topbar-h: 56px;

  --bg: #ffffff;
  --bg-soft: #f6f7f9;
  --bg-code: #f4f5f7;
  --surface: #ffffff;
  --text: #1c2530;
  --text-soft: #55606c;
  --text-mut: #6b7684;
  --border: #e3e7ec;
  --border-strong: #cdd4dc;
  --accent: #1f6feb;
  --accent-soft: #e7f0ff;
  --focus: #1f6feb;

  --cl-note: #3b82f6; --cl-note-bg: #eff6ff;
  --cl-tip: #0d9488; --cl-tip-bg: #ecfdf7;
  --cl-best: #16a34a; --cl-best-bg: #f0fdf4;
  --cl-warn: #d97706; --cl-warn-bg: #fffbeb;
  --cl-danger: #dc2626; --cl-danger-bg: #fef2f2;
  --cl-deprecated: #db2777; --cl-deprecated-bg: #fdf2f8;
  --cl-legacy: #6b7280; --cl-legacy-bg: #f3f4f6;

  --tok-comment: #6a737d;
  --tok-string: #067d17;
  --tok-number: #b5690a;
  --tok-keyword: #a626a4;
  --tok-key: #1f6feb;
  --tok-builtin: #005cc5;
  --tok-meta: #6f42c1;
  --tok-punct: #57606a;
  --tok-op: #cf222e;
  --tok-added: #116329; --tok-added-bg: #e6ffec;
  --tok-removed: #a40e26; --tok-removed-bg: #ffebe9;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0e1116; --bg-soft: #161b22; --bg-code: #161b22; --surface: #12161c;
    --text: #e6edf3; --text-soft: #aeb9c5; --text-mut: #8b97a4;
    --border: #262c34; --border-strong: #333b45;
    --accent: #4c9aff; --accent-soft: #16263f; --focus: #4c9aff;
    --cl-note: #60a5fa; --cl-note-bg: #12213a;
    --cl-tip: #2dd4bf; --cl-tip-bg: #10241f;
    --cl-best: #4ade80; --cl-best-bg: #10241a;
    --cl-warn: #fbbf24; --cl-warn-bg: #2a2110;
    --cl-danger: #f87171; --cl-danger-bg: #2c1416;
    --cl-deprecated: #f472b6; --cl-deprecated-bg: #2b1420;
    --cl-legacy: #9aa4b1; --cl-legacy-bg: #1a1f26;
    --tok-comment: #8b949e; --tok-string: #7ee787; --tok-number: #ffab70;
    --tok-keyword: #d2a8ff; --tok-key: #79c0ff; --tok-builtin: #79c0ff;
    --tok-meta: #d2a8ff; --tok-punct: #8b949e; --tok-op: #ff7b72;
    --tok-added: #7ee787; --tok-added-bg: #12261a; --tok-removed: #ffa198; --tok-removed-bg: #2c1416;
  }
}
:root[data-theme="dark"] {
  --bg: #0e1116; --bg-soft: #161b22; --bg-code: #161b22; --surface: #12161c;
  --text: #e6edf3; --text-soft: #aeb9c5; --text-mut: #8b97a4;
  --border: #262c34; --border-strong: #333b45;
  --accent: #4c9aff; --accent-soft: #16263f; --focus: #4c9aff;
  --cl-note: #60a5fa; --cl-note-bg: #12213a;
  --cl-tip: #2dd4bf; --cl-tip-bg: #10241f;
  --cl-best: #4ade80; --cl-best-bg: #10241a;
  --cl-warn: #fbbf24; --cl-warn-bg: #2a2110;
  --cl-danger: #f87171; --cl-danger-bg: #2c1416;
  --cl-deprecated: #f472b6; --cl-deprecated-bg: #2b1420;
  --cl-legacy: #9aa4b1; --cl-legacy-bg: #1a1f26;
  --tok-comment: #8b949e; --tok-string: #7ee787; --tok-number: #ffab70;
  --tok-keyword: #d2a8ff; --tok-key: #79c0ff; --tok-builtin: #79c0ff;
  --tok-meta: #d2a8ff; --tok-punct: #8b949e; --tok-op: #ff7b72;
  --tok-added: #7ee787; --tok-added-bg: #12261a; --tok-removed: #ffa198; --tok-removed-bg: #2c1416;
}

* { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: calc(var(--topbar-h) + 1rem); }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } * { animation: none !important; transition: none !important; } }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font-family: var(--font-sans); font-size: 16px; line-height: 1.62;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 3px; }

.skip-link { position: fixed; left: 0.5rem; top: -3rem; z-index: 100; background: var(--accent); color: #fff; padding: 0.5rem 0.9rem; border-radius: 6px; transition: top .15s; }
.skip-link:focus { top: 0.5rem; }

/* Topbar */
.topbar { position: sticky; top: 0; z-index: 50; height: var(--topbar-h); background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: saturate(1.6) blur(8px); border-bottom: 1px solid var(--border); }
.topbar-inner { height: var(--topbar-h); max-width: 90rem; margin: 0 auto; padding: 0 1rem; display: flex; align-items: center; gap: 0.75rem; }
.brand { font-weight: 650; color: var(--text); font-size: 0.98rem; white-space: nowrap; }
.brand:hover { text-decoration: none; }
.nav-menus { display: flex; align-items: center; gap: 0.15rem; margin-left: 0.5rem; flex: 1; }
.hamburger, .search-btn, .theme-toggle { display: inline-flex; align-items: center; justify-content: center; background: transparent; border: 1px solid transparent; border-radius: 7px; color: var(--text-soft); cursor: pointer; padding: 0.4rem; }
.hamburger:hover, .search-btn:hover, .theme-toggle:hover { background: var(--bg-soft); color: var(--text); }
.hamburger { display: none; }

.nav-menu { position: relative; }
.nav-menu > summary { list-style: none; cursor: pointer; padding: 0.4rem 0.6rem; border-radius: 7px; color: var(--text-soft); font-size: 0.9rem; display: inline-flex; align-items: center; gap: 0.15rem; white-space: nowrap; }
.nav-menu > summary::-webkit-details-marker { display: none; }
.nav-menu > summary svg { width: 14px; height: 14px; opacity: .6; }
.nav-menu[open] > summary, .nav-menu > summary:hover { background: var(--bg-soft); color: var(--text); }
.menu-panel { position: absolute; top: calc(100% + 6px); left: 0; min-width: 16rem; max-width: 22rem; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.14); padding: 0.6rem; display: grid; gap: 0.4rem; max-height: 70vh; overflow: auto; }
.menu-group-title { margin: 0.2rem 0.3rem; font-size: 0.72rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-mut); }
.menu-panel ul { list-style: none; margin: 0 0 0.3rem; padding: 0; }
.menu-panel a { display: block; padding: 0.28rem 0.5rem; border-radius: 6px; color: var(--text-soft); font-size: 0.87rem; }
.menu-panel a:hover { background: var(--accent-soft); color: var(--text); text-decoration: none; }

.topbar-tools { display: flex; align-items: center; gap: 0.35rem; margin-left: auto; }
.search { position: relative; display: flex; align-items: center; }
.search .search-btn { display: none; }
.search-input { width: 13rem; max-width: 40vw; padding: 0.4rem 0.6rem; font-size: 0.85rem; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--bg-soft); color: var(--text); }
.search-input:focus { outline: none; border-color: var(--accent); background: var(--surface); }
.search-results { position: absolute; top: calc(100% + 6px); right: 0; width: 28rem; max-width: 92vw; max-height: 70vh; overflow: auto; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.18); padding: 0.4rem; z-index: 60; }
.search-result { display: block; padding: 0.5rem 0.6rem; border-radius: 8px; color: var(--text); }
.search-result[aria-selected="true"], .search-result:hover { background: var(--accent-soft); text-decoration: none; }
.search-result .sr-title { font-weight: 600; font-size: 0.9rem; }
.search-result .sr-meta { font-size: 0.72rem; color: var(--text-mut); }
.search-result .sr-snippet { font-size: 0.8rem; color: var(--text-soft); margin-top: 0.15rem; }
.search-result mark { background: transparent; color: var(--accent); font-weight: 600; }
.search-empty { padding: 0.8rem; color: var(--text-mut); font-size: 0.85rem; }

.theme-icon { display: none; }
:root[data-theme="light"] .theme-light, :root[data-theme="dark"] .theme-dark, :root[data-theme="system"] .theme-dark { display: inline-flex; }

/* Drawer */
.drawer { position: fixed; top: var(--topbar-h); left: 0; bottom: 0; width: min(20rem, 86vw); background: var(--surface); border-right: 1px solid var(--border); overflow: auto; padding: 1rem 1.1rem 3rem; z-index: 45; }
.drawer[hidden] { display: none; }
.drawer-scrim { position: fixed; inset: var(--topbar-h) 0 0 0; background: rgba(0,0,0,.35); z-index: 44; }
.drawer-scrim[hidden] { display: none; }
.drawer-top { list-style: none; margin: 0 0 1rem; padding: 0 0 0.6rem; border-bottom: 1px solid var(--border); }
.drawer-top a { display: block; padding: 0.35rem 0; font-weight: 600; }
.drawer-section h2 { font-size: 0.78rem; text-transform: uppercase; letter-spacing: .05em; color: var(--text-mut); margin: 1rem 0 0.35rem; }
.drawer-part-title { font-size: 0.8rem; font-weight: 650; margin: 0.6rem 0 0.2rem; color: var(--text-soft); }
.drawer-part ul { list-style: none; margin: 0 0 0.4rem; padding: 0; }
.drawer-part a { display: block; padding: 0.22rem 0.4rem; font-size: 0.85rem; color: var(--text-soft); border-radius: 6px; }
.drawer-part a:hover { background: var(--accent-soft); color: var(--text); text-decoration: none; }

/* Layout */
.layout { max-width: calc(1.5rem + var(--prose) + var(--gap) + var(--toc-w) + 1.5rem); margin: 0 auto; padding: 1.5rem 1.5rem 4rem; display: grid; grid-template-columns: minmax(0, var(--prose)) var(--toc-w); gap: var(--gap); justify-content: center; }
.layout.no-toc { grid-template-columns: minmax(0, var(--prose)); }
.content { min-width: 0; }
.prose { max-width: var(--prose); }
.landing { max-width: 62rem; margin: 0 auto; padding: 2rem 1.5rem 4rem; }

/* Page header */
.page-header { margin-bottom: 1.5rem; }
.breadcrumb { font-size: 0.78rem; color: var(--text-mut); display: flex; flex-wrap: wrap; gap: 0.3rem; align-items: center; margin-bottom: 0.7rem; }
.breadcrumb .sep { color: var(--border-strong); }
.breadcrumb a { color: var(--text-mut); }
.breadcrumb [aria-current="page"] { color: var(--text-soft); }
.page-header h1 { font-size: 2rem; line-height: 1.2; margin: 0.2rem 0 0.6rem; text-wrap: balance; }
.badges { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 0.7rem; }
.badge { font-size: 0.7rem; font-weight: 600; padding: 0.15rem 0.5rem; border-radius: 999px; text-transform: capitalize; border: 1px solid transparent; }
.badge-level { background: var(--bg-soft); color: var(--text-soft); border-color: var(--border); }
.badge-foundations { background: #eef2ff; color: #4338ca; border-color: #c7d2fe; }
.badge-beginner { background: #ecfdf5; color: #047857; border-color: #a7f3d0; }
.badge-intermediate { background: #eff6ff; color: #1d4ed8; border-color: #bfdbfe; }
.badge-advanced { background: #fff7ed; color: #c2410c; border-color: #fed7aa; }
.badge-expert { background: #fdf2f8; color: #be185d; border-color: #fbcfe8; }
.badge-type { background: var(--bg-soft); color: var(--text-mut); border-color: var(--border); }
.badge-status { color: #fff; }
.badge-beta { background: #2563eb; }
.badge-alpha { background: #7c3aed; }
.badge-legacy { background: #6b7280; }
.badge-deprecated { background: #db2777; }
:root[data-theme="dark"] .badge-foundations,:root[data-theme="dark"] .badge-beginner,:root[data-theme="dark"] .badge-intermediate,:root[data-theme="dark"] .badge-advanced,:root[data-theme="dark"] .badge-expert { background: var(--bg-soft); color: var(--text); border-color: var(--border-strong); }
.lede { font-size: 1.08rem; color: var(--text-soft); margin: 0.4rem 0 0.8rem; text-wrap: pretty; }
.version-line { font-size: 0.82rem; color: var(--text-mut); margin: 0.3rem 0; }
.version-line span { font-weight: 600; color: var(--text-soft); }
.prereqs { margin-top: 0.9rem; padding: 0.7rem 0.9rem; background: var(--bg-soft); border: 1px solid var(--border); border-radius: 10px; }
.prereqs-title { margin: 0 0 0.3rem; font-size: 0.78rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-mut); }
.prereqs ul { margin: 0; padding-left: 1.1rem; }
.prereqs li { font-size: 0.88rem; }
.prereq-missing { color: var(--cl-danger); text-decoration: underline dotted; }

/* Prose typography */
.prose { text-wrap: pretty; }
.prose > * { margin-top: 0; }
.prose p { margin: 0 0 1rem; }
.prose h2 { font-size: 1.45rem; font-weight: 650; line-height: 1.25; margin: 2.5rem 0 0.75rem; padding-top: 1.1rem; border-top: 1px solid var(--border); text-wrap: balance; }
.prose h3 { font-size: 1.15rem; font-weight: 640; margin: 1.8rem 0 0.6rem; text-wrap: balance; }
.prose h4 { font-size: 1rem; font-weight: 640; margin: 1.4rem 0 0.5rem; }
.prose h2:first-child, .prose h3:first-child { margin-top: 0; border-top: 0; padding-top: 0; }
.anchor-link { margin-left: 0.4rem; color: var(--text-mut); opacity: 0; font-weight: 400; text-decoration: none; }
.prose h2:hover .anchor-link, .prose h3:hover .anchor-link, .anchor-link:focus { opacity: 1; }
.prose ul, .prose ol { margin: 0 0 1rem; padding-left: 1.4rem; }
.prose li { margin: 0.25rem 0; }
.prose li > ul, .prose li > ol { margin: 0.3rem 0; }
.prose blockquote { margin: 0 0 1rem; padding: 0.3rem 0 0.3rem 1rem; border-left: 3px solid var(--border-strong); color: var(--text-soft); }
.prose img { max-width: 100%; height: auto; border-radius: 8px; }
.prose hr { border: 0; border-top: 1px solid var(--border); margin: 2rem 0; }
.prose code { font-family: var(--font-mono); font-size: 0.86em; background: var(--bg-code); padding: 0.12em 0.35em; border-radius: 5px; border: 1px solid var(--border); }
.prose a code { color: inherit; }

/* Tables */
.table-wrap { overflow-x: auto; margin: 0 0 1.2rem; border: 1px solid var(--border); border-radius: 10px; }
.prose table { border-collapse: collapse; width: 100%; font-size: 0.88rem; }
.prose th, .prose td { text-align: left; padding: 0.55rem 0.8rem; border-bottom: 1px solid var(--border); vertical-align: top; }
.prose thead th { background: var(--bg-soft); font-weight: 640; }
.prose tbody tr:last-child td { border-bottom: 0; }

/* Code blocks */
.code-block { margin: 0 0 1.3rem; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: var(--bg-code); }
.code-head { display: flex; align-items: center; gap: 0.6rem; padding: 0.4rem 0.7rem; background: var(--bg-soft); border-bottom: 1px solid var(--border); font-size: 0.76rem; }
.code-file { font-family: var(--font-mono); color: var(--text-soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.code-tools { margin-left: auto; display: flex; align-items: center; gap: 0.5rem; }
.code-lang { color: var(--text-mut); text-transform: uppercase; letter-spacing: .04em; font-size: 0.68rem; }
.copy-btn { font: inherit; font-size: 0.72rem; padding: 0.2rem 0.55rem; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--surface); color: var(--text-soft); cursor: pointer; }
.copy-btn:hover { color: var(--text); border-color: var(--accent); }
.copy-btn.copied { color: var(--cl-best); border-color: var(--cl-best); }
.code-pre { margin: 0; padding: 0.85rem 0.95rem; overflow-x: auto; }
.code-pre code { font-family: var(--font-mono); font-size: 0.82rem; line-height: 1.55; background: none; border: 0; padding: 0; white-space: pre; }
.missing-include { margin: 0 0 1.3rem; padding: 0.7rem 0.9rem; border: 1px dashed var(--cl-danger); border-radius: 8px; background: var(--cl-danger-bg); color: var(--cl-danger); font-family: var(--font-mono); font-size: 0.82rem; }

.tok-comment { color: var(--tok-comment); font-style: italic; }
.tok-string { color: var(--tok-string); }
.tok-number { color: var(--tok-number); }
.tok-keyword { color: var(--tok-keyword); }
.tok-key { color: var(--tok-key); }
.tok-builtin { color: var(--tok-builtin); }
.tok-meta { color: var(--tok-meta); }
.tok-punct { color: var(--tok-punct); }
.tok-op { color: var(--tok-op); }
.tok-added { color: var(--tok-added); background: var(--tok-added-bg); display: inline-block; width: 100%; }
.tok-removed { color: var(--tok-removed); background: var(--tok-removed-bg); display: inline-block; width: 100%; }

/* Callouts */
.callout { margin: 0 0 1.3rem; padding: 0.8rem 1rem; border: 1px solid var(--border); border-left: 4px solid var(--cl-note); border-radius: 8px; background: var(--cl-note-bg); }
.callout-head { display: flex; align-items: center; gap: 0.5rem; font-weight: 640; font-size: 0.9rem; margin-bottom: 0.35rem; }
.callout-icon { display: inline-flex; }
.callout-body > *:last-child { margin-bottom: 0; }
.callout-note { border-left-color: var(--cl-note); background: var(--cl-note-bg); } .callout-note .callout-head { color: var(--cl-note); }
.callout-tip { border-left-color: var(--cl-tip); background: var(--cl-tip-bg); } .callout-tip .callout-head { color: var(--cl-tip); }
.callout-best-practice { border-left-color: var(--cl-best); background: var(--cl-best-bg); } .callout-best-practice .callout-head { color: var(--cl-best); }
.callout-warning { border-left-color: var(--cl-warn); background: var(--cl-warn-bg); } .callout-warning .callout-head { color: var(--cl-warn); }
.callout-danger { border-left-color: var(--cl-danger); background: var(--cl-danger-bg); } .callout-danger .callout-head { color: var(--cl-danger); }
.callout-deprecated { border-left-color: var(--cl-deprecated); background: var(--cl-deprecated-bg); } .callout-deprecated .callout-head { color: var(--cl-deprecated); }
.callout-legacy { border-left-color: var(--cl-legacy); background: var(--cl-legacy-bg); } .callout-legacy .callout-head { color: var(--cl-legacy); }

/* Tabs */
.tabs { margin: 0 0 1.3rem; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.tablist { display: none; }
.tabs.js-tabs .tablist { display: flex; flex-wrap: wrap; gap: 0.2rem; background: var(--bg-soft); border-bottom: 1px solid var(--border); padding: 0.35rem; }
.tablist button { font: inherit; font-size: 0.85rem; padding: 0.35rem 0.75rem; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--text-soft); cursor: pointer; }
.tablist button[aria-selected="true"] { background: var(--surface); color: var(--text); border-color: var(--border); }
.tab-panel { padding: 0.9rem 1rem; }
.tabs.js-tabs .tab-panel[hidden] { display: none; }
.tab-label { font-weight: 640; font-size: 0.9rem; margin: 0 0 0.6rem; padding-bottom: 0.4rem; border-bottom: 1px solid var(--border); color: var(--text-soft); }
.tabs.js-tabs .tab-label { display: none; }
.tab-content > *:last-child { margin-bottom: 0; }

/* TOC */
.toc-rail { position: sticky; top: calc(var(--topbar-h) + 1.5rem); align-self: start; max-height: calc(100vh - var(--topbar-h) - 3rem); overflow: auto; }
.toc-title { font-size: 0.72rem; text-transform: uppercase; letter-spacing: .05em; color: var(--text-mut); margin: 0 0 0.5rem; }
.toc ul { list-style: none; margin: 0; padding: 0; border-left: 1px solid var(--border); }
.toc li a { display: block; padding: 0.22rem 0 0.22rem 0.8rem; margin-left: -1px; border-left: 2px solid transparent; font-size: 0.8rem; color: var(--text-mut); }
.toc li.toc-l3 a { padding-left: 1.6rem; }
.toc li a:hover { color: var(--text); text-decoration: none; }
.toc li a.active { color: var(--accent); border-left-color: var(--accent); font-weight: 500; }

/* Prev/next + breadcrumb footer */
.prevnext { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 2.5rem; }
.pn { border: 1px solid var(--border); border-radius: 10px; padding: 0.7rem 0.9rem; display: flex; flex-direction: column; gap: 0.15rem; }
.pn:hover { border-color: var(--accent); text-decoration: none; }
.pn span { font-size: 0.72rem; color: var(--text-mut); text-transform: uppercase; letter-spacing: .04em; }
.pn strong { color: var(--text); font-weight: 600; font-size: 0.92rem; }
.pn-next { text-align: right; }

.site-footer { border-top: 1px solid var(--border); margin-top: 2rem; padding: 1.5rem; max-width: 90rem; margin-left: auto; margin-right: auto; color: var(--text-mut); font-size: 0.82rem; }
.site-footer .prevnext { display: none; }
.footer-verify { margin: 0 0 0.4rem; }

/* Landing */
.landing h1 { font-size: 2.2rem; text-wrap: balance; }
.landing .section-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: 1rem; margin: 1.5rem 0; }
.landing .section-card { border: 1px solid var(--border); border-radius: 12px; padding: 1rem 1.1rem; background: var(--surface); }
.landing .section-card h2 { font-size: 1.05rem; margin: 0 0 0.5rem; }
.landing .section-card ul { list-style: none; margin: 0; padding: 0; }
.landing .section-card li { margin: 0.2rem 0; font-size: 0.88rem; }

/* Responsive */
@media (max-width: 1180px) {
  .layout { grid-template-columns: minmax(0, var(--prose)); }
  .toc-rail { display: none; }
}
@media (max-width: 1040px) {
  :root { --gap: 1rem; }
  .nav-menus { display: none; }
  .hamburger { display: inline-flex; }
  .layout, .landing { padding-left: 1rem; padding-right: 1rem; }
  .prevnext { grid-template-columns: 1fr; }
}
@media (max-width: 640px) {
  :root { --topbar-h: 56px; }
  body { padding: 0; }
  .layout, .landing { padding-left: 0.875rem; padding-right: 0.875rem; }
  .search-input { width: 8rem; }
  .page-header h1 { font-size: 1.6rem; }
}
@media (pointer: coarse) { .anchor-link { opacity: 1; } }

/* Print */
@media print {
  .topbar, .drawer, .drawer-scrim, .toc-rail, .prevnext, .site-footer .footer-links, .hamburger, .skip-link, .copy-btn { display: none !important; }
  .layout { grid-template-columns: 1fr; display: block; max-width: none; }
  body { font-size: 11pt; color: #000; background: #fff; }
  .prose a[href^="http"]::after { content: " (" attr(href) ")"; font-size: 0.85em; color: #444; word-break: break-all; }
  .code-block, .callout, .table-wrap { break-inside: avoid; }
}
`;

// ---------------------------------------------------------------------------
// Client script
// ---------------------------------------------------------------------------

export const APP_JS = `/* Handbook client — dropdowns, theme, drawer, tabs, scroll-spy, search. */
(function () {
  'use strict';
  var doc = document;

  /* ---- Theme toggle (light / dark / system) ---- */
  var root = doc.documentElement;
  function currentTheme() { try { return localStorage.getItem('theme') || 'system'; } catch (e) { return 'system'; } }
  function applyTheme(t) {
    root.setAttribute('data-theme', t);
    try { if (t === 'system') localStorage.removeItem('theme'); else localStorage.setItem('theme', t); } catch (e) {}
    var btn = doc.querySelector('.theme-toggle');
    if (btn) btn.title = 'Theme: ' + t;
  }
  var themeBtn = doc.querySelector('.theme-toggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var order = ['system', 'light', 'dark'];
      var next = order[(order.indexOf(currentTheme()) + 1) % order.length];
      applyTheme(next);
    });
    themeBtn.title = 'Theme: ' + currentTheme();
  }

  /* ---- Section dropdowns: one open at a time, outside click, Escape, hover on fine pointers ---- */
  var menus = Array.prototype.slice.call(doc.querySelectorAll('.nav-menu'));
  function closeMenus(except) {
    menus.forEach(function (m) { if (m !== except) { m.removeAttribute('open'); var s = m.querySelector('summary'); if (s) s.setAttribute('aria-expanded', 'false'); } });
  }
  menus.forEach(function (m) {
    var sum = m.querySelector('summary');
    m.addEventListener('toggle', function () {
      if (sum) sum.setAttribute('aria-expanded', m.open ? 'true' : 'false');
      if (m.open) closeMenus(m);
    });
  });
  var finePointer = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)');
  if (finePointer && finePointer.matches) {
    menus.forEach(function (m) {
      var t;
      m.addEventListener('mouseenter', function () { clearTimeout(t); closeMenus(m); m.setAttribute('open', ''); });
      m.addEventListener('mouseleave', function () { t = setTimeout(function () { m.removeAttribute('open'); }, 120); });
    });
  }
  doc.addEventListener('click', function (e) {
    if (!e.target.closest('.nav-menu')) closeMenus(null);
    if (!e.target.closest('.search')) hideSearch();
  });
  doc.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeMenus(null); hideSearch(); closeDrawer(); }
  });

  /* ---- Drawer ---- */
  var drawer = doc.getElementById('drawer');
  var scrim = doc.querySelector('.drawer-scrim');
  var burger = doc.querySelector('.hamburger');
  function openDrawer() { if (!drawer) return; drawer.hidden = false; if (scrim) scrim.hidden = false; if (burger) burger.setAttribute('aria-expanded', 'true'); }
  function closeDrawer() { if (!drawer) return; drawer.hidden = true; if (scrim) scrim.hidden = true; if (burger) burger.setAttribute('aria-expanded', 'false'); }
  if (burger) burger.addEventListener('click', function () { drawer && drawer.hidden ? openDrawer() : closeDrawer(); });
  if (scrim) scrim.addEventListener('click', closeDrawer);
  if (drawer) drawer.addEventListener('click', function (e) { if (e.target.closest('a')) closeDrawer(); });

  /* ---- Copy buttons ---- */
  doc.querySelectorAll('.copy-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var fig = btn.closest('.code-block');
      var code = fig && fig.querySelector('code');
      if (!code) return;
      var text = code.textContent;
      var done = function () { btn.textContent = 'Copied'; btn.classList.add('copied'); setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done, done); }
      else { try { var ta = doc.createElement('textarea'); ta.value = text; doc.body.appendChild(ta); ta.select(); doc.execCommand('copy'); doc.body.removeChild(ta); done(); } catch (e) {} }
    });
  });

  /* ---- Tabs ---- */
  doc.querySelectorAll('.tabs[data-tabs]').forEach(function (group) {
    group.classList.add('js-tabs');
    var tabs = Array.prototype.slice.call(group.querySelectorAll('[role=tab]'));
    var panels = Array.prototype.slice.call(group.querySelectorAll('[role=tabpanel]'));
    function select(idx) {
      tabs.forEach(function (t, i) { t.setAttribute('aria-selected', i === idx ? 'true' : 'false'); t.tabIndex = i === idx ? 0 : -1; });
      panels.forEach(function (p, i) { p.hidden = i !== idx; });
    }
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { select(i); });
      t.addEventListener('keydown', function (e) {
        var ni = null;
        if (e.key === 'ArrowRight') ni = (i + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') ni = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') ni = 0;
        else if (e.key === 'End') ni = tabs.length - 1;
        if (ni !== null) { e.preventDefault(); select(ni); tabs[ni].focus(); }
      });
    });
    select(0);
  });

  /* ---- Scroll-spy for the TOC ---- */
  var tocLinks = Array.prototype.slice.call(doc.querySelectorAll('.toc a'));
  if (tocLinks.length && 'IntersectionObserver' in window) {
    var byId = {};
    tocLinks.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
    var heads = Array.prototype.slice.call(doc.querySelectorAll('.prose h2[id], .prose h3[id]'));
    var visible = new Set();
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) visible.add(en.target.id); else visible.delete(en.target.id); });
      var firstVisible = heads.filter(function (h) { return visible.has(h.id); })[0];
      var activeId = firstVisible ? firstVisible.id : null;
      tocLinks.forEach(function (a) { a.classList.remove('active'); });
      if (activeId && byId[activeId]) byId[activeId].classList.add('active');
    }, { rootMargin: '-80px 0px -70% 0px', threshold: 0 });
    heads.forEach(function (h) { obs.observe(h); });
  }

  /* ---- Search ---- */
  var input = doc.getElementById('search-input');
  var results = doc.getElementById('search-results');
  var index = null;
  var selected = -1;
  var lastMatches = [];
  function loadIndex(cb) {
    if (index) { cb(); return; }
    fetch(window.__SEARCH_URL__).then(function (r) { return r.json(); }).then(function (d) { index = d.pages || []; cb(); }).catch(function () { index = []; cb(); });
  }
  function esc(s) { return s.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function hideSearch() { if (results) { results.hidden = true; } selected = -1; }
  function score(page, terms) {
    var hay = (page.title + ' ' + page.headings.join(' ') + ' ' + page.text).toLowerCase();
    var s = 0;
    for (var i = 0; i < terms.length; i++) {
      var t = terms[i];
      if (page.title.toLowerCase().indexOf(t) >= 0) s += 10;
      if (page.headings.join(' ').toLowerCase().indexOf(t) >= 0) s += 4;
      var idx = hay.indexOf(t);
      if (idx < 0) return -1;
      s += 1;
    }
    return s;
  }
  function snippet(text, terms) {
    var low = text.toLowerCase();
    var idx = -1;
    for (var i = 0; i < terms.length; i++) { var p = low.indexOf(terms[i]); if (p >= 0 && (idx < 0 || p < idx)) idx = p; }
    if (idx < 0) idx = 0;
    var start = Math.max(0, idx - 40);
    var frag = (start > 0 ? '…' : '') + text.slice(start, start + 140) + '…';
    frag = esc(frag);
    terms.forEach(function (t) { if (!t) return; var re = new RegExp('(' + t.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&') + ')', 'ig'); frag = frag.replace(re, '<mark>$1</mark>'); });
    return frag;
  }
  function render(matches, terms) {
    lastMatches = matches; selected = -1;
    if (!matches.length) { results.innerHTML = '<div class="search-empty">No results</div>'; results.hidden = false; return; }
    results.innerHTML = matches.map(function (m, i) {
      return '<a class="search-result" role="option" id="sr-' + i + '" href="' + m.url + '">' +
        '<div class="sr-title">' + esc(m.title) + '</div>' +
        '<div class="sr-meta">' + esc(m.part || '') + (m.level ? ' · ' + esc(m.level) : '') + '</div>' +
        '<div class="sr-snippet">' + snippet(m.text, terms) + '</div></a>';
    }).join('');
    results.hidden = false;
  }
  function run(q) {
    var terms = q.toLowerCase().split(/\\s+/).filter(Boolean);
    if (!terms.length) { hideSearch(); return; }
    var scored = index.map(function (p) { return { p: p, s: score(p, terms) }; }).filter(function (x) { return x.s >= 0; });
    scored.sort(function (a, b) { return b.s - a.s; });
    render(scored.slice(0, 12).map(function (x) { return x.p; }), terms);
  }
  function highlightSel() {
    var opts = Array.prototype.slice.call(results.querySelectorAll('.search-result'));
    opts.forEach(function (o, i) { o.setAttribute('aria-selected', i === selected ? 'true' : 'false'); if (i === selected) o.scrollIntoView({ block: 'nearest' }); });
  }
  if (input) {
    input.addEventListener('input', function () { loadIndex(function () { run(input.value); }); });
    input.addEventListener('focus', function () { loadIndex(function () { if (input.value) run(input.value); }); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); selected = Math.min(selected + 1, lastMatches.length - 1); highlightSel(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(selected - 1, 0); highlightSel(); }
      else if (e.key === 'Enter') { var opts = results.querySelectorAll('.search-result'); if (selected >= 0 && opts[selected]) { window.location.href = opts[selected].getAttribute('href'); } else if (opts[0]) { window.location.href = opts[0].getAttribute('href'); } }
    });
  }
  doc.addEventListener('keydown', function (e) {
    if (e.key === '/' && doc.activeElement !== input && !/^(INPUT|TEXTAREA|SELECT)$/.test(doc.activeElement.tagName)) {
      e.preventDefault(); if (input) input.focus();
    }
  });
})();
`;
