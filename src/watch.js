// Owner-editable "what the agent hunts": extra keywords/hackathons to boost and tag, phrases to exclude, per-source on/off.
// Stored in kv `watch.config`. It can only TIGHTEN or RANK what the relevance rule already accepts: a keyword never makes a record
// "NEAR", never clears a prompt-injection/low-signal flag, and never touches records the official NEAR RPC source forces.
import { audit, j, parse } from './db.js';
import { PolicyError } from './policy.js';

export const WATCH_KEY = 'watch.config';
export const LIMITS = Object.freeze({ perList: 40, itemChars: 60, minChars: 2 });
export const EMPTY = Object.freeze({ keywords: [], excludes: [], hackathons: [], sources: {} });

// eslint-disable-next-line no-control-regex
const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>`]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

function cleanList(v, field) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new PolicyError(`${field} must be a list`, 'input');
  if (v.length > LIMITS.perList * 3) throw new PolicyError(`${field}: at most ${LIMITS.perList} entries`, 'input');
  const out = [];
  for (const raw of v) {
    if (typeof raw !== 'string') continue;
    const t = clean(raw).slice(0, LIMITS.itemChars);
    if (t.length >= LIMITS.minChars && !out.includes(t)) out.push(t);
  }
  if (out.length > LIMITS.perList) throw new PolicyError(`${field}: at most ${LIMITS.perList} entries`, 'input');
  return out;
}

/** Normalise untrusted input into a stored config. `sourceIds` = registered connector ids (anything else is rejected). */
export function sanitizeWatch(input, sourceIds) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PolicyError('watch config must be an object', 'input');
  const sources = {};
  for (const [k, v] of Object.entries(input.sources ?? {})) {
    if (!sourceIds.includes(k)) throw new PolicyError(`unknown source "${String(k).slice(0, 40)}"`, 'input');
    if (typeof v !== 'boolean') throw new PolicyError(`source ${k} must be true or false`, 'input');
    if (v === false) sources[k] = false; // only disabled sources are stored; enabled is the default
  }
  return { keywords: cleanList(input.keywords, 'keywords'), excludes: cleanList(input.excludes, 'excludes'), hackathons: cleanList(input.hackathons, 'hackathons'), sources };
}

export async function getWatch(db) {
  const v = parse((await db.get('SELECT v FROM kv WHERE k=?', [WATCH_KEY]))?.v, null);
  return v && typeof v === 'object' ? { ...EMPTY, ...v, sources: v.sources ?? {} } : { ...EMPTY, sources: {} };
}

export async function setWatch(db, input, actor = 'operator', { sourceIds } = {}) {
  const ids = sourceIds ?? (await import('./connectors/index.js')).CONNECTORS.map((c) => c.id);
  const cfg = sanitizeWatch(input, ids);
  await db.run('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', [WATCH_KEY, j(cfg)]);
  await audit(db, actor, 'watch.updated', { keywords: cfg.keywords.length, excludes: cfg.excludes.length, hackathons: cfg.hackathons.length, disabled: Object.keys(cfg.sources) });
  return cfg;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const matcher = (term) => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(term)}($|[^\\p{L}\\p{N}])`, 'iu');

/** Apply owner settings to ONE relevance assessment. Returns { drop, rel }. Never turns a non-NEAR record into a NEAR one. */
export function applyWatch(rel, text, watch) {
  if (!watch) return { drop: false, rel };
  const t = String(text ?? '').slice(0, 20_000);
  if (watch.excludes?.some((x) => matcher(x).test(t))) return { drop: true, rel };
  if (!rel.isNear) return { drop: false, rel };
  const hits = [...(watch.keywords ?? []), ...(watch.hackathons ?? [])].filter((k) => matcher(k).test(t));
  if (!hits.length) return { drop: false, rel };
  return {
    drop: false,
    rel: { ...rel, score: Number(Math.min(1, rel.score + 0.05).toFixed(2)), tags: [...new Set([...rel.tags, ...hits.map((h) => `watch:${h}`)])], reasons: [...rel.reasons, `matches an owner watch term: ${hits.join(', ')}`] },
  };
}
