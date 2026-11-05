// Wrangler `alias` target for modules that exist only on the Node/Vercel code paths (node:sqlite, @libsql/client).
// The Worker always opens D1 (src/worker.js -> openDb({ d1 })), so these dynamic imports are unreachable there.
const unavailable = () => { throw new Error('this module is not available on Cloudflare Workers; use the D1 binding'); };
export const DatabaseSync = unavailable;
export const createClient = unavailable;
export default {};
