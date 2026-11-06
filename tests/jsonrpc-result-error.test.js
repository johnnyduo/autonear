// Newer NEAR nodes (fastnear) answer a failed query with HTTP 200 and { result: { error: '...' } } instead of a JSON-RPC error. Every caller of jsonRpc must see a failure,
// never an "empty but valid" answer (a missing account, a missing key, a pruned block). Real shape captured from rpc.testnet.fastnear.com.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonRpc } from '../src/chains/common.js';
import { nearRpc, generateSeed, formatSecretKey } from '../src/agent/near-signer.js';
import { createNearAdmin } from '../src/agent/near-admin.js';

const answer = (body) => async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }), { status: 200, headers: { 'content-type': 'application/json' } });
const MISSING = { result: { block_hash: '8FX3hqQhH9WFS9ZAPwZyAdkFiWFULuTrZPNfZwEuyKB6', block_height: 276501828, error: 'access key ed25519:3HDMUBDSSup8jPL7FMLiduSPwir6HhX4zedvZmzy25So does not exist while viewing', logs: [] } };
const URL = 'https://rpc.testnet.fastnear.com';

test('jsonRpc raises { result: { error } } with the node\'s own words', async () => {
  await assert.rejects(jsonRpc('monitor', URL, 'query', {}, { fetchImpl: answer(MISSING) }), /does not exist while viewing/);
});
test('jsonRpc still raises a classic JSON-RPC error and still returns ordinary results, arrays and strings', async () => {
  await assert.rejects(jsonRpc('monitor', URL, 'query', {}, { fetchImpl: answer({ error: { message: 'bad', data: 'worse' } }) }), /bad worse/);
  assert.deepEqual(await jsonRpc('monitor', URL, 'query', {}, { fetchImpl: answer({ result: { amount: '5', code_hash: '1' } }) }), { amount: '5', code_hash: '1' });
  assert.deepEqual(await jsonRpc('monitor', URL, 'x', {}, { fetchImpl: answer({ result: [1, 2] }) }), [1, 2]);
  assert.equal(await jsonRpc('monitor', URL, 'x', {}, { fetchImpl: answer({ result: '0x1' }) }), '0x1');
  assert.deepEqual(await jsonRpc('monitor', URL, 'x', {}, { fetchImpl: answer({ result: { error: 123 } }) }), { error: 123 }, 'only a STRING error field is the node reporting a failure');
});
test('the signer\'s access key lookup keeps its clear message for a missing key', async () => {
  await assert.rejects(nearRpc(URL, { fetchImpl: answer(MISSING) }).accessKey('0xabc', 'ed25519:x'), /access key lookup failed: .*does not exist/);
});
test('near-admin account(), keys() and view() raise instead of returning an object without the expected fields', async () => {
  const seed = formatSecretKey(generateSeed());
  const a = createNearAdmin({ rpcUrl: URL, accountId: 'x.testnet', secretKey: seed, networkId: 'testnet', fetchImpl: answer(MISSING) });
  await assert.rejects(a.account('nobody.testnet'), /does not exist/);
  await assert.rejects(a.keys('nobody.testnet'), /does not exist/);
  await assert.rejects(a.view('c.testnet', 'm', {}), /does not exist/);
});
