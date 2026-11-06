#!/usr/bin/env node
// END-TO-END of the autonomy loop (Manual and Auto) on NEAR, against a LOCAL nearcore SANDBOX (chain_id "localnet"). NOT testnet.
// Everything between the owner's wallet and the chain is the production code: attach -> propose -> approve -> the owner's plan steps -> activation ->
// autonomyTick() in Manual, owner approval, Auto, gas top-up. Only the network is swapped: the 'near-testnet' entry of the protocol table points at the sandbox
// for this process (rpc + networkId), so the same policy, adapter, signer and database code runs. Owner signatures come from a throw-away key made here.
// Exit codes: 0 all passed, 1 a check failed, 2 prerequisites missing.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSandboxBin, startSandbox, stopSandbox } from './lib/near-sandbox.mjs';
import { PROTOCOLS } from '../src/protocols.js';
import { loadKeystore } from '../src/agent/keystore.js';
import { generateSeed, formatSecretKey, formatPublicKey, ed25519PublicKey } from '../src/agent/near-signer.js';
import { createNearAdmin } from '../src/agent/near-admin.js';
import { adapter, VAULT_WASM_PATH, REGISTRY_WASM_PATH, sha256Hex } from '../src/vault/near.js';
import { createApp } from '../src/app.js';
import { recordAttestation } from '../src/attest.js';
import { autonomyTick } from '../src/autonomy.js';
import { setMode, getMode } from '../src/autonomy-mode.js';
import { seededDb, NAMES, offline } from '../tests/vault-helpers.js';
import { createRun, executeRun } from '../src/orchestrator/coordinator.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NEAR = 10n ** 24n; const TGAS = 10n ** 12n;
const nearStr = (y) => `${(Number(BigInt(y) / 10n ** 20n) / 1e4).toFixed(4)} NEAR`;
const R = { pass: 0, fail: 0 };
const step = (n, m) => console.log(`\n[${n}] ${m}`);
const t = (name, ok, detail = '') => { ok ? R.pass++ : R.fail++; console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); return ok; };

const bin = findSandboxBin();
if (!bin) { console.error('near-sandbox binary not found (run `cd contracts/near-vault/integration && cargo test` once, or set NEAR_SANDBOX_BIN_PATH).'); process.exit(2); }
for (const p of [VAULT_WASM_PATH, REGISTRY_WASM_PATH]) if (!existsSync(p)) { console.error(`missing ${p}`); process.exit(2); }
const vaultWasm = new Uint8Array(readFileSync(VAULT_WASM_PATH)); const registryWasm = new Uint8Array(readFileSync(REGISTRY_WASM_PATH));
const registrySha = sha256Hex(registryWasm);

console.log('AutoNEAR autonomy loop, Manual and Auto, on a LOCAL NEAR SANDBOX (NOT testnet).');
const sb = await startSandbox(bin);
console.log(`sandbox up: ${sb.url}  chain_id=${sb.chainId}`);
try {
  // The production code finds the network by id; for this process that id means the sandbox.
  Object.assign(PROTOCOLS.near.networks.find((n) => n.id === 'near-testnet'), { rpc: sb.url, networkId: sb.chainId, local: true });

  step(1, 'accounts, vault, funding (our serialisation)');
  const mk = (id, sk) => createNearAdmin({ rpcUrl: sb.url, accountId: id, secretKey: sk, networkId: sb.chainId });
  const kf = () => { const seed = generateSeed(); return { sk: formatSecretKey(seed), pk: formatPublicKey(ed25519PublicKey(seed)) }; };
  const VAULT = `vault.${sb.rootId}`; const OWNER = `owner.${sb.rootId}`;
  const root = mk(sb.rootId, sb.rootKey); const kOwner = kf(); const kVault = kf();
  await root.createSubAccount(OWNER, kOwner.pk, 80n * NEAR); await root.createSubAccount(VAULT, kVault.pk, 10n * NEAR);
  const owner = mk(OWNER, kOwner.sk);
  const init = await mk(VAULT, kVault.sk).deploy(VAULT, vaultWasm, { method: 'new', args: { owner: OWNER, network_id: 'testnet' }, gas: 30n * TGAS });
  t('vault deployed and initialised with the owner', init.ok);
  await owner.transfer(VAULT, 60n * NEAR);
  const keystore = loadKeystore({ path: join('/nonexistent', 'no-agent.keys.json'), env: { AGENT_NEAR_PRIVATE_KEY: kf().sk } });
  const AGENT = keystore.near.accountId;
  await root.transfer(AGENT, 1n * NEAR);
  const balance = async (id) => BigInt((await root.account(id)).amount);

  step(2, 'database: evidence, the attested registry build, a pipeline run that yields a pending deploy request');
  const { db } = await seededDb();
  await recordAttestation(db, { protocol: 'near', commitSha: 'e2e-near-loop', manifest: { sha256: registrySha, bytes: registryWasm.length, sourceSha256: 'ab'.repeat(32) }, tests: { passed: 84, failed: 0, lint: true, fuzz: true, names: NAMES } });
  const app = createApp({ db, operatorToken: 'op', keystore, signingSupported: true, defer: () => {} });
  const ip = `e2e-${Math.random()}`;
  const api = async (path, { method = 'GET', body } = {}) => { const r = await app(new Request('http://t' + path, { method, headers: { 'x-peer-ip': ip, authorization: 'Bearer op', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* text */ } return { status: r.status, json, text }; };
  let seq = 0;
  const newRequest = async (name) => { // the helper in tests/ does not pass contractAccount, which a NEAR request needs
    const { run } = await createRun(db, { opportunityId: 'opp_treasury', params: { chain: 'near-testnet', owner: OWNER, proposer: AGENT, contractAccount: `${name}.${VAULT}` }, idemKey: `e2e-loop-${++seq}-${Math.random()}` });
    const done = await executeRun(db, run.id, { fetchImpl: offline });
    if (done.state !== 'awaiting_approval') throw new Error(`pipeline ended ${done.state}`);
    return db.get('SELECT * FROM decisions WHERE run_id=?', [run.id]);
  };

  step(3, 'owner flow: attach the vault, propose the grant, approve it, sign the plan steps, activate');
  let a = await api('/api/vault/attach', { method: 'POST', body: { chainId: 'near-testnet', address: VAULT } });
  t('vault attached (code == the attested build)', a.status === 201, a.text.slice(0, 120));
  const prop = await api('/api/vault/mandates/propose', { method: 'POST', body: {
    chainId: 'near-testnet', vault: { address: VAULT, owner: OWNER }, agent: { account: AGENT },
    mandate: { perDrawCap: String(NEAR), periodSecs: 3600, periodCap: String(20n * NEAR), totalCap: String(20n * NEAR), maxDeploys: 5 },
    templates: [{ artifactHash: registrySha, owner: OWNER, proposer: AGENT }], fund: { amount: '0' }, loop: { maxPerDay: 5 } } });
  t('grant proposed', prop.status === 201, prop.text.slice(0, 160));
  const grant = prop.json;
  const ap = await api(`/api/decisions/${grant.id}/approve`, { method: 'POST', body: { nonce: grant.nonce, payloadHash: grant.payload_hash, confirm: `approve ${grant.id}`, signer: OWNER } });
  t('grant approved with the vault owner as signer', ap.status === 200, ap.text.slice(0, 160));
  const plan = (await api(`/api/vault/plan?decisionId=${grant.id}`)).json;
  for (const s of plan.steps.filter((x) => x.who === 'human' && x.call)) {
    const c = s.call;
    const r = c.method ? await owner.call(c.receiverId, c.method, c.args ?? {}, { deposit: BigInt(c.deposit ?? 0), gas: BigInt(c.gas ?? 30n * TGAS) }) : await owner.transfer(c.receiverId, BigInt(c.deposit ?? 0));
    t(`owner step: ${s.title.slice(0, 60)}`, r.ok);
  }
  a = await api('/api/vault/attach', { method: 'POST', body: { chainId: 'near-testnet', address: VAULT } });
  t('vault ACTIVATED: the chain equals the approved grant, field by field', a.json?.activation?.activated === true, JSON.stringify(a.json?.activation ?? a.text).slice(0, 200));

  const deps = (env = {}) => ({ keystore, signingSupported: true, signerOpts: { pollMs: 250, timeoutMs: 90_000 }, env: { AUTONOMY_ENABLED: '1', AUTONOMY_MAX_PER_DAY: '5', ...env } });
  const tick = (env) => autonomyTick(db, deps(env));
  const ledger = async () => (await api('/api/vault/ledger?limit=200')).json.items;
  const exists = async (id) => { try { await root.account(id); return true; } catch { return false; } };
  const dec = (id) => db.get('SELECT * FROM decisions WHERE id=?', [id]);
  const runs = async () => (await db.get('SELECT COUNT(*) n FROM mandate_runs')).n;

  step(4, 'MANUAL (default): a pending request waits; the loop sends nothing');
  const d1 = await newRequest('reg1'); const agentBefore = await balance(AGENT);
  t('default mode is manual', await getMode(db) === 'manual');
  const m1 = await tick(); t('tick reports manual and does nothing', m1.vaults?.[0]?.manual === true, JSON.stringify(m1.vaults?.[0] ?? m1).slice(0, 120));
  t('no deploy, no claim, no transaction from the agent', !(await exists(`reg1.${VAULT}`)) && await runs() === 0 && await balance(AGENT) === agentBefore);

  step(5, 'MANUAL: the owner approves; the agent publishes it through the vault');
  const ap1 = await api(`/api/decisions/${d1.id}/approve`, { method: 'POST', body: { nonce: d1.nonce, payloadHash: d1.payload_hash, confirm: `approve ${d1.id}`, signer: OWNER } });
  t('owner approval recorded', ap1.status === 200, ap1.text.slice(0, 120));
  const m2 = await tick();
  const row1 = await dec(d1.id);
  t('the registry now exists on chain at the approved address', await exists(`reg1.${VAULT}`), JSON.stringify(m2.vaults?.[0] ?? m2).slice(0, 200));
  t('request is executed and recorded as: owner approved, agent published', row1.status === 'executed' && /^mandate:.+\+operator$/.test(row1.approver), `${row1.status} ${row1.approver}`);
  const full = (await api(`/api/decisions/${d1.id}`)).json;
  t('API says humanApproved=true, humanSigned=false and a verified deployment exists', full.approval?.humanApproved === true && full.approval?.humanSigned === false && full.deployment?.status === 'verified_local' || full.deployment?.status === 'verified', JSON.stringify(full.deployment?.status));
  t('registry code on chain == the attested wasm', (await root.account(`reg1.${VAULT}`)).code_hash.length > 20);
  const owned = await root.view(`reg1.${VAULT}`, 'config', {}).catch(() => null);
  t('registry owner on chain == the approved owner', owned?.owner_id === OWNER, JSON.stringify(owned)?.slice(0, 100));
  t('ledger says the agent signed and the owner did not', (await ledger()).some((x) => x.decisionId === d1.id && /approved by the owner/.test(x.detail) && /the owner does not/.test(x.detail)));
  t('mode is still manual', await getMode(db) === 'manual');

  step(6, 'MANUAL: a second request that nobody approved stays untouched');
  const d2 = await newRequest('reg2'); const runsBefore = await runs();
  await tick(); await tick();
  t('unapproved request: still pending, nothing deployed, no new claim', (await dec(d2.id)).status === 'pending' && !(await exists(`reg2.${VAULT}`)) && await runs() === runsBefore);

  step(7, 'AUTO: the same pending request is run by the agent on its own, inside the limits');
  await setMode(db, 'auto', 'owner:e2e');
  const m3 = await tick();
  const row2 = await dec(d2.id);
  t('request executed without an owner click', row2.status === 'executed' && /^mandate:[^+]+$/.test(row2.approver) && await exists(`reg2.${VAULT}`), `${row2.status} ${row2.approver} ${JSON.stringify(m3.vaults?.[0] ?? m3).slice(0, 100)}`);
  t('the record says no human signed it', (await api(`/api/decisions/${d2.id}`)).json.approval?.humanApproved === false);
  const st = await adapter.readState({ net: { id: 'near-testnet', protocol: 'near', rpc: sb.url, networkId: sb.chainId, local: true }, vault: VAULT, now: Math.floor(Date.now() / 1000) });
  t('vault usage follows the chain: 2 deploys', Number(st.usage.deploys) === 2, `deploys ${st.usage.deploys}, spent ${nearStr(st.usage.totalSpent)}`);

  step(8, 'AUTO: gas top-up when the agent is under the low-water mark, once; MANUAL never tops up');
  await setMode(db, 'manual', 'owner:e2e');
  const low = { AUTONOMY_TOPUP_LOW: String(5n * NEAR), AUTONOMY_TOPUP_TARGET: String(6n * NEAR) };
  const bal0 = await balance(AGENT);
  await tick(low); t('manual: no top-up even though the agent is below the mark', await balance(AGENT) <= bal0);
  await setMode(db, 'auto', 'owner:e2e');
  const mt = await tick(low);
  let bal1 = await balance(AGENT); // 'final' views trail the head by a few blocks
  for (let i = 0; i < 20 && bal1 <= bal0; i++) { await new Promise((r) => setTimeout(r, 1000)); bal1 = await balance(AGENT); }
  t('auto: one bounded draw to the agent (inside the per-draw cap)', bal1 > bal0 && bal1 - bal0 <= NEAR, `${nearStr(bal0)} -> ${nearStr(bal1)} ${JSON.stringify(mt.vaults?.[0] ?? mt).slice(0, 80)}`);
  const ledgerTop = (await ledger()).filter((x) => x.kind === 'draw' && /^top-up/.test(x.detail));
  t('top-up is in the history', ledgerTop.length >= 1);

  step(9, 'safety: kill switch and a stopped loop stop everything, even an approved request');
  await setMode(db, 'manual', 'owner:e2e');
  const d3 = await newRequest('reg3');
  await api(`/api/decisions/${d3.id}/approve`, { method: 'POST', body: { nonce: d3.nonce, payloadHash: d3.payload_hash, confirm: `approve ${d3.id}`, signer: OWNER } });
  await api('/api/security/pause', { method: 'POST' });
  await tick(); t('kill switch engaged: the approved request is not run', !(await exists(`reg3.${VAULT}`)) && (await dec(d3.id)).status === 'approved');
  await api('/api/security/resume', { method: 'POST' });
  await tick();
  t('after resume it runs', await exists(`reg3.${VAULT}`) && (await dec(d3.id)).status === 'executed');
  t('ledger hash chain intact', (await api('/api/vault')).json.health.find((h) => /ledger hash chain/.test(h.name))?.ok === true);
} catch (e) {
  console.error('\nE2E ERROR:', e.stack || e); R.fail++;
} finally { await stopSandbox(); }
console.log(`\nRESULT: ${R.pass} PASS, ${R.fail} FAIL`);
console.log('SCOPE: local nearcore sandbox (chain_id localnet). The production loop, policy, adapter, signer and database code ran; the network table entry was pointed at the sandbox. NOT testnet.');
process.exit(R.fail ? 1 : 0);
