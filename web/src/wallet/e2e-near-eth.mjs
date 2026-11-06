#!/usr/bin/env node
// End to end on the PUBLIC NEAR testnet: owner actions on a scratch vault signed as an Ethereum wallet through the NEP-518 relayer.
// WHO SIGNS WHAT: the owner signature comes from a TEST key (data/demo-owner.keys.json, evm.privateKey) held by an injected EIP-1193 provider
// (src/wallet/testProvider.js). That is NOT the user's MetaMask. The scratch vault is created by a funded named account (autonear-fund-1106-d) that uses the agent key.
// Run: NEAR_ETH_E2E=yes node web/src/wallet/e2e-near-eth.mjs  (NEAR_ETH_RESUME=yes continues on an existing scratch vault; NEAR_ETH_FROM=unpause also skips the funding, allowlist, limits and pause steps)     (budget: about 6 NEAR of testnet funds; most of it is recovered by the final withdraw)
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.NEAR_ETH_E2E !== 'yes') { console.error('Refusing: this spends public-testnet NEAR. Re-run with NEAR_ETH_E2E=yes.'); process.exit(2); }
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const rf = globalThis.fetch; globalThis.fetch = async (u, i) => { for (let k = 0; ; k++) { const r = await rf(u, i); if (r.status !== 429 || k > 8 || !/near\.org/.test(String(u))) return r; await new Promise((ok) => setTimeout(ok, 1500 * 2 ** Math.min(k, 4))); } };
const { callNear, waitForReceipt, balanceYocto, explorerTx, viewNear, relayer } = await import('./nearEth.js');
const { testProvider } = await import('./testProvider.js');
const { createNearAdmin, deleteKey } = await import(`${ROOT}/src/agent/near-admin.js`);
const { generateSeed, formatSecretKey, formatPublicKey, ed25519PublicKey } = await import(`${ROOT}/src/agent/near-signer.js`);
const { adapter, VAULT_WASM_PATH, REGISTRY_WASM_PATH, sha256Hex } = await import(`${ROOT}/src/vault/near.js`);

const NEAR = 10n ** 24n; const TGAS = 10n ** 12n; const RPC = 'https://rpc.testnet.fastnear.com';
const TAG = process.env.NEAR_ETH_TAG ?? 'e2e1';
const D = 'autonear-fund-1106-d.testnet'; const E = 'autonear-fund-1106-e.testnet'; const VAULT = `vault-${TAG}.${D}`;
const nearStr = (y) => `${(Number(BigInt(y) / 10n ** 20n) / 1e4).toFixed(4)} NEAR`;
const agentSecret = JSON.parse(readFileSync(`${ROOT}/data/agent.keys.json`, 'utf8')).near.secretKey;
const ownerKey = JSON.parse(readFileSync(`${ROOT}/data/demo-owner.keys.json`, 'utf8')).evm.privateKey; // never printed
const as = (id, sk = agentSecret) => createNearAdmin({ rpcUrl: RPC, accountId: id, secretKey: sk, networkId: 'testnet' });
const provider = testProvider(ownerKey); const OWNER = provider.address;
const net = { id: 'near-testnet', protocol: 'near', rpc: RPC, mainnet: false, networkId: 'testnet' };
const AGENT = (await import(`${ROOT}/src/agent/keystore.js`)).loadKeystore({ path: `${ROOT}/data/agent.keys.json` }).near.accountId;

const ev = { network: 'near-testnet', note: 'Owner-side transactions were signed by a TEST key through an injected EIP-1193 provider (viem local account), not by the user\'s MetaMask. Relayer: eth-rpc.testnet.near.org (NEP-518).', owner: OWNER, vault: VAULT, startedAt: new Date().toISOString(), steps: [], checks: [] };
const EVFILE = resolve(dirname(fileURLToPath(import.meta.url)), `e2e-near-eth.${TAG}.evidence.json`);
if (process.env.NEAR_ETH_RESUME === 'yes') { try { const prev = JSON.parse(readFileSync(EVFILE, 'utf8')); ev.steps = prev.steps ?? []; ev.checks = (prev.checks ?? []).filter((c) => c.ok); ev.startedAt = prev.startedAt ?? ev.startedAt; ev.resumedAt = new Date().toISOString(); } catch { /* first run */ } }
let pass = ev.checks.filter((c) => c.ok).length; let fail = 0;
const t = (name, ok, detail = '') => { ev.checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 200) }); if (ok) pass++; else fail++; console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); return ok; };
const RESUME = process.env.NEAR_ETH_RESUME === 'yes';
const state = async () => { for (let i = 0; ; i++) { try { return await adapter.readState({ net, vault: VAULT, now: Math.floor(Date.now() / 1000) }); } catch (e) { if (i >= 14) throw e; await new Promise((ok) => setTimeout(ok, 9000)); } } };
async function owner(label, spec) {
  const r = await callNear({ provider, account: OWNER, ...spec }); const w = await waitForReceipt(r.hash);
  ev.steps.push({ label, signer: `${OWNER} (test key, injected provider)`, relayerHash: r.hash, ok: w.ok, explorer: explorerTx(r.hash) });
  console.log(`   ${w.ok ? 'ok  ' : 'FAIL'} ${label}  ${explorerTx(r.hash)}`); return w;
}
try {
  console.log(`scratch vault ${VAULT}\nowner (0x account) ${OWNER}  liquid ${nearStr(await balanceYocto(OWNER))}`);
  if (!RESUME) {
  console.log('\n[1] setup with named accounts (agent key): create the vault account, deploy the vault wasm, hand it to a named owner, lock it');
  const kv = (() => { const s = generateSeed(); return { sk: formatSecretKey(s), pk: formatPublicKey(ed25519PublicKey(s)) }; })();
  const d = as(D);
  const c = await d.createSubAccount(VAULT, kv.pk, 5n * NEAR + NEAR / 5n); t('vault account created and funded', c.ok, c.txHash);
  const va = as(VAULT, kv.sk);
  const init = await va.deploy(VAULT, new Uint8Array(readFileSync(VAULT_WASM_PATH)), { method: 'new', args: { owner: E, network_id: 'testnet' }, gas: 30n * TGAS }); t('vault wasm deployed and initialised (owner = a named account)', init.ok, init.txHash);
  const vc = await adapter.verifyVaultCode({ net, vault: VAULT }); t('on-chain code hash == contracts/near-vault/dist/autonear_vault.wasm', vc.ok);
  t('vault account locked', (await va.send(VAULT, [deleteKey(kv.pk)])).ok);
  const tr = await as(E).call(VAULT, 'transfer_ownership', { to: OWNER }); t('named owner proposes the 0x account as new owner', tr.ok, tr.txHash);
  }
  let st = await state(); if (!RESUME) t('pending_owner is the 0x account', st.config.pendingOwner === OWNER, JSON.stringify(st.config).slice(0, 120));

  console.log('\n[2] the 0x account signs through the relayer');
  let w = { ok: true };
  if (st.config.pendingOwner === OWNER) w = await owner('accept_ownership', { receiver: VAULT, method: 'accept_ownership', args: {}, gas: 30n * TGAS });
  st = await state(); t('accept_ownership: the 0x account is now the vault owner', w.ok && st.config.owner === OWNER && !st.config.pendingOwner, `owner ${st.config.owner}`);

  const FROM = process.env.NEAR_ETH_FROM ?? '';
  if (!FROM) {
  const before = await balanceYocto(OWNER);
  w = await owner('plain transfer 0.3 NEAR into the vault', { receiver: VAULT, method: null, deposit: NEAR * 3n / 10n });
  t('transfer into the vault arrived', w.ok, nearStr(before - (await balanceYocto(OWNER))) + ' left the owner');

  const manifest = { sha256: sha256Hex(new Uint8Array(readFileSync(REGISTRY_WASM_PATH))), bytes: readFileSync(REGISTRY_WASM_PATH).length };
  const approved = { action: 'deploy_testnet', protocol: 'near', network: 'testnet', registry: { owner: OWNER, proposer: AGENT, maxSpendCap: '0', networkId: 'testnet', contractAccount: `reg1.${VAULT}` } };
  const exp = adapter.expectedTemplate({ manifest, payload: approved, vault: VAULT });
  w = await owner('allow_template (registry wasm, fixed init args)', { receiver: VAULT, method: 'allow_template', args: exp.allowTemplateArgs, gas: 30n * TGAS });
  st = await state(); t('allow_template: the template is on the vault allowlist with the approved init args', w.ok && st.templates.length === 1 && st.templates[0].id === exp.templateId && adapter.checkTemplate({ state: st, expected: exp }).ok);

  const blk = (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'block', params: { finality: 'final' } }) })).json()).result.header; const now = Math.floor(Number(BigInt(blk.timestamp_nanosec) / 1_000_000_000n));
  const mandate = { agent: AGENT, expires_at: String(now + 3600), per_draw_cap: String(NEAR / 2n), period_secs: '3600', period_cap: String(NEAR), total_cap: String(NEAR), max_deploys: 1 };
  w = await owner('set_mandate', { receiver: VAULT, method: 'set_mandate', args: mandate, gas: 30n * TGAS });
  st = await state(); t('set_mandate: limits are active on chain', w.ok && st.mandate?.active && st.mandate.totalCap === mandate.total_cap && st.mandate.agent === AGENT);

  }
  if (!FROM) {
  w = await owner('pause', { receiver: VAULT, method: 'pause', args: {}, gas: 30n * TGAS }); st = await state(); t('pause: vault is paused', w.ok && st.config.paused === true);
  }
  w = await owner('unpause', { receiver: VAULT, method: 'unpause', args: {}, gas: 30n * TGAS }); st = await state(); t('unpause: vault is running again', w.ok && st.config.paused === false);
  w = await owner('revoke', { receiver: VAULT, method: 'revoke', args: {}, gas: 30n * TGAS }); st = await state(); t('revoke: limits are revoked', w.ok && st.mandate?.revoked === true && st.mandate.active === false);

  const avail = BigInt(st.available); const wd = avail > NEAR / 100n ? avail - NEAR / 100n : 0n; const ob = await balanceYocto(OWNER);
  w = await owner(`withdraw ${nearStr(wd)} back to the owner`, { receiver: VAULT, method: 'withdraw', args: { amount: String(wd) }, gas: 30n * TGAS });
  const oa = await balanceYocto(OWNER); t('withdraw: the owner balance went up (after relayer fees)', w.ok && oa > ob + wd * 9n / 10n, `${nearStr(ob)} -> ${nearStr(oa)}`);
  st = await state(); t('the vault no longer shows the owner as pending', !JSON.stringify(st.config).includes('"pendingOwner":"0x'));
} catch (e) { fail++; console.log(`\nFAIL  ${e?.stack ?? e}`); ev.error = String(e?.message ?? e).slice(0, 300); }
finally {
  ev.finishedAt = new Date().toISOString(); ev.result = { pass, fail };
  writeFileSync(EVFILE, `${JSON.stringify(ev, null, 2)}\n`);
  console.log(`\nRESULT: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}
