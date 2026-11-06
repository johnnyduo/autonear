// Manual mode's execution step: a deploy the OWNER approved is run by the agent through the vault. State machine only (no chain):
// the loop-level behaviour on EVM is covered in tests/autonomy.test.js, NEAR on a sandbox/testnet is not covered by npm test.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { memDb } from './helpers.js';
import { sha256, now } from '../src/db.js';
import { approveDecision, approveUnderMandate, approvalInfo, releaseToHuman } from '../src/decisions.js';

const OWNER = '0x5ebaddf71482d44991923be1fc42938129988000'.slice(0, 42);
const payload = JSON.stringify({ action: 'deploy_testnet', protocol: 'near', network: 'testnet', registry: { owner: OWNER, proposer: 'agent', contractAccount: 'reg1.vault.testnet' } });
const VAULT = { id: 'vlt_1', chain_id: 'near-testnet', address: 'vault.testnet', status: 'active' };

async function mkDecision(db, id, over = {}) {
  await db.run("INSERT INTO decisions(id,run_id,artifact_hash,action,chain_id,target,method,max_spend,expiry,nonce,payload,payload_hash,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [id, null, 'h', over.action ?? 'deploy_testnet', over.chain ?? 'near-testnet', 'reg1.vault.testnet', 'deploy', '0', over.expiry ?? now() + 3600_000, `n_${id}`, payload, sha256(payload), 'pending', now()]);
  return db.get('SELECT * FROM decisions WHERE id=?', [id]);
}
const ownerApprove = (db, d) => approveDecision(db, d.id, { nonce: d.nonce, payloadHash: d.payload_hash, confirm: `approve ${d.id}`, signer: OWNER, actor: `owner:${OWNER}` });

describe('owner-approved execution through the vault', () => {
  test('claims an owner-approved NEAR deploy, keeps the human approval in the record, and says the owner did not sign', async () => {
    const db = await memDb(); const d = await mkDecision(db, 'dec_a'); await ownerApprove(db, d);
    const r = await approveUnderMandate(db, d.id, { vault: VAULT, epoch: 2, byOwner: true });
    assert.equal(r.status, 'approved'); assert.equal(r.approver, `mandate:vlt_1:2+owner:${OWNER}`); assert.equal(r.bound_signer, 'vault.testnet');
    assert.equal(r.approval.humanApproved, true); assert.equal(r.approval.humanSigned, false); assert.equal(r.approval.approvedBy, `owner:${OWNER}`); assert.match(r.approval.note, /did not sign/);
    assert.equal((await db.get('SELECT COUNT(*) n FROM mandate_runs WHERE decision_id=?', [d.id])).n, 1);
    const a = await db.get("SELECT detail FROM audit WHERE action='decision.owner_approved_executed_under_mandate'"); assert.match(a.detail, new RegExp(OWNER));
  });
  test('only one execution per decision, ever', async () => {
    const db = await memDb(); const d = await mkDecision(db, 'dec_b'); await ownerApprove(db, d);
    await approveUnderMandate(db, d.id, { vault: VAULT, epoch: 1, byOwner: true });
    await assert.rejects(approveUnderMandate(db, d.id, { vault: VAULT, epoch: 1, byOwner: true }), (e) => e.code === 'state');
  });
  test('a pending (unapproved) decision cannot take the owner path, and an owner-approved one cannot take the Auto path', async () => {
    const db = await memDb(); const p = await mkDecision(db, 'dec_c');
    await assert.rejects(approveUnderMandate(db, p.id, { vault: VAULT, epoch: 1, byOwner: true }), (e) => e.code === 'state');
    const q = await mkDecision(db, 'dec_d'); await ownerApprove(db, q);
    await assert.rejects(approveUnderMandate(db, q.id, { vault: VAULT, epoch: 1 }), (e) => e.code === 'state');
  });
  test('refuses an expired approval, another network, an inactive vault, and EVM decisions (the owner signs those)', async () => {
    const db = await memDb();
    const e = await mkDecision(db, 'dec_e', { expiry: now() + 1000 }); await ownerApprove(db, e); await db.run('UPDATE decisions SET expiry=? WHERE id=?', [now() - 1, e.id]);
    await assert.rejects(approveUnderMandate(db, e.id, { vault: VAULT, epoch: 1, byOwner: true }), /expired/);
    const f = await mkDecision(db, 'dec_f'); await ownerApprove(db, f);
    await assert.rejects(approveUnderMandate(db, f.id, { vault: { ...VAULT, chain_id: 'near-mainnet' }, epoch: 1, byOwner: true }), (x) => x.code === 'network_blocked');
    await assert.rejects(approveUnderMandate(db, f.id, { vault: { ...VAULT, status: 'paused' }, epoch: 1, byOwner: true }), /not active/);
    await db.run("UPDATE decisions SET chain_id='evm:84532' WHERE id=?", [f.id]);
    await assert.rejects(approveUnderMandate(db, f.id, { vault: { ...VAULT, chain_id: 'evm:84532' }, epoch: 1, byOwner: true }), /NEAR only|allowed|blocked/);
  });
  test('refuses when the stored payload no longer matches its hash', async () => {
    const db = await memDb(); const d = await mkDecision(db, 'dec_g'); await ownerApprove(db, d);
    await db.run("UPDATE decisions SET payload=? WHERE id=?", [payload.replace('reg1', 'evil'), d.id]);
    await assert.rejects(approveUnderMandate(db, d.id, { vault: VAULT, epoch: 1, byOwner: true }), (x) => x.code === 'payload_hash');
  });
  test('a failed agent attempt goes back to pending and unbound: the owner must approve again', async () => {
    const db = await memDb(); const d = await mkDecision(db, 'dec_h'); await ownerApprove(db, d);
    await approveUnderMandate(db, d.id, { vault: VAULT, epoch: 1, byOwner: true });
    const r = await releaseToHuman(db, d.id, 'deploy failed');
    assert.equal(r.status, 'pending'); assert.equal(r.approver, null); assert.equal(r.bound_signer, null);
    assert.equal((await db.get('SELECT status FROM mandate_runs WHERE decision_id=?', [d.id])).status, 'failed');
  });
  test('approvalInfo: plain mandate vs owner-approved vs human', () => {
    assert.equal(approvalInfo({ approver: 'mandate:v:3' }).humanApproved, false);
    assert.equal(approvalInfo({ approver: 'mandate:v:3+owner:0xabc' }).approvedBy, 'owner:0xabc');
    assert.equal(approvalInfo({ approver: 'owner:0xabc' }).humanSigned, true);
  });
});
