import { githubConnector } from './github.js';
import { govNearConnector } from './govnear.js';
import { hnConnector } from './hn.js';
import { nearRpcConnector } from './nearrpc.js';
import { nearSocialConnector } from './nearsocial.js';
import { mastodonConnector } from './mastodon.js';
import { farcasterConnector } from './farcaster.js';
import { devtoConnector } from './devto.js';
import { blueskyConnector } from './bluesky.js';
// Order matters for tick latency only: the four established sources first, then social/news (lower weight in scoring, see source-weights.js).
export const CONNECTORS = [githubConnector, govNearConnector, hnConnector, nearRpcConnector, nearSocialConnector, mastodonConnector, farcasterConnector, devtoConnector, blueskyConnector];
