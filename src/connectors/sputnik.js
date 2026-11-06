import { rpc } from './nearrpc.js';
import { int, nearOf, utcDay } from './onchain-common.js';

// Sputnik DAO treasuries on NEAR mainnet. DAOs were picked on 2026-11-06 from the factory `sputnik-dao.near` (2,074 DAOs) as the ones with the most proposals;
// the balances are what `view_account` returns now and `get_last_proposal_id` is the number of proposals ever filed. This is on-chain treasury activity: it says
// that multisig-style treasuries exist and are used, not that they need a particular product.
const DAOS = ['ref-finance.sputnik-dao.near', 'news.sputnik-dao.near', 'marmaj.sputnik-dao.near', 'marketing.sputnik-dao.near', 'creatives.sputnik-dao.near'];

export const sputnikConnector = {
  id: 'sputnik-dao',
  name: 'Sputnik DAO treasuries · NEAR mainnet',
  kind: 'usage',
  endpoint: 'https://rpc.mainnet.fastnear.com',
  terms: 'Public NEAR JSON-RPC view calls on Sputnik DAO contracts (docs.near.org/api/rpc). Public chain data.',
  rateLimit: 'Public RPC is rate limited; we make 2 view calls per DAO (10 per run) and at most one run every 2 hours; a DAO that fails is skipped',
  docsUrl: 'https://github.com/near-daos/sputnik-dao-contract',
  minIntervalMs: 2 * 3_600_000,
  subSources: () => DAOS.map((id) => `dao: ${id}`),
  async fetch(ctx = {}) {
    const rows = []; const errors = [];
    for (const id of DAOS) {
      try {
        const [acct, last] = await Promise.all([
          rpc('query', { request_type: 'view_account', finality: 'final', account_id: id }, ctx),
          rpc('query', { request_type: 'call_function', finality: 'final', account_id: id, method_name: 'get_last_proposal_id', args_base64: Buffer.from('{}').toString('base64') }, ctx),
        ]);
        const proposals = JSON.parse(Buffer.from(last.result).toString());
        if (!Number.isInteger(proposals) || proposals < 0) throw new Error('get_last_proposal_id is not an integer');
        rows.push({ id, amount: acct.amount, proposals, block: acct.block_height });
      } catch (e) { errors.push(`${id}: ${String(e.message).slice(0, 100)}`); }
    }
    if (rows.length < 2) throw new Error(`sputnik: only ${rows.length} of ${DAOS.length} DAOs could be read (${errors.join('; ')})`);
    const total = rows.reduce((a, r) => a + BigInt(r.amount), 0n);
    const props = rows.reduce((a, r) => a + r.proposals, 0);
    const day = utcDay();
    return {
      items: [{
        externalId: `sputnik:treasuries:${day}`,
        url: `https://nearblocks.io/address/${rows[0].id}`,
        publishedAt: Date.now(),
        author: 'near-rpc',
        title: `On-chain: ${rows.length} NEAR DAO treasuries hold ${int(Number(nearOf(total).split('.')[0]))} NEAR and have filed ${int(props)} proposals, ${day}`,
        body: `Observed on NEAR mainnet at block ${rows[0].block}. ${rows.map((r) => `${r.id}: ${nearOf(r.amount)} NEAR native balance, ${int(r.proposals)} proposals filed`).join('; ')}. `
          + 'Sputnik DAOs pay out of a shared treasury only after members vote on a proposal.',
        org: 'near',
        kind: 'usage',
        license: 'public chain data',
        signals: { daos: rows.map((r) => ({ id: r.id, yocto: r.amount, proposals: r.proposals })), totalYocto: total.toString(), block: rows[0].block },
        raw: { rows, errors },
        forceTags: ['treasury'],
        forceReason: 'on-chain Sputnik DAO treasury balances and proposal counts',
      }],
      meta: { partial: errors.length > 0, errors },
    };
  },
};
