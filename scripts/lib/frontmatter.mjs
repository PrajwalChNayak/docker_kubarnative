// frontmatter.mjs — a tiny, dependency-free YAML front-matter parser.
//
// It understands only the subset used by this handbook (see CONTRIBUTING 5.1):
//   key: scalar
//   key: "quoted scalar"
//   key: []                 (empty inline list)
//   key:
//     - item
//     - item
// Anything more exotic is returned as a raw string. It never throws; on a
// malformed document it returns { data: {}, body: <original>, error: <msg> }.

function stripQuotes(s) {
  s = s.trim();
  if (s.length >= 2) {
    const a = s[0], b = s[s.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

function coerce(raw) {
  const s = raw.trim();
  if (s === '') return '';
  if (s === '[]') return [];
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  // Inline list [a, b, c]
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((x) => stripQuotes(x.trim())).filter((x) => x !== '');
  }
  return stripQuotes(s);
}

/**
 * Parse front matter fenced by `---` lines at the very top of `src`.
 * @returns {{data: object, body: string, error?: string}}
 */
export function parseFrontMatter(src) {
  // Normalise newlines so Windows checkouts behave the same as POSIX ones.
  const text = src.replace(/\r\n?/g, '\n');
  if (!text.startsWith('---\n') && text !== '---') {
    return { data: {}, body: text, error: 'no front matter' };
  }
  const lines = text.split('\n');
  // lines[0] === '---'
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) {
    return { data: {}, body: text, error: 'unterminated front matter' };
  }

  const data = {};
  let i = 1;
  try {
    while (i < end) {
      const line = lines[i];
      if (line.trim() === '' || line.trim().startsWith('#')) { i++; continue; }
      const m = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
      if (!m) { i++; continue; }
      const key = m[1];
      const rest = m[2];
      if (rest.trim() === '') {
        // Could be a block list on following indented lines.
        const items = [];
        let j = i + 1;
        while (j < end) {
          const l = lines[j];
          const lm = l.match(/^\s+-\s+(.*)$/);
          if (lm) { items.push(stripQuotes(lm[1])); j++; continue; }
          if (l.trim() === '') { j++; continue; }
          break;
        }
        data[key] = items;
        i = j;
      } else {
        data[key] = coerce(rest);
        i++;
      }
    }
  } catch (err) {
    return { data: {}, body: lines.slice(end + 1).join('\n'), error: String(err && err.message || err) };
  }

  const body = lines.slice(end + 1).join('\n');
  return { data, body };
}
