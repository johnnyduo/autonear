// Decisions: one consequential action = one decision = one human approval. Approval is NOT execution:
// the human signs the chain transaction in their own wallet/CLI, and we only record it after verifying it on-chain.
import { sha256, now, j, parse, audit, getBlob } from './db.js';
import { PolicyError, assertDecisionAllowed } from './policy.js';
import { findNetwork } from './protocols.js';
import { verifyNearDeploy } from './chains/near.js';
import { verifyEvmDeploy } from './chains/evm.js';
import { isPaused } from './orchestrator/coordinator.js';
import { adapterFor, adapterProblems, VAULT_REQUIRED_LOOP } from './vault/index.js';
import { formatUnits } from './vault/units.js';

export const CONFIRM_PHRASE = (id) => `approve ${id}`;
/** Who approved this decision, in a form the API/UI can show verbatim. A decision approved by `mandate:<vaultId>:<epoch>` was executed by the
 *  agent under a standing, human-granted mandate: NO human signed that particular deployment. */
export function approvalInfo(d) {
  if (!d?.approver) return null;
  const m = /^mandate:([^:]+):(\d+)(?:\+(.+))?$/.exec(d.approver);
  if (m && m[3]) return { mode: 'mandate', humanSigned: false, humanApproved: true, approvedBy: m[3], vaultId: m[1], epoch: Number(m[2]), approver: d.approver, note: 'The owner approved this request. The agent then published it from its vault, inside the limits the owner set. The owner did not sign the transaction.' };
  if (m) return { mode: 'mandate', humanSigned: false, humanApproved: false, vaultId: m[1], epoch: Number(m[2]), approver: d.approver, note: 'Executed autonomously by the agent under a standing mandate. No human signed this particular deployment.' };
  return { mode: 'human', humanSigned: true, approver: d.approver, note: 'A human approved this decision and signs the on-chain transaction themselves.' };
}
const hydrate = (d) => d && ({ ...d, payload: parse(d.payload, {}), approval: approvalInfo(d) });

export async function listDecisions(db) {
  const rows = await db.all('SELECT * FROM decisions ORDER BY created_at DESC LIMIT 50');
  return rows.map((d) => ({ ...hydrate(d), effectiveStatus: effective(d) }));
}
export async function getDecision(db, id) {
  const d = await db.get('SELECT * FROM decisions WHERE id=?', [id]);
  if (!d) return null;
  const dep = await db.get('SELECT * FROM deployments WHERE decision_id=?', [id]);
  const pay = d.action === 'pay_testnet' ? await db.get('SELECT * FROM payments WHERE decision_id=?', [id]) : undefined;
  return { ...hydrate(d), effectiveStatus: effective(d), confirmPhrase: CONFIRM_PHRASE(d.id), deployment: dep ? { ...dep, verification: parse(dep.verification, {}) } : null, ...(d.action === 'pay_testnet' ? { payment: pay ? { ...pay, verification: parse(pay.verification, {}) } : null } : {}) };
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
  if (!signer || !SIGNER_RE[proto]?.test(signer) || signer.length > 64) throw new PolicyError(`approval must name the ${proto === 'near' ? 'NEAR account id' : 'EVM address'} that will sign the ${d.action === 'grant_mandate' ? 'mandate' : d.action === 'pay_testnet' ? 'payment approval' : 'deployment'}`, 'signer');
  if (d.action === 'grant_mandate') { // a mandate is the vault OWNER's grant: nobody else can be the bound signer
    const owner = parse(d.payload, {})?.vault?.owner;
    if (String(owner).toLowerCase() !== signer.toLowerCase()) throw new PolicyError('a grant_mandate must be approved with the vault OWNER as the signer', 'signer');
  }
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

/**
 * A pay_testnet decision may run under a vault's mandate only if THIS vault's activated grant approved the token and the payee and the amount fits the
 * granted per-payment cap. (The chain re-checks all of it; this keeps a stray or stale request from ever reaching the signer.) Throws PolicyError.
 */
async function assertPayMatchesGrant(db, d, vault) {
  const payload = parse(d.payload, {});
  if (String(payload.vault ?? '').toLowerCase() !== String(vault.address).toLowerCase()) throw new PolicyError('this payment names a different vault', 'state');
  const grant = vault.mandate_decision_id ? parse((await db.get('SELECT payload FROM decisions WHERE id=?', [vault.mandate_decision_id]))?.payload, null) : null;
  const t = grant?.payouts?.tokens?.find((x) => x.token === payload.token);
  if (!t) throw new PolicyError('the owner\'s approved grant for this vault does not include this token: no payment can run', 'state');
  if (!(grant.payouts.payees ?? []).includes(payload.payee)) throw new PolicyError('the owner\'s approved grant for this vault does not include this payee: no payment can run', 'state');
  if (t.decimals !== payload.decimals || t.symbol !== payload.symbol) throw new PolicyError('the token\'s symbol or decimals differ from the approved grant: refusing to pay', 'state');
  if (BigInt(payload.amount) > BigInt(t.perPayCap)) throw new PolicyError(`the amount is above the per-payment cap the owner set (${formatUnits(t.perPayCap, t.decimals)} ${t.symbol})`, 'state');
}

/**
 * Approve a pending deploy_testnet OR pay_testnet decision UNDER A VERIFIED MANDATE (called only by src/autonomy.js). Re-runs every check approveDecision
 * runs except the human-only ones (nonce, typed phrase, human-named signer), then:
 *   - approver = `mandate:<vaultId>:<epoch>`  (the API/UI render this as "no human signed this deployment")
 *   - bound_signer = the vault address (the deployer of record is the vault, which creates the contract via CREATE2/promise batch)
 *   - inserts mandate_runs(decision_id PK): one agent execution per decision, ever; a partial unique index allows one in flight per vault.
 */
export async function approveUnderMandate(db, id, { vault, epoch, byOwner = false }) {
  if (await isPaused(db)) throw new PolicyError('kill switch engaged', 'paused');
  const d = await db.get('SELECT * FROM decisions WHERE id=?', [id]);
  if (!d) throw new PolicyError('unknown decision', 'not_found');
  if (d.action !== 'deploy_testnet' && d.action !== 'pay_testnet') throw new PolicyError(`only deploy_testnet and pay_testnet decisions can run under a mandate (got "${d.action}")`, 'action_blocked');
  // Two entry points. Auto: a pending decision nobody has touched. byOwner: a decision the OWNER already approved (Manual mode's execution step):
  // the human approval is kept in the approver string (`mandate:<vault>:<epoch>+<owner actor>`), so the record never claims the owner signed the tx.
  if (byOwner) {
    if (d.status !== 'approved' || !d.approver || String(d.approver).startsWith('mandate:') || !d.bound_signer) throw new PolicyError('only a decision approved by the owner can be executed this way', 'state');
    if (d.expiry < now()) throw new PolicyError('the approved request has expired: approve it again', 'state');
    if (findNetwork(d.chain_id)?.protocol !== 'near') throw new PolicyError('owner-approved execution through the vault is NEAR only; other networks are signed by the owner', 'action_blocked');
  } else {
    if (effective(d) !== 'pending') throw new PolicyError(`decision is ${effective(d)}, not pending`, 'state');
    if (d.bound_signer || d.approver) throw new PolicyError('decision already has an approver/bound signer: it is left to that human', 'state');
  }
  if (!vault || vault.status !== 'active') throw new PolicyError('vault is not active', 'state');
  if (d.chain_id !== vault.chain_id) throw new PolicyError('decision network differs from the vault network', 'network_blocked');
  const net = findNetwork(d.chain_id);
  if (!net || net.mainnet) throw new PolicyError('mainnet is blocked', 'network_blocked');
  assertDecisionAllowed(d);
  if (sha256(d.payload) !== d.payload_hash) throw new PolicyError('stored payload does not match its hash: refusing to execute', 'payload_hash');
  if (d.action === 'pay_testnet') await assertPayMatchesGrant(db, d, vault);
  if (!Number.isSafeInteger(Number(epoch))) throw new PolicyError('mandate epoch required', 'input');
  const approver = `mandate:${vault.id}:${Number(epoch)}${byOwner ? `+${d.approver}` : ''}`;
  const receipt = sha256(`${d.id}|${d.payload_hash}|${d.nonce}|${approver}|${now()}`);
  const guard = byOwner ? "status='approved' AND approver=? AND bound_signer=?" : "status='pending' AND bound_signer IS NULL AND approver IS NULL";
  try {
    await db.tx(async (tx) => {
      await tx.run("INSERT INTO mandate_runs(decision_id,vault_id,epoch,tx_hash,status,created_at) VALUES(?,?,?,?,?,?)", [id, vault.id, Number(epoch), null, 'claimed', now()]);
      const r = await tx.run(`UPDATE decisions SET status='approved', approver=?, decided_at=?, signed_receipt=?, bound_signer=? WHERE id=? AND ${guard}`, [approver, now(), receipt, vault.address, id, ...(byOwner ? [d.approver, d.bound_signer] : [])]);
      if (!r.changes) throw new PolicyError('decision changed concurrently', 'state');
    });
  } catch (e) {
    if (e instanceof PolicyError) throw e;
    if (/UNIQUE|constraint/i.test(String(e.message))) throw new PolicyError(/mandate_runs\.vault_id|inflight/i.test(String(e.message)) ? d.action === 'pay_testnet' ? 'another agent action is already in flight for this vault' : 'another agent deployment is already in flight for this vault' : 'this decision was already executed (or attempted) by the agent', 'state');
    throw e;
  }
  await audit(db, approver, byOwner ? 'decision.owner_approved_executed_under_mandate' : 'decision.approved_under_mandate', { id, vaultId: vault.id, epoch: Number(epoch), grantDecisionId: vault.mandate_decision_id ?? null, payloadHash: d.payload_hash, signer: vault.address, humanSigned: false, ...(byOwner ? { approvedBy: d.approver, ownerSigner: d.bound_signer } : {}) });
  return getDecision(db, id);
}

/** Return a failed agent attempt's decision to the humans: pending again, unbound, and the mandate run closed as `failed`. Never leaves `approved/executing`. */
export async function releaseToHuman(db, id, reason = '') {
  const d = await db.get('SELECT * FROM decisions WHERE id=?', [id]);
  if (!d) return null;
  if (d.status === 'executed') return d;
  await db.run("UPDATE decisions SET status='pending', approver=NULL, decided_at=NULL, signed_receipt=NULL, bound_signer=NULL WHERE id=? AND status IN ('approved','executing') AND approver LIKE 'mandate:%'", [id]);
  await db.run("UPDATE mandate_runs SET status='failed' WHERE decision_id=? AND status IN ('claimed','submitted')", [id]);
  await audit(db, 'vault', 'decision.released_to_human', { id, reason: String(reason).slice(0, 200) });
  return getDecision(db, id);
}

/** Record a human-signed deployment, only after the chain confirms it matches the approved payload, the bound signer
 *  and the attested artifact. The signer/receiver come from the APPROVED decision, never from the receipt request. */
export async function recordDeployment(db, id, { txHash, fetchImpl, rpcOverride }) {
  const d = await db.get('SELECT * FROM decisions WHERE id=?', [id]);
  if (!d) throw new PolicyError('unknown decision', 'not_found');
  if (d.action !== 'deploy_testnet') throw new PolicyError(`a ${d.action} decision is activated on-chain, not deployed: no deployment can be recorded`, 'state');
  if (await isPaused(db)) throw new PolicyError('kill switch engaged', 'paused');
  const existing = await db.get('SELECT * FROM deployments WHERE decision_id=?', [id]);
  if (existing) { // recover a partial write (deployment row exists but status not advanced)
    if (d.status !== 'executed') await db.run("UPDATE decisions SET status='executed' WHERE id=? AND status IN ('approved','executing')", [id]);
    await db.run("UPDATE mandate_runs SET status='confirmed', tx_hash=COALESCE(tx_hash, ?) WHERE decision_id=? AND status IN ('claimed','submitted')", [existing.transaction_hash, id]);
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
  const viaMandate = String(d.approver ?? '').startsWith('mandate:');
  try {
  if (viaMandate) {
    // Vault path: the agent deployed THROUGH the vault under a mandate. The adapter proves, from the receipt, that the vault created exactly the attested
    // code at the predicted address with the approved owner/proposer, sent by the mandate-bound agent. Same atomic claim below.
    const run = await db.get('SELECT * FROM mandate_runs WHERE decision_id=?', [id]);
    const vault = run ? await db.get('SELECT * FROM vaults WHERE id=?', [run.vault_id]) : null;
    if (!run || !vault || String(vault.address).toLowerCase() !== String(d.bound_signer).toLowerCase()) throw new PolicyError('no mandate run / vault matches this decision', 'state');
    const { adapter, reason } = await adapterFor(net.protocol);
    if (!adapter) throw new PolicyError(reason, 'unavailable');
    const missing = adapterProblems(adapter, VAULT_REQUIRED_LOOP); if (missing.length) throw new PolicyError(`vault adapter incomplete: missing ${missing.join(', ')}`, 'unavailable');
    if (net.protocol === 'evm' && !/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new PolicyError('invalid EVM tx hash', 'input');
    const expected0 = adapter.expectedTemplate({ manifest, payload, vault: vault.address });
    const target = adapter.deployTarget({ decision: d, vault: vault.address, expected: expected0 }); // NEAR: the sub-account name the approved payload names (or a decision-id derived one)
    const expected = { ...expected0, name: expected0.name ?? (net.protocol === 'near' ? target.nameOrSalt : undefined) };
    v = await adapter.verifyDeploy({ net, txHash, vault: vault.address, agent: vault.agent, decision: d, manifest, expected, name: target.nameOrSalt, fetchImpl });
    v = { ...v, via: { kind: 'mandate', vaultId: vault.id, epoch: run.epoch, humanSigned: false } };
  } else if (net.protocol === 'near') {
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
  if (viaMandate) await db.run("UPDATE mandate_runs SET status='confirmed', tx_hash=? WHERE decision_id=?", [txHash, id]);
  await audit(db, 'verifier', 'deployment.recorded', { id, txHash, account: v.account, network: d.chain_id, signer: d.bound_signer, approval: viaMandate ? 'mandate' : 'human' });
  return { recorded: true, verification: v, deployment: { id: depId, account: v.account, explorer } };
}
