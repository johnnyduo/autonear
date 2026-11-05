// Gate B benchmark: deterministic baseline vs LLM-augmented Analyst, scored by the same mechanical rubric.
// The rubric measures verifiability (citations resolve, claims are cited, sources are covered), NOT writing quality.
import { oppEvidence, getOpp } from './store.js';
import { baselineAnalysis, evidenceAnalyst } from './orchestrator/agents.js';
import { Budget } from './policy.js';
import { llmStatus } from './orchestrator/llm.js';

function score(out, evidence) {
  const ids = new Set(evidence.map((e) => e.id));
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const cites = out.findings.flatMap((f) => f.citations);
  const valid = cites.filter((c) => ids.has(c));
  const sources = new Set(valid.map((c) => byId.get(c).source_id));
  const allSources = new Set(evidence.map((e) => e.source_id));
  return {
    findings: out.findings.length,
    citationValidity: cites.length ? valid.length / cites.length : 0,
    claimsWithCitation: out.findings.filter((f) => f.citations.length).length / Math.max(1, out.findings.length),
    sourceCoverage: sources.size / Math.max(1, allSources.size),
    hasProblemStatement: out.problem?.length >= 20,
    flaggedEvidenceCited: valid.filter((c) => byId.get(c).flags.some((f) => f.startsWith('prompt-injection'))).length,
  };
}

export async function runBenchmark(db, oppId = 'opp_treasury') {
  const opp = await getOpp(db, oppId);
  if (!opp) throw new Error(`unknown opportunity ${oppId}`);
  const evidence = await oppEvidence(db, oppId);
  const baseline = baselineAnalysis(opp, evidence);
  const result = { opportunity: oppId, evidenceCount: evidence.length, llm: llmStatus(), arms: { deterministic: score(baseline, evidence) } };
  if (llmStatus().enabled) {
    const t0 = Date.now();
    const out = await evidenceAnalyst({ db, opp, evidence, budget: new Budget() });
    result.arms[`llm:${out.model}`] = { ...score(out.output, evidence), source: out.output.source, latencyMs: Date.now() - t0, tokens: out.tokens, costUsd: out.cost, note: out.detail };
  } else {
    result.arms.llm = { skipped: true, reason: llmStatus().reason };
  }
  return result;
}
