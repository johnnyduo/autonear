// What-if and verify-in-browser for the Council page. Pure functions, no network, nothing is written anywhere.
// whatIf() mirrors verdictOf() in src/council.js (a test keeps them identical). verifyEntry() recomputes the SHA-256 digests the API publishes.

/** Weights typed by a visitor are scaled so they sum to 1, like the real ones. All zero falls back to the real weights. */
export function normalize(weights, fallback) {
  const t = Object.values(weights).reduce((a, b) => a + b, 0);
  const src = t > 0 ? weights : fallback; const s = Object.values(src).reduce((a, b) => a + b, 0);
  return Object.fromEntries(Object.entries(src).map(([k, v]) => [k, v / s]));
}

/** The council verdict for one product under changed weights or thresholds. `rules` supplies the veto floors and the minimum confidence, which stay as published. */
export function whatIf({ votes, confidence, buildable, rules, weights, goAt = rules.goAt, watchAt = rules.watchAt }) {
  const w = normalize(weights, rules.weights);
  const S = votes.reduce((a, v) => a + w[v.role] * v.support, 0);
  const sk = votes.find((x) => x.role === 'skeptic').support; const sec = votes.find((x) => x.role === 'security_reviewer').support;
  const vetoes = []; if (sk < rules.vetoSkeptic) vetoes.push('Skeptic'); if (sec < rules.vetoSecurity) vetoes.push('Security');
  const goGrade = S >= goAt && confidence >= rules.minConfidence && !vetoes.length;
  let verdict;
  if (goGrade && buildable) verdict = 'go';
  else if (goGrade) verdict = 'watch';
  else if (S >= watchAt || (S >= goAt && vetoes.length)) verdict = 'watch';
  else verdict = 'drop';
  return { S, verdict, vetoes };
}

// Same canonical JSON as src/council.js: object keys sorted at every level.
export const canon = (x) => JSON.stringify(x, (_, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
export async function sha256Hex(text, subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error('This browser cannot compute SHA-256 here (needs a secure page).');
  const buf = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Recompute every vote digest and the verdict digest of one entry from the numbers and reasons in the API answer. */
export async function verifyEntry(entry, subtle) {
  const seats = [];
  for (const v of entry.votes) {
    const mine = await sha256Hex(canon({ seat: `autonear:council-seat:${v.role}@1`, opp: entry.oppId, weight: v.weight, support: v.support, reason: v.reason }), subtle);
    seats.push({ role: v.role, ok: mine === v.digest });
  }
  const verdictMine = await sha256Hex(canon({ opp: entry.oppId, support: entry.support, verdict: entry.verdict, vetoes: entry.vetoes, votes: entry.votes.map((v) => v.digest) }), subtle);
  return { seats, verdictOk: verdictMine === entry.digest, all: seats.every((s) => s.ok) && verdictMine === entry.digest };
}
