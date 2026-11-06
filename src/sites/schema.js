// Content schema for the product landing pages. The model returns this JSON object and nothing else; our code lays it out (src/sites/render.js).
// Every string is plain text: no markup, no links, no control characters. Anything else is rejected, not repaired.
// The model never writes code: for the contract sketch it gives names and one plain sentence per method. Our renderer composes the signatures.

const FEATURE = { title: 32, body: 110 };
const STEP = { title: 28, body: 90 };
const CONTRACT = { name: [3, 24], method: [3, 29], methods: 3, args: [1, 3], does: 72 };
export const ARG_TYPES = Object.freeze(['AccountId', 'U128', 'String', 'u64', 'bool', 'Vec<String>']);
export const RETURN_TYPES = Object.freeze(['none', 'bool', 'U128', 'String', 'u64']);
export const LIMITS = Object.freeze({ badge: 24, headline: 70, sub: 140, cta: 24, feature: FEATURE, step: STEP, features: 3, steps: 3, contract: CONTRACT });
const RUST_KEYWORDS = new Set(['fn', 'pub', 'mut', 'self', 'struct', 'impl', 'let', 'use', 'mod', 'type', 'where', 'match', 'loop', 'move', 'ref', 'static', 'trait', 'crate', 'super', 'enum', 'const', 'as', 'in', 'if', 'else', 'for', 'while', 'return', 'true', 'false']);
const IDENT = /^[a-z][a-z0-9_]*$/;
const METHOD_IDENT = /^[a-z][a-z0-9_]{2,28}$/;

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const SLOP = ['seamless', 'robust', 'leverage', 'empower', 'unlock', 'revolution', 'cutting-edge', 'next-gen', 'game-chang', 'streamline', 'holistic', 'synerg', 'effortless', 'state-of-the-art', 'world-class', 'supercharge'];
const BAD = [['<', 'markup'], ['>', 'markup'], ['&#', 'an HTML entity'], ['http', 'a link'], ['://', 'a link'], ['javascript:', 'a script URL']];

/** Returns an error string or null. */
function checkString(v, max, path) {
  if (typeof v !== 'string') return `${path}: must be a string`;
  const s = v.trim();
  if (!s) return `${path}: must not be empty`;
  if (s.length > max) return `${path}: ${s.length} characters, the limit is ${max}`;
  if (CONTROL.test(s)) return `${path}: control characters are not allowed`;
  const low = s.toLowerCase();
  for (const [needle, what] of BAD) if (low.includes(needle)) return `${path}: contains ${what} ("${needle}")`;
  for (const w of SLOP) if (low.includes(w)) return `${path}: uses marketing wording ("${w}"); say what it does in plain words`;
  return null;
}

function checkList(list, n, shape, keys, path, errors) {
  if (!Array.isArray(list) || list.length !== n) { errors.push(`${path}: must be a list of exactly ${n}`); return []; }
  return list.map((item, i) => {
    const p = `${path}[${i}]`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) { errors.push(`${p}: must be an object`); return null; }
    const o = {};
    for (const k of keys) { const e = checkString(item[k], shape[k], `${p}.${k}`); if (e) errors.push(e); else o[k] = item[k].trim(); }
    return o;
  });
}

/** A snake_case name that is not a Rust keyword. Returns an error string or null. */
function checkIdent(v, re, path, what) {
  if (typeof v !== 'string') return `${path}: must be a string`;
  if (!re.test(v)) return `${path}: "${String(v).slice(0, 40)}" is not ${what}`;
  if (RUST_KEYWORDS.has(v)) return `${path}: "${v}" is a Rust keyword`;
  return null;
}

function checkContract(x, errors) {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) { errors.push('contract: must be an object'); return null; }
  const value = {};
  const [nMin, nMax] = CONTRACT.name;
  const ne = checkIdent(x.name, IDENT, 'contract.name', 'a snake_case name (lowercase letters, digits, underscores, starting with a letter)');
  if (ne) errors.push(ne);
  else if (x.name.length < nMin || x.name.length > nMax) errors.push(`contract.name: ${x.name.length} characters, it must be ${nMin} to ${nMax}`);
  else value.name = x.name;
  if (!Array.isArray(x.methods) || x.methods.length !== CONTRACT.methods) { errors.push(`contract.methods: must be a list of exactly ${CONTRACT.methods}`); return null; }
  const seen = new Set();
  value.methods = x.methods.map((m, i) => {
    const p = `contract.methods[${i}]`;
    if (m === null || typeof m !== 'object' || Array.isArray(m)) { errors.push(`${p}: must be an object`); return null; }
    const o = {};
    const e = checkIdent(m.name, METHOD_IDENT, `${p}.name`, 'a snake_case method name of 3 to 29 characters');
    if (e) errors.push(e);
    else if (seen.has(m.name)) errors.push(`${p}.name: "${m.name}" is used twice`);
    else { seen.add(m.name); o.name = m.name; }
    const d = checkString(m.does, CONTRACT.does, `${p}.does`);
    if (d) errors.push(d); else o.does = m.does.trim();
    if (!RETURN_TYPES.includes(m.returns)) errors.push(`${p}.returns: must be one of ${RETURN_TYPES.join(', ')}`); else o.returns = m.returns;
    if (!Array.isArray(m.args) || m.args.length < CONTRACT.args[0] || m.args.length > CONTRACT.args[1]) { errors.push(`${p}.args: must be a list of ${CONTRACT.args[0]} to ${CONTRACT.args[1]}`); return o; }
    const names = new Set();
    o.args = m.args.map((a, k) => {
      const q = `${p}.args[${k}]`;
      if (a === null || typeof a !== 'object' || Array.isArray(a)) { errors.push(`${q}: must be an object`); return null; }
      const r = {};
      const ae = checkIdent(a.name, METHOD_IDENT, `${q}.name`, 'a snake_case name of 3 to 29 characters');
      if (ae) errors.push(ae);
      else if (names.has(a.name)) errors.push(`${q}.name: "${a.name}" is used twice`);
      else { names.add(a.name); r.name = a.name; }
      if (!ARG_TYPES.includes(a.type)) errors.push(`${q}.type: must be one of ${ARG_TYPES.join(', ')}`); else r.type = a.type;
      return r;
    });
    return o;
  });
  return value;
}

/** @returns {{ok:true,value:object}|{ok:false,errors:string[]}} value has only the known keys, strings trimmed. */
export function validateContent(x) {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return { ok: false, errors: ['content must be an object'] };
  const errors = []; const value = {};
  for (const k of ['badge', 'headline', 'sub']) { const e = checkString(x[k], LIMITS[k], k); if (e) errors.push(e); else value[k] = x[k].trim(); }
  value.features = checkList(x.features, LIMITS.features, FEATURE, ['title', 'body'], 'features', errors);
  value.steps = checkList(x.steps, LIMITS.steps, STEP, ['title', 'body'], 'steps', errors);
  { const e = checkString(x.cta, LIMITS.cta, 'cta'); if (e) errors.push(e); else value.cta = x.cta.trim(); }
  value.contract = checkContract(x.contract, errors);
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

/** Product slugs for the council topics are fixed, so a URL does not change when a title is reworded. */
const TOPIC_SLUGS = Object.freeze({
  treasury: 'treasury', signing: 'signing', intents: 'intents', ai_agents: 'ai-agents', dev_tooling: 'dev-tooling', data_indexing: 'data-indexing', wallet_ux: 'wallet-ux',
});
const kebab = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');

/** @param {{topic?:string,title?:string}} opportunity */
export function slugOf(opportunity) {
  const t = String(opportunity?.topic ?? '');
  return TOPIC_SLUGS[t] ?? (kebab(t) || kebab(opportunity?.title) || 'product');
}
