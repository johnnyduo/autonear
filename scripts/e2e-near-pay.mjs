#!/usr/bin/env node
// END-TO-END of TOKEN PAYMENTS (rule l) on NEAR, against a LOCAL nearcore SANDBOX (chain_id "localnet"). NOT testnet.
// REAL compiled contracts: the payouts vault (autonear_vault_pay.wasm) and the mock USDC token (near_mock_token.wasm). Everything between the owner's wallet and the
// chain is the production code: attach -> propose a grant WITH payouts -> approve -> every human plan step -> activation -> POST /api/payments -> autonomyTick()
// (Manual waits, owner approval pays, Auto pays by itself, early refusals sign nothing, kill switch). Only the network is swapped: the 'near-testnet' entry of the
// protocol table points at the sandbox for this process. Owner signatures come from a throw-away key made here.
// It also MEASURES the gas of the real pay transaction tree and checks verifyPay against the real receipts.
// Exit codes: 0 all passed, 1 a check failed, 2 prerequisites missing.
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSandboxBin, startSandbox, stopSandbox } from './lib/near-sandbox.mjs';
import { PROTOCOLS, findNetwork } from '../src/protocols.js';
import { loadKeystore } from '../src/agent/keystore.js';
import { generateSeed, formatSecretKey, formatPublicKey, ed25519PublicKey } from '../src/agent/near-signer.js';
import { createNearAdmin } from '../src/agent/near-admin.js';
import { adapter, VAULT_PAY_WASM_PATH, REGISTRY_WASM_PATH, sha256Hex } from '../src/vault/near.js';
import { createApp } from '../src/app.js';
import { recordAttestation } from '../src/attest.js';
import { autonomyTick } from '../src/autonomy.js';
import { setMode, getMode } from '../src/autonomy-mode.js';
import { seededDb, NAMES } from '../tests/vault-helpers.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN_WASM_PATH = resolve(ROOT, 'contracts/near-mock-token/dist/near_mock_token.wasm');
const NEAR = 10n ** 24n; const TGAS = 10n ** 12n; const M = 10n ** 6n;
const R = { pass: 0, fail: 0 };
const step = (n, m) => console.log(`\n[${n}] ${m}`);
const t = (name, ok, detail = '') => { ok ? R.pass++ : R.fail++; console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); return ok; };
const usd = (v) => `${(Number(BigInt(v)) / 1e6).toFixed(2)} USDC`;
const tg = (g) => `${(Number(BigInt(g)) / 1e12).toFixed(3)} Tgas`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bin = findSandboxBin();
if (!bin) { console.error('near-sandbox binary not found (set NEAR_SANDBOX_BIN_PATH, or run `cd contracts/near-vault/integration && cargo test` once).'); process.exit(2); }
for (const p of [VAULT_PAY_WASM_PATH, REGISTRY_WASM_PATH, TOKEN_WASM_PATH]) if (!existsSync(p)) { console.error(`missing ${p}`); process.exit(2); }
const vaultWasm = new Uint8Array(readFileSync(VAULT_PAY_WASM_PATH)); const registryWasm = new Uint8Array(readFileSync(REGISTRY_WASM_PATH)); const tokenWasm = new Uint8Array(readFileSync(TOKEN_WASM_PATH));
const registrySha = sha256Hex(registryWasm);

console.log('AutoNEAR token payments (rule l), Manual and Auto, REAL payouts vault + mock USDC, on a LOCAL NEAR SANDBOX (NOT testnet).');
const sb = await startSandbox(bin);
console.log(`sandbox up: ${sb.url}  chain_id=${sb.chainId}`);
try {
  Object.assign(PROTOCOLS.near.networks.find((n) => n.id === 'near-testnet'), { rpc: sb.url, networkId: sb.chainId, local: true });
  const net = findNetwork('near-testnet');

  step(1, 'accounts, the REAL mock token and the REAL payouts vault');
  const mk = (id, sk) => createNearAdmin({ rpcUrl: sb.url, accountId: id, secretKey: sk, networkId: sb.chainId });
  const kf = () => { const seed = generateSeed(); return { sk: formatSecretKey(seed), pk: formatPublicKey(ed25519PublicKey(seed)) }; };
  const VAULT = `vault.${sb.rootId}`; const OWNER = `owner.${sb.rootId}`; const TOKEN = `usdc.${sb.rootId}`;
  const ALICE = `alice.${sb.rootId}`; const BOB = `bob.${sb.rootId}`; const CAROL = `carol.${sb.rootId}`; const DAVE = `dave.${sb.rootId}`;
  const root = mk(sb.rootId, sb.rootKey); const kOwner = kf(); const kVault = kf(); const kToken = kf();
  await root.createSubAccount(OWNER, kOwner.pk, 80n * NEAR); await root.createSubAccount(VAULT, kVault.pk, 10n * NEAR); await root.createSubAccount(TOKEN, kToken.pk, 10n * NEAR);
  const owner = mk(OWNER, kOwner.sk);
  const tinit = await mk(TOKEN, kToken.sk).deploy(TOKEN, tokenWasm, { method: 'new', args: { name: 'Mock USDC (testnet, anyone can mint)', symbol: 'USDC', decimals: 6, network_id: 'localnet' }, gas: 30n * TGAS });
  t('mock USDC token deployed and initialised (localnet label, account suffix enforced by the contract)', tinit.ok);
  const vinit = await mk(VAULT, kVault.sk).deploy(VAULT, vaultWasm, { method: 'new', args: { owner: OWNER, network_id: 'testnet' }, gas: 30n * TGAS });
  t('payouts vault deployed and initialised with the owner', vinit.ok);
  await owner.transfer(VAULT, 60n * NEAR);
  const keystore = loadKeystore({ path: join('/nonexistent', 'no-agent.keys.json'), env: { AGENT_NEAR_PRIVATE_KEY: kf().sk } });
  const AGENT = keystore.near.accountId;
  const ftBal = async (a) => BigInt(await root.view(TOKEN, 'ft_balance_of', { account_id: a }));
  const tokenUsage = async () => root.view(VAULT, 'token_usage', { token: TOKEN });

  step(2, 'database, API, attestation (the grant needs one attested template even though payments deploy nothing)');
  const { db } = await seededDb();
  await recordAttestation(db, { protocol: 'near', commitSha: 'e2e-near-pay', manifest: { sha256: registrySha, bytes: registryWasm.length, sourceSha256: 'ab'.repeat(32) }, tests: { passed: 84, failed: 0, lint: true, fuzz: true, names: NAMES } });
  const app = createApp({ db, operatorToken: 'op', keystore, signingSupported: true, defer: () => {} });
  const api = async (path, { method = 'GET', body } = {}) => { const r = await app(new Request('http://t' + path, { method, headers: { 'x-peer-ip': `e2e-${Math.random()}`, authorization: 'Bearer op', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* text */ } return { status: r.status, json, text }; };
  const approve = (d) => api(`/api/decisions/${d.id}/approve`, { method: 'POST', body: { nonce: d.nonce, payloadHash: d.payload_hash, confirm: `approve ${d.id}`, signer: OWNER } });
  const request = (payee, amount, memo, token = TOKEN) => api('/api/payments', { method: 'POST', body: { token, payee, amount: String(amount), memo } });

  step(3, 'owner flow: attach, propose a grant WITH payouts, approve, sign every plan step, activate');
  let a = await api('/api/vault/attach', { method: 'POST', body: { chainId: 'near-testnet', address: VAULT } });
  t('payouts vault attached (code == the attested payouts build)', a.status === 201, a.text.slice(0, 120));
  const prop = await api('/api/vault/mandates/propose', { method: 'POST', body: {
    chainId: 'near-testnet', vault: { address: VAULT, owner: OWNER }, agent: { account: AGENT },
    mandate: { perDrawCap: String(NEAR), periodSecs: 3600, periodCap: String(20n * NEAR), totalCap: String(20n * NEAR), maxDeploys: 1 },
    templates: [{ artifactHash: registrySha, owner: OWNER, proposer: AGENT }], fund: { amount: '0' }, loop: { maxPerDay: 5 },
    payouts: { tokens: [{ token: TOKEN, perPayCap: String(40n * M), periodCap: String(80n * M), totalCap: String(400n * M) }], payees: [ALICE, BOB, CAROL], fund: { token: TOKEN, amount: String(60n * M) } } } });
  t('grant with payouts proposed (symbol and decimals read from the token itself)', prop.status === 201 && prop.json?.payload?.payouts?.tokens?.[0]?.symbol === 'USDC' && prop.json.payload.payouts.tokens[0].decimals === 6 && prop.json.payload.payouts.tokens[0].mock === true, prop.text.slice(0, 160));
  const grant = prop.json;
  const ap = await approve(grant);
  t('grant approved with the vault owner as signer', ap.status === 200, ap.text.slice(0, 160));
  const plan = (await api(`/api/vault/plan?decisionId=${grant.id}`)).json;
  let done = 0;
  for (const s of plan.steps.filter((x) => x.who === 'human' && x.call)) {
    if (s.title.includes(`register ${CAROL} `)) { console.log(`   (skipped on purpose, to test the unregistered-payee refusal: ${s.title})`); continue; }
    const c = s.call;
    const r = c.method ? await owner.call(c.receiverId, c.method, c.args ?? {}, { deposit: BigInt(c.deposit ?? 0), gas: BigInt(c.gas ?? 30n * TGAS) }) : await owner.transfer(c.receiverId, BigInt(c.deposit ?? 0));
    if (!t(`owner step: ${s.title.slice(0, 70)}`, r.ok)) break;
    done += 1;
  }
  a = await api('/api/vault/attach', { method: 'POST', body: { chainId: 'near-testnet', address: VAULT } });
  t('vault ACTIVATED: tokens, caps and payees on chain equal the approved grant, field by field', a.json?.activation?.activated === true, JSON.stringify(a.json?.activation ?? a.text).slice(0, 200));
  t('the vault holds the 60 USDC the owner funded it with', (await ftBal(VAULT)) === 60n * M && done >= 8, usd(await ftBal(VAULT)));
  const view = (await api('/api/vault')).json.vaults[0];
  t('GET /api/vault shows the payouts build, the token with its caps and the vault balance', view.build === 'pay' && view.payouts?.tokens?.[0]?.balance === String(60n * M) && view.payouts.payees.length === 3, JSON.stringify(view.payouts?.tokens?.[0]).slice(0, 200));

  const deps = (env = {}) => ({ keystore, signingSupported: true, signerOpts: { pollMs: 250, timeoutMs: 90_000 }, env: { AUTONOMY_ENABLED: '1', AUTONOMY_MAX_PER_DAY: '5', AUTONOMY_MAX_PAYMENTS_PER_DAY: '6', ...env } });
  const tick = (env) => autonomyTick(db, deps(env));
  const ledger = async () => (await api('/api/vault/ledger?limit=300')).json.items;
  const dec = (id) => db.get('SELECT * FROM decisions WHERE id=?', [id]);
  const runs = async () => (await db.get('SELECT COUNT(*) n FROM mandate_runs')).n;
  const payRow = (id) => db.get('SELECT * FROM payments WHERE decision_id=?', [id]);
  const txTree = (h) => root.rpc.call('EXPERIMENTAL_tx_status', { tx_hash: h, sender_account_id: AGENT, wait_until: 'FINAL' });
  const usedTotals = (u) => `total ${usd(u.total_spent)}, period ${usd(u.period_spent)}`;
  const gasReport = (label, tx) => {
    const actionsOf = (id) => (tx.receipts.find((r) => r.receipt_id === id)?.receipt?.Action?.actions ?? []).map((x) => x.FunctionCall?.method_name ?? Object.keys(x)[0]).join('+');
    const rows = tx.receipts_outcome.map((o) => { const what = actionsOf(o.id); const refund = what === 'Transfer'; return { who: refund ? `(refund to ${o.outcome.executor_id.slice(0, 8)}...)` : o.outcome.executor_id, what: refund ? 'refund' : what, burnt: BigInt(o.outcome.gas_burnt), tokens: BigInt(o.outcome.tokens_burnt), refund }; });
    console.log(`   RECEIPT TREE (${label}): ${tx.receipts.map((r) => `${r.predecessor_id.slice(0, 12)}->${r.receiver_id.slice(0, 12)}:${actionsOf(r.receipt_id)}`).join('  |  ')}`);
    console.log(`   GAS (${label}): signer->receipt conversion ${tg(tx.transaction_outcome.outcome.gas_burnt)}`);
    for (const r of rows) console.log(`        ${r.who.padEnd(26)} ${r.what.padEnd(12)} gas_burnt ${tg(r.burnt)}`);
    const exec = rows.filter((r) => !r.refund);
    const sum = exec.reduce((n, r) => n + r.burnt, 0n); const all = rows.reduce((n, r) => n + r.burnt, 0n) + BigInt(tx.transaction_outcome.outcome.gas_burnt);
    const tokens = rows.reduce((n, r) => n + r.tokens, 0n) + BigInt(tx.transaction_outcome.outcome.tokens_burnt);
    console.log(`        function-call receipts total ${tg(sum)}; whole tree incl. conversion and refund receipts ${tg(all)}; attached 100.000 Tgas; headroom (attached - function-call total) ${tg(100n * TGAS - sum)}; tokens burnt (whole tree) ${(Number(tokens / 10n ** 18n) / 1e6).toFixed(6)} NEAR`);
    return { rows, sum, all, tokens, byWhat: Object.fromEntries(exec.map((r) => [r.what, r.burnt])) };
  };

  step(4, 'MANUAL (default): a payment request waits; nothing moves');
  const d1 = (await request(ALICE, 25n * M, 'invoice 1')).json;
  t('payment request created as a pending pay_testnet decision', d1?.status === 'pending' && d1.action === 'pay_testnet', JSON.stringify(d1).slice(0, 100));
  const vaultBefore = await ftBal(VAULT);
  t('default mode is manual', await getMode(db) === 'manual');
  const m1 = await tick(); t('tick reports manual and does nothing', m1.vaults?.[0]?.manual === true, JSON.stringify(m1.vaults?.[0] ?? m1).slice(0, 120));
  t('payee balance, vault balance and runs unchanged; decision still pending', await ftBal(ALICE) === 0n && await ftBal(VAULT) === vaultBefore && await runs() === 0 && (await dec(d1.id)).status === 'pending');

  step(5, 'MANUAL: the owner approves; the next tick pays through the vault');
  const ap1 = await approve(d1);
  t('owner approval recorded', ap1.status === 200, ap1.text.slice(0, 120));
  const m2 = await tick();
  const row1 = await dec(d1.id);
  t('payee balance up by exactly the amount; vault balance down by the same', await ftBal(ALICE) === 25n * M && await ftBal(VAULT) === 35n * M, `alice ${usd(await ftBal(ALICE))}, vault ${usd(await ftBal(VAULT))} ${JSON.stringify(m2.vaults?.[0] ?? m2).slice(0, 140)}`);
  t('decision is executed; approver says owner approved, agent signed (mandate:...+operator)', row1.status === 'executed' && /^mandate:.+\+operator$/.test(row1.approver), `${row1.status} ${row1.approver}`);
  const pay1 = await payRow(d1.id);
  t('a payments row exists, verified, with the tx hash', Boolean(pay1) && /^verified/.test(pay1.status) && pay1.amount === String(25n * M) && pay1.token === TOKEN && pay1.payee === ALICE, JSON.stringify(pay1)?.slice(0, 160));
  const full = (await api(`/api/decisions/${d1.id}`)).json;
  t('API says humanApproved=true, humanSigned=false and carries the payment', full.approval?.humanApproved === true && full.approval?.humanSigned === false && full.payment?.tx_hash === pay1.tx_hash);
  const v1 = await adapter.verifyPay({ net, txHash: pay1.tx_hash, vault: VAULT, agent: AGENT, token: TOKEN, to: ALICE, amount: String(25n * M), memo: 'invoice 1' });
  t('verifyPay is ok against the REAL receipt tree', v1.ok === true, v1.ok ? `${v1.checks.length} checks` : JSON.stringify(v1.checks.filter((c) => !c.ok)).slice(0, 400));
  t('the real token emitted the NEP-141 ft_transfer event that verifyPay now REQUIRES', v1.checks.some((c) => /token event ft_transfer vault -> payee/.test(c.name) && c.ok));
  t('verifyPay rejects the same real tx for another amount / payee / token', (await adapter.verifyPay({ net, txHash: pay1.tx_hash, vault: VAULT, agent: AGENT, token: TOKEN, to: ALICE, amount: String(26n * M), memo: 'invoice 1' })).ok === false && (await adapter.verifyPay({ net, txHash: pay1.tx_hash, vault: VAULT, agent: AGENT, token: TOKEN, to: BOB, amount: String(25n * M), memo: 'invoice 1' })).ok === false && (await adapter.verifyPay({ net, txHash: pay1.tx_hash, vault: VAULT, agent: AGENT, token: DAVE, to: ALICE, amount: String(25n * M), memo: 'invoice 1' })).ok === false);
  const L = await ledger();
  t('ledger has the payment (kind pay, confirmed, token and payee in the detail, amount as a decimal string)', L.some((x) => x.kind === 'pay' && x.status === 'confirmed' && x.decisionId === d1.id && x.txHash === pay1.tx_hash && x.amount === String(25n * M) && x.detail.includes(TOKEN) && x.detail.includes(ALICE)));
  t('ledger says the agent signed and the owner did not', L.some((x) => x.decisionId === d1.id && /approved by the owner/.test(x.detail) && /the owner does not/.test(x.detail)));
  const listed = (await api('/api/payments')).json.items.find((x) => x.decisionId === d1.id);
  t('GET /api/payments lists it with the verified payment', listed?.payment?.txHash === pay1.tx_hash && listed.amountDisplay === '25 USDC', JSON.stringify(listed)?.slice(0, 120));
  t('mode is still manual', await getMode(db) === 'manual');

  step(6, 'MEASURE GAS of the real pay transaction tree');
  const tx1 = await txTree(pay1.tx_hash);
  const g1 = gasReport('successful pay', tx1);
  const ftBurnt = g1.byWhat.ft_transfer ?? 0n; const cbBurnt = g1.byWhat.on_paid ?? 0n; const payBurnt = g1.byWhat.pay ?? 0n;
  t('real tree has the expected receipts: pay, ft_transfer, on_paid', payBurnt > 0n && ftBurnt > 0n && cbBurnt > 0n);
  t(`ft_transfer burnt ${tg(ftBurnt)} < the 30 Tgas the vault gives it`, ftBurnt > 0n && ftBurnt < 30n * TGAS);
  t(`on_paid burnt ${tg(cbBurnt)} < the 10 Tgas the vault reserves for it`, cbBurnt > 0n && cbBurnt < 10n * TGAS);
  t(`the whole function-call tree (${tg(g1.sum)}) fits inside the 100 Tgas attached, with room to spare`, g1.sum < 100n * TGAS && 100n * TGAS - g1.sum >= 30n * TGAS, `headroom ${tg(100n * TGAS - g1.sum)}`);
  t('the signer reports the same tree as ok (all receipts succeeded)', tx1.receipts_outcome.every((o) => o.outcome.status.Failure === undefined) && tx1.status.SuccessValue !== undefined);

  step(7, 'AUTO: a new pending request is paid by the agent on its own');
  await setMode(db, 'auto', 'owner:e2e');
  const d2 = (await request(BOB, 30n * M, 'invoice 2')).json;
  const m3 = await tick();
  const row2 = await dec(d2.id);
  t('request paid without an owner click (approver mandate:... without +)', row2.status === 'executed' && /^mandate:[^+]+$/.test(row2.approver) && await ftBal(BOB) === 30n * M, `${row2.status} ${row2.approver} bob ${usd(await ftBal(BOB))} ${JSON.stringify(m3.vaults?.[0] ?? m3).slice(0, 100)}`);
  t('the record says no human approved it', (await api(`/api/decisions/${d2.id}`)).json.approval?.humanApproved === false);
  const u2 = await tokenUsage();
  t('vault token usage follows the chain: 55 USDC spent in total and in this period', BigInt(u2.total_spent) === 55n * M && BigInt(u2.period_spent) === 55n * M, usedTotals(u2));
  t('vault now holds 5 USDC', await ftBal(VAULT) === 5n * M);

  step(8, 'REFUSALS: over the per-pay cap, unlisted payee, token not allowlisted (the API says 409; nothing is created)');
  const decCount = async () => (await db.get("SELECT COUNT(*) n FROM decisions WHERE action='pay_testnet'")).n;
  const n0 = await decCount();
  const r1 = await request(ALICE, 41n * M, 'too big'); t('amount over the per-payment cap: 409', r1.status === 409, `${r1.status} ${r1.text.slice(0, 100)}`);
  const r2 = await request(DAVE, 5n * M, 'stranger'); t('payee the owner never listed: 409', r2.status === 409, `${r2.status} ${r2.text.slice(0, 100)}`);
  const r3 = await request(ALICE, 5n * M, 'other token', `usdt.${sb.rootId}`); t('token the owner never allowlisted: 409', r3.status === 409, `${r3.status} ${r3.text.slice(0, 100)}`);
  t('none of them created a decision', await decCount() === n0);

  step(9, 'REFUSALS in the loop (Auto): payee not registered on the token, vault balance too small, period cap used up. Nothing is signed.');
  const runs0 = await runs(); const vaultTok0 = await ftBal(VAULT);
  const dC = (await request(CAROL, 5n * M, 'unregistered')).json;
  t('request for a payee the owner allowlisted but never registered on the token is accepted by the API', dC?.status === 'pending', JSON.stringify(dC).slice(0, 100));
  await tick(); await tick();
  const LC = (await ledger()).filter((x) => x.decisionId === dC.id && x.kind === 'refused');
  t('loop refused early: decision untouched, no run, nothing moved', (await dec(dC.id)).status === 'pending' && await runs() === runs0 && await ftBal(CAROL) === 0n && await ftBal(VAULT) === vaultTok0);
  t('ledgered once with a plain reason ("not registered", "nothing was signed")', LC.length === 1 && /not registered/.test(LC[0].detail) && /nothing was signed/.test(LC[0].detail), LC.map((x) => x.detail).join(' | ').slice(0, 200));
  await api(`/api/decisions/${dC.id}/reject`, { method: 'POST', body: { reason: 'e2e: tested' } });

  const dB = (await request(ALICE, 20n * M, 'more than the vault holds')).json;
  await tick();
  const LB = (await ledger()).filter((x) => x.decisionId === dB.id && x.kind === 'refused');
  t('vault balance too small (5 USDC for a 20 USDC payment): refused early, nothing signed', (await dec(dB.id)).status === 'pending' && await runs() === runs0 && /vault holds 5.* USDC/.test(LB[0]?.detail ?? ''), LB.map((x) => x.detail).join(' | ').slice(0, 220));
  await api(`/api/decisions/${dB.id}/reject`, { method: 'POST', body: { reason: 'e2e: tested' } });

  const mintR = await owner.call(TOKEN, 'mint', { account_id: OWNER, amount: String(200n * M) }, { gas: 30n * TGAS });
  const xferR = await owner.call(TOKEN, 'ft_transfer', { receiver_id: VAULT, amount: String(200n * M), memo: 'top up' }, { gas: 30n * TGAS, deposit: 1n });
  t('owner topped the vault up with 200 more USDC (mock mint + ft_transfer)', mintR.ok && xferR.ok && await ftBal(VAULT) === 205n * M, usd(await ftBal(VAULT)));
  const dP = (await request(BOB, 40n * M, 'over what is left this period')).json;
  const vaultTok1 = await ftBal(VAULT); const bobTok1 = await ftBal(BOB);
  await tick();
  const LP = (await ledger()).filter((x) => x.decisionId === dP.id && x.kind === 'refused');
  t('period cap used up (25 USDC left, 40 asked): refused, nothing signed, nothing moved', (await dec(dP.id)).status === 'pending' && await runs() === runs0 && await ftBal(VAULT) === vaultTok1 && await ftBal(BOB) === bobTok1 && /period is used up|PeriodCap/.test(LP[0]?.detail ?? ''), LP.map((x) => x.detail).join(' | ').slice(0, 220));
  await api(`/api/decisions/${dP.id}/reject`, { method: 'POST', body: { reason: 'e2e: tested' } });

  step(10, 'CHAIN-LEVEL REVERSAL: the agent calls vault.pay itself to a payee that is allowlisted but unregistered on the token');
  await setMode(db, 'manual', 'owner:e2e');
  const uBefore = await tokenUsage();
  const signer = keystore.signer('near', adapter.signerOptions({ net, payouts: true, extra: { pollMs: 250, timeoutMs: 90_000 } }));
  const direct = await signer.signAndSend(adapter.buildCall('pay', { vault: VAULT, token: TOKEN, to: CAROL, amount: String(10n * M), memo: 'will fail' }), { maxFeePerTx: NEAR, allowedTargets: [VAULT], allowedMethods: ['pay'] });
  t('the signed pay tx reports a failure (the token refused the transfer)', direct.ok === false && direct.status === 'failed', `${direct.status} ${String(direct.failure).slice(0, 120)}`);
  const txF = await txTree(direct.txHash);
  const vaultEvents = txF.receipts_outcome.filter((o) => o.outcome.executor_id === VAULT).flatMap((o) => o.outcome.logs).filter((l) => l.startsWith('EVENT_JSON:')).map((l) => JSON.parse(l.slice(11)));
  const pf = vaultEvents.find((e) => e.event === 'pay_failed');
  t('a pay_failed event exists, saying the charge was reversed', Boolean(pf) && pf.data?.reversed === true && pf.data.to === CAROL && pf.data.amount === String(10n * M), JSON.stringify(pf)?.slice(0, 200));
  t('the paid event came first (optimistic charge) and the transfer receipt failed on the token', vaultEvents.some((e) => e.event === 'paid') && txF.receipts_outcome.some((o) => o.outcome.executor_id === TOKEN && o.outcome.status.Failure !== undefined));
  const uAfter = await tokenUsage();
  t('token_usage returned to the previous value', uAfter.total_spent === uBefore.total_spent && uAfter.period_spent === uBefore.period_spent, `${usedTotals(uBefore)} -> ${usedTotals(uAfter)}`);
  t('payee got nothing; vault token balance unchanged', await ftBal(CAROL) === 0n && await ftBal(VAULT) === vaultTok1);
  const vf = await adapter.verifyPay({ net, txHash: direct.txHash, vault: VAULT, agent: AGENT, token: TOKEN, to: CAROL, amount: String(10n * M), memo: 'will fail' });
  t('verifyPay on the real reversed tx: not ok, and it is the pay_failed check that says so', vf.ok === false && vf.checks.some((c) => !c.ok && /pay_failed/.test(c.name)), JSON.stringify(vf.checks.filter((c) => !c.ok).map((c) => c.name)).slice(0, 300));
  const g2 = gasReport('reversed pay (ft_transfer fails, on_paid reverses)', txF);
  t(`on_paid on the REVERSAL path burnt ${tg(g2.byWhat.on_paid ?? 0n)}, still under its 10 Tgas`, (g2.byWhat.on_paid ?? 0n) > 0n && (g2.byWhat.on_paid ?? 0n) < 10n * TGAS);

  step(11, 'KILL SWITCH blocks an approved payment (Manual); resuming pays it');
  const d3 = (await request(ALICE, 20n * M, 'invoice 3')).json;
  await approve(d3);
  const aliceBefore = await ftBal(ALICE);
  await api('/api/security/pause', { method: 'POST' });
  await tick(); t('kill switch engaged: the approved payment is not run', await ftBal(ALICE) === aliceBefore && (await dec(d3.id)).status === 'approved');
  await api('/api/security/resume', { method: 'POST' });
  await tick();
  t('after resume it is paid', await ftBal(ALICE) === aliceBefore + 20n * M && (await dec(d3.id)).status === 'executed', `alice ${usd(await ftBal(ALICE))}`);
  const u3 = await tokenUsage();
  t('usage 75 USDC = 25 + 30 + 20; the reversed 10 left no trace', BigInt(u3.total_spent) === 75n * M && BigInt(u3.period_spent) === 75n * M, usedTotals(u3));

  step(12, 'owner withdraw_token works while the vault is PAUSED (the agent is stopped, the owner is not)');
  const pauseR = await owner.call(VAULT, 'pause', {}, { gas: 30n * TGAS });
  const d4 = (await request(ALICE, 5n * M, 'while paused')).json; await approve(d4);
  const mp = await tick();
  t('vault paused: the loop refuses, pays nothing', pauseR.ok && (await dec(d4.id)).status === 'approved' && /paused/.test(mp.vaults?.[0]?.refused ?? ''), JSON.stringify(mp.vaults?.[0] ?? mp).slice(0, 120));
  const ownerBefore = await ftBal(OWNER); const vaultBeforeW = await ftBal(VAULT);
  const wc = adapter.buildCall('withdraw_token', { vault: VAULT, token: TOKEN, amount: String(50n * M) });
  const wr = await owner.call(wc.target, wc.method, wc.args, { gas: BigInt(wc.gas), deposit: BigInt(wc.deposit) });
  t('owner withdraw_token succeeded while paused: owner +50 USDC, vault -50 USDC', wr.ok && await ftBal(OWNER) === ownerBefore + 50n * M && await ftBal(VAULT) === vaultBeforeW - 50n * M, `owner ${usd(await ftBal(OWNER))}, vault ${usd(await ftBal(VAULT))}`);
  await owner.call(VAULT, 'unpause', {}, { gas: 30n * TGAS });
  await tick();
  t('after unpause the approved payment runs', await ftBal(ALICE) === aliceBefore + 25n * M && (await dec(d4.id)).status === 'executed');

  step(13, 'bookkeeping');
  t('every payment has exactly one run and one verified payments row', (await db.get("SELECT COUNT(*) n FROM payments")).n === 4 && (await db.get("SELECT COUNT(*) n FROM mandate_runs WHERE status='confirmed'")).n === 4);
  t('loop never blocked', (await api('/api/vault')).json.loop.state !== 'blocked');
  t('ledger hash chain intact', (await api('/api/vault')).json.health.find((h) => /ledger hash chain/.test(h.name))?.ok === true);
  const everything = JSON.stringify(await ledger()) + JSON.stringify(await db.all('SELECT detail FROM audit'));
  t('no key material anywhere in the ledger or audit log', !everything.includes(kOwner.sk) && !everything.includes(kVault.sk) && !/ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/.test(everything));
  console.log('\n   GAS SUMMARY (real sandbox, nearcore ' + sb.version + '):');
  console.log(`        successful pay: pay ${tg(payBurnt)}, ft_transfer ${tg(ftBurnt)}, on_paid ${tg(cbBurnt)}; function-call total ${tg(g1.sum)} of 100.000 Tgas attached (headroom ${tg(100n * TGAS - g1.sum)}); whole tree incl. conversion+refunds ${tg(g1.all)}; tokens burnt ${(Number(g1.tokens / 10n ** 18n) / 1e6).toFixed(6)} NEAR (the signer's worst-case bound was ${(Number(100n * TGAS * 100000000n * 15n / 10n / 10n ** 18n) / 1e6).toFixed(6)} NEAR at 1e8 yocto/gas)`);
  console.log(`        reversed pay:   pay ${tg(g2.byWhat.pay ?? 0n)}, ft_transfer(fails) ${tg(g2.byWhat.ft_transfer ?? 0n)}, on_paid ${tg(g2.byWhat.on_paid ?? 0n)}; function-call total ${tg(g2.sum)}`);
} catch (e) {
  console.error('\nE2E ERROR:', e.stack || e); R.fail++;
} finally { await stopSandbox(); }
console.log(`\nRESULT: ${R.pass} PASS, ${R.fail} FAIL`);
console.log('SCOPE: local nearcore sandbox (chain_id localnet), real compiled payouts vault and mock token. The production loop, policy, adapter, signer and database code ran; the network table entry was pointed at the sandbox. NOT testnet.');
process.exit(R.fail ? 1 : 0);
