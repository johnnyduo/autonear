// Curated competitor/prior-art registry. These are HUMAN-CURATED PRIORS, not live evidence: each entry carries a URL
// so the Skeptic can cite it and a reviewer can verify. Last reviewed date is shown in the UI.
export const COMPETITORS_REVIEWED = '2026-11-05';
export const COMPETITORS = {
  treasury: [
    { name: 'Sputnik DAO / AstroDAO', alias: /\bSputnik ?DAO\b|\bAstro ?DAO\b/i, url: 'https://app.astrodao.com', coverage: 0.5, note: 'NEAR-native DAO treasury with role-based proposals; no policy-bound automated rebalancing documented.' },
    { name: 'Safe (multi-chain smart accounts)', alias: /\bGnosis Safe\b|safe\.global|\bSafe ?\{Wallet\}|\bSafe multisig\b/i, url: 'https://safe.global', coverage: 0.3, note: 'Strong multisig and guard modules on EVM; not a NEAR-native account model.' },
    { name: 'Squads', alias: /\bsquads\.so\b|\bSquads Protocol\b/i, url: 'https://squads.so', coverage: 0.3, note: 'Solana treasury multisig with spending limits; different chain.' },
  ],
  intents: [
    { name: 'NEAR Intents (1Click API)', alias: /\b1Click\b|\bNEAR Intents\b/i, url: 'https://docs.near-intents.org', coverage: 0.7, note: 'First-party swap/intents rails; any rebalancing product would build ON it, not replace it.' },
    { name: 'Ref Finance', alias: /\bRef Finance\b|ref\.finance/i, url: 'https://app.ref.finance', coverage: 0.6, note: 'Incumbent NEAR DEX/router.' },
  ],
  signing: [
    { name: 'NEAR Chain Signatures', alias: /\bChain Signatures?\b/i, url: 'https://docs.near.org/chain-abstraction/chain-signatures', coverage: 0.6, note: 'First-party MPC signing; products consume it.' },
  ],
  wallet_ux: [{ name: 'NEAR wallet selector ecosystem', alias: /\bwallet[- ]selector\b/i, url: 'https://github.com/near/wallet-selector', coverage: 0.7, note: 'Mature multi-wallet connector.' }],
  dev_tooling: [{ name: 'near-workspaces / cargo-near', alias: /\bnear-workspaces\b|\bcargo-near\b/i, url: 'https://github.com/near/near-workspaces-rs', coverage: 0.6, note: 'Official testing and build tooling.' }],
  data_indexing: [{ name: 'NEAR Lake / QueryAPI / FastNEAR', alias: /\bNEAR Lake\b|\bQueryAPI\b|\bFastNEAR\b/i, url: 'https://docs.near.org/data-infrastructure/welcome', coverage: 0.6, note: 'Existing indexing infra.' }],
  ai_agents: [{ name: 'NEAR AI / Shade Agents', alias: /\bShade Agents?\b|\bNEAR AI\b/i, url: 'https://docs.near.org/ai/introduction', coverage: 0.5, note: 'First-party agent infrastructure.' }],
};
