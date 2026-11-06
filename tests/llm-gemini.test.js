import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { llmStatus, completeJson } from '../src/orchestrator/llm.js';

function withGemini(fn) {
  const prev = { ...config.llm }; const orig = globalThis.fetch;
  config.llm.provider = 'gemini'; config.llm.geminiKey = 'test-key-not-real'; config.llm.geminiModel = 'gemini-test';
  return fn().finally(() => { globalThis.fetch = orig; Object.assign(config.llm, prev); });
}

test('gemini: status is not enabled without a key', () => {
  const prev = { ...config.llm };
  config.llm.provider = 'gemini'; config.llm.geminiKey = '';
  try { const s = llmStatus(); assert.equal(s.enabled, false); assert.match(s.reason, /credential missing/); } finally { Object.assign(config.llm, prev); }
});

test('gemini: request goes to generativelanguage with the key in a header, never in the URL; JSON reply is parsed', () => withGemini(async () => {
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  assert.equal(llmStatus().enabled, true);
  const r = await completeJson({ system: 'sys', user: 'usr' });
  assert.equal(seen.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
  assert.ok(!seen.url.includes('test-key-not-real'));
  assert.equal(seen.headers['x-goog-api-key'], 'test-key-not-real');
  assert.equal(seen.body.systemInstruction.parts[0].text, 'sys');
  assert.equal(seen.body.contents[0].parts[0].text, 'usr');
  assert.deepEqual(r.json, { ok: true }); assert.equal(r.provider, 'gemini'); assert.equal(r.tokens, 17);
}));
