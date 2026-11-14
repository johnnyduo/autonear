// The "Let the agent pay people" form (web/src/app/PayBudget.jsx) builds its request with payBudgetCheck. The REAL server (proposeGrant, fake NEAR testnet of tests/pay-helpers.js) must accept exactly that
// request, read the token's symbol and decimals from the token itself, and produce the owner's on-chain steps. A form that passes its own checks but is refused by the server would be worthless.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { payBudgetCheck, PAY_DEFAULTS, PAY_FUEL } from '../web/src/app/vaultView.js';
import { makeWorld, skipNoBuilds, VAULT, OWNER, AGENT, USDC, ALICE, BOB, M } from './pay-helpers.js';

describe('the pay-budget form against the real server', { skip: skipNoBuilds }, () => {
  test('the request the form builds is accepted, and the plan has the allow_token / allow_payee steps for the owner', async () => {
    const world = await makeWorld({ grant: false });
    const { errors, body } = payBudgetCheck({ token: USDC, ...PAY_DEFAULTS, people: `${ALICE}\n${BOB}` }, { decimals: 6, vault: VAULT, chainId: 'near-testnet', owner: OWNER, artifactHash: world.artifactHash, agent: AGENT });
    assert.deepEqual(errors, {}); assert.ok(body);
    const r = await world.api('/api/vault/mandates/propose', { method: 'POST', body });
    assert.equal(r.status, 201, r.text);
    const p = r.json.payload;
    assert.deepEqual(p.payouts.tokens.map((t) => [t.token, t.symbol, t.decimals, t.perPayCap, t.periodCap, t.totalCap]), [[USDC, 'USDC', 6, String(10n * M), String(50n * M), String(200n * M)]], 'symbol and decimals come from the token, caps from the form in base units');
    assert.deepEqual(p.payouts.payees, [ALICE, BOB]);
    assert.equal(p.mandate.maxDeploys, '0'); assert.equal(BigInt(p.mandate.totalCap), BigInt(PAY_FUEL.totalCap));
    const exp = Number(p.mandate.expiresAt); const now = Math.floor(Date.now() / 1000); assert.ok(exp > now + 6 * 86400 && exp <= now + 8 * 86400, 'about 7 days');
    const plan = (await world.api(`/api/vault/plan?decisionId=${r.json.id}`)).json;
    const titles = plan.steps.filter((s) => s.who === 'human' && s.call).map((s) => s.title);
    assert.ok(titles.some((x) => /allow_token/.test(x)), titles.join(' | ')); assert.ok(titles.some((x) => /allow_payee: /.test(x))); assert.ok(titles.some((x) => /set_mandate|mandate/i.test(x)));
    const again = await world.api('/api/vault/mandates/propose', { method: 'POST', body }); assert.equal(again.status, 200, 'the same proposal twice is the same decision, not a second one'); assert.equal(again.json.id, r.json.id);
  });
  test('what the form refuses never reaches the server, and what only the server can know is still refused by it (an unattested build)', async () => {
    const world = await makeWorld({ grant: false });
    const ok = payBudgetCheck({ token: USDC, ...PAY_DEFAULTS, people: ALICE }, { decimals: 6, vault: VAULT, chainId: 'near-testnet', owner: OWNER, artifactHash: world.artifactHash, agent: AGENT }).body;
    const r = await world.api('/api/vault/mandates/propose', { method: 'POST', body: { ...ok, templates: [{ artifactHash: 'cd'.repeat(32) }] } });
    assert.ok(r.status >= 400 && r.status < 500, `${r.status} ${r.text}`);
    const notOwner = await world.api('/api/vault/mandates/propose', { method: 'POST', body: { ...ok, vault: { address: VAULT, owner: 'someone-else.testnet' } } });
    assert.ok(notOwner.status >= 400, 'a wrong owner is refused');
  });
});
