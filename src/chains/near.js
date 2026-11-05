import { jsonRpc, base58, hexToBytes, check } from './common.js';

/** Verify that a human-signed NEAR deploy transaction is final and deployed exactly the attested wasm. */
export async function verifyNearDeploy({ rpc, txHash, signerId, expectedReceiver, expectedNetworkId, expectedWasmSha256, expectedOwner, expectedProposer, fetchImpl }) {
  const checks = [];
  const tx = await jsonRpc('monitor', rpc, 'tx', { tx_hash: txHash, sender_account_id: signerId, wait_until: 'FINAL' }, { fetchImpl });
  const actions = tx.transaction?.actions ?? [];
  const deploy = actions.find((a) => a.DeployContract);
  const receiver = tx.transaction?.receiver_id;
  const failure = tx.status?.Failure;
  const receiptFailures = (tx.receipts_outcome ?? []).filter((r) => r.outcome?.status?.Failure);
  checks.push(check('no failed receipts inside the transaction', receiptFailures.length === 0, receiptFailures.length ? JSON.stringify(receiptFailures[0].outcome.status.Failure).slice(0, 160) : `${(tx.receipts_outcome ?? []).length} receipts ok`));
  // Action allowlist: exactly one DeployContract, an optional `new` init call, and account setup. Anything else is refused.
  const kinds = actions.map((a) => Object.keys(a)[0]);
  const ALLOWED = new Set(['CreateAccount', 'Transfer', 'AddKey', 'DeployContract', 'FunctionCall']);
  const badKinds = kinds.filter((k) => !ALLOWED.has(k));
  checks.push(check('only allowlisted actions (no DeleteAccount/Stake/DeleteKey/Delegate)', badKinds.length === 0, badKinds.join(',') || kinds.join(',')));
  checks.push(check('exactly one DeployContract', kinds.filter((k) => k === 'DeployContract').length === 1));
  const calls = actions.filter((a) => a.FunctionCall).map((a) => a.FunctionCall.method_name);
  checks.push(check('only the `new` initializer is called', calls.every((m) => m === 'new'), calls.join(',') || 'none'));
  checks.push(check('tx finalized', tx.final_execution_status === 'FINAL', tx.final_execution_status));
  checks.push(check('tx succeeded', !failure && tx.status?.SuccessValue !== undefined, failure ? JSON.stringify(failure).slice(0, 200) : 'SuccessValue'));
  checks.push(check('signer matches', tx.transaction?.signer_id === signerId, tx.transaction?.signer_id));
  checks.push(check('contains DeployContract action', Boolean(deploy)));
  checks.push(check('deployed to the approved contract account', Boolean(expectedReceiver) && receiver === expectedReceiver, `${receiver} vs ${expectedReceiver}`));
  const acct = await jsonRpc('monitor', rpc, 'query', { request_type: 'view_account', finality: 'final', account_id: receiver }, { fetchImpl });
  const expectedHash = base58(hexToBytes(expectedWasmSha256));
  checks.push(check('on-chain code hash == attested wasm sha256', acct.code_hash === expectedHash, `${acct.code_hash} vs ${expectedHash}`));
  try {
    const keys = await jsonRpc('monitor', rpc, 'query', { request_type: 'view_access_key_list', finality: 'final', account_id: receiver }, { fetchImpl });
    const full = (keys.keys ?? []).filter((k) => k.access_key?.permission === 'FullAccess').map((k) => k.public_key);
    // Informational: cannot be judged by code. The human must confirm every full-access key on the contract account is theirs.
    checks.push({ name: 'INFO: full-access keys on contract account (human must confirm each is theirs)', ok: true, detail: full.join(', ') || 'none (account is locked)', info: true });
  } catch (e) { checks.push({ name: 'INFO: access key list unavailable', ok: true, detail: e.message, info: true }); }
  try {
    const r = await jsonRpc('monitor', rpc, 'query', { request_type: 'call_function', finality: 'final', account_id: receiver, method_name: 'config', args_base64: Buffer.from('{}').toString('base64') }, { fetchImpl });
    const cfg = JSON.parse(Buffer.from(r.result).toString());
    if (expectedOwner) checks.push(check('owner matches decision', cfg.owner_id === expectedOwner, cfg.owner_id));
    if (expectedProposer) checks.push(check('proposer matches decision', cfg.proposer_id === expectedProposer, cfg.proposer_id));
    checks.push(check('contract not paused at deploy', cfg.paused === false));
    if (expectedNetworkId) checks.push(check('registry network_id matches the decision network', cfg.network_id === expectedNetworkId, `${cfg.network_id} vs ${expectedNetworkId}`));
  } catch (e) { checks.push(check('config() view callable', false, e.message)); }
  return { ok: checks.every((c) => c.ok), account: receiver, checks, observedAt: Date.now() };
}
