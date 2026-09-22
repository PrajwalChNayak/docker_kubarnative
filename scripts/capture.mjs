// Capture runner: executes the capture requests in captures/requests/*.txt and
// writes the REAL output to captures/<part>/<id>.txt, which the docs include.
//
//   node scripts/capture.mjs                 run every request
//   node scripts/capture.mjs foundations k8s-beginner   run only these parts
//
// Each request line is:  <part>/<id> | <shell command>
// Commands run through bash from the repo root against whatever lab is up.
// A command that fails (missing operator, no cluster) leaves an honest
// "not captured" marker instead of inventing output. Nothing here fabricates
// output — it only records what really ran.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';

// Find a POSIX shell to run the requests. On Windows, Git Bash may live under
// Program Files or the per-user AppData install; fall back to whatever `where`
// reports, then to plain "bash" on PATH.
function findBash() {
  const cands = [
    process.env.CAPTURE_BASH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'usr', 'bin', 'bash.exe'),
    join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ].filter(Boolean);
  for (const c of cands) if (existsSync(c)) return c;
  try {
    const found = execFileSync('where', ['bash'], { encoding: 'utf8' })
      .split(/\r?\n/).map(s => s.trim()).filter(s => /git/i.test(s) && s.toLowerCase().endsWith('bash.exe'))[0];
    if (found && existsSync(found)) return found;
  } catch {}
  return 'bash';
}
const BASH = findBash();

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const REQ = join(ROOT, 'captures', 'requests');
const onlyParts = process.argv.slice(2);
const PATHPREFIX = join(ROOT, '.tools');

let ok = 0, failed = 0, total = 0;
const failures = [];

for (const file of readdirSync(REQ).filter(f => f.endsWith('.txt'))) {
  const part = file.replace(/\.txt$/, '');
  if (onlyParts.length && !onlyParts.includes(part)) continue;
  for (const raw of readFileSync(join(REQ, file), 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('|')) continue;
    const idx = line.indexOf('|');
    let id = line.slice(0, idx).trim();        // e.g. foundations/lsns, or a bare id
    const cmd = line.slice(idx + 1).trim();
    if (!id || !cmd) continue;
    // Docs reference captures/<part>/<id>. If a request file uses a bare id
    // (no slash), prefix it with the part taken from the request filename so
    // the output lands where the page's include= expects it.
    if (!id.includes('/')) id = `${part}/${id}`;
    total++;
    const outFile = join(ROOT, 'captures', ...id.split('/')) + '.txt';
    mkdirSync(dirname(outFile), { recursive: true });
    try {
      const out = execSync(cmd, {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 90000, env: { ...process.env, PATH: PATHPREFIX + ';' + process.env.PATH },
        shell: BASH,
      });
      // Store the command and its real output, trimmed to a sane size.
      const body = `$ ${cmd}\n${out}`.split('\n').slice(0, 60).join('\n');
      writeFileSync(outFile, body.trimEnd() + '\n');
      ok++;
    } catch (e) {
      const msg = ((e.stderr || '') + (e.stdout || '')).split('\n').slice(0, 3).join(' ').trim();
      failed++;
      failures.push(`${id}: ${msg || e.message}`);
      // Honest marker — never invent the output.
      writeFileSync(outFile, `# not captured in this environment\n# command: ${cmd}\n# reason: ${msg || e.message}\n`);
    }
  }
}

console.log(`captures: ${ok}/${total} produced real output, ${failed} not capturable here`);
if (failures.length) {
  mkdirSync(join(ROOT, '.harness'), { recursive: true });
  writeFileSync(join(ROOT, '.harness', 'capture-failures.txt'), failures.join('\n'));
  console.log('  not-captured details in .harness/capture-failures.txt');
}
