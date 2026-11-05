// Monitor role: re-checks recorded deployments against the chain on every pipeline tick (code unchanged, not paused, owner unchanged).
import { parse, j, now, audit, getBlob } from './db.js';
import { findNetwork } from './protocols.js';
import { jsonRpc, base58, hexToBytes, check } from './chains/common.js';

const strip = (h) => (h ?? '').toLowerCase().replace(/^0x/, '');

async function checkEvm(net, dep, manifest, payload, fetchImpl) {
  const addr = dep.account; const checks = [];
  const code = await jsonRpc('monitor', net.rpc, 'eth_getCode', [addr, 'latest'], { fetchImpl });
  checks.push(check('runtime code unchanged', strip(code) === strip(manifest.deployedBytecode)));
  const raw = strip(await jsonRpc('monitor', net.rpc, 'eth_call', [{ to: addr, data: '0x79502c55' }, 'latest'], { fetchImpl }));
  const w = (i) => raw.slice(i * 64, i * 64 + 64);
  checks.push(check('owner unchanged', '0x' + w(0).slice(24) === '0x' + strip(payload.registry.owner)));
  checks.push(check('pending ownership transfer', BigInt('0x' + w(1)) === 0n, 'a pending transfer is flagged, not failed'));
  checks.push(check('not paused', BigInt('0x' + w(3)) === 0n, 'paused contracts are an operator signal'));
  return checks;
}
async function checkNear(net, dep, manifest, payload, fetchImpl) {
  const checks = [];
  const acct = await jsonRpc('monitor', net.rpc, 'query', { request_type: 'view_account', finality: 'final', account_id: dep.account }, { fetchImpl });
  checks.push(check('code hash unchanged', acct.code_hash === base58(hexToBytes(manifest.sha256))));
  const r = await jsonRpc('monitor', net.rpc, 'query', { request_type: 'call_function', finality: 'final', account_id: dep.account, method_name: 'config', args_base64: Buffer.from('{}').toString('base64') }, { fetchImpl });
  const cfg = JSON.parse(Buffer.from(r.result).toString());
  checks.push(check('owner unchanged', cfg.owner_id === payload.registry.owner));
  checks.push(check('not paused', cfg.paused === false));
  return checks;
}

export async function monitorDeployments(db, { fetchImpl } = {}) {
  const all = await db.all("SELECT * FROM deployments WHERE status = 'verified' ORDER BY time DESC LIMIT 200");
  const lastAt = async (d) => parse((await db.get('SELECT v FROM kv WHERE k=?', [`monitor:${d.id}`]))?.v, null)?.at ?? 0;
  const keyed = await Promise.all(all.map(async (d) => ({ d, at: await lastAt(d) })));
  const deps = keyed.sort((a, b) => a.at - b.at).slice(0, 5).map((x) => x.d); // least-recently-checked first: nothing starves
  const out = [];
  for (const dep of deps) {
    const net = findNetwork(dep.network);
    try {
      const dec = await db.get('SELECT payload FROM decisions WHERE id=?', [dep.decision_id]);
      const att = await db.get('SELECT immutable_ref FROM artifacts WHERE hash=? AND kind LIKE ?', [dep.artifact_hash, 'contract-build:%']);
      const manifest = parse(await getBlob(db, att.immutable_ref), {});
      const payload = parse(dec.payload, {});
      const checks = net.protocol === 'near' ? await checkNear(net, dep, manifest, payload, fetchImpl) : await checkEvm(net, dep, manifest, payload, fetchImpl);
      const res = { at: now(), ok: checks.every((c) => c.ok), checks };
      await db.run('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', [`monitor:${dep.id}`, j(res)]);
      if (!res.ok) await audit(db, 'monitor', 'deployment.anomaly', { id: dep.id, failed: checks.filter((c) => !c.ok) });
      out.push({ id: dep.id, ...res });
    } catch (e) {
      const res = { at: now(), ok: false, error: e.message, checks: [] };
      await db.run('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', [`monitor:${dep.id}`, j(res)]);
      out.push({ id: dep.id, ...res });
    }
  }
  return out;
}
