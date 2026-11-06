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
