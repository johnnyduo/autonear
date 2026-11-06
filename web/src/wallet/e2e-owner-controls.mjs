#!/usr/bin/env node
// End to end on the PUBLIC NEAR testnet for EVERY owner control a vault owner uses from an 0x wallet, through the NEP-518 relayer and the REAL web code (web/src/wallet/nearEth.js):
// take ownership (one-time relayer setup + accept_ownership), fund the vault (plain transfer), pause / unpause, set_mandate, revoke, withdraw, hand the vault back.
// WHO SIGNS WHAT: a THROW-AWAY wallet key made here, held by an injected EIP-1193 provider (testProvider.js). NOT a human, NOT MetaMask (MetaMask differs only in how it shows and submits the same
// eth_sendTransaction). The demo owner key (data/demo-owner.keys.json) first moves spare NEAR out of the scratch vault into itself, funds the scratch wallet, and finally gets the vault back.
// Run: NEAR_ETH_OWNER_E2E=yes node web/src/wallet/e2e-owner-controls.mjs      Evidence: docs/testnet/near-eth-owner-controls-e2e.json
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.env.NEAR_ETH_OWNER_E2E !== 'yes') { console.error('Refusing: this spends public-testnet NEAR. Re-run with NEAR_ETH_OWNER_E2E=yes.'); process.exit(2); }
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const rf = globalThis.fetch; globalThis.fetch = async (u, i) => { for (let k = 0; ; k++) { const r = await rf(u, i); if (r.status !== 429 || k > 8 || !/near\.org/.test(String(u))) return r; await new Promise((ok) => setTimeout(ok, 1500 * 2 ** Math.min(k, 4))); } };
const { callNear, waitForReceipt, onboardingStatus, balanceYocto, explorerTx, viewNear } = await import('./nearEth.js');
const { testProvider } = await import('./testProvider.js');
const { generatePrivateKey } = await import('viem/accounts');
const { createNearAdmin } = await import('../../../src/agent/near-admin.js');
const { loadKeystore } = await import('../../../src/agent/keystore.js');
const NEAR = 10n ** 24n; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OWNER = process.env.NEAR_OWNER_ACCOUNT ?? 'autonear-owner-1106.testnet'; const VAULT = process.env.NEAR_PAY_VAULT ?? 'vault-v2.autonear-owner-1106.testnet';
const AGENT = loadKeystore({ path: resolve(ROOT, 'data/agent.keys.json') }).near.accountId;
const owner = createNearAdmin({ rpcUrl: 'https://rpc.testnet.fastnear.com', accountId: OWNER, secretKey: JSON.parse(readFileSync(resolve(ROOT, 'data/demo-owner.keys.json'), 'utf8')).near.secretKey, networkId: 'testnet' });
const R = { pass: 0, fail: 0 }; const ev = { network: 'near-testnet', startedAt: new Date().toISOString(), vault: VAULT, txs: [], checks: [], signers: { scratchWallet: 'throw-away key, injected provider (not a human, not MetaMask)', owner: `${OWNER} (demo owner key, automated)` } };
const t = (name, ok, detail = '') => { ev.checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 200) }); ok ? R.pass++ : R.fail++; console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); return ok; };
const transient = /408|429|50[234]|timeout|timed out|fetch failed|ECONN|socket/i;
const retry = async (fn, n = 4) => { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= n || !transient.test(String(e?.message ?? e))) throw e; await sleep(3000 * (i + 1)); } } };
const cfg = () => viewNear({ contract: VAULT, method: 'config' }); const near = (y) => `${(Number(BigInt(y) / 10n ** 20n) / 1e4).toFixed(4)} NEAR`;
const vaultBal = async () => BigInt((await (await fetch('https://rpc.testnet.fastnear.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: VAULT } }) })).json()).result.amount);
try {
  const keyFile = resolve(ROOT, 'data/e2e-scratch-wallet.json'); // saved BEFORE any money is sent to it, so a failed run never strands funds; reused with NEAR_ETH_RESUME=yes
  let pk = process.env.NEAR_ETH_RESUME === 'yes' && existsSync(keyFile) ? JSON.parse(readFileSync(keyFile, 'utf8')).privateKey : null;
  if (!pk) { pk = generatePrivateKey(); writeFileSync(keyFile, JSON.stringify({ note: 'throw-away testnet wallet key for e2e-owner-controls.mjs', privateKey: pk }), { mode: 0o600 }); }
  const provider = testProvider(pk); const A = provider.address; ev.scratchWallet = A; console.log(`scratch wallet ${A}\nvault ${VAULT}`);
  const c0 = await cfg(); if (c0.owner !== OWNER) throw new Error(`vault must be owned by ${OWNER} to start (found owner ${c0.owner}); a leftover pending owner is simply replaced`);
  const send = async (label, o) => { const s = await callNear({ provider, account: A, ...o }); const rc = await waitForReceipt(s.hash); ev.txs.push({ label, hash: s.hash, explorer: explorerTx(s.hash), ok: rc.ok }); return rc.ok; };

  console.log('\n[0] the demo owner takes spare NEAR out of the vault (budget for this run), funds the scratch wallet, offers it the vault');
  const ownerBal = async () => BigInt((await retry(() => owner.account(OWNER))).amount);
  if ((await ownerBal()) < 12n * NEAR / 10n) { const avail = BigInt((await retry(() => viewNear({ contract: VAULT, method: 'available' })))); const take = avail > 9n * NEAR / 10n ? 9n * NEAR / 10n : 0n;
    if (take > 0n) { const w = await retry(() => owner.call(VAULT, 'withdraw', { amount: String(take) })); ev.txs.push({ label: 'demo owner withdraw (budget)', hash: w.txHash }); t(`demo owner took ${near(take)} of spare NEAR out of the vault`, w.ok); } }
  const scratchBal = async () => { try { return await balanceYocto(A); } catch { return 0n; } };
  if ((await scratchBal()) < 4n * NEAR / 10n) { const f = await retry(() => owner.transfer(A, 55n * NEAR / 100n)); ev.txs.push({ label: 'fund scratch wallet 0.55 NEAR', hash: f.txHash }); t('scratch wallet funded', f.ok); } else t('scratch wallet already funded', true, near(await scratchBal()));
  if ((await cfg()).pending_owner !== A) { const o = await retry(() => owner.call(VAULT, 'transfer_ownership', { to: A })); ev.txs.push({ label: 'transfer_ownership -> scratch wallet', hash: o.txHash }); }
  t('vault is offered to the scratch wallet', (await cfg()).pending_owner === A);

  console.log('\n[1] take ownership: one-time relayer setup, then accept_ownership');
  t('onboardingStatus is false before the setup', (await onboardingStatus(A)).onboarded === false);
  t('accept_ownership', await send('scratch accept_ownership (with one-time setup)', { receiver: VAULT, method: 'accept_ownership', args: {} }));
  t('relayer key present now; vault owner is the scratch wallet', (await onboardingStatus(A)).onboarded && (await cfg()).owner === A);

  console.log('\n[2] fund the vault with a plain transfer from the wallet');
  const b0 = await vaultBal();
  t('transfer 0.05 NEAR to the vault', await send('scratch transfer 0.05 NEAR -> vault', { receiver: VAULT, method: null, deposit: 5n * NEAR / 100n }));
  const b1 = await vaultBal(); t('the vault balance rose by exactly 0.05 NEAR', b1 - b0 === 5n * NEAR / 100n, `${near(b0)} -> ${near(b1)}`);

  console.log('\n[3] pause and unpause');
  t('pause', await send('scratch pause', { receiver: VAULT, method: 'pause', args: {} })); t('vault is paused on chain', (await cfg()).paused === true);
  t('unpause', await send('scratch unpause', { receiver: VAULT, method: 'unpause', args: {} })); t('vault runs again', (await cfg()).paused === false);

  console.log('\n[4] set_mandate, then revoke');
  const blk = await (await fetch('https://rpc.testnet.fastnear.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'block', params: { finality: 'final' } }) })).json(); const nowS = Math.floor(Number(BigInt(blk.result.header.timestamp_nanosec) / 1_000_000_000n));
  const args = { agent: AGENT, expires_at: String(nowS + 3600), per_draw_cap: String(NEAR / 10n), period_secs: '3600', period_cap: String(NEAR / 5n), total_cap: String(NEAR / 5n), max_deploys: 1 };
  t('set_mandate', await send('scratch set_mandate', { receiver: VAULT, method: 'set_mandate', args }));
  const m = await viewNear({ contract: VAULT, method: 'mandate' }); t('the mandate is on chain and active (agent, caps as signed)', m && m.agent === AGENT && !m.revoked && String(m.total_cap) === String(NEAR / 5n), JSON.stringify(m).slice(0, 140));
  t('revoke', await send('scratch revoke', { receiver: VAULT, method: 'revoke', args: {} })); t('the mandate shows revoked', (await viewNear({ contract: VAULT, method: 'mandate' }))?.revoked === true);

  console.log('\n[5] withdraw (works while revoked)');
  const wb = await balanceYocto(A); const v0 = await vaultBal();
  t('withdraw 0.05 NEAR to the wallet', await send('scratch withdraw 0.05 NEAR', { receiver: VAULT, method: 'withdraw', args: { amount: String(5n * NEAR / 100n) } }));
  const v1 = await vaultBal(); t('the vault balance fell by exactly 0.05 NEAR', v0 - v1 === 5n * NEAR / 100n, `${near(v0)} -> ${near(v1)}`);
  t('the wallet received it (net of the relayer fee)', (await balanceYocto(A)) > wb - NEAR / 20n + 4n * NEAR / 100n - NEAR / 100n, `${near(wb)} -> ${near(await balanceYocto(A))}`);

  console.log('\n[6] hand the vault back to the demo owner');
  t('scratch wallet offered the vault back', await send('scratch transfer_ownership -> demo owner', { receiver: VAULT, method: 'transfer_ownership', args: { to: OWNER } }));
  const acc = await retry(() => owner.call(VAULT, 'accept_ownership', {})); ev.txs.push({ label: 'demo owner accept_ownership', hash: acc.txHash });
  const c2 = await cfg(); t('vault is owned by the demo owner again', acc.ok && c2.owner === OWNER && !c2.pending_owner, c2.owner);
  const left = await balanceYocto(A); if (left > 12n * NEAR / 100n) { try { await send('scratch sweeps its spare NEAR back to the demo owner', { receiver: OWNER, method: null, deposit: left - 10n * NEAR / 100n }); } catch { /* best effort */ } }
} catch (e) { R.fail++; console.log(`\nFAIL  script error: ${e?.stack ?? e}`); ev.error = String(e?.message ?? e).slice(0, 300); }
finally {
  ev.finishedAt = new Date().toISOString(); ev.result = { pass: R.pass, fail: R.fail };
  ev.scope = 'NEAR public testnet. The wallet key is a throw-away test key (not a human, not MetaMask). Not an independent audit; no mainnet.';
  const out = resolve(ROOT, 'docs/testnet/near-eth-owner-controls-e2e.json'); mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, `${JSON.stringify(ev, null, 2)}\n`);
  console.log(`\nevidence: ${out}\nRESULT: ${R.pass} PASS, ${R.fail} FAIL`); process.exit(R.fail ? 1 : 0);
}
