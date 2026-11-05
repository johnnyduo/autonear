// LLM provider layer. Provider "none" (default) => callers use the deterministic baseline.
// Output is always treated as untrusted: callers validate it against a schema and check citations.
import { config } from '../config.js';
import { guardedFetch } from '../http-client.js';
import { PolicyError } from '../policy.js';

// Estimated list prices (USD per 1M tokens). Placeholders: override with LLM_PRICE_IN / LLM_PRICE_OUT.
const PRICE_IN = Number(process.env.LLM_PRICE_IN ?? 3);
const PRICE_OUT = Number(process.env.LLM_PRICE_OUT ?? 15);
const est = (inTok, outTok) => (inTok * PRICE_IN + outTok * PRICE_OUT) / 1e6;
const approxTokens = (s) => Math.ceil(s.length / 4);

export function llmStatus() {
  const p = config.llm.provider;
  const ready = p === 'anthropic' ? Boolean(config.llm.anthropicKey) : p === 'gateway' ? Boolean(config.llm.gatewayKey) : p === 'codex-cli' ? !config.onVercel : false;
  return {
    provider: p, enabled: p !== 'none' && ready,
    model: p === 'anthropic' ? config.llm.anthropicModel : p === 'gateway' ? config.llm.gatewayModel : p === 'codex-cli' ? 'codex (local CLI default)' : null,
    reason: p === 'none' ? 'LLM_PROVIDER=none: deterministic baseline in use' : ready ? 'ready' : `provider "${p}" selected but credential missing`,
  };
}

function extractJson(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*\})/);
  if (!m) throw new PolicyError('LLM output contained no JSON', 'llm_format');
  return JSON.parse(m[1]);
}

/** @returns {Promise<null | {json:any, model:string, provider:string, tokens:number, cost:number, latencyMs:number}>} */
export async function completeJson({ system, user, maxTokens = 1500, signal } = {}) {
  const st = llmStatus();
  if (!st.enabled) return null;
  const t0 = Date.now();
  let text; let inTok = approxTokens(system + user); let outTok = 0;
  if (st.provider === 'anthropic') {
    const res = await guardedFetch('llm', 'https://api.anthropic.com/v1/messages', {
      method: 'POST', timeoutMs: 60_000,
      headers: { 'content-type': 'application/json', 'x-api-key': config.llm.anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: config.llm.anthropicModel, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    });
    const d = JSON.parse(res.text);
    text = d.content?.map((c) => c.text).join('') ?? '';
    inTok = d.usage?.input_tokens ?? inTok; outTok = d.usage?.output_tokens ?? approxTokens(text);
  } else if (st.provider === 'gateway') {
    const res = await guardedFetch('llm', config.llm.gatewayUrl, {
      method: 'POST', timeoutMs: 60_000,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.llm.gatewayKey}` },
      body: JSON.stringify({ model: config.llm.gatewayModel, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    const d = JSON.parse(res.text);
    text = d.choices?.[0]?.message?.content ?? '';
    inTok = d.usage?.prompt_tokens ?? inTok; outTok = d.usage?.completion_tokens ?? approxTokens(text);
  } else if (st.provider === 'codex-cli') {
    const { execFile } = await import('node:child_process');
    text = await new Promise((resolve, reject) => {
      const child = execFile('codex', ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-'], { timeout: 180_000, maxBuffer: 4_000_000 }, (err, stdout) => err ? reject(err) : resolve(stdout));
      child.stdin.end(`${system}\n\n${user}\n\nReply with a single JSON object only.`);
    });
    outTok = approxTokens(text);
  } else throw new PolicyError(`unknown LLM provider ${st.provider}`);
  return { json: extractJson(text), model: st.model, provider: st.provider, tokens: inTok + outTok, cost: st.provider === 'codex-cli' ? 0 : est(inTok, outTok), latencyMs: Date.now() - t0 };
}
