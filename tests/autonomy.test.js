// Autonomy loop: every hard rule enforced in code, each with a named test. Gate tests are offline (no RPC may be touched); the cycle tests drive the REAL
// loop against a LOCAL anvil (31337, started and stopped here): real AgentVault bytecode from dist, real ProposalRegistry, real signing through src/agent.
// NOT a public testnet, NOT NEAR: nothing here says anything about live networks, real gas prices, reorgs or the Workers runtime.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { autonomyTick, HARD_MAX_FEE_PER_TX } from '../src/autonomy.js';
import { autonomyEnabled, autonomyMaxPerDay, AUTONOMY_HARD_MAX_PER_DAY } from '../src/config.js';
import { setPaused } from '../src/orchestrator/coordinator.js';
import { getDecision, approveDecision, approveUnderMandate, recordDeployment } from '../src/decisions.js';
import { monitorDeployments } from '../src/monitor.js';
import { vaultId, getVault, getLoop, pauseLoop, blockLoop, verifyLedgerChain, registerAdapter, unregisterAdapter } from '../src/vault/index.js';
import { adapter as evm, encodeVaultCall, predictCreate2, saltForDecision } from '../src/vault/evm.js';
import { verifyAuditChain } from '../src/db.js';
import { getMode, setMode } from '../src/autonomy-mode.js';
import { selector } from '../src/agent/evm-signer.js';
import { topUpConfig } from '../src/autonomy.js';
import {
  haveAnvil, startAnvil, makeWorld, sendAs, seededDb, pendingDecision, tempKeystore, apiClient, offline, ADDR, ETH, REG_ART, REG_OWNER, REG_PROPOSER, MANDATE, KEY,
} from './vault-helpers.js';
import { createApp } from '../src/app.js';

const require = createRequire(new URL('../web/package.json', import.meta.url));
let viem = null;
try { viem = require('viem'); } catch { /* optional */ }
const ENV_ON = { AUTONOMY_ENABLED: '1', AUTONOMY_MAX_PER_DAY: '5' };
const AGENT_ADDR = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const VAULT_ADDR = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

// ------------------------------------------------------------------ rule (a): gates, offline
describe('rule (a): the loop does nothing unless every gate is open (no RPC is touched)', () => {
  async function gateWorld(over = {}) {
    const { db } = await seededDb();
    const keys = tempKeystore();
    await db.run("INSERT INTO kv(k,v) VALUES('autonomy.mode',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [over.mode ?? 'auto']);
    const chainId = over.chainId ?? 'evm:31337';
    const id = vaultId(chainId, VAULT_ADDR);
    await db.run('INSERT INTO vaults(id,chain_id,address,owner,agent,attested_ref,status,mandate_decision_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      [id, chainId, VAULT_ADDR, ADDR.owner, over.agent ?? keys.ks.publicView().evm.address, 'x', over.status ?? 'active', 'dec_grant', Date.now()]);
    const d = chainId.startsWith('evm') ? await pendingDecision(db, { chain: chainId.startsWith('evm:31337') ? chainId : 'evm:31337' }) : null;
    let rpc = 0;
    const fetchImpl = async () => { rpc += 1; throw new Error('RPC must not be called'); };
    const run = (extra = {}) => autonomyTick(db, { keystore: keys.ks, signingSupported: true, fetchImpl, env: ENV_ON, ...extra });
    const ledger = async () => (await db.all('SELECT kind,status,detail,vault_id FROM vault_ledger ORDER BY id'));
    const untouched = async () => {
      assert.equal(rpc, 0, 'no RPC call');
      assert.equal((await db.get('SELECT COUNT(*) n FROM mandate_runs')).n, 0, 'no mandate run');
      if (d) assert.equal((await getDecision(db, d.id)).status, 'pending', 'decision untouched');
    };
    return { db, keys, id, d, run, ledger, untouched, getRpc: () => rpc };
  }

  test('AUTONOMY_ENABLED defaults OFF: config helper, tick, and CLI-visible report', async () => {
    assert.equal(autonomyEnabled({}), false); assert.equal(autonomyEnabled({ AUTONOMY_ENABLED: '0' }), false); assert.equal(autonomyEnabled({ AUTONOMY_ENABLED: '' }), false);
    assert.equal(autonomyEnabled({ AUTONOMY_ENABLED: 'yes' }), false, 'only exactly 1/true switches it on');
    assert.equal(autonomyEnabled({ AUTONOMY_ENABLED: '1' }), true);
    const w = await gateWorld();
    const r = await w.run({ env: {} });
    assert.equal(r.ran, false); assert.match(r.skipped, /AUTONOMY_ENABLED is off/);
    await w.untouched();
    const app = createApp({ db: w.db, operatorToken: 't', defer: () => {}, fetchImpl: offline });
    assert.equal((await (await app(new Request('http://t/api/vault'))).json()).enabled, process.env.AUTONOMY_ENABLED === '1' || process.env.AUTONOMY_ENABLED === 'true');
    assert.equal(autonomyMaxPerDay({}), 5); assert.equal(autonomyMaxPerDay({ AUTONOMY_MAX_PER_DAY: '9999' }), AUTONOMY_HARD_MAX_PER_DAY); assert.equal(autonomyMaxPerDay({ AUTONOMY_MAX_PER_DAY: 'x' }), 5);
    w.keys.cleanup();
  });
  test('kill switch engaged: refuses, ledgers it once, touches nothing; releasing it re-opens the gate', async () => {
    const w = await gateWorld();
    await setPaused(w.db, true, 'test');
    const r = await w.run();
    assert.equal(r.ran, false); assert.match(r.skipped, /kill switch/);
    await w.run(); // identical refusal is not ledgered twice
    const l = (await w.ledger()).filter((x) => x.kind === 'refused');
    assert.equal(l.length, 1); assert.match(l[0].detail, /kill switch engaged/); assert.equal(l[0].status, 'refused');
    await w.untouched();
    await setPaused(w.db, false, 'test');
    await w.run().catch(() => {}); // gate open: it now tries to read the (unreachable) chain and refuses for THAT reason
    assert.ok(w.getRpc() > 0, 'with the kill switch released the loop proceeds to the chain');
    w.keys.cleanup();
  });
  test('loop paused or blocked by an operator/anomaly: no action; blocked survives a pause attempt', async () => {
    const w = await gateWorld();
    await pauseLoop(w.db);
    assert.match((await w.run()).skipped, /loop paused/);
    await w.untouched();
    await w.db.run("DELETE FROM kv WHERE k='vault:loop'");
    await blockLoop(w.db, 'unit-test anomaly');
    assert.match((await w.run()).skipped, /loop blocked: unit-test anomaly/);
    await pauseLoop(w.db);
    assert.equal((await getLoop(w.db)).state, 'blocked');
    await w.untouched();
    w.keys.cleanup();
  });
  test('signing unsupported (Worker runtime / no keystore): read-only, ledgered, no RPC', async () => {
    const w = await gateWorld();
    const r = await w.run({ signingSupported: false });
    assert.equal(r.ran, false); assert.match(r.skipped, /signing is not supported/);
    assert.match((await w.run({ keystore: null })).skipped, /signing is not supported/);
    assert.ok((await w.ledger()).some((x) => x.kind === 'refused' && /signing is not supported/.test(x.detail)));
    await w.untouched();
    w.keys.cleanup();
  });
  test('mainnet / unknown chain vault: refused before any RPC, even if a row exists', async () => {
    for (const chainId of ['evm:1', 'near-mainnet', 'evm:99999', 'solana:devnet']) {
      const w = await gateWorld({ chainId });
      const r = await w.run();
      assert.ok(r.vaults?.[0]?.refused, chainId);
      const l = await w.ledger();
      assert.ok(l.some((x) => x.kind === 'refused' && /mainnet or unknown/.test(x.detail)), `${chainId}: ${JSON.stringify(l)}`);
      assert.equal(w.getRpc(), 0, `${chainId}: no RPC`);
      w.keys.cleanup();
    }
  });
  test('an agent key that is not the mandate-bound agent is refused; an incomplete adapter is refused (fail closed)', async () => {
    const w = await gateWorld({ agent: AGENT_ADDR });
    await w.run();
    assert.ok((await w.ledger()).some((x) => /different agent/.test(x.detail)));
    await w.untouched();
    w.keys.cleanup();
    const w2 = await gateWorld({ chainId: 'near-testnet', agent: 'agent.testnet' });
    registerAdapter('near', { chain: 'near', readState: async () => ({}), verifyVaultCode: async () => ({ ok: true, checks: [] }) });
    try { await w2.run(); assert.ok((await w2.ledger()).some((x) => /incomplete/.test(x.detail)), JSON.stringify(await w2.ledger())); } finally { unregisterAdapter('near'); }
    assert.equal(w2.getRpc(), 0);
    w2.keys.cleanup();
  });
  test('rule (h) reconcile: stale `claimed` and hash-less `submitted` runs are released to the humans, never left in flight (offline)', async () => {
    const w = await gateWorld();
    const vault = await getVault(w.db, w.id);
    await approveUnderMandate(w.db, w.d.id, { vault, epoch: 1 });
    await w.db.run("UPDATE mandate_runs SET created_at=? WHERE decision_id=?", [Date.now() - 10 * 60_000, w.d.id]);
    await w.run();
    let dec = await getDecision(w.db, w.d.id);
    assert.equal(dec.status, 'pending'); assert.equal(dec.approver, null);
    assert.equal((await w.db.get('SELECT status FROM mandate_runs WHERE decision_id=?', [w.d.id])).status, 'failed');
    assert.ok((await w.ledger()).some((x) => /stale claim released/.test(x.detail)));
    const d2 = await pendingDecision(w.db);
    await approveUnderMandate(w.db, d2.id, { vault, epoch: 1 });
    await w.db.run("UPDATE mandate_runs SET status='submitted', created_at=? WHERE decision_id=?", [Date.now() - 2 * 3600_000, d2.id]);
    await w.run();
    dec = await getDecision(w.db, d2.id);
    assert.equal(dec.status, 'pending');
    assert.ok((await w.ledger()).some((x) => x.kind === 'deploy' && x.status === 'failed' && /no tx hash|without a recorded tx hash/.test(x.detail)));
    assert.equal((await w.db.get("SELECT COUNT(*) n FROM mandate_runs WHERE status IN ('claimed','submitted')")).n, 0);
    w.keys.cleanup();
  });
  test('compiled-in fee ceilings exist for both chains', () => {
    assert.ok(HARD_MAX_FEE_PER_TX.evm > 0n && HARD_MAX_FEE_PER_TX.near > 0n);
  });
});

// ------------------------------------------------------------------ the live cycle against a local anvil
describe('autonomous cycle on a LOCAL anvil (31337)', { skip: !haveAnvil && 'anvil not installed (~/.foundry/bin)' }, () => {
  let anvil;
  before(async () => { anvil = await startAnvil(); });
  after(() => { anvil?.stop(); });

  const ledgerOf = async (w) => (await w.ledger()).items;
  const refusals = async (w, re) => (await ledgerOf(w)).filter((x) => x.kind === 'refused' && x.status === 'refused' && re.test(x.detail));
  const noDeploy = async (w, decisionIds) => {
    assert.equal((await w.db.get('SELECT COUNT(*) n FROM deployments')).n, 0, 'nothing deployed');
    for (const id of decisionIds) assert.equal((await getDecision(w.db, id)).status, 'pending', 'decision left pending for a human');
    assert.equal((await w.db.get("SELECT COUNT(*) n FROM decisions WHERE status='executing'")).n, 0, 'nothing stuck executing');
  };
  const ethCall = async (to, data) => anvil.raw('eth_call', [{ to, data }, 'latest']);
  const ownerTx = (w, name, args) => sendAs(anvil, 'owner', { to: w.vault, data: Buffer.from(encodeVaultCall(name, args)).toString('hex').replace(/^/, '0x') });

  test('rule (b): activation happens only after the on-chain mandate equals the approved grant, field by field', async () => {
    const w = await makeWorld(anvil, { skipPlan: true });
    const planTx = w.plan.steps.filter((s) => s.who === 'human' && s.tx);
    const attach = async () => (await w.api('/api/vault/attach', { method: 'POST', body: { chainId: 'evm:31337', address: w.vault } })).json.activation;
    const status = async () => (await getVault(w.db, w.vaultId)).status;
    const decision = await w.newDecision();
    // 1) nothing installed on-chain yet
    let a = await attach();
    assert.equal(a.activated, false); assert.ok(a.checks.some((c) => !c.ok && /mandate is installed/.test(c.name)));
    assert.equal(await status(), 'attached');
    // the loop has an active-vault gate: an attached (not active) vault is never acted on, even with a pending decision and the loop enabled
    const r0 = await w.tick(); assert.equal(r0.vaults.length, 0);
    await noDeploy(w, [decision.id]);
    // 2) mandate present but the template is not allowlisted
    const [allow, setM] = planTx;
    await sendAs(anvil, 'owner', { to: setM.tx.to, data: setM.tx.data });
    a = await attach(); assert.equal(a.activated, false); assert.ok(a.checks.some((c) => !c.ok && /allowlisted on-chain/.test(c.name)));
    // 3) every approved mandate field, flipped one at a time on-chain, blocks activation
    const p = w.grant.payload.mandate; const agent = w.agent;
    const base = [agent, BigInt(p.expiresAt), BigInt(p.perDrawCap), BigInt(p.periodSecs), BigInt(p.periodCap), BigInt(p.totalCap), BigInt(p.maxDeploys)];
    await sendAs(anvil, 'owner', { to: allow.tx.to, data: allow.tx.data });
    const fields = ['agent', 'expiresAt', 'perDrawCap', 'periodSecs', 'periodCap', 'totalCap', 'maxDeploys'];
    for (let i = 1; i < base.length; i += 1) {
      const args = [...base];
      args[i] = i === 1 ? args[i] - 100n : i === 2 ? args[i] - 1n : i === 3 ? args[i] + 60n : i === 4 ? args[i] + 1n : i === 5 ? args[i] + 1n : args[i] - 1n;
      await ownerTx(w, 'setMandate', args);
      a = await attach();
      assert.equal(a.activated, false, `${fields[i]} differs`); assert.ok(a.checks.some((c) => !c.ok && c.name.includes(fields[i])), `${fields[i]} flagged: ${JSON.stringify(a.checks.filter((c) => !c.ok))}`);
      assert.equal(await status(), 'attached');
    }
    await ownerTx(w, 'setMandate', [ADDR.other, ...base.slice(1)]);
    a = await attach(); assert.equal(a.activated, false); assert.ok(a.checks.some((c) => !c.ok && /agent/.test(c.name)), 'wrong agent');
    // 4) the exact approved mandate: activates; the grant decision is executed
    await sendAs(anvil, 'owner', { to: setM.tx.to, data: setM.tx.data });
    a = await attach(); assert.equal(a.activated, true, JSON.stringify(a));
    assert.equal(await status(), 'active'); assert.equal((await getDecision(w.db, w.grant.id)).status, 'executed');
    assert.equal((await getVault(w.db, w.vaultId)).mandate_decision_id, w.grant.id);
    assert.ok((await ledgerOf(w)).some((x) => x.kind === 'activate' && x.status === 'confirmed'));
    w.cleanup();
  });

  test('attach refuses a contract whose code is not the attested AgentVault build', async () => {
    const w = await makeWorld(anvil, { skipPlan: true });
    const other = await (await import('./vault-helpers.js')).deployVault(anvil);
    await anvil.raw('anvil_setCode', [other, '0x6080604052348015600e575f80fd5b00']);
    const r = await w.api('/api/vault/attach', { method: 'POST', body: { chainId: 'evm:31337', address: other } });
    assert.equal(r.status, 400); assert.equal(r.json.code, 'vault_code');
    w.cleanup();
  });

  describe('happy path: two decisions, two vault deploys, monitor green, no secret anywhere', () => {
    let w; let d1; let d2; let drawn = 0n;
    before(async () => { w = await makeWorld(anvil); });
    after(() => w?.cleanup());

    test('world is active and the plan steps executed verbatim', () => {
      assert.equal(w.activation.activation.activated, true);
    });

    test('decision 1: agent draws gas, deploys the registry THROUGH the vault, backend verifies and records it', async () => {
      d1 = await w.newDecision();
      // independent estimate of the deploy/draw worst-case fees BEFORE the loop acts (rule g bound below)
      const net = { id: 'evm:31337', rpc: 'http://127.0.0.1:8545', chainId: 31337 };
      const exp0 = evm.expectedTemplate({ manifest: JSON.parse((await w.db.get("SELECT body FROM blobs WHERE ref=(SELECT immutable_ref FROM artifacts WHERE kind='contract-build:evm')")).body), payload: d1.payload ? JSON.parse(d1.payload) : {} });
      const tgt = evm.deployTarget({ decision: d1, vault: w.vault, expected: exp0 });
      const worstDeploy = (await evm.estimateFee({ net, vault: w.vault, agent: w.agent, call: evm.buildCall('deploy', { vault: w.vault, template: exp0.templateId, code: exp0.code, nameOrSalt: tgt.nameOrSalt }), fetchImpl: anvil.baseFetch })).worstCaseFee;
      const worstDraw = (await evm.estimateFee({ net, vault: w.vault, agent: w.agent, call: evm.buildCall('draw', { vault: w.vault, amount: 1n }), fetchImpl: anvil.baseFetch })).worstCaseFee;
      const balBefore = BigInt(await anvil.raw('eth_getBalance', [w.agent, 'latest']));
      const r = await w.tick();
      assert.deepEqual(r.vaults[0].done, [d1.id], JSON.stringify(r));
      const dec = await getDecision(w.db, d1.id);
      assert.equal(dec.status, 'executed');
      assert.match(dec.approver, new RegExp(`^mandate:${w.vaultId}:1$`)); assert.equal(dec.bound_signer.toLowerCase(), w.vault.toLowerCase());
      assert.equal(dec.approval.humanSigned, false); assert.equal(dec.approval.mode, 'mandate');
      assert.equal((await w.db.get('SELECT status FROM mandate_runs WHERE decision_id=?', [d1.id])).status, 'confirmed');
      const dep = dec.deployment; assert.ok(dep); assert.equal(dep.status, 'verified_local');
      assert.equal(dep.verification.via.humanSigned, false);
      assert.ok(dep.verification.checks.every((c) => c.ok), JSON.stringify(dep.verification.checks.filter((c) => !c.ok)));
      // on-chain: exactly the attested registry code, owned by the owner-fixed addresses (the agent never chose them)
      assert.equal((await anvil.raw('eth_getCode', [dep.account, 'latest'])).toLowerCase(), REG_ART.deployedBytecode.toLowerCase());
      const cfg = (await ethCall(dep.account, '0x79502c55')).slice(2);
      assert.equal('0x' + cfg.slice(24, 64), REG_OWNER.toLowerCase()); assert.equal('0x' + cfg.slice(2 * 64 + 24, 3 * 64), REG_PROPOSER.toLowerCase());
      // rule (d): local CREATE2 / templateId == the chain's own predictAddress / templateIdOf
      const exp = evm.expectedTemplate({ manifest: { ...(JSON.parse((await w.db.get("SELECT body FROM blobs WHERE ref=(SELECT immutable_ref FROM artifacts WHERE kind='contract-build:evm')")).body)) }, payload: dec.payload });
      const salt = saltForDecision(d1.id);
      const viaChain = await ethCall(w.vault, '0x' + Buffer.from(encodeVaultCall('predictAddress', [exp.templateId, salt])).toString('hex'));
      assert.equal('0x' + viaChain.slice(-40), dep.account.toLowerCase(), 'vault.predictAddress == the address the vault really deployed to');
      assert.equal(predictCreate2(w.vault, salt, exp.templateId).toLowerCase(), dep.account.toLowerCase(), 'local CREATE2 prediction == real anvil CREATE2 address');
      const idOnChain = await ethCall(w.vault, '0x' + Buffer.from(encodeVaultCall('templateIdOf', [exp.code])).toString('hex'));
      assert.equal(idOnChain, exp.templateId, 'vault.templateIdOf(initcode) == locally recomputed templateId');
      if (viem) assert.equal(exp.templateId, viem.keccak256('0x' + Buffer.from(exp.code).toString('hex')));
      // ledger: approval, draw (rule g), deploy, all confirmed and hash-chained
      const items = await ledgerOf(w);
      const draw = items.find((x) => x.kind === 'draw'); assert.ok(draw, 'the agent was funded by a vault draw');
      assert.equal(draw.status, 'confirmed'); assert.ok(draw.txHash);
      drawn += BigInt(draw.amount);
      assert.ok(BigInt(draw.amount) > 0n && BigInt(draw.amount) <= BigInt(MANDATE.perDrawCap), 'inside the per-draw cap');
      // rule (g): the draw is the minimum for 3x the deploy fee headroom, i.e. bounded by 3x worst-case deploy fee + the draw tx fee, never "as much as allowed"
      assert.ok(BigInt(draw.amount) < BigInt(MANDATE.perDrawCap) / 2n, `drew ${draw.amount}, far below the per-draw cap ${MANDATE.perDrawCap}`);
      const A = BigInt(draw.amount); const slack = (x) => (x * 125n) / 100n; // fees drift a little between my estimate and the loop's
      assert.ok(A <= slack(3n * worstDeploy) + slack(worstDraw), `never more than 3x the deploy fee + the draw's own fee: drew ${A}, 3x deploy ${3n * worstDeploy}, draw fee ${worstDraw}`);
      assert.ok(A + balBefore >= (3n * worstDeploy * 75n) / 100n, `it did draw enough to reach ~3x headroom (drew ${A}, had ${balBefore}, 3x deploy ${3n * worstDeploy})`);
      const dp = items.find((x) => x.kind === 'deploy'); assert.equal(dp.status, 'confirmed'); assert.equal(dp.decisionId, d1.id);
      assert.ok(items.some((x) => x.kind === 'loop' && /approved under mandate/.test(x.detail) && /no human signs/.test(x.detail)));
      assert.equal((await w.ledger()).chainOk, true);
      assert.ok(dp.explorerUrl === '' || dp.explorerUrl.includes(dp.txHash), 'local chain has no explorer');
      // the chain's own accounting agrees with the ledger
      const u = (await w.api('/api/vault')).json.vaults[0];
      assert.equal(u.usage.totalSpent, drawn.toString()); assert.equal(u.usage.deploys, 1);
    });

    test('monitor passes for the deployment AND the vault', async () => {
      const res = await monitorDeployments(w.db, { fetchImpl: anvil.baseFetch });
      assert.ok(res.length >= 2, JSON.stringify(res));
      for (const r of res) assert.equal(r.ok, true, `${r.id}: ${JSON.stringify(r.checks?.filter((c) => !c.ok) ?? r.error)}`);
      assert.ok(res.some((r) => r.id.startsWith('vault:')));
    });

    test('decision 2: a second vault deploy (new salt, new address), budget accounting follows the chain', async () => {
      d2 = await w.newDecision();
      const r = await w.tick();
      assert.deepEqual(r.vaults[0].done, [d2.id], JSON.stringify(r));
      const a1 = (await getDecision(w.db, d1.id)).deployment.account; const a2 = (await getDecision(w.db, d2.id)).deployment.account;
      assert.notEqual(a1, a2);
      for (const l of (await ledgerOf(w)).filter((x) => x.kind === 'draw' && x.decisionId === d2.id)) drawn += BigInt(l.amount);
      const v = (await w.api('/api/vault')).json.vaults[0];
      assert.equal(v.usage.deploys, 2); assert.equal(v.budget.remainingDeploys, '1'); assert.equal(v.usage.totalSpent, drawn.toString());
      assert.equal(BigInt(v.budget.remainingTotal), BigInt(MANDATE.totalCap) - drawn);
      assert.equal(v.status, 'active'); assert.equal(v.codeOk, true); assert.equal(v.mandateDecisionId, w.grant.id);
      assert.deepEqual(v.templates.map((t) => [t.matches, t.artifactHash]), [[true, w.artifactHash]]);
      assert.equal((await w.api('/api/vault')).json.loop.usedToday, 2);
      assert.equal((await w.api('/api/vault')).json.loop.state, 'idle');
    });

    test('rule (e): one agent execution per decision — an executed or failed decision is never run twice', async () => {
      const before = (await ledgerOf(w)).length;
      const r = await w.tick();
      assert.deepEqual(r.vaults[0].idle ?? true, true, 'nothing pending: the loop stays idle');
      assert.equal((await ledgerOf(w)).length, before, 'an idle tick writes nothing');
      assert.equal((await w.db.get('SELECT COUNT(*) n FROM mandate_runs WHERE decision_id=?', [d1.id])).n, 1);
      const vrow = await getVault(w.db, w.vaultId);
      await assert.rejects(approveUnderMandate(w.db, d1.id, { vault: vrow, epoch: 1 }), (e) => e.code === 'state');
    });

    test('crash recovery: a decision left `executing` (process died inside recordDeployment) is recovered by the next tick, never stuck', async () => {
      const dep = await w.db.get('SELECT * FROM deployments WHERE decision_id=?', [d2.id]);
      await w.db.run('DELETE FROM deployments WHERE id=?', [dep.id]);
      await w.db.run("UPDATE decisions SET status='executing', decided_at=? WHERE id=?", [Date.now() - 10 * 60_000, d2.id]);
      await w.db.run("UPDATE mandate_runs SET status='submitted', tx_hash=?, created_at=? WHERE decision_id=?", [dep.transaction_hash, Date.now() - 60_000, d2.id]);
      await w.tick();
      assert.equal((await getDecision(w.db, d2.id)).status, 'executed');
      assert.equal((await w.db.get('SELECT status FROM mandate_runs WHERE decision_id=?', [d2.id])).status, 'confirmed');
      assert.ok((await ledgerOf(w)).some((x) => x.kind === 'deploy' && /reconciled/.test(x.detail)));
    });

    test('rule (i): no private key, key-file contents or signer internals appear in API output, ledger, audit, decisions or logs', async () => {
      const priv = w.keys.privateKeyHex(); const needles = [priv, priv.slice(2), priv.toUpperCase().slice(2)];
      const blobs = [];
      for (const path of ['/api/vault', '/api/vault/ledger?limit=200', `/api/vault/plan?decisionId=${w.grant.id}`, '/api/security', '/api/decisions', '/api/deployments', '/api/status']) blobs.push([path, (await w.api(path)).text]);
      blobs.push(['audit table', JSON.stringify(await w.db.all('SELECT * FROM audit'))]);
      blobs.push(['ledger table', JSON.stringify(await w.db.all('SELECT * FROM vault_ledger'))]);
      blobs.push(['vaults table', JSON.stringify(await w.db.all('SELECT * FROM vaults'))]);
      blobs.push(['kv', JSON.stringify(await w.db.all('SELECT * FROM kv'))]);
      for (const [name, text] of blobs) for (const n of needles) assert.ok(!text.toLowerCase().includes(n.toLowerCase()), `key hex found in ${name}`);
      assert.ok(!JSON.stringify(blobs).includes(w.keys.path), 'key file path never published');
      assert.equal((await verifyAuditChain(w.db)).ok, true);
      assert.equal((await verifyLedgerChain(w.db)).ok, true);
    });
  });

  // ---------------------------------------------------------------- mode + rule (j): gas top-up
  describe('manual/auto mode and rule (j) gas top-up', () => {
    const balanceOf = async (addr) => BigInt(await anvil.raw('eth_getBalance', [addr, 'latest']));
    const topups = async (w) => (await ledgerOf(w)).filter((x) => x.kind === 'draw' && /^top-up/.test(x.detail));
    const lowGas = async (w) => { await anvil.raw('anvil_setBalance', [w.agent, '0x38d7ea4c68000']); return w; }; // 0.001 ETH: below the 0.003 low-water mark (the shared anvil reuses one agent key, so set it explicitly)
    const LOW = 3_000_000_000_000_000n; const TARGET = 10_000_000_000_000_000n;

    test('default mode is manual; setMode audits the change and rejects junk', async () => {
      const { db } = await seededDb();
      assert.equal(await getMode(db), 'manual');
      await setMode(db, 'auto', 'owner:0xabc'); assert.equal(await getMode(db), 'auto');
      assert.equal((await db.get("SELECT COUNT(*) n FROM audit WHERE action='autonomy.mode'")).n, 1);
      await assert.rejects(setMode(db, 'yolo'), (e) => e.code === 'input');
      assert.equal(await getMode(db), 'auto');
    });
    test('top-up band: env overrides are bounded and target stays above low-water', () => {
      assert.deepEqual(topUpConfig({}, 'evm'), { low: LOW, target: TARGET });
      assert.equal(topUpConfig({ AUTONOMY_TOPUP_LOW: '100', AUTONOMY_TOPUP_TARGET: '50' }, 'evm').target, 300n);
      assert.deepEqual(topUpConfig({ AUTONOMY_TOPUP_LOW: 'junk' }, 'evm'), { low: LOW, target: TARGET });
    });
    test('manual mode never executes a pending deploy and never tops up', async () => {
      const w = await makeWorld(anvil, { mode: 'manual' }); const d = await w.newDecision();
      const bal = await balanceOf(w.agent);
      const r = await w.tick();
      assert.equal(r.vaults[0].manual, true);
      await noDeploy(w, [d.id]);
      assert.equal(await balanceOf(w.agent), bal, 'no transaction was sent');
      assert.equal((await ledgerOf(w)).filter((x) => x.kind === 'draw').length, 0);
      w.cleanup();
    });
    test('auto mode tops up when the balance is below low-water, once, up to the target', async () => {
      const w = await lowGas(await makeWorld(anvil));
      const r = await w.tick();
      assert.equal(r.vaults[0].idle, true); assert.ok(r.vaults[0].toppedUp, JSON.stringify(r));
      const t = await topups(w); assert.equal(t.length, 1); assert.equal(t[0].status, 'confirmed'); assert.ok(t[0].txHash);
      const bal = await balanceOf(w.agent);
      assert.ok(bal >= LOW && bal <= TARGET, `balance ${bal} inside the band`);
      const r2 = await w.tick(); assert.equal(r2.vaults[0].toppedUp, undefined, 'balance is above low-water: nothing more to do');
      assert.equal((await topups(w)).length, 1);
      w.cleanup();
    });
    test('top-up is capped by the per-draw cap and the remaining budget', async () => {
      const w = await lowGas(await makeWorld(anvil, { mandate: { perDrawCap: '2000000000000000', periodCap: '2500000000000000', totalCap: '2500000000000000' } }));
      await w.tick();
      const t = await topups(w); assert.equal(t.length, 1);
      assert.ok(BigInt(t[0].amount) <= 2_000_000_000_000_000n, `drew ${t[0].amount} <= per-draw cap`);
      const v = (await w.api('/api/vault')).json.vaults[0];
      assert.ok(BigInt(v.budget.remainingTotal) >= 0n);
      w.cleanup();
    });
    test('no top-up while the vault is paused, the loop is paused, or the kill switch is engaged', async () => {
      const w = await lowGas(await makeWorld(anvil));
      await ownerTx(w, 'pause', []);
      await w.tick(); assert.equal((await topups(w)).length, 0, 'vault paused');
      await ownerTx(w, 'unpause', []);
      await pauseLoop(w.db, 'test'); await w.tick(); assert.equal((await topups(w)).length, 0, 'loop paused');
      await w.api('/api/vault/loop/resume', { method: 'POST' });
      await setPaused(w.db, true, 'test'); await w.tick(); assert.equal((await topups(w)).length, 0, 'kill switch');
      await setPaused(w.db, false, 'test');
      const r = await w.tick(); assert.ok(r.vaults[0].toppedUp, 'everything open again: the top-up happens');
      w.cleanup();
    });
    test('no second top-up while the first claim is fresh; a crash after the claim never repeats the draw; a stale claim allows a retry', async () => {
      const w = await lowGas(await makeWorld(anvil));
      await w.db.run('INSERT INTO kv(k,v) VALUES(?,?)', [`topup:${w.vaultId}`, JSON.stringify({ status: 'claimed', at: Date.now() })]); // process died right after claiming
      await w.tick(); assert.equal((await topups(w)).length, 0, 'fresh claim: wait');
      await w.db.run('UPDATE kv SET v=? WHERE k=?', [JSON.stringify({ status: 'claimed', at: Date.now() - 31 * 60_000 }), `topup:${w.vaultId}`]);
      await w.tick(); assert.equal((await topups(w)).length, 1, 'stale claim: one retry');
      await anvil.raw('anvil_setBalance', [w.agent, '0x1000000000000']); // low again straight away
      await w.tick(); assert.equal((await topups(w)).length, 1, 'the retry holds a fresh claim again: no second draw');
      w.cleanup();
    });
    test('a stale submitted claim is settled from the chain first: no hash -> the loop BLOCKS; a mined hash -> one more top-up may follow', async () => {
      const w = await lowGas(await makeWorld(anvil));
      await w.db.run('INSERT INTO kv(k,v) VALUES(?,?)', [`topup:${w.vaultId}`, JSON.stringify({ status: 'submitted', at: Date.now() - 31 * 60_000 })]); // died while sending, hash unknown
      const r = await w.tick();
      assert.equal(r.vaults[0].blocked, true, JSON.stringify(r)); assert.equal((await getLoop(w.db)).state, 'blocked'); assert.match((await getLoop(w.db)).reason, /outcome cannot be established/);
      assert.equal((await topups(w)).length, 0);
      w.cleanup();
      const w2 = await lowGas(await makeWorld(anvil));
      await w2.tick(); assert.equal((await topups(w2)).length, 1);
      const claim = JSON.parse((await w2.db.get('SELECT v FROM kv WHERE k=?', [`topup:${w2.vaultId}`])).v); assert.ok(claim.txHash, 'the claim kept the tx hash');
      await anvil.raw('anvil_setBalance', [w2.agent, '0x38d7ea4c68000']);
      await w2.db.run('UPDATE kv SET v=? WHERE k=?', [JSON.stringify({ ...claim, at: Date.now() - 31 * 60_000 }), `topup:${w2.vaultId}`]);
      await w2.tick(); assert.equal((await topups(w2)).length, 2, 'the earlier tx is mined, so the balance decides');
      w2.cleanup();
    });
    test('mode flipped to manual between the claim and the send aborts before signing', async () => {
      let armed = false; let sawEstimate = false; let flipped = false; let w;
      const f = async (u, init) => {
        const b = init?.body ? JSON.parse(init.body) : null;
        if (armed && b?.method === 'eth_estimateGas') sawEstimate = true;
        if (armed && sawEstimate && !flipped && b?.method === 'eth_call') { flipped = true; await setMode(w.db, 'manual', 'test'); }
        return anvil.baseFetch(u, init);
      };
      w = await lowGas(await makeWorld(anvil, { fetchImpl: f }));
      armed = true;
      const bal = await balanceOf(w.agent);
      await w.tick();
      assert.equal(flipped, true, 'the hook fired between estimate and claim');
      assert.equal((await topups(w)).length, 0); assert.equal(await balanceOf(w.agent), bal, 'nothing was signed or sent');
      w.cleanup();
    });
    test('top-up parity mismatch (chain says Paused, model says ok) blocks the loop and signs nothing', async () => {
      let tamper = false;
      const sel = Buffer.from(selector('previewDraw(uint256)')).toString('hex');
      const f = async (u, init) => {
        const b = init?.body ? JSON.parse(init.body) : null;
        if (tamper && b?.method === 'eth_call' && String(b.params?.[0]?.data).startsWith('0x' + sel)) return new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id ?? 1, result: '0x9e87fac8' + '00'.repeat(28) }), { status: 200 });
        return anvil.baseFetch(u, init);
      };
      const w = await lowGas(await makeWorld(anvil, { fetchImpl: f }));
      tamper = true;
      const r = await w.tick();
      assert.equal(r.vaults[0].blocked, true, JSON.stringify(r));
      assert.equal((await getLoop(w.db)).state, 'blocked');
      assert.equal((await topups(w)).length, 0);
      w.cleanup();
    });
  });

  // ---------------------------------------------------------------- negatives: each must REFUSE and LEDGER it
  describe('negative cases: refuse, ledger, change nothing', () => {
    test('over budget: the draw needed for gas exceeds the per-draw cap -> PerDrawCap, refused, nothing consumed', async () => {
      const w = await makeWorld(anvil, { mandate: { perDrawCap: '1000', periodCap: '2000', totalCap: '5000' }, fund: 5000n });
      const d = await w.newDecision();
      const r = await w.tick();
      assert.equal(r.vaults[0].refused, 'PerDrawCap');
      assert.equal((await refusals(w, /draw refused by vault rules: PerDrawCap/)).length, 1);
      await noDeploy(w, [d.id]);
      assert.equal((await w.db.get('SELECT COUNT(*) n FROM mandate_runs')).n, 0, 'a budget refusal never consumes the single execution');
      assert.equal((await ledgerOf(w)).filter((x) => x.kind === 'draw').length, 0);
      await w.tick(); assert.equal((await refusals(w, /PerDrawCap/)).length, 1, 'a persistent refusal is ledgered once, not every tick');
      w.cleanup();
    });
    test('revoked mandate: refused and ledgered; vault shows inactive', async () => {
      const w = await makeWorld(anvil); const d = await w.newDecision();
      await ownerTx(w, 'revoke', []);
      const r = await w.tick();
      assert.match(r.vaults[0].refused, /revoked/);
      assert.equal((await refusals(w, /revoked/)).length, 1); await noDeploy(w, [d.id]);
      assert.equal((await getVault(w.db, w.vaultId)).status, 'inactive');
      assert.equal((await w.api('/api/vault')).json.vaults[0].budget.blocked, 'MandateInactive');
      w.cleanup();
    });
    test('paused vault: refused and ledgered; unpausing resumes work', async () => {
      const w = await makeWorld(anvil); const d = await w.newDecision();
      await ownerTx(w, 'pause', []);
      await w.tick();
      assert.equal((await refusals(w, /paused/)).length, 1); await noDeploy(w, [d.id]);
      assert.equal((await w.api('/api/vault')).json.vaults[0].paused, true);
      await ownerTx(w, 'unpause', []);
      const r = await w.tick(); assert.deepEqual(r.vaults[0].done, [d.id]);
      w.cleanup();
    });
    test('rule (d): wrong owner / wrong proposer in the decision payload -> templateId not approved -> left for a human, never auto-approved', async () => {
      const w = await makeWorld(anvil);
      const badOwner = await w.newDecision({ owner: ADDR.other, proposer: REG_PROPOSER });
      const badProposer = await w.newDecision({ owner: REG_OWNER, proposer: ADDR.other });
      const r = await w.tick();
      assert.deepEqual(r.vaults[0].left.sort(), [badOwner.id, badProposer.id].sort());
      assert.equal((await refusals(w, /left for a human: locally recomputed template/)).length, 2);
      await noDeploy(w, [badOwner.id, badProposer.id]);
      assert.equal((await w.db.get('SELECT COUNT(*) n FROM mandate_runs')).n, 0);
      assert.equal((await ledgerOf(w)).filter((x) => x.kind === 'draw').length, 0, 'no gas was drawn for a decision the owner never approved');
      // and a human can still approve it the normal way
      const a = await approveDecision(w.db, badOwner.id, { nonce: badOwner.nonce, payloadHash: badOwner.payload_hash, confirm: `approve ${badOwner.id}`, signer: ADDR.other, actor: 'op' });
      assert.equal(a.approval.humanSigned, true);
      w.cleanup();
    });
    test('NEAR-style template check: id matches but the owner-stored init material differs (adapter.checkTemplate fails) -> left for a human, no draw, no claim', async () => {
      const w = await makeWorld(anvil); const d = await w.newDecision();
      const wrapped = { ...evm, checkTemplate: ({ expected }) => (!expected.code ? { ok: true, checks: [] } : { ok: false, checks: [{ name: 'on-chain init_args == approved init material (owner / proposer / network)', ok: false, detail: `swapped owner for ${expected.templateId.slice(0, 10)}` }] }) };
      registerAdapter('evm', wrapped);
      try {
        const r = await w.tick();
        assert.deepEqual(r.vaults[0].left, [d.id]);
      } finally { registerAdapter('evm', evm); }
      assert.equal((await refusals(w, /left for a human: on-chain template differs from the approved init material/)).length, 1);
      await noDeploy(w, [d.id]);
      assert.equal((await w.db.get('SELECT COUNT(*) n FROM mandate_runs')).n, 0); assert.equal((await ledgerOf(w)).filter((x) => x.kind === 'draw').length, 0);
      w.cleanup();
    });
    test('API surface for the console: per-field verification verdict, explorer links, agent-needs-seed health, seconds timestamps', async () => {
      const w = await makeWorld(anvil, { seed: 0n });
      let v = (await w.api('/api/vault')).json;
      assert.equal(v.vaults[0].verification.ok, true, JSON.stringify(v.vaults[0].verification.fields.filter((f) => !f.ok)));
      assert.ok(v.vaults[0].verification.fields.every((f) => 'name' in f && 'expected' in f && 'actual' in f && typeof f.ok === 'boolean'));
      assert.ok(v.vaults[0].verification.fields.some((f) => f.name === 'mandate.totalCap == approved' && f.expected === MANDATE.totalCap && f.actual === MANDATE.totalCap));
      assert.deepEqual(Object.keys(v.vaults[0].explorer).sort(), ['agent', 'owner', 'vault']);
      const live = (await w.api(`/api/vault/verify?decisionId=${w.grant.id}`, { auth: false })).json;
      assert.equal(live.ok, true); assert.equal(live.vaultId, w.vaultId);
      const seed = v.health.find((h) => h.name.startsWith('agent needs seed funding'));
      assert.ok(seed, 'health item exists'); assert.equal(typeof seed.ok, 'boolean');
      assert.ok(v.vaults[0].readAt < 1e11, 'seconds');
      const tick = await w.tick(); void tick;
      v = (await w.api('/api/vault')).json; assert.ok(v.loop.lastTickAt < 1e11);
      // tamper one field on-chain: the verdict flips and names the field
      const p = w.grant.payload.mandate;
      await ownerTx(w, 'setMandate', [w.agent, BigInt(p.expiresAt), BigInt(p.perDrawCap), BigInt(p.periodSecs), BigInt(p.periodCap), BigInt(p.totalCap) + 1n, BigInt(p.maxDeploys)]);
      const flipped = (await w.api(`/api/vault/verify?decisionId=${w.grant.id}`, { auth: false })).json; // forces a fresh read (GET /api/vault serves a <=15 s cache)
      assert.equal(flipped.ok, false); assert.ok(flipped.fields.some((f) => !f.ok && /totalCap/.test(f.name)));
      w.cleanup();
    });
    for (const mode of ['from the first tick', 'only after the first read passed (mid-flow)']) {
      test(`fail closed: the code check cannot run while state reads succeed (${mode}) -> ledgered refusal, ZERO signer calls, no claim, no anomaly, loop not blocked`, async () => {
        let sends = 0; let codeCalls = 0; let failing = false;
        const f = async (u, init) => {
          const b = init?.body ? JSON.parse(init.body) : null;
          if (b?.method === 'eth_sendRawTransaction') sends += 1;
          if (failing && b?.method === 'eth_getCode' && String(b.params?.[0]).toLowerCase() === w.vault.toLowerCase()) {
            codeCalls += 1;
            if (mode.startsWith('from') || codeCalls > 1) throw new TypeError('code check timed out');
          }
          return anvil.baseFetch(u, init);
        };
        var w = await makeWorld(anvil, { fetchImpl: f }); const d = await w.newDecision(); // eslint-disable-line no-var
        failing = true; const sendsBefore = sends;
        const r = await w.tick();
        assert.ok(r.vaults[0].refused, JSON.stringify(r));
        assert.equal(sends, sendsBefore, 'no transaction was signed or sent');
        assert.equal((await w.db.get('SELECT COUNT(*) n FROM mandate_runs')).n, 0, 'no claim');
        await noDeploy(w, [d.id]);
        assert.equal((await ledgerOf(w)).filter((x) => x.kind === 'anomaly').length, 0, 'an unverifiable check is not a positive mismatch: no anomaly');
        assert.notEqual((await getLoop(w.db)).state, 'blocked');
        assert.equal((await ledgerOf(w)).filter((x) => x.kind === 'draw').length, 0);
        assert.ok((await refusals(w, /unreadable|code check/)).length >= 1, JSON.stringify((await ledgerOf(w)).map((x) => [x.kind, x.detail])));
        failing = false;
        assert.deepEqual((await w.tick()).vaults[0].done, [d.id], 'once the check can run again the work proceeds');
        w.cleanup();
      });
    }
    test('an approved grant is NOT reusable after the owner resets the mandate: same fields, new epoch -> refused until a NEW grant is approved and activated', async () => {
      const w = await makeWorld(anvil); const d = await w.newDecision();
      const setM = w.plan.steps.find((s) => s.title === 'setMandate');
      await sendAs(anvil, 'owner', { to: setM.tx.to, data: setM.tx.data }); // identical fields, epoch 1 -> 2, usage reset on-chain
      const funded = BigInt(await anvil.raw('eth_getBalance', [w.agent, 'latest']));
      const r = await w.tick();
      assert.match(r.vaults[0].refused, /epoch/i);
      assert.equal((await refusals(w, /epoch changed.*new approved grant_mandate/i)).length, 1);
      assert.equal(BigInt(await anvil.raw('eth_getBalance', [w.agent, 'latest'])), funded, 'nothing drawn');
      assert.equal((await ledgerOf(w)).filter((x) => x.kind === 'draw' || x.kind === 'anomaly').length, 0);
      assert.equal((await w.db.get('SELECT COUNT(*) n FROM mandate_runs')).n, 0);
      await noDeploy(w, [d.id]);
      assert.notEqual((await getLoop(w.db)).state, 'blocked', 'no global block');
      assert.equal((await getVault(w.db, w.vaultId)).status, 'inactive');
      const ver = (await w.api(`/api/vault/verify?decisionId=${w.grant.id}`, { auth: false })).json;
      assert.equal(ver.ok, false); assert.ok(ver.fields.some((f) => !f.ok && /epoch changed: new approval required/.test(f.name + f.actual)), JSON.stringify(ver.fields.filter((f) => !f.ok)));
      // a NEW approved grant re-activates it
      const old = w.grant.payload;
      const prop = await w.api('/api/vault/mandates/propose', { method: 'POST', body: { chainId: 'evm:31337', vault: w.vault, mandate: { ...old.mandate }, templates: [{ artifactHash: w.artifactHash, owner: REG_OWNER, proposer: REG_PROPOSER }], fund: { amount: old.fund.amount }, loop: { maxPerDay: 5 } } });
      assert.equal(prop.status, 201, prop.text);
      const g2 = prop.json;
      assert.equal((await w.api(`/api/decisions/${g2.id}/approve`, { method: 'POST', body: { nonce: g2.nonce, payloadHash: g2.payload_hash, confirm: `approve ${g2.id}`, signer: ADDR.owner } })).status, 200);
      const att = (await w.api('/api/vault/attach', { method: 'POST', body: { chainId: 'evm:31337', address: w.vault } })).json;
      assert.equal(att.activation.activated, true, JSON.stringify(att));
      assert.equal((await getVault(w.db, w.vaultId)).mandate_decision_id, g2.id);
      const r2 = await w.tick();
      assert.deepEqual(r2.vaults[0].done, [d.id]);
      assert.match((await getDecision(w.db, d.id)).approver, new RegExp(`^mandate:${w.vaultId}:2$`));
      w.cleanup();
    });
    test('per-vault isolation: vault A\'s state RPC fails, vault B is still processed and executes; A gets ONE ledgered refusal (no anomaly, no block, no tick crash)', async () => {
      let failA = false; let aAddr = '';
      const f = async (u, init) => {
        const b = init?.body ? JSON.parse(init.body) : null;
        if (failA && b?.method === 'eth_call' && String(b.params?.[0]?.to).toLowerCase() === aAddr.toLowerCase()) throw new TypeError('state RPC down for vault A');
        return anvil.baseFetch(u, init);
      };
      const a = await makeWorld(anvil, { fetchImpl: f });
      aAddr = a.vault;
      const b = await makeWorld(anvil, { fetchImpl: f, db: a.db, keys: a.keys, artifactHash: a.artifactHash });
      assert.equal(b.activation.activation.activated, true);
      const d = await a.newDecision();
      failA = true;
      await a.db.run('UPDATE vaults SET last_state=NULL, last_read_at=NULL WHERE id=?', [a.vaultId]); // no cached state to fall back on: the read result carries NO state
      const r = await a.tick();
      assert.ok(!r.error, `tick must not crash: ${JSON.stringify(r)}`);
      const byId = Object.fromEntries(r.vaults.map((x) => [x.id, x]));
      assert.match(byId[a.vaultId].refused, /unreadable/);
      assert.deepEqual(byId[b.vaultId].done, [d.id], 'vault B was still processed');
      assert.equal((await getDecision(a.db, d.id)).status, 'executed');
      await a.tick();
      const refA = (await ledgerOf(a)).filter((x) => x.vaultId === a.vaultId && x.kind === 'refused' && /unreadable/.test(x.detail));
      assert.equal(refA.length, 1, 'ledgered once, not every tick');
      assert.equal((await ledgerOf(a)).filter((x) => x.kind === 'anomaly').length, 0);
      assert.notEqual((await getLoop(a.db)).state, 'blocked');
      a.cleanup();
    });
    test('rule (d): a template allowlisted on-chain is required too (owner removes it after activation -> drift, nothing deployed)', async () => {
      const w = await makeWorld(anvil); const d = await w.newDecision();
      const tid = w.grant.payload.templates[0].templateId;
      await ownerTx(w, 'disallowTemplate', [tid]);
      await w.tick();
      assert.equal((await refusals(w, /mandate drift/)).length + (await ledgerOf(w)).filter((x) => x.kind === 'anomaly').length > 0, true);
      await noDeploy(w, [d.id]);
      assert.equal((await getVault(w.db, w.vaultId)).status, 'drift');
      w.cleanup();
    });
    test('kill switch: nothing happens while it is engaged (live chain behind it), and it is ledgered', async () => {
      const w = await makeWorld(anvil); const d = await w.newDecision();
      const funded = BigInt(await anvil.raw('eth_getBalance', [w.agent, 'latest']));
      await setPaused(w.db, true, 'test');
      const r = await w.tick();
      assert.match(r.skipped, /kill switch/);
      assert.equal((await refusals(w, /kill switch engaged/)).length, 1); await noDeploy(w, [d.id]);
      assert.equal((await w.db.get('SELECT COUNT(*) n FROM mandate_runs')).n, 0);
      assert.equal(BigInt(await anvil.raw('eth_getBalance', [w.agent, 'latest'])), funded, 'the agent was not funded and sent nothing');
      await setPaused(w.db, false, 'test');
      assert.deepEqual((await w.tick()).vaults[0].done, [d.id]);
      w.cleanup();
    });
    test('rule (c): chain preview disagrees with the model (chain says Paused, model says ok) -> anomaly + loop BLOCKED; only an operator resume re-opens it', async () => {
      let tamper = false;
      const f = async (u, init) => {
        const b = init?.body ? JSON.parse(init.body) : null;
        if (tamper && b?.method === 'eth_call' && String(b.params?.[0]?.data).startsWith('0x04e7a876')) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x9e87fac8' + '00'.repeat(28) }), { status: 200 });
        return anvil.baseFetch(u, init);
      };
      const w = await makeWorld(anvil, { fetchImpl: f }); const d = await w.newDecision();
      tamper = true;
      const r = await w.tick();
      assert.equal(r.vaults[0].blocked, true);
      const loop = await getLoop(w.db);
      assert.equal(loop.state, 'blocked'); assert.match(loop.reason, /model\/chain preview mismatch on deploy: model says "ok", chain says "Paused"/);
      const an = (await ledgerOf(w)).filter((x) => x.kind === 'anomaly'); assert.equal(an.length, 1); assert.equal(an[0].status, 'failed');
      await noDeploy(w, [d.id]);
      assert.equal((await ledgerOf(w)).filter((x) => x.kind === 'draw').length, 0);
      tamper = false;
      assert.match((await w.tick()).skipped, /loop blocked/, 'honest chain again, but still blocked until an operator resumes');
      await noDeploy(w, [d.id]);
      assert.equal((await w.api('/api/vault')).json.loop.state, 'blocked');
      assert.equal((await w.api('/api/vault/loop/resume', { method: 'POST', auth: false })).status, 401);
      assert.equal((await w.api('/api/vault/loop/resume', { method: 'POST' })).json.loop.state, 'idle');
      assert.deepEqual((await w.tick()).vaults[0].done, [d.id], 'after the operator resume the same decision executes');
      w.cleanup();
    });
    test('rule (c), other direction: chain says ok where the model says PerDrawCap -> blocked before any draw is signed', async () => {
      let tamper = false;
      const f = async (u, init) => {
        const b = init?.body ? JSON.parse(init.body) : null;
        if (tamper && b?.method === 'eth_call' && String(b.params?.[0]?.data).startsWith('0xa054d076')) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + '00'.repeat(32) }), { status: 200 });
        return anvil.baseFetch(u, init);
      };
      const w = await makeWorld(anvil, { fetchImpl: f, mandate: { perDrawCap: '1000', periodCap: '2000', totalCap: '5000' }, fund: 5000n }); const d = await w.newDecision();
      tamper = true;
      const r = await w.tick();
      assert.equal(r.vaults[0].blocked, true);
      assert.match((await getLoop(w.db)).reason, /preview mismatch on draw: model says "PerDrawCap", chain says "ok"/);
      await noDeploy(w, [d.id]); assert.equal((await ledgerOf(w)).filter((x) => x.kind === 'draw').length, 0);
      w.cleanup();
    });
    test('rule (a): vault code that is not the attested build (code swapped on-chain) -> anomaly + BLOCKED, nothing signed', async () => {
      const w = await makeWorld(anvil); const d = await w.newDecision();
      await anvil.raw('anvil_setCode', [w.vault, '0x6080604052348015600e575f80fd5b00']);
      const r = await w.tick();
      assert.equal(r.vaults[0].blocked, true);
      assert.match((await getLoop(w.db)).reason, /vault runtime code does not equal the attested AgentVault build/);
      assert.equal((await ledgerOf(w)).filter((x) => x.kind === 'anomaly').length, 1);
      await noDeploy(w, [d.id]);
      const mon = await monitorDeployments(w.db, { fetchImpl: anvil.baseFetch });
      assert.equal(mon.find((x) => x.id.startsWith('vault:')).ok, false, 'the monitor also flags code drift');
      w.cleanup();
    });
    test('mandate drift: the owner installs a different mandate -> the loop stops for that vault (anomaly), the monitor flags it', async () => {
      const w = await makeWorld(anvil); const d = await w.newDecision();
      const p = w.grant.payload.mandate;
      await ownerTx(w, 'setMandate', [w.agent, BigInt(p.expiresAt), BigInt(p.perDrawCap), BigInt(p.periodSecs), BigInt(p.periodCap) * 2n, BigInt(p.totalCap) * 2n, BigInt(p.maxDeploys)]);
      const r = await w.tick();
      assert.equal(r.vaults[0].drift, true);
      assert.ok((await ledgerOf(w)).some((x) => x.kind === 'anomaly' && /differ from the approved grant/.test(x.detail)));
      await noDeploy(w, [d.id]); assert.equal((await getVault(w.db, w.vaultId)).status, 'drift');
      const mon = await monitorDeployments(w.db, { fetchImpl: anvil.baseFetch });
      assert.equal(mon.find((x) => x.id.startsWith('vault:')).ok, false);
      w.cleanup();
    });
    test('deploy count exhausted (maxDeploys 1): the second decision is refused with DeployLimit and ledgered', async () => {
      const w = await makeWorld(anvil, { mandate: { maxDeploys: 1 } });
      const d1 = await w.newDecision(); const d2 = await w.newDecision();
      const r = await w.tick();
      assert.deepEqual(r.vaults[0].done, [d1.id]); assert.equal(r.vaults[0].refused, 'DeployLimit');
      assert.equal((await refusals(w, /deploy refused by vault rules: DeployLimit/)).length, 1);
      assert.equal((await getDecision(w.db, d2.id)).status, 'pending');
      assert.equal((await w.db.get('SELECT COUNT(*) n FROM deployments')).n, 1);
      assert.equal((await w.db.get('SELECT COUNT(*) n FROM mandate_runs WHERE decision_id=?', [d2.id])).n, 0);
      w.cleanup();
    });
    test('rule (e): per-day limit (grant loop.maxPerDay=1): the second decision waits and is ledgered', async () => {
      const w = await makeWorld(anvil, { maxPerDay: 1 });
      const d1 = await w.newDecision(); const d2 = await w.newDecision();
      const r = await w.tick();
      assert.deepEqual(r.vaults[0].done, [d1.id]);
      assert.equal((await refusals(w, /per-day limit reached \(1 agent executions in 24h\)/)).length, 1);
      assert.equal((await getDecision(w.db, d2.id)).status, 'pending');
      // the env cap lowers it too, and can never raise a grant's own limit
      const w2 = await makeWorld(anvil, { maxPerDay: 5 });
      const e1 = await w2.newDecision(); await w2.newDecision();
      const r2 = await w2.tick({ env: { ...ENV_ON, AUTONOMY_MAX_PER_DAY: '1' } });
      assert.deepEqual(r2.vaults[0].done, [e1.id]);
      w.cleanup(); w2.cleanup();
    });
    test('rule (h): a failing deploy never leaves the decision stuck; errors carrying the key are redacted; the decision returns to the humans', async () => {
      let sends = 0; let secret = '';
      const f = async (u, init) => {
        const b = init?.body ? JSON.parse(init.body) : null;
        if (b?.method === 'eth_sendRawTransaction') { sends += 1; if (sends === 2) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: `node exploded ${secret}`, data: `key=${secret.slice(2)}` } }), { status: 200 }); }
        return anvil.baseFetch(u, init);
      };
      const w = await makeWorld(anvil, { fetchImpl: f }); secret = w.keys.privateKeyHex();
      const logs = []; const origErr = console.error; const origLog = console.log; console.error = (...a) => logs.push(a.join(' ')); console.log = (...a) => logs.push(a.join(' '));
      let d; try { d = await w.newDecision(); await w.tick(); await w.tick(); } finally { console.error = origErr; console.log = origLog; }
      const dec = await getDecision(w.db, d.id);
      assert.equal(dec.status, 'pending', 'released to the humans'); assert.equal(dec.approver, null); assert.equal(dec.bound_signer, null);
      assert.equal((await w.db.get('SELECT status FROM mandate_runs WHERE decision_id=?', [d.id])).status, 'failed');
      assert.equal((await w.db.get("SELECT COUNT(*) n FROM decisions WHERE status IN ('executing','approved')")).n, 0, 'nothing stuck approved/executing');
      const items = await ledgerOf(w);
      assert.ok(items.some((x) => x.kind === 'draw' && x.status === 'confirmed'));
      const fail = items.find((x) => x.kind === 'deploy' && x.status === 'failed'); assert.ok(fail, JSON.stringify(items.map((x) => [x.kind, x.status])));
      assert.match(fail.detail, /node exploded/);
      for (const text of [JSON.stringify(items), JSON.stringify(await w.db.all('SELECT * FROM audit')), logs.join('\n'), JSON.stringify(await w.db.all('SELECT * FROM kv'))]) {
        assert.ok(!text.includes(secret) && !text.includes(secret.slice(2)), 'redacted');
      }
      assert.match(fail.detail, /REDACTED/);
      // the agent does not retry it (one execution per decision); a human still can
      assert.equal((await w.db.get('SELECT COUNT(*) n FROM mandate_runs WHERE decision_id=?', [d.id])).n, 1);
      const a = await approveDecision(w.db, d.id, { nonce: dec.nonce, payloadHash: dec.payload_hash, confirm: `approve ${d.id}`, signer: ADDR.deployer, actor: 'op' });
      assert.equal(a.status, 'approved'); assert.equal(a.approval.humanSigned, true);
      w.cleanup();
    });
    test('human receipt route works for a mandate-approved decision (recordDeployment vault path is reachable by the operator too) and rejects a wrong tx', async () => {
      const w = await makeWorld(anvil); const d = await w.newDecision();
      await w.tick();
      const dep = await w.db.get('SELECT * FROM deployments WHERE decision_id=?', [d.id]);
      const again = await recordDeployment(w.db, d.id, { txHash: dep.transaction_hash, fetchImpl: anvil.baseFetch });
      assert.equal(again.idempotent, true);
      w.cleanup();
    });
    test('rule (a)/(b): an EXPIRED mandate is refused and ledgered (runs last: it moves the anvil clock)', async () => {
      const now = await anvil.blockTime();
      const w = await makeWorld(anvil, { mandate: { expiresAt: String(now + 400) } });
      const d = await w.newDecision();
      await anvil.raw('evm_increaseTime', [900]); await anvil.raw('evm_mine', []);
      const r = await w.tick();
      assert.match(r.vaults[0].refused, /expired/);
      assert.equal((await refusals(w, /expired/)).length, 1); await noDeploy(w, [d.id]);
      assert.equal((await w.api('/api/vault')).json.vaults[0].budget.blocked, 'MandateInactive');
      assert.equal((await getVault(w.db, w.vaultId)).status, 'inactive');
      void KEY;
      w.cleanup();
    });
  });
});
