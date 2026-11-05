// Mandate Vault backend service: schema v3, ledger, ABI decoding + template/CREATE2 hashing (cross-checked with viem), verifyMandate, policy
// ceilings, approveUnderMandate, the HTTP API, plan calldata, the ERC-8004 draft endpoint. OFFLINE: no chain, no network (the live-chain proofs
// are in tests/autonomy.test.js against a local anvil).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { SCHEMA_V3, audit, sha256 } from '../src/db.js';
import { grantCeiling, assertDecisionAllowed, PolicyError, GRANT_CEILINGS } from '../src/policy.js';
import { UNITS, parseUnits, formatUnits } from '../src/vault/units.js';
import { adapter as evm, decodeOutputs, predictCreate2, saltForDecision, templateIdOfInitcode, PREVIEW_CODES, encodeVaultCall } from '../src/vault/evm.js';
import {
  normalizeState, modelFromState, budgetSummary, verifyMandate, appendLedger, appendLedgerOnce, verifyLedgerChain, listLedger, vaultId, getVault,
  getLoop, pauseLoop, resumeLoop, blockLoop, agentRegistrationFile, buildPlan, proposeGrant, registerAdapter, unregisterAdapter, adapterFor,
} from '../src/vault/index.js';
import { approveDecision, approveUnderMandate, releaseToHuman, getDecision, recordDeployment } from '../src/decisions.js';
import { createApp } from '../src/app.js';
import { memDb } from './helpers.js';
import { seededDb, pendingDecision, apiClient, offline, REG_ART, REG_OWNER, REG_PROPOSER, ADDR, ETH, MANDATE, OPERATOR } from './vault-helpers.js';

const require = createRequire(new URL('../web/package.json', import.meta.url));
let viem = null;
try { viem = require('viem'); } catch { /* web deps not installed */ }
const needViem = !viem && 'viem not installed (npm --prefix web ci)';
const VAULT_ABI = JSON.parse(readFileSync(new URL('../contracts/evm/dist/AgentVault.abi.json', import.meta.url), 'utf8')).abi;
const VAULT_ADDR = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const AGENT_ADDR = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

async function fakeVault(db, { status = 'active', chainId = 'evm:31337', address = VAULT_ADDR, agent = AGENT_ADDR, decisionId = null } = {}) {
  const id = vaultId(chainId, address);
  await db.run('INSERT INTO vaults(id,chain_id,address,owner,agent,attested_ref,status,mandate_decision_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)', [id, chainId, address, ADDR.owner, agent, 'x', status, decisionId, Date.now()]);
  return getVault(db, id);
}
const grantPayload = (over = {}) => ({
  kind: 'grant_mandate', vault: { chainId: 'evm:31337', address: VAULT_ADDR, owner: ADDR.owner }, agent: { address: AGENT_ADDR },
  mandate: { expiresAt: String(Math.floor(Date.now() / 1000) + 86400), perDrawCap: '1000', periodSecs: '3600', periodCap: '2000', totalCap: '5000', maxDeploys: '2' },
  templates: [{ artifactHash: 'a'.repeat(64), templateId: '0x' + 'b'.repeat(64), label: 'ProposalRegistry', deposit: '0', initMaterial: {} }],
  fund: { amount: '5000' }, loop: { maxPerDay: 3 }, ...over,
});
const grantRow = (payload, over = {}) => ({ action: 'grant_mandate', chain_id: 'evm:31337', expiry: Date.now() + 3600_000, max_spend: payload.mandate.totalCap, payload: JSON.stringify(payload), ...over });

describe('schema v3 + migration', () => {
  test('migrations/0003_vault.sql is exactly the generated SCHEMA_V3 and never alters existing tables', () => {
    const sql = readFileSync(new URL('../migrations/0003_vault.sql', import.meta.url), 'utf8');
    assert.ok(sql.endsWith(SCHEMA_V3), 'regenerate with: node scripts/gen-migration.mjs');
    assert.doesNotMatch(SCHEMA_V3, /ALTER TABLE|DROP /i);
    for (const t of ['vaults', 'vault_ledger', 'mandate_runs']) assert.match(SCHEMA_V3, new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\(`));
  });
  test('mandate_runs: one agent execution per decision (PK) and one deploy in flight per vault (partial unique index)', async () => {
    const db = await memDb();
    const ins = (d, v, st) => db.run('INSERT INTO mandate_runs(decision_id,vault_id,epoch,tx_hash,status,created_at) VALUES(?,?,?,?,?,?)', [d, v, 1, null, st, Date.now()]);
    await ins('dec_1', 'vlt_a', 'claimed');
    await assert.rejects(ins('dec_1', 'vlt_b', 'claimed'), /UNIQUE/, 'same decision twice');
    await assert.rejects(ins('dec_2', 'vlt_a', 'submitted'), /UNIQUE/, 'second in-flight run on one vault');
    await ins('dec_3', 'vlt_b', 'claimed'); // another vault is independent
    await db.run("UPDATE mandate_runs SET status='confirmed' WHERE decision_id='dec_1'");
    await ins('dec_2', 'vlt_a', 'claimed'); // in-flight slot is free again once the run settles
  });
});

describe('vault_ledger: hash-chained', () => {
  test('append / verify / tamper detection / dedupe / redaction hook', async () => {
    const db = await memDb();
    await appendLedger(db, 'vlt_a', { kind: 'draw', status: 'confirmed', decisionId: 'dec_1', txHash: '0x' + '11'.repeat(32), amount: 5n, detail: 'drew' });
    await appendLedger(db, 'vlt_a', { kind: 'refused', status: 'refused', detail: 'secret SECRET123 here' }, { redact: (t) => t.replace('SECRET123', '[REDACTED]') });
    assert.equal((await verifyLedgerChain(db)).ok, true);
    const rows = await db.all('SELECT * FROM vault_ledger ORDER BY id');
    assert.equal(rows[1].prev_hash, rows[0].hash); assert.match(rows[1].detail, /\[REDACTED\]/); assert.doesNotMatch(rows[1].detail, /SECRET123/);
    assert.equal(rows[0].amount, '5');
    const dup = { kind: 'refused', status: 'refused', detail: 'same' };
    assert.ok(await appendLedgerOnce(db, 'vlt_a', 'k', dup)); assert.equal(await appendLedgerOnce(db, 'vlt_a', 'k', dup), null, 'identical refusal is ledgered once');
    assert.ok(await appendLedgerOnce(db, 'vlt_a', 'k', { ...dup, detail: 'different' }));
    await assert.rejects(appendLedger(db, 'v', { kind: 'bogus', status: 'confirmed' }), /bad kind/);
    const l = await listLedger(db, { limit: 10 });
    assert.equal(l.chainOk, true); assert.equal(l.items[0].id > l.items.at(-1).id, true, 'newest first');
    for (const k of ['id', 'time', 'vaultId', 'kind', 'decisionId', 'txHash', 'explorerUrl', 'amount', 'status', 'detail', 'hash', 'prevHash']) assert.ok(k in l.items[0], k);
    await db.run("UPDATE vault_ledger SET detail='forged' WHERE id=1");
    assert.equal((await verifyLedgerChain(db)).ok, false);
    assert.equal((await listLedger(db)).chainOk, false);
  });
  test('prev_hash is UNIQUE: a forked append loses', async () => {
    const db = await memDb();
    await appendLedger(db, 'v', { kind: 'loop', status: 'confirmed', detail: 'a' });
    const head = (await db.get('SELECT * FROM vault_ledger')).prev_hash;
    await assert.rejects(db.run('INSERT INTO vault_ledger(vault_id,time,kind,status,detail,prev_hash,hash) VALUES(?,?,?,?,?,?,?)', ['v', 1, 'loop', 'confirmed', 'fork', head, 'x']), /UNIQUE/);
  });
});

describe('EVM adapter: ABI decoding and local hashing, cross-checked against viem', () => {
  test('decodeOutputs == viem.decodeFunctionResult for config / mandate / usage / templates(string[]) / bytes4', { skip: needViem }, () => {
    const out = (name, value) => viem.encodeFunctionResult({ abi: VAULT_ABI, functionName: name, result: value });
    const dec = (name, hex) => decodeOutputs(VAULT_ABI.find((x) => x.type === 'function' && x.name === name).outputs, hex);
    const cfg = { owner: ADDR.owner, pendingOwner: AGENT_ADDR, paused: true, networkId: 31337n, epoch: 7n };
    assert.deepEqual(dec('config', out('config', cfg)), cfg);
    const m = { agent: AGENT_ADDR, expiresAt: 99n, maxDeploys: 5, start: 11n, periodSecs: 3600n, revoked: false, perDrawCap: 1n, periodCap: 2n, totalCap: 3n };
    const got = dec('mandate', out('mandate', m));
    assert.equal(got.agent, m.agent); assert.equal(got.expiresAt, 99n); assert.equal(got.revoked, false); assert.equal(got.totalCap, 3n); assert.equal(Number(got.maxDeploys), 5);
    const ts = [{ id: '0x' + '01'.repeat(32), label: 'ProposalRegistry v1', deposit: 0n }, { id: '0x' + '02'.repeat(32), label: '', deposit: 0n }, { id: '0x' + '03'.repeat(32), label: 'x'.repeat(64), deposit: 0n }];
    assert.deepEqual(dec('templates', out('templates', ts)), ts);
    assert.deepEqual(dec('templates', out('templates', [])), []);
    assert.equal(dec('previewDraw', out('previewDraw', '0xf203bf60')), '0xf203bf60');
  });
  test('templateId = keccak256(creation ++ abi.encode(ctor args)) == viem; CREATE2 prediction == viem getCreate2Address; salt is per decision', { skip: needViem }, () => {
    const man = { bytecode: REG_ART.bytecode, deployedBytecode: REG_ART.deployedBytecode, abi: REG_ART.abi, sha256: sha256Of(REG_ART.deployedBytecode) };
    const e = evm.expectedTemplate({ manifest: man, payload: { registry: { owner: REG_OWNER, proposer: REG_PROPOSER, maxSpendCap: '5000000' } } });
    const args = viem.encodeAbiParameters(viem.parseAbiParameters('address, address, uint256'), [REG_OWNER, REG_PROPOSER, 5000000n]);
    const initcode = viem.concat([REG_ART.bytecode, args]);
    assert.equal(e.templateId, viem.keccak256(initcode));
    assert.equal('0x' + Buffer.from(e.code).toString('hex'), initcode.toLowerCase());
    assert.equal(e.initMaterial.constructorArgs, args);
    const salt = saltForDecision('dec_abc');
    assert.equal(salt, viem.keccak256(viem.toBytes('autonear:deploy:dec_abc')));
    assert.notEqual(salt, saltForDecision('dec_abd'));
    assert.equal(predictCreate2(VAULT_ADDR, salt, e.templateId), viem.getCreate2Address({ from: VAULT_ADDR, salt, bytecodeHash: e.templateId }));
    assert.equal(templateIdOfInitcode(initcode), e.templateId);
  });
  const sha256Of = (hex) => sha256(Buffer.from(hex.replace(/^0x/, ''), 'hex').toString('binary')) && require('node:crypto').createHash('sha256').update(Buffer.from(hex.replace(/^0x/, ''), 'hex')).digest('hex');
  test('expectedTemplate refuses to guess: wrong constructor ABI, zero/invalid owner, tampered attested hash, bad cap', () => {
    const base = { bytecode: REG_ART.bytecode, deployedBytecode: REG_ART.deployedBytecode, abi: REG_ART.abi, sha256: sha256Of(REG_ART.deployedBytecode) };
    const ok = { registry: { owner: REG_OWNER, proposer: REG_PROPOSER } };
    assert.doesNotThrow(() => evm.expectedTemplate({ manifest: base, payload: ok }));
    assert.throws(() => evm.expectedTemplate({ manifest: { ...base, abi: [{ type: 'constructor', inputs: [{ type: 'address' }] }] }, payload: ok }), /constructor/);
    assert.throws(() => evm.expectedTemplate({ manifest: { ...base, sha256: '00'.repeat(32) }, payload: ok }), /sha256/);
    assert.throws(() => evm.expectedTemplate({ manifest: base, payload: { registry: { owner: '0x' + '00'.repeat(20), proposer: REG_PROPOSER } } }), /non-zero/);
    assert.throws(() => evm.expectedTemplate({ manifest: base, payload: { registry: { owner: 'nope', proposer: REG_PROPOSER } } }), /non-zero/);
    assert.throws(() => evm.expectedTemplate({ manifest: base, payload: { registry: { owner: REG_OWNER, proposer: REG_PROPOSER, maxSpendCap: '-1' } } }), /maxSpendCap/);
    assert.throws(() => evm.expectedTemplate({ manifest: { ...base, bytecode: undefined }, payload: ok }), /bytecode/);
  });
  test('previewCodes cover every spec error and the encode helpers produce the ABI selectors', () => {
    assert.equal(PREVIEW_CODES['0x00000000'], '');
    assert.equal(Object.values(PREVIEW_CODES).filter(Boolean).length, 17);
    assert.equal(Buffer.from(encodeVaultCall('draw', [1n])).subarray(0, 4).toString('hex'), '3b304147');
  });
});

describe('state, model, budget, verifyMandate', () => {
  const raw = (over = {}) => ({
    config: { owner: ADDR.owner, pendingOwner: null, paused: false, networkId: '31337', epoch: 1n },
    mandate: { agent: AGENT_ADDR, expiresAt: 5000n, perDrawCap: 1000n, periodSecs: 3600n, periodCap: 2000n, totalCap: 5000n, maxDeploys: 2n, revoked: false, start: 100n },
    usage: { totalSpent: 300n, periodSpent: 300n, deploys: 1n, periodIndex: 0n }, available: 4000n, agentBalance: 10n, blockTime: 200n,
    templates: [{ id: '0x' + 'B'.repeat(64), label: 'ProposalRegistry', deposit: 0n }], ...over,
  });
  test('normalizeState accepts bigint / number / decimal strings, lower-cases template ids, and REQUIRES mandate.start', () => {
    const s = normalizeState(raw({ available: '4000', blockTime: 200, usage: { totalSpent: '300', periodSpent: 300, deploys: 1n, periodIndex: 0 } }));
    assert.equal(typeof s.available, 'bigint'); assert.equal(s.templates[0].id, '0x' + 'b'.repeat(64));
    const bad = raw(); delete bad.mandate.start;
    assert.throws(() => normalizeState(bad), /mandate\.start/);
    assert.throws(() => normalizeState(raw({ available: 'x1' })), /available/);
    assert.throws(() => normalizeState({}), /config/);
  });
  test('budget summary comes from VaultModel.describeBudget (decimal strings)', () => {
    const b = budgetSummary(normalizeState(raw()), 'evm');
    assert.deepEqual({ ...b, periodResetsAt: undefined }, { maxDraw: '1000', remainingPeriod: '1700', remainingTotal: '4700', remainingDeploys: '1', blocked: '', periodResetsAt: undefined });
    assert.equal(b.periodResetsAt, 100 + 3600);
    assert.equal(budgetSummary(normalizeState(raw({ mandate: null })), 'evm').blocked, 'NoMandate');
    assert.equal(budgetSummary(normalizeState(raw({ config: { ...raw().config, paused: true } })), 'evm').blocked, 'Paused');
    assert.equal(budgetSummary(normalizeState(raw({ blockTime: 5000n })), 'evm').blocked, 'MandateInactive');
  });
  test('the model rebuilt from chain state agrees with the spec on previews', () => {
    const m = modelFromState(normalizeState(raw()), 'evm');
    assert.equal(m.previewDraw(1000n, 200n), '');
    assert.equal(m.previewDraw(1001n, 200n), 'PerDrawCap');
    assert.equal(m.previewDeploy('0x' + 'b'.repeat(64), '0x01', 200n), '');
    assert.equal(m.previewDeploy('0x' + 'c'.repeat(64), '0x01', 200n), 'TemplateNotAllowed');
  });
  const payload = () => grantPayload({ templates: [{ artifactHash: 'a'.repeat(64), templateId: '0x' + 'b'.repeat(64), label: 'ProposalRegistry', deposit: '0' }], mandate: { expiresAt: '5000', perDrawCap: '1000', periodSecs: '3600', periodCap: '2000', totalCap: '5000', maxDeploys: '2' } });
  test('verifyMandate: equal state passes; EVERY approved field is checked individually', () => {
    const st = normalizeState(raw());
    const good = verifyMandate(st, payload());
    assert.equal(good.ok, true, JSON.stringify(good.checks.filter((c) => !c.ok)));
    for (const [k, v] of [['expiresAt', '5001'], ['perDrawCap', '999'], ['periodSecs', '3601'], ['periodCap', '2001'], ['totalCap', '5001'], ['maxDeploys', '3']]) {
      const p = payload(); p.mandate[k] = v;
      const r = verifyMandate(st, p);
      assert.equal(r.ok, false, k); assert.ok(r.checks.some((c) => !c.ok && c.name.includes(k)), `${k} flagged`);
    }
    const wrongAgent = payload(); wrongAgent.agent.address = ADDR.other;
    assert.equal(verifyMandate(st, wrongAgent).ok, false);
    const wrongOwner = payload(); wrongOwner.vault.owner = ADDR.other;
    assert.equal(verifyMandate(st, wrongOwner).ok, false);
    const noTpl = payload(); noTpl.templates[0].templateId = '0x' + 'd'.repeat(64);
    assert.equal(verifyMandate(st, noTpl).ok, false);
    const label = payload(); label.templates[0].label = 'other';
    assert.equal(verifyMandate(st, label).ok, false);
    assert.equal(verifyMandate(normalizeState(raw({ templates: [...raw().templates, { id: '0x' + 'e'.repeat(64), label: 'x', deposit: 0n }] })), payload()).ok, false, 'an unapproved extra template is a mismatch');
    assert.equal(verifyMandate(normalizeState(raw({ mandate: null })), payload()).ok, false);
    const rev = verifyMandate(normalizeState(raw({ mandate: { ...raw().mandate, revoked: true } })), payload());
    assert.equal(rev.fieldsOk, true); assert.equal(rev.live, false); assert.equal(rev.ok, false, 'revoked is not live');
    assert.equal(verifyMandate(normalizeState(raw({ blockTime: 5000n })), payload()).live, false, 'expired is not live');
    assert.equal(verifyMandate(st, { ...payload(), agent: { address: AGENT_ADDR.toLowerCase() } }).ok, true, 'address comparison is case-insensitive');
  });
});

describe('policy: per-action spend ceiling, testnet only', () => {
  test('grantCeiling: defaults 0.5 ETH / 20 NEAR, env can lower or raise but never above the compiled-in maximum', () => {
    assert.equal(grantCeiling('evm', {}), parseUnits('0.5', 18)); assert.equal(grantCeiling('near', {}), parseUnits('20', 24));
    assert.equal(grantCeiling('evm', { VAULT_MAX_TOTAL_CAP: '0.1' }), parseUnits('0.1', 18));
    assert.equal(grantCeiling('evm', { VAULT_MAX_TOTAL_CAP: '0.8' }), parseUnits('0.8', 18));
    assert.equal(grantCeiling('evm', { VAULT_MAX_TOTAL_CAP: '999' }), GRANT_CEILINGS.evm.hardMax, 'clamped to the compiled-in maximum');
    assert.equal(grantCeiling('near', { VAULT_MAX_TOTAL_CAP: 'evm:0.2,near:7' }), parseUnits('7', 24));
    assert.equal(grantCeiling('evm', { VAULT_MAX_TOTAL_CAP: 'evm:0.2,near:7' }), parseUnits('0.2', 18));
    assert.equal(grantCeiling('evm', { VAULT_MAX_TOTAL_CAP: 'garbage' }), parseUnits('0.5', 18), 'invalid env falls back to the safe default');
    assert.equal(grantCeiling('evm', { VAULT_MAX_TOTAL_CAP: '0' }), parseUnits('0.5', 18));
  });
  test('assertDecisionAllowed(grant_mandate): ceiling, max_spend binding, schema, bounds, mainnet', () => {
    assert.doesNotThrow(() => assertDecisionAllowed(grantRow(grantPayload())));
    const over = grantPayload(); over.mandate.totalCap = (ETH).toString(); over.mandate.periodCap = over.mandate.totalCap; over.mandate.perDrawCap = '1000';
    assert.throws(() => assertDecisionAllowed(grantRow(over)), (e) => e.code === 'spend', 'total cap above the 0.5 ETH ceiling');
    const nearOver = grantPayload({ vault: { chainId: 'near-testnet', address: 'vault.testnet', owner: 'op.testnet' }, agent: { account: 'agent.testnet' } });
    nearOver.mandate.totalCap = (21n * 10n ** 24n).toString(); nearOver.mandate.periodCap = nearOver.mandate.totalCap;
    assert.throws(() => assertDecisionAllowed(grantRow(nearOver, { chain_id: 'near-testnet' })), (e) => e.code === 'spend', '21 NEAR > 20 NEAR');
    assert.throws(() => assertDecisionAllowed(grantRow(grantPayload(), { max_spend: '1' })), (e) => e.code === 'spend', 'max_spend must equal totalCap');
    assert.throws(() => assertDecisionAllowed(grantRow(grantPayload({ fund: { amount: ETH.toString() } }))), (e) => e.code === 'spend', 'funding above ceiling');
    assert.throws(() => assertDecisionAllowed(grantRow(grantPayload(), { chain_id: 'evm:1' })), (e) => e.code === 'network_blocked');
    assert.throws(() => assertDecisionAllowed(grantRow(grantPayload(), { chain_id: 'near-mainnet' })), (e) => e.code === 'network_blocked');
    assert.throws(() => assertDecisionAllowed(grantRow(grantPayload({ loop: { maxPerDay: 51 } }))), (e) => e.code === 'schema');
    assert.throws(() => assertDecisionAllowed(grantRow(grantPayload({ templates: [] }))), (e) => e.code === 'schema');
    const dep = grantPayload(); dep.templates[0].deposit = '1';
    assert.throws(() => assertDecisionAllowed(grantRow(dep)), (e) => e.code === 'grant', 'EVM templates carry no deposit');
    const caps = grantPayload(); caps.mandate.perDrawCap = '3000';
    assert.throws(() => assertDecisionAllowed(grantRow(caps)), (e) => e.code === 'grant', 'perDraw > periodCap');
    const md = grantPayload(); md.mandate.maxDeploys = '1001';
    assert.throws(() => assertDecisionAllowed(grantRow(md)), (e) => e.code === 'grant');
    assert.throws(() => assertDecisionAllowed(grantRow(grantPayload(), { payload: '{not json' })), PolicyError);
    assert.throws(() => assertDecisionAllowed(grantRow(grantPayload(), { expiry: Date.now() + 30 * 864e5 })), (e) => e.code === 'expiry');
  });
  test('existing deploy_testnet limits are unchanged', () => {
    const ok = { action: 'deploy_testnet', chain_id: 'evm:31337', expiry: Date.now() + 1000, max_spend: '0' };
    assert.doesNotThrow(() => assertDecisionAllowed(ok));
    assert.throws(() => assertDecisionAllowed({ ...ok, max_spend: '1' }), (e) => e.code === 'spend');
  });
  test('units helpers', () => {
    assert.equal(parseUnits('0.05', 18), 50000000000000000n); assert.equal(parseUnits('1.', 18), null); assert.equal(parseUnits('-1', 18), null); assert.equal(parseUnits('1e3', 18), null);
    assert.equal(formatUnits(50000000000000000n, 18), '0.05'); assert.equal(formatUnits(0n, 18), '0'); assert.equal(UNITS.near.decimals, 24);
  });
});

describe('approveUnderMandate + decision semantics', () => {
  async function world() {
    const { db } = await seededDb();
    const vault = await fakeVault(db);
    const d = await pendingDecision(db);
    return { db, vault, d };
  }
  test('records approver mandate:<vaultId>:<epoch>, binds the vault, inserts the mandate run, audits it; the API says no human signed', async () => {
    const { db, vault, d } = await world();
    const before = await getDecision(db, d.id);
    assert.equal(before.approval, null);
    const a = await approveUnderMandate(db, d.id, { vault, epoch: 4 });
    assert.equal(a.status, 'approved'); assert.equal(a.approver, `mandate:${vault.id}:4`); assert.equal(a.bound_signer, VAULT_ADDR);
    assert.deepEqual({ mode: a.approval.mode, humanSigned: a.approval.humanSigned, vaultId: a.approval.vaultId, epoch: a.approval.epoch }, { mode: 'mandate', humanSigned: false, vaultId: vault.id, epoch: 4 });
    assert.match(a.approval.note, /No human signed/);
    const run = await db.get('SELECT * FROM mandate_runs WHERE decision_id=?', [d.id]);
    assert.deepEqual({ vault: run.vault_id, epoch: run.epoch, status: run.status }, { vault: vault.id, epoch: 4, status: 'claimed' });
    const au = await db.get("SELECT * FROM audit WHERE action='decision.approved_under_mandate'");
    assert.equal(JSON.parse(au.detail).humanSigned, false);
    // the same view is what the list API returns
    const app = createApp({ db, operatorToken: OPERATOR, defer: () => {} });
    const list = (await (await app(new Request('http://t/api/decisions'))).json()).items.find((x) => x.id === d.id);
    assert.equal(list.approval.humanSigned, false);
    // deploy-data (the HUMAN signing helper) is refused for a mandate-approved decision
    const dd = await apiClient(app)(`/api/decisions/${d.id}/deploy-data`);
    assert.equal(dd.status, 409); assert.match(dd.json.error, /no human signs/);
  });
  test('a human-approved decision is marked humanSigned: true', async () => {
    const { db, d } = await world();
    const a = await approveDecision(db, d.id, { nonce: d.nonce, payloadHash: d.payload_hash, confirm: `approve ${d.id}`, signer: ADDR.owner, actor: 'operator' });
    assert.deepEqual({ mode: a.approval.mode, humanSigned: a.approval.humanSigned }, { mode: 'human', humanSigned: true });
  });
  test('re-checks what approveDecision checks (except human-only fields): kill switch, state, action, network, payload hash, binding, vault status', async () => {
    const { db, vault, d } = await world();
    await db.run("INSERT INTO kv(k,v) VALUES('kill_switch','1')");
    await assert.rejects(approveUnderMandate(db, d.id, { vault, epoch: 1 }), (e) => e.code === 'paused');
    await db.run("DELETE FROM kv WHERE k='kill_switch'");
    await assert.rejects(approveUnderMandate(db, d.id, { vault: { ...vault, status: 'inactive' }, epoch: 1 }), (e) => e.code === 'state');
    await assert.rejects(approveUnderMandate(db, d.id, { vault: { ...vault, chain_id: 'evm:84532' }, epoch: 1 }), (e) => e.code === 'network_blocked');
    await db.run("UPDATE decisions SET payload=? WHERE id=?", [JSON.stringify({ ...JSON.parse(d.payload), registry: { owner: ADDR.other, proposer: ADDR.other } }), d.id]);
    await assert.rejects(approveUnderMandate(db, d.id, { vault, epoch: 1 }), (e) => e.code === 'payload_hash', 'a tampered stored payload is never executed');
    await db.run("UPDATE decisions SET payload=? WHERE id=?", [d.payload, d.id]);
    await db.run("UPDATE decisions SET expiry=? WHERE id=?", [Date.now() - 1, d.id]);
    await assert.rejects(approveUnderMandate(db, d.id, { vault, epoch: 1 }), (e) => e.code === 'state', 'expired');
    await db.run("UPDATE decisions SET expiry=?, bound_signer=? WHERE id=?", [Date.now() + 1e6, ADDR.other, d.id]);
    await assert.rejects(approveUnderMandate(db, d.id, { vault, epoch: 1 }), (e) => e.code === 'state', 'a decision a human already bound is left to that human');
    await db.run("UPDATE decisions SET bound_signer=NULL, action='grant_mandate' WHERE id=?", [d.id]);
    await assert.rejects(approveUnderMandate(db, d.id, { vault, epoch: 1 }), (e) => e.code === 'action_blocked', 'only deploy_testnet runs under a mandate');
    assert.equal((await db.get('SELECT COUNT(*) n FROM mandate_runs')).n, 0, 'no refused attempt consumed the single execution');
  });
  test('one execution per decision, one in flight per vault, released decisions are never retried by the agent', async () => {
    const { db, vault, d } = await world();
    const d2 = await pendingDecision(db);
    await approveUnderMandate(db, d.id, { vault, epoch: 1 });
    await assert.rejects(approveUnderMandate(db, d2.id, { vault, epoch: 1 }), (e) => /in flight/.test(e.message), 'second claim on the same vault while one is in flight');
    assert.equal((await getDecision(db, d2.id)).status, 'pending', 'the refused claim rolled back completely');
    const rel = await releaseToHuman(db, d.id, 'test');
    assert.equal(rel.status, 'pending'); assert.equal(rel.approver, null); assert.equal(rel.bound_signer, null);
    assert.equal((await db.get('SELECT status FROM mandate_runs WHERE decision_id=?', [d.id])).status, 'failed');
    await assert.rejects(approveUnderMandate(db, d.id, { vault, epoch: 1 }), (e) => /already executed/.test(e.message), 'mandate_runs PK: one agent attempt per decision');
    await approveUnderMandate(db, d2.id, { vault, epoch: 1 }); // the slot is free after the failure
  });
  test('grant_mandate: only the vault OWNER can be the bound signer; it is activated on-chain, never "deployed"', async () => {
    const { db } = await seededDb();
    await fakeVault(db, { status: 'attached', agent: null });
    const app = createApp({ db, operatorToken: OPERATOR, defer: () => {} });
    const api = apiClient(app);
    const grant = await propose(api, db);
    const body = (signer) => ({ nonce: grant.nonce, payloadHash: grant.payload_hash, confirm: `approve ${grant.id}`, signer });
    const wrong = await api(`/api/decisions/${grant.id}/approve`, { method: 'POST', body: body(ADDR.other) });
    assert.equal(wrong.status, 400); assert.equal(wrong.json.code, 'signer');
    const ok = await api(`/api/decisions/${grant.id}/approve`, { method: 'POST', body: body(ADDR.owner.toLowerCase()) });
    assert.equal(ok.status, 200); assert.equal(ok.json.status, 'approved');
    await assert.rejects(recordDeployment(db, grant.id, { txHash: '0x' + '11'.repeat(32) }), (e) => e.code === 'state');
    assert.equal((await api(`/api/decisions/${grant.id}/deploy-data`)).status, 409);
  });
});

async function propose(api, db, over = {}) {
  const { artifactHash } = await (async () => ({ artifactHash: (await db.get("SELECT hash FROM artifacts WHERE kind='contract-build:evm'")).hash }))();
  const r = await api('/api/vault/mandates/propose', { method: 'POST', body: {
    chainId: 'evm:31337', vault: VAULT_ADDR, agent: AGENT_ADDR, mandate: { ...MANDATE, ...(over.mandate ?? {}) },
    templates: [{ artifactHash, owner: REG_OWNER, proposer: REG_PROPOSER }], fund: { amount: (ETH / 5n).toString() }, loop: { maxPerDay: 3 }, ...(over.top ?? {}),
  } });
  if (over.raw) return r;
  assert.ok([200, 201].includes(r.status), r.text);
  return r.json;
}

describe('HTTP API', () => {
  async function setup(opts = {}) {
    const { db } = await seededDb();
    const vault = await fakeVault(db, { status: opts.status ?? 'attached', agent: null });
    const app = createApp({ db, operatorToken: OPERATOR, fetchImpl: offline, defer: () => {}, ...opts.deps });
    return { db, app, api: apiClient(app), vault };
  }
  test('GET /api/vault: documented shape even with no chain reachable; reads are public; signing is not supported without a keystore', async () => {
    const { api, vault } = await setup();
    const r = await api('/api/vault', { auth: false });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json).sort(), ['agent', 'enabled', 'health', 'loop', 'signingSupported', 'vaults']);
    assert.equal(r.json.enabled, false, 'AUTONOMY_ENABLED defaults off'); assert.equal(r.json.signingSupported, false);
    assert.deepEqual(r.json.agent, { evm: null, near: null });
    assert.deepEqual(Object.keys(r.json.loop).sort(), ['lastError', 'lastTickAt', 'maxPerDay', 'state', 'usedToday']);
    const v = r.json.vaults[0];
    for (const k of ['id', 'chainId', 'network', 'address', 'owner', 'paused', 'codeOk', 'mandate', 'usage', 'budget', 'available', 'agentBalance', 'unit', 'templates', 'readAt', 'readError', 'mandateDecisionId']) assert.ok(k in v, k);
    assert.equal(v.id, vault.id); assert.equal(v.codeOk, false); assert.match(v.readError, /offline|network/i);
    assert.deepEqual(v.unit, { symbol: 'ETH', base: 'wei', decimals: 18 });
    assert.ok(r.json.health.every((h) => typeof h.name === 'string' && typeof h.ok === 'boolean' && typeof h.detail === 'string'));
    assert.equal(r.json.health.find((h) => h.name === 'autonomy enabled').ok, false);
    const st = await api('/api/status');
    assert.deepEqual(st.json.vault, { loop: 'idle', vaults: 1, activeMandates: 0 });
  });
  test('GET /api/vault with a keystore shows PUBLIC addresses only', async () => {
    const { tempKeystore } = await import('./vault-helpers.js');
    const keys = tempKeystore();
    try {
      const { api } = await setup({ deps: { keystore: keys.ks, signingSupported: true } });
      const r = await api('/api/vault', { auth: false });
      assert.equal(r.json.signingSupported, true); assert.equal(r.json.agent.evm.address, keys.ks.publicView().evm.address);
      assert.match(r.json.agent.near.account, /^[0-9a-f]{64}$/);
      const priv = keys.privateKeyHex();
      assert.ok(!r.text.includes(priv) && !r.text.includes(priv.slice(2)));
    } finally { keys.cleanup(); }
  });
  test('propose: auth, validation, ceiling, mainnet, unattached vault, idempotent duplicates; amounts are decimal strings', async () => {
    const { db, api } = await setup();
    assert.equal((await propose(api, db, { raw: true, top: {} }).then((r) => r.status)), 201);
    const noAuth = await api('/api/vault/mandates/propose', { method: 'POST', auth: false, body: {} });
    assert.equal(noAuth.status, 401);
    assert.equal((await api('/api/vault/mandates/propose', { method: 'POST', body: { chainId: 'evm:31337' } })).status, 400);
    const over = await propose(api, db, { raw: true, mandate: { totalCap: ETH.toString(), periodCap: ETH.toString() } });
    assert.equal(over.status, 400); assert.equal(over.json.code, 'spend');
    const main = await propose(api, db, { raw: true, top: { chainId: 'evm:1' } });
    assert.equal(main.status, 400); assert.equal(main.json.code, 'network_blocked');
    const nov = await propose(api, db, { raw: true, top: { vault: ADDR.other } });
    assert.equal(nov.status, 409); assert.match(nov.json.error, /attach the vault first/);
    const noArt = await api('/api/vault/mandates/propose', { method: 'POST', body: { chainId: 'evm:31337', vault: VAULT_ADDR, agent: AGENT_ADDR, mandate: MANDATE, templates: [{ artifactHash: 'f'.repeat(64), owner: REG_OWNER }], fund: { amount: '1' } } });
    assert.equal(noArt.status, 400); assert.equal(noArt.json.code, 'artifact');
    const first = await propose(api, db); const second = await propose(api, db);
    assert.equal(first.id, second.id, 'identical pending proposals collapse');
    const d = await db.get('SELECT * FROM decisions WHERE id=?', [first.id]);
    assert.equal(d.action, 'grant_mandate'); assert.equal(d.status, 'pending'); assert.equal(d.max_spend, MANDATE.totalCap);
    const p = JSON.parse(d.payload);
    assert.equal(p.kind, 'grant_mandate'); assert.equal(p.vault.chainId, 'evm:31337'); assert.equal(p.vault.owner, ADDR.owner); assert.equal(p.agent.address, AGENT_ADDR);
    assert.deepEqual(Object.keys(p.mandate).sort(), ['expiresAt', 'maxDeploys', 'perDrawCap', 'periodCap', 'periodSecs', 'totalCap']);
    assert.ok(Object.values(p.mandate).every((x) => typeof x === 'string'), 'amounts and times are decimal strings');
    assert.deepEqual(Object.keys(p.templates[0]).sort(), ['artifactHash', 'deposit', 'initMaterial', 'label', 'templateId']);
    assert.match(p.templates[0].templateId, /^0x[0-9a-f]{64}$/); assert.equal(p.loop.maxPerDay, 3); assert.equal(p.fund.amount, (ETH / 5n).toString());
  });
  test('propose also accepts the web console shape (vault/agent objects, client-computed templates) but RECOMPUTES every template id and rejects any mismatch', async () => {
    const { db, api } = await setup();
    const artifactHash = (await db.get("SELECT hash FROM artifacts WHERE kind='contract-build:evm'")).hash;
    const first = await propose(api, db); // server-side computation
    const t0 = first.payload.templates[0];
    const body = (over = {}, tpl = {}) => ({ chainId: 'evm:31337', vault: { address: VAULT_ADDR, owner: ADDR.owner }, agent: { address: AGENT_ADDR }, mandate: { ...MANDATE, expiresAt: String(Math.floor(Date.now() / 1000) + 3600) },
      templates: [{ artifactHash, templateId: t0.templateId, label: t0.label, deposit: '0', initMaterial: t0.initMaterial, ...tpl }], fund: { amount: '1000' }, loop: { maxPerDay: 2 }, ...over });
    const ok = await api('/api/vault/mandates/propose', { method: 'POST', body: body() });
    assert.equal(ok.status, 201, ok.text); assert.equal(ok.json.payload.templates[0].templateId, t0.templateId);
    const forged = await api('/api/vault/mandates/propose', { method: 'POST', body: body({}, { templateId: '0x' + 'ab'.repeat(32) }) });
    assert.equal(forged.status, 400); assert.match(forged.json.error, /template_mismatch/);
    const wrongOwner = await api('/api/vault/mandates/propose', { method: 'POST', body: body({}, { initMaterial: { ...t0.initMaterial, owner: ADDR.other } }) });
    assert.equal(wrongOwner.status, 400, 'owner in initMaterial changes the recomputed id, so the supplied id no longer matches');
    const notOwner = await api('/api/vault/mandates/propose', { method: 'POST', body: body({ vault: { address: VAULT_ADDR, owner: ADDR.other } }) });
    assert.equal(notOwner.status, 400); assert.match(notOwner.json.error, /not the on-chain owner/);
  });
  test('web console propose body (templates carry only artifactHash/label/deposit; seconds timestamps) works; registry owner defaults to the vault OWNER, proposer to the AGENT; response carries {decision}', async () => {
    const { db, api } = await setup();
    const artifactHash = (await db.get("SELECT hash FROM artifacts WHERE kind='contract-build:evm'")).hash;
    const r = await api('/api/vault/mandates/propose', { method: 'POST', body: {
      chainId: 'evm:31337', vault: { address: VAULT_ADDR, owner: ADDR.owner }, agent: { address: AGENT_ADDR },
      mandate: { expiresAt: Math.floor(Date.now() / 1000) + 86400, perDrawCap: '1000', periodSecs: 3600, periodCap: '2000', totalCap: '5000', maxDeploys: 2 },
      templates: [{ artifactHash, label: 'ProposalRegistry', deposit: '0' }], fund: { amount: '5000' }, loop: { maxPerDay: 3 } } });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.decision.id, r.json.id);
    const t = r.json.payload.templates[0];
    assert.equal(t.initMaterial.owner, ADDR.owner); assert.equal(t.initMaterial.proposer, AGENT_ADDR);
    assert.equal(r.json.payload.vault.chainId, 'evm:31337');
    const tooMany = await api('/api/vault/mandates/propose', { method: 'POST', body: { chainId: 'evm:31337', vault: VAULT_ADDR, agent: AGENT_ADDR, mandate: MANDATE, templates: [{ artifactHash }], fund: { amount: '1' }, loop: { maxPerDay: 100 } } });
    assert.equal(tooMany.status, 400, 'loop.maxPerDay is hard-capped at 50 in code');
  });
  test('/api/security publishes the grant total-cap ceiling; GET /api/vault/verify gives a per-field verdict; /api/vault timestamps are seconds', async () => {
    const { db, api } = await setup();
    const sec = (await api('/api/security')).json.vaultLimits;
    assert.equal(sec.grantTotalCapCeiling.evm.default, '500000000000000000'); assert.equal(sec.grantTotalCapCeiling.near.default, '20000000000000000000000000');
    assert.equal(sec.grantTotalCapCeiling.evm.effective, grantCeiling('evm').toString()); assert.equal(sec.mainnet, 'blocked'); assert.equal(sec.maxPerDayHardCap, 50);
    const g = await propose(api, db);
    const v = await api(`/api/vault/verify?decisionId=${g.id}`, { auth: false });
    assert.equal(v.status, 200); assert.equal(v.json.attached, true); assert.equal(v.json.ok, false, 'chain unreachable offline: no verdict can be positive');
    assert.equal((await api('/api/vault/verify?decisionId=dec_nope')).status, 404);
    assert.equal((await api('/api/vault/verify')).status, 400);
    const state = await api('/api/vault');
    assert.ok(state.json.loop.lastTickAt === null || state.json.loop.lastTickAt < 1e11, 'seconds, not ms');
  });
  test('verifyMandate with the REAL NEAR adapter: right wasm id but swapped owner in the stored init args is a MISMATCH (NEAR ids do not bind init args)', async () => {
    const near = (await adapterFor('near')).adapter;
    if (!near?.checkTemplate) return; // adapter not present in this build
    const tid = 'ab'.repeat(32);
    const init = { owner_id: 'op.testnet', proposer_id: 'agent.testnet', network_id: 'testnet' };
    const payload = { vault: { owner: 'op.testnet' }, agent: { account: 'agent.testnet' }, mandate: { expiresAt: '5000', perDrawCap: '10', periodSecs: '3600', periodCap: '20', totalCap: '50', maxDeploys: '2' }, templates: [{ artifactHash: 'a'.repeat(64), templateId: tid, label: 'registry', deposit: '3800000000000000000000000', initMaterial: init }] };
    const st = (initArgs) => normalizeState({ config: { owner: 'op.testnet', paused: false, networkId: 'testnet', epoch: 1 }, mandate: { agent: 'agent.testnet', expiresAt: 5000, perDrawCap: '10', periodSecs: 3600, periodCap: '20', totalCap: '50', maxDeploys: 2, revoked: false, start: 100 },
      usage: {}, available: '1', agentBalance: '0', agentExists: false, blockTime: 200, templates: [{ id: tid, label: 'registry', deposit: '3800000000000000000000000', initArgs, initGas: '30000000000000' }] });
    assert.equal(verifyMandate(st(init), payload, { protocol: 'near', adapter: near }).ok, true, JSON.stringify(verifyMandate(st(init), payload, { protocol: 'near', adapter: near }).checks.filter((c) => !c.ok)));
    const swapped = verifyMandate(st({ ...init, owner_id: 'attacker.testnet' }), payload, { protocol: 'near', adapter: near });
    assert.equal(swapped.ok, false); assert.ok(swapped.checks.some((c) => !c.ok && /init_args/.test(c.name)));
    assert.equal(verifyMandate(st(init), payload, { protocol: 'near' }).ok, true, 'without the adapter hook only the id/label/deposit are compared (documented)');
    assert.equal(normalizeState({ config: { owner: 'o', epoch: 0 }, mandate: null, blockTime: 1, templates: [{ id: 'AA', initArgs: { a: 1 } }] }).templates[0].initArgs.a, 1, 'initArgs survive normalizeState');
  });
  test('plan: exact calldata for allowTemplate / setMandate / deposit decodes (viem) to the approved payload; cast equivalents never carry a key', { skip: needViem }, async () => {
    const { db, api } = await setup();
    const g = await propose(api, db);
    const payload = g.payload;
    const plan = (await api(`/api/vault/plan?decisionId=${g.id}`, { auth: false })).json;
    assert.equal(plan.evmChainId, 31337);
    assert.deepEqual(plan.steps.map((s) => s.who), ['human', 'human', 'human', 'human', 'human', 'server', 'agent'], 'approve, allowTemplate, setMandate, fund, seed, then server and agent notes');
    const txs = plan.steps.filter((s) => s.tx);
    assert.ok(txs.every((s) => s.tx.chainId === 31337 && typeof s.tx.value === 'string' && /^0x/.test(s.tx.data)));
    const allow = viem.decodeFunctionData({ abi: VAULT_ABI, data: txs[0].tx.data });
    assert.equal(allow.functionName, 'allowTemplate'); assert.deepEqual(allow.args, [payload.templates[0].templateId, payload.templates[0].label, 0n]);
    const sm = viem.decodeFunctionData({ abi: VAULT_ABI, data: txs[1].tx.data });
    const m = payload.mandate;
    assert.equal(sm.functionName, 'setMandate');
    assert.deepEqual(sm.args.map(String), [payload.agent.address, m.expiresAt, m.perDrawCap, m.periodSecs, m.periodCap, m.totalCap, m.maxDeploys].map((x, i) => (i === 0 ? viem.getAddress(x) : x)));
    assert.equal(txs[1].tx.to, VAULT_ADDR);
    assert.deepEqual({ data: txs[2].tx.data, value: txs[2].tx.value, to: txs[2].tx.to }, { data: '0x', value: payload.fund.amount, to: VAULT_ADDR }, 'funding is a plain value transfer');
    for (const s of plan.steps.filter((x) => x.cli)) { assert.match(s.cli, /^cast send /); assert.doesNotMatch(s.cli, /private-key|--mnemonic|0x[0-9a-fA-F]{64}(?![0-9a-fA-F])(?=.*private)/i); assert.match(s.cli, /--rpc-url/); }
    assert.match(plan.steps.find((s) => s.title.startsWith('setMandate')).cli, /setMandate\(address,uint256,uint256,uint256,uint256,uint256,uint256\)/);
    assert.equal((await api('/api/vault/plan?decisionId=dec_nope', { auth: false })).status, 404);
    assert.equal((await api('/api/vault/plan', { auth: false })).status, 400);
    const dep = await pendingDecision(db); assert.equal((await api(`/api/vault/plan?decisionId=${dep.id}`)).status, 409);
  });
  test('plan for NEAR with no NEAR adapter says "not available" instead of inventing commands', async () => {
    const { db } = await seededDb();
    const payload = grantPayload({ vault: { chainId: 'near-testnet', address: 'vault.testnet', owner: 'op.testnet' }, agent: { account: 'agent.testnet' } });
    const d = { id: 'dec_near1', artifact: 'a'.repeat(64) };
    await db.run("INSERT INTO decisions(id,run_id,artifact_hash,action,chain_id,target,method,max_spend,expiry,nonce,payload,payload_hash,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [d.id, null, d.artifact, 'grant_mandate', 'near-testnet', 'vault.testnet', 'grant_mandate', payload.mandate.totalCap, Date.now() + 1e6, 'n', JSON.stringify(payload), 'h', 'pending', Date.now()]);
    unregisterAdapter('near');
    const plan = await buildPlan(db, d.id);
    const stepText = JSON.stringify(plan.steps);
    const have = (await adapterFor('near')).adapter;
    if (!have) assert.match(stepText, /not available/);
    else { // fallback/adapter-supplied near-cli-rs commands (NOT run against a NEAR node)
      const cli = plan.steps.filter((s) => s.who === 'human' && s.cli).map((s) => s.cli);
      assert.ok(cli.length >= 3 && cli.every((c) => /^near (contract|tokens) /.test(c) && /sign-with-keychain/.test(c) && !/private|secret/i.test(c)));
      assert.ok(cli.some((c) => /allow_template/.test(c)) && cli.some((c) => /set_mandate/.test(c)));
    }
  });
  test('loop pause / resume (operator only); a BLOCKED loop cannot be paused away and needs an operator resume', async () => {
    const { db, api } = await setup();
    assert.equal((await api('/api/vault/loop/pause', { method: 'POST', auth: false })).status, 401);
    assert.equal((await api('/api/vault/loop/pause', { method: 'POST' })).json.loop.state, 'paused');
    assert.equal((await api('/api/vault')).json.loop.state, 'paused');
    assert.equal((await api('/api/vault/loop/resume', { method: 'POST' })).json.loop.state, 'idle');
    await blockLoop(db, 'test anomaly');
    assert.equal((await pauseLoop(db)).state, 'blocked', 'pause does not hide a block');
    assert.equal((await getLoop(db)).reason, 'test anomaly');
    const led = (await api('/api/vault/ledger')).json;
    assert.ok(led.items.some((i) => i.kind === 'anomaly' && /BLOCKED/.test(i.detail)) && led.chainOk);
    assert.equal((await api('/api/vault/loop/resume', { method: 'POST' })).json.loop.state, 'idle');
    assert.ok((await db.get("SELECT 1 x FROM audit WHERE action='vault.loop.resumed'")));
  });
  test('methods: unknown method on a vault path is 405 + Allow; unknown path 404', async () => {
    const { api } = await setup();
    const r = await api('/api/vault', { method: 'POST' }); assert.equal(r.status, 405); assert.match(r.headers.get('allow'), /GET/);
    assert.equal((await api('/api/vault/attach')).status, 405);
    assert.equal((await api('/api/vault/nothing')).status, 404);
  });
  test('attach refuses mainnet / unknown chains and bad addresses before any RPC', async () => {
    const { api } = await setup();
    const never = createApp({ db: await memDb(), operatorToken: OPERATOR, defer: () => {}, fetchImpl: async () => { throw new Error('RPC must not be called'); } });
    const c = apiClient(never);
    assert.equal((await c('/api/vault/attach', { method: 'POST', body: { chainId: 'evm:1', address: VAULT_ADDR } })).json.code, 'network_blocked');
    assert.equal((await c('/api/vault/attach', { method: 'POST', body: { chainId: 'near-mainnet', address: 'x.near' } })).json.code, 'network_blocked');
    assert.equal((await c('/api/vault/attach', { method: 'POST', body: { chainId: 'evm:31337', address: 'not-an-address' } })).json.code, 'input');
    void api;
  });
});

describe('ERC-8004 registration file (Draft; nothing is sent)', () => {
  test('404 unless AGENT_PUBLIC_URL is set; then a valid file labelled Draft; never a transaction', async () => {
    const db = await memDb();
    const off = createApp({ db, operatorToken: 't', defer: () => {}, agentPublicUrl: '' });
    assert.equal((await off(new Request('http://t/.well-known/agent-registration.json'))).status, 404);
    const app = createApp({ db, operatorToken: 't', defer: () => {}, agentPublicUrl: 'https://agent.example.org' });
    const r = await app(new Request('http://t/.well-known/agent-registration.json'));
    assert.equal(r.status, 200); assert.equal(r.headers.get('x-erc8004-status'), 'Draft');
    const file = await r.json();
    const { validateRegistrationFile } = await import('../src/identity/erc8004.js');
    assert.equal(validateRegistrationFile(file).ok, true, JSON.stringify(validateRegistrationFile(file).errors));
    assert.match(file.description, /DRAFT/); assert.equal(file.services[0].endpoint, 'https://agent.example.org'); assert.deepEqual(file.registrations, []);
    assert.equal((await app(new Request('http://t/.well-known/agent-registration.json', { method: 'POST' }))).status, 404);
    assert.equal(agentRegistrationFile({ publicUrl: '' }), null);
    assert.equal(agentRegistrationFile({ publicUrl: 'https://x.example' }).spec.status, 'Draft');
  });
});

describe('adapter registry', () => {
  test('a missing NEAR adapter is a clear "not available" status; a registered adapter is used; incomplete adapters are reported by the loop gates', async () => {
    unregisterAdapter('near');
    const r = await adapterFor('near');
    if (!r.adapter) assert.match(r.reason, /NEAR adapter not available/);
    registerAdapter('near', { chain: 'near', readState: async () => ({}), verifyVaultCode: async () => ({ ok: true, checks: [] }) });
    assert.equal((await adapterFor('near')).adapter.chain, 'near');
    unregisterAdapter('near');
    assert.equal((await adapterFor('solana')).adapter, null);
  });
});

void proposeGrant; void audit; void resumeLoop;
