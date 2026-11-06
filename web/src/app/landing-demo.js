// Illustration for the landing hero. MADE-UP DATA, generated in the browser on every visit: none of it was read from the network
// and none of it is stored anywhere. The app's own screens (Home, #/constellation) show the real stored records.
// The topic wells keep the engine's internal ids; only the labels shown on screen are changed (see `labels`).
// Same ids, same order as TOPIC_ORDER in views/_evidence-parts.jsx (not imported: that file is JSX and this one is tested in plain Node).
const LABELS = {
  treasury: 'Stablecoins', intents: 'Perp DEX', signing: 'Dark pools', wallet_ux: 'Onchain cards',
  dev_tooling: 'Privacy', data_indexing: 'Prediction markets', ai_agents: 'AI trading', untagged: 'RWA',
};

export const TOPIC_LABELS = Object.values(LABELS); // the eight illustrated topics, in the engine's order

const TITLES = {
  treasury: ['Payroll moves from bank wires to a dollar token', 'Yield-bearing dollar passes another supply high', 'Local-currency stablecoin goes live in Brazil', 'Treasury teams ask for per-seat spend limits', 'Cross-border payout settles in seconds, not days', 'Merchant checkout accepts stablecoins without a card network', 'Stablecoin float earns on a vault instead of idling', 'Remittance app drops fees to a flat cent'],
  intents: ['Perp venue ships cross-margin with sub-second fills', 'Funding rates flip negative across the majors', 'Order book moves fully onchain, no keeper needed', 'Solvers compete to fill a perp order at best price', 'One-click leverage from any chain via intents', 'Liquidation engine rewritten for tighter bands', 'Perp traders ask for a kill switch on agents', 'Open interest climbs while spot volume sleeps'],
  signing: ['Dark pool matches a block trade without leaking size', 'Encrypted order flow hides slippage from searchers', 'Sealed-bid auction settles privately, proves later', 'Institutions want size hidden until the fill', 'Threshold keys let a team sign without one hot wallet', 'Pre-trade privacy without a trusted operator', 'Intent batches settle at one clearing price', 'Searchers lose an edge when orders stay sealed'],
  wallet_ux: ['Self-custody card spends dollars at a corner shop', 'Tap to pay from a smart account, no seed phrase', 'Card rewards paid out as staking yield', 'Gas paid in the token you are already spending', 'Passkey wallet onboards in one tap', 'Virtual card issued in under a minute', 'Spend limits set per merchant category', 'Recovery by friends instead of twelve words'],
  dev_tooling: ['Shielded transfers with view keys for auditors', 'Privacy pool passes a compliance proof', 'Stealth addresses for payroll that stays private', 'Zero-knowledge proof of funds, no balance shown', 'Selective disclosure for a tax report', 'Private payments without a mixer', 'Proof that a wallet is not on a sanctions list', 'Confidential token standard draws wallet teams'],
  data_indexing: ['Prediction market clears a record election volume', 'Gasless bets for a sports prediction app', 'Oracle disputes resolve in minutes, not days', 'Market maker quotes both sides of a niche event', 'Event contracts list on a new venue', 'Liquidity for long-tail outcomes finally appears', 'Resolution rules written in plain language', 'Traders hedge a policy vote with a share'],
  ai_agents: ['Agent rebalances a vault inside its spend limits', 'Autonomous trader runs a month on a hard daily cap', 'Agent wallets get per-trade caps and a pause button', 'Strategy marketplace lists onchain bots with audited limits', 'Agent pays for its own data feed from a budget', 'A leash for the agent: limits live on chain, not in a prompt', 'Swarm of small agents splits one mandate', 'Human approves the big move, agent handles the rest'],
  untagged: ['Tokenized T-bills pass a new supply high', 'Private credit pool goes live onchain', 'Real estate share trades around the clock', 'Fund shares settle same day', 'Invoice financing opens to small lenders', 'Commodity token redeems for a vault receipt', 'Bond coupon paid by a smart contract', 'Collateral moves between venues without a custodian'],
};

// Source ids the real engine already colours; names are display only.
const SOURCES = [
  ['github-near', 'GitHub'], ['hn-algolia', 'Hacker News'], ['farcaster', 'Farcaster'], ['mastodon', 'Mastodon'], ['devto', 'Dev.to'], ['bluesky', 'Bluesky'],
  ['near-social', 'NEAR Social'], ['gov-near', 'Gov forum'], ['defillama-near', 'DefiLlama'], ['nearblocks', 'NearBlocks'], ['sputnik-dao', 'DAO treasuries'], ['near-official', 'near.org blog'],
];

// small seeded generator so one visit is internally consistent; the seed differs per visit
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hex = (r, n) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');

export function makeLandingDemo(seed = (Math.random() * 2 ** 32) >>> 0, count = 300) {
  const r = rng(seed); const now = Date.now(); const topics = Object.keys(LABELS).filter((k) => k !== 'untagged');
  // uneven topic sizes: some wells are big, some small
  const weight = Object.fromEntries([...topics, 'untagged'].map((t) => [t, 0.5 + r() * 1.5]));
  const wsum = Object.values(weight).reduce((a, b) => a + b, 0);
  const pick = () => { let x = r() * wsum; for (const [t, w] of Object.entries(weight)) { x -= w; if (x <= 0) return t; } return 'untagged'; };
  const evidence = []; const links = new Map();
  for (let i = 0; i < count; i++) {
    const topic = pick(); const titles = TITLES[topic]; const src = SOURCES[Math.floor(r() * SOURCES.length)][0];
    const id = `ev_demo_${i}`; const age = Math.floor(r() ** 1.6 * 14 * 864e5);
    const rel = Math.min(0.99, 0.2 + r() ** 0.45 * 0.8);
    const flagged = r() < 0.08;
    evidence.push({
      id, source_id: src, kind: 'post', title: titles[Math.floor(r() * titles.length)], body_excerpt: '', content_hash: hex(r, 64),
      observed_at: now - age, published_at: now - age - Math.floor(r() * 36e5), relevance: Math.round(rel * 100) / 100,
      flags: flagged ? ['low-signal:repeated-text'] : [], tags: topic === 'untagged' ? [] : [topic], canonical_url: '',
    });
    const rr = r(); const relation = rr < 0.78 ? 'supports' : rr < 0.9 ? 'usage' : rr < 0.96 ? 'competitor' : 'contradicts';
    links.set(id, topic === 'untagged' ? [] : [{ opp: `opp_${topic}`, relation }, ...(r() < 0.18 ? [{ opp: `opp_${topics[Math.floor(r() * topics.length)]}`, relation: 'supports' }] : [])]);
  }
  const opps = topics.map((t) => ({ id: `opp_${t}`, topic: t, title: LABELS[t], score: Math.round((0.52 + r() * 0.42) * 100) / 100, confidence: Math.round((0.6 + r() * 0.35) * 100) / 100, warnings: [] }));
  // made-up freshness so the labels read "ingested 7m ago" or "quiet"; a few are recent enough to pulse
  return { evidence, links, labels: LABELS, opps,
    sources: SOURCES.map(([id, name]) => ({ id, name, status: 'ok', lastSuccess: now - Math.floor((r() < 0.45 ? 1 + r() * 16 : 25 + r() * 200) * 60000) })) };
}
