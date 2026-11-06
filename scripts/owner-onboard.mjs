#!/usr/bin/env node
// One-time relayer setup for an owner wallet (an 0x account on NEAR testnet), for wallets that refuse it.
//
// Why this exists: before a 0x account can send NEAR transactions through the NEP-518 relayer it must hold the relayer's function-call key (rlp_execute only). Adding it is a transaction
// from the account TO ITSELF with data. MetaMask refuses that from a website ("External transactions to internal accounts cannot include data"), so the web app cannot do it.
//
// What this does: builds that one transaction with the same code the web app uses (web/src/wallet/nearEth.js), signs it LOCALLY with your key, and sends only the signed
// transaction to the public testnet relayer. The key is read from a hidden prompt (or OWNER_ETH_PRIVATE_KEY), is never printed, never written to disk and never sent anywhere.
// It is a signature by YOU on YOUR machine; nothing here signs for anyone else. Testnet only (chain 398). Cost: about 0.002 NEAR of gas from the account itself.
//
// Run:  npm run owner:onboard                 (asks for the key, shows the address, asks you to type "yes")
//       npm run owner:onboard -- --expect 0x5ebaddf71482d40044391923be1fc42938129988      (refuses if the key is for another address)
//       OWNER_ETH_PRIVATE_KEY=0x... npm run owner:onboard -- --yes                         (no prompts; for scripts)
//       npm run owner:onboard -- --print --address 0x5eba...9988   (NO key at all: prints the exact values to paste into MetaMask's own Send screen; see below)
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
const { onboardingStatus, balanceYocto, buildTx, relayer, waitForReceipt, NEAR_EVM, explorerTx } = await import('../web/src/wallet/nearEth.js');
const { testProvider } = await import('../web/src/wallet/testProvider.js'); // a local-key EIP-1193 signer (viem); used here as a CLI signer, never by the app
const args = process.argv.slice(2); const flag = (n) => args.includes(n); const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const die = (m, code = 1) => { console.error(`\n${m}`); process.exit(code); };
const ask = (q, { hidden = false } = {}) => new Promise((ok) => {
  let muted = false; const out = new Writable({ write(c, e, cb) { if (!muted) process.stdout.write(c, e); cb(); } });
  const rl = createInterface({ input: process.stdin, output: out, terminal: true }); rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); ok(a.trim()); }); muted = hidden;
});

if (flag('--print')) { // MetaMask-only path: MetaMask's OWN Send screen is not a website, so its self-address rule does not apply. Needs Settings > Advanced > "Show hex data" (older send flow) and a manual gas limit.
  const addr = (opt('--address') ?? '').toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(addr)) die('Give your wallet address: --address 0x...');
  try {
    const ob = await onboardingStatus(addr);
    if (ob.onboarded) { console.log('Already set up: the relayer key is on this account. Nothing to do.'); process.exit(0); }
    const [nonce, gasPrice, bal] = await Promise.all([relayer('eth_getTransactionCount', [addr, 'latest']), relayer('eth_gasPrice', []), balanceYocto(addr)]);
    const tx = buildTx({ account: addr, nonce, gasPrice, onboard: ob.relayerKeyHex });
    console.log(`\nNetwork:   NEAR testnet (EVM wallet), chain id ${NEAR_EVM.chainId}  (${NEAR_EVM.rpc})\nFrom:      ${addr}\nTo:        ${tx.to}   (your OWN address)\nAmount:    0\nGas limit: ${BigInt(tx.gas)}   (set it by hand: the automatic estimate is far too low and the transaction would fail)\nGas price: ${BigInt(tx.gasPrice)} wei (${Number(BigInt(tx.gasPrice)) / 1e9} gwei), legacy\nHex data:  ${tx.data}\n`);
    console.log(`Balance ${(Number(bal / 10n ** 20n) / 1e4).toFixed(4)} NEAR; the fee is about ${(Number(BigInt(tx.gas) * BigInt(tx.gasPrice) * 10n ** 6n / 10n ** 18n) / 1e6).toFixed(4)} NEAR.`);
    console.log('In MetaMask: turn on Settings > Advanced > "Show hex data", switch to the NEAR testnet network, press Send, paste the To address, Amount 0, paste the Hex data, then Edit gas and set the Gas limit above. Confirm, wait a minute, then run this command again: it says "Already set up" when it worked.');
  } catch (e) { die(`Failed: ${String(e?.message ?? e).slice(0, 300)}`); }
  process.exit(0);
}
let key = process.env.OWNER_ETH_PRIVATE_KEY?.trim();
if (!key) { if (!process.stdin.isTTY) die('No key: set OWNER_ETH_PRIVATE_KEY or run this in a terminal.'); key = await ask('Private key of the owner wallet (hidden, 0x + 64 hex): ', { hidden: true }); }
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) die('That is not a 0x-prefixed 64-hex private key.');
let provider; try { provider = testProvider(key); } catch { die('The key could not be used.'); }
key = ''; delete process.env.OWNER_ETH_PRIVATE_KEY;
const A = provider.address;
console.log(`\nWallet address: ${A}`);
if (opt('--expect') && opt('--expect').toLowerCase() !== A) die(`This key is for ${A}, not ${opt('--expect')}. Nothing was sent.`);
try {
  const chain = (await relayer('eth_chainId', [])); if (Number(chain) !== Number(NEAR_EVM.chainId)) die(`The relayer reports chain ${Number(chain)}, expected ${NEAR_EVM.chainId} (NEAR testnet). Nothing was sent.`);
  const ob = await onboardingStatus(A);
  if (ob.onboarded) { console.log('Already set up: the relayer key is on this account. Nothing to do.'); process.exit(0); }
  const bal = await balanceYocto(A); console.log(`Balance: ${(Number(bal / 10n ** 20n) / 1e4).toFixed(4)} NEAR`);
  if (bal < 10n ** 22n) die('This account holds under 0.01 NEAR, which is not enough for the gas. Fund it first. Nothing was sent.');
  console.log(`\nThis adds the relayer's key (${ob.pub.slice(0, 18)}…, may call only rlp_execute on this account) to ${A}.`);
  if (!flag('--yes') && (await ask('Type "yes" to sign and send it: ')).toLowerCase() !== 'yes') die('Cancelled. Nothing was sent.', 0);
  const [nonce, gasPrice] = await Promise.all([relayer('eth_getTransactionCount', [A, 'latest']), relayer('eth_gasPrice', [])]);
  const hash = await provider.request({ method: 'eth_sendTransaction', params: [buildTx({ account: A, nonce, gasPrice, onboard: ob.relayerKeyHex })] });
  console.log(`Sent: ${hash}\n${explorerTx(hash)}`);
  for (let i = 0; i < 40; i++) { if ((await onboardingStatus(A)).onboarded) { console.log('\nDone. The relayer key is on the account. Go back to the app and press "Accept ownership" again.'); process.exit(0); } await new Promise((r) => setTimeout(r, 2500)); }
  const rc = await waitForReceipt(hash).catch(() => null);
  die(`The transaction was sent but the key is not visible yet${rc ? ` (receipt status ${rc.ok ? 'ok' : 'failed'})` : ''}. Wait a minute and run this again; it will say "Already set up" if it landed.`);
} catch (e) { die(`Failed: ${String(e?.message ?? e).slice(0, 300)}`); }
