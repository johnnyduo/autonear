import test from 'node:test';
import assert from 'node:assert/strict';
import { netOf } from './session-net.js';

test('NEAR testnet is recognised as hex, as upper-case hex and as a number', () => {
  assert.equal(netOf('0x18e'), 'near');
  assert.equal(netOf('0x18E'), 'near');
  assert.equal(netOf(398), 'near');
});
test('any other chain is "other", a missing answer is "unknown"', () => {
  assert.equal(netOf('0x1'), 'other');
  assert.equal(netOf(11155111), 'other');
  assert.equal(netOf(null), 'unknown');
  assert.equal(netOf(undefined), 'unknown');
  assert.equal(netOf(''), 'unknown');
  assert.equal(netOf('not-a-chain'), 'unknown');
});
