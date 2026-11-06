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
const mk = async (extra = {}) => { const app = createApp({ db: await memDb(), operatorToken: 'op-token', ownerAddress: owner.address, defer: () => {}, ...extra }); app.ip = `10.0.0.${++n}`; return app; };

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
