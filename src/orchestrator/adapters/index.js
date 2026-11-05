// Engine adapters. Every adapter exposes the same status shape. NONE of the three is a hard dependency, and none is
// implemented in this MVP beyond an honest decision about whether it would be invoked: they report "not_installed".
import { config } from '../../config.js';

const base = { enabled: false, version: null, last_run: null, cost: 0, latency: null, result: null, error: null, evidence_id: null };

export function engineRegistry() {
  return [
    {
      ...base, id: 'pythia', name: 'EleutherAI Pythia',
      role: 'Open LLM research suite (scaling/behaviour studies). NOT an orchestrator.',
      license: 'Apache-2.0 (upstream)', upstream: 'https://github.com/EleutherAI/pythia',
      enabled: config.engines.pythia, status: 'not_installed',
      why: 'Not invoked: a Pythia baseline would only be used for a bounded benchmark of Analyst prose quality against the deterministic baseline. No weights are installed; adding it for branding would add cost without evidence value.',
    },
    {
      ...base, id: 'mirofish', name: 'MiroFish',
      role: 'Multi-agent scenario simulation from seed material. Predictions are hypotheses, not validation.',
      license: 'AGPL-3.0 (upstream): network-service use triggers source-offer obligations', upstream: 'https://github.com/666ghj/MiroFish',
      enabled: Boolean(config.engines.mirofishUrl), status: config.engines.mirofishUrl ? 'configured_untested' : 'not_installed',
      why: config.engines.mirofishUrl
        ? 'Endpoint configured but no adapter call is implemented yet.'
        : 'Not invoked: needs a separately hosted instance (AGPL isolation) and real evidence first. Adoption rehearsal is deferred until the registry has usage to compare against.',
    },
    {
      ...base, id: 'kronos', name: 'Kronos',
      role: 'Financial candlestick foundation model for market-regime analysis.',
      license: 'MIT (upstream)', upstream: 'https://github.com/shiyu-coder/Kronos',
      enabled: config.engines.kronos, status: 'not_installed',
      why: 'Not invoked: the current product (attestation registry) moves no funds and needs no market model. Kronos is not an auditor and never gates contract safety here.',
    },
  ];
}
