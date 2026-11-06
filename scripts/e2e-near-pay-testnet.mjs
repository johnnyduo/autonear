#!/usr/bin/env node
// REAL run of TOKEN PAYMENTS on the PUBLIC NEAR TESTNET (chain_id "testnet"): the mock USDC token + the payouts vault (autonear_vault_pay.wasm). Spends testnet NEAR only.
//
// Who signs what (same honesty rule as scripts/e2e-near-testnet.mjs):
//   OWNER  = the DEMO owner key (data/demo-owner.keys.json, same machine as the agent key). Automation, NOT a human signature.
//   AGENT  = the keystore agent key through src/agent/near-signer.js with call limits (vault `pay` only, fee cap).
//   A STRANGER (the named funder account) mints mock USDC to show the faucet is open; it is the only thing that account does here.
// Both new contracts are deployed on sub-accounts of the owner and then LOCKED (DeleteKey): their code can never change.
// Usage: NEAR_TESTNET_RUN=yes node scripts/e2e-near-pay-testnet.mjs   (anything else exits 2 without touching the network)
//        NEAR_RUN_TAG=v3 to use fresh account names. Evidence: docs/testnet/near-pay-testnet-<tag>.json
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { base58Encode } from '../src/agent/base58.js';
import { loadKeystore } from '../src/agent/keystore.js';
import { generateSeed, formatSecretKey, formatPublicKey, ed25519PublicKey } from '../src/agent/near-signer.js';
import { createNearAdmin, deleteKey } from '../src/agent/near-admin.js';
import { adapter, VAULT_PAY_WASM_PATH, sha256Hex } from '../src/vault/near.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN_WASM_PATH = resolve(ROOT, 'contracts/near-mock-token/dist/near_mock_token.wasm');
const NEAR = 10n ** 24n; const TGAS = 10n ** 12n; const M = 10n ** 6n; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nearStr = (y) => `${(Number(BigInt(y) / 10n ** 20n) / 1e4).toFixed(4)} NEAR`;
const usd = (v) => `${(Number(BigInt(v)) / 1e6).toFixed(2)} USDC`;
if (process.env.NEAR_TESTNET_RUN !== 'yes') { console.error('Refusing: this script spends public-testnet NEAR. Re-run with NEAR_TESTNET_RUN=yes.'); process.exit(2); }

const RPC = process.env.NEAR_TESTNET_RPC ?? 'https://rpc.testnet.fastnear.com';
const OWNER = process.env.NEAR_OWNER_ACCOUNT ?? 'autonear-owner-1106.testnet';
const STRANGER = process.env.NEAR_AGENT_NAMED_ACCOUNT ?? 'autonear-agent-1106.testnet';
const TAG = process.env.NEAR_RUN_TAG ?? 'v2'; const RESUME = process.env.NEAR_RESUME === 'yes';
const VAULT = `vault-${TAG}.${OWNER}`; const TOKEN = `usdc-${TAG}.${OWNER}`; const ALICE = `alice-${TAG}.${OWNER}`; const BOB = `bob-${TAG}.${OWNER}`;
const EXPLORER = 'https://testnet.nearblocks.io'; const EVIDENCE_OUT = resolve(ROOT, `docs/testnet/near-pay-testnet-${TAG}.json`);
const tx = (h) => `${EXPLORER}/txns/${h}`;
const keyFile = (p) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8')).near.secretKey;
for (const p of ['data/demo-owner.keys.json', 'data/agent.keys.json', VAULT_PAY_WASM_PATH, TOKEN_WASM_PATH]) if (!existsSync(resolve(ROOT, p))) { console.error(`missing ${p}`); process.exit(2); }

const R = { pass: 0, fail: 0, failed: [] };
const evidence = { network: 'near-testnet', chainId: 'testnet', startedAt: new Date().toISOString(), signers: { owner: `${OWNER} (DEMO owner key; automated, not a human signature)`, agent: null, stranger: `${STRANGER} (mints from the open faucet)` }, accounts: {}, txs: [], checks: [] };
const step = (n, m) => console.log(`\n[${n}] ${m}`);
function t(name, ok, detail = '') { evidence.checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 200) }); if (ok) { R.pass++; console.log(`   PASS  ${name}${detail ? `  (${detail})` : ''}`); } else { R.fail++; R.failed.push(name); console.log(`   FAIL  ${name}${detail ? `  (${detail})` : ''}`); } return ok; }
const rec = (label, r, who) => { if (r?.txHash) evidence.txs.push({ label, signer: who, hash: r.txHash, ok: r.ok ?? null, explorer: tx(r.txHash) }); return r; };
const rpcNorm = (j) => (j?.result && typeof j.result === 'object' && typeof j.result.error === 'string' ? { jsonrpc: j.jsonrpc, id: j.id, error: { message: j.result.error } } : j); // fastnear answers a failed query as { result: { error } }
const rpcRaw = async (method, params) => rpcNorm(await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json());
const kf = () => { const seed = generateSeed(); return { sk: formatSecretKey(seed), pk: formatPublicKey(ed25519PublicKey(seed)) }; };

const vaultWasm = new Uint8Array(readFileSync(VAULT_PAY_WASM_PATH)); const tokenWasm = new Uint8Array(readFileSync(TOKEN_WASM_PATH));
const vaultSha = sha256Hex(vaultWasm); const tokenSha = sha256Hex(tokenWasm);
const net = { id: 'near-testnet', protocol: 'near', rpc: RPC, explorer: `${EXPLORER}/txns/`, mainnet: false, networkId: 'testnet' };
console.log(`AutoNEAR token payments on the PUBLIC NEAR TESTNET\nvault ${VAULT}  (payouts build sha256 ${vaultSha})\ntoken ${TOKEN}  (mock USDC sha256 ${tokenSha})`);
try {
  const status = (await rpcRaw('status', [])).result; if (status?.chain_id !== 'testnet') throw new Error(`RPC chain_id is ${status?.chain_id}, expected testnet`);
  const owner = createNearAdmin({ rpcUrl: RPC, accountId: OWNER, secretKey: keyFile('data/demo-owner.keys.json'), networkId: 'testnet' });
  const stranger = createNearAdmin({ rpcUrl: RPC, accountId: STRANGER, secretKey: keyFile('data/agent.keys.json'), networkId: 'testnet' });
  const keystore = loadKeystore({ path: resolve(ROOT, 'data/agent.keys.json') }); const AGENT = keystore.near.accountId; evidence.signers.agent = `${AGENT} (agent keystore key, call-limited signer: vault pay only)`;
  evidence.accounts = { owner: OWNER, agent: AGENT, vault: VAULT, token: TOKEN, alice: ALICE, bob: BOB };
  let r;
  const bal = async (id) => { try { return BigInt((await owner.account(id)).amount); } catch { return null; } };
  const ftBal = async (a) => BigInt(await owner.view(TOKEN, 'ft_balance_of', { account_id: a }));
  console.log(`owner ${nearStr(await bal(OWNER))}   agent ${(await bal(AGENT)) === null ? 'not on chain' : nearStr(await bal(AGENT))}`);
  if (!RESUME) for (const id of [VAULT, TOKEN, ALICE, BOB]) if ((await bal(id)) !== null) throw new Error(`${id} already exists; set NEAR_RUN_TAG to a new value`);
  if ((await bal(AGENT)) === null || (await bal(AGENT)) < NEAR / 5n) throw new Error('agent account is missing or has under 0.2 NEAR for gas');

  if (!RESUME) {
  step(1, 'owner creates the mock USDC account, deploys the token, checks its code hash, then locks the account (DeleteKey)');
  const kTok = kf();
  rec('create token sub-account + fund', await owner.createSubAccount(TOKEN, kTok.pk, 23n * NEAR / 10n), OWNER);
  const tokAdmin = createNearAdmin({ rpcUrl: RPC, accountId: TOKEN, secretKey: kTok.sk, networkId: 'testnet' });
  const tinit = rec('deploy mock token + new(name, symbol, decimals, network_id)', await tokAdmin.deploy(TOKEN, tokenWasm, { method: 'new', args: { name: 'Mock USDC (testnet, anyone can mint)', symbol: 'USDC', decimals: 6, network_id: 'testnet' }, gas: 30n * TGAS }), TOKEN);
  t('mock token deployed and initialised', tinit.ok, tinit.txHash);
  const tAcc = await owner.account(TOKEN); t('on-chain token code hash == base58(sha256(near_mock_token.wasm))', tAcc.code_hash === base58Encode(createHash('sha256').update(tokenWasm).digest()), tAcc.code_hash);
  const meta = await owner.view(TOKEN, 'ft_metadata', {}); t('ft_metadata: USDC, 6 decimals', meta.symbol === 'USDC' && meta.decimals === 6, `${meta.symbol}/${meta.decimals}`);
  const delT = rec('DeleteKey: lock the token account', await tokAdmin.send(TOKEN, [deleteKey(kTok.pk)]), TOKEN);
  t('token account has no access keys (code can no longer be replaced)', delT.ok && (await owner.keys(TOKEN)).length === 0);

  step(2, 'owner creates the vault account, deploys the PAYOUTS build, verifies it against the attested hash, then locks it');
  const kVault = kf();
  rec('create vault sub-account + fund (storage ~3.4 + 1 NEAR reserve + cushion: pay() attaches 1 yocto from the vault SPENDABLE NEAR)', await owner.createSubAccount(VAULT, kVault.pk, 52n * NEAR / 10n), OWNER);
  const vaultAdmin = createNearAdmin({ rpcUrl: RPC, accountId: VAULT, secretKey: kVault.sk, networkId: 'testnet' });
  const vinit = rec('deploy payouts vault + new(owner, network_id)', await vaultAdmin.deploy(VAULT, vaultWasm, { method: 'new', args: { owner: OWNER, network_id: 'testnet' }, gas: 30n * TGAS }), VAULT);
  t('payouts vault deployed and initialised', vinit.ok, vinit.txHash);
  let vc = await adapter.verifyVaultCode({ net, vault: VAULT, attested: { sha256: vaultSha } });
  t('on-chain vault code == the attested payouts build; build detected as "pay"', vc.ok && vc.build === 'pay', `sha256 ${vaultSha.slice(0, 16)}... build ${vc.build}`);
  const delV = rec('DeleteKey: lock the vault account', await vaultAdmin.send(VAULT, [deleteKey(kVault.pk)]), VAULT);
  t('vault account has no access keys', delV.ok && (await owner.keys(VAULT)).length === 0);
  const cfg = await owner.view(VAULT, 'config', {}); t('config().version is 1.1.0 (payouts) and the owner is set', cfg.version === '1.1.0' && cfg.owner === OWNER, JSON.stringify(cfg).slice(0, 120));

  step(3, 'the faucet is open: a stranger and the owner mint mock USDC (each pays the receiver storage if needed)');
  }
  if (!RESUME) {
  const kA = kf(); const kB = kf();
  rec('create alice (payee)', await owner.createSubAccount(ALICE, kA.pk, NEAR / 10n), OWNER); rec('create bob (NOT allowlisted)', await owner.createSubAccount(BOB, kB.pk, NEAR / 10n), OWNER);
  r = rec('stranger mints 50 USDC to the owner (needs storage deposit: owner not registered)', await stranger.call(TOKEN, 'mint', { account_id: OWNER, amount: String(50n * M) }, { deposit: NEAR / 400n, gas: 30n * TGAS }), STRANGER);
  t('stranger mint accepted; owner holds 50 USDC', r.ok && (await ftBal(OWNER)) === 50n * M, usd(await ftBal(OWNER)));
  r = rec('owner mints 150 more USDC to itself', await owner.call(TOKEN, 'mint', { account_id: OWNER, amount: String(150n * M) }, { deposit: 0n, gas: 30n * TGAS }), OWNER);
  t('owner now holds 200 USDC', r.ok && (await ftBal(OWNER)) === 200n * M, usd(await ftBal(OWNER)));
  }
  r = await stranger.call(TOKEN, 'mint', { account_id: OWNER, amount: String(10_001n * M) }, { deposit: 0n, gas: 30n * TGAS, allowFail: true });
  t('mint above the per-call ceiling is refused by the chain (E_MintCeiling)', !r.ok && /E_MintCeiling/.test(JSON.stringify(r.failure ?? r.summary ?? r)), String(r.failure ?? '').slice(-70));

  step(4, 'owner sets the leash: register accounts on the token, allow_token with caps, allow_payee (alice only), fund the vault with 100 USDC, grant a short mandate');
  const SKIP_SETUP = process.env.NEAR_SKIP_SETUP === 'yes';
  if (process.env.NEAR_VAULT_TOPUP) rec(`owner tops the vault up with ${process.env.NEAR_VAULT_TOPUP} NEAR (spendable NEAR above storage + 1 NEAR reserve)`, await owner.transfer(VAULT, BigInt(Math.round(Number(process.env.NEAR_VAULT_TOPUP) * 1000)) * (NEAR / 1000n)), OWNER);
  if (!SKIP_SETUP) {
  const reg = async (acct) => rec(`storage_deposit: register ${acct.split('.')[0]} on USDC`, await owner.call(TOKEN, 'storage_deposit', { account_id: acct, registration_only: true }, { deposit: NEAR / 400n, gas: 30n * TGAS }), OWNER);
  t('vault, alice and bob registered on the token', (await reg(VAULT)).ok && (await reg(ALICE)).ok && (await reg(BOB)).ok);
  r = rec('owner allow_token (per pay 10, per period 20, total 50 USDC)', await owner.call(VAULT, 'allow_token', { token: TOKEN, per_pay_cap: String(10n * M), period_cap: String(20n * M), total_cap: String(50n * M) }, { gas: 30n * TGAS }), OWNER);
  t('allow_token accepted', r.ok, r.txHash);
  r = rec('owner allow_payee alice', await owner.call(VAULT, 'allow_payee', { account: ALICE }, { gas: 30n * TGAS }), OWNER); t('allow_payee accepted', r.ok);
  r = rec('owner funds the vault: ft_transfer 100 USDC', await owner.call(TOKEN, 'ft_transfer', { receiver_id: VAULT, amount: String(100n * M) }, { deposit: 1n, gas: 30n * TGAS }), OWNER);
  t('vault holds 100 USDC', r.ok && (await ftBal(VAULT)) === 100n * M, usd(await ftBal(VAULT)));
  }
  const blk = (await rpcRaw('block', { finality: 'final' })).result.header; const nowS = Math.floor(Number(BigInt(blk.timestamp_nanosec) / 1_000_000_000n));
  const MANDATE = { agent: AGENT, expires_at: String(nowS + 3 * 3600), per_draw_cap: String(NEAR), period_secs: '3600', period_cap: String(NEAR), total_cap: String(NEAR), max_deploys: 1 };
  r = rec('owner set_mandate (agent, 3 h)', await owner.call(VAULT, 'set_mandate', MANDATE, { gas: 30n * TGAS }), OWNER); t('mandate set', r.ok, r.txHash);
  const toks = await owner.view(VAULT, 'tokens', {}); const pees = await owner.view(VAULT, 'payees', {});
  t('on-chain tokens/payees equal what the owner set', toks.length === 1 && toks[0].token === TOKEN && String(toks[0].per_pay_cap) === String(10n * M) && String(toks[0].total_cap) === String(50n * M) && pees.length === 1 && pees[0] === ALICE, JSON.stringify(toks).slice(0, 160));

  step(5, 'AGENT (call-limited signer) pays alice THROUGH the vault; the receipts are checked independently');
  const limits = { maxFeePerTx: (NEAR / 10n).toString(), allowedTargets: [VAULT], allowedMethods: ['pay'] };
  const signer = keystore.signer('near', adapter.signerOptions({ net, extra: { pollMs: 1500, timeoutMs: 120_000 } }));
  const settle = async (h) => { for (let i = 0; i < 40; i++) { const x = await rpcRaw('tx', { tx_hash: h, sender_account_id: AGENT, wait_until: 'FINAL' }); if (x.result) return x.result; await sleep(1500); } return null; };
  const agentPay = async (label, args) => { const x = await signer.signAndSend(adapter.buildCall('pay', { vault: VAULT, token: TOKEN, ...args }), limits); if (x.txHash) await settle(x.txHash); return rec(label, x, AGENT); };
  const agentBefore = await bal(AGENT);
  const p1 = await agentPay('agent pay 8 USDC to alice (memo "invoice 1")', { to: ALICE, amount: 8n * M, memo: 'invoice 1' });
  t('pay tx: all receipts succeeded', p1.ok && p1.status === 'success', `${p1.txHash} ${p1.finality}`);
  t('alice received exactly 8 USDC; the vault paid it', (await ftBal(ALICE)) === 8n * M && (await ftBal(VAULT)) === 92n * M, `alice ${usd(await ftBal(ALICE))}, vault ${usd(await ftBal(VAULT))}`);
  const vp = await adapter.verifyPay({ net, txHash: p1.txHash, vault: VAULT, agent: AGENT, token: TOKEN, to: ALICE, amount: String(8n * M), memo: 'invoice 1' });
  t(`adapter.verifyPay ok (${vp.checks.length} independent checks incl. vault event, token ft_transfer event, signer, receipts)`, vp.ok, vp.ok ? '' : JSON.stringify(vp.checks.filter((c) => !c.ok)).slice(0, 300));
  evidence.verifyPay = vp.checks.map((c) => ({ name: c.name, ok: c.ok }));
  const wrong = await adapter.verifyPay({ net, txHash: p1.txHash, vault: VAULT, agent: AGENT, token: TOKEN, to: ALICE, amount: String(9n * M), memo: 'invoice 1' });
  t('the same tx does NOT verify for a different amount', wrong.ok === false);
  const used = await owner.view(VAULT, 'token_usage', { token: TOKEN }); t('vault usage counted 8 USDC', String(used.total_spent) === String(8n * M), JSON.stringify(used).slice(0, 120));
  const gasBurnt = agentBefore - (await bal(AGENT)); console.log(`   agent paid about ${nearStr(gasBurnt)} in gas for the payment`);
  evidence.gas = { agentGasNear: nearStr(gasBurnt), note: 'measured on public testnet from the agent balance difference' };

  step(6, 'the leash holds on the real chain: refusals the chain itself produces');
  r = await agentPay('NEGATIVE pay 11 USDC (per-pay cap is 10)', { to: ALICE, amount: 11n * M });
  t('over per-pay cap: chain says E_PerPayCap', !r.ok && /E_PerPayCap/.test(r.failure ?? ''), String(r.failure).slice(-60));
  r = await agentPay('NEGATIVE pay to bob (registered on the token, NOT allowlisted)', { to: BOB, amount: 1n * M });
  t('payee not allowlisted: E_PayeeNotAllowed', !r.ok && /E_PayeeNotAllowed/.test(r.failure ?? ''), String(r.failure).slice(-60));
  r = await agentPay('NEGATIVE pay another token (not allowed)', { token: STRANGER, to: ALICE, amount: 1n * M });
  t('token not allowlisted: E_TokenNotAllowed', !r.ok && /E_TokenNotAllowed/.test(r.failure ?? ''), String(r.failure).slice(-60));
  const p2 = await agentPay('agent pay 10 USDC to alice', { to: ALICE, amount: 10n * M });
  const p3 = await agentPay('NEGATIVE third pay of 5 USDC (period cap 20, already 18 used)', { to: ALICE, amount: 5n * M });
  t('second 10 USDC accepted (18 of 20 used)', p2.ok && p2.status === 'success');
  t('over the period cap: chain says E_PeriodCap', !p3.ok && /E_PeriodCap/.test(p3.failure ?? ''), String(p3.failure).slice(-60));
  t('alice holds 18 USDC; nothing the refused calls asked for moved', (await ftBal(ALICE)) === 18n * M && (await ftBal(BOB)) === 0n, `alice ${usd(await ftBal(ALICE))}, bob ${usd(await ftBal(BOB))}`);

  step(7, 'kill switch: owner revokes; the agent is refused; the owner can still take the remaining USDC back');
  rec('owner revoke', await owner.call(VAULT, 'revoke', {}, { gas: 30n * TGAS }), OWNER);
  r = await agentPay('NEGATIVE pay after revoke', { to: ALICE, amount: 1n * M });
  t('after revoke: E_MandateInactive', !r.ok && /E_MandateInactive/.test(r.failure ?? ''), String(r.failure).slice(-60));
  const w = rec('owner withdraw_token 82 USDC back to itself while revoked', await owner.call(VAULT, 'withdraw_token', { token: TOKEN, amount: String(82n * M) }, { gas: 100n * TGAS }), OWNER);
  await sleep(4000);
  t('owner can still withdraw after revoke; vault USDC is 0', w.ok && (await ftBal(VAULT)) === 0n && (await ftBal(OWNER)) === 100n * M + 82n * M, `vault ${usd(await ftBal(VAULT))}, owner ${usd(await ftBal(OWNER))}`);
  evidence.final = { tokenUsage: await owner.view(VAULT, 'token_usage', { token: TOKEN }), alice: String(await ftBal(ALICE)), vaultUsdc: String(await ftBal(VAULT)) };
} catch (e) { R.fail++; R.failed.push(`script error: ${String(e?.message ?? e).slice(0, 200)}`); console.log(`\nFAIL  script error: ${e?.stack ?? e}`); }
finally {
  evidence.finishedAt = new Date().toISOString(); evidence.result = { pass: R.pass, fail: R.fail, failed: R.failed };
  evidence.scope = 'NEAR public testnet. Owner-side transactions are signed by a DEMO owner key held on the same machine as the agent key (automation, not a human). The token is a MOCK (open faucet, no value). Not an independent audit; no mainnet.';
  mkdirSync(dirname(EVIDENCE_OUT), { recursive: true }); writeFileSync(EVIDENCE_OUT, `${JSON.stringify(evidence, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
  console.log(`\nevidence written: ${EVIDENCE_OUT}`);
}
console.log(`\nRESULT: ${R.pass} PASS, ${R.fail} FAIL`); if (R.fail) console.log(`failed:\n  - ${R.failed.join('\n  - ')}`);
for (const x of evidence.txs) console.log(`  ${x.label}\n    ${x.explorer}`);
process.exit(R.fail ? 1 : 0);
