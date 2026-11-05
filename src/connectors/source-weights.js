// Source classes used by src/scoring.js. Kept in a dependency-free module so scoring never imports network code.
//
// SOCIAL_WEIGHT = 0.4 is a JUDGEMENT, not a measurement. Why a social record counts as 0.4 of a GitHub issue / forum post:
//  1. Identity is cheap and unverified (no org membership, free accounts, bot farms); a GitHub issue in the near org or a gov.near.org post
//     comes from an account with history in the NEAR community.
//  2. What we observed live on 2026-11-05 (PROGRESS.md): most NEAR-Protocol-relevant social posts are price/ETF news and promotion,
//     not builder friction. Demand evidence must describe a problem someone has.
//  3. 0.4 keeps it clearly below 1 (so it can corroborate) and well above 0 (so a real builder complaint is still visible).
// Social breadth is additionally CAPPED in scoring (SOCIAL_BREADTH_CAP) and never counts toward the 3-independent-source rule.
export const SOCIAL_WEIGHT = 0.4;
export const SOCIAL_SOURCE_IDS = Object.freeze(['near-social', 'mastodon', 'farcaster', 'devto', 'bluesky']);
export const isSocialSource = (sourceId) => SOCIAL_SOURCE_IDS.includes(sourceId);
export const sourceWeight = (sourceId) => (isSocialSource(sourceId) ? SOCIAL_WEIGHT : 1);
