// Token payouts, backend half (phase 2b-1): create a `pay_testnet` decision from a request, list payments, and record a payment ONLY after the chain
// proves it. Nothing here signs: the agent signs `pay` through the vault in the autonomy loop (phase 2b-2), under the owner's on-chain limits.
//
//   POST /api/payments  -> createPayment   a pending pay_testnet decision (the owner approves it in Approvals; Manual waits for that, Auto may run it)
//   GET  /api/payments  -> listPayments
//   recordPayment       -> verifies the transaction through adapter.verifyPay, then atomically inserts `payments` + marks the decision executed
import { sha256, now, j, parse, audit } from './db.js';
import { PolicyError, assertDecisionAllowed, MAX_PAY_MEMO_BYTES } from './policy.js';
import { findNetwork } from './protocols.js';
import { isPaused } from './orchestrator/coordinator.js';
import { adapterFor, listVaults, readVault } from './vault/index.js';
import { getDecision } from './decisions.js';
import { formatUnits } from './vault/units.js';

const CHAIN = 'near-testnet';
const DEC = /^(0|[1-9][0-9]{0,77})$/;
const bytesOf = (t) => new TextEncoder().encode(t).length;
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const isAccount = (a) => typeof a === 'string' && a.length >= 2 && a.length <= 64 && ACCOUNT_RE.test(a);

/** Plain-language amount: "25 USDC". */
export const showAmount = (amount, decimals, symbol) => `${formatUnits(amount, decimals)} ${symbol}`;

/**
 * Create a pending pay_testnet decision.
 * input = { token, payee, amount (base units, decimal string or integer), memo? , reference?, vault? (address; needed only when several NEAR vaults are active) }
 * symbol and decimals are NEVER taken from the request: they come from the vault's approved grant (which read them from the token's ft_metadata).
 * Early, friendly checks against the vault's cached chain state: the token and the payee are on the on-chain allowlist and amount <= the on-chain per-payment cap.
 * The chain enforces all of it again when the agent calls `pay`. -> the decision (getDecision shape) + { created }
 */
export async function createPayment(db, input, { fetchImpl, actor = 'operator', maxAgeMs, redact } = {}) {
  const bad = (m, code = 'input') => { throw new PolicyError(m, code); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('the payment request must be an object');
  for (const k of Object.keys(input)) if (!['token', 'payee', 'amount', 'memo', 'reference', 'vault'].includes(k)) bad(`unexpected field "${k.slice(0, 40)}" (symbol and decimals are read from the token, never from the request)`);
  const token = input.token; const payee = input.payee;
  if (!isAccount(token)) bad('token must be the token contract\'s NEAR account id');
  if (!isAccount(payee)) bad('payee must be a NEAR account id');
  const amount = typeof input.amount === 'number' && Number.isSafeInteger(input.amount) ? String(input.amount) : input.amount;
  if (typeof amount !== 'string' || !DEC.test(amount) || BigInt(amount) <= 0n) bad('amount must be a positive whole number in the token\'s smallest unit (a decimal string)');
  const memo = input.memo === undefined || input.memo === null ? '' : input.memo;
  if (typeof memo !== 'string' || bytesOf(memo) > MAX_PAY_MEMO_BYTES) bad(`memo must be text of at most ${MAX_PAY_MEMO_BYTES} bytes`);
  if (input.reference !== undefined && (typeof input.reference !== 'string' || bytesOf(input.reference) > MAX_PAY_MEMO_BYTES)) bad(`reference must be text of at most ${MAX_PAY_MEMO_BYTES} bytes`);

  const net = findNetwork(CHAIN);
  if (!net || net.mainnet) throw new PolicyError('mainnet is blocked', 'network_blocked');
  // which vault: the one named, else the only active NEAR testnet vault
  const vaults = (await listVaults(db)).filter((v) => v.chain_id === CHAIN && (input.vault === undefined || v.address === input.vault));
  if (input.vault !== undefined && !vaults.length) bad('that vault is not attached to this server', 'not_found');
  const active = vaults.filter((v) => v.status === 'active');
  if (!active.length) bad(vaults.length ? 'the vault is not active yet: finish the owner\'s grant steps first' : 'no vault is attached on NEAR testnet', 'state');
  if (active.length > 1) bad('more than one vault is active: name the vault in the request ("vault")');
  const vault = active[0];
  const grant = vault.mandate_decision_id ? parse((await db.get('SELECT payload FROM decisions WHERE id=?', [vault.mandate_decision_id]))?.payload, null) : null;
  const gt = grant?.payouts?.tokens?.find((t) => t.token === token);
  if (!grant?.payouts) bad('this vault\'s approved grant has no token payouts', 'state');
  if (!gt) bad(`${token} is not one of the tokens the owner approved for this vault`, 'state');
  if (!grant.payouts.payees.includes(payee)) bad(`${payee} is not one of the payees the owner approved for this vault`, 'state');

  // the vault's cached chain state: the allowlist and the per-payment cap as they are on chain right now
  const read = await readVault(db, vault, { fetchImpl, maxAgeMs, redact });
  if (!read.state || read.stale) bad(`the vault could not be read just now (${read.readError ?? 'no state'}): try again in a moment`, 'unavailable');
  if (!read.state.payouts) bad('the vault on chain is not the payouts build', 'state');
  const onChain = read.state.payouts.tokens.find((t) => t.token === token);
  if (!onChain) bad(`${gt.symbol} is not on the vault's on-chain allowlist (the owner has not finished allow_token, or removed it)`, 'state');
  if (!read.state.payouts.payees.includes(payee)) bad(`${payee} is not on the vault's on-chain payee list (the owner has not finished allow_payee, or removed it)`, 'state');
  if (BigInt(amount) > onChain.perPayCap) bad(`${showAmount(amount, gt.decimals, gt.symbol)} is above the per-payment cap on chain (${showAmount(onChain.perPayCap, gt.decimals, gt.symbol)})`, 'state');

  const payload = {
    action: 'pay_testnet', protocol: 'near', network: CHAIN, vault: vault.address, token, symbol: gt.symbol, decimals: gt.decimals,
    payee, amount, memo, ...(input.reference !== undefined ? { reference: input.reference } : {}),
  };
  const d = { action: 'pay_testnet', chain_id: CHAIN, target: vault.address, method: 'pay', max_spend: amount, expiry: now() + 24 * 36e5 };
  assertDecisionAllowed({ ...d, payload: j(payload) });
  const payloadJson = j(payload); const payloadHash = sha256(payloadJson);
  const dup = await db.get("SELECT id FROM decisions WHERE action='pay_testnet' AND payload_hash=? AND status='pending' AND expiry>?", [payloadHash, now()]);
  if (dup) return { ...(await getDecision(db, dup.id)), created: false };
  const id = 'dec_' + sha256(`pay|${vault.id}|${payloadHash}|${now()}`).slice(0, 14);
  const nonce = sha256(`${id}|${now()}|${Math.random()}`).slice(0, 24);
  await db.run(`INSERT INTO decisions(id,run_id,artifact_hash,action,chain_id,target,method,max_spend,expiry,nonce,payload,payload_hash,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`,
    [id, null, vault.attested_ref ?? '0'.repeat(64), d.action, d.chain_id, d.target, d.method, d.max_spend, d.expiry, nonce, payloadJson, payloadHash, now()]);
  await audit(db, actor, 'decision.proposed', { id, action: 'pay_testnet', vaultId: vault.id, payloadHash, token, payee, amount, symbol: gt.symbol });
  return { ...(await getDecision(db, id)), created: true };
}

/** Plain-words summary of a pay_testnet payload: "Pay 25 USDC to alice.testnet for invoice 12". */
export function describePayment(p) {
  return `Pay ${showAmount(p.amount, p.decimals, p.symbol)} to ${p.payee}${p.memo ? ` for ${p.memo}` : ''}`;
}

/** GET /api/payments: the 50 newest payment requests (any status) with the verified payment row, when there is one. */
export async function listPayments(db, { limit = 50 } = {}) {
  const rows = await db.all("SELECT * FROM decisions WHERE action='pay_testnet' ORDER BY created_at DESC LIMIT ?", [limit]);
  const net = findNetwork(CHAIN);
  const items = [];
  for (const d of rows) {
    const p = parse(d.payload, {});
    const pay = await db.get('SELECT * FROM payments WHERE decision_id=?', [d.id]);
    items.push({
      decisionId: d.id, status: d.status, effectiveStatus: d.status === 'pending' && d.expiry < now() ? 'expired' : d.status,
      vault: p.vault, token: p.token, symbol: p.symbol, decimals: p.decimals, payee: p.payee, amount: p.amount, amountDisplay: showAmount(p.amount ?? '0', p.decimals ?? 0, p.symbol ?? ''),
      memo: p.memo ?? '', ...(p.reference !== undefined ? { reference: p.reference } : {}), summary: describePayment(p),
      createdAt: d.created_at, expiry: d.expiry, approver: d.approver ?? null,
      payment: pay ? { id: pay.id, txHash: pay.tx_hash, status: pay.status, explorerUrl: net?.explorer ? `${net.explorer}${pay.tx_hash}` : '', recordedAt: pay.created_at, verification: parse(pay.verification, {}) } : null,
    });
  }
  return { items };
}

/**
 * Record a payment, only after the chain confirms it matches the APPROVED decision: the token, payee and amount come from the stored payload, the sender is the
 * mandate-bound agent of the vault that ran it, never from this call. Idempotent per decision; one chain transaction can prove only one payment.
 * -> { recorded: true, payment, verification, idempotent? } | { recorded: false, verification, payFailed } (nothing is written when verification fails)
 */
export async function recordPayment(db, decisionId, { txHash, fetchImpl } = {}) {
  const d = await db.get('SELECT * FROM decisions WHERE id=?', [decisionId]);
  if (!d) throw new PolicyError('unknown decision', 'not_found');
  if (d.action !== 'pay_testnet') throw new PolicyError(`a ${d.action} decision is not a payment: nothing to record`, 'state');
  if (await isPaused(db)) throw new PolicyError('kill switch engaged', 'paused');
  const existing = await db.get('SELECT * FROM payments WHERE decision_id=?', [decisionId]);
  if (existing) { // recover a partial write (payment row exists but the decision / run were not advanced)
    if (txHash !== undefined && txHash !== existing.tx_hash) throw new PolicyError('a different transaction is already recorded for this payment', 'state');
    if (d.status !== 'executed') await db.run("UPDATE decisions SET status='executed' WHERE id=? AND status IN ('approved','executing')", [decisionId]);
    await db.run("UPDATE mandate_runs SET status='confirmed', tx_hash=COALESCE(tx_hash, ?) WHERE decision_id=? AND status IN ('claimed','submitted')", [existing.tx_hash, decisionId]);
    return { recorded: true, idempotent: true, payment: { id: existing.id, txHash: existing.tx_hash, vaultId: existing.vault_id }, verification: parse(existing.verification, {}) };
  }
  if (d.status !== 'approved') throw new PolicyError('decision is not approved: no payment can be recorded', 'state');
  if (!String(d.approver ?? '').startsWith('mandate:')) throw new PolicyError('only a payment the agent sent through the vault under the mandate can be recorded', 'state');
  if (typeof txHash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(txHash)) throw new PolicyError('invalid NEAR tx hash', 'input');
  const other = await db.get('SELECT decision_id FROM payments WHERE tx_hash=?', [txHash]);
  if (other) throw new PolicyError('this transaction hash is already recorded for another payment', 'state');
  const net = findNetwork(d.chain_id);
  if (!net || net.mainnet) throw new PolicyError('mainnet is blocked', 'network_blocked');
  const payload = parse(d.payload, {});
  const run = await db.get('SELECT * FROM mandate_runs WHERE decision_id=?', [decisionId]);
  const vault = run ? await db.get('SELECT * FROM vaults WHERE id=?', [run.vault_id]) : null;
  if (!run || !vault || String(vault.address).toLowerCase() !== String(d.bound_signer).toLowerCase() || String(vault.address).toLowerCase() !== String(payload.vault ?? '').toLowerCase()) throw new PolicyError('no mandate run / vault matches this payment', 'state');
  const { adapter, reason } = await adapterFor(net.protocol);
  if (!adapter) throw new PolicyError(reason, 'unavailable');
  if (typeof adapter.verifyPay !== 'function') throw new PolicyError('vault adapter incomplete: missing verifyPay', 'unavailable');
  let v;
  try {
    v = await adapter.verifyPay({ net, txHash, vault: vault.address, agent: vault.agent, token: payload.token, to: payload.payee, amount: payload.amount, memo: payload.memo, fetchImpl });
    v = { ...v, via: { kind: 'mandate', vaultId: vault.id, epoch: run.epoch, humanSigned: false } };
  } catch (e) {
    // Unknown tx, RPC error or unreachable node: a verification failure, never a 500 and never recorded.
    v = { ok: false, checks: [{ name: 'transaction found and verifiable on this network', ok: false, detail: String(e.message).slice(0, 240) }], observedAt: now() };
  }
  if (!v.ok) {
    await audit(db, 'verifier', 'payment.rejected', { id: decisionId, txHash, failed: (v.checks ?? []).filter((c) => !c.ok).map((c) => ({ name: c.name, detail: c.detail })) });
    return { recorded: false, verification: v, payFailed: (v.checks ?? []).some((c) => !c.ok && /pay_failed/.test(c.name)) };
  }
  // Atomic claim: only one concurrent request can move approved -> executing.
  const claim = await db.run("UPDATE decisions SET status='executing' WHERE id=? AND status='approved'", [decisionId]);
  if (!claim.changes) throw new PolicyError('decision changed concurrently', 'state');
  const payId = 'pay_' + sha256(txHash).slice(0, 14);
  try {
    await db.run('INSERT INTO payments(id,decision_id,vault_id,token,payee,amount,tx_hash,status,verification,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      [payId, decisionId, vault.id, payload.token, payload.payee, payload.amount, txHash, net.local ? 'verified_local' : 'verified', j(v), now()]);
  } catch (e) {
    await db.run("UPDATE decisions SET status='approved' WHERE id=? AND status='executing'", [decisionId]);
    if (/UNIQUE|constraint/i.test(String(e.message))) throw new PolicyError('this transaction hash is already recorded for another payment', 'state');
    throw e;
  }
  await db.run("UPDATE decisions SET status='executed' WHERE id=? AND status='executing'", [decisionId]);
  await db.run("UPDATE mandate_runs SET status='confirmed', tx_hash=? WHERE decision_id=?", [txHash, decisionId]);
  await audit(db, 'verifier', 'payment.recorded', { id: decisionId, txHash, vaultId: vault.id, token: payload.token, payee: payload.payee, amount: payload.amount, network: d.chain_id, approval: 'mandate' });
  return { recorded: true, payment: { id: payId, txHash, vaultId: vault.id }, verification: v };
}
