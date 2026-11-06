// One data hook for the whole owner app. Live API by default; the demo (hash `?fixture=1`, or no vault attached at all) swaps ONLY the vault,
// history and requests for the labelled example data. Ingestion numbers (sources, findings) are always real.
import { useEffect, useMemo, useState } from 'react';
import { isFixtureMode, useApi } from '../api.js';

// The product is NEAR testnet only. Anything on another chain (old rows, the design fixture's EVM vaults) is left out of the owner app.
const isNear = (c) => String(c ?? '').startsWith('near');
const nearVaults = (v) => (v && Array.isArray(v.vaults) ? { ...v, vaults: v.vaults.filter((x) => isNear(x.chainId)) } : v);
const nearFx = (fx) => {
  if (!fx || fx.mode !== 'ok') return fx;
  const vault = nearVaults(fx.vault); const ids = new Set((vault?.vaults ?? []).map((x) => x.id));
  return { ...fx, vault, decisions: (fx.decisions ?? []).filter((d) => isNear(d.chain_id)), ledger: { ...fx.ledger, items: (fx.ledger?.items ?? []).filter((e) => !e.vaultId || ids.has(e.vaultId)) } };
};

// `#/vault?fixture=1&scenario=idle` previews a vault without payouts (the default preview has one). Any other scenario name falls back to the default.
export const fixtureScenario = () => { try { const s = new URLSearchParams((location.hash || '').split('?')[1] || '').get('scenario'); return s === 'idle' ? s : 'default'; } catch { return 'default'; } };

export function useAppData() {
  const forced = isFixtureMode();
  const status = useApi('/api/status', { poll: 15000 });
  const vaultLive = useApi('/api/vault', { poll: 20000, enabled: !forced });
  const decLive = useApi('/api/decisions', { poll: 20000, enabled: !forced });
  const ledgerLive = useApi('/api/vault/ledger?limit=40', { poll: 30000, enabled: !forced });
  const watch = useApi('/api/watch');
  const autonomy = useApi('/api/autonomy', { poll: 20000 });
  // Payments are only asked for when a vault in the report can pay (a v1 vault never causes this request).
  const canPayLive = !forced && (vaultLive.data?.vaults ?? []).some((v) => v.payouts);
  const paymentsLive = useApi('/api/payments', { poll: 20000, enabled: canPayLive });
  const opps = useApi('/api/opportunities', { poll: 60000 });
  const noVault = vaultLive.data && !(vaultLive.data.vaults ?? []).length;
  const demo = forced || Boolean(noVault);
  const [fx, setFx] = useState(null);
  useEffect(() => {
    if (!demo || fx) return undefined;
    let on = true;
    import('../mock/vaultFixture.js').then((m) => on && setFx(nearFx(m.buildFixture(fixtureScenario(), Date.now())))).catch(() => {});
    return () => { on = false; };
  }, [demo, fx]);
  const liveDecisions = decLive.data?.items ?? [];
  const liveLedger = ledgerLive.data?.items ?? [];
  // Example requests/history appear only when there is nothing real to show; real ones always win, and example ones can never be approved.
  const demoDecisions = forced || (demo && !liveDecisions.length);
  const demoLedger = forced || (demo && !liveLedger.length);
  return useMemo(() => ({
    demo, demoDecisions,
    demoReason: forced ? 'preview' : 'no-vault',
    status,
    vault: demo ? (fx?.vault ?? null) : (nearVaults(vaultLive.data) ?? null),
    vaultError: demo ? null : vaultLive.error,
    decisions: demoDecisions ? (fx?.decisions ?? []) : liveDecisions,
    ledger: demoLedger ? (fx?.ledger?.items ?? []) : liveLedger,
    payments: demo ? (fx?.payments ?? { items: [] }) : (canPayLive ? (paymentsLive.data ?? { items: [] }) : { items: [] }),
    watch: watch.data, autonomy: autonomy.data, opps: opps.data?.items ?? [],
    reload: () => { status.reload(); vaultLive.reload(); decLive.reload(); ledgerLive.reload(); paymentsLive.reload(); watch.reload(); autonomy.reload(); },
    reloadWatch: watch.reload, reloadAutonomy: autonomy.reload,
  }), [demo, demoDecisions, demoLedger, liveDecisions, liveLedger, forced, fx, status, vaultLive, decLive, ledgerLive, paymentsLive, canPayLive, watch, autonomy, opps]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The vault the app talks about: the first one that has a mandate, else the first. */
export const mainVault = (vault) => (vault?.vaults ?? []).find((v) => v.mandate && !v.mandate.revoked) ?? vault?.vaults?.[0] ?? null;
export const pendingOf = (decisions) => decisions.filter((d) => d.effectiveStatus === 'pending');
