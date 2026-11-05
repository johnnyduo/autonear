// Decisions: one consequential action = one decision = one human approval. Approval is NOT execution:
// the human signs the chain transaction in their own wallet/CLI, and we only record it after verifying it on-chain.
import { sha256, now, j, parse, audit, getBlob } from './db.js';
import { PolicyError, assertDecisionAllowed } from './policy.js';
import { findNetwork } from './protocols.js';
import { verifyNearDeploy } from './chains/near.js';
import { verifyEvmDeploy } from './chains/evm.js';
import { isPaused } from './orchestrator/coordinator.js';

export const CONFIRM_PHRASE = (id) => `approve ${id}`;
const hydrate = (d) => d && ({ ...d, payload: parse(d.payload, {}) });

export async function listDecisions(db) {
  const rows = await db.all('SELECT * FROM decisions ORDER BY created_at DESC LIMIT 50');
  return rows.map((d) => ({ ...hydrate(d), effectiveStatus: effective(d) }));
}
export async function getDecision(db, id) {
  const d = await db.get('SELECT * FROM decisions WHERE id=?', [id]);
  if (!d) return null;
  const dep = await db.get('SELECT * FROM deployments WHERE decision_id=?', [id]);
  return { ...hydrate(d), effectiveStatus: effective(d), confirmPhrase: CONFIRM_PHRASE(d.id), deployment: dep ? { ...dep, verification: parse(dep.verification, {}) } : null };
}
const effective = (d) => (d.status === 'pending' && d.expiry < now() ? 'expired' : d.status);

const SIGNER_RE = { near: /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, evm: /^0x[0-9a-fA-F]{40}$/ };

export async function approveDecision(db, id, { nonce, payloadHash, confirm, signer, actor }) {
  if (await isPaused(db)) throw new PolicyError('kill switch engaged', 'paused');
  const d = await db.get('SELECT * FROM decisions WHERE id=?', [id]);
  if (!d) throw new PolicyError('unknown decision', 'not_found');
  if (effective(d) !== 'pending') throw new PolicyError(`decision is ${effective(d)}, not pending`, 'state');
  if (nonce !== d.nonce) throw new PolicyError('nonce mismatch', 'nonce');
  if (payloadHash !== d.payload_hash) throw new PolicyError('payload hash mismatch: the payload you reviewed is not the one stored', 'payload_hash');
  if (confirm !== CONFIRM_PHRASE(id)) throw new PolicyError(`type the exact confirmation phrase: ${CONFIRM_PHRASE(id)}`, 'confirm');
  assertDecisionAllowed(d);
  const proto = findNetwork(d.chain_id)?.protocol;
  if (!signer || !SIGNER_RE[proto]?.test(signer) || signer.length > 64) throw new PolicyError(`approval must name the ${proto === 'near' ? 'NEAR account id' : 'EVM address'} that will sign the deployment`, 'signer');
  const receipt = sha256(`${d.id}|${d.payload_hash}|${d.nonce}|${actor}|${now()}`);
  const r = await db.run("UPDATE decisions SET status='approved', approver=?, decided_at=?, signed_receipt=?, bound_signer=? WHERE id=? AND status='pending'", [actor, now(), receipt, signer, id]);
  if (!r.changes) throw new PolicyError('decision changed concurrently', 'state');
  await audit(db, actor, 'decision.approved', { id, payloadHash, receipt, signer });
  return getDecision(db, id);
}

export async function rejectDecision(db, id, { actor, reason = '' }) {
  const d = await db.get('SELECT * FROM decisions WHERE id=?', [id]);
  if (!d) throw new PolicyError('unknown decision', 'not_found');
  if (!['pending', 'approved'].includes(d.status)) throw new PolicyError(`decision is ${d.status}`, 'state');
  const r = await db.run("UPDATE decisions SET status='rejected', approver=?, decided_at=? WHERE id=? AND status IN ('pending','approved')", [actor, now(), id]);
  if (!r.changes) throw new PolicyError('decision changed concurrently', 'state');
  await audit(db, actor, 'decision.rejected', { id, reason: String(reason).slice(0, 200) });
  return getDecision(db, id);
}

/** Record a human-signed deployment, only after the chain confirms it matches the approved payload, the bound signer
 *  and the attested artifact. The signer/receiver come from the APPROVED decision, never from the receipt request. */
export async function recordDeployment(db, id, { txHash, fetchImpl, rpcOverride }) {
  const d = await db.get('SELECT * FROM decisions WHERE id=?', [id]);
  if (!d) throw new PolicyError('unknown decision', 'not_found');
  if (await isPaused(db)) throw new PolicyError('kill switch engaged', 'paused');
  const existing = await db.get('SELECT * FROM deployments WHERE decision_id=?', [id]);
  if (existing) { // recover a partial write (deployment row exists but status not advanced)
    if (d.status !== 'executed') await db.run("UPDATE decisions SET status='executed' WHERE id=? AND status IN ('approved','executing')", [id]);
    return { recorded: true, idempotent: true, deployment: { id: existing.id, account: existing.account, explorer: existing.explorer_url }, verification: parse(existing.verification, {}) };
  }
  if (d.status !== 'approved') throw new PolicyError('decision is not approved: no deployment can be recorded', 'state');
  if (!d.bound_signer) throw new PolicyError('decision has no bound signer', 'signer');
  const payload = parse(d.payload, {});
  const net = findNetwork(d.chain_id);
  if (!net || net.mainnet) throw new PolicyError('mainnet is blocked', 'network_blocked');
  const att = await db.get('SELECT * FROM artifacts WHERE hash=? AND kind LIKE ?', [d.artifact_hash, 'contract-build:%']);
  if (!att) throw new PolicyError('attested artifact for this decision not found', 'artifact');
  const manifest = parse(await getBlob(db, att.immutable_ref), {});
  const rpc = rpcOverride ?? net.rpc;
  let v;
  try {
  if (net.protocol === 'near') {
    if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(txHash)) throw new PolicyError('invalid NEAR tx hash', 'input');
    v = await verifyNearDeploy({ rpc, txHash, signerId: d.bound_signer, expectedReceiver: payload.registry.contractAccount, expectedNetworkId: d.chain_id === 'near-testnet' ? 'testnet' : 'mainnet', expectedWasmSha256: manifest.sha256, expectedOwner: payload.registry.owner, expectedProposer: payload.registry.proposer, fetchImpl });
  } else {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new PolicyError('invalid EVM tx hash', 'input');
    v = await verifyEvmDeploy({ rpc, chainId: net.chainId, txHash, expectedDeployer: d.bound_signer, expectedDeployedBytecode: manifest.deployedBytecode, expectedOwner: payload.registry.owner, expectedProposer: payload.registry.proposer, fetchImpl });
  }
  } catch (e) {
    if (e instanceof PolicyError) throw e;
    // Unknown tx, RPC error or unreachable node: a verification failure, never a 500 and never recorded.
    v = { ok: false, account: null, checks: [{ name: 'transaction found and verifiable on this network', ok: false, detail: String(e.message).slice(0, 240) }], observedAt: now() };
  }
  if (!v.ok) { await audit(db, 'verifier', 'deployment.rejected', { id, txHash, failed: v.checks.filter((c) => !c.ok) }); return { recorded: false, verification: v }; }
  // Atomic claim: only one concurrent request can move approved -> executing.
  const claim = await db.run("UPDATE decisions SET status='executing' WHERE id=? AND status='approved'", [id]);
  if (!claim.changes) throw new PolicyError('decision changed concurrently', 'state');
  const depId = 'dep_' + sha256(txHash).slice(0, 14);
  const explorer = net.explorer ? net.explorer + txHash : '';
  try {
    await db.run('INSERT INTO deployments(id,decision_id,network,account,artifact_hash,transaction_hash,explorer_url,time,status,verification) VALUES(?,?,?,?,?,?,?,?,?,?)',
      [depId, id, d.chain_id, v.account, d.artifact_hash, txHash, explorer, now(), net.local ? 'verified_local' : 'verified', j(v)]);
  } catch (e) {
    await db.run("UPDATE decisions SET status='approved' WHERE id=? AND status='executing'", [id]);
    if (/UNIQUE|constraint/i.test(String(e.message))) throw new PolicyError('this transaction hash is already recorded for another decision', 'state');
    throw e;
  }
  await db.run("UPDATE decisions SET status='executed' WHERE id=? AND status='executing'", [id]);
  await audit(db, 'verifier', 'deployment.recorded', { id, txHash, account: v.account, network: d.chain_id, signer: d.bound_signer });
  return { recorded: true, verification: v, deployment: { id: depId, account: v.account, explorer } };
}
