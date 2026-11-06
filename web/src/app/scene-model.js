// Pure model for the Leash scene: real numbers in, drawable facts out. Tested in scene-model.test.js. The picture must never claim more than the data.
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const big = (v) => { try { return BigInt(v ?? 0); } catch { return 0n; } };
const frac = (a, b) => { const d = big(b); if (d <= 0n) return 0; return clamp(Number((big(a) * 10000n) / d) / 10000); };

export function buildScene({ sources = [], vault = null, autonomy = null, pending = [], demo = false, paused = false, now = Date.now() } = {}) {
  const nodes = sources.map((s, i) => ({
    id: s.id, name: s.name, angle: (i / Math.max(1, sources.length)) * Math.PI * 2 - Math.PI / 2,
    tone: s.status === 'ok' ? (s.stale ? 'warn' : 'ok') : s.status === 'disabled_by_owner' || s.status === 'not_configured' ? 'off' : 'bad',
    fresh: Boolean(s.lastSuccess && now - s.lastSuccess < 20 * 60_000),
  }));
  const m = vault?.mandate;
  const has = Boolean(vault && m && !m.revoked);
  const used = has ? Math.max(frac(vault.usage?.totalSpent, m.totalCap), frac(vault.usage?.periodSpent, m.periodCap)) : 0;
  const low = has ? big(vault.agentBalance) < big(autonomy?.topUp?.evm?.low ?? '3000000000000000') : false;
  const target = big(autonomy?.topUp?.evm?.target ?? '10000000000000000');
  const gas = has ? { pct: frac(vault.agentBalance, target), low } : null;
  const mode = autonomy?.mode === 'auto' ? 'auto' : 'manual';
  const beams = paused ? [] : pending.slice(0, 5).map((d, i) => ({ id: d.id, phase: i / Math.max(1, Math.min(5, pending.length)), waiting: mode !== 'auto' }));
  const state = paused ? 'paused' : demo ? 'demo' : 'live';
  const summary = `${nodes.filter((n) => n.tone === 'ok').length} of ${nodes.length} sources healthy. ${has ? `Limits used: ${Math.round(used * 100)}%.` : 'No vault limits yet.'} ${gas ? `Agent fuel: ${Math.round(gas.pct * 100)}%${low ? ', low' : ''}.` : ''} ${beams.length ? `${beams.length} request${beams.length > 1 ? 's' : ''} ${mode === 'auto' ? 'in flight' : 'waiting for you'}.` : 'No requests waiting.'}`.replace(/\s+/g, ' ').trim();
  return { nodes, ring: { has, fill: used }, gas, beams, mode, state, summary };
}
