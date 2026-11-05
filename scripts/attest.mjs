#!/usr/bin/env node
// Build attestation: runs the REAL build + test + lint commands for a protocol and records the result.
//   node scripts/attest.mjs near|evm            -> writes to the local DB (config.dbPath)
//   node scripts/attest.mjs evm --post https://host --token $OPERATOR_TOKEN   -> POST /api/artifacts (CI / remote D1)
// Nothing is faked: if a command fails the attestation records failed > 0 or aborts.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [protocol, ...rest] = process.argv.slice(2);
const flag = (n) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
if (!['near', 'evm'].includes(protocol)) { console.error('usage: attest.mjs near|evm [--post URL --token T]'); process.exit(2); }

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6, env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.HOME}/.foundry/bin:${process.env.PATH}` }, ...opts });
const need = (r, what) => { if (r.status !== 0) { console.error(`FAILED: ${what}\n${(r.stdout ?? '').slice(-1500)}\n${(r.stderr ?? '').slice(-1500)}`); process.exit(1); } return r; };
const lastJson = (s) => { const m = s.match(/\{[\s\S]*\}\s*$/); if (!m) throw new Error('build script did not print a JSON manifest'); return JSON.parse(m[0]); };

let commit = 'uncommitted';
try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* repo has no commits yet */ }
try { if (execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim()) commit += '+dirty'; } catch { /* ignore */ }

let manifest; const tests = { passed: 0, failed: 0, names: [], lint: false, fuzz: false };
if (protocol === 'near') {
  manifest = lastJson(need(sh('bash', ['scripts/near-build.sh']), 'near build').stdout);
  const dir = 'contracts/near-registry';
  const run = sh('cargo', ['test', '--locked'], { cwd: resolve(ROOT, dir) });
  const sums = [...(run.stdout + run.stderr).matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)];
  tests.passed = sums.reduce((a, m) => a + Number(m[1]), 0); tests.failed = sums.reduce((a, m) => a + Number(m[2]), 0) + (run.status === 0 ? 0 : 1);
  tests.names = [...run.stdout.matchAll(/^test (\S+) \.\.\. ok$/gm)].map((m) => m[1]);
  tests.lint = sh('cargo', ['fmt', '--check'], { cwd: resolve(ROOT, dir) }).status === 0 && sh('cargo', ['clippy', '--all-targets', '--locked', '--', '-D', 'warnings'], { cwd: resolve(ROOT, dir) }).status === 0;
  tests.fuzz = tests.names.some((n) => /prop|random|fuzz|state_machine/i.test(n));
} else {
  manifest = lastJson(need(sh('node', ['scripts/evm-build.mjs']), 'evm build').stdout);
  const dir = resolve(ROOT, 'contracts/evm');
  const run = sh('forge', ['test', '--json'], { cwd: dir });
  let res = {}; try { res = JSON.parse(run.stdout); } catch { console.error('forge test --json unparsable'); process.exit(1); }
  for (const suite of Object.values(res)) for (const [name, t] of Object.entries(suite.test_results ?? {})) { tests.names.push(name); if (t.status === 'Success') tests.passed++; else tests.failed++; }
  tests.lint = sh('forge', ['fmt', '--check'], { cwd: dir }).status === 0;
  tests.fuzz = tests.names.some((n) => /fuzz|invariant/i.test(n));
  const dist = resolve(dir, 'dist/ProposalRegistry.json');
  if (existsSync(dist)) { const art = JSON.parse(readFileSync(dist, 'utf8')); manifest = { ...manifest, abi: art.abi, bytecode: art.bytecode, deployedBytecode: art.deployedBytecode }; }
  manifest.sha256 = manifest.deployedBytecodeSha256 ?? manifest.sha256;
}
manifest.attestedAt = new Date().toISOString();
const att = { protocol, manifest, tests, commitSha: commit };

if (flag('post')) {
  const res = await fetch(`${flag('post').replace(/\/$/, '')}/api/artifacts`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${flag('token') ?? process.env.OPERATOR_TOKEN}` }, body: JSON.stringify(att) });
  console.log(res.status, await res.text()); process.exit(res.ok ? 0 : 1);
} else {
  const { config } = await import('../src/config.js'); const { openDb } = await import('../src/db.js'); const { recordAttestation } = await import('../src/attest.js');
  const db = await openDb(config.databaseUrl ? { url: config.databaseUrl, authToken: config.databaseAuthToken } : { path: config.dbPath });
  console.log(JSON.stringify({ recorded: await recordAttestation(db, att, 'attest-cli'), tests: { passed: tests.passed, failed: tests.failed, lint: tests.lint, fuzz: tests.fuzz }, sha256: manifest.sha256, bytes: manifest.bytes }, null, 2));
  await db.close();
}
