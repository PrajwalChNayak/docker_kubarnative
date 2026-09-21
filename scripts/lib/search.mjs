// search.mjs — build a compact client-side search index.
//
// One entry per page: { id, title, part, level, url, headings, text }.
// Markdown is stripped to plain text and the body is capped so the index
// stays small enough to ship inline.

import { stripInline } from './markdown.mjs';

const BODY_CAP = 2000;

function plain(body) {
  return body
    .replace(/\r\n?/g, '\n')
    // Drop fenced code blocks entirely.
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    // Drop callout/tab fences and @tab markers, keep their text.
    .replace(/^:{3,}.*$/gm, ' ')
    .replace(/^@tab\s+/gm, ' ')
    // Headings -> plain text.
    .replace(/^#{1,6}\s+/gm, ' ')
    // Tables: turn pipes into spaces.
    .replace(/\|/g, ' ')
    // Inline markdown.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {object} page { id, title, part, level, url, body, headings }
 * @returns compact index entry
 */
export function makeIndexEntry(page) {
  const text = plain(page.body).slice(0, BODY_CAP);
  const headings = (page.headings || [])
    .filter((h) => h.level === 2 || h.level === 3)
    .map((h) => h.text);
  return {
    id: page.id,
    title: page.title,
    part: page.part || '',
    level: page.level || '',
    url: page.url,
    headings,
    text,
  };
}

export function buildSearchIndex(pages) {
  return { generated: new Date().toISOString().slice(0, 10), pages: pages.map(makeIndexEntry) };
}

// re-export so callers only import one module if they prefer
export { stripInline };
