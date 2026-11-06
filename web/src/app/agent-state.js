// Where an owner-approved NEAR deploy stands. The agent publishes it from the vault (src/autonomy.js, owner-approved execution), so the owner
// needs to know one of three things: it is queued, it was held back, or there is no vault able to do it. Pure, so it is tested without a browser.
export function agentPublishState(d, vault, ledger = [], nowSec = Math.floor(Date.now() / 1000)) {
  const last = [...ledger].filter((e) => e.decisionId === d.id).sort((a, b) => Number(new Date(b.time)) - Number(new Date(a.time)))[0];
  if (last && (last.status === 'refused' || last.status === 'failed')) return 'held';
  // A request is not bound to a vault until the agent claims it, so match on the network: any live vault on the request's network can take it.
  const vs = (vault?.vaults ?? []).filter((x) => !d.chain_id || !x.chainId || x.chainId === d.chain_id);
  const live = vs.some((v) => v.status === 'active' && !v.paused && v.mandate && !v.mandate.revoked && Number(v.mandate.expiresAt) > nowSec);
  return live ? 'waiting' : 'novault';
}
