import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { parseTransaction, recoverTransactionAddress } from 'viem';
import { decodeAbiParameters, parseAbiParameters, keccak256, toBytes, hexToString } from 'viem';
import { onboardRows, ONBOARD_STEPS } from './onboardHelp.js';
import { accountToAddress, b58encode, buildTx, encodeAction, encodeOnboarding, onboardingStatus, nearRpc, explainWalletError, explainEthSignError, sendSetupWithEthSign, callNear, SELECTORS, NEAR_EVM } from '../wallet/nearEth.js';

test('selectors match the wallet contract (near/near-wallet-contract types.rs)', () => {
  assert.equal(SELECTORS.functionCall, '0x6179b707'); assert.equal(SELECTORS.transfer, '0x3ed64124'); assert.equal(SELECTORS.addKey, '0x753ce5ab');
  const sel = (sig) => keccak256(toBytes(sig)).slice(0, 10);
  assert.equal(sel('functionCall(string,string,bytes,uint64,uint32)'), SELECTORS.functionCall);
  assert.equal(sel('transfer(string,uint32)'), SELECTORS.transfer);
  assert.equal(sel('addKey(uint8,bytes,uint64,bool,bool,uint128,string,string[])'), SELECTORS.addKey);
});

test('the to address of a receiver is the last 20 bytes of keccak256(account id)', () => {
  // vector from internal.rs test_account_id_to_address would use a named account; this one is recomputed independently
  assert.equal(accountToAddress('vault.testnet'), `0x${keccak256(toBytes('vault.testnet')).slice(-40)}`);
  assert.match(accountToAddress('x.testnet'), /^0x[0-9a-f]{40}$/);
});

test('functionCall data decodes back to the receiver, method, JSON args, gas and the yocto remainder', () => {
  const dep = 3n * 10n ** 24n + 123_456n; // 3 NEAR + 123456 yocto: value carries whole multiples of 1e6, the uint32 carries the rest
  const a = encodeAction({ receiver: 'vault.testnet', method: 'set_mandate', args: { cap: '5' }, deposit: dep, gas: 30_000_000_000_000n });
  assert.equal(a.data.slice(0, 10), SELECTORS.functionCall);
  const [recv, method, args, gas, yocto] = decodeAbiParameters(parseAbiParameters('string, string, bytes, uint64, uint32'), `0x${a.data.slice(10)}`);
  assert.equal(recv, 'vault.testnet'); assert.equal(method, 'set_mandate'); assert.equal(hexToString(args), '{"cap":"5"}'); assert.equal(gas, 30_000_000_000_000n); assert.equal(yocto, 123_456);
  assert.equal(a.value * 1_000_000n + BigInt(yocto), dep);
  assert.equal(a.to, accountToAddress('vault.testnet'));
});

test('a plain transfer uses the transfer selector and no method', () => {
  const a = encodeAction({ receiver: 'bob.testnet', method: null, deposit: 5n * 10n ** 23n + 7n });
  assert.equal(a.data.slice(0, 10), SELECTORS.transfer);
  const [recv, yocto] = decodeAbiParameters(parseAbiParameters('string, uint32'), `0x${a.data.slice(10)}`);
  assert.equal(recv, 'bob.testnet'); assert.equal(a.value * 1_000_000n + BigInt(yocto), 5n * 10n ** 23n + 7n);
});

test('buildTx: legacy tx on chain 398, gas = (action gas + 20 Tgas) / 1e8 EVM gas', () => {
  const t = buildTx({ account: '0x4aef87e3001efb67114944bc2cf319ddf40cbc4b', nonce: 7, gasPrice: 100_000_000_000n, receiver: 'vault.testnet', method: 'pause', args: {}, gas: 30_000_000_000_000n });
  assert.equal(t.chainId, NEAR_EVM.chainIdHex); assert.equal(BigInt(t.gas), 500_000n); assert.equal(BigInt(t.nonce), 7n); assert.equal(t.value, '0x0'); assert.equal(t.from, '0x4aef87e3001efb67114944bc2cf319ddf40cbc4b');
});

test('bad input is refused before anything reaches the wallet', () => {
  assert.throws(() => encodeAction({ receiver: '', method: 'x' }), /receiver/);
  assert.throws(() => encodeAction({ receiver: 'a.testnet', method: 'x', gas: 0n }), /gas/);
  assert.throws(() => encodeAction({ receiver: 'a.testnet', method: 'x', gas: 10n ** 15n }), /gas/);
  assert.throws(() => encodeAction({ receiver: 'a.testnet', method: 'x', deposit: -1n }), /deposit/);
});

test('onboarding adds only the relayer key, limited to rlp_execute on the account itself', () => {
  const acct = '0x4aef87e3001efb67114944bc2cf319ddf40cbc4b';
  const o = encodeOnboarding({ account: acct, relayerKeyHex: 'ab'.repeat(32) });
  assert.equal(o.to, acct); assert.equal(o.data.slice(0, 10), SELECTORS.addKey);
  const [kind, key, nonce, full, limited, allowance, recv, methods] = decodeAbiParameters(parseAbiParameters('uint8, bytes, uint64, bool, bool, uint128, string, string[]'), `0x${o.data.slice(10)}`);
  assert.equal(kind, 0); assert.equal(key, `0x${'ab'.repeat(32)}`); assert.equal(nonce, 0n); assert.equal(full, false); assert.equal(limited, false); assert.equal(allowance, 0n); assert.equal(recv, acct); assert.deepEqual([...methods], ['rlp_execute']);
  assert.throws(() => encodeOnboarding({ account: acct, relayerKeyHex: 'ab' }), /32 bytes/);
});

test('base58 matches NEAR key encoding', () => {
  assert.equal(b58encode(new Uint8Array([0, 0, 1])), '112');
  assert.equal(b58encode(Uint8Array.from(Buffer.from('d1f730e4a45f61c90789bfd953ec6f247c1e15c571320a93f62a7f41621fae34', 'hex'))), 'F8cptyekqCo7x7LwKtMHGpijTQcGwtFXHzeM9oDTmwPZ');
});

// The one-time relayer setup must not be skipped when the node says the key is missing. fastnear answers that with HTTP 200 and { result: { error } }, not a JSON-RPC error.
const RELAYER_KEY = '21dea25fbd244dca1f835a95f02a2e368f5a0dc9a935abd22462c4e9f8e5ecb0';
const fakeNet = (nearAnswer) => async (url, init) => {
  const body = JSON.parse(init.body); const reply = (o) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, ...o }) });
  if (String(url) === NEAR_EVM.rpc && body.method === 'near_getPublicKey') return reply({ result: { public_key: RELAYER_KEY } });
  return reply(nearAnswer);
};
const ACCT = '0x5ebaddf71482d40044391923be1fc42938129988';
test('onboardingStatus: a missing key reported the fastnear way ({ result: { error } }) means NOT onboarded', async () => {
  const fx = fakeNet({ result: { block_hash: 'x', block_height: 1, error: 'access key ed25519:3HDMUBDSSup8jPL7FMLiduSPwir6HhX4zedvZmzy25So does not exist while viewing', logs: [] } });
  const s = await onboardingStatus(ACCT, fx); assert.equal(s.onboarded, false); assert.equal(s.relayerKeyHex, RELAYER_KEY);
});
test('onboardingStatus: a missing key reported as a classic JSON-RPC error is also NOT onboarded', async () => {
  assert.equal((await onboardingStatus(ACCT, fakeNet({ error: { message: 'access key ed25519:xxx does not exist while viewing' } }))).onboarded, false);
});
test('onboardingStatus: a real access key answer means onboarded', async () => {
  assert.equal((await onboardingStatus(ACCT, fakeNet({ result: { nonce: 0, permission: { FunctionCall: { receiver_id: ACCT, method_names: ['rlp_execute'] } }, block_hash: 'x', block_height: 1 } }))).onboarded, true);
});
test('onboardingStatus: any other node failure is raised, never read as "onboarded" or "not onboarded"', async () => {
  await assert.rejects(onboardingStatus(ACCT, fakeNet({ result: { error: 'the node is syncing' } })), /syncing/);
  await assert.rejects(onboardingStatus(ACCT, fakeNet({ error: { message: 'Internal error' } })), /Internal error/);
});
test('nearRpc raises a { result: { error } } answer, and still returns ordinary results (including ones that merely contain other fields)', async () => {
  await assert.rejects(nearRpc('query', {}, fakeNet({ result: { error: 'boom', logs: [] } })), /boom/);
  assert.deepEqual(await nearRpc('query', {}, fakeNet({ result: { amount: '1' } })), { amount: '1' });
  assert.deepEqual(await nearRpc('x', {}, fakeNet({ result: [1, 2] })), [1, 2]);
});

test('the MetaMask self-address rule is explained in plain words; every other error passes through untouched', () => {
  const mm = Object.assign(new Error('External transactions to internal accounts cannot include data'), { code: -32602 });
  const e = explainWalletError(mm); assert.equal(e.code, 'WALLET_SELF_DATA_BLOCKED'); assert.match(e.message, /inside MetaMask itself/); assert.equal(e.cause, mm);
  const other = new Error('User rejected the request.'); assert.equal(explainWalletError(other), other);
  assert.equal(explainWalletError('External transactions to internal accounts cannot include data').code, 'WALLET_SELF_DATA_BLOCKED');
});
test('callNear: when the wallet refuses the one-time setup the owner gets the explanation, and no second transaction is attempted', async () => {
  const sent = [];
  const provider = { async request({ method }) { if (method === 'eth_requestAccounts') return [ACCT]; if (method === 'eth_chainId') return NEAR_EVM.chainIdHex; if (method === 'eth_sendTransaction') { sent.push(method); throw new Error('External transactions to internal accounts cannot include data'); } return null; } };
  const fx = async (url, init) => { const b = JSON.parse(init.body); const reply = (o) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, ...o }) });
    if (String(url) === NEAR_EVM.rpc) return reply({ result: b.method === 'near_getPublicKey' ? { public_key: RELAYER_KEY } : '0x0' });
    return reply({ result: { block_hash: 'x', block_height: 1, error: 'access key does not exist while viewing', logs: [] } }); };
  await assert.rejects(callNear({ provider, account: ACCT, receiver: 'v.testnet', method: 'm', args: {}, fetchImpl: fx }), (e) => e.code === 'WALLET_SELF_DATA_BLOCKED' && e.onboard.to === ACCT && e.onboard.gasLimit === '220000' && e.onboard.data.startsWith(SELECTORS.addKey) && e.onboard.chainId === NEAR_EVM.chainId && e.onboard.address === ACCT);
  assert.equal(sent.length, 1, 'only the setup was attempted');
});

test('onboardRows: lists the values to enter in MetaMask, and refuses anything malformed', () => {
  const setup = { address: ACCT, to: ACCT, data: `${SELECTORS.addKey}${'00'.repeat(64)}`, gasLimit: '220000', gasPrice: '100000000000', chainId: 398, network: 'NEAR testnet (EVM wallet)' };
  const rows = onboardRows(setup); const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(by.to.copy, ACCT); assert.equal(by.amount.copy, '0'); assert.equal(by.data.copy, setup.data); assert.equal(by.gas.copy, '220000'); assert.match(by.price.value, /^100 gwei$/); assert.match(by.network.value, /chain id 398/);
  assert.equal(onboardRows(null), null); assert.equal(onboardRows({ ...setup, to: 'nope' }), null); assert.equal(onboardRows({ ...setup, data: 'zz' }), null);
  assert.ok(ONBOARD_STEPS.length === 4 && ONBOARD_STEPS.every((s) => s.length > 20));
});

// ---- the one-time setup through eth_sign (MetaMask only: no transaction from the wallet to itself) ------------------------------------------------------------------
function setupWorld(account, { ethSign }) {
  const w = { onboarded: false, raws: [] };
  const fx = async (url, init) => { const b = JSON.parse(init.body); const reply = (o) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, ...o }) });
    if (String(url) === NEAR_EVM.rpc) {
      if (b.method === 'near_getPublicKey') return reply({ result: { public_key: RELAYER_KEY } });
      if (b.method === 'eth_getTransactionCount') return reply({ result: '0x0' });
      if (b.method === 'eth_gasPrice') return reply({ result: '0x174876e800' });
      if (b.method === 'eth_sendRawTransaction') { w.raws.push(b.params[0]); w.onboarded = true; return reply({ result: '0xabc' }); }
    }
    return reply(w.onboarded ? { result: { nonce: 0, permission: 'FullAccess', block_hash: 'x', block_height: 1 } } : { result: { block_hash: 'x', block_height: 1, error: 'access key does not exist while viewing', logs: [] } }); };
  const provider = { calls: [], async request({ method, params }) { this.calls.push(method); if (method === 'eth_requestAccounts') return [account.address.toLowerCase()]; if (method === 'eth_sign') return ethSign(params); throw new Error(`unexpected ${method}`); } };
  return { w, fx, provider };
}
test('sendSetupWithEthSign: signs the hash of the exact setup transaction, sends it, and the transaction recovers to the wallet', async () => {
  const acct = privateKeyToAccount(generatePrivateKey()); const A = acct.address.toLowerCase();
  const { w, fx, provider } = setupWorld(acct, { ethSign: (p) => acct.sign({ hash: p[1] }) });
  const r = await sendSetupWithEthSign({ provider, account: A, fetchImpl: fx, pollMs: 1 });
  assert.ok(r.hash); assert.equal(w.raws.length, 1); assert.deepEqual(provider.calls.filter((c) => c === 'eth_sign'), ['eth_sign']);
  const tx = parseTransaction(w.raws[0]);
  assert.equal(tx.to, A, 'self-targeted, as the wallet contract requires for AddKey'); assert.equal(tx.chainId, 398); assert.equal(tx.gas, 220000n); assert.equal(tx.value ?? 0n, 0n);
  assert.ok(tx.data.startsWith(SELECTORS.addKey)); assert.equal((await recoverTransactionAddress({ serializedTransaction: w.raws[0] })).toLowerCase(), A);
  const keyBytes = decodeAbiParameters(parseAbiParameters('uint8, bytes, uint64, bool, bool, uint128, string, string[]'), `0x${tx.data.slice(10)}`)[1];
  assert.equal(String(keyBytes).slice(2), RELAYER_KEY, 'the key being added is the relayer key');
});
test('sendSetupWithEthSign: a wallet that signs something else (a prefixed message, or another account) sends NOTHING', async () => {
  const acct = privateKeyToAccount(generatePrivateKey()); const A = acct.address.toLowerCase(); const other = privateKeyToAccount(generatePrivateKey());
  for (const ethSign of [(p) => other.sign({ hash: p[1] }), (p) => acct.signMessage({ message: { raw: p[1] } })]) {
    const { w, fx, provider } = setupWorld(acct, { ethSign });
    await assert.rejects(sendSetupWithEthSign({ provider, account: A, fetchImpl: fx, pollMs: 1 }), /Nothing was sent/); assert.equal(w.raws.length, 0);
  }
});
test('sendSetupWithEthSign: already set up -> nothing is asked of the wallet; eth_sign switched off -> plain instructions', async () => {
  const acct = privateKeyToAccount(generatePrivateKey()); const A = acct.address.toLowerCase();
  const done = setupWorld(acct, { ethSign: () => { throw new Error('should not be called'); } }); done.w.onboarded = true;
  assert.deepEqual(await sendSetupWithEthSign({ provider: done.provider, account: A, fetchImpl: done.fx }), { already: true }); assert.equal(done.provider.calls.includes('eth_sign'), false);
  const off = setupWorld(acct, { ethSign: () => { throw Object.assign(new Error('The eth_sign method has been disabled. Enable it in Advanced settings.'), { code: -32601 }); } });
  await assert.rejects(sendSetupWithEthSign({ provider: off.provider, account: A, fetchImpl: off.fx }), (e) => e.code === 'ETH_SIGN_DISABLED' && /Eth_sign requests/.test(e.message)); assert.equal(off.w.raws.length, 0);
  const rej = new Error('User rejected the request.'); assert.equal(explainEthSignError(rej), rej);
});
