import { githubConnector } from './github.js';
import { govNearConnector } from './govnear.js';
import { hnConnector } from './hn.js';
import { nearRpcConnector } from './nearrpc.js';
import { nearSocialConnector } from './nearsocial.js';
import { mastodonConnector } from './mastodon.js';
import { farcasterConnector } from './farcaster.js';
import { devtoConnector } from './devto.js';
import { blueskyConnector } from './bluesky.js';
import { defillamaConnector } from './defillama.js';
import { nearblocksConnector } from './nearblocks.js';
import { sputnikConnector } from './sputnik.js';
import { nearFeedConnector } from './nearfeed.js';
// Order matters for tick latency only: the four established sources first, then on-chain usage and the official feed, then social (lower weight in scoring, see source-weights.js).
export const CONNECTORS = [githubConnector, govNearConnector, hnConnector, nearRpcConnector, defillamaConnector, nearblocksConnector, sputnikConnector, nearFeedConnector, nearSocialConnector, mastodonConnector, farcasterConnector, devtoConnector, blueskyConnector];
