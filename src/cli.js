#!/usr/bin/env node
import { config } from './config.js';
import { openDb } from './db.js';
import { registerSources, ingestAll } from './ingest.js';
import { refreshOpportunities } from './scoring.js';
import { pipelineTick, createRun, executeRun, emit } from './orchestrator/coordinator.js';

const [cmd, ...rest] = process.argv.slice(2);

/** `agent` subcommands. Never prints key material: only the keystore's public view. Amounts are whole units ("0.01") or base units with a suffix ("5000wei", "10yocto"). */
async function agentCommand(db, args) {
  const [sub, ...more] = args;
  const flags = Object.fromEntries(more.filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.length ? v.join('=') : 'true']; }));
  const { loadKeystore } = await import('./agent/keystore.js');
  let ks = null;
  try { ks = loadKeystore({ create: false }); const pv = ks.publicView(); if (!pv.evm && !pv.near) ks = null; } catch (e) { console.error(`agent: keystore not loaded: ${String(e.message).replace(/\s+/g, ' ').slice(0, 200)}`); }
  const vault = await import('./vault/index.js');
  const { findNetwork } = await import('./protocols.js');
  if (sub === 'status') {
    console.log(JSON.stringify(await vault.vaultReport(db, { keystore: ks, signingSupported: Boolean(ks) }), null, 2));
    return 0;
  }
  if (sub === 'loop') {
    const { autonomyEnabled } = await import('./config.js');
    if (!autonomyEnabled()) { console.error('agent loop: AUTONOMY_ENABLED is off (default). Set AUTONOMY_ENABLED=1 to let the agent act. Nothing was done.'); return 3; }
    const { runLoop } = await import('./autonomy.js');
    const ac = new AbortController();
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => ac.abort());
    const interval = Math.max(5, Number(flags.interval ?? 30)) * 1000;
    await runLoop(db, { keystore: ks, signingSupported: Boolean(ks) }, { intervalMs: interval, signal: ac.signal, once: flags.once === 'true', onTick: (r) => console.log(`[agent:loop] ${new Date().toISOString()} ${r.skipped ?? r.error ?? JSON.stringify(r.vaults ?? [])}`) });
    return 0;
  }
  if (sub === 'propose') {
    const chainId = flags.chain ?? 'evm:84532'; const net = findNetwork(chainId);
    if (!net) { console.error(`agent propose: unknown --chain ${chainId}`); return 2; }
    const { parseUnits, UNITS } = await import('./vault/units.js');
    const amt = (name) => {
      const raw = String(flags[name] ?? ''); const m = /^([0-9]+)(wei|yocto)$/.exec(raw);
      if (m) return m[1];
      const v = parseUnits(raw, UNITS[net.protocol].decimals);
      if (v === null) throw new Error(`--${name} must be a decimal amount like 0.01 (${UNITS[net.protocol].symbol}) or an integer with a wei/yocto suffix`);
      return v.toString();
    };
    let artifact = flags.artifact;
    if (!artifact) artifact = (await db.get("SELECT hash FROM artifacts WHERE kind=? ORDER BY created_at DESC LIMIT 1", [`contract-build:${net.protocol}`]))?.hash;
    if (!artifact) { console.error(`agent propose: no attested ${net.protocol} build; run "npm run attest" first`); return 2; }
    try {
      const d = await vault.proposeGrant(db, {
        chainId, vault: flags.vault, agent: flags.agent,
        mandate: { expiresInSecs: Number(flags['expires-days'] ?? 7) * 86400, perDrawCap: amt('per-draw'), periodSecs: Number(flags['period-secs'] ?? 3600), periodCap: amt('period-cap'), totalCap: amt('total-cap'), maxDeploys: Number(flags['max-deploys'] ?? 2) },
        templates: [{ artifactHash: artifact, owner: flags.owner, proposer: flags.proposer ?? flags.owner, maxSpendCap: flags['max-spend-cap'] ?? '0' }],
        fund: { amount: amt('fund') }, loop: { maxPerDay: Number(flags['max-per-day'] ?? 3) },
      }, { keystore: ks });
      console.log(JSON.stringify({ decisionId: d.id, status: d.status, confirmPhrase: d.confirmPhrase, payloadHash: d.payload_hash, next: `approve in the Approval Room, then GET /api/vault/plan?decisionId=${d.id} for the exact transactions` }, null, 2));
      return 0;
    } catch (e) { console.error(`agent propose: ${e.message}`); return 2; }
  }
  console.error('usage: cli.js agent status | loop [--once] [--interval=SEC] | propose --chain=.. --vault=.. --owner=.. [...]');
  return 2;
}
const db = await openDb({ path: config.dbPath });
await registerSources(db);
if (cmd === 'ingest') {
  const r = await ingestAll(db, { trigger: 'cli' }); const o = await refreshOpportunities(db);
  console.log(JSON.stringify({ ingest: r, opportunities: o.map((x) => ({ id: x.id, score: x.score, confidence: x.confidence })) }, null, 2));
} else if (cmd === 'tick') {
  console.log(JSON.stringify(await pipelineTick(db, { trigger: 'cli', ingest: ingestAll }), null, 2));
} else if (cmd === 'pipeline') {
  const arg = Object.fromEntries(rest.map((a) => a.replace(/^--/, '').split('=')));
  await refreshOpportunities(db);
  const { run } = await createRun(db, { opportunityId: arg.opp ?? 'opp_treasury', trigger: 'cli', idemKey: `cli:${Date.now()}`, params: { chain: arg.chain ?? 'near-testnet', owner: arg.owner, proposer: arg.proposer } });
  const done = await executeRun(db, run.id);
  const events = await db.all('SELECT stage,agent_role,status,detail FROM run_events WHERE run_id=? ORDER BY id', [run.id]);
  console.log(JSON.stringify({ run: done, events }, null, 2));
} else if (cmd === 'bench') {
  const { runBenchmark } = await import('./bench.js');
  await refreshOpportunities(db);
  console.log(JSON.stringify(await runBenchmark(db, rest[0] ?? 'opp_treasury'), null, 2));
} else if (cmd === 'agent') {
  process.exitCode = await agentCommand(db, rest);
} else {
  console.error('usage: cli.js ingest | tick | bench | pipeline [--opp=opp_treasury] [--chain=near-testnet|evm:84532|...] [--owner=..] [--proposer=..]\n       cli.js agent status | loop [--once] [--interval=SEC] | propose --chain=evm:84532 --vault=0x.. --owner=0x.. [--proposer=0x..] [--artifact=<hash>] [--per-draw=0.01 --period-secs=3600 --period-cap=0.02 --total-cap=0.1 --max-deploys=2 --expires-days=7 --fund=0.1 --max-per-day=3]');
  process.exit(2);
}
await db.close();
