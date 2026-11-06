import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanLine } from '../scripts/secret-scan.mjs';

// Fake credentials are assembled at run time so this file itself stays clean under the scanner.
const rules = (l) => scanLine(l).map((f) => f.rule);
test('flags well-known credential shapes', () => {
  assert.deepEqual(rules('key=' + 'AIza' + 'x'.repeat(35)), ['google-api-key']);
  assert.ok(rules('t ' + 'ghp_' + 'a'.repeat(36)).includes('github-token'));
  assert.ok(rules('-----BEGIN ' + 'PRIVATE KEY-----').includes('private-key-block'));
  assert.ok(rules('sk' + '-' + 'a'.repeat(40)).includes('openai-style-key'));
  assert.ok(rules('ed25519:' + '1'.repeat(87)).includes('near-secret-key'));
  assert.ok(rules('app ' + ['abcd', 'efgh', 'ijkl', 'mnop'].map((w) => w.replace('a', 'q')).join('-')).includes('app-password-shape'));
});
test('flags assigned secrets and hex private keys, but not placeholders, env reads or public dev keys', () => {
  assert.ok(rules('OPERATOR_TOKEN=' + 'f'.repeat(32)).includes('assigned-operator_token'));
  assert.ok(rules('const privateKey = "0x' + 'ab12'.repeat(16) + '"').includes('hex-private-key'));
  assert.deepEqual(rules('OPERATOR_TOKEN='), []);
  assert.deepEqual(rules('OPERATOR_TOKEN=process.env.OPERATOR_TOKEN_VALUE_X'), []);
  assert.deepEqual(rules('AGENT_NEAR_PRIVATE_KEY: near.formatSecretKey(seed)'), []);
  assert.deepEqual(rules('GEMINI_API_KEY=<your key goes here>'), []);
  assert.deepEqual(rules('const KEY0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil secret'), []);
});
