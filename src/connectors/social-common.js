// Shared helpers for the social / news connectors (NEAR Social, Mastodon, Farcaster, Dev.to, Bluesky).
// Everything here is deterministic and offline-testable. Settings are read from process.env AT CALL TIME (Workers expose env late).
import { guardedFetch, HttpError } from '../http-client.js';

/** Social records are demand evidence of LOWER quality than GitHub/forum records. See SOCIAL_WEIGHT in source-weights.js. */
export { SOCIAL_SOURCE_IDS, SOCIAL_WEIGHT, isSocialSource } from './source-weights.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function envNum(name, def, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

/** Per-source item cap per tick: <name> (e.g. MASTODON_MAX_ITEMS) else SOCIAL_MAX_ITEMS else 40. Hard-clamped to 1..200. */
export const maxItemsPerTick = (name) => Math.floor(envNum(name, envNum('SOCIAL_MAX_ITEMS', 40, 1, 200), 1, 200));
/** Records older than this are not requested/kept (default 90 days, the same horizon family as the other sources). */
export const maxAgeMs = () => envNum('SOCIAL_MAX_AGE_DAYS', 90, 1, 3650) * 864e5;
/** Wall-clock budget one social connector may spend fetching (default 25 s); it stops early and reports partial:true. */
export const budgetMs = () => envNum('SOCIAL_BUDGET_MS', 25_000, 1_000, 120_000);
export const csv = (name, def) => (process.env[name] ? String(process.env[name]) : def).split(',').map((s) => s.trim()).filter(Boolean);

export class Budget {
  constructor(ms = budgetMs()) { this.until = Date.now() + ms; }
  get exhausted() { return Date.now() > this.until; }
}

export function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { const c = parseInt(h, 16); return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : ' '; })
    .replace(/&#(\d+);/g, (_, d) => { const c = Number(d); return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : ' '; })
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
/** HTML (Mastodon, Dev.to) -> plain text. Tags are removed (not replaced by spaces: Mastodon splits "#" / tag and URL pieces across spans), never executed or rendered. */
export function htmlToText(h = '') {
  return decodeEntities(String(h).replace(/<(br|\/p|\/div|\/li)\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')).replace(/[ \t\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}
/** Control characters (except \n, \t) and bidi overrides have no place in stored excerpts. */
export const sanitize = (s = '') => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, '').trim();
export function titleFrom(text, max = 110) {
  const first = sanitize(text).split('\n').find((l) => l.trim()) ?? '';
  const t = first.replace(/^[#>*_\-\s]+/, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim() || first.trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

// ---- noise heuristics. They only ADD flags; nothing is dropped here. Scoring de-weights `low-signal:*` and `bot-author` records. ----
const URL_RE = /https?:\/\/\S+/gi;
const MARKET_RE = /(\bprice\b|\b(?:rose|fell|gained|dropped|jumped|soared|slumped|outperform\w*)\b|\b[A-Z]{2,6}USDT?\b|\bcrypto market\b|\brall(?:y|ies|ied)\b|\bsurg(?:e|es|ed)\b|\bplunge[sd]?\b|\bETF\b|\bmarket cap\b|\bbullish\b|\bbearish\b|\bpump(?:s|ed)?\b|\btrading volume\b|\bopen interest\b|\bwhale\b)/i;
const FIGURE_RE = /(\d[\d,.]*\s?%|\$\s?\d)/;

/** Deterministic per-post flags. `accountCreatedMs` may be unknown (null): then no account-age claim is made. */
export function lowSignalFlags({ text = '', createdAtMs = null, accountCreatedMs = null, minAccountAgeDays = 30 } = {}) {
  const flags = [];
  if (accountCreatedMs && createdAtMs && createdAtMs - accountCreatedMs < minAccountAgeDays * 864e5) flags.push('low-signal:new-account');
  const bare = text.replace(URL_RE, ' ').replace(/[#@][\w.-]+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (bare.length < 12) flags.push(/https?:\/\/\S+/i.test(text) ? 'low-signal:link-only' : 'low-signal:very-short');
  if (MARKET_RE.test(text) && FIGURE_RE.test(text)) flags.push('low-signal:market-ticker');
  if ((text.match(/#\w+/g) ?? []).length > 6) flags.push('low-signal:hashtag-spam');
  return flags;
}

const normText = (t) => t.toLowerCase().replace(URL_RE, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** Adds `low-signal:repeated-text` to records whose text is repeated in this batch (any authors) or that one author templates (>=3 same 50-char openings). */
export function flagRepeats(items) {
  const byText = new Map(); const byAuthorHead = new Map();
  for (const it of items) {
    const n = normText(`${it.title}\n${it.body}`);
    it._n = n;
    if (n.length >= 20) byText.set(n, (byText.get(n) ?? 0) + 1);
    const k = `${(it.author ?? '').toLowerCase()}|${n.slice(0, 50)}`;
    if (it.author && n.length >= 20) byAuthorHead.set(k, (byAuthorHead.get(k) ?? 0) + 1);
  }
  for (const it of items) {
    const n = it._n; delete it._n;
    const k = `${(it.author ?? '').toLowerCase()}|${n.slice(0, 50)}`;
    if (n.length >= 20 && (byText.get(n) > 1 || (byAuthorHead.get(k) ?? 0) >= 3)) it.flags = [...new Set([...(it.flags ?? []), 'low-signal:repeated-text'])];
  }
  return items;
}

/** Newest first, stable, bounded by maxAge. Returns {items, dropped} where dropped counts out-of-window records (reported, not hidden). */
export function windowAndSort(items, ageMs = maxAgeMs(), nowMs = Date.now()) {
  const inWindow = items.filter((i) => !i.publishedAt || nowMs - i.publishedAt <= ageMs);
  inWindow.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
  return { items: inWindow, dropped: items.length - inWindow.length };
}

/**
 * GET/POST JSON through the single guarded outbound path with ONE bounded retry on 429 / 502 / 503 / 504 (honours Retry-After, capped at 5 s).
 * Malformed JSON is an error (visible in /api/status), never an empty result. Returns {json, headers}.
 */
export async function fetchJson(url, ctx = {}, { role = 'collector', method = 'GET', headers = {}, body } = {}) {
  let res;
  for (let attempt = 0; ; attempt++) {
    try { res = await guardedFetch(role, url, { method, headers: { accept: 'application/json', ...headers }, body, fetchImpl: ctx.fetchImpl }); break; }
    catch (e) {
      const retryable = e instanceof HttpError && [429, 502, 503, 504].includes(e.status);
      if (!retryable || attempt >= 1) throw e;
      const ra = Number(e.retryAfter);
      const wait = ctx.fetchImpl ? 0 : Math.min(5000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1500);
      await (ctx.sleep ?? sleep)(wait);
    }
  }
  let json;
  try { json = JSON.parse(res.text); } catch { throw new Error(`malformed JSON from ${new URL(url).hostname}`); }
  return { json, headers: res.headers };
}

/** Small header reader that never throws on odd header objects. */
export const header = (headers, name) => { try { return headers?.get?.(name) ?? null; } catch { return null; } };
