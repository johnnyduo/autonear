// Pre-render gate: node scripts/verify.mjs   (exit 1 on any failure)
// 1. every number spoken/shown comes from captured data  2. no unbacked claim words  3. length budget  4. provenance tags  5. data freshness
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spoken } from '../src/lib/narration.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => JSON.parse(readFileSync(resolve(root, p), 'utf8'));
const script = rd('script/script.json'), data = rd('src/data/captured.json'), meta = rd('script/meta.json');
const timing = existsSync(resolve(root, 'src/data/timing.json')) ? rd('src/data/timing.json') : null;
const fails = [], warns = [];
const must = (c, m) => { if (!c) fails.push(m); };

// 1. tokens resolve (spoken() throws on a missing path) and no bare digits hide in narration
for (const s of script.scenes) {
  let t; try { t = spoken(s.narration, data); } catch (e) { fails.push(`${s.id}: ${e.message}`); continue; }
  const raw = s.narration.replace(/\{\{[^}]+\}\}/g, '');
  must(!/\d/.test(raw), `${s.id}: hard-coded digit in narration; use a {{token}} so it cannot drift from captured data`);
  must(t.length > 0, `${s.id}: empty narration`);
}

// 2. banned / overclaiming words (Codex fact-check found these overstate what the code proves)
const BANNED = [/\baudited\b/i, /\bguarantee/i, /\bunhackable\b/i, /\bproduction[- ]ready\b/i, /\bmainnet\b/i, /\bnever (let|move|holds?)\b/i, /\breal funds\b/i, /\bautonomous(ly)? (deploy|execut)/i, /\bsecure[sd]?\b/i];
for (const s of script.scenes) for (const re of BANNED) must(!re.test(s.narration), `${s.id}: banned claim word ${re}`);

// 3. length budget: X allows 2:20 for most accounts; pitch target <= 105 s total
const words = script.scenes.map((s) => spoken(s.narration, data).split(/\s+/).length).reduce((a, b) => a + b, 0);
must(words <= 245, `narration is ${words} words (budget 245)`);
if (timing) {
  const total = timing.scenes.reduce((a, s) => a + 0.25 + s.durationSec + 0.4, 0) + 2.6;
  must(total <= 125, `video would be ${total.toFixed(1)}s (budget 125s)`);
  if (total > 105) warns.push(`video ${total.toFixed(1)}s is above the 105s pitch target`);
  must(timing.scenes.length === script.scenes.length, 'timing.json is stale: rerun `npm run tts`');
  if (timing.mode !== 'gemini') warns.push(`narration is "${timing.mode}" (placeholder voice), not Gemini. Set GEMINI_API_KEY and run npm run tts`);
}

// 4. honesty: scenes built from fixtures/mocks must say so on screen
const need = { poison: /FIXTURE/, owner: /DEMO DATA/, evidence: /LIVE/, council: /FIXTURE/, approval: /FIXTURE/, refusal: /MOCKED/, testnet: /TESTNET.*DEMO OWNER KEY/ };
for (const [id, re] of Object.entries(need)) must(re.test(script.scenes.find((s) => s.id === id)?.tag ?? ''), `${id}: provenance tag must match ${re}`);

// 5. captured data must be fresh and green; contract numbers must be MEASURED (contracts.json), not typed
const cpath = resolve(root, 'src/data/contracts.json');
if (!existsSync(cpath)) fails.push('src/data/contracts.json missing: run `node scripts/contracts.mjs` (measures cargo + forge)');
else {
  const c = rd('src/data/contracts.json');
  const cAge = (Date.now() - Date.parse(c.ranAt)) / 36e5;
  if (cAge > 12) warns.push(`contract test results are ${cAge.toFixed(1)}h old: rerun node scripts/contracts.mjs before the final render`);
  must(data.suites.nearContract.passed === c.near.passed && data.suites.evmContract.passed === c.evm.passed, 'captured.json contract counts differ from contracts.json: rerun capture');
  must(c.near.failed === 0 && c.evm.failed === 0, 'a contract suite has failures');
}
const ageH = (Date.now() - Date.parse(data.capturedAt)) / 36e5;
if (ageH > 6) warns.push(`captured.json is ${ageH.toFixed(1)}h old: rerun node scripts/capture.mjs (the app is still changing)`);
must(data.suites.node.fail === 0 && data.suites.node.pass > 0, `Node suite not green in capture (${JSON.stringify(data.suites.node)})`);
must(data.attempts.every((a) => a.rejected), 'a gate attempt that must be rejected was allowed');
must(data.verification.badRecorded === false && data.verification.goodRecorded === true, 'verifier outcome changed: wrong hash must be refused, matching hash recorded');
must(data.run.state === 'awaiting_approval' && data.run.auditChainOk, `run state ${data.run.state} / audit chain ${data.run.auditChainOk}`);
if (!meta.repoUrl) warns.push('script/meta.json repoUrl is null: end card says "repo link in this post"');

for (const w of warns) console.warn('! ' + w);
if (fails.length) { for (const f of fails) console.error('✗ ' + f); process.exit(1); }
console.log(`✓ verify passed (${words} spoken words${timing ? `, narration ${timing.scenes.reduce((a, s) => a + s.durationSec, 0).toFixed(1)}s [${timing.mode}]` : ''})`);
