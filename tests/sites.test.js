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
import { pathFor } from '../src/sites/service.js';
import { memDb, fakeConnector, gh } from './helpers.js';

const method = (name, args, returns, does) => ({ name, args, returns, does });
const goodContract = () => ({
  name: 'treasury_vault',
  methods: [
    method('propose_payout', [{ name: 'recipient', type: 'AccountId' }, { name: 'amount', type: 'U128' }], 'U128', 'Opens a payout request that waits for approvals.'),
    method('approve_payout', [{ name: 'proposal_id', type: 'U128' }], 'bool', 'Records one approver for a request.'),
    method('execute_payout', [{ name: 'proposal_id', type: 'U128' }, { name: 'memo', type: 'String' }], 'none', 'Sends the payment once the approvals are in.'),
  ],
});
const good = () => ({
  badge: 'Treasury tooling', headline: 'Pay out a DAO treasury with clear rules', sub: 'A tool that would let a NEAR DAO set payout rules and review each payment before it is sent.',
  features: [{ title: 'Payout rules', body: 'Set who can approve which payment, and up to what amount.' }, { title: 'Review queue', body: 'Every payment waits in a list until enough people approve it.' }, { title: 'History', body: 'A plain record of what was paid, to whom, and who approved it.' }],
  steps: [{ title: 'Connect', body: 'Link the DAO account.' }, { title: 'Set rules', body: 'Choose the approvers and limits.' }, { title: 'Approve', body: 'Review each payment and sign it.' }],
  cta: 'Read the idea',
  contract: goodContract(),
});
const kindsOf = (html) => [...html.matchAll(/data-sw="(\w+)"/g)];
const meta = (over = {}) => ({ slug: 'treasury', title: 'DAO treasury', verdict: 'go', support: 0.71, builtAt: Date.UTC(2026, 10, 6, 12), hash: shortHash(good()), override: false, model: 'gemini-test', evidence: [{ title: 'Multisig payout fails', url: 'https://example.org/a?x=1&y=2' }, { title: 'No link here' }], ...over });

test('schema: a good object passes and is returned with only the known keys', () => {
  const r = validateContent({ ...good(), extra: '<b>x</b>', features: good().features.map((f) => ({ ...f, junk: 1 })) });
  assert.equal(r.ok, true); assert.deepEqual(r.value, good());
});

test('schema: every Rust keyword is rejected as a contract, method or argument name', () => {
  const kw = ['fn', 'pub', 'mut', 'self', 'struct', 'impl', 'let', 'use', 'mod', 'type', 'where', 'match', 'loop', 'move', 'ref', 'static', 'trait', 'crate', 'super', 'enum', 'const', 'as', 'in', 'if', 'else', 'for', 'while', 'return', 'true', 'false'];
  for (const w of kw) {
    const a = good(); a.contract.name = w; assert.equal(validateContent(a).ok, false, `contract ${w}`);
    const b = good(); b.contract.methods[0].name = w; assert.equal(validateContent(b).ok, false, `method ${w}`);
    const c = good(); c.contract.methods[0].args[0].name = w; assert.equal(validateContent(c).ok, false, `arg ${w}`);
  }
  const ok = good(); ok.contract.name = 'self_custody'; ok.contract.methods[0].name = 'return_funds'; assert.equal(validateContent(ok).ok, true, 'a keyword inside a longer name is fine');
});

test('schema: every allowed argument and return type is accepted; the contract comes back with only the known keys', () => {
  const c = good();
  c.contract.methods[0].args = ['AccountId', 'U128', 'String'].map((type, k) => ({ name: `arg_${k}`, type }));
  c.contract.methods[1].args = ['u64', 'bool', 'Vec<String>'].map((type, k) => ({ name: `val_${k}`, type }));
  for (const [k, r] of ['none', 'bool', 'U128', 'String', 'u64'].entries()) c.contract.methods[k % 3].returns = r;
  const r = validateContent({ ...c, contract: { ...c.contract, extra: 'x', methods: c.contract.methods.map((m) => ({ ...m, junk: 1, args: m.args.map((a) => ({ ...a, more: 2 })) })) } });
  assert.equal(r.ok, true, JSON.stringify(r.errors)); assert.deepEqual(r.value.contract, c.contract);
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
    no_contract: (c) => { delete c.contract; },
    contract_not_object: (c) => { c.contract = 'treasury_vault'; },
    contract_name_upper: (c) => { c.contract.name = 'TreasuryVault'; },
    contract_name_short: (c) => { c.contract.name = 'ab'; },
    contract_name_long: (c) => { c.contract.name = 'a'.repeat(25); },
    contract_name_digit_first: (c) => { c.contract.name = '1vault'; },
    contract_name_dash: (c) => { c.contract.name = 'my-vault'; },
    contract_name_keyword: (c) => { c.contract.name = 'struct'; },
    two_methods: (c) => { c.contract.methods.pop(); },
    four_methods: (c) => { c.contract.methods.push(method('cancel_payout', [{ name: 'proposal_id', type: 'U128' }], 'bool', 'Cancels a request.')); },
    methods_not_list: (c) => { c.contract.methods = {}; },
    method_name_short: (c) => { c.contract.methods[0].name = 'go'; },
    method_name_upper: (c) => { c.contract.methods[0].name = 'ProposePayout'; },
    method_name_long: (c) => { c.contract.methods[0].name = 'a' + 'b'.repeat(29); },
    method_name_keyword: (c) => { c.contract.methods[0].name = 'return'; },
    method_name_mut: (c) => { c.contract.methods[1].name = 'mut'; },
    method_duplicate: (c) => { c.contract.methods[1].name = c.contract.methods[0].name; },
    arg_keyword: (c) => { c.contract.methods[0].args[0].name = 'self'; },
    arg_name_short: (c) => { c.contract.methods[0].args[0].name = 'to'; },
    arg_duplicate: (c) => { c.contract.methods[0].args[1].name = c.contract.methods[0].args[0].name; },
    arg_bad_type: (c) => { c.contract.methods[0].args[0].type = 'i32'; },
    arg_type_injection: (c) => { c.contract.methods[0].args[0].type = 'U128) -> ()'; },
    no_args: (c) => { c.contract.methods[0].args = []; },
    four_args: (c) => { c.contract.methods[0].args = ['aaa', 'bbb', 'ccc', 'ddd'].map((name) => ({ name, type: 'u64' })); },
    args_missing: (c) => { delete c.contract.methods[0].args; },
    bad_return: (c) => { c.contract.methods[0].returns = 'ProposalId'; },
    missing_return: (c) => { delete c.contract.methods[0].returns; },
    does_long: (c) => { c.contract.methods[0].does = 'x'.repeat(73); },
    does_empty: (c) => { c.contract.methods[0].does = ' '; },
    does_markup: (c) => { c.contract.methods[0].does = 'Sends <b>funds</b>'; },
    does_link: (c) => { c.contract.methods[0].does = 'See http docs'; },
    does_filler: (c) => { c.contract.methods[0].does = 'Seamless payout of funds.'; },
    does_newline: (c) => { c.contract.methods[0].does = 'a\nb'; },
    method_not_object: (c) => { c.contract.methods[2] = 'execute_payout'; },
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

const HOSTILE = `"><script>alert(1)</script><img src=x onerror=alert(2)>'&amp;`;
const hostileContent = () => ({ badge: HOSTILE, headline: HOSTILE, sub: HOSTILE, cta: HOSTILE, features: [0, 1, 2].map(() => ({ title: HOSTILE, body: HOSTILE })), steps: [0, 1, 2].map(() => ({ title: HOSTILE, body: HOSTILE })), contract: { name: HOSTILE, methods: [0, 1, 2].map(() => method(HOSTILE, [{ name: HOSTILE, type: HOSTILE }], HOSTILE, HOSTILE)) } });
// The text a visitor reads: no style/script/noscript blocks, no tags, no attribute values.
const visibleText = (html) => html.replace(/<(style|script|noscript)\b[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

test('render: hostile strings are escaped in every field (renderer does not rely on the validator)', () => {
  const html = renderSite({ content: hostileContent(), meta: meta({ title: HOSTILE, model: HOSTILE, verdict: HOSTILE, hash: HOSTILE, evidence: [{ title: HOSTILE, url: `https://example.org/"><script>x</script>` }, { title: 'x', url: 'javascript:alert(1)' }] }) });
  assert.ok(!html.includes('<img'), 'no injected tag');
  assert.ok(!/<script>alert/.test(html));
  assert.ok(!html.includes('onerror=alert(2)>'), 'no live attribute');
  assert.deepEqual(html.match(/<script\b[^>]*>/g), ['<script src="/swarm.js">', '<script src="/mark.js" defer>', '<script src="/contract-sim.js" defer>'], 'only our three static scripts');
  assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(html.replace(/&quot;|&#39;/g, '')), 'no handler attribute');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&quot;&gt;&lt;script&gt;'));
  assert.ok(!html.includes('javascript:alert'), 'a javascript: evidence URL is dropped');
  assert.ok(!html.includes('<script>x</script>'));
});

test('render: deterministic, only our three static scripts, data-sw markers in order, no external requests', () => {
  const a = renderSite({ content: good(), meta: meta() }); const b = renderSite({ content: good(), meta: meta() });
  assert.equal(a, b);
  const scripts = a.match(/<script\b[^>]*>/g); assert.deepEqual(scripts, ['<script src="/swarm.js">', '<script src="/mark.js" defer>', '<script src="/contract-sim.js" defer>']);
  assert.ok(!/<script\b(?![^>]*\ssrc="\/(swarm|mark|contract-sim)\.js")/.test(a), 'no inline script');
  assert.ok(!/\son[a-z]+=/i.test(a) && !a.includes('javascript:'), 'no handler attributes');
  assert.ok(kindsOf(a).length < 140, 'the number of marked elements stays small enough for a 10 s replay');
  assert.match(a, /<meta name="viewport"/); assert.match(a, /<noscript><style>/);
  const kinds = [...a.matchAll(/data-sw="(\w+)" data-sw-agent="(\w+)"/g)];
  assert.ok(kinds.length > 25);
  for (const [, k, ag] of kinds) { assert.ok(['box', 'text', 'button', 'line', 'media'].includes(k)); assert.ok(['Copy', 'Layout', 'Style', 'Media', 'Check'].includes(ag)); }
  const set = new Set(kinds.map((x) => x[1])); for (const k of ['box', 'text', 'button', 'line', 'media']) assert.ok(set.has(k), k);
  // order: top bar, hero, features, steps, council, footer
  const at = (s) => a.indexOf(s); const order = ['class="brand"', 'class="eyebrow"', 'What it would do', 'How it would work', 'The contract it would need', 'Interface sketch (not audited, not deployed)', 'Try the limits', 'What it takes to make this real', 'The council scored this', 'Written by AutoNEAR agents'];
  order.reduce((prev, s) => { assert.ok(at(s) > prev, s); return at(s); }, -1);
  // parents before children: the hero box opens before its headline
  assert.ok(a.indexOf('class="hero"') < a.indexOf('<h1'));
  assert.ok(!/(src|href)="(?!\/swarm\.js|\/mark\.js|\/contract-sim\.js|data:,|#|\/")/.test(a.replace(/<a href="https?:[^"]*"/g, '')), 'no external src/href outside evidence links');
  assert.ok(!/url\(|@import|<link rel="stylesheet"/.test(a));
});

test('render: council line, override line, footer note, evidence as text or escaped http(s) link', () => {
  const go = renderSite({ content: good(), meta: meta() });
  assert.match(go, /The council scored this 71 out of 100: GO/);
  assert.ok(!go.includes('on the owner'));
  assert.ok(go.includes('Written by AutoNEAR agents from stored evidence. Not a live service.'));
  assert.ok(!/concept/i.test(go), 'the word concept does not appear anywhere in the page');
  assert.ok(go.includes('Simulation in your browser. Nothing is sent to any network.'));
  assert.ok(go.includes('WATCH 48') && go.includes('GO 62') && go.includes('style="width:71%"'));
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
  assert.match(h, /^[0-9a-f]{64}$/); assert.notEqual(h, contentHash(c)); assert.notEqual(h, contentHash(good(), 'v3'));
  assert.equal(TEMPLATE_VERSION, 'v2'); assert.equal(h, contentHash(good(), 'v2')); assert.notEqual(h, contentHash(good(), 'v1'));
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
  assert.equal(calls[0].generationConfig.maxOutputTokens, 1400);
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
  // 3. a row written straight into the table with markup fails the check at serve time and is not rendered (it is shown as out of date)
  const bad = hostileContent();
  await db.run('INSERT INTO sites(slug,hash,opp_id,content,meta,created_at,published_at) VALUES(?,?,?,?,?,?,NULL)', ['signing', 'abcdef0123', 'opp_signing', JSON.stringify(bad), JSON.stringify({ title: HOSTILE, evidence: [{ title: HOSTILE }] }), Date.now()]);
  const x = await call(app, '/develop/signing/abcdef0123'); assert.equal(x.status, 404); assert.match(x.body, /out of date/);
  assert.ok(!String(x.body).includes('<script>alert')); assert.ok(!String(x.body).includes('onerror'));
  // 4. hostile evidence titles and product title in meta are escaped in a page whose content is fine
  await db.run('INSERT INTO sites(slug,hash,opp_id,content,meta,created_at,published_at) VALUES(?,?,?,?,?,?,NULL)', ['intents', 'abcdef0124', 'opp_intents', JSON.stringify(good()), JSON.stringify({ title: HOSTILE, verdict: 'watch', support: 0.5, override: true, model: HOSTILE, evidence: [{ title: HOSTILE, url: 'https://example.org/x' }] }), Date.now()]);
  const y = await call(app, '/develop/intents/abcdef0124'); assert.equal(y.status, 200);
  assert.ok(!y.body.includes('<img')); assert.equal((y.body.match(/<script/g) ?? []).length, 3);
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

test('render: neither example nor concept appears in the visible text or the title', () => {
  const html = renderSite({ content: good(), meta: meta() });
  assert.ok(!/example/i.test(visibleText(html)), 'visible text');
  assert.ok(!/example/i.test(html.match(/<title>[^<]*<\/title>/)[0]), 'title');
  assert.ok(!/example/i.test(html.replace(/https?:\/\/example\.org[^"]*/g, '')), 'markup, apart from the evidence link in the fixture');
  assert.ok(!/concept/i.test(visibleText(html)) && !/concept/i.test(html.match(/<title>[^<]*<\/title>/)[0]));
  assert.match(html, /<title>DAO treasury<\/title>/);
});

test('render: the contract sketch is composed by our code from names and sentences, with syntax spans', () => {
  const html = renderSite({ content: good(), meta: meta() });
  assert.ok(html.includes('<span class="k">pub</span> <span class="k">struct</span> <span class="t">TreasuryVault</span><span class="p">;</span>'));
  assert.ok(html.includes('<span class="k">impl</span> <span class="t">TreasuryVault</span>'));
  const sig = '<span class="k">pub</span> <span class="k">fn</span> <span class="n">propose_payout</span><span class="p">(</span><span class="p">&amp;</span><span class="k">mut</span> <span class="k">self</span><span class="p">,</span> <span class="n">recipient</span><span class="p">:</span> <span class="t">AccountId</span><span class="p">,</span> <span class="n">amount</span><span class="p">:</span> <span class="t">U128</span><span class="p">)</span> <span class="p">-&gt;</span> <span class="t">U128</span><span class="p">;</span>';
  assert.ok(html.includes(sig), 'signature line');
  assert.ok(html.includes('<span class="c">// Opens a payout request that waits for approvals.</span>'));
  const text = visibleText(html);
  assert.ok(text.includes('pub fn execute_payout (&mut self , proposal_id : U128 , memo : String ) ;') || /execute_payout/.test(text));
  assert.ok(!/execute_payout[^;]*->/.test(visibleText(html.match(/<pre[\s\S]*?<\/pre>/)[0]).replace(/\s+/g, ' ').replace(/ ([,:;()])/g, '$1')), 'return type none has no arrow');
  const lines = html.match(/<span class="l" data-sw="text"/g); assert.equal(lines.length, 1 + 1 + 6 + 1, 'struct, impl, comment and signature for 3 methods, closing brace');
  assert.ok(html.includes('Interface sketch (not audited, not deployed)'));
});

test('render: the simulation form lists the contract methods and uses only data-sim hooks', () => {
  const html = renderSite({ content: good(), meta: meta() });
  for (const name of ['propose_payout', 'approve_payout', 'execute_payout']) {
    assert.ok(html.includes(`<option value="${name}">${name}</option>`), name);
    assert.ok(html.includes(`<input type="checkbox" data-sim="allow" value="${name}" checked>`), name);
  }
  for (const hook of ['form', 'method', 'amount', 'percall', 'perperiod', 'percall-out', 'perperiod-out', 'spent', 'meter', 'log', 'run', 'reset']) assert.ok(html.includes(`data-sim="${hook}"`), hook);
  assert.ok(html.includes('<form data-sim="form"'));
  assert.ok(!/<form[^>]*\saction=/.test(html));
});

test('render: the hero mark depends only on the hash, and the card icons are drawn by us', () => {
  const svgOf = (h, over = {}) => renderSite({ content: good(), meta: meta({ hash: h, ...over }) }).match(/<svg class="mark-fb"[\s\S]*?<\/svg>/)[0];
  const a = svgOf('0123456789'); assert.equal(a, svgOf('0123456789', { title: 'Other title', support: 0.2, model: 'x', evidence: [] }));
  const c = { ...good(), headline: 'Another headline for the same hash' };
  assert.equal(a, renderSite({ content: c, meta: meta({ hash: '0123456789' }) }).match(/<svg class="mark-fb"[\s\S]*?<\/svg>/)[0], 'content does not change the mark');
  assert.notEqual(a, svgOf('abcdef0123')); assert.notEqual(svgOf('abcdef0123'), svgOf('abcdef0124'));
  assert.match(a, /aria-hidden="true"/); assert.ok(a.length < 20000, `the still mark is ${a.length} bytes`);
  const html = renderSite({ content: good(), meta: meta({ hash: '0123456789' }) });
  assert.ok(html.includes('<canvas data-mark data-seed="0123456789" aria-hidden="true" data-sw="media" data-sw-agent="Media"></canvas>'));
  assert.equal((html.match(/<svg class="icon"/g) ?? []).length, 3);
  const kinds = new Set([...html.matchAll(/<svg class="icon"[^>]*>(.*?)<\/svg>/g)].map((m) => m[1])); assert.equal(kinds.size, 3, 'three different icons');
});

test('render: path states are shown as DONE, NEXT or LATER with their notes escaped; a missing path says it is not available', () => {
  const path = [{ key: 'contract', state: 'done', note: 'A contract template exists for this topic.' }, { key: 'build', state: 'next', note: `Note <b>${HOSTILE}` }, { key: 'approval', state: 'later', note: 'later note' }, { key: 'testnet', state: 'bogus', note: 'n' }];
  const html = renderSite({ content: good(), meta: meta({ path }) });
  const rows = [...html.matchAll(/<li class="p-row (\w+)"[\s\S]*?<span class="p-state">(\w+)<\/span>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(rows, [['done', 'DONE'], ['next', 'NEXT'], ['later', 'LATER'], ['later', 'LATER']]);
  for (const t of ['Contract written and tested', 'Build attested', 'Deploy request approved by the owner', 'Running on NEAR testnet through the vault']) assert.ok(html.includes(t), t);
  assert.ok(!html.includes('<b>Note')); assert.ok(html.includes('Note &lt;b&gt;'));
  const none = renderSite({ content: good(), meta: meta() });
  assert.equal([...none.matchAll(/<span class="p-state">LATER<\/span>/g)].length, 4); assert.ok(none.includes('not available for this page'));
});

test('render: escapes every new field (contract name, method names, arg names and types, sentences)', () => {
  const html = renderSite({ content: hostileContent(), meta: meta({ path: [{ key: 'contract', state: 'done', note: HOSTILE }] }) });
  assert.ok(!html.includes('<img') && !/<script>alert/.test(html) && !html.includes('onerror=alert(2)>'));
  assert.ok(!/<option value="[^"]*"[^>]*"/.test(html.replace(/&quot;/g, '')));
  assert.ok((html.match(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/g) ?? []).length > 10);
  assert.equal(renderSite({ content: hostileContent(), meta: meta() }), renderSite({ content: hostileContent(), meta: meta() }));
});

test('endpoints: a stored version without the contract field is stale: listed as stale, shown as out of date with the same CSP, and rebuilt by a plain build', () => withGemini([good()], async (calls) => {
  const app = await mkApp(); const db = app.db;
  const old = { badge: 'Example product', headline: 'Pay out a DAO treasury with clear rules', sub: 'A tool that would let a NEAR DAO set payout rules.', features: good().features, steps: good().steps, cta: 'Read the idea' };
  await db.run('INSERT INTO sites(slug,hash,opp_id,content,meta,created_at,published_at) VALUES(?,?,?,?,?,?,?)', ['treasury', 'aaaaaaaaaa', 'opp_treasury', JSON.stringify(old), JSON.stringify({ title: 'DAO treasury', template: 'v1' }), Date.now() - 1000, Date.now() - 500]);
  const list = (await call(app, '/api/sites')).body.items.find((x) => x.slug === 'treasury');
  assert.equal(list.stale, true); assert.equal(list.hash, 'aaaaaaaaaa');
  assert.equal((await call(app, '/api/sites')).body.items.find((x) => x.slug === 'signing').stale, undefined);
  for (const path of ['/develop/treasury', '/develop/treasury/aaaaaaaaaa']) {
    const r = await call(app, path);
    assert.equal(r.status, 404, path); assert.match(r.body, /This version is out of date/); assert.equal(r.headers.get('content-security-policy'), SITE_CSP); assert.ok(!r.body.includes('<script'));
  }
  const b = await post(app, '/api/sites/opp_treasury/build');
  assert.equal(b.status, 201, JSON.stringify(b.body)); assert.equal(calls.length, 1); assert.notEqual(b.body.site.hash, 'aaaaaaaaaa');
  const again = await post(app, '/api/sites/opp_treasury/build'); assert.equal(again.status, 200); assert.equal(calls.length, 1, 'the new version is reused');
  const fresh = (await call(app, '/api/sites')).body.items.find((x) => x.slug === 'treasury'); assert.equal(fresh.stale, undefined); assert.equal(fresh.hash, b.body.site.hash);
  assert.equal((await call(app, `/develop/treasury/${b.body.site.hash}`)).status, 200);
}));

test('endpoints: the served page carries the real path state of the product', () => withGemini([good()], async () => {
  const app = await mkApp(); const built = await post(app, '/api/sites/opp_treasury/build'); const page = (await call(app, `/develop/treasury/${built.body.site.hash}`)).body;
  const rows = [...page.matchAll(/<li class="p-row (\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(rows, ['done', 'next', 'later', 'later'], 'treasury has a template; nothing else is stored');
  assert.match(page, /No attested build is stored yet/);
  const sig = await post(app, '/api/sites/opp_signing/build', { override: true });
  const p2 = (await call(app, `/develop/signing/${sig.body.site.hash}`)).body;
  assert.deepEqual([...p2.matchAll(/<li class="p-row (\w+)"/g)].map((m) => m[1]), ['next', 'later', 'later', 'later']);
  assert.match(p2, /None exists yet/);
}));

const stateOf = (path) => path.map((p) => p.state);
async function pathDb(topic = 'treasury') {
  const db = await memDb(); const t = Date.now();
  await db.run("INSERT INTO opportunities(id,title,thesis,problem,audience,topic,score_breakdown,score,confidence,warnings,status,created_at,updated_at) VALUES('opp_x','X','h','p','a',?,'{}',0.5,0.5,'[]','open',?,?)", [topic, t, t]);
  return db;
}
const addRun = (db, id = 'run_1') => db.run("INSERT INTO runs(id,idem_key,opportunity_id,trigger,state,budget,started_at) VALUES(?,?,?,?,?,?,?)", [id, id, 'opp_x', 'manual', 'succeeded', '{}', Date.now()]);
const addBuild = (db, passed = 84) => db.run("INSERT INTO artifacts(id,run_id,kind,immutable_ref,hash,commit_sha,test_results,created_at) VALUES('art_1',NULL,'contract-build:near','ref','h1','abc',?,?)", [JSON.stringify({ passed, failed: 0 }), Date.now()]);
const addDecision = (db, status, approver = null, id = 'dec_1') => db.run("INSERT INTO decisions(id,run_id,artifact_hash,action,chain_id,target,method,max_spend,expiry,nonce,payload,payload_hash,approver,status,decided_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [id, 'run_1', 'h1', 'deploy_testnet', 'near-testnet', 't', 'm', '0', Date.now() + 1e6, 'n' + id, '{}', 'ph', approver, status, approver ? Date.now() : null, Date.now()]);
const addDeploy = (db, status = 'verified', network = 'near-testnet') => db.run("INSERT INTO deployments(id,decision_id,network,account,artifact_hash,transaction_hash,explorer_url,time,status,verification) VALUES('dep_1','dec_1',?,?,?,?,?,?,?,?)", [network, 'vault.test.near', 'h1', 'tx1', '', Date.now(), status, '{}']);

test('path: a product without a template has one NEXT step and three LATER, and the first note says none exists', async () => {
  const db = await pathDb('intents'); await addBuild(db); // an attested build of another product does not count
  const p = await pathFor(db, 'opp_x');
  assert.deepEqual(stateOf(p), ['next', 'later', 'later', 'later']); assert.deepEqual(p.map((x) => x.key), ['contract', 'build', 'approval', 'testnet']);
  assert.match(p[0].note, /has to be written and tested\. None exists yet/);
});

test('path: a template without any stored build, decision or deployment is done / next / later / later', async () => {
  const db = await pathDb(); const p = await pathFor(db, 'opp_x');
  assert.deepEqual(stateOf(p), ['done', 'next', 'later', 'later']); assert.match(p[1].note, /No attested build is stored yet/);
});

test('path: an attested build is done and its note carries the stored test count', async () => {
  const db = await pathDb(); await addBuild(db, 84); const p = await pathFor(db, 'opp_x');
  assert.deepEqual(stateOf(p), ['done', 'done', 'next', 'later']); assert.match(p[1].note, /84 tests passed/);
  assert.match(p[2].note, /No deploy request exists/);
});

test('path: pending, rejected and expired decisions are not approvals; approved and executed are', async () => {
  for (const [status, expect, re] of [['pending', 'next', /is pending/], ['rejected', 'next', /is rejected/], ['approved', 'done', /owner approved the deploy request/], ['executed', 'done', /owner approved/]]) {
    const db = await pathDb(); await addBuild(db); await addRun(db); await addDecision(db, status, status === 'approved' || status === 'executed' ? '0xowner' : null);
    const p = await pathFor(db, 'opp_x'); assert.equal(p[2].state, expect, status); assert.match(p[2].note, re, status);
  }
  const db = await pathDb(); await addRun(db); await addDecision(db, 'approved', 'mandate:vault1:1'); assert.match((await pathFor(db, 'opp_x'))[2].note, /standing mandate\. No person signed/);
  const ex = await pathDb(); await addRun(ex); await ex.run("INSERT INTO decisions(id,run_id,artifact_hash,action,chain_id,target,method,max_spend,expiry,nonce,payload,payload_hash,status,created_at) VALUES('d2','run_1','h','deploy_testnet','near-testnet','t','m','0',1,'n2','{}','p','pending',1)");
  assert.match((await pathFor(ex, 'opp_x'))[2].note, /is expired/);
});

test('path: only a decision of this product and of the deploy_testnet kind counts', async () => {
  const db = await pathDb(); await addBuild(db); await addRun(db); await addDecision(db, 'approved', '0xowner');
  await db.run("UPDATE decisions SET action='grant_mandate'"); assert.equal((await pathFor(db, 'opp_x'))[2].state, 'next');
  await db.run("UPDATE decisions SET action='deploy_testnet'"); await db.run("UPDATE runs SET opportunity_id='opp_other'"); assert.equal((await pathFor(db, 'opp_x'))[2].state, 'next');
});

test('path: running on testnet needs a verified near-testnet deployment that went through the vault', async () => {
  const mk = async (status, network, viaVault) => {
    const db = await pathDb(); await addBuild(db); await addRun(db); await addDecision(db, 'executed', '0xowner'); await addDeploy(db, status, network);
    if (viaVault) await db.run("INSERT INTO mandate_runs(decision_id,vault_id,epoch,tx_hash,status,created_at) VALUES('dec_1','v',1,'tx1','confirmed',1)");
    return pathFor(db, 'opp_x');
  };
  const vault = await mk('verified', 'near-testnet', true); assert.deepEqual(stateOf(vault), ['done', 'done', 'done', 'done']); assert.match(vault[3].note, /through the vault on NEAR testnet as vault\.test\.near/);
  const owner = await mk('verified', 'near-testnet', false); assert.equal(owner[3].state, 'next'); assert.match(owner[3].note, /signed by the owner\. It was not run through the vault/);
  const local = await mk('verified_local', 'near-testnet', true); assert.equal(local[3].state, 'next'); assert.match(local[3].note, /verified_local/);
  const failed = await mk('failed', 'near-testnet', true); assert.equal(failed[3].state, 'next');
  const other = await mk('verified', 'evm:84532', true); assert.equal(other[3].state, 'next');
});

test('path: an unknown product does not throw and has nothing done', async () => {
  const db = await memDb(); assert.deepEqual(stateOf(await pathFor(db, 'opp_none')), ['next', 'later', 'later', 'later']);
});
