// One data hook for the whole owner app. Live API by default; the demo (hash `?fixture=1`, or no vault attached at all) swaps ONLY the vault,
// history and requests for the labelled example data. Ingestion numbers (sources, findings) are always real.
import { useEffect, useMemo, useState } from 'react';
import { isFixtureMode, useApi } from '../api.js';

export function useAppData() {
  const forced = isFixtureMode();
  const status = useApi('/api/status', { poll: 15000 });
  const vaultLive = useApi('/api/vault', { poll: 20000, enabled: !forced });
  const decLive = useApi('/api/decisions', { poll: 20000, enabled: !forced });
  const ledgerLive = useApi('/api/vault/ledger?limit=40', { poll: 30000, enabled: !forced });
  const watch = useApi('/api/watch');
  const autonomy = useApi('/api/autonomy', { poll: 20000 });
  const opps = useApi('/api/opportunities', { poll: 60000 });
  const noVault = vaultLive.data && !(vaultLive.data.vaults ?? []).length;
  const demo = forced || Boolean(noVault);
  const [fx, setFx] = useState(null);
  useEffect(() => {
    if (!demo || fx) return undefined;
    let on = true;
    import('../mock/vaultFixture.js').then((m) => on && setFx(m.buildFixture('default', Date.now()))).catch(() => {});
    return () => { on = false; };
  }, [demo, fx]);
  return useMemo(() => ({
    demo,
    demoReason: forced ? 'preview' : 'no-vault',
    status,
    vault: demo ? (fx?.vault ?? null) : (vaultLive.data ?? null),
    vaultError: demo ? null : vaultLive.error,
    decisions: demo ? (fx?.decisions ?? []) : (decLive.data?.items ?? []),
    ledger: demo ? (fx?.ledger?.items ?? []) : (ledgerLive.data?.items ?? []),
    watch: watch.data, autonomy: autonomy.data, opps: opps.data?.items ?? [],
    reload: () => { status.reload(); vaultLive.reload(); decLive.reload(); ledgerLive.reload(); watch.reload(); autonomy.reload(); },
    reloadWatch: watch.reload, reloadAutonomy: autonomy.reload,
  }), [demo, forced, fx, status, vaultLive, decLive, ledgerLive, watch, autonomy, opps]);
}

/** The vault the app talks about: the first one that has a mandate, else the first. */
export const mainVault = (vault) => (vault?.vaults ?? []).find((v) => v.mandate && !v.mandate.revoked) ?? vault?.vaults?.[0] ?? null;
export const pendingOf = (decisions) => decisions.filter((d) => d.effectiveStatus === 'pending');
