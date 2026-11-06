// FIXTURE DATA - NOT A REAL VAULT. Loaded ONLY by a dynamic import() from views/vault/Vault.jsx when the hash carries `fixture=1`.
// Everything here is invented for design review and screenshots: every address, hash and amount starts with the visible marker
// `f1c7` (or is plainly labelled), no transaction exists on any chain, and the UI blocks every mutation while this data is shown.
// Scenarios (hash query `scenario=`): default | blocked | paused | idle | empty | worker | loading | error | grant-pending | grant-approved | grant-partial | grant-verified | grant-tampered

const MIN = 60_000; const HR = 60 * MIN; const DAY = 24 * HR;
const pad = (n, w = 4) => n.toString(16).padStart(w, '0');
const addr = (i) => `0x${'f1c7'.repeat(9)}${pad(i)}`;                  // 0x + 40 hex, all "f1c7" noise
const b32 = (i) => `0x${'f1c7'.repeat(15)}${pad(i)}`;                  // 0x + 64 hex
const hsh = (i) => `${pad(i)}${'f1c7'.repeat(15)}`;
const ETH = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;           // 1e6 resolution is enough for fixtures
const NEAR = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 18n;
const S = (b) => b.toString();
const USDC = (x) => BigInt(Math.round(x * 1e6)); // the demo token has 6 decimals

// ---- tiny ABI encoder (fixture calldata for the plan; mirrors the decoder in views/vault/decode.js so the review UI is exercised for real) ----
const w = (hex) => hex.replace(/^0x/, '').padStart(64, '0');
const u = (n) => w(BigInt(n).toString(16));
const A = (a) => w(a.toLowerCase());
const SEL = { setMandate: '0x2fe8e348', allowTemplate: '0x6214a32f' };
const encSetMandate = (m) => `${SEL.setMandate}${A(m.agent)}${u(m.expiresAt)}${u(m.perDrawCap)}${u(m.periodSecs)}${u(m.periodCap)}${u(m.totalCap)}${u(m.maxDeploys)}`;
function encAllow(id, label, deposit) {
  const hex = [...new TextEncoder().encode(label)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${SEL.allowTemplate}${w(id)}${u(96)}${u(deposit)}${u(label.length)}${hex.padEnd(Math.ceil(hex.length / 64) * 64, '0')}`;
}

export function buildFixture(scenario = 'default', now = Date.now()) {
  if (scenario === 'loading') return { mode: 'loading', at: now };
  if (scenario === 'error') return { mode: 'error', at: now };
  const sec = (ms) => Math.floor(ms / 1000);
  const grantStage = scenario.startsWith('grant-') ? scenario.slice(6) : 'approved';

  const AGENT = addr(0xa1); const OWNER = addr(0xb1);
  const unitEth = { symbol: 'ETH', base: 'wei', decimals: 18 }; const unitNear = { symbol: 'NEAR', base: 'yoctoNEAR', decimals: 24 };

  const vA = { id: 'vault_fx_a', chainId: 'evm:84532', network: 'Base Sepolia', address: addr(0xa0), owner: OWNER, paused: false, codeOk: true, unit: unitEth,
    mandate: { agent: AGENT, expiresAt: sec(now + 6 * DAY + 4 * HR), perDrawCap: S(ETH(0.005)), periodSecs: 3600, periodCap: S(ETH(0.015)), totalCap: S(ETH(0.1)), maxDeploys: 5, revoked: false, epoch: 3 },
    usage: { totalSpent: S(ETH(0.0235)), periodSpent: S(ETH(0.0045)), deploys: 2, periodResetsAt: sec(now + 41 * MIN + 12_000) },
    budget: { maxDraw: S(ETH(0.005)), remainingPeriod: S(ETH(0.0105)), remainingTotal: S(ETH(0.0765)), remainingDeploys: 3, blocked: '' },
    available: S(ETH(0.0765)), agentBalance: S(ETH(0.0031)),
    templates: [{ id: b32(0x11), label: 'registry-v1 (attested)', deposit: '0', artifactHash: `sha256:${hsh(0x71)}`, matches: true }, { id: b32(0x12), label: 'registry-v2-draft', deposit: '0', artifactHash: null, matches: false }],
    readAt: now - 4000, readError: null, mandateDecisionId: 'dec_fx_grant_a' };
  const vB = { id: 'vault_fx_b', chainId: 'near-testnet', network: 'NEAR testnet', address: 'fx-vault-b.fixture.testnet', owner: 'fx-owner.fixture.testnet', paused: false, codeOk: true, unit: unitNear,
    mandate: { agent: 'fx-agent.fixture.testnet', expiresAt: sec(now + 19 * HR), perDrawCap: S(NEAR(0.5)), periodSecs: 86400, periodCap: S(NEAR(2)), totalCap: S(NEAR(10)), maxDeploys: 3, revoked: false, epoch: 1 },
    usage: { totalSpent: S(NEAR(9.4)), periodSpent: S(NEAR(1.9)), deploys: 3, periodResetsAt: sec(now + 5 * HR + 12 * MIN) },
    budget: { maxDraw: S(NEAR(0.1)), remainingPeriod: S(NEAR(0.1)), remainingTotal: S(NEAR(0.6)), remainingDeploys: 0, blocked: '' },
    available: S(NEAR(0.8)), agentBalance: S(NEAR(0.12)),
    templates: [{ id: `${hsh(0x21)}`, label: 'registry-v1 (wasm)', deposit: S(NEAR(5)), artifactHash: `sha256:${hsh(0x72)}`, matches: true }],
    readAt: now - 6000, readError: null, mandateDecisionId: 'dec_fx_grant_b' };
  // The demo vault that can pay people (the payouts build). A mock USDC token on testnet, two payees, one payment made and one waiting for the owner.
  const TOKEN = 'mock-usdc.fixture.testnet'; const PAYEE_A = 'alice.fixture.testnet'; const PAYEE_B = 'bob-design-studio.fixture.testnet';
  const vP = { id: 'vault_fx_p', chainId: 'near-testnet', network: 'NEAR testnet', address: 'fx-pay-vault.fixture.testnet', owner: 'fx-owner.fixture.testnet', status: 'active', build: 'pay', paused: false, codeOk: true, unit: unitNear,
    mandate: { agent: 'fx-agent.fixture.testnet', expiresAt: sec(now + 6 * DAY), perDrawCap: S(NEAR(0.5)), periodSecs: 86400, periodCap: S(NEAR(2)), totalCap: S(NEAR(10)), maxDeploys: 3, revoked: false, epoch: 1 },
    usage: { totalSpent: S(NEAR(1.2)), periodSpent: S(NEAR(0.3)), deploys: 1, periodResetsAt: sec(now + 9 * HR) },
    budget: { maxDraw: S(NEAR(0.5)), remainingPeriod: S(NEAR(1.7)), remainingTotal: S(NEAR(8.8)), remainingDeploys: 2, blocked: '' },
    available: S(NEAR(4.5)), agentBalance: S(NEAR(0.9)), templates: [{ id: `${hsh(0x23)}`, label: 'registry-v1 (wasm)', deposit: S(NEAR(5)), artifactHash: `sha256:${hsh(0x72)}`, matches: true }],
    payouts: {
      tokens: [{ token: TOKEN, symbol: 'USDC', decimals: 6, perPayCap: S(USDC(100)), periodCap: S(USDC(250)), totalCap: S(USDC(1000)), usage: { totalSpent: S(USDC(325)), periodSpent: S(USDC(75)) }, remaining: { period: S(USDC(175)), total: S(USDC(675)), maxPayment: S(USDC(100)) }, balance: S(USDC(480.5)), matches: true }],
      payees: [{ account: PAYEE_A, matches: true }, { account: PAYEE_B, matches: true }],
    },
    readAt: now - 5000, readError: null, mandateDecisionId: 'dec_fx_grant_p' };
  const vC = { id: 'vault_fx_c', chainId: 'evm:421614', network: 'Arbitrum Sepolia', address: addr(0xc0), owner: OWNER, paused: false, codeOk: true, unit: unitEth,
    mandate: { agent: AGENT, expiresAt: sec(now - 3 * HR), perDrawCap: S(ETH(0.004)), periodSecs: 3600, periodCap: S(ETH(0.01)), totalCap: S(ETH(0.05)), maxDeploys: 2, revoked: false, epoch: 2 },
    usage: { totalSpent: S(ETH(0.031)), periodSpent: 0, deploys: 1, periodResetsAt: sec(now - 2 * HR) },
    budget: { maxDraw: '0', remainingPeriod: S(ETH(0.01)), remainingTotal: S(ETH(0.019)), remainingDeploys: 1, blocked: 'MandateInactive' },
    available: S(ETH(0.019)), agentBalance: S(ETH(0.0004)),
    templates: [{ id: b32(0x31), label: 'registry-v1 (attested)', deposit: '0', artifactHash: `sha256:${hsh(0x71)}`, matches: true }],
    readAt: now - 5000, readError: null, mandateDecisionId: 'dec_fx_grant_c' };
  const vD = { id: 'vault_fx_d', chainId: 'evm:11155420', network: 'OP Sepolia', address: addr(0xd0), owner: OWNER, paused: false, codeOk: false, unit: unitEth,
    mandate: { agent: AGENT, expiresAt: sec(now + 2 * DAY), perDrawCap: S(ETH(0.005)), periodSecs: 3600, periodCap: S(ETH(0.01)), totalCap: S(ETH(0.05)), maxDeploys: 2, revoked: false, epoch: 1 },
    usage: { totalSpent: '0', periodSpent: '0', deploys: 0, periodResetsAt: sec(now + 30 * MIN) },
    budget: { maxDraw: S(ETH(0.005)), remainingPeriod: S(ETH(0.01)), remainingTotal: S(ETH(0.05)), remainingDeploys: 2, blocked: '' },
    available: S(ETH(0.05)), agentBalance: '0',
    templates: [{ id: b32(0x41), label: 'registry-v1 (attested)', deposit: '0', artifactHash: `sha256:${hsh(0x71)}`, matches: true }],
    readAt: now - 3000, readError: null, mandateDecisionId: 'dec_fx_grant_d' };
  const vE = { ...vA, id: 'vault_fx_e', chainId: 'evm:11155111', network: 'Ethereum Sepolia', address: addr(0xe0), paused: true, mandate: { ...vA.mandate, revoked: true, epoch: 4 }, budget: { ...vA.budget, maxDraw: '0', blocked: 'Paused' }, readError: 'HTTP 429 from the chain RPC (rate limited); retrying on the next tick', readAt: now - 3 * MIN, mandateDecisionId: null };

  // ---- the vault a grant flow talks about ----
  const grantPayload = {
    kind: 'grant_mandate', vault: { chainId: 'evm:84532', address: addr(0x90), owner: OWNER }, agent: { address: AGENT },
    mandate: { expiresAt: sec(now + 5 * DAY), perDrawCap: S(ETH(0.005)), periodSecs: 3600, periodCap: S(ETH(0.015)), totalCap: S(ETH(0.1)), maxDeploys: 3 },
    templates: [{ artifactHash: `sha256:${hsh(0x71)}`, templateId: b32(0x11), label: 'registry-v1 (attested)', deposit: '0', initMaterial: { owner: OWNER } }],
    fund: { amount: S(ETH(0.05)) }, loop: { maxPerDay: 3 },
  };
  const gm = grantPayload.mandate;
  const stageApproved = grantStage !== 'pending';
  const grantDecision = { id: 'dec_fx_grant', action: 'grant_mandate', chain_id: 'evm:84532', status: stageApproved ? 'approved' : 'pending', effectiveStatus: stageApproved ? 'approved' : 'pending', approver: stageApproved ? 'operator' : null,
    decided_at: stageApproved ? now - 12 * MIN : null, created_at: now - 40 * MIN, expiry: now + 23 * HR, artifact_hash: `sha256:${hsh(0x70)}`, nonce: hsh(0x91).slice(0, 32), payload_hash: hsh(0x92), max_spend: S(ETH(0.1)),
    bound_signer: stageApproved ? OWNER : null, confirmPhrase: 'approve dec_fx_grant', payload: grantPayload, run_id: null };
  const tamper = grantStage === 'tampered';
  const grantPlan = { steps: [
    { who: 'human', title: 'Fund the vault', note: 'Plain transfer from your wallet. This is the pool the agent may draw from, inside its budget.', tx: { to: grantPayload.vault.address, data: '0x', value: S(ETH(0.05) + (tamper ? ETH(0.4) : 0n)), chainId: 84532 } },
    { who: 'human', title: 'Allowlist the template', note: 'Exact bytecode id, label and deposit as approved.', tx: { to: grantPayload.vault.address, data: encAllow(b32(0x11), 'registry-v1 (attested)', 0), value: '0', chainId: 84532 } },
    { who: 'human', title: 'Set the mandate', note: 'Binds the agent and installs every cap and the expiry.', tx: { to: grantPayload.vault.address, data: encSetMandate({ agent: AGENT, ...gm }), value: '0', chainId: 84532 } },
    { who: 'server', title: 'Server verifies the chain', note: 'It reads the vault and enables the loop only when state equals the approved payload, field by field.' },
    { who: 'agent', title: 'Agent starts working', note: 'Draws gas and deploys the listed template inside the budget. Nothing more.' },
  ] };
  const vG = { ...vA, id: 'vault_fx_g', address: grantPayload.vault.address, mandate: null, available: stageApproved ? S(ETH(0.05)) : '0', agentBalance: '0', templates: [], budget: { maxDraw: '0', remainingPeriod: '0', remainingTotal: '0', remainingDeploys: 0, blocked: 'NoMandate' }, usage: { totalSpent: '0', periodSpent: '0', deploys: 0, periodResetsAt: 0 }, mandateDecisionId: null, readAt: now - 5000 };
  if (grantStage === 'partial' || grantStage === 'verified') {
    vG.mandate = { agent: AGENT, expiresAt: gm.expiresAt, perDrawCap: gm.perDrawCap, periodSecs: gm.periodSecs, periodCap: grantStage === 'partial' ? S(ETH(0.03)) : gm.periodCap, totalCap: gm.totalCap, maxDeploys: gm.maxDeploys, revoked: false, epoch: 1 };
    vG.templates = [{ id: b32(0x11), label: 'registry-v1 (attested)', deposit: '0', artifactHash: `sha256:${hsh(0x71)}`, matches: true }];
    vG.budget = { maxDraw: gm.perDrawCap, remainingPeriod: vG.mandate.periodCap, remainingTotal: gm.totalCap, remainingDeploys: 3, blocked: '' };
    vG.mandateDecisionId = grantStage === 'verified' ? 'dec_fx_grant' : null;
  }

  // ---- loop ----
  const empty = scenario === 'empty';
  const state = empty ? 'idle' : { default: 'running', blocked: 'blocked', paused: 'paused', idle: 'idle', worker: 'idle' }[scenario] ?? 'running';
  const loop = { state, lastTickAt: scenario === 'worker' || empty ? null : now - 37_000, lastError: state === 'blocked' ? 'preview mismatch on vault_fx_d: the JS model said draw(0.005) is ok, the chain preview said E_PerDrawCap. Loop blocked itself; nothing was sent.' : state === 'paused' ? null : scenario === 'default' ? 'HTTP 429 from the OP Sepolia RPC at the previous tick (rate limited); retried and succeeded.' : null, usedToday: empty ? 0 : 2, maxPerDay: 5 };
  const vaults = empty ? [] : scenario.startsWith('grant-') ? (grantStage === 'pending' || grantStage === 'tampered' ? [] : [vG]) : (scenario === 'default' ? [vP, vA, vB, vC, vD, vE] : [vA, vB, vC, vD, vE]);
  const vault = { enabled: scenario !== 'disabled', signingSupported: scenario !== 'worker', loop, agent: { evm: { address: AGENT }, near: { account: 'fx-agent.fixture.testnet', publicKey: `ed25519:${hsh(0x55).slice(0, 44)}` } },
    vaults,
    health: [
      { name: 'agent key loaded (evm)', ok: true, detail: 'fixture' }, { name: 'agent key loaded (near)', ok: true, detail: 'fixture' },
      { name: 'vault_fx_a code matches attested AgentVault build', ok: true, detail: 'runtime hash equals the attested build' },
      { name: 'vault_fx_d code matches attested AgentVault build', ok: false, detail: 'runtime hash differs from the attested build' },
      { name: 'RPC reachable: Base Sepolia', ok: true, detail: 'fixture' }, { name: 'kill switch released', ok: true, detail: 'fixture' },
    ] };

  // ---- ledger (hash-chained; newest has the highest id) ----
  const rows = []; let n = 0; let prev = null;
  const add = (kind, ago, o = {}) => { n += 1; const hash = hsh(0x100 + n); rows.push({ id: n, time: now - ago, vaultId: 'vaultId' in o ? o.vaultId : 'vault_fx_a', kind, decisionId: o.decisionId ?? null, txHash: o.tx ? b32(0x200 + n) : null, explorerUrl: null, amount: o.amount ?? null, status: o.status ?? 'confirmed', detail: o.detail ?? '', hash, prevHash: prev }); prev = hash; };
  if (!empty) {
    add('activate', 26 * HR, { decisionId: 'dec_fx_grant_a', detail: 'mandate epoch 3 verified field by field against decision dec_fx_grant_a; loop enabled for this vault' });
    add('loop', 25 * HR, { detail: 'operator resumed the loop', vaultId: null });
    add('draw', 5 * HR + 4 * MIN, { decisionId: 'dec_fx_dep1', amount: S(ETH(0.003)), tx: true, detail: 'agent balance below 3x estimated fee: drew the minimum needed' });
    add('deploy', 5 * HR, { decisionId: 'dec_fx_dep1', tx: true, detail: 'registry-v1 deployed from the vault via CREATE2 to 0xf1c7…a0d1' });
    add('refused', 4 * HR, { decisionId: null, amount: S(ETH(0.02)), status: 'refused', detail: 'E_PerDrawCap: draw of 0.02 ETH exceeds the per-draw cap of 0.005 ETH (chain preview). Not sent.' });
    add('draw', 70 * MIN, { decisionId: 'dec_fx_dep2', amount: S(ETH(0.005)), tx: true, detail: 'drew gas for the next deploy' });
    add('deploy', 66 * MIN, { decisionId: 'dec_fx_dep2', tx: true, detail: 'registry-v1 deployed from the vault; awaiting server-side verification' });
    add('refused', 52 * MIN, { decisionId: 'dec_fx_dep3', status: 'refused', detail: 'artifact f1c79c1e… maps to no allowlisted template (templateId recomputed locally). Decision left for a human; never auto-approved.' });
    add('refused', 48 * MIN, { amount: S(ETH(0.005)), status: 'refused', detail: 'E_PeriodCap: draw of 0.005 ETH would exceed the remaining 0.0035 ETH in this period. Not sent.' });
    add('refused', 44 * MIN, { vaultId: 'vault_fx_b', decisionId: 'dec_fx_dep5', status: 'refused', detail: 'E_DeployLimit: 3 of 3 deploys already used on this mandate. Not sent.' });
    add('refused', 43 * MIN, { vaultId: 'vault_fx_c', status: 'refused', detail: 'E_MandateInactive: the mandate expired 3 hours ago.' });
    add('draw', 41 * MIN, { vaultId: 'vault_fx_b', amount: S(NEAR(0.4)), tx: true, detail: 'drew gas to the agent account' });
    add('anomaly', 40 * MIN, { vaultId: 'vault_fx_d', status: 'refused', detail: 'runtime code at the vault address differs from the attested AgentVault build. Vault excluded from the loop.' });
    if (state === 'blocked') add('anomaly', 2 * MIN, { vaultId: 'vault_fx_d', status: 'refused', detail: 'JS model preview_draw(0.005 ETH) = ok but chain preview = E_PerDrawCap. Loop blocked itself.' });
    else add('loop', 35 * MIN, { detail: 'operator resumed the loop after reviewing the anomaly', vaultId: null });
  }
  if (!empty && scenario === 'default') {
    const nb = (h) => `https://testnet.nearblocks.io/txns/${h}`;
    add('pay', 3 * HR, { vaultId: 'vault_fx_p', decisionId: 'dec_fx_pay1', amount: S(USDC(25)), tx: true, detail: `paid ${USDC(25)} base units of ${TOKEN} to ${PAYEE_A}; verified on chain` });
    rows.at(-1).explorerUrl = nb(rows.at(-1).txHash);
    add('refused', 2 * HR, { vaultId: 'vault_fx_p', decisionId: 'dec_fx_pay0', status: 'refused', detail: `payment of 500 USDC to ${PAYEE_A} not sent: the amount is above the per-payment cap the owner set (PerPayCap); nothing was signed` });
  }
  const ledger = { items: rows, chainOk: scenario !== 'broken' };

  const dec = (id, o) => ({ id, action: 'deploy_testnet', chain_id: 'evm:84532', artifact_hash: `sha256:${hsh(0x71)}`, created_at: now - 6 * HR, expiry: now + 18 * HR, payload: { networkLabel: 'Base Sepolia' }, ...o });
  const decisions = empty ? [] : [
    dec('dec_fx_dep1', { effectiveStatus: 'executed', status: 'executed', approver: 'mandate:vault_fx_a:3', decided_at: now - 5 * HR - 6 * MIN }),
    dec('dec_fx_dep2', { effectiveStatus: 'executing', status: 'executing', approver: 'mandate:vault_fx_a:3', decided_at: now - 72 * MIN }),
    dec('dec_fx_dep3', { effectiveStatus: 'pending', status: 'pending', approver: null, artifact_hash: `sha256:${hsh(0x73)}` }),
    dec('dec_fx_dep5', { effectiveStatus: 'pending', status: 'pending', approver: null, chain_id: 'near-testnet', payload: { networkLabel: 'NEAR testnet' } }),
    dec('dec_fx_dep0', { effectiveStatus: 'executed', status: 'executed', approver: 'operator', decided_at: now - 3 * DAY }),
    { ...grantDecision },
    ...(scenario === 'default' ? [
      dec('dec_fx_pay2', { action: 'pay_testnet', chain_id: 'near-testnet', target: vP.address, method: 'pay', effectiveStatus: 'pending', status: 'pending', approver: null, created_at: now - 20 * MIN, nonce: hsh(0x93).slice(0, 32), payload_hash: hsh(0x94), max_spend: S(USDC(12.5)),
        payload: { action: 'pay_testnet', protocol: 'near', network: 'near-testnet', vault: vP.address, token: TOKEN, symbol: 'USDC', decimals: 6, payee: PAYEE_B, amount: S(USDC(12.5)), memo: 'design work, October' } }),
      dec('dec_fx_pay1', { action: 'pay_testnet', chain_id: 'near-testnet', target: vP.address, method: 'pay', effectiveStatus: 'executed', status: 'executed', approver: 'mandate:vault_fx_p:1+fx-owner.fixture.testnet', decided_at: now - 3 * HR - 2 * MIN, created_at: now - 4 * HR, max_spend: S(USDC(25)),
        payload: { action: 'pay_testnet', protocol: 'near', network: 'near-testnet', vault: vP.address, token: TOKEN, symbol: 'USDC', decimals: 6, payee: PAYEE_A, amount: S(USDC(25)), memo: 'invoice 42' } }),
    ] : []),
  ];
  const artifacts = [{ hash: `sha256:${hsh(0x71)}`, kind: 'contract-build:evm' }, { hash: `sha256:${hsh(0x72)}`, kind: 'contract-build:near' }];
  // GET /api/payments (same shape as the server: newest first, the verified payment attached when there is one)
  const payments = { items: scenario === 'default' && !empty ? [
    { decisionId: 'dec_fx_pay2', status: 'pending', effectiveStatus: 'pending', vault: vP.address, token: TOKEN, symbol: 'USDC', decimals: 6, payee: PAYEE_B, amount: S(USDC(12.5)), amountDisplay: '12.5 USDC', memo: 'design work, October', summary: `Pay 12.5 USDC to ${PAYEE_B} for design work, October`, createdAt: now - 20 * MIN, expiry: now + 23 * HR, approver: null, payment: null },
    { decisionId: 'dec_fx_pay1', status: 'executed', effectiveStatus: 'executed', vault: vP.address, token: TOKEN, symbol: 'USDC', decimals: 6, payee: PAYEE_A, amount: S(USDC(25)), amountDisplay: '25 USDC', memo: 'invoice 42', summary: `Pay 25 USDC to ${PAYEE_A} for invoice 42`, createdAt: now - 4 * HR, expiry: now + 20 * HR, approver: 'mandate:vault_fx_p:1+fx-owner.fixture.testnet',
      payment: { id: 1, txHash: rows.find((r) => r.kind === 'pay')?.txHash ?? null, status: 'confirmed', explorerUrl: rows.find((r) => r.kind === 'pay')?.explorerUrl ?? '', recordedAt: now - 3 * HR, verification: {} } },
  ] : [] };
  return { mode: 'ok', scenario, at: now, vault, ledger, decisions, artifacts, payments, grant: { decision: grantDecision, plan: grantPlan } };
}
