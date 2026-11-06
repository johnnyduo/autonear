import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentPublishState } from './agent-state.js';

const live = { vaults: [{ status: 'active', paused: false, mandate: { revoked: false, expiresAt: 2_000 } }] };
const d = { id: 'dec_1' };
test('queued when a live vault exists and nothing was refused', () => assert.equal(agentPublishState(d, live, [], 1_000), 'waiting'));
test('no vault, a revoked or expired or paused one: nothing can publish', () => {
  assert.equal(agentPublishState(d, { vaults: [] }, [], 1_000), 'novault');
  assert.equal(agentPublishState(d, null, [], 1_000), 'novault');
  assert.equal(agentPublishState(d, { vaults: [{ status: 'active', mandate: { revoked: true, expiresAt: 2_000 } }] }, [], 1_000), 'novault');
  assert.equal(agentPublishState(d, live, [], 3_000), 'novault');
  assert.equal(agentPublishState(d, { vaults: [{ ...live.vaults[0], paused: true }] }, [], 1_000), 'novault');
});
test('only a live vault on the request\'s own network counts', () => {
  const other = { vaults: [{ ...live.vaults[0], chainId: 'near-mainnet' }] };
  assert.equal(agentPublishState({ id: 'dec_1', chain_id: 'near-testnet' }, other, [], 1_000), 'novault');
  assert.equal(agentPublishState({ id: 'dec_1', chain_id: 'near-testnet' }, { vaults: [{ ...live.vaults[0], chainId: 'near-testnet' }] }, [], 1_000), 'waiting');
});
test('held when the newest history entry for this request is a refusal or failure; other requests are ignored', () => {
  const l = [{ decisionId: 'dec_1', status: 'confirmed', time: 1000 }, { decisionId: 'dec_1', status: 'refused', time: 2000 }, { decisionId: 'dec_2', status: 'refused', time: 3000 }];
  assert.equal(agentPublishState(d, live, l, 1_000), 'held');
  assert.equal(agentPublishState({ id: 'dec_3' }, live, l, 1_000), 'waiting');
  assert.equal(agentPublishState(d, live, [{ decisionId: 'dec_1', status: 'refused', time: 1000 }, { decisionId: 'dec_1', status: 'confirmed', time: 2000 }], 1_000), 'waiting');
});

import { payState } from './agent-state.js';
const payVault = { vaults: [{ id: 'v1', address: 'v.testnet', chainId: 'near-testnet', status: 'active', paused: false, mandate: { revoked: false, expiresAt: 2_000 }, payouts: { tokens: [{ token: 'usdc.testnet' }], payees: [{ account: 'alice.testnet' }] } }] };
const pd = { id: 'dec_p', chain_id: 'near-testnet', effectiveStatus: 'approved', payload: { vault: 'v.testnet', token: 'usdc.testnet', payee: 'alice.testnet' } };
test('payState: queued, sending, held, or no vault able to pay this', () => {
  assert.equal(payState(pd, payVault, [], 1_000), 'waiting');
  assert.equal(payState({ ...pd, effectiveStatus: 'executing' }, payVault, [], 1_000), 'sending');
  assert.equal(payState(pd, payVault, [{ decisionId: 'dec_p', status: 'refused', time: 5 }], 1_000), 'held');
  assert.equal(payState(pd, payVault, [{ decisionId: 'dec_p', status: 'failed', time: 5 }], 1_000), 'held');
  assert.equal(payState(pd, payVault, [{ decisionId: 'dec_p', status: 'refused', time: 5 }, { decisionId: 'dec_p', status: 'confirmed', time: 9 }], 1_000), 'waiting');
  assert.equal(payState(pd, null, [], 1_000), 'novault');
  assert.equal(payState(pd, { vaults: [] }, [], 1_000), 'novault');
});
test('payState: the vault must be a live payouts vault that names this token and this person', () => {
  const v = payVault.vaults[0];
  assert.equal(payState(pd, { vaults: [{ ...v, payouts: undefined }] }, [], 1_000), 'novault'); // a v1 vault cannot pay
  assert.equal(payState(pd, { vaults: [{ ...v, payouts: { tokens: [{ token: 'other.testnet' }], payees: v.payouts.payees } }] }, [], 1_000), 'novault');
  assert.equal(payState(pd, { vaults: [{ ...v, payouts: { tokens: v.payouts.tokens, payees: [{ account: 'bob.testnet' }] } }] }, [], 1_000), 'novault');
  assert.equal(payState(pd, { vaults: [{ ...v, paused: true }] }, [], 1_000), 'novault');
  assert.equal(payState(pd, { vaults: [{ ...v, mandate: { revoked: true, expiresAt: 2_000 } }] }, [], 1_000), 'novault');
  assert.equal(payState(pd, payVault, [], 3_000), 'novault'); // expired
  assert.equal(payState(pd, { vaults: [{ ...v, address: 'other.testnet' }] }, [], 1_000), 'novault');
});
