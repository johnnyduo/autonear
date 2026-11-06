import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BANNED, T, ROUTES, describeDecision, historyLine, homeLine } from './copy.js';

test('no banned jargon in any user-facing string', () => {
  const strings = [];
  const walk = (v) => { if (typeof v === 'string') strings.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(T); walk(ROUTES);
  for (const d of [{ action: 'deploy_testnet', chain_id: 'evm:84532' }, { action: 'grant_mandate', chain_id: 'evm:84532' }, { action: 'x' }]) walk(describeDecision(d));
  for (const e of [{ kind: 'draw', detail: 'top-up' }, { kind: 'deploy', status: 'confirmed' }, { kind: 'activate' }, { kind: 'anomaly' }, { kind: 'refused', detail: 'left for a human' }, { kind: 'loop', detail: 'resumed' }]) strings.push(historyLine(e));
  for (const a of [{ paused: true }, { pending: 2 }, { demo: true }, { sourcesOk: 9, sourcesTotal: 9 }, { vaultLive: true }, { vaultLive: true, signing: true, mode: 'auto' }, { vaultLive: true, signing: true, mode: 'manual' }]) walk(homeLine({ sourcesOk: 9, sourcesTotal: 9, ...a }));
  for (const s of strings) for (const b of BANNED) assert.ok(!new RegExp(`\\b${b}`, 'i').test(s), `"${s}" contains "${b}"`);
});
test('every route has a title', () => {
  for (const k of ['home', 'approvals', 'watch', 'vault']) assert.ok(ROUTES[k]);
});
test('copy.js is the only module that defines the jargon map', () => {
  assert.match(readFileSync(new URL('./copy.js', import.meta.url), 'utf8'), /mandate -> limits/);
});
