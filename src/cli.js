#!/usr/bin/env node
import { config } from './config.js';
import { openDb } from './db.js';
import { registerSources, ingestAll } from './ingest.js';
import { refreshOpportunities } from './scoring.js';
import { pipelineTick, createRun, executeRun, emit } from './orchestrator/coordinator.js';

const [cmd, ...rest] = process.argv.slice(2);
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
} else {
  console.error('usage: cli.js ingest | tick | bench | pipeline [--opp=opp_treasury] [--chain=near-testnet|evm:84532|...] [--owner=..] [--proposer=..]');
  process.exit(2);
}
await db.close();
