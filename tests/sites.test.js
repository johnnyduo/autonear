import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../web/package.json', import.meta.url));
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { ingestSource, registerSources } from '../src/ingest.js';
import { refreshOpportunities } from '../src/scoring.js';
import { validateContent, slugOf } from '../src/sites/schema.js';
import { renderSite, contentHash, shortHash, TEMPLATE_VERSION, SITE_CSP } from '../src/sites/render.js';
import { generateContent } from '../src/sites/content.js';
import { saveSite, getSite, latestPublished, latestBuilt, listSites, publish, unpublish } from '../src/sites/store.js';
import { memDb, fakeConnector, gh } from './helpers.js';

const good = () => ({
  badge: 'Example product', headline: 'Pay out a DAO treasury with clear rules', sub: 'A tool that would let a NEAR DAO set payout rules and review each payment before it is sent.',
  features: [{ title: 'Payout rules', body: 'Set who can approve which payment, and up to what amount.' }, { title: 'Review queue', body: 'Every payment waits in a list until enough people approve it.' }, { title: 'History', body: 'A plain record of what was paid, to whom, and who approved it.' }],
  steps: [{ title: 'Connect', body: 'Link the DAO account.' }, { title: 'Set rules', body: 'Choose the approvers and limits.' }, { title: 'Approve', body: 'Review each payment and sign it.' }],
  cta: 'Read the idea',
});
const meta = (over = {}) => ({ slug: 'treasury', title: 'DAO treasury', verdict: 'go', support: 0.71, builtAt: Date.UTC(2026, 10, 6, 12), hash: shortHash(good()), override: false, model: 'gemini-test', evidence: [{ title: 'Multisig payout fails', url: 'https://example.org/a?x=1&y=2' }, { title: 'No link here' }], ...over });

// ------------------------------------------------------------------------------------------ schema
test('schema: a good object passes and is returned with only the known keys', () => {
  const r = validateContent({ ...good(), extra: '<b>x</b>', features: good().features.map((f) => ({ ...f, junk: 1 })) });
  assert.equal(r.ok, true); assert.deepEqual(r.value, good());
});

test('schema: each bad case is rejected', () => {
  const bad = (mut) => { const c = good(); mut(c); return validateContent(c); };
  const cases = {
    html: (c) => { c.headline = 'Hello <b>world</b>'; },
    angle: (c) => { c.sub = 'a > b'; },
    entity: (c) => { c.badge = 'x &#60; y'; },
    url: (c) => { c.sub = 'See http example'; },
    slashes: (c) => { c.features[0].body = 'go to site://now'; },
    jsurl: (c) => { c.cta = 'JavaScript:alert'; },
    long_badge: (c) => { c.badge = 'x'.repeat(25); },
    long_headline: (c) => { c.headline = 'x'.repeat(71); },
    long_sub: (c) => { c.sub = 'x'.repeat(141); },
    long_feature_title: (c) => { c.features[1].title = 'x'.repeat(33); },
    long_feature_body: (c) => { c.features[1].body = 'x'.repeat(111); },
    long_step_title: (c) => { c.steps[2].title = 'x'.repeat(29); },
    long_step_body: (c) => { c.steps[2].body = 'x'.repeat(91); },
    long_cta: (c) => { c.cta = 'x'.repeat(25); },
    two_features: (c) => { c.features.pop(); },
    four_steps: (c) => { c.steps.push({ title: 'a', body: 'b' }); },
    features_not_list: (c) => { c.features = 'three'; },
    number: (c) => { c.badge = 5; },
    null_value: (c) => { c.sub = null; },
    missing: (c) => { delete c.cta; },
    empty: (c) => { c.headline = '   '; },
    control: (c) => { c.sub = 'line\nbreak'; },
    nul: (c) => { c.badge = 'a\u0000b'; },
    step_item_not_object: (c) => { c.steps[0] = 'text'; },
    object_value: (c) => { c.cta = { a: 1 }; },
  };
  for (const [name, mut] of Object.entries(cases)) { const r = bad(mut); assert.equal(r.ok, false, name); assert.ok(r.errors.length >= 1, name); }
  assert.equal(validateContent(null).ok, false); assert.equal(validateContent([]).ok, false); assert.equal(validateContent('x').ok, false);
});

test('schema: slugOf maps the council topics and builds a safe slug otherwise', () => {
  const m = { treasury: 'treasury', signing: 'signing', intents: 'intents', ai_agents: 'ai-agents', dev_tooling: 'dev-tooling', data_indexing: 'data-indexing', wallet_ux: 'wallet-ux' };
  for (const [t, s] of Object.entries(m)) assert.equal(slugOf({ topic: t, title: 'Whatever' }), s);
  assert.equal(slugOf({ title: 'A "Weird" Name / <x>!' }), 'a-weird-name-x');
  assert.equal(slugOf({}), 'product');
  assert.match(slugOf({ topic: '../../etc', title: '' }), /^[a-z0-9-]+$/);
});

// ------------------------------------------------------------------------------------------ render
const HOSTILE = `"><script>alert(1)</script><img src=x onerror=alert(2)>'&amp;`;
const hostileContent = () => ({ badge: HOSTILE, headline: HOSTILE, sub: HOSTILE, cta: HOSTILE, features: [0, 1, 2].map(() => ({ title: HOSTILE, body: HOSTILE })), steps: [0, 1, 2].map(() => ({ title: HOSTILE, body: HOSTILE })) });

test('render: hostile strings are escaped in every field (renderer does not rely on the validator)', () => {
  const html = renderSite({ content: hostileContent(), meta: meta({ title: HOSTILE, model: HOSTILE, verdict: HOSTILE, hash: HOSTILE, evidence: [{ title: HOSTILE, url: `https://example.org/"><script>x</script>` }, { title: 'x', url: 'javascript:alert(1)' }] }) });
  assert.ok(!html.includes('<img'), 'no injected tag');
  assert.ok(!/<script>alert/.test(html));
  assert.ok(!html.includes('onerror=alert(2)>'), 'no live attribute');
  assert.equal((html.match(/<script/g) ?? []).length, 1, 'exactly one script tag');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&quot;&gt;&lt;script&gt;'));
  assert.ok(!html.includes('javascript:alert'), 'a javascript: evidence URL is dropped');
  assert.ok(!html.includes('<script>x</script>'));
});

test('render: deterministic, one script (/swarm.js), data-sw markers in order, no external requests', () => {
  const a = renderSite({ content: good(), meta: meta() }); const b = renderSite({ content: good(), meta: meta() });
  assert.equal(a, b);
  const scripts = a.match(/<script\b[^>]*>/g); assert.deepEqual(scripts, ['<script src="/swarm.js" defer>']);
  assert.match(a, /<meta name="viewport"/); assert.match(a, /<noscript><style>/);
  const kinds = [...a.matchAll(/data-sw="(\w+)" data-sw-agent="(\w+)"/g)];
  assert.ok(kinds.length > 25);
  for (const [, k, ag] of kinds) { assert.ok(['box', 'text', 'button', 'line', 'media'].includes(k)); assert.ok(['Copy', 'Layout', 'Style', 'Media', 'Check'].includes(ag)); }
  const set = new Set(kinds.map((x) => x[1])); for (const k of ['box', 'text', 'button', 'line', 'media']) assert.ok(set.has(k), k);
  // order: top bar, hero, features, steps, council, footer
  const at = (s) => a.indexOf(s); const order = ['class="brand"', 'class="badge"', 'What it would do', 'How it would work', 'The council scored this', 'Example page written by AutoNEAR agents'];
  order.reduce((prev, s) => { assert.ok(at(s) > prev, s); return at(s); }, -1);
  // parents before children: the hero box opens before its headline
  assert.ok(a.indexOf('class="hero"') < a.indexOf('<h1'));
  assert.ok(!/(src|href)="(?!\/swarm\.js|data:,)/.test(a.replace(/<a href="[^"]*"/g, '')), 'no external src/href outside evidence links');
  assert.ok(!/url\(|@import|<link rel="stylesheet"/.test(a));
});

test('render: council line, override line, footer note, evidence as text or escaped http(s) link', () => {
  const go = renderSite({ content: good(), meta: meta() });
  assert.match(go, /The council scored this 71 out of 100: GO/);
  assert.ok(!go.includes('on the owner'));
  assert.ok(go.includes('Example page written by AutoNEAR agents from stored evidence. Not a live service.'));
  assert.ok(!go.includes('>Example page<'), 'the top bar carries no label; the footer note says it is an example');
  assert.ok(go.includes('2026-11-06'));
  assert.ok(go.includes('<li><a href="https://example.org/a?x=1&amp;y=2" rel="noopener noreferrer" target="_blank">Multisig payout fails</a></li>'));
  assert.ok(go.includes('<li>No link here</li>'));
  assert.ok(go.includes(shortHash(good())));
  const ov = renderSite({ content: good(), meta: meta({ verdict: 'watch', support: 0.55, override: true }) });
  assert.match(ov, /The council scored this 55 out of 100: WATCH/);
  assert.ok(ov.includes('Built on the owner&#39;s call. The council said WATCH.'));
});

test('hash: changes with content and with the template version; short hash is 10 hex characters', () => {
  const h = contentHash(good()); const c = good(); c.cta = 'Other';
  assert.match(h, /^[0-9a-f]{64}$/); assert.notEqual(h, contentHash(c)); assert.notEqual(h, contentHash(good(), 'v2'));
  assert.equal(TEMPLATE_VERSION, 'v1'); assert.equal(h, contentHash(good(), 'v1'));
  const reordered = Object.fromEntries(Object.entries(good()).reverse()); assert.equal(h, contentHash(reordered));
  assert.match(shortHash(good()), /^[0-9a-f]{10}$/);
});

test('vercel.json: /develop is excluded from the global header block and has the same CSP as the app', () => {
  const v = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const dev = v.headers.find((h) => h.source === '/develop/(.*)'); assert.ok(dev);
  assert.equal(dev.headers.find((h) => h.key === 'Content-Security-Policy').value, SITE_CSP);
  assert.equal(dev.headers.find((h) => h.key === 'X-Frame-Options').value, 'SAMEORIGIN');
  const global = v.headers.find((h) => h.headers.some((x) => x.value === 'DENY'));
  assert.ok(global.source.includes('(?!develop/)'));
  assert.ok(v.rewrites.some((r) => r.source === '/develop/(.*)' && r.destination === '/api/index'));
});

// ------------------------------------------------------------------------------------------ generateContent (mocked Gemini)
function withGemini(replies, fn) {
  const prev = { ...config.llm }; const orig = globalThis.fetch; const calls = [];
  config.llm.provider = 'gemini'; config.llm.geminiKey = 'test-key-not-real'; config.llm.geminiModel = 'gemini-test';
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: typeof r === 'string' ? r : JSON.stringify(r) }] } }], usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 300 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return fn(calls).finally(() => { globalThis.fetch = orig; Object.assign(config.llm, prev); });
}
const gIn = () => ({ opportunity: { title: 'DAO treasury', thesis: 'A hypothesis.' }, entry: { reason: 'The score of 71 out of 100 is above the 62 needed.' }, evidenceTitles: ['Multisig payout fails', 'Policy missing <b>x</b>'] });

test('generateContent: valid answer is returned with model, tokens and cost; prompt is grounded and small', () => withGemini([good()], async (calls) => {
  const r = await generateContent(gIn());
  assert.deepEqual(r.content, good()); assert.equal(r.model, 'gemini-test'); assert.equal(r.tokens, 800); assert.ok(r.cost > 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].generationConfig.maxOutputTokens, 900);
  const user = calls[0].contents[0].parts[0].text;
  assert.match(user, /Council reason: The score of 71/); assert.match(user, /<evidence n="1">Multisig payout fails<\/evidence>/);
  assert.ok(!user.includes('<b>'), 'markup in an evidence title is removed before it reaches the prompt');
  assert.match(calls[0].systemInstruction.parts[0].text, /does not exist yet/);
}));

test('generateContent: bad first answer is retried once with the error list, then accepted', () => withGemini([{ ...good(), headline: 'See http://x.example' }, good()], async (calls) => {
  const r = await generateContent(gIn());
  assert.equal(calls.length, 2); assert.deepEqual(r.content, good()); assert.equal(r.tokens, 1600);
  assert.match(calls[1].contents[0].parts[0].text, /rejected for these reasons[\s\S]*headline/);
}));

test('generateContent: throws after the second bad answer (also for text that is not JSON)', async () => {
  await withGemini([{ ...good(), badge: '<i>x</i>' }], async (calls) => {
    await assert.rejects(generateContent(gIn()), /rejected twice/); assert.equal(calls.length, 2);
  });
  await withGemini(['I cannot do that.'], async (calls) => {
    await assert.rejects(generateContent(gIn()), /rejected twice/); assert.equal(calls.length, 2);
  });
});

test('generateContent: no LLM configured is a clear error', async () => {
  const prev = { ...config.llm }; config.llm.provider = 'none';
  try { await assert.rejects(generateContent(gIn()), /No LLM is configured/); } finally { Object.assign(config.llm, prev); }
});

// ------------------------------------------------------------------------------------------ store
test('store: save, get, publish keeps exactly one published row per slug, unpublish clears it', async () => {
  const db = await memDb(); const c1 = good(); const c2 = { ...good(), cta: 'Other' }; const h1 = shortHash(c1); const h2 = shortHash(c2);
  await saveSite(db, { slug: 'treasury', oppId: 'opp_treasury', hash: h1, content: c1, meta: meta(), createdAt: 1000 });
  await saveSite(db, { slug: 'treasury', oppId: 'opp_treasury', hash: h2, content: c2, meta: meta(), createdAt: 2000 });
  await saveSite(db, { slug: 'treasury', oppId: 'opp_treasury', hash: h2, content: c2, meta: meta(), createdAt: 3000 }); // same version again: kept as it is
  assert.equal((await latestBuilt(db, 'treasury')).hash, h2); assert.equal((await getSite(db, 'treasury', h2)).created_at, 2000);
  assert.equal(await latestPublished(db, 'treasury'), null);
  await publish(db, 'treasury', h1); assert.equal((await latestPublished(db, 'treasury')).hash, h1);
  await publish(db, 'treasury', h2); assert.equal((await latestPublished(db, 'treasury')).hash, h2);
  assert.equal((await db.all('SELECT * FROM sites WHERE published_at IS NOT NULL')).length, 1);
  await assert.rejects(publish(db, 'treasury', 'ffffffffff'), /no such stored page version/);
  assert.equal((await listSites(db)).length, 2); assert.equal((await listSites(db))[0].content, undefined);
  assert.equal(await unpublish(db, 'treasury'), true); assert.equal(await latestPublished(db, 'treasury'), null); assert.equal(await unpublish(db, 'treasury'), false);
});

// ------------------------------------------------------------------------------------------ endpoints
const HOST = 'app.example'; const owner = privateKeyToAccount(generatePrivateKey()); const other = privateKeyToAccount(generatePrivateKey());
let n = 0;
async function seeded() {
  const db = await memDb();
  const mk = (id, k) => fakeConnector(id, Array.from({ length: k }, (_, i) => gh(i + 1, { externalId: `${id}${i}`, author: `${id}-u${i}`, title: `Treasury multisig payout fails (${id}-${i})`, body: `We cannot rebalance DAO treasury ${id}${i}`, url: `https://example.org/${id}/${i}` })));
  const conns = [mk('s1', 6), mk('s2', 6)];
  await registerSources(db, conns); for (const c of conns) await ingestSource(db, c); await refreshOpportunities(db);
  // a fixed, fresh council result so verdicts are known: treasury GO, signing WATCH, intents DROP
  const e = (oppId, topic, verdict, support) => ({ oppId, topic, title: oppId, verdict, support, score: 0.6, confidence: 0.6, reason: `fixture reason for ${verdict}`, buildable: verdict === 'go', votes: [] });
  for (const [id, topic] of [['opp_signing', 'signing'], ['opp_intents', 'intents']]) await db.run("INSERT OR IGNORE INTO opportunities(id,title,thesis,problem,audience,topic,score_breakdown,score,confidence,warnings,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'{}',0.5,0.5,'[]','open',?,?)", [id, `Fixture ${topic}`, 'A hypothesis.', 'p', 'a', topic, Date.now(), Date.now()]);
  const council = { at: Date.now(), rules: {}, opportunities: [e('opp_treasury', 'treasury', 'go', 0.71), e('opp_signing', 'signing', 'watch', 0.55), e('opp_intents', 'intents', 'drop', 0.2)], winner: 'opp_treasury' };
  await db.run("INSERT INTO kv(k,v) VALUES('council:last',?)", [JSON.stringify(council)]);
  return db;
}
const mkApp = async (extra = {}) => { const db = await seeded(); const app = createApp({ db, operatorToken: 'op-token', ownerAddress: owner.address, defer: () => {}, ...extra }); app.db = db; app.ip = `10.9.0.${++n}`; return app; };
const call = async (app, path, init = {}) => {
  const r = await app(new Request('http://' + HOST + path, { ...init, headers: { host: HOST, 'x-peer-ip': app.ip, 'content-type': 'application/json', ...(init.headers ?? {}) } }));
  const text = await r.text(); let body = text; try { body = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, headers: r.headers, body };
};
const OWNER = { authorization: 'Bearer op-token' };
const post = (app, path, body = {}, headers = OWNER) => call(app, path, { method: 'POST', headers, body: JSON.stringify(body) });

async function ownerSession(app, account) {
  const ch = await call(app, '/api/auth/challenge', { method: 'POST', body: JSON.stringify({ address: account.address }) });
  const signature = await account.signMessage({ message: ch.body.message });
  return call(app, '/api/auth/session', { method: 'POST', body: JSON.stringify({ address: account.address, message: ch.body.message, signature }) });
}

test('endpoints: build needs the owner (no token, wrong token, non-owner wallet)', () => withGemini([good()], async (calls) => {
  const app = await mkApp();
  assert.equal((await post(app, '/api/sites/opp_treasury/build', {}, {})).status, 401);
  assert.equal((await post(app, '/api/sites/opp_treasury/build', {}, { authorization: 'Bearer nope' })).status, 401);
  const o = await ownerSession(app, other); assert.equal(o.body.token, null);
  assert.equal((await post(app, '/api/sites/opp_treasury/build', {}, { authorization: `Bearer ${o.body.token}` })).status, 401);
  assert.equal(calls.length, 0, 'no model call without an owner');
  const s = await ownerSession(app, owner); assert.ok(s.body.token);
  const ok = await post(app, '/api/sites/opp_treasury/build', {}, { authorization: `Bearer ${s.body.token}` });
  assert.equal(ok.status, 201, JSON.stringify(ok.body)); assert.equal(calls.length, 1);
}));

test('endpoints: WATCH without override is 409, with override it builds and the page says so; DROP is refused', () => withGemini([good()], async (calls) => {
  const app = await mkApp();
  const no = await post(app, '/api/sites/opp_signing/build', {}); assert.equal(no.status, 409); assert.match(no.body.error, /WATCH, not GO/); assert.equal(calls.length, 0);
  assert.equal((await post(app, '/api/sites/opp_signing/build', { override: 'yes' })).status, 400);
  const yes = await post(app, '/api/sites/opp_signing/build', { override: true }); assert.equal(yes.status, 201, JSON.stringify(yes.body));
  assert.equal(yes.body.site.override, true); assert.equal(yes.body.site.slug, 'signing');
  const page = await call(app, `/develop/signing/${yes.body.site.hash}`);
  assert.equal(page.status, 200); assert.ok(page.body.includes('Built on the owner&#39;s call. The council said WATCH.'));
  assert.equal((await post(app, '/api/sites/opp_intents/build', { override: true })).status, 409);
  assert.equal((await post(app, '/api/sites/opp_nothing/build', {})).status, 404);
  const audit = await app.db.all("SELECT detail FROM audit WHERE action='site.build'"); assert.equal(audit.length, 1); assert.equal(JSON.parse(audit[0].detail).override, true);
}));

test('endpoints: build is idempotent (no second model call); regenerate asks again', () => withGemini([good(), { ...good(), cta: 'Another' }], async (calls) => {
  const app = await mkApp();
  const a = await post(app, '/api/sites/opp_treasury/build'); const b = await post(app, '/api/sites/opp_treasury/build');
  assert.equal(a.status, 201); assert.equal(b.status, 200); assert.equal(a.body.site.hash, b.body.site.hash); assert.equal(b.body.created, false); assert.equal(calls.length, 1);
  assert.equal(a.body.site.model, 'gemini-test'); assert.equal(a.body.site.tokens, 800);
  const c = await post(app, '/api/sites/opp_treasury/build', { regenerate: true }); assert.equal(c.status, 201); assert.notEqual(c.body.site.hash, a.body.site.hash); assert.equal(calls.length, 2);
}));

test('endpoints: build without an LLM is 503 with a plain reason; bad model output is 502', async () => {
  const app = await mkApp(); const prev = { ...config.llm }; config.llm.provider = 'none';
  try { const r = await post(app, '/api/sites/opp_treasury/build'); assert.equal(r.status, 503); assert.match(r.body.error, /No LLM is configured/); } finally { Object.assign(config.llm, prev); }
  await withGemini(['nope'], async () => { const r = await post(app, '/api/sites/opp_treasury/build'); assert.equal(r.status, 502); assert.match(r.body.error, /rejected twice/); });
});

test('endpoints: GET /api/sites is public and lists the council products', () => withGemini([good()], async () => {
  const app = await mkApp();
  const before = await call(app, '/api/sites'); assert.equal(before.status, 200);
  const t = before.body.items.find((x) => x.slug === 'treasury'); assert.deepEqual([t.opp_id, t.verdict, t.buildable, t.hash, t.published], ['opp_treasury', 'go', true, null, false]);
  assert.equal(before.body.items.find((x) => x.slug === 'signing').buildable, false);
  const built = await post(app, '/api/sites/opp_treasury/build');
  await post(app, '/api/sites/treasury/publish', { hash: built.body.site.hash });
  const after = (await call(app, '/api/sites')).body.items.find((x) => x.slug === 'treasury');
  assert.equal(after.hash, built.body.site.hash); assert.equal(after.published, true); assert.equal(after.published_hash, built.body.site.hash); assert.equal(after.model, 'gemini-test'); assert.ok(after.built_at);
  assert.equal(after.content, undefined);
}));

test('endpoints: publish and unpublish are owner only; /develop/:slug is 404 before publish and 200 after, and 404 again after unpublish', () => withGemini([good()], async () => {
  const app = await mkApp();
  const built = await post(app, '/api/sites/opp_treasury/build'); const hash = built.body.site.hash;
  assert.equal((await post(app, '/api/sites/treasury/publish', { hash }, {})).status, 401);
  assert.equal((await post(app, '/api/sites/treasury/unpublish', {}, {})).status, 401);
  assert.equal((await post(app, '/api/sites/treasury/publish', { hash: 'zz' })).status, 400);
  assert.equal((await post(app, '/api/sites/treasury/publish', { hash: 'ffffffffff' })).status, 404);
  assert.equal((await call(app, '/develop/treasury')).status, 404);
  const unlisted = await call(app, `/develop/treasury/${hash}`); assert.equal(unlisted.status, 200); assert.equal(unlisted.headers.get('cache-control'), 'no-store');
  assert.equal((await post(app, '/api/sites/treasury/publish', { hash })).status, 200);
  const live = await call(app, '/develop/treasury'); assert.equal(live.status, 200); assert.equal(live.headers.get('cache-control'), 'public, max-age=60');
  assert.equal((await call(app, `/develop/treasury/${hash}`)).headers.get('cache-control'), 'public, max-age=60');
  assert.equal((await post(app, '/api/sites/treasury/unpublish')).status, 200);
  assert.equal((await call(app, '/develop/treasury')).status, 404);
  const actions = (await app.db.all("SELECT action FROM audit WHERE action LIKE 'site.%' ORDER BY id")).map((r) => r.action); assert.deepEqual(actions, ['site.build', 'site.publish', 'site.unpublish']);
}));

test('endpoints: served page has the exact CSP and the other security headers; 404 pages are plain and escaped', () => withGemini([good()], async () => {
  const app = await mkApp(); const built = await post(app, '/api/sites/opp_treasury/build'); const hash = built.body.site.hash;
  const r = await call(app, `/develop/treasury/${hash}`);
  assert.equal(r.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
  assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8'); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer'); assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.ok(r.body.includes('Not a live service.'));
  for (const path of ['/develop/nothing', '/develop/treasury/ffffffffff', '/develop/%3Cscript%3E', '/develop/treasury/%3Cscript%3Ealert(1)%3C%2Fscript%3E', `/develop/treasury/${hash}/extra`]) {
    const x = await call(app, path);
    assert.ok([404].includes(x.status), path + ' ' + x.status); assert.ok(!String(x.body).includes('<script'), path);
    assert.equal(x.headers.get('content-security-policy'), r.headers.get('content-security-policy'));
  }
  assert.equal((await call(app, `/develop/treasury/${hash}`, { method: 'POST', body: '{}' })).status, 405);
  const head = await app(new Request(`http://${HOST}/develop/treasury/${hash}`, { method: 'HEAD', headers: { host: HOST, 'x-peer-ip': app.ip } })); assert.equal(head.status, 200);
}));

test('endpoints: hostile model content that got into the database never appears unescaped in the served page', async () => {
  const app = await mkApp(); const db = app.db;
  // 1. a hostile answer from the model is rejected by the validator, so nothing is stored
  await withGemini([hostileContent()], async () => { const r = await post(app, '/api/sites/opp_treasury/build'); assert.equal(r.status, 502); });
  assert.equal((await db.all('SELECT * FROM sites')).length, 0);
  // 2. content that passes the validator but is full of quotes and ampersands is escaped
  const tricky = { ...good(), headline: `Say "hello" & 'bye'`, sub: `Fish & chips, a "quoted" part, it's fine` };
  await withGemini([tricky], async () => {
    const r = await post(app, '/api/sites/opp_treasury/build'); assert.equal(r.status, 201);
    const page = (await call(app, `/develop/treasury/${r.body.site.hash}`)).body;
    assert.ok(page.includes('Say &quot;hello&quot; &amp; &#39;bye&#39;')); assert.ok(!page.includes('Say "hello"'));
  });
  // 3. a row written straight into the table with markup fails the check at serve time and is not rendered
  const bad = hostileContent();
  await db.run('INSERT INTO sites(slug,hash,opp_id,content,meta,created_at,published_at) VALUES(?,?,?,?,?,?,NULL)', ['signing', 'abcdef0123', 'opp_signing', JSON.stringify(bad), JSON.stringify({ title: HOSTILE, evidence: [{ title: HOSTILE }] }), Date.now()]);
  const x = await call(app, '/develop/signing/abcdef0123'); assert.equal(x.status, 500);
  assert.ok(!String(x.body).includes('<script>alert')); assert.ok(!String(x.body).includes('onerror'));
  // 4. hostile evidence titles and product title in meta are escaped in a page whose content is fine
  await db.run('INSERT INTO sites(slug,hash,opp_id,content,meta,created_at,published_at) VALUES(?,?,?,?,?,?,NULL)', ['intents', 'abcdef0124', 'opp_intents', JSON.stringify(good()), JSON.stringify({ title: HOSTILE, verdict: 'watch', support: 0.5, override: true, model: HOSTILE, evidence: [{ title: HOSTILE, url: 'https://example.org/x' }] }), Date.now()]);
  const y = await call(app, '/develop/intents/abcdef0124'); assert.equal(y.status, 200);
  assert.ok(!y.body.includes('<img')); assert.equal((y.body.match(/<script/g) ?? []).length, 1);
});

test('endpoints: daily token budget stops a new build', () => withGemini([good()], async (calls) => {
  const app = await mkApp(); const prev = process.env.SITE_DAILY_TOKENS; process.env.SITE_DAILY_TOKENS = '800';
  try {
    assert.equal((await post(app, '/api/sites/opp_treasury/build')).status, 201); // 800 tokens used, the cap is 800
    const r = await post(app, '/api/sites/opp_treasury/build', { regenerate: true }); assert.equal(r.status, 409); assert.match(r.body.error, /daily token budget/); assert.equal(calls.length, 1);
  } finally { if (prev === undefined) delete process.env.SITE_DAILY_TOKENS; else process.env.SITE_DAILY_TOKENS = prev; }
}));

test('schema: marketing filler is rejected with a plain reason', () => {
  const bad = good(); bad.sub = 'A seamless way to move treasury funds.';
  const r = validateContent(bad);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /marketing wording/);
});
