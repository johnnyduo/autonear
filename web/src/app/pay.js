// Pure helpers for the Payments section: what to show per token, whether the form may be used, and the checks on what the owner typed.
// All words come from copy.js. No React, no I/O, so it is tested without a browser. Money is BigInt end to end.
import { P, pfill, tokenAmount } from './copy.js';

export const NOTE_MAX_BYTES = 128;
export const byteLen = (s) => new TextEncoder().encode(String(s ?? '')).length;
const big = (v) => { try { return v === null || v === undefined || v === '' ? null : BigInt(String(v)); } catch { return null; } };

/** A long account id cut for the page; the full id goes in a tooltip. Short names are left alone. */
export function shortAccount(a, max = 24) {
  const s = String(a ?? ''); if (s.length <= max) return s;
  const keep = Math.floor((max - 1) / 2); return `${s.slice(0, keep)}…${s.slice(-keep)}`;
}

/** Whole tokens typed by a person ("25", "12.5") -> base units. { base } or { error: key }. Never rounds: too many decimals is an error. */
export function parseTokenAmount(text, decimals) {
  const s = String(text ?? '').trim(); const dec = Number(decimals);
  if (!s) return { error: 'empty' };
  if (!/^\d+(\.\d+)?$/.test(s) || !Number.isInteger(dec) || dec < 0) return { error: 'format' };
  const [w, f = ''] = s.split('.');
  if (f.length > dec) return { error: 'places' };
  const base = BigInt(w + f.padEnd(dec, '0'));
  return base === 0n ? { error: 'zero' } : { base };
}

/** What the page shows for one token of the vault report. A token whose symbol or decimals are unknown is listed but cannot be paid here. */
export function tokenView(t) {
  const dec = t.decimals; const sym = t.symbol; const usable = Boolean(sym) && Number.isInteger(dec) && t.matches !== false;
  const fm = (x, o) => (usable ? tokenAmount(x, dec, sym, o) : null);
  const lim = (cap, left, spent) => {
    const c = big(cap); const l = big(left); const sp = big(spent);
    const frac = c && c > 0n && sp !== null ? Math.min(1, Number((sp * 10000n) / c) / 10000) : 0;
    return { cap: fm(cap), capShort: fm(cap, { max: 6 }), left: fm(left, { max: 6 }), leftExact: fm(left), none: l !== null && l <= 0n, frac };
  };
  const bal = big(t.balance);
  return {
    token: t.token, symbol: sym ?? null, usable,
    balance: bal === null ? null : fm(t.balance, { max: 6 }), balanceExact: bal === null ? null : fm(t.balance),
    balanceBig: bal, decimals: dec,
    each: { cap: fm(t.perPayCap) },
    period: lim(t.periodCap, t.remaining?.period, t.usage?.periodSpent),
    total: lim(t.totalCap, t.remaining?.total, t.usage?.totalSpent),
    maxPayment: big(t.remaining?.maxPayment), maxPaymentText: fm(t.remaining?.maxPayment, { max: 6 }),
  };
}

/** Why the "Pay someone" form is off, in one sentence; '' when it may be used. Order: who you are, then the vault, then what is set up. */
export function payFormOff({ owner, demo, vault, stopped }) {
  if (!owner?.address) return P.signIn;
  if (!owner.isOwner) return null; // the page shows its own read-only sentence
  if (demo) return null;
  if (!vault?.payouts) return P.offNoBuild;
  const m = vault.mandate;
  if (vault.status !== 'active' || !m || m.revoked) return P.offNotOn;
  if (vault.paused || stopped) return P.offPaused;
  const usable = vault.payouts.tokens.some((t) => tokenView(t).usable);
  if (!usable || !vault.payouts.payees.length) return P.offNone;
  return '';
}

/**
 * Check the form. -> { ok, base?, errors: { amount?, payee?, note?, reference? }, warn? }
 * `tv` is the tokenView of the chosen token. The server decides in the end; these checks only save a round trip and say it in plain words.
 */
export function validatePay({ tv, payee, amount, note = '', reference = '' }) {
  const errors = {}; let base; let warn;
  if (!payee) errors.payee = P.fPayeeNeeded;
  if (byteLen(note) > NOTE_MAX_BYTES) errors.note = P.fNote2;
  if (byteLen(reference) > NOTE_MAX_BYTES) errors.reference = P.fRef2;
  if (!tv?.usable) errors.amount = P.noTokens;
  else {
    const r = parseTokenAmount(amount, tv.decimals);
    if (r.error === 'empty') errors.amount = P.fEnter;
    else if (r.error === 'format') errors.amount = P.fFormat;
    else if (r.error === 'zero') errors.amount = P.fZero;
    else if (r.error === 'places') errors.amount = pfill(P.fPlaces, { s: tv.symbol, n: tv.decimals });
    else {
      base = r.base;
      if (tv.maxPayment !== null && tv.maxPayment <= 0n) errors.amount = P.fNoRoom;
      else if (tv.maxPayment !== null && base > tv.maxPayment) errors.amount = pfill(P.fAbove, { x: tv.maxPaymentText ?? '' });
      else if (tv.balanceBig !== null && base > tv.balanceBig) warn = P.fLow;
    }
  }
  return { ok: Object.keys(errors).length === 0, base, errors, warn };
}

/** The request body for POST /api/payments. Amount goes as a base-unit string; empty optional fields are left out. */
export function payBody({ vault, token, payee, base, note, reference }) {
  return { vault: vault.address, token, payee, amount: String(base), ...(note?.trim() ? { memo: note.trim() } : {}), ...(reference?.trim() ? { reference: reference.trim() } : {}) };
}

/** Links come from the server; only plain web links are ever put in an href. */
export const safeLink = (u) => (/^https?:\/\//i.test(String(u ?? '')) ? String(u) : '');

/** Payment requests of one vault, newest first, as plain rows. */
export function paymentRows(payments, vault) {
  const items = (payments?.items ?? []).filter((p) => !vault?.address || !p.vault || p.vault === vault.address);
  return [...items].sort((a, b) => Number(b.createdAt) - Number(a.createdAt)).map((p) => ({
    id: p.decisionId, when: p.payment?.recordedAt ?? p.createdAt, payee: p.payee, amount: tokenAmount(p.amount, p.decimals, p.symbol) ?? '–',
    note: p.memo || '', state: P.stateWord[p.effectiveStatus] ?? P.stateWord[p.status] ?? '', status: p.effectiveStatus ?? p.status,
    link: safeLink(p.payment?.explorerUrl), done: p.effectiveStatus === 'executed',
  }));
}

/** One line for Home: what has been paid and what waits for the owner. null when the vault cannot pay. */
export function payHome(vault, payments) {
  if (!vault?.payouts) return null;
  const rows = paymentRows(payments, vault); const waiting = rows.filter((r) => r.status === 'pending').length;
  const sums = new Map();
  for (const p of payments?.items ?? []) {
    if (p.effectiveStatus !== 'executed' || (vault.address && p.vault && p.vault !== vault.address)) continue;
    try { const k = `${p.symbol}|${p.decimals}`; sums.set(k, (sums.get(k) ?? 0n) + BigInt(p.amount)); } catch { /* skip an amount that is not a whole number */ }
  }
  const paid = [...sums].map(([k, v]) => { const [sym, dec] = k.split('|'); return tokenAmount(v, Number(dec), sym); }).filter(Boolean);
  return { paid, waiting, any: rows.length > 0 };
}
