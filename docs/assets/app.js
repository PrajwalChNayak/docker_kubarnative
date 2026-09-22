/* Handbook client — dropdowns, theme, drawer, tabs, scroll-spy, search. */
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
    terms.forEach(function (t) { if (!t) return; var re = new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig'); frag = frag.replace(re, '<mark>$1</mark>'); });
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
    var terms = q.toLowerCase().split(/\s+/).filter(Boolean);
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
