import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../web/package.json', import.meta.url));
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');
import { createApp } from '../src/app.js';
import { memDb } from './helpers.js';

const HOST = 'app.example';
const owner = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());
const call = (app, path, init = {}) => app(new Request('http://' + HOST + path, { ...init, headers: { host: HOST, 'x-peer-ip': app.ip, 'content-type': 'application/json', ...(init.headers ?? {}) } }))
  .then(async (r) => ({ status: r.status, body: await r.text().then((t) => { try { return JSON.parse(t); } catch { return t; } }) }));
let n = 0;
const mk = async (extra = {}) => { const db = await memDb(); const app = createApp({ db, operatorToken: 'op-token', ownerAddress: owner.address, defer: () => {}, ...extra }); app.__db = db; app.ip = `10.0.0.${++n}`; return app; };

async function signIn(app, account, tweak = (m) => m) {
  const ch = await call(app, '/api/auth/challenge', { method: 'POST', body: JSON.stringify({ address: account.address }) });
  assert.equal(ch.status, 200, JSON.stringify(ch.body));
  const message = tweak(ch.body.message);
  const signature = await account.signMessage({ message });
  return call(app, '/api/auth/session', { method: 'POST', body: JSON.stringify({ address: account.address, message, signature }) });
}

test('challenge message binds host, address, nonce and expiry', async () => {
  const app = await mk();
  const ch = await call(app, '/api/auth/challenge', { method: 'POST', body: JSON.stringify({ address: owner.address }) });
  assert.match(ch.body.message, new RegExp(HOST));
  assert.ok(ch.body.message.toLowerCase().includes(owner.address.toLowerCase()));
  assert.match(ch.body.message, /Nonce: [0-9a-f]{32}/);
  assert.match(ch.body.message, /Expires At: /);
  assert.match(ch.body.message, /no transaction/i);
});

test('the owner signs in and the session works on scoped routes; non-owner gets no token', async () => {
  const app = await mk();
  const ok = await signIn(app, owner);
  assert.equal(ok.status, 200); assert.equal(ok.body.isOwner, true); assert.ok(ok.body.token);
  const me = await call(app, '/api/auth/me', { headers: { authorization: `Bearer ${ok.body.token}` } });
  assert.equal(me.body.isOwner, true);
  const no = await signIn(app, other);
  assert.equal(no.status, 200); assert.equal(no.body.isOwner, false); assert.equal(no.body.token, null);
});

test('rejects a signature from another key', async () => {
  const app = await mk();
  const ch = await call(app, '/api/auth/challenge', { method: 'POST', body: JSON.stringify({ address: owner.address }) });
  const signature = await other.signMessage({ message: ch.body.message });
  const r = await call(app, '/api/auth/session', { method: 'POST', body: JSON.stringify({ address: owner.address, message: ch.body.message, signature }) });
  assert.equal(r.status, 401);
});

test('challenge for another host is rejected', async () => {
  const app = await mk();
  const r = await signIn(app, owner, (m) => m.replace(HOST, 'evil.example'));
  assert.equal(r.status, 401);
});

test('challenge nonce is single use; concurrent redemption succeeds exactly once', async () => {
  const app = await mk();
  const ch = await call(app, '/api/auth/challenge', { method: 'POST', body: JSON.stringify({ address: owner.address }) });
  const signature = await owner.signMessage({ message: ch.body.message });
  const body = JSON.stringify({ address: owner.address, message: ch.body.message, signature });
  const rs = await Promise.all([1, 2, 3, 4].map(() => call(app, '/api/auth/session', { method: 'POST', body })));
  assert.equal(rs.filter((r) => r.status === 200).length, 1, JSON.stringify(rs.map((r) => r.status)));
  assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.status === 401));
});

test('rejects an expired challenge', async () => {
  const app = await mk();
  const r = await signIn(app, owner, (m) => m.replace(/Expires At: .*/, `Expires At: ${new Date(Date.now() - 1000).toISOString()}`));
  assert.equal(r.status, 401);
});

test('rejects a tampered token', async () => {
  const app = await mk();
  const { body } = await signIn(app, owner);
  const [p, s] = body.token.split('.');
  const forged = Buffer.from(JSON.stringify({ a: other.address.toLowerCase(), exp: Date.now() + 1e6 })).toString('base64url');
  for (const t of [`${forged}.${s}`, `${p}.${s.slice(0, -2)}aa`, 'x.y']) {
    const r = await call(app, '/api/security/pause', { method: 'POST', headers: { authorization: `Bearer ${t}` } });
    assert.equal(r.status, 401, t.slice(0, 20));
  }
});

test('rejects an expired token', async () => {
  const app = await mk({ sessionTtlMs: -1 });
  const { body } = await signIn(app, owner);
  const r = await call(app, '/api/security/pause', { method: 'POST', headers: { authorization: `Bearer ${body.token}` } });
  assert.equal(r.status, 401);
});

test('owner session is limited to the scoped routes; operator token still works everywhere', async () => {
  const app = await mk();
  const { body } = await signIn(app, owner);
  const h = { authorization: `Bearer ${body.token}` };
  assert.equal((await call(app, '/api/security/pause', { method: 'POST', headers: h })).status, 200);
  assert.equal((await call(app, '/api/security/resume', { method: 'POST', headers: h })).status, 200);
  assert.equal((await call(app, '/api/ingest', { method: 'POST', headers: h })).status, 401); // operator-only
  assert.equal((await call(app, '/api/security/pause', { method: 'POST', headers: { authorization: 'Bearer op-token' } })).status, 200);
});

test('owner transfer invalidates an existing session', async () => {
  let current = owner.address;
  const app = await mk({ ownerAddress: undefined, resolveOwner: async () => current });
  const { body } = await signIn(app, owner);
  const h = { authorization: `Bearer ${body.token}` };
  assert.equal((await call(app, '/api/security/pause', { method: 'POST', headers: h })).status, 200);
  current = other.address;
  assert.equal((await call(app, '/api/security/resume', { method: 'POST', headers: h })).status, 401);
});

test('approve with signer != session address is rejected before any state change', async () => {
  const app = await mk();
  const { body } = await signIn(app, owner);
  const r = await call(app, '/api/decisions/dec_x/approve', { method: 'POST', headers: { authorization: `Bearer ${body.token}` }, body: JSON.stringify({ nonce: 'n', payloadHash: 'h', confirm: 'approve dec_x', signer: other.address }) });
  assert.equal(r.status, 400); assert.match(JSON.stringify(r.body), /signed-in wallet/);
});

test('without OPERATOR_TOKEN sessions are disabled', async () => {
  const app = await mk({ operatorToken: '' });
  const ch = await call(app, '/api/auth/challenge', { method: 'POST', body: JSON.stringify({ address: owner.address }) });
  assert.equal(ch.status, 401);
});

test('autonomy mode: public read, owner/operator write, junk rejected', async () => {
  const app = await mk();
  assert.equal((await call(app, '/api/autonomy')).body.mode, 'manual');
  assert.equal((await call(app, '/api/autonomy/mode', { method: 'PUT', body: JSON.stringify({ mode: 'auto' }) })).status, 401);
  const { body } = await signIn(app, owner);
  const h = { authorization: `Bearer ${body.token}` };
  assert.equal((await call(app, '/api/autonomy/mode', { method: 'PUT', headers: h, body: JSON.stringify({ mode: 'auto' }) })).body.mode, 'auto');
  assert.equal((await call(app, '/api/autonomy/mode', { method: 'PUT', headers: h, body: JSON.stringify({ mode: 'yolo' }) })).status, 400);
  assert.equal((await call(app, '/api/status')).body.autonomy.mode, 'auto');
});

test('PUBLIC_HOSTS allowlist: a challenge cannot be minted or redeemed for another domain', async () => {
  const app = await mk({ publicHosts: ['other.example'] });
  const ch = await call(app, '/api/auth/challenge', { method: 'POST', body: JSON.stringify({ address: owner.address }) });
  assert.equal(ch.status, 400); assert.match(JSON.stringify(ch.body), /not available on this domain/);
  const ok = await mk({ publicHosts: [HOST] });
  assert.equal((await signIn(ok, owner)).body.isOwner, true);
});

test('owner session reaches receipt/deploy-data only for requests bound to its own wallet; the operator reaches any', async () => {
  const app = await mk();
  const { body } = await signIn(app, owner);
  const h = { authorization: `Bearer ${body.token}` };
  const db = app.__db;
  const ins = (id, signer) => db.run("INSERT INTO decisions(id,run_id,artifact_hash,action,chain_id,target,method,max_spend,expiry,nonce,payload,payload_hash,status,created_at,bound_signer) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [id, null, 'h', 'deploy_testnet', 'evm:84532', 't', 'deploy', '0', Date.now() + 1e6, `n_${id}`, '{}', 'ph', 'approved', Date.now(), signer]);
  await ins('dec_mine', owner.address); await ins('dec_other', other.address);
  const get = (id, hh) => call(app, `/api/decisions/${id}/deploy-data`, { headers: hh });
  assert.notEqual((await get('dec_mine', h)).status, 400, 'own request passes the scope check');
  const r = await get('dec_other', h); assert.equal(r.status, 400); assert.match(JSON.stringify(r.body), /different signer/);
  assert.equal((await call(app, '/api/decisions/dec_other/receipt', { method: 'POST', headers: h, body: JSON.stringify({ txHash: '0x1' }) })).status, 400);
  assert.notEqual((await get('dec_other', { authorization: 'Bearer op-token' })).status, 400, 'operator is not scoped');
});

test('co-owners (OWNER_ADDRESSES) can sign in and use owner routes alongside the primary owner; strangers still cannot', async () => {
  const co = privateKeyToAccount(generatePrivateKey());
  const app = await mk({ extraOwners: [co.address.toLowerCase()] });
  const a = await signIn(app, co);
  assert.equal(a.body.isOwner, true); assert.ok(a.body.token);
  const me = await call(app, '/api/auth/me', { headers: { authorization: `Bearer ${a.body.token}` } });
  assert.equal(me.body.isOwner, true); assert.equal(me.body.address, co.address.toLowerCase());
  const put = await call(app, '/api/autonomy/mode', { method: 'PUT', headers: { authorization: `Bearer ${a.body.token}` }, body: JSON.stringify({ mode: 'manual' }) });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const prim = await signIn(app, owner); assert.equal(prim.body.isOwner, true);
  const stranger = await signIn(app, other); assert.equal(stranger.body.isOwner, false); assert.equal(stranger.body.token, null);
});

test('removing a co-owner kills its existing session on the next request (ownership is re-resolved every time)', async () => {
  const co = privateKeyToAccount(generatePrivateKey()); const list = [co.address.toLowerCase()];
  const app = await mk({ extraOwners: list });
  const a = await signIn(app, co); assert.ok(a.body.token);
  list.length = 0;
  const me = await call(app, '/api/auth/me', { headers: { authorization: `Bearer ${a.body.token}` } });
  assert.equal(me.body.isOwner, false);
});

test('POST /api/vault/activate: owner or operator only, scoped to the owner\'s own grant, and it refuses what is not a grant or has no attached vault', async () => {
  const app = await mk(); const db = app.__db;
  const ins = (id, action, signer, target = 'vault.testnet') => db.run("INSERT INTO decisions(id,run_id,artifact_hash,action,chain_id,target,method,max_spend,expiry,nonce,payload,payload_hash,status,created_at,bound_signer) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [id, null, 'h', action, 'near-testnet', target, 'm', '0', Date.now() + 1e6, `n_${id}`, '{}', 'ph', 'approved', Date.now(), signer]);
  await ins('dec_grant', 'grant_mandate', owner.address); await ins('dec_theirs', 'grant_mandate', other.address); await ins('dec_dep', 'deploy_testnet', owner.address);
  const post = (decisionId, headers) => call(app, '/api/vault/activate', { method: 'POST', headers, body: JSON.stringify({ decisionId }) });
  assert.equal((await post('dec_grant', {})).status, 401);
  const { body } = await signIn(app, owner); const h = { authorization: `Bearer ${body.token}` };
  assert.equal((await post('dec_theirs', h)).status, 400); // bound to a different signer
  assert.equal((await post('dec_dep', h)).status, 404); // not a grant
  const noVault = await post('dec_grant', h); assert.equal(noVault.status, 404); assert.match(JSON.stringify(noVault.body), /not attached/);
  assert.equal((await post('nope', h)).status, 400);
});

test('the approving owner can reach the receipt route of a request the agent has since claimed (bound signer is then the vault)', async () => {
  const app = await mk(); const db = app.__db;
  const { body } = await signIn(app, owner); const h = { authorization: `Bearer ${body.token}` };
  const ins = (id, approver) => db.run("INSERT INTO decisions(id,run_id,artifact_hash,action,chain_id,target,method,max_spend,expiry,nonce,payload,payload_hash,status,created_at,bound_signer,approver) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [id, null, 'h', 'pay_testnet', 'near-testnet', 'vault.testnet', 'pay', '1', Date.now() + 1e6, `n_${id}`, '{}', 'ph', 'approved', Date.now(), 'vault.testnet', approver]);
  await ins('dec_mine_claimed', `mandate:vlt_1:1+owner:${owner.address.toLowerCase()}`);
  await ins('dec_other_claimed', `mandate:vlt_1:1+owner:${other.address.toLowerCase()}`);
  await ins('dec_auto_claimed', 'mandate:vlt_1:1');
  const rc = (id) => call(app, `/api/decisions/${id}/receipt`, { method: 'POST', headers: h, body: JSON.stringify({ txHash: '1'.repeat(44) }) });
  assert.notEqual((await rc('dec_mine_claimed')).status, 400, 'own approval passes the scope check');
  assert.equal((await rc('dec_other_claimed')).status, 400);
  assert.equal((await rc('dec_auto_claimed')).status, 400, 'an Auto payment nobody approved is operator-only');
});
