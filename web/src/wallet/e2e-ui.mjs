#!/usr/bin/env node
// Browser end to end for the NEAR owner controls: the real web app (vite dev) + a real API process + a TEST wallet injected as an EIP-6963 provider
// (src/wallet/testProvider.js signs with data/demo-owner.keys.json evm.privateKey). It is NOT the user's MetaMask. Spends a little NEAR on testnet.
// Prerequisite: a scratch vault proposed to the test account (see e2e-near-eth.mjs, or NEAR_UI_VAULT=<vault account id>).
// Run: NEAR_ETH_E2E=yes NEAR_UI_VAULT=vault-ui1.autonear-fund-1106-e.testnet node web/src/wallet/e2e-ui.mjs
import { spawn } from 'node:child_process';
import { readFileSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
if (process.env.NEAR_ETH_E2E !== 'yes') { console.error('Refusing: this spends public-testnet NEAR. Re-run with NEAR_ETH_E2E=yes.'); process.exit(2); }
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'); const VAULT = process.env.NEAR_UI_VAULT; if (!VAULT) { console.error('Set NEAR_UI_VAULT'); process.exit(2); }
const require = createRequire('/private/tmp/claude-501/pw/'); const { chromium } = require('playwright');
const { testProvider } = await import('./testProvider.js'); const { viewNear } = await import('./nearEth.js');
const key = JSON.parse(readFileSync(`${ROOT}/data/demo-owner.keys.json`, 'utf8')).evm.privateKey; const wallet = testProvider(key);
const opToken = readFileSync(`${ROOT}/data/operator.token`, 'utf8').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DB = '/private/tmp/claude-501/fork/ui-e2e.db'; copyFileSync('/private/tmp/claude-501/-Library-WebServer-Documents-autonear/4beae4f4-1f79-40ba-884a-9a826a874691/scratchpad/data/autonear.db', DB);
const api = spawn('node', ['src/server.js'], { cwd: ROOT, env: { ...process.env, DB_PATH: DB, PORT: '8799', OWNER_ADDRESS: wallet.address }, stdio: 'ignore' });
const VCFG = `${ROOT}/web/.vite.e2e.config.mjs`; // temporary; removed on exit
writeFileSync(VCFG, `import { defineConfig } from 'vite'; import react from '@vitejs/plugin-react'; export default defineConfig({ root: '${ROOT}/web', plugins: [react()], server: { port: 5201, proxy: { '/api': 'http://127.0.0.1:8799' } } });`);
const vite = spawn(`${ROOT}/web/node_modules/.bin/vite`, ['--config', VCFG, '--host', '127.0.0.1'], { cwd: `${ROOT}/web`, stdio: 'ignore' });
const stop = () => { try { api.kill(); vite.kill(); rmSync(VCFG, { force: true }); } catch { /* gone */ } }; process.on('exit', stop);
let pass = 0; let fail = 0; const t = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  (${d})` : ''}`); };
try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch('http://127.0.0.1:8799/api/health')).ok && (await fetch('http://127.0.0.1:5201/')).ok) break; } catch { /* starting */ } await sleep(500); }
  const at = await fetch('http://127.0.0.1:8799/api/vault/attach', { method: 'POST', headers: { authorization: `Bearer ${opToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ chainId: 'near-testnet', address: VAULT }) }); t('scratch API attached the NEAR vault', at.status === 201 || at.status === 200, `HTTP ${at.status}`);
  const b = await chromium.launch(); const page = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage(); const errs = []; globalThis.__page = page; globalThis.__errs = errs; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
  await page.exposeFunction('__walletRequest', async (method, params) => { try { return { ok: await wallet.request({ method, params }) }; } catch (e) { return { err: { message: e.message, code: e.code } }; } });
  await page.addInitScript((addr) => {
    const provider = { isTest: true, request: async ({ method, params }) => { const r = await window.__walletRequest(method, params ?? []); if (r.err) { const e = new Error(r.err.message); e.code = r.err.code; throw e; } return r.ok; }, on() {}, removeListener() {} };
    const info = { uuid: '00000000-0000-4000-8000-000000000001', name: 'Test wallet', icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=', rdns: 'test.wallet' };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce); announce(); void addr;
  }, wallet.address);
  await page.goto('http://127.0.0.1:5201/#/vault'); await page.getByRole('button', { name: /connect wallet/i }).first().click(); await page.getByRole('button', { name: 'Test wallet' }).click();
  await page.locator('h1.pg', { hasText: 'Vault' }).waitFor({ timeout: 60000 });
  t('signed in as the vault owner account (no read-only banner)', await page.getByText(/not the owner/i).count() === 0);
  const accept = page.getByRole('button', { name: /accept ownership/i }).first();
  await accept.waitFor({ timeout: 45000 }).catch(() => {});
  if (await accept.count()) { await accept.click(); await page.getByText(/now the owner of this vault/i).waitFor({ timeout: 150000 }); }
  let cfg = await viewNear({ contract: VAULT, method: 'config' }); t('accept ownership from the page: the vault owner is the 0x account', cfg.owner === wallet.address && !cfg.pending_owner, cfg.owner);
  await page.reload(); await page.locator('h1.pg', { hasText: 'Vault' }).waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: /pause on chain/i }).click(); await sleep(8000); console.log('   after click, wallet calls:', wallet.log.slice(-8).join(','), '| status text:', (await page.locator('[role=status],[role=alert]').allInnerTexts()).join(' / ').slice(0, 300)); await page.getByText(/vault paused on chain/i).waitFor({ timeout: 150000 });
  cfg = await viewNear({ contract: VAULT, method: 'config' }); t('pause from the page: vault is paused on chain', cfg.paused === true);
  await page.getByRole('button', { name: /un-pause on chain/i }).click(); await page.getByText(/un-paused on chain/i).waitFor({ timeout: 150000 });
  cfg = await viewNear({ contract: VAULT, method: 'config' }); t('un-pause from the page: vault runs again', cfg.paused === false);
  t('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.screenshot({ path: '/private/tmp/claude-501/shots/near-owner-vault.png' }); await b.close();
} catch (e) { fail++; console.log('FAIL', String(e?.message ?? e).split('\n')[0]); try { const pg = globalThis.__page; await pg.screenshot({ path: '/private/tmp/claude-501/shots/near-ui-fail.png' }); console.log('page text:', (await pg.locator('body').innerText()).slice(-900).replace(/\n+/g, ' | '), '\nerrors:', (globalThis.__errs ?? []).slice(0, 4), '\nwallet calls:', wallet.log.slice(-14).join(',')); } catch { /* no page */ } }
finally { console.log(`\nRESULT: ${pass} PASS, ${fail} FAIL`); stop(); process.exit(fail ? 1 : 0); }
