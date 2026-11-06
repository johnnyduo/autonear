// Content schema for the example landing pages. The model returns this JSON object and nothing else; our code lays it out (src/sites/render.js).
// Every string is plain text: no markup, no links, no control characters. Anything else is rejected, not repaired.

const FEATURE = { title: 32, body: 110 };
const STEP = { title: 28, body: 90 };
export const LIMITS = Object.freeze({ badge: 24, headline: 70, sub: 140, cta: 24, feature: FEATURE, step: STEP, features: 3, steps: 3 });

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
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

/** @returns {{ok:true,value:object}|{ok:false,errors:string[]}} value has only the known keys, strings trimmed. */
export function validateContent(x) {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return { ok: false, errors: ['content must be an object'] };
  const errors = []; const value = {};
  for (const k of ['badge', 'headline', 'sub']) { const e = checkString(x[k], LIMITS[k], k); if (e) errors.push(e); else value[k] = x[k].trim(); }
  value.features = checkList(x.features, LIMITS.features, FEATURE, ['title', 'body'], 'features', errors);
  value.steps = checkList(x.steps, LIMITS.steps, STEP, ['title', 'body'], 'steps', errors);
  { const e = checkString(x.cta, LIMITS.cta, 'cta'); if (e) errors.push(e); else value.cta = x.cta.trim(); }
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
