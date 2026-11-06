// Made-up product ideas for the landing card. Seat scores are the bias plus a little noise on every visit; the total is the weighted
// sum with the same weights and thresholds as the real council (build from 62, watch from 48), so each card agrees with itself.
export const SEATS = [['Demand', 0.16], ['Evidence', 0.22], ['Objections', 0.18], ['NEAR fit', 0.10], ['Buildable', 0.12], ['Safety', 0.10], ['Momentum', 0.12]];
export const RULES = { goAt: 62, watchAt: 48 };

//            title (plain words)                                      demand evid. obj.  fit  build safe  moment.
export const STORIES = [
  { title: 'Perp trading with one-click leverage',                    bias: [88, 74, 66, 84, 72, 64, 90] },
  { title: 'Dark pool: block trades with the size hidden',            bias: [64, 52, 44, 66, 40, 50, 60] },
  { title: 'Pay a team in stablecoins from one vault',                bias: [92, 80, 72, 78, 86, 82, 70] },
  { title: 'A card that spends from your wallet at any shop',         bias: [78, 58, 50, 62, 44, 48, 74] },
  { title: 'Private transfers with a proof for auditors',             bias: [70, 60, 56, 70, 52, 66, 62] },
  { title: 'A trading agent that cannot spend past its limit',        bias: [90, 70, 62, 92, 76, 80, 94] },
  { title: 'Gasless bets on real-world events',                       bias: [58, 40, 32, 54, 60, 36, 48] },
  { title: 'Tokenized T-bills as collateral for a treasury',          bias: [84, 76, 70, 74, 66, 72, 68] },
  { title: 'One wallet for payments, trading and yield',              bias: [86, 66, 58, 76, 54, 60, 82] },
];

const clamp = (x, a = 0, b = 100) => Math.max(a, Math.min(b, x));

export function scoreStory(story, rnd = Math.random) {
  const seats = SEATS.map(([name, w], i) => ({ name, w, score: Math.round(clamp(story.bias[i] + (rnd() - 0.5) * 18)) }));
  const support = Math.round(seats.reduce((a, s) => a + s.w * s.score, 0)); // the verdict follows the number that is shown
  const verdict = support >= RULES.goAt ? 'go' : support >= RULES.watchAt ? 'watch' : 'drop';
  return { title: story.title, seats, support, verdict };
}

// The same card as the council API's shape, so the council star on the landing can draw it. Made-up data only.
const ROLES = [['signal_collector', 'Collector'], ['evidence_analyst', 'Analyst'], ['skeptic', 'Skeptic'], ['product_architect', 'Architect'], ['builder', 'Builder'], ['security_reviewer', 'Security'], ['launch_planner', 'Planner']];
const OUTCOME = {
  go: { state: 'waiting', headline: 'Waiting to be executed', detail: 'The request is ready.', next: 'Next: the agent builds it, inside your limits.', done: 3 },
  watch: { state: 'not_started', headline: 'On watch', detail: 'Not strong enough to build yet.', next: 'Next: keep watching. Nothing is built.', done: 1 },
  drop: { state: 'not_started', headline: 'Set aside', detail: 'The council passed on it.', next: 'Next: set aside.', done: 0 },
};
export function councilFrom(r, now = Date.now()) {
  const votes = r.seats.map((s, i) => ({ role: ROLES[i][0], label: ROLES[i][1], weight: s.w, support: s.score / 100, stance: s.score >= RULES.goAt ? 'back' : s.score >= RULES.watchAt ? 'abstain' : 'object', reason: `Score ${s.score} out of 100 for ${s.name.toLowerCase()}.` }));
  const oc = OUTCOME[r.verdict]; const step = (k) => (k < oc.done ? 'done' : k === oc.done ? 'active' : 'todo');
  const entry = { oppId: 'opp_demo', topic: 'treasury', title: r.title, score: r.support / 100, confidence: 0.8, support: r.support / 100, momentum: r.seats[6].score / 100, recent: 10, prior: 6, buildable: true, verdict: r.verdict, vetoes: [], reason: `The score is ${r.support} out of 100.`, votes };
  return {
    council: { at: now, rules: { weights: Object.fromEntries(ROLES.map(([k], i) => [k, SEATS[i][1]])), goAt: RULES.goAt / 100, watchAt: RULES.watchAt / 100, minConfidence: 0.45, vetoSkeptic: 0.25, vetoSecurity: 0.3, trendWindowDays: 14, freshMs: 21600000 }, buildableTopics: ['treasury'], opportunities: [entry], winner: 'opp_demo', trigger: 'cron' },
    journey: { oppId: 'opp_demo', run: { id: 'run_demo', state: 'awaiting_approval', startedAt: now, endedAt: now, roles: Object.fromEntries(ROLES.map(([k]) => [k, 'completed'])) }, decision: null, deployment: null,
      stages: ['Research', 'Build and check', 'Decision', 'Owner approves and signs', 'Deploy', 'Check on chain', 'Monitor'].map((label, k) => ({ id: ['research', 'build', 'decision', 'approve', 'deploy', 'verify', 'monitor'][k], label, state: step(k), detail: 'made-up' })),
      outcome: { state: oc.state, headline: oc.headline, detail: oc.detail, next: oc.next, progress: { done: oc.done, total: 7 } } },
    mode: 'auto',
  };
}
