#!/usr/bin/env node
// Secret scan for a repo that is (or will be) public. Never prints a secret value: only rule name, file and line.
//   node scripts/secret-scan.mjs --staged   lines about to be committed (used by .githooks/pre-commit)
//   node scripts/secret-scan.mjs            every tracked file in the working tree
//   node scripts/secret-scan.mjs --history  every line ever added on any branch (slow; run once before going public)
// Two checks: (1) well-known credential shapes, (2) the REAL secret values held in this machine's ignored files
// (.env, video/.env, data/*.token, data/*.secret, data/*keys*.json) must not appear anywhere in what is scanned.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Public, well-known test keys (Anvil/Hardhat dev accounts) are not secrets.
const PUBLIC_HEX = new Set(['0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6']);
const PLACEHOLDER = /^(not-a-key.*|x+|\*+|<.*>|your[-_ ].*|change[-_ ]?me|example.*|dev-.*|test.*|placeholder.*|abcd-efgh-ijkl-mnop|\$\{.*\}|\$\(.*\))$/i;

export const RULES = [
  ['google-api-key', /AIza[0-9A-Za-z_-]{30,}/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ['openai-style-key', /\bsk-[A-Za-z0-9_-]{30,}/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private-key-block', /-----BEGIN [A-Z ]*PRIVATE KEY/],
  ['near-secret-key', /ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/],
  ['app-password-shape', /\b[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}\b/],
  ['vercel-token', /\bvcp_[A-Za-z0-9]{20,}/],
];
const ASSIGN = /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|APP_PASSWORD))\s*[=:]\s*['"]?([^\s'"#(]{20,})/;
const HEXKEY = /0x[0-9a-fA-F]{64}\b/g;

/** Returns [{rule}] for one line of text. Pure; used by the tests. */
export function scanLine(line) {
  const out = [];
  for (const [rule, re] of RULES) {
    const m = re.exec(line);
    if (m && !(rule === 'app-password-shape' && PLACEHOLDER.test(m[0]))) out.push({ rule });
  }
  const a = ASSIGN.exec(line);
  if (a && line[a.index + a[0].length] !== '(' && !PLACEHOLDER.test(a[2]) && !/^(process\.env|env\(|config\.|req\.|headers?\.)/.test(a[2])) out.push({ rule: `assigned-${a[1].toLowerCase()}` });
  if (/priv|secret|seed|mnemonic/i.test(line) && !/\bconstant\b/.test(line)) for (const h of line.match(HEXKEY) ?? []) if (!PUBLIC_HEX.has(h.toLowerCase())) { out.push({ rule: 'hex-private-key' }); break; }
  return out;
}

/** Real values held locally in ignored files. Label only is ever printed. */
export function localSecrets(root = '.') {
  const vals = new Map();
  const add = (label, v) => { v = String(v ?? '').trim(); if (v.length >= 16 && v.length <= 400 && !/^(true|false|https?:\/\/)/.test(v) && !v.includes('\n')) vals.set(v, label); };
  const envFile = (f) => { if (!existsSync(f)) return; for (const l of readFileSync(f, 'utf8').split('\n')) { const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(l); if (m && /TOKEN|SECRET|PASSWORD|KEY|URL/.test(m[1])) add(`${f}:${m[1]}`, m[2].replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '')); } };
  const walk = (o, f, p = '') => { if (typeof o === 'string') add(`${f}${p}`, o); else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, f, `${p}.${k}`); };
  envFile(`${root}/.env`); envFile(`${root}/video/.env`);
  if (existsSync(`${root}/data`)) for (const n of readdirSync(`${root}/data`)) {
    const f = `${root}/data/${n}`; if (!statSync(f).isFile()) continue;
    if (/\.(token|secret)$/.test(n)) { for (const l of readFileSync(f, 'utf8').split('\n')) { const m = /^[A-Z0-9_]+=(.*)$/.exec(l.trim()); add(f, m ? m[1].replace(/^"|"$/g, '') : l); } }
    else if (/keys.*\.json$/.test(n)) { try { walk(JSON.parse(readFileSync(f, 'utf8')), f); } catch { /* not json */ } }
  }
  // Values that are configuration, not secrets, would only create noise.
  for (const v of [...vals.keys()]) if (/^(gemini|gpt|claude|libsql:)/i.test(v) && !/TOKEN|KEY|SECRET/.test(vals.get(v))) vals.delete(v);
  return vals;
}

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 29 });
const SKIP_FILE = /(^|\/)(package-lock\.json|Cargo\.lock|foundry\.lock)$|\.(wasm|png|jpe?g|gif|webp|mp3|wav|mp4|woff2?)$|^contracts\/evm\/lib\//;

/** Yields { file, line, text } for added/present lines depending on mode. */
function* lines(mode) {
  if (mode === 'staged' || mode === 'history') {
    const args = mode === 'staged' ? ['diff', '--cached', '-U0', '--no-color', '--no-ext-diff'] : ['log', '--all', '-p', '-U0', '--no-color', '--no-ext-diff'];
    let file = ''; let n = 0; let commit = '';
    for (const raw of git(...args).split('\n')) {
      if (raw.startsWith('commit ')) commit = raw.slice(7, 15);
      else if (raw.startsWith('+++ ')) { file = raw.slice(6); n = 0; }
      else if (raw.startsWith('@@')) n = Number(/\+(\d+)/.exec(raw)?.[1] ?? 0) - 1;
      else if (raw.startsWith('+') && !raw.startsWith('+++')) { n++; if (!SKIP_FILE.test(file)) yield { file: commit ? `${file}@${commit}` : file, line: n, text: raw.slice(1) }; }
    }
  } else {
    for (const file of git('ls-files').split('\n').filter(Boolean)) {
      if (SKIP_FILE.test(file) || !existsSync(file)) continue;
      let txt; try { txt = readFileSync(file, 'utf8'); } catch { continue; }
      if (txt.includes('\0')) continue;
      let n = 0; for (const text of txt.split('\n')) yield { file, line: ++n, text };
    }
  }
}

export function scan(mode) {
  const secrets = localSecrets(); const findings = [];
  for (const { file, line, text } of lines(mode)) {
    if (text.length > 20000 && !/\.(js|mjs)$/.test(file)) continue; // minified blobs: values are still checked below
    for (const f of scanLine(text)) if (!(file.startsWith('web/dist/') && f.rule === 'hex-private-key')) findings.push({ file, line, rule: f.rule }); // minified bundles hold curve constants
    for (const [v, label] of secrets) if (text.includes(v)) findings.push({ file, line, rule: `local-secret-value (${label})` });
  }
  return { findings, secretsChecked: secrets.size };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv.includes('--staged') ? 'staged' : process.argv.includes('--history') ? 'history' : 'tree';
  const { findings, secretsChecked } = scan(mode);
  if (findings.length) {
    console.error(`secret-scan (${mode}): ${findings.length} possible secret(s). Values are not printed.`);
    for (const f of findings.slice(0, 50)) console.error(`  ${f.rule}  ${f.file}:${f.line}`);
    console.error('Remove it, or if it is a public test value add it to PUBLIC_HEX / the placeholder list in scripts/secret-scan.mjs. A secret that reached a pushed commit must be rotated.');
    process.exit(1);
  }
  console.log(`secret-scan (${mode}): clean (${secretsChecked} local secret values also checked)`);
}
