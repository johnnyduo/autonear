#!/usr/bin/env node
// End to end on the PUBLIC NEAR testnet for the "Add test USDC" button: the EXACT call the button sends (web/src/app/vaultView.js mintCall) is signed by a throw-away wallet through the NEP-518 relayer
// and mints mock USDC straight into the payouts vault; then the owner grants a short mandate and the AGENT (call-limited keystore signer) PAYS a payee from the minted funds, verified from the receipts.
// WHO SIGNS WHAT: scratch wallet = throw-away key in an injected provider (NOT a human, NOT MetaMask; mint is an open faucet so any wallet may call it). Demo owner key = set_mandate / revoke (automated).
// Run: NEAR_ETH_MINT_E2E=yes node web/src/wallet/e2e-mint.mjs     Evidence: docs/testnet/near-eth-mint-e2e.json
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.env.NEAR_ETH_MINT_E2E !== 'yes') { console.error('Refusing: this spends public-testnet NEAR. Re-run with NEAR_ETH_MINT_E2E=yes.'); process.exit(2); }
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const rf = globalThis.fetch; globalThis.fetch = async (u, i) => { for (let k = 0; ; k++) { const r = await rf(u, i); if (r.status !== 429 || k > 8 || !/near\.org/.test(String(u))) return r; await new Promise((ok) => setTimeout(ok, 1500 * 2 ** Math.min(k, 4))); } };
const { callNear, waitForReceipt, explorerTx, viewNear, balanceYocto } = await import('./nearEth.js');
const { testProvider } = await import('./testProvider.js'); const { mintCall } = await import('../app/vaultView.js');
const { generatePrivateKey } = await import('viem/accounts');
const { createNearAdmin } = await import('../../../src/agent/near-admin.js'); const { loadKeystore } = await import('../../../src/agent/keystore.js');
const { adapter } = await import('../../../src/vault/near.js');
const NEAR = 10n ** 24n; const M = 10n ** 6n; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OWNER = 'autonear-owner-1106.testnet'; const VAULT = 'vault-v2.autonear-owner-1106.testnet'; const TOKEN = 'usdc-v2.autonear-owner-1106.testnet'; const ALICE = 'alice-v2.autonear-owner-1106.testnet';
const RPC = 'https://rpc.testnet.fastnear.com'; const net = { id: 'near-testnet', protocol: 'near', rpc: RPC, explorer: 'https://testnet.nearblocks.io/txns/', mainnet: false, networkId: 'testnet' };
const ks = loadKeystore({ path: resolve(ROOT, 'data/agent.keys.json') }); const AGENT = ks.near.accountId;
const owner = createNearAdmin({ rpcUrl: RPC, accountId: OWNER, secretKey: JSON.parse(readFileSync(resolve(ROOT, 'data/demo-owner.keys.json'), 'utf8')).near.secretKey, networkId: 'testnet' });
const R = { pass: 0, fail: 0 }; const ev = { network: 'near-testnet', startedAt: new Date().toISOString(), vault: VAULT, token: TOKEN, txs: [], checks: [], signers: { scratchWallet: 'throw-away key (not a human, not MetaMask)', owner: `${OWNER} (demo owner key, automated)`, agent: `${AGENT} (agent keystore, call-limited: vault pay only)` } };
const t = (name, ok, detail = '') => { ev.checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 200) }); ok ? R.pass++ : R.fail++; console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); return ok; };
const usd = (v) => `${(Number(BigInt(v)) / 1e6).toFixed(2)} USDC`; const ft = async (a) => BigInt(await viewNear({ contract: TOKEN, method: 'ft_balance_of', args: { account_id: a } }));
const rpcRaw = async (method, params) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json());
try {
  const { generatePrivateKey: gen } = await import('viem/accounts'); const keyFile = resolve(ROOT, 'data/e2e-scratch-wallet.json');
  const pk = gen(); writeFileSync(keyFile, JSON.stringify({ note: 'throw-away testnet wallet key for e2e-mint.mjs', privateKey: pk }), { mode: 0o600 }); // saved BEFORE any money moves to it
  const provider = testProvider(pk); const A = provider.address; ev.scratchWallet = A; console.log(`scratch wallet ${A}\nvault ${VAULT}\ntoken ${TOKEN}`);
  const dec = JSON.parse(JSON.stringify(await viewNear({ contract: TOKEN, method: 'ft_metadata' }))).decimals; t('token metadata: mock USDC, 6 decimals (what the button reads)', dec === 6);
  const f = await owner.transfer(A, 15n * NEAR / 100n); ev.txs.push({ label: 'fund scratch wallet 0.15 NEAR', hash: f.txHash }); t('scratch wallet funded', f.ok);
  const send = async (label, call) => { const s = await callNear({ provider, account: A, ...call }); const rc = await waitForReceipt(s.hash); ev.txs.push({ label, hash: s.hash, explorer: explorerTx(s.hash), ok: rc.ok }); return rc.ok; };

  console.log('\n[1] the button: mint 100 USDC straight into the vault (one wallet signature, after the one-time relayer setup)');
  const v0 = await ft(VAULT); const reg = await viewNear({ contract: TOKEN, method: 'storage_balance_of', args: { account_id: VAULT } }); t('the vault is registered on the token, so no storage deposit is attached', Boolean(reg));
  const call = mintCall({ token: TOKEN, to: VAULT, base: 100n * M, decimals: 6, registered: reg }); t('the call is exactly mint(account_id = vault, amount = 100 USDC) with no deposit', call.method === 'mint' && call.args.account_id === VAULT && call.args.amount === String(100n * M) && call.deposit === 0n);
  t('mint accepted through the relayer', await send('scratch mint 100 USDC -> vault', call)); const v1 = await ft(VAULT);
  t('the vault holds exactly 100 USDC more', v1 - v0 === 100n * M, `${usd(v0)} -> ${usd(v1)}`);
  t('the wallet that pressed the button received nothing (the tokens went to the vault)', (await ft(A)) === 0n);

  console.log('\n[2] a receiver that is NOT registered on the token: the button attaches the storage deposit and it works');
  const fresh = `0x${'ab'.repeat(20)}`; const regFresh = await viewNear({ contract: TOKEN, method: 'storage_balance_of', args: { account_id: fresh } });
  const c2 = mintCall({ token: TOKEN, to: fresh, base: 5n * M, decimals: 6, registered: regFresh }); t('an unregistered receiver gets 0.0025 NEAR attached', regFresh === null && c2.deposit === 25n * 10n ** 20n);
  t('mint to an unregistered account accepted', await send('scratch mint 5 USDC -> unregistered account', c2)); t('it now holds 5 USDC and is registered', (await ft(fresh)) === 5n * M && Boolean(await viewNear({ contract: TOKEN, method: 'storage_balance_of', args: { account_id: fresh } })));

  console.log('\n[3] the ceiling is the contract\'s, not just the page\'s: a mint above 10,000 is refused on chain');
  const over = await send('scratch mint 10,001 USDC (over the ceiling)', { receiver: TOKEN, method: 'mint', args: { account_id: VAULT, amount: String(10_001n * M) }, deposit: 0n }).catch(() => false);
  t('above the per-call ceiling the chain refuses and nothing is added', over === false && (await ft(VAULT)) === v1);

  console.log('\n[4] "give it to the agent": the owner grants a short mandate, the agent PAYS a payee from the minted funds');
  const blk = (await rpcRaw('block', { finality: 'final' })).result.header; const nowS = Math.floor(Number(BigInt(blk.timestamp_nanosec) / 1_000_000_000n));
  const sm = await owner.call(VAULT, 'set_mandate', { agent: AGENT, expires_at: String(nowS + 2 * 3600), per_draw_cap: String(NEAR / 10n), period_secs: '3600', period_cap: String(NEAR / 5n), total_cap: String(NEAR / 5n), max_deploys: 1 }, { gas: 30n * 10n ** 12n }); ev.txs.push({ label: 'owner set_mandate (2 h)', hash: sm.txHash }); t('owner set a short mandate', sm.ok);
  const signer = ks.signer('near', adapter.signerOptions({ net, extra: { pollMs: 1500, timeoutMs: 120_000 } })); const limits = { maxFeePerTx: (NEAR / 10n).toString(), allowedTargets: [VAULT], allowedMethods: ['pay'] };
  const a0 = await ft(ALICE); const r = await signer.signAndSend(adapter.buildCall('pay', { vault: VAULT, token: TOKEN, to: ALICE, amount: 5n * M, memo: 'minted with the button' }), limits);
  for (let i = 0; i < 40 && r.txHash; i++) { const x = await rpcRaw('tx', { tx_hash: r.txHash, sender_account_id: AGENT, wait_until: 'FINAL' }); if (x.result && !x.error) break; await sleep(1500); }
  ev.txs.push({ label: 'agent pay 5 USDC -> alice (from the minted funds)', hash: r.txHash, explorer: `https://testnet.nearblocks.io/txns/${r.txHash}`, ok: r.ok });
  t('the agent paid alice 5 USDC from the minted funds', r.ok && (await ft(ALICE)) - a0 === 5n * M && (await ft(VAULT)) === v1 - 5n * M, `alice +${usd((await ft(ALICE)) - a0)}, vault ${usd(await ft(VAULT))}`);
  const vp = await adapter.verifyPay({ net, txHash: r.txHash, vault: VAULT, agent: AGENT, token: TOKEN, to: ALICE, amount: String(5n * M), memo: 'minted with the button' }); t(`verifyPay ok on the real receipts (${vp.checks.length} checks)`, vp.ok, vp.ok ? '' : JSON.stringify(vp.checks.filter((c) => !c.ok)).slice(0, 200));
  const rv = await owner.call(VAULT, 'revoke', {}, { gas: 30n * 10n ** 12n }); ev.txs.push({ label: 'owner revoke (leave the vault safe)', hash: rv.txHash }); t('owner revoked the mandate again; the vault keeps the remaining USDC', rv.ok && (await ft(VAULT)) === v1 - 5n * M, usd(await ft(VAULT)));
  const left = await balanceYocto(A); if (left > 5n * NEAR / 100n) { try { await send('scratch sweeps spare NEAR to the demo owner', { receiver: OWNER, method: null, deposit: left - 4n * NEAR / 100n }); } catch { /* best effort */ } }
} catch (e) { R.fail++; console.log(`\nFAIL  script error: ${e?.stack ?? e}`); ev.error = String(e?.message ?? e).slice(0, 300); }
finally {
  ev.finishedAt = new Date().toISOString(); ev.result = { pass: R.pass, fail: R.fail }; ev.scope = 'NEAR public testnet. Wallet key is a throw-away test key (not a human, not MetaMask). The token is a MOCK (open faucet, no value). Not an independent audit; no mainnet.';
  const out = resolve(ROOT, 'docs/testnet/near-eth-mint-e2e.json'); mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, `${JSON.stringify(ev, null, 2)}\n`);
  console.log(`\nevidence: ${out}\nRESULT: ${R.pass} PASS, ${R.fail} FAIL`); process.exit(R.fail ? 1 : 0);
}
