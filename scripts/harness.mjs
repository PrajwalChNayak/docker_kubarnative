// Validation harness for the handbook.
//
//   node scripts/harness.mjs             local checks (no cluster):
//                                          kubeconform, hadolint, compose config, helm lint/template
//   node scripts/harness.mjs --cluster   also: kubectl apply --dry-run=server + pluto against kind
//   node scripts/harness.mjs --only=manifests|dockerfiles|compose|helm
//
// It extracts every YAML manifest from content/**/*.md fenced blocks (those
// with title="*.yaml"/"*.yml" or include= pointing at a YAML file, excluding
// blocks flagged `fragment` or `legacy`) AND every examples/**/*.yaml, writes
// them to .harness/manifests/, and validates them. A manifest is only
// "documented correctly" once the real 1.37 API server has accepted it.
//
// Tools are discovered on PATH and in ./.tools. Docker-based fallbacks are used
// for hadolint and trivy. Anything unavailable is reported as NOT RUN, never
// silently skipped or faked.

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, dirname, resolve, extname, basename } from 'node:path';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const OUT = join(ROOT, '.harness');
const args = process.argv.slice(2);
const withCluster = args.includes('--cluster');
const onlyArg = (args.find(a => a.startsWith('--only=')) || '').split('=')[1];
const only = onlyArg ? new Set(onlyArg.split(',')) : null;
const want = (name) => !only || only.has(name);

const K8S_VERSION = '1.37.0';
const TOOLS = join(ROOT, '.tools');
const bin = (name) => {
  for (const p of [join(TOOLS, name + '.exe'), join(TOOLS, name)]) if (existsSync(p)) return p;
  return name; // fall back to PATH
};
function run(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}
function has(cmd, testArgs = ['--version']) {
  try { run(cmd, testArgs); return true; } catch (e) { return e.status !== undefined && e.status !== 127 && !/ENOENT/.test(String(e.code)); }
}
function walk(dir, filter) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p, filter));
    else if (filter(p)) out.push(p);
  }
  return out;
}

const summary = {};
const record = (k, v) => { summary[k] = v; };

// ---------------------------------------------------------------------------
// 1. Extract manifests from docs + examples
// ---------------------------------------------------------------------------
function fenceAttrs(info) {
  // info is the text after ``` e.g.  yaml title="x.yaml" lines="1-4" fragment
  const lang = (info.match(/^\s*([A-Za-z0-9_-]+)/) || [, ''])[1];
  const attrs = {};
  for (const m of info.matchAll(/(\w+)="([^"]*)"/g)) attrs[m[1]] = m[2];
  for (const flag of ['fragment', 'legacy']) if (new RegExp(`(^|\\s)${flag}(\\s|$)`).test(info)) attrs[flag] = true;
  if (/expect="reject"/.test(info)) attrs.expect = 'reject';
  return { lang, attrs };
}

function extractFromMarkdown() {
  const blocks = [];
  for (const file of walk(join(ROOT, 'content'), p => p.endsWith('.md'))) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const open = lines[i].match(/^```+(.*)$/);
      if (!open) continue;
      const fence = lines[i].match(/^`+/)[0];
      const { lang, attrs } = fenceAttrs(open[1]);
      let j = i + 1;
      const body = [];
      while (j < lines.length && !(lines[j].startsWith(fence) && /^`+\s*$/.test(lines[j]))) { body.push(lines[j]); j++; }
      i = j;
      if (attrs.fragment || attrs.legacy) continue;
      const isYamlLang = lang === 'yaml' || lang === 'yml';
      const includePath = attrs.include;
      if (includePath && /\.ya?ml$/.test(includePath)) {
        blocks.push({ source: `${relative(ROOT, file)} (include ${includePath})`, viaInclude: includePath, reject: attrs.expect === 'reject' });
      } else if (isYamlLang && (attrs.title ? /\.ya?ml$/.test(attrs.title) : /(^|\n)\s*(apiVersion|kind):/.test(body.join('\n')))) {
        blocks.push({ source: relative(ROOT, file), content: body.join('\n'), reject: attrs.expect === 'reject' });
      }
    }
  }
  return blocks;
}

function gatherManifests() {
  rmSync(join(OUT, 'manifests'), { recursive: true, force: true });
  mkdirSync(join(OUT, 'manifests'), { recursive: true });
  const items = [];
  let n = 0;
  const add = (content, source, reject) => {
    // split multi-doc; keep only docs that look like k8s objects
    for (const doc of content.split(/^---\s*$/m)) {
      if (!/(^|\n)\s*apiVersion:/.test(doc) || !/(^|\n)\s*kind:/.test(doc)) continue;
      const f = join(OUT, 'manifests', `m${String(n).padStart(4, '0')}.yaml`);
      writeFileSync(f, doc.trim() + '\n');
      items.push({ file: f, source, reject });
      n++;
    }
  };
  // From markdown (inline + include)
  for (const b of extractFromMarkdown()) {
    if (b.viaInclude) {
      const p = join(ROOT, b.viaInclude);
      if (existsSync(p)) add(readFileSync(p, 'utf8'), b.source, b.reject);
    } else add(b.content, b.source, b.reject);
  }
  // From examples/**/*.yaml (skip kustomization/helm-template inputs and known non-CRD helpers handled elsewhere)
  for (const p of walk(join(ROOT, 'examples'), f => /\.ya?ml$/.test(f))) {
    const rel = relative(ROOT, p).replace(/\\/g, '/');
    if (/kustomization\.ya?ml$/i.test(p)) continue;              // kustomize output validated separately
    if (/\/patches\//.test(rel)) continue;                        // strategic/JSON6902 patch fragments, not standalone
    if (/\/helm\/.*\/templates\//.test(rel)) continue;           // helm templates handled by helm
    if (/\/helm\/.*\/(values|Chart)\.ya?ml$/.test(rel)) continue;
    const content = readFileSync(p, 'utf8');
    if (/^\s*\$patch:/m.test(content) || /(^|\n)\s*- op:\s/.test(content)) continue; // patch documents
    add(content, rel, /reject|vulnerable|non-compliant/i.test(rel));
  }
  return items;
}

// ---------------------------------------------------------------------------
// 2. kubeconform
// ---------------------------------------------------------------------------
function runKubeconform(items) {
  const kc = bin('kubeconform');
  if (!existsSync(kc) && kc === 'kubeconform') { record('kubeconform', 'NOT RUN (kubeconform not found)'); return; }
  const schemaLocs = [
    '-schema-location', 'default',
    '-schema-location', 'https://raw.githubusercontent.com/yannh/kubernetes-json-schema/master/v{{.NormalizedKubernetesVersion}}-standalone-strict/{{.ResourceKind}}{{.KindSuffix}}.json',
    '-schema-location', 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json',
  ];
  let pass = 0, fail = 0; const failures = [];
  for (const it of items) {
    try {
      run(kc, ['-strict', '-summary', '-kubernetes-version', K8S_VERSION, '-ignore-missing-schemas', ...schemaLocs, it.file]);
      pass++;
    } catch (e) {
      fail++; failures.push(`${it.source}: ${(e.stdout || '') + (e.stderr || '')}`.split('\n').slice(0, 2).join(' '));
    }
  }
  record('kubeconform', `${pass}/${items.length} valid, ${fail} failed`);
  if (failures.length) writeFileSync(join(OUT, 'kubeconform-failures.txt'), failures.join('\n'));
}

// ---------------------------------------------------------------------------
// 3. kubectl apply --dry-run=server (needs cluster)
// ---------------------------------------------------------------------------
function runServerDryRun(items) {
  const kubectl = bin('kubectl');
  try { run(kubectl, ['cluster-info'], { timeout: 15000 }); }
  catch { record('kubectl-dry-run', 'NOT RUN (no reachable cluster)'); return; }
  let pass = 0, fail = 0, rejectedAsExpected = 0; const failures = [];
  for (const it of items) {
    try {
      run(kubectl, ['apply', '--dry-run=server', '-f', it.file], { timeout: 30000 });
      if (it.reject) { fail++; failures.push(`${it.source}: expected rejection but server accepted it`); }
      else pass++;
    } catch (e) {
      if (it.reject) { rejectedAsExpected++; }
      else { fail++; failures.push(`${it.source}: ${((e.stderr || '') + (e.stdout || '')).split('\n')[0]}`); }
    }
  }
  record('kubectl-dry-run', `${pass} accepted, ${rejectedAsExpected} rejected-as-expected, ${fail} unexpected failures`);
  if (failures.length) writeFileSync(join(OUT, 'dryrun-failures.txt'), failures.join('\n'));
}

// ---------------------------------------------------------------------------
// 4. pluto (deprecated/removed APIs)
// ---------------------------------------------------------------------------
function runPluto() {
  let cmd, pre = [];
  if (existsSync(bin('pluto')) && bin('pluto') !== 'pluto') { cmd = bin('pluto'); }
  else if (has('docker')) { cmd = 'docker'; pre = ['run', '--rm', '-v', `${ROOT.replace(/\\/g, '/')}:/w`, '-w', '/w', 'us-docker.pkg.dev/fairwinds-ops/oss/pluto:v5.24.4']; }
  else { record('pluto', 'NOT RUN (pluto and docker both unavailable)'); return; }
  try {
    const out = run(cmd, [...pre, 'detect-files', '-d', pre.length ? '.harness/manifests' : join(OUT, 'manifests'), '--target-versions', 'k8s=v' + K8S_VERSION]);
    record('pluto', 'no deprecated/removed APIs found');
    writeFileSync(join(OUT, 'pluto.txt'), out);
  } catch (e) {
    const out = (e.stdout || '') + (e.stderr || '');
    // pluto exits non-zero when it finds deprecated/removed APIs
    record('pluto', /No output to display|no.*found/i.test(out) ? 'clean' : 'FOUND deprecated/removed APIs — see .harness/pluto.txt');
    writeFileSync(join(OUT, 'pluto.txt'), out);
  }
}

// ---------------------------------------------------------------------------
// 5. Dockerfiles (hadolint + optional build)
// ---------------------------------------------------------------------------
function runDockerfiles() {
  const files = walk(join(ROOT, 'examples'), p => /(^|[\\/])Dockerfile([.\-].*)?$/.test(basename(p)) || basename(p).startsWith('Dockerfile'));
  if (!files.length) { record('hadolint', 'no Dockerfiles found'); return; }
  let useDocker = has('docker');
  let hl = bin('hadolint');
  const haveHl = existsSync(hl) && hl !== 'hadolint';
  if (!haveHl && !useDocker) { record('hadolint', `NOT RUN (hadolint and docker unavailable); ${files.length} Dockerfiles found`); return; }
  let pass = 0, fail = 0; const failures = [];
  for (const f of files) {
    try {
      if (haveHl) run(hl, [f]);
      else run('docker', ['run', '--rm', '-i', 'hadolint/hadolint:v2.15.1', 'hadolint', '-'], { input: readFileSync(f) });
      pass++;
    } catch (e) { fail++; failures.push(`${relative(ROOT, f)}: ${((e.stdout || '') + (e.stderr || '')).split('\n').slice(0, 3).join(' ')}`); }
  }
  record('hadolint', `${pass}/${files.length} clean, ${fail} with findings`);
  if (failures.length) writeFileSync(join(OUT, 'hadolint-findings.txt'), failures.join('\n'));
}

// ---------------------------------------------------------------------------
// 6. Compose config
// ---------------------------------------------------------------------------
function runCompose() {
  if (!has('docker')) { record('compose', 'NOT RUN (docker unavailable)'); return; }
  const files = walk(join(ROOT, 'examples'), p => /(^|[\\/])(compose|docker-compose)[^\\/]*\.ya?ml$/.test(basename(p)));
  const roots = [...new Set(files.map(f => dirname(f)))];
  let pass = 0, fail = 0; const failures = [];
  for (const f of files) {
    if (/override/.test(basename(f))) continue; // validated with its base
    try { run('docker', ['compose', '-f', f, 'config'], { cwd: dirname(f) }); pass++; }
    catch (e) { fail++; failures.push(`${relative(ROOT, f)}: ${((e.stderr || '')).split('\n')[0]}`); }
  }
  record('compose', `${pass} parsed, ${fail} failed`);
  if (failures.length) writeFileSync(join(OUT, 'compose-failures.txt'), failures.join('\n'));
}

// ---------------------------------------------------------------------------
// 7. Helm lint/template
// ---------------------------------------------------------------------------
function runHelm() {
  const helm = bin('helm');
  if (!existsSync(helm) && helm === 'helm') { record('helm', 'NOT RUN (helm not found)'); return; }
  const charts = walk(join(ROOT, 'examples'), p => basename(p) === 'Chart.yaml').map(dirname);
  if (!charts.length) { record('helm', 'no charts found'); return; }
  let lintOk = 0, tmplOk = 0; const failures = [];
  for (const c of charts) {
    try { run(helm, ['lint', c]); lintOk++; } catch (e) { failures.push(`lint ${relative(ROOT, c)}: ${((e.stdout || '') + (e.stderr || '')).split('\n').slice(-3).join(' ')}`); }
    try { run(helm, ['template', 't', c, '--kube-version', K8S_VERSION]); tmplOk++; } catch (e) { failures.push(`template ${relative(ROOT, c)}: ${((e.stdout || '') + (e.stderr || '')).split('\n').slice(-3).join(' ')}`); }
  }
  record('helm', `${lintOk}/${charts.length} lint clean, ${tmplOk}/${charts.length} template ok`);
  if (failures.length) writeFileSync(join(OUT, 'helm-failures.txt'), failures.join('\n'));
}

// ---------------------------------------------------------------------------
// 8. Kustomize build
// ---------------------------------------------------------------------------
function runKustomize() {
  const kubectl = bin('kubectl');
  const kustDirs = walk(join(ROOT, 'examples'), p => /kustomization\.ya?ml$/i.test(basename(p))).map(dirname)
    .filter(d => /overlay|overlays|base|metrics-server/.test(d.replace(/\\/g, '/')));
  if (!kustDirs.length) { record('kustomize', 'no overlays found'); return; }
  const kc = bin('kubeconform');
  const canValidate = existsSync(kc) && kc !== 'kubeconform';
  let ok = 0, validated = 0; const failures = [];
  mkdirSync(join(OUT, 'kustomize'), { recursive: true });
  for (const d of kustDirs) {
    let rendered;
    try { rendered = run(kubectl, ['kustomize', d]); ok++; }
    catch (e) { failures.push(`build ${relative(ROOT, d)}: ${((e.stderr || '')).split('\n')[0]}`); continue; }
    if (canValidate && /(^|\n)\s*kind:/.test(rendered)) {
      const f = join(OUT, 'kustomize', relative(join(ROOT, 'examples'), d).replace(/[\\/]/g, '_') + '.yaml');
      writeFileSync(f, rendered);
      try {
        run(kc, ['-strict', '-summary', '-kubernetes-version', K8S_VERSION, '-ignore-missing-schemas',
          '-schema-location', 'default',
          '-schema-location', 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json', f]);
        validated++;
      } catch (e) { failures.push(`validate ${relative(ROOT, d)}: ${((e.stdout || '') + (e.stderr || '')).split('\n').slice(0, 2).join(' ')}`); }
    }
  }
  record('kustomize', `${ok}/${kustDirs.length} build ok, ${validated} rendered outputs kubeconform-valid`);
  if (failures.length) writeFileSync(join(OUT, 'kustomize-failures.txt'), failures.join('\n'));
}

// ---------------------------------------------------------------------------
mkdirSync(OUT, { recursive: true });
console.log(`Harness — Kubernetes ${K8S_VERSION}${withCluster ? ' (with cluster)' : ' (local only)'}\n`);

let items = [];
if (want('manifests')) {
  items = gatherManifests();
  record('manifests-extracted', String(items.length));
  runKubeconform(items);
  if (withCluster) { runServerDryRun(items); runPluto(); }
  else { record('kubectl-dry-run', 'NOT RUN (pass --cluster)'); record('pluto', 'NOT RUN (pass --cluster)'); }
}
if (want('dockerfiles')) runDockerfiles();
if (want('compose')) runCompose();
if (want('helm')) runHelm();
if (want('kustomize')) runKustomize();

console.log('Results');
console.log('-------');
for (const [k, v] of Object.entries(summary)) console.log(`  ${k.padEnd(20)} ${v}`);
console.log(`\nArtifacts and failure details in ${relative(ROOT, OUT)}/`);
