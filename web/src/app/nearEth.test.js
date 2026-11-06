import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAbiParameters, parseAbiParameters, keccak256, toBytes, hexToString } from 'viem';
import { accountToAddress, b58encode, buildTx, encodeAction, encodeOnboarding, onboardingStatus, nearRpc, SELECTORS, NEAR_EVM } from '../wallet/nearEth.js';

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
