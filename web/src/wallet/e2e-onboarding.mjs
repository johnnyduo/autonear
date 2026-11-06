#!/usr/bin/env node
// End to end on the PUBLIC NEAR testnet for the exact flow an owner wallet (an 0x account) goes through to take over a vault: one-time relayer setup, then accept_ownership,
// through the NEP-518 relayer, using the REAL web code (web/src/wallet/nearEth.js). Regression for: the node answering "no such access key" as { result: { error } } made the app
// believe the setup was done, skip it, and every transaction failed.
// WHO SIGNS WHAT: a THROW-AWAY wallet key made here, held by an injected EIP-1193 provider (testProvider.js). NOT a human, NOT the user's MetaMask. The demo owner key (data/demo-owner.keys.json)
// funds the scratch wallet with 0.25 NEAR and hands the vault over to it; the scratch wallet hands the vault straight back. Budget: well under 1 NEAR of testnet funds.
// Run: NEAR_ETH_ONBOARD_E2E=yes node web/src/wallet/e2e-onboarding.mjs        Evidence: docs/testnet/near-eth-onboarding-e2e.json
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.env.NEAR_ETH_ONBOARD_E2E !== 'yes') { console.error('Refusing: this spends public-testnet NEAR. Re-run with NEAR_ETH_ONBOARD_E2E=yes.'); process.exit(2); }
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const rf = globalThis.fetch; globalThis.fetch = async (u, i) => { for (let k = 0; ; k++) { const r = await rf(u, i); if (r.status !== 429 || k > 8 || !/near\.org/.test(String(u))) return r; await new Promise((ok) => setTimeout(ok, 1500 * 2 ** Math.min(k, 4))); } };
const { callNear, waitForReceipt, onboardingStatus, explorerTx, viewNear } = await import('./nearEth.js');
const { testProvider } = await import('./testProvider.js');
const { generatePrivateKey } = await import('viem/accounts');
const { createNearAdmin } = await import('../../../src/agent/near-admin.js');
const NEAR = 10n ** 24n;
const OWNER = process.env.NEAR_OWNER_ACCOUNT ?? 'autonear-owner-1106.testnet'; const VAULT = process.env.NEAR_PAY_VAULT ?? 'vault-v2.autonear-owner-1106.testnet';
const ownerKey = JSON.parse(readFileSync(resolve(ROOT, 'data/demo-owner.keys.json'), 'utf8')).near.secretKey;
const owner = createNearAdmin({ rpcUrl: 'https://rpc.testnet.fastnear.com', accountId: OWNER, secretKey: ownerKey, networkId: 'testnet' });
const R = { pass: 0, fail: 0 }; const ev = { network: 'near-testnet', startedAt: new Date().toISOString(), vault: VAULT, txs: [], checks: [], signers: { scratchWallet: 'throw-away key, injected provider (not a human, not MetaMask)', owner: `${OWNER} (demo owner key, automated)` } };
const t = (name, ok, detail = '') => { ev.checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 200) }); ok ? R.pass++ : R.fail++; console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); return ok; };
const cfg = () => viewNear({ contract: VAULT, method: 'config' });
try {
  const provider = testProvider(generatePrivateKey()); const A = provider.address; ev.scratchWallet = A; console.log(`scratch wallet ${A}\nvault ${VAULT}`);
  const c0 = await cfg(); if (c0.owner !== OWNER || c0.pending_owner) throw new Error(`vault must start owned by ${OWNER} with no pending owner (found owner ${c0.owner}, pending ${c0.pending_owner})`);

  console.log('\n[1] owner funds the scratch wallet and offers it the vault');
  const f = await owner.transfer(A, 25n * NEAR / 100n); ev.txs.push({ label: 'owner funds scratch wallet 0.25 NEAR', hash: f.txHash });
  t('scratch wallet funded (account created by the transfer)', f.ok, f.txHash);
  const o = await owner.call(VAULT, 'transfer_ownership', { to: A }); ev.txs.push({ label: 'owner transfer_ownership -> scratch wallet', hash: o.txHash });
  t('vault shows the scratch wallet as pending_owner', o.ok && (await cfg()).pending_owner === A, A);

  console.log('\n[2] the regression: the chain has NO relayer key yet, and the app must say so');
  const before = await onboardingStatus(A);
  t('onboardingStatus is FALSE for an account whose relayer key is missing (the node answers { result: { error } })', before.onboarded === false);

  console.log('\n[3] accept_ownership through the real app code: one-time setup, then the call');
  const sent = await callNear({ provider, account: A, receiver: VAULT, method: 'accept_ownership', args: {} });
  ev.txs.push({ label: 'scratch wallet accept_ownership (via relayer)', hash: sent.hash, explorer: explorerTx(sent.hash) });
  const rc = await waitForReceipt(sent.hash);
  t('the relayer accepted and the NEAR action succeeded', rc.ok, sent.hash);
  t('the relayer key is now on the account', (await onboardingStatus(A)).onboarded === true);
  const c1 = await cfg(); t('vault owner is now the scratch wallet; no pending owner', c1.owner === A && !c1.pending_owner, `${c1.owner}`);
  t('provider asked the wallet to sign exactly twice (setup + call)', provider.log.filter((m) => m === 'eth_sendTransaction').length === 2, provider.log.filter((m) => m === 'eth_sendTransaction').length);

  console.log('\n[4] hand the vault straight back to the demo owner');
  const back = await callNear({ provider, account: A, receiver: VAULT, method: 'transfer_ownership', args: { to: OWNER } });
  ev.txs.push({ label: 'scratch wallet transfer_ownership -> demo owner', hash: back.hash, explorer: explorerTx(back.hash) });
  t('scratch wallet offered the vault back', (await waitForReceipt(back.hash)).ok);
  const acc = await owner.call(VAULT, 'accept_ownership', {}); ev.txs.push({ label: 'owner accept_ownership', hash: acc.txHash });
  const c2 = await cfg(); t('vault is owned by the demo owner again', acc.ok && c2.owner === OWNER && !c2.pending_owner, c2.owner);
} catch (e) { R.fail++; console.log(`\nFAIL  script error: ${e?.stack ?? e}`); ev.error = String(e?.message ?? e).slice(0, 300); }
finally {
  ev.finishedAt = new Date().toISOString(); ev.result = { pass: R.pass, fail: R.fail };
  ev.scope = 'NEAR public testnet. The wallet key is a throw-away test key (not a human, not MetaMask). Not an independent audit; no mainnet.';
  const out = resolve(ROOT, 'docs/testnet/near-eth-onboarding-e2e.json'); mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, `${JSON.stringify(ev, null, 2)}\n`);
  console.log(`\nevidence: ${out}\nRESULT: ${R.pass} PASS, ${R.fail} FAIL`); process.exit(R.fail ? 1 : 0);
}
