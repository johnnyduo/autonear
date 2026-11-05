// Shared by the Node scripts (tts, verify) and by Remotion. Pure JS, no deps.
// Narration tokens: {{path}} digits | {{path|w}} spoken words | {{path|W}} spoken words, capitalised | {{path|d}} 0.xx -> "point x x".
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

export function intToWords(n) {
  if (!Number.isInteger(n) || n < 0 || n > 999999) throw new Error(`intToWords: unsupported ${n}`);
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '');
  if (n < 1000) return ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' and ' + intToWords(n % 100) : '');
  return intToWords(Math.floor(n / 1000)) + ' thousand' + (n % 1000 ? (n % 1000 < 100 ? ' and ' : ' ') + intToWords(n % 1000) : '');
}

const pick = (obj, path) => path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), obj);

export function resolveTokens(text, data, mode /* 'spoken' | 'display' */) {
  return text.replace(/\{\{\s*([\w.]+)(?:\|(\w))?\s*\}\}/g, (_, path, fmt) => {
    const v = pick(data, path);
    if (v === undefined || v === null) throw new Error(`narration token {{${path}}} not found in captured data`);
    if (mode === 'display') {
      if (fmt === 'd') return Number(v).toFixed(2);
      if (fmt === 'W') return String(v);
      return String(v);
    }
    if (fmt === 'w' || fmt === 'W') {
      const s = intToWords(Number(v));
      return fmt === 'W' ? s[0].toUpperCase() + s.slice(1) : s;
    }
    if (fmt === 'd') {
      const [, frac] = Number(v).toFixed(2).split('.');
      return 'point ' + [...frac].map((c) => ONES[Number(c)]).join(' ');
    }
    return String(v);
  });
}

export const spoken = (text, data) => resolveTokens(text, data, 'spoken');
export const display = (text, data) => resolveTokens(text, data, 'display');

/** Split a display sentence into caption chunks (<= maxWords), breaking at punctuation first. */
export function captionChunks(text, maxWords = 6) {
  const out = [];
  for (const sentence of text.split(/(?<=[.!?:])\s+/)) {
    const words = sentence.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length) {
      let end = Math.min(i + maxWords, words.length);
      if (words.length - end === 1) end = words.length; // no 1-word orphan
      out.push(words.slice(i, end).join(' '));
      i = end;
    }
  }
  return out;
}

/**
 * Word-level timing. Gemini TTS returns no timestamps, so:
 *  1. sentence windows come from REAL pauses detected in the audio (ffmpeg silencedetect, stored by tts.mjs as cal.speech/cal.pauses);
 *  2. inside a sentence each word gets time proportional to its length (+ small allowance after commas/colons).
 * Without calibration data it falls back to a purely proportional estimate over the whole clip.
 */
export function wordTimings(text, durationSec, cal) {
  const words = text.split(/\s+/).filter(Boolean);
  const wt = words.map((x) => x.replace(/[^\w]/g, '').length + 2 + (/[,:;]$/.test(x) ? 3 : 0));
  const bounds = [];
  words.forEach((w, i) => { if (/[.!?]$/.test(w) && i < words.length - 1) bounds.push(i + 1); });
  const sStart = cal?.speech?.start ?? 0;
  const sEnd = cal?.speech?.end ?? Math.max(0.1, durationSec - 0.12);
  const pauses = (cal?.pauses ?? []).filter((p) => p.start > sStart + 0.05 && p.end < sEnd - 0.05);
  // proportional prediction of each sentence boundary (used to pick the matching real pause)
  const w2 = words.map((x, i) => wt[i] + (/[.!?]$/.test(x) ? 7 : 0));
  const tot2 = w2.reduce((a, b) => a + b, 0);
  const cum = []; let acc = 0;
  w2.forEach((x) => { acc += x; cum.push(acc); });
  const pred = bounds.map((bi) => sStart + (cum[bi - 1] / tot2) * (sEnd - sStart));
  let windows;
  if (!bounds.length) windows = [[sStart, sEnd]];
  else if (pauses.length >= bounds.length) {
    // ordered assignment of K pauses minimising total distance to the predictions (DP)
    const K = bounds.length, P = pauses.length, mid = pauses.map((p) => (p.start + p.end) / 2);
    const INF = 1e9;
    const dp = Array.from({ length: K + 1 }, () => Array(P + 1).fill(INF));
    const take = Array.from({ length: K + 1 }, () => Array(P + 1).fill(false));
    for (let j = 0; j <= P; j++) dp[0][j] = 0;
    for (let k = 1; k <= K; k++) for (let j = 1; j <= P; j++) {
      const skip = dp[k][j - 1], use = dp[k - 1][j - 1] + Math.abs(mid[j - 1] - pred[k - 1]);
      if (use <= skip) { dp[k][j] = use; take[k][j] = true; } else dp[k][j] = skip;
    }
    const chosen = []; let k = K, j = P;
    while (k > 0 && j > 0) { if (take[k][j]) { chosen.unshift(pauses[j - 1]); k--; } j--; }
    windows = [];
    let prev = sStart;
    for (const p of chosen) { windows.push([prev, p.start]); prev = p.end; }
    windows.push([prev, sEnd]);
  } else {
    let t = sStart;
    return words.map((word, i) => { const d = (w2[i] / tot2) * (sEnd - sStart); const r = { word, start: t, end: t + d }; t += d; return r; });
  }
  const segs = [];
  let from = 0;
  for (const bnd of [...bounds, words.length]) { segs.push([from, bnd]); from = bnd; }
  const out = [];
  segs.forEach(([a, b], k) => {
    const [t0, t1] = windows[k];
    const tot = wt.slice(a, b).reduce((x, y) => x + y, 0);
    let t = t0;
    for (let i = a; i < b; i++) { const d = (wt[i] / tot) * (t1 - t0); out.push({ word: words[i], start: t, end: t + d }); t += d; }
  });
  return out;
}

const norm = (x) => x.toLowerCase().replace(/[^a-z0-9.]/g, '');

/** Start time (sec) of the nth occurrence of a phrase (word sequence, punctuation/case-insensitive). Throws if absent. */
export function whenSaid(wt, phrase, nth = 0) {
  const target = phrase.split(/\s+/).map(norm).filter(Boolean);
  let seen = 0;
  for (let i = 0; i + target.length <= wt.length; i++) {
    if (target.every((t, k) => norm(wt[i + k].word) === t)) {
      if (seen === nth) return wt[i].start;
      seen++;
    }
  }
  throw new Error(`whenSaid: phrase not found in narration: "${phrase}" (#${nth})`);
}

/** Caption chunks with start/end derived from word timings. */
export function captionTimings(text, durationSec, maxWords = 6, cal) {
  const wt = wordTimings(text, durationSec, cal);
  const chunks = captionChunks(text, maxWords);
  let wi = 0;
  return chunks.map((c, i) => {
    const n = c.split(/\s+/).length;
    const start = wt[wi].start;
    wi += n;
    return { text: c, start, end: i === chunks.length - 1 ? durationSec : wt[wi].start };
  });
}
