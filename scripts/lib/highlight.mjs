// highlight.mjs — a tiny, robust, regex-based syntax highlighter.
//
// It never throws. Unknown languages fall through to escaped plain text.
// Each language is a list of sticky-regex rules [regex, className]; the
// tokenizer walks the string, emitting the first matching rule at each
// position and escaping everything else one character at a time.

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Every regex here MUST carry the sticky flag `y` so exec() only matches at
// the current index.
function r(source, flags = '') { return new RegExp(source, 'y' + flags); }

const COMMENT_HASH = [r('#[^\\n]*'), 'tok-comment'];
const STRING_DQ = [r('"(?:\\\\.|[^"\\\\])*"'), 'tok-string'];
const STRING_SQ = [r("'(?:\\\\.|[^'\\\\])*'"), 'tok-string'];
const NUMBER = [r('\\b\\d[\\d_]*(?:\\.\\d+)?\\b'), 'tok-number'];
const WS = [r('\\s+'), null];

const RULES = {
  yaml: [
    COMMENT_HASH,
    // key: (at start of a token position) — capture the key and colon
    [r('(?:-\\s+)?[A-Za-z0-9_.$/-]+(?=\\s*:(?:\\s|$))'), 'tok-key'],
    [r('&[A-Za-z0-9_-]+|\\*[A-Za-z0-9_-]+'), 'tok-meta'],
    STRING_DQ, STRING_SQ,
    [r('\\b(?:true|false|null|yes|no|on|off|~)\\b'), 'tok-keyword'],
    NUMBER,
    [r('[|>][-+]?'), 'tok-op'],
    [r('[:\\-]'), 'tok-punct'],
    WS,
  ],
  dockerfile: [
    COMMENT_HASH,
    [r('^\\s*#\\s*syntax=.*', 'm'), 'tok-meta'],
    [r('^\\s*(?:FROM|RUN|CMD|LABEL|MAINTAINER|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)\\b', 'im'), 'tok-keyword'],
    [r('\\b(?:AS|as)\\b'), 'tok-keyword'],
    [r('--[A-Za-z0-9-]+'), 'tok-builtin'],
    STRING_DQ, STRING_SQ,
    NUMBER,
    WS,
  ],
  bash: [
    COMMENT_HASH,
    STRING_DQ, STRING_SQ,
    [r('\\$\\{[^}]*\\}|\\$[A-Za-z0-9_]+'), 'tok-meta'],
    [r('^\\s*(?:sudo|apt|apt-get|dnf|yum|docker|kubectl|helm|kind|curl|wget|systemctl|install|tee|chmod|groupadd|usermod|newgrp|export|cd|echo|cat|ls|rm|mkdir|cp|mv|grep|sed|awk|base64|openssl|git|make|go|node|npm|sh|bash)\\b', 'm'), 'tok-builtin'],
    [r('\\b(?:if|then|else|elif|fi|for|while|do|done|case|esac|in|function|return|local)\\b'), 'tok-keyword'],
    [r('--[A-Za-z0-9-]+|(?<![\\w-])-[A-Za-z]+'), 'tok-op'],
    NUMBER,
    WS,
  ],
  console: [
    COMMENT_HASH,
    STRING_DQ, STRING_SQ,
    NUMBER,
    WS,
  ],
  json: [
    [r('"(?:\\\\.|[^"\\\\])*"(?=\\s*:)'), 'tok-key'],
    STRING_DQ,
    [r('\\b(?:true|false|null)\\b'), 'tok-keyword'],
    [r('-?\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][-+]?\\d+)?\\b'), 'tok-number'],
    [r('[{}\\[\\],:]'), 'tok-punct'],
    WS,
  ],
  go: [
    [r('//[^\\n]*'), 'tok-comment'],
    [r('/\\*[\\s\\S]*?\\*/'), 'tok-comment'],
    STRING_DQ,
    [r('`[^`]*`'), 'tok-string'],
    [r("'(?:\\\\.|[^'\\\\])'"), 'tok-string'],
    [r('\\b(?:package|import|func|var|const|type|struct|interface|map|chan|go|defer|return|if|else|for|range|switch|case|default|select|break|continue|fallthrough|goto)\\b'), 'tok-keyword'],
    [r('\\b(?:string|int|int8|int16|int32|int64|uint|uint8|uint16|uint32|uint64|byte|rune|float32|float64|bool|error|any|nil|true|false|iota)\\b'), 'tok-builtin'],
    NUMBER,
    WS,
  ],
  hcl: [
    COMMENT_HASH,
    [r('//[^\\n]*'), 'tok-comment'],
    [r('[A-Za-z0-9_-]+(?=\\s*=)'), 'tok-key'],
    STRING_DQ,
    [r('\\b(?:true|false|null)\\b'), 'tok-keyword'],
    [r('\\b(?:variable|resource|data|module|provider|output|locals|terraform|target|group)\\b'), 'tok-keyword'],
    NUMBER,
    [r('[{}\\[\\]=]'), 'tok-punct'],
    WS,
  ],
  toml: [
    COMMENT_HASH,
    [r('^\\s*\\[\\[?[^\\]]+\\]\\]?', 'm'), 'tok-meta'],
    [r('[A-Za-z0-9_.-]+(?=\\s*=)'), 'tok-key'],
    STRING_DQ, STRING_SQ,
    [r('\\b(?:true|false)\\b'), 'tok-keyword'],
    NUMBER,
    [r('='), 'tok-punct'],
    WS,
  ],
  ini: [
    [r('[;#][^\\n]*'), 'tok-comment'],
    [r('^\\s*\\[[^\\]]+\\]', 'm'), 'tok-meta'],
    [r('[A-Za-z0-9_.-]+(?=\\s*=)'), 'tok-key'],
    STRING_DQ, STRING_SQ,
    [r('\\b(?:true|false)\\b'), 'tok-keyword'],
    NUMBER,
    [r('='), 'tok-punct'],
    WS,
  ],
};

// diff is handled line-by-line for clarity.
function highlightDiff(code) {
  return code.split('\n').map((line) => {
    let cls = null;
    if (/^\+\+\+|^---/.test(line)) cls = 'tok-meta';
    else if (/^@@/.test(line)) cls = 'tok-meta';
    else if (/^\+/.test(line)) cls = 'tok-added';
    else if (/^-/.test(line)) cls = 'tok-removed';
    else if (/^ /.test(line) === false && /^\\/.test(line)) cls = 'tok-comment';
    const esc = escapeHtml(line);
    return cls ? `<span class="${cls}">${esc}</span>` : esc;
  }).join('\n');
}

function tokenize(code, rules) {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    let matched = false;
    for (const [re, cls] of rules) {
      re.lastIndex = i;
      const m = re.exec(code);
      if (m && m.index === i && m[0].length > 0) {
        const t = m[0];
        out += cls ? `<span class="${cls}">${escapeHtml(t)}</span>` : escapeHtml(t);
        i += t.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += escapeHtml(code[i]);
      i += 1;
    }
  }
  return out;
}

/**
 * Highlight `code` for `lang`, returning HTML with token <span>s.
 * Text content of the result equals the original code, so a Copy button can
 * read it back via textContent. Never throws.
 */
export function highlight(code, lang) {
  const language = (lang || 'text').toLowerCase();
  try {
    if (language === 'diff') return highlightDiff(code);
    const rules = RULES[language];
    if (!rules) return escapeHtml(code); // text, powershell, and anything unknown
    return tokenize(code, rules);
  } catch {
    return escapeHtml(code);
  }
}

export const HIGHLIGHT_LANGS = Object.keys(RULES).concat(['diff', 'text']);
