// Policy engine. Lives OUTSIDE the LLM: roles cannot widen their own permissions, and model output is untrusted input.
import { config } from './config.js';

export class PolicyError extends Error {
  constructor(msg, code = 'policy_violation') { super(msg); this.code = code; }
}

/** Tool allowlist per role. A role may only invoke tools listed here (enforced by `tool()` below). */
export const ROLE_POLICY = {
  signal_collector: { tools: ['db.read', 'http.collector'], llm: false, dataClass: 'public' },
  evidence_analyst: { tools: ['db.read', 'llm.complete'], llm: true, dataClass: 'public' },
  skeptic: { tools: ['db.read', 'llm.complete', 'registry.competitors'], llm: true, dataClass: 'public' },
  product_architect: { tools: ['db.read', 'llm.complete', 'http.launch'], llm: true, dataClass: 'public' },
  builder: { tools: ['db.read', 'artifacts.read'], llm: false, dataClass: 'public' },
  security_reviewer: { tools: ['db.read', 'artifacts.read'], llm: false, dataClass: 'public' },
  launch_planner: { tools: ['db.read', 'db.write.decision'], llm: false, dataClass: 'public' },
  monitor: { tools: ['db.read', 'http.monitor'], llm: false, dataClass: 'public' },
};

export function assertTool(role, tool) {
  const p = ROLE_POLICY[role];
  if (!p || !p.tools.includes(tool)) throw new PolicyError(`role "${role}" is not permitted to use tool "${tool}"`, 'tool_denied');
}

export class Budget {
  constructor({ usd = config.budget.usd, tokens = config.budget.tokens } = {}) { this.usd = usd; this.tokens = tokens; this.spentUsd = 0; this.spentTokens = 0; }
  charge({ usd = 0, tokens = 0 }) {
    this.spentUsd += usd; this.spentTokens += tokens;
    if (this.spentUsd > this.usd) throw new PolicyError(`budget exceeded: $${this.spentUsd.toFixed(4)} > $${this.usd}`, 'budget_usd');
    if (this.spentTokens > this.tokens) throw new PolicyError(`budget exceeded: ${this.spentTokens} tokens > ${this.tokens}`, 'budget_tokens');
  }
  remaining() { return { usd: this.usd - this.spentUsd, tokens: this.tokens - this.spentTokens }; }
}

/** Minimal JSON-schema-ish validator (type, required, properties, items, enum, min/max). Throws PolicyError. */
export function validate(schema, value, path = '$') {
  const fail = (m) => { throw new PolicyError(`schema violation at ${path}: ${m}`, 'schema'); };
  if (schema.enum && !schema.enum.includes(value)) fail(`expected one of ${schema.enum.join('|')}`);
  switch (schema.type) {
    case 'object':
      if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('expected object');
      for (const k of schema.required ?? []) if (!(k in value)) fail(`missing "${k}"`);
      for (const [k, s] of Object.entries(schema.properties ?? {})) if (k in value) validate(s, value[k], `${path}.${k}`);
      break;
    case 'array':
      if (!Array.isArray(value)) fail('expected array');
      if (schema.minItems !== undefined && value.length < schema.minItems) fail(`needs ≥${schema.minItems} items`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`needs ≤${schema.maxItems} items`);
      if (schema.items) value.forEach((v, i) => validate(schema.items, v, `${path}[${i}]`));
      break;
    case 'string':
      if (typeof value !== 'string') fail('expected string');
      if (schema.minLength !== undefined && value.length < schema.minLength) fail('too short');
      if (schema.maxLength !== undefined && value.length > schema.maxLength) fail('too long');
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail('expected number');
      if (schema.min !== undefined && value < schema.min) fail(`< ${schema.min}`);
      if (schema.max !== undefined && value > schema.max) fail(`> ${schema.max}`);
      break;
    case 'boolean': if (typeof value !== 'boolean') fail('expected boolean'); break;
    default: break;
  }
  return value;
}

/** Hallucinated-citation guard: every cited id must be one of the evidence ids this role was actually given. */
export function assertCitations(citations, allowedIds, what = 'output') {
  const allowed = allowedIds instanceof Set ? allowedIds : new Set(allowedIds);
  const bad = (citations ?? []).filter((c) => !allowed.has(c));
  if (bad.length) throw new PolicyError(`${what} cites ${bad.length} unknown evidence id(s): ${bad.slice(0, 3).join(', ')}`, 'bad_citation');
}

/** Retrieved text is DATA. Injection-flagged evidence is withheld from prompts; the rest is fenced and length-capped. */
export function promptSafeEvidence(evidence, { maxItems = 40, maxChars = 360 } = {}) {
  const usable = evidence.filter((e) => !e.flags.some((f) => f.startsWith('prompt-injection')));
  return {
    withheld: evidence.length - usable.length,
    block: usable.slice(0, maxItems).map((e) => `<evidence id="${e.id}" source="${e.source_id}">\n${(e.title + ' — ' + e.body_excerpt).replace(/[<>]/g, '').slice(0, maxChars)}\n</evidence>`).join('\n'),
    ids: usable.slice(0, maxItems).map((e) => e.id),
  };
}

/** Constraints on any consequential decision this system may propose. Checked in code, never by prompt. */
export const DECISION_LIMITS = {
  allowedActions: ['deploy_testnet'],       // upgrade / spend / liquidity / outreach are separate, not yet enabled
  allowedNetworks: ['near-testnet', 'evm:11155111', 'evm:84532', 'evm:421614', 'evm:11155420', 'evm:10143', 'evm:97', 'evm:31337'],
  maxExpiryMs: 7 * 864e5,
  maxSpendCeiling: '0',                     // the registry itself never moves funds: spend ceiling is zero for deployments
};

export function assertDecisionAllowed(d) {
  if (!DECISION_LIMITS.allowedActions.includes(d.action)) throw new PolicyError(`action "${d.action}" is not enabled in this build`, 'action_blocked');
  if (!DECISION_LIMITS.allowedNetworks.includes(d.chain_id)) throw new PolicyError(`network "${d.chain_id}" is not allowed (mainnet is blocked: needs separate security review and explicit human signature)`, 'network_blocked');
  if (d.expiry - Date.now() > DECISION_LIMITS.maxExpiryMs) throw new PolicyError('expiry too far in the future', 'expiry');
  if (BigInt(d.max_spend) > BigInt(DECISION_LIMITS.maxSpendCeiling)) throw new PolicyError('max_spend above ceiling', 'spend');
}
