// Explicit, inspectable relevance + topic rules. NEAR Protocol is distinguished from the English word "near".

// Strong NEAR-Protocol markers. Bare "near" never counts.
const STRONG = [ // decisive: unambiguous NEAR Protocol reference on its own
  [/\bNEAR Protocol\b/i, 'mentions "NEAR Protocol"'],
  [/\bNEAR[-_ ]?Intents?\b/i, 'mentions "NEAR Intents"'], // also the hashtag form #NEARIntents / #near_intents used on social networks
  [/\bnearprotocol\b/i, 'mentions NearProtocol (hashtag / handle)'], // the one-word form is never the English word
  [/\bnearcore\b/i, 'mentions nearcore'],
  [/\bnear[-_ ]?sdk\b/i, 'mentions near-sdk'],
  [/\bnear[-_ ]?cli\b/i, 'mentions near-cli'],
  [/\bNEAR (wallet|blockchain|chain|token|account|contract|validator|mainnet|testnet|ecosystem|AI|foundation|DAO)\b/i, 'NEAR + blockchain noun'],
];
const WEAK = [ // supporting: need blockchain context or another marker to count
  [/\bchain signatures?\b/i, 'mentions Chain Signatures'],
  [/\b[a-z0-9_-]+\.(?:near|testnet)\b/, 'contains a .near/.testnet account id'],
  [/\bnear\.org\b|\bnear\.ai\b|\bnearblocks\.io\b|\bnear-intents\.org\b/i, 'links a NEAR domain'],
  [/\b(?:NEP-\d{2,4})\b/, 'cites a NEP'],
  [/\$NEAR\b|\bNEAR\/USD\b/, 'ticker $NEAR'],
];
const NEAR_ORGS = new Set(['near', 'near-gov']);
const BLOCKCHAIN_CONTEXT = /\b(blockchain|smart contract|wallet|validator|shard|sharding|rpc|onchain|on-chain|dapp|token|defi|web3|crypto|account abstraction|multisig)\b/i;

// Phrases that mean the ordinary word.
const FALSE_FRIENDS = /\b(near[- ]?(?:earth|field|future|term|real[- ]?time|duplicate|miss|me|by|ly|sighted|death)|nearby|nearest|nearly|near[- ]infrared|near to|near the|near a)\b/i;

export const TOPICS = {
  treasury: { label: 'Treasury & multisig operations', re: /\b(treasur(y|ies)|multi-?sig|rebalanc\w*|dao fund|payroll|grant payout|spend(ing)? polic\w*|allowlist)\b/i },
  intents: { label: 'Intents, swaps & solver routing', re: /\b(intents?|solver|1click|swap|quote|slippage|liquidity|router|cross-chain|bridge)\b/i },
  signing: { label: 'Chain signatures & key custody', re: /\b(chain signatures?|mpc|key custody|signer|sign(ing)? request|delegat\w+ key|access key|function.?call key)\b/i },
  wallet_ux: { label: 'Wallet & account UX', re: /\b(wallet|onboarding|account creation|seed phrase|passkey|login|connect wallet|wallet selector)\b/i },
  dev_tooling: { label: 'Developer tooling & SDKs', re: /\b(sdk|cli|near-api|workspaces|sandbox|testing|compile|wasm|cargo|toolchain|debug|deploy)\b/i },
  data_indexing: { label: 'Data, RPC & indexing', re: /\b(indexer|rpc|archival|lake|query api|explorer|data availability|rate.?limit|graphql)\b/i },
  ai_agents: { label: 'AI agents on NEAR', re: /\b(ai agents?|agentic|llm|autonomous agent|shade agent|tee|openai)\b/i },
};

const INJECTION = [
  /ignore (all |any )?(previous|prior|above) (instructions|prompts?)/i,
  /disregard (the )?(system|previous) (prompt|instructions)/i,
  /you are now (a|an|the) /i,
  /(^|\n)\s*(system|assistant)\s*:/i,
  /<\|(im_start|im_end|system)\|>/i,
  /reveal (your )?(system prompt|api key|secret|private key)/i,
  /(send|transfer) (all )?(funds|tokens|near) to/i,
];

export function injectionFlags(text) {
  return INJECTION.filter((r) => r.test(text)).map((r) => 'prompt-injection:' + r.source.slice(0, 40));
}

/**
 * @returns {{score:number, isNear:boolean, reasons:string[], tags:string[], flags:string[]}}
 */
export function assessRelevance({ title = '', body = '', url = '', org = null, author = '', authorType = '' }) {
  const text = `${title}\n${body}\n${url}`;
  const reasons = [];
  let score = 0;
  const flags = injectionFlags(text);

  const inNearHome = NEAR_ORGS.has(org);
  if (inNearHome) { score += 0.6; reasons.push(org === 'near' ? 'published inside the github.com/near organization' : 'published on the NEAR governance forum (gov.near.org)'); }
  const strong = STRONG.filter(([r]) => r.test(text));
  const weak = WEAK.filter(([r]) => r.test(text));
  for (const [, why] of [...strong, ...weak]) reasons.push(why);
  const ctx = BLOCKCHAIN_CONTEXT.test(text);
  if (ctx) reasons.push('blockchain context words present');
  if (strong.length) score += 0.6 + Math.min(0.2, (strong.length - 1) * 0.1);
  if (weak.length) score += Math.min(0.4, weak.length * 0.25) + (ctx ? 0.25 : 0);
  else if (ctx) score += 0.05;
  if (FALSE_FRIENDS.test(text) && strong.length === 0 && !inNearHome) {
    score -= 0.4; reasons.push('ordinary-English "near" phrase and no NEAR Protocol marker');
  }
  if (/\[bot\]$/i.test(author) || authorType === 'Bot') { flags.push('bot-author'); reasons.push('author is a bot: de-weighted'); score -= 0.15; }
  if (flags.some((f) => f.startsWith('prompt-injection'))) reasons.push('contains prompt-injection-like text: quarantined from LLM prompts');

  score = Math.max(0, Math.min(1, score));
  const isNear = score >= 0.5 && (inNearHome || strong.length > 0 || (weak.length > 0 && ctx));
  const tags = Object.entries(TOPICS).filter(([, t]) => t.re.test(text)).map(([k]) => k);
  return { score: Number(score.toFixed(2)), isNear, reasons, tags, flags };
}

export const RELEVANCE_THRESHOLD = 0.5;
