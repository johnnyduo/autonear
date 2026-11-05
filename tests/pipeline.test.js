import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ingestSource, registerSources } from '../src/ingest.js';
import { refreshOpportunities } from '../src/scoring.js';
import { createRun, executeRun, verifyRunChain, setPaused } from '../src/orchestrator/coordinator.js';
import { recordAttestation } from '../src/attest.js';
import { approveDecision, getDecision, recordDeployment, rejectDecision } from '../src/decisions.js';
import { createApp } from '../src/app.js';
import { base58, hexToBytes } from '../src/chains/common.js';
import { memDb, fakeConnector, gh } from './helpers.js';

// TEST DOUBLE: a fabricated attestation so the pipeline can be exercised without a toolchain. Never used outside tests.
const WASM = 'ab'.repeat(32);
const FAKE_ATT = {
  protocol: 'near', commitSha: 'deadbeef',
  manifest: { sha256: WASM, bytes: 123456, sourceSha256: 'cd'.repeat(32), rustc: 'test', nearSdk: 'test' },
  tests: { passed: 40, failed: 0, lint: true, fuzz: true, names: ['unauthorized_propose', 'replay_rejected', 'expired_approve', 'pause_blocks', 'bad_nonce', 'cancel_by_outsider', 'double_execute', 'exceeded_spend', 'wrong_method', 'wrong_target', 'owner_two_step'] },
};

async function seeded() {
  const db = await memDb();
  const mk = (id, n) => fakeConnector(id, Array.from({ length: n }, (_, i) => gh(i + 1, { externalId: `${id}${i}`, author: `${id}-u${i}`, title: `Treasury multisig payout fails (${id}-${i})`, body: `We cannot rebalance DAO treasury ${id}${i}: multisig approval missing policy`, url: `https://example.org/${id}/${i}` })));
  const usage = fakeConnector('u1', [gh(99, { externalId: 'u99', kind: 'usage', forceTags: ['treasury'], org: 'near', title: 'On-chain: escrow holdings', body: 'fixture usage observation', author: 'rpc', url: 'https://example.org/usage' })]);
  const conns = [mk('s1', 8), mk('s2', 8), mk('s3', 8), usage];
  await registerSources(db, conns);
  for (const c of conns) await ingestSource(db, c);
  await db.run("UPDATE sources SET last_success=?", [Date.now()]);
  await refreshOpportunities(db);
  return db;
}
const treasuryQuoteFetch = async () => { throw new Error('offline'); };
// fetchImpl that makes every outbound call fail (the treasury rehearsal must fall back to labelled fixtures)
const offline = async () => { throw new TypeError('offline'); };

test('pipeline blocks at Builder without an attested build, and never creates a decision', async () => {
  const db = await seeded();
  const { run } = await createRun(db, { opportunityId: 'opp_treasury', params: { chain: 'near-testnet', owner: 'op.testnet', contractAccount: 'reg.op.testnet' } });
  const done = await executeRun(db, run.id, { fetchImpl: offline });
  assert.equal(done.state, 'blocked');
  assert.equal((await db.get('SELECT COUNT(*) n FROM decisions')).n, 0);
  assert.ok((await verifyRunChain(db, run.id)).ok);
});

test('full pipeline → pending decision; approval gates; deployment recorded only after on-chain verification', async () => {
  const db = await seeded();
  await recordAttestation(db, FAKE_ATT);
  const { run } = await createRun(db, { opportunityId: 'opp_treasury', params: { chain: 'near-testnet', owner: 'op.testnet', proposer: 'agent.testnet', contractAccount: 'reg.op.testnet' } });
  const done = await executeRun(db, run.id, { fetchImpl: offline });
  assert.equal(done.state, 'awaiting_approval', done.error ?? '');
  const ev = await db.all('SELECT agent_role,status FROM run_events WHERE run_id=?', [run.id]);
  for (const r of ['signal_collector', 'evidence_analyst', 'skeptic', 'product_architect', 'builder', 'security_reviewer', 'launch_planner']) assert.ok(ev.some((e) => e.agent_role === r && e.status === 'completed'), r);
  const brief = await db.get("SELECT * FROM artifacts WHERE kind='brief'");
  assert.ok(brief); assert.match(brief.hash, /^[0-9a-f]{64}$/);

  const d = await db.get('SELECT * FROM decisions');
  assert.equal(d.status, 'pending'); assert.equal(d.max_spend, '0');
  const good = { nonce: d.nonce, payloadHash: d.payload_hash, confirm: `approve ${d.id}`, signer: 'op.testnet', actor: 'op' };
  await assert.rejects(approveDecision(db, d.id, { ...good, signer: '' }), (e) => e.code === 'signer');
  await assert.rejects(approveDecision(db, d.id, { ...good, signer: 'Not A Valid Id!' }), (e) => e.code === 'signer');
  await assert.rejects(approveDecision(db, d.id, { ...good, nonce: 'wrong' }), (e) => e.code === 'nonce');
  await assert.rejects(approveDecision(db, d.id, { ...good, payloadHash: 'f'.repeat(64) }), (e) => e.code === 'payload_hash');
  await assert.rejects(approveDecision(db, d.id, { ...good, confirm: 'yes' }), (e) => e.code === 'confirm');
  await assert.rejects(recordDeployment(db, d.id, { txHash: '1'.repeat(44) }), (e) => e.code === 'state', 'cannot record a deployment before approval');

  await setPaused(db, true, 'test');
  await assert.rejects(approveDecision(db, d.id, good), (e) => e.code === 'paused');
  await setPaused(db, false, 'test');
  const approved = await approveDecision(db, d.id, good);
  assert.equal(approved.status, 'approved'); assert.ok(approved.signed_receipt);
  await assert.rejects(approveDecision(db, d.id, good), (e) => e.code === 'state', 'cannot approve twice');

  // On-chain verification with a mocked RPC: wrong code hash must be REJECTED, matching one accepted.
  const rpc = (codeHash, ok = true, receiver = 'reg.op.testnet', signerId = 'op.testnet', extra = []) => async (_url, init) => {
    const { method } = JSON.parse(init.body);
    const res = method === 'tx'
      ? { final_execution_status: 'FINAL', status: ok ? { SuccessValue: '' } : { Failure: {} }, receipts_outcome: [{ outcome: { status: { SuccessValue: '' } } }], transaction: { signer_id: signerId, receiver_id: receiver, actions: extra.concat([{ DeployContract: { code: 'x' } }, { FunctionCall: { method_name: 'new' } }]) } }
      : method === 'query' && JSON.parse(init.body).params.request_type === 'view_access_key_list' ? { keys: [{ public_key: 'ed25519:abc', access_key: { permission: 'FullAccess' } }] }
      : { code_hash: codeHash, result: Array.from(Buffer.from(JSON.stringify({ owner_id: 'op.testnet', proposer_id: 'agent.testnet', paused: false, network_id: 'testnet' }))) };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: res }), { status: 200 });
  };
  const tx = base58(createHash('sha256').update('t').digest());
  const wrongRecv = await recordDeployment(db, d.id, { txHash: tx, fetchImpl: rpc(base58(hexToBytes(WASM)), true, 'attacker.testnet') });
  assert.equal(wrongRecv.recorded, false); assert.ok(wrongRecv.verification.checks.some((c) => !c.ok && /approved contract account/.test(c.name)), 'deploy to a different account must be refused');
  const backdoor = await recordDeployment(db, d.id, { txHash: tx, fetchImpl: rpc(base58(hexToBytes(WASM)), true, 'reg.op.testnet', 'op.testnet', [{ DeleteAccount: {} }]) });
  assert.equal(backdoor.recorded, false, 'extra destructive actions in the same tx are refused');
  const extraCall = await recordDeployment(db, d.id, { txHash: tx, fetchImpl: rpc(base58(hexToBytes(WASM)), true, 'reg.op.testnet', 'op.testnet', [{ FunctionCall: { method_name: 'drain' } }]) });
  assert.equal(extraCall.recorded, false, 'unexpected function calls in the same tx are refused');
  const bad = await recordDeployment(db, d.id, { txHash: tx, fetchImpl: rpc('11111111111111111111111111111111') });
  assert.equal(bad.recorded, false); assert.ok(bad.verification.checks.some((c) => !c.ok && /code hash/.test(c.name)));
  assert.equal((await db.get('SELECT COUNT(*) n FROM deployments')).n, 0);
  const goodDep = await recordDeployment(db, d.id, { txHash: tx, fetchImpl: rpc(base58(hexToBytes(WASM))) });
  assert.equal(goodDep.recorded, true);
  assert.equal((await getDecision(db, d.id)).status, 'executed');
  const again = await recordDeployment(db, d.id, { txHash: tx, fetchImpl: rpc(base58(hexToBytes(WASM))) });
  assert.equal(again.idempotent, true, 're-recording the same decision is idempotent');
});

test('expired decisions cannot be approved; rejected ones stay rejected', async () => {
  const db = await seeded();
  await recordAttestation(db, FAKE_ATT);
  const { run } = await createRun(db, { opportunityId: 'opp_treasury', params: { chain: 'near-testnet', owner: 'op.testnet', contractAccount: 'reg.op.testnet' } });
  await executeRun(db, run.id, { fetchImpl: offline });
  const d = await db.get('SELECT * FROM decisions');
  await db.run('UPDATE decisions SET expiry=? WHERE id=?', [Date.now() - 1, d.id]);
  await assert.rejects(approveDecision(db, d.id, { nonce: d.nonce, payloadHash: d.payload_hash, confirm: `approve ${d.id}`, signer: 'op.testnet', actor: 'op' }), (e) => e.code === 'state');
  await db.run('UPDATE decisions SET expiry=? WHERE id=?', [Date.now() + 1e6, d.id]);
  await rejectDecision(db, d.id, { actor: 'op', reason: 'no' });
  await assert.rejects(approveDecision(db, d.id, { nonce: d.nonce, payloadHash: d.payload_hash, confirm: `approve ${d.id}`, signer: 'op.testnet', actor: 'op' }), (e) => e.code === 'state');
});

test('mainnet decisions can never be created', async () => {
  const db = await seeded();
  await recordAttestation(db, FAKE_ATT);
  const { run } = await createRun(db, { opportunityId: 'opp_treasury', params: { chain: 'near-mainnet', owner: 'op.near' } });
  const done = await executeRun(db, run.id, { fetchImpl: offline });
  assert.notEqual(done.state, 'awaiting_approval');
  assert.equal((await db.get('SELECT COUNT(*) n FROM decisions')).n, 0);
});

test('missing owner → decision is NOT created and the run explains why', async () => {
  const db = await seeded();
  await recordAttestation(db, FAKE_ATT);
  const prev = process.env.NEAR_DEPLOY_ACCOUNT; delete process.env.NEAR_DEPLOY_ACCOUNT;
  const { run } = await createRun(db, { opportunityId: 'opp_treasury', params: { chain: 'near-testnet' } });
  const done = await executeRun(db, run.id, { fetchImpl: offline });
  if (prev) process.env.NEAR_DEPLOY_ACCOUNT = prev;
  assert.equal((await db.get('SELECT COUNT(*) n FROM decisions')).n, 0);
  assert.ok(['succeeded', 'blocked', 'awaiting_approval'].includes(done.state));
  const last = await db.get("SELECT detail FROM run_events WHERE run_id=? AND agent_role='launch_planner' AND status='completed'", [run.id]);
  assert.match(last.detail, /missing owner|no decision/);
});

test('run idempotency key returns the same run', async () => {
  const db = await seeded();
  const a = await createRun(db, { opportunityId: 'opp_treasury', idemKey: 'k1' });
  const b = await createRun(db, { opportunityId: 'opp_treasury', idemKey: 'k1' });
  assert.equal(a.run.id, b.run.id); assert.equal(b.created, false);
});

test('API: mutations need the operator token; reads are public; Idempotency-Key required', async () => {
  const db = await seeded();
  const app = createApp({ db, operatorToken: 'secret-token', defer: () => {}, fetchImpl: offline });
  const call = (path, init = {}, tok) => app(new Request('http://x' + path, { ...init, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(init.headers ?? {}) } }));
  assert.equal((await call('/api/opportunities')).status, 200);
  assert.equal((await call('/api/runs', { method: 'POST', body: '{"opportunityId":"opp_treasury"}' })).status, 401);
  assert.equal((await call('/api/runs', { method: 'POST', body: '{"opportunityId":"opp_treasury"}' }, 'wrong')).status, 401);
  assert.equal((await call('/api/runs', { method: 'POST', body: '{"opportunityId":"opp_treasury"}' }, 'secret-token')).status, 400, 'missing idempotency key');
  const ok = await call('/api/runs', { method: 'POST', body: '{"opportunityId":"opp_treasury"}', headers: { 'idempotency-key': 'abc' } }, 'secret-token');
  assert.equal(ok.status, 202);
  assert.equal((await call('/api/security/pause', { method: 'POST' })).status, 401);
  const noTokenApp = createApp({ db, operatorToken: '', defer: () => {} });
  assert.equal((await noTokenApp(new Request('http://x/api/security/pause', { method: 'POST', headers: { authorization: 'Bearer ' } }))).status, 401, 'empty configured token disables mutations');
  const raw = await call('/api/evidence/' + (await db.get('SELECT id FROM evidence LIMIT 1')).id + '?raw=1');
  assert.equal(raw.status, 401, 'raw bodies need the operator');
});

test('API: cron endpoint requires CRON_SECRET or operator', async () => {
  const db = await seeded();
  const app = createApp({ db, operatorToken: 'op', cronSecret: 'cron', defer: () => {} });
  assert.equal((await app(new Request('http://x/api/cron/tick'))).status, 401);
  assert.equal((await app(new Request('http://x/api/cron/tick', { headers: { authorization: 'Bearer nope' } }))).status, 401);
});

test('EVM verifier: deployer must equal the signer bound at approval; code must equal the attested bytecode', async () => {
  const { verifyEvmDeploy } = await import('../src/chains/evm.js');
  const CODE = '0x6080aa';
  const rpc = (from, code) => async (_u, init) => {
    const { method } = JSON.parse(init.body);
    const r = { eth_chainId: '0x14a34', eth_blockNumber: '0x10', eth_getTransactionReceipt: { status: '0x1', contractAddress: '0x' + '11'.repeat(20), from, blockNumber: '0x5' }, eth_getCode: code, eth_call: '0x' + [('cd'.repeat(20)).padStart(64, '0'), '0'.padStart(64, '0'), ('ee'.repeat(20)).padStart(64, '0'), '0'.padStart(64, '0'), (84532).toString(16).padStart(64, '0'), '0'.padStart(64, '0'), '0'.padStart(64, '0')].join('') }[method];
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: r }), { status: 200 });
  };
  const base = { rpc: 'https://sepolia.base.org', chainId: 84532, txHash: '0x' + 'ab'.repeat(32), expectedDeployedBytecode: CODE };
  const good = await verifyEvmDeploy({ ...base, expectedDeployer: '0x' + 'cd'.repeat(20), fetchImpl: rpc('0x' + 'cd'.repeat(20), CODE) });
  assert.equal(good.ok, true);
  const wrongSigner = await verifyEvmDeploy({ ...base, expectedDeployer: '0x' + 'cd'.repeat(20), fetchImpl: rpc('0x' + 'ee'.repeat(20), CODE) });
  assert.equal(wrongSigner.ok, false);
  const noSigner = await verifyEvmDeploy({ ...base, expectedDeployer: undefined, fetchImpl: rpc('0x' + 'cd'.repeat(20), CODE) });
  assert.equal(noSigner.ok, false, 'an unbound deployer can never verify');
  const wrongCode = await verifyEvmDeploy({ ...base, expectedDeployer: '0x' + 'cd'.repeat(20), fetchImpl: rpc('0x' + 'cd'.repeat(20), '0x6080bb') });
  assert.equal(wrongCode.ok, false);
  const wrongChain = await verifyEvmDeploy({ ...base, chainId: 1, expectedDeployer: '0x' + 'cd'.repeat(20), fetchImpl: rpc('0x' + 'cd'.repeat(20), CODE) });
  assert.equal(wrongChain.ok, false);
});

test('http client: oversized bodies are cut off while streaming', async () => {
  const { guardedFetch } = await import('../src/http-client.js');
  const big = new Response(new ReadableStream({ start(c) { for (let i = 0; i < 6; i++) c.enqueue(new Uint8Array(1_000_000).fill(97)); c.close(); } }), { status: 200 });
  await assert.rejects(guardedFetch('collector', 'https://api.github.com/x', { fetchImpl: async () => big }), /too large/);
});

test('API: evidence search treats LIKE wildcards literally', async () => {
  const db = await seeded();
  const app = createApp({ db, operatorToken: 't', defer: () => {} });
  const r = await (await app(new Request('http://x/api/evidence?q=' + encodeURIComponent('%')))).json();
  assert.equal(r.items.length, 0, 'a bare % must not match everything');
});

test('attestation: failing or unlinted builds are rejected (audit B-01)', async () => {
  const db = await memDb();
  await assert.rejects(recordAttestation(db, { ...FAKE_ATT, tests: { ...FAKE_ATT.tests, failed: 1 } }), (e) => e.code === 'attestation');
  await assert.rejects(recordAttestation(db, { ...FAKE_ATT, tests: { ...FAKE_ATT.tests, lint: false } }), (e) => e.code === 'attestation');
  await assert.rejects(recordAttestation(db, { ...FAKE_ATT, tests: { ...FAKE_ATT.tests, names: [] } }), (e) => e.code === 'attestation');
  assert.equal((await db.get("SELECT COUNT(*) n FROM artifacts WHERE kind LIKE 'contract-build%'")).n, 0);
});

test('monitor: least-recently-checked deployments are visited first (audit B-02)', async () => {
  const { monitorDeployments } = await import('../src/monitor.js');
  const db = await memDb();
  for (let i = 0; i < 7; i++) await db.run("INSERT INTO deployments VALUES(?,?,?,?,?,?,?,?,?,?)", [`dep_${i}`, `dec_${i}`, 'evm:84532', '0x' + '11'.repeat(20), 'ff'.repeat(32), `0x${i}`.padEnd(66, '0'), '', Date.now() - i, 'verified', '{}']);
  const seen = new Set();
  for (let round = 0; round < 3; round++) for (const r of await monitorDeployments(db, { fetchImpl: async () => { throw new TypeError('x'); } })) seen.add(r.id);
  assert.equal(seen.size, 7, 'every deployment gets checked within a few ticks');
});

test('receipt with an unknown/unqueryable tx is a clean verification failure, not a 500', async () => {
  const db = await seeded();
  await recordAttestation(db, FAKE_ATT);
  const { run } = await createRun(db, { opportunityId: 'opp_treasury', params: { chain: 'near-testnet', owner: 'op.testnet', contractAccount: 'reg.op.testnet' } });
  await executeRun(db, run.id, { fetchImpl: offline });
  const d = await db.get('SELECT * FROM decisions');
  await approveDecision(db, d.id, { nonce: d.nonce, payloadHash: d.payload_hash, confirm: `approve ${d.id}`, signer: 'op.testnet', actor: 'op' });
  const rpcErr = async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'Server error', data: 'Transaction not found' } }), { status: 200 });
  const r = await recordDeployment(db, d.id, { txHash: base58(createHash('sha256').update('nope').digest()), fetchImpl: rpcErr });
  assert.equal(r.recorded, false); assert.match(JSON.stringify(r.verification.checks), /not found/);
  assert.equal((await getDecision(db, d.id)).status, 'approved', 'decision stays approved and retryable');
});
