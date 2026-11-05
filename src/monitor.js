// Monitor role: re-checks recorded deployments against the chain on every pipeline tick (code unchanged, not paused, owner unchanged).
import { parse, j, now, audit, getBlob } from './db.js';
import { findNetwork } from './protocols.js';
import { jsonRpc, base58, hexToBytes, check } from './chains/common.js';
import { listVaults, readVault, verifyMandate, verifyLedgerChain, blockLoop, adapterFor, getPinnedEpoch } from './vault/index.js';

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

/** Vault anomaly checks (read-only): code drift, owner change, mandate drift vs the approved grant, revoked/expired/paused, usage beyond caps,
 *  agent deployments recorded beyond what the chain counted, ledger hash chain. Code drift and a broken ledger also BLOCK the autonomy loop. */
export async function monitorVaults(db, { fetchImpl } = {}) {
  const out = [];
  for (const vault of (await listVaults(db)).filter((v) => ['active', 'drift', 'inactive'].includes(v.status))) {
    const id = `vault:${vault.id}`;
    try {
      const net = findNetwork(vault.chain_id); const checks = [];
      const read = await readVault(db, vault, { fetchImpl, force: true });
      if (read.codeChecked && !read.codeOk) await blockLoop(db, `monitor: vault ${vault.id} code differs from the attested build`, { vaultId: vault.id });
      if (!read.state || read.stale) { checks.push(check('vault state readable', false, read.readError ?? 'unreadable')); checks.push(check('vault code == attested AgentVault build', read.codeOk, read.codeChecks.filter((c) => !c.ok).map((c) => c.detail || c.name).join('; '))); }
      else {
        const s = read.state;
        const grant = vault.mandate_decision_id ? parse((await db.get('SELECT payload FROM decisions WHERE id=?', [vault.mandate_decision_id]))?.payload, null) : null;
        checks.push(check('vault code == attested AgentVault build', read.codeOk, read.codeChecks.filter((c) => !c.ok).map((c) => c.detail || c.name).join('; ')));
        checks.push(check('owner unchanged since the approved grant', !grant || String(s.config.owner).toLowerCase() === String(grant.vault.owner).toLowerCase(), s.config.owner));
        checks.push(check('pending ownership transfer', !s.config.pendingOwner, 'a pending transfer is flagged, not failed'));
        checks.push(check('not paused', !s.config.paused, 'a paused vault is an owner/operator signal'));
        if (grant) { const vm = verifyMandate(s, grant, { protocol: net.protocol, adapter: (await adapterFor(net.protocol)).adapter, activatedEpoch: await getPinnedEpoch(db, vault.id) }); checks.push(check('on-chain mandate and templates == approved grant', vm.fieldsOk, vm.checks.filter((c) => !c.ok).map((c) => c.name).join('; '))); checks.push(check('mandate epoch unchanged since activation (else a new approval is required)', vm.epochOk, vm.epochOk ? '' : 'epoch changed: new approval required')); checks.push(check('mandate live (not revoked / expired)', vm.live)); }
        if (s.mandate) {
          checks.push(check('usage within caps', s.usage.totalSpent <= s.mandate.totalCap && s.usage.deploys <= s.mandate.maxDeploys, `spent ${s.usage.totalSpent}/${s.mandate.totalCap}, deploys ${s.usage.deploys}/${s.mandate.maxDeploys}`));
          const seen = Number((await db.get("SELECT COUNT(*) n FROM mandate_runs WHERE vault_id=? AND status='confirmed' AND epoch=?", [vault.id, Number(s.config.epoch)])).n);
          checks.push(check('agent deployments on record <= deployments the chain counted', BigInt(seen) <= s.usage.deploys, `${seen} recorded / ${s.usage.deploys} on-chain this epoch`));
        }
      }
      const chain = await verifyLedgerChain(db);
      checks.push(check('vault ledger hash chain intact', chain.ok, chain.ok ? '' : `broken at ${chain.brokenAt}`));
      if (!chain.ok) await blockLoop(db, `monitor: vault_ledger hash chain broken at row ${chain.brokenAt}`, { vaultId: vault.id });
      const res = { at: now(), ok: checks.every((c) => c.ok), checks };
      await db.run('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', [`monitor:${id}`, j(res)]);
      if (!res.ok) await audit(db, 'monitor', 'vault.anomaly', { id: vault.id, failed: checks.filter((c) => !c.ok) });
      out.push({ id, ...res });
    } catch (e) {
      const res = { at: now(), ok: false, error: e.message, checks: [] };
      await db.run('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', [`monitor:${id}`, j(res)]);
      out.push({ id, ...res });
    }
  }
  return out;
}

export async function monitorDeployments(db, { fetchImpl } = {}) {
  const all = await db.all("SELECT * FROM deployments WHERE status IN ('verified','verified_local') ORDER BY time DESC LIMIT 200");
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
  out.push(...await monitorVaults(db, { fetchImpl }).catch((e) => [{ id: 'vaults', ok: false, error: e.message, checks: [] }]));
  return out;
}
