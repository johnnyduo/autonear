// Mandate Vault v1: pure-JS reference model of the state machine in the Mandate Vault spec.
//
// Purpose: (1) executable spec that the EVM and NEAR contracts are checked against (contracts/vault-conformance.json,
// via runScenario below), (2) PRE-FLIGHT for every agent transaction (previewDraw / previewDeploy return the exact error
// code the chain would hit), (3) budget headroom for the UI (describeBudget).
//
// This is a MODEL. It proves nothing about deployed bytecode; it only says what the spec requires. Amounts are BigInt
// (wei / yoctoNEAR / abstract units), time is integer seconds. Every rejected operation throws VaultError with a `.code`
// from ERROR_CODES, checks run in exactly the order of the spec, and a rejected operation never mutates state.
// Zero dependencies, no I/O, no clock: callers always pass `now`.

export const ERROR_CODES = Object.freeze([
  'Unauthorized', 'Paused', 'NoMandate', 'MandateInactive', 'BadMandate', 'BadAmount', 'PerDrawCap', 'PeriodCap', 'TotalCap',
  'InsufficientBalance', 'DeployLimit', 'TemplateNotAllowed', 'CodeMismatch', 'AddressTaken', 'BadName', 'BadTemplate', 'BadOwner',
]);

/**
 * Extra codes of the payouts build (contracts/near-vault, cargo feature `payouts`, config().version "1.1.0"). Kept OUT of ERROR_CODES on
 * purpose: ERROR_CODES is the v1 list that contracts/vault-conformance.json and the EVM/NEAR v1 contracts are checked against.
 * contracts/vault-conformance-pay.json lists these separately (`payoutErrors`).
 */
export const PAYOUT_ERROR_CODES = Object.freeze(['TokenNotAllowed', 'PayeeNotAllowed', 'PerPayCap', 'BadToken', 'BadPayee', 'BadMemo']);
export const ALL_ERROR_CODES = Object.freeze([...ERROR_CODES, ...PAYOUT_ERROR_CODES]);

export class VaultError extends Error {
  constructor(code, detail = '') {
    super(detail ? `E_${code}: ${detail}` : `E_${code}`);
    this.name = 'VaultError';
    this.code = code;
  }
}

export const LIMITS = Object.freeze({
  maxExpirySecs: 30n * 86400n,   // expires_at <= now + 30d
  minPeriodSecs: 60n,
  maxPeriodSecs: 30n * 86400n,
  maxDeploys: 1000n,
  maxLabelBytes: 64,
  maxInitArgsBytes: 1024,
  nearNameMaxLen: 40,            // MODEL CHOICE: the spec says only "invalid name"; the Rust contract is the authority.
  // payouts build (payouts.rs): MAX_TOKENS / MAX_PAYEES / MAX_MEMO_BYTES
  maxTokens: 8,
  maxPayees: 64,
  maxMemoBytes: 128,
});
const U128_MAX = (1n << 128n) - 1n;

const NEAR_NAME = /^[a-z0-9]+([-_][a-z0-9]+)*$/;
const ZERO_ADDR = /^0x0*$/i;
const isEmptyAddr = (a) => a === undefined || a === null || a === '' || (typeof a === 'string' && ZERO_ADDR.test(a));
const utf8Len = (s) => new TextEncoder().encode(s).length;

/** Coerce to a non-negative BigInt, or null when it is not a plain integer value. */
export function toBig(v) {
  try {
    if (typeof v === 'bigint') return v >= 0n ? v : null;
    if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
    if (typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v)) return BigInt(v);
  } catch { /* fallthrough */ }
  return null;
}
const floorDiv = (a, b) => { const q = a / b; return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q; };
const timeOf = (now) => { const t = toBig(now); if (t === null) throw new TypeError('now must be a non-negative integer (seconds)'); return t; };

export class VaultModel {
  /**
   * init: owner address, chain ('evm' | 'near'), initial balance. `deploy_fail_reverts` is not a knob: see onDeployFailed.
   */
  constructor({ chain = 'evm', owner = 'owner', balance = 0n, networkId = '', vaultId = 'vault', callDeposit = 1n } = {}) {
    if (chain !== 'evm' && chain !== 'near') throw new TypeError('chain must be "evm" or "near"');
    if (isEmptyAddr(owner)) throw new TypeError('owner required');
    const b = toBig(balance);
    if (b === null) throw new TypeError('balance must be a non-negative integer');
    this.chain = chain;
    // Payouts only: `vaultId` = the vault's own account (never a token or payee). `callDeposit` = the NEAR the vault attaches to each
    // ft_transfer (1 yoctoNEAR on chain; pass 0n when `balance` is in abstract units, as the conformance runner does). The runtime refunds it
    // when the transfer fails.
    this.vaultId = vaultId;
    this.callDeposit = toBig(callDeposit) ?? 1n;
    this.config = { owner, pendingOwner: null, paused: false, networkId, epoch: 0n };
    this.mandate = null;   // { agent, expiresAt, perDrawCap, periodSecs, periodCap, totalCap, maxDeploys, revoked, start }
    this.usage = { totalSpent: 0n, periodIndex: 0n, periodSpent: 0n, deploys: 0n };
    this.templates = new Map();
    this.taken = new Set();
    this.balance = b;
    this.received = new Map();       // address -> cumulative amount sent to it by draw / withdraw
    this.deployedDeposits = 0n;      // cumulative deposit forwarded to deployed contracts, net of failed-deploy refunds
    this.deposited = b;              // cumulative funds that entered (initial balance + deposits)
    this.pendingDeploys = new Map(); // NEAR async window: id -> receipt, until onDeployed / onDeployFailed
    // ---- payouts (payouts.rs); empty = v1 behaviour, nothing below is touched
    this.tokens = new Map();         // token account -> { perPayCap, periodCap, totalCap }   (insertion order)
    this.payees = new Set();
    this.tokenUsage = new Map();     // token account -> { epoch, total, periodIndex, period }  kept when a token is disallowed
    this.tokenSent = new Map();      // token -> Map(receiver -> cumulative amount transferred out, net of failed transfers)
    this.events = [];
    this._seq = 0;
  }

  static init(opts) { return new VaultModel(opts); }

  clone() {
    const m = new VaultModel({ chain: this.chain, owner: this.config.owner, balance: 0n, networkId: this.config.networkId, vaultId: this.vaultId, callDeposit: this.callDeposit });
    m.tokens = new Map([...this.tokens].map(([k, v]) => [k, { ...v }]));
    m.payees = new Set(this.payees);
    m.tokenUsage = new Map([...this.tokenUsage].map(([k, v]) => [k, { ...v }]));
    m.tokenSent = new Map([...this.tokenSent].map(([k, v]) => [k, new Map(v)]));
    m.config = { ...this.config };
    m.mandate = this.mandate ? { ...this.mandate } : null;
    m.usage = { ...this.usage };
    m.templates = new Map([...this.templates].map(([k, v]) => [k, { ...v }]));
    m.taken = new Set(this.taken);
    m.balance = this.balance; m.received = new Map(this.received); m.deployedDeposits = this.deployedDeposits; m.deposited = this.deposited;
    m.pendingDeploys = new Map([...this.pendingDeploys].map(([k, v]) => [k, { ...v }]));
    m.events = this.events.map((e) => ({ ...e })); m._seq = this._seq;
    return m;
  }

  // ---------------------------------------------------------------- views
  isActive(now) { const t = timeOf(now); return Boolean(this.mandate) && !this.mandate.revoked && t < this.mandate.expiresAt; }
  available() { return this.balance; }
  periodIndex(now) { const t = timeOf(now); return this.mandate ? floorDiv(t - this.mandate.start, this.mandate.periodSecs) : 0n; }
  /** period_state(now): period_spent is treated as 0 when the stored period differs from the current one. */
  periodState(now) {
    if (!this.mandate) return { index: 0n, spent: 0n, startsAt: 0n, endsAt: 0n };
    const index = this.periodIndex(now);
    const spent = index === this.usage.periodIndex ? this.usage.periodSpent : 0n;
    const startsAt = this.mandate.start + index * this.mandate.periodSecs;
    return { index, spent, startsAt, endsAt: startsAt + this.mandate.periodSecs };
  }
  template(id) { const t = this.templates.get(id); return t ? { ...t } : null; }
  listTemplates(from = 0, limit = 50) { return [...this.templates.values()].slice(from, from + limit).map((t) => ({ ...t })); }
  receivedBy(addr) { return this.received.get(addr) ?? 0n; }
  /** Plain observable state (the subset the conformance file may assert, plus a few extras). */
  observe(now) {
    const ps = this.periodState(now);
    return {
      available: this.balance, total_spent: this.usage.totalSpent, period_spent: ps.spent, deploys: this.usage.deploys,
      epoch: this.config.epoch, paused: this.config.paused, revoked: this.mandate ? this.mandate.revoked : false,
    };
  }
  snapshot(now) {
    return {
      chain: this.chain, config: { ...this.config }, mandate: this.mandate ? { ...this.mandate } : null,
      usage: { ...this.usage }, period: now === undefined ? null : this.periodState(now), available: this.balance,
      templates: this.listTemplates(0, Number.MAX_SAFE_INTEGER), received: Object.fromEntries(this.received),
      // only present once payouts are used, so a v1 snapshot is exactly what it always was
      ...(this.tokens.size || this.payees.size || this.tokenUsage.size ? { payouts: this.payoutSnapshot() } : {}),
    };
  }
  payoutSnapshot() {
    return {
      tokens: this.tokenList(), payees: [...this.payees],
      usage: Object.fromEntries([...this.tokenUsage].map(([k, v]) => [k, { ...v }])),
      sent: Object.fromEntries([...this.tokenSent].map(([k, v]) => [k, Object.fromEntries(v)])),
    };
  }

  // ---------------------------------------------------------------- payout views (payouts.rs: tokens, payees, token_usage, token_period_state)
  tokenList() { return [...this.tokens].map(([token, l]) => ({ token, ...l })); }
  payeeList(from = 0, limit = 50) { return [...this.payees].slice(from, from + Math.min(limit, 100)); }
  _usageIn(token, epoch) {
    const u = this.tokenUsage.get(token);
    return u && u.epoch === epoch ? { ...u } : { epoch, total: 0n, periodIndex: 0n, period: 0n };
  }
  /** Rust period_index saturates (a time before `start` is period 0); v1's periodIndex above does not. Payouts mirror Rust. */
  _payPeriodIndex(t) { const m = this.mandate; return t > m.start ? (t - m.start) / m.periodSecs : 0n; }
  /** token_usage(token): stored (lazily re-based) values of the CURRENT epoch; zeros for an unknown token or an older epoch. */
  tokenUsageView(token) { const u = this._usageIn(token, this.config.epoch); return { totalSpent: u.total, periodIndex: u.periodIndex, periodSpent: u.period }; }
  /** Period spend of `token` effective at `now` (0 when the stored period is not the current one, or there is no mandate). */
  tokenPeriodSpent(token, now) {
    if (!this.mandate) return 0n;
    const u = this._usageIn(token, this.config.epoch);
    return u.periodIndex === this._payPeriodIndex(timeOf(now)) ? u.period : 0n;
  }
  /** token_period_state(token, now): figures effective at `now`; null without a mandate or when the token is not allowed. */
  tokenPeriodState(token, now) {
    const t = timeOf(now); const m = this.mandate; const lim = this.tokens.get(token);
    if (!m || !lim) return null;
    const idx = this._payPeriodIndex(t); const u = this._usageIn(token, this.config.epoch);
    const spent = u.periodIndex === idx ? u.period : 0n;
    const sat = (a, b) => (a > b ? a - b : 0n);
    const start = m.start + idx * m.periodSecs;
    return { periodIndex: idx, periodStart: start, periodEnd: start + m.periodSecs, periodSpent: spent, periodRemaining: sat(lim.periodCap, spent), totalSpent: u.total, totalRemaining: sat(lim.totalCap, u.total), active: !m.revoked && t < m.expiresAt };
  }
  /** Cumulative token amount sent out to `to` (net of transfers whose callback reported failure). */
  tokenSentTo(token, to) { return this.tokenSent.get(token)?.get(to) ?? 0n; }

  // ---------------------------------------------------------------- internals
  _emit(type, data = {}) { this.events.push({ seq: this._seq++, type, ...data }); }
  _owner(caller) { if (caller !== this.config.owner || isEmptyAddr(caller)) throw new VaultError('Unauthorized', 'owner only'); }
  _credit(addr, amt) { this.received.set(addr, this.receivedBy(addr) + amt); }

  /** Agent preamble: NoMandate (any caller) -> Unauthorized -> Paused -> MandateInactive. `caller === null` = preview (assume bound agent). */
  _agentGate(caller, t) {
    const m = this.mandate;
    if (!m) return 'NoMandate';
    if (caller !== null && caller !== m.agent) return 'Unauthorized';
    if (this.config.paused) return 'Paused';
    if (m.revoked || t >= m.expiresAt) return 'MandateInactive';
    return null;
  }
  /** Shared spend rules (period -> total -> balance). `perDraw` is true for draws only. Returns error code or null. */
  _spendCheck(amount, t) {
    const m = this.mandate;
    const ps = this.periodState(t);
    if (ps.spent + amount > m.periodCap) return 'PeriodCap';
    if (this.usage.totalSpent + amount > m.totalCap) return 'TotalCap';
    if (amount > this.balance) return 'InsufficientBalance';
    return null;
  }
  _spend(amount, t) {
    const idx = this.periodIndex(t);
    if (idx !== this.usage.periodIndex) { this.usage.periodIndex = idx; this.usage.periodSpent = 0n; }
    this.usage.periodSpent += amount;
    this.usage.totalSpent += amount;
    this.balance -= amount;
  }
  _checkDraw(caller, amountIn, t) {
    const gate = this._agentGate(caller, t); if (gate) return { err: gate };
    const amount = toBig(amountIn);
    if (amount === null || amount === 0n) return { err: 'BadAmount' };
    if (amount > this.mandate.perDrawCap) return { err: 'PerDrawCap' };
    const s = this._spendCheck(amount, t); if (s) return { err: s };
    return { amount };
  }
  _targetKey(template, nameOrSalt) { return this.chain === 'near' ? `near:${nameOrSalt}` : `evm:${template}:${nameOrSalt}`; }
  _validName(name) {
    if (this.chain !== 'near') return typeof name === 'string';   // EVM: any salt that the harness can map to bytes32
    return typeof name === 'string' && name.length > 0 && name.length <= LIMITS.nearNameMaxLen && NEAR_NAME.test(name);
  }
  _checkDeploy(caller, { template, name, salt, code } = {}, t) {
    const gate = this._agentGate(caller, t); if (gate) return { err: gate };
    const tpl = this.templates.get(template);
    if (!tpl) return { err: 'TemplateNotAllowed' };
    if ((code ?? template) !== template) return { err: 'CodeMismatch' };
    if (this.usage.deploys >= this.mandate.maxDeploys) return { err: 'DeployLimit' };
    const s = this._spendCheck(tpl.deposit, t); if (s) return { err: s };
    const raw = name ?? salt;
    const nameOrSalt = raw === undefined || raw === null ? undefined : String(raw);
    const key = this._targetKey(template, nameOrSalt);
    if (nameOrSalt !== undefined && this.taken.has(key)) return { err: 'AddressTaken' };
    if (!this._validName(nameOrSalt)) return { err: 'BadName' };
    return { tpl, key, nameOrSalt };
  }

  // ---------------------------------------------------------------- previews (never mutate; assume the bound agent)
  /** Returns the error code `draw` would hit now, or '' when it would succeed. */
  previewDraw(amount, now) { const r = this._checkDraw(null, amount, timeOf(now)); return r.err ?? ''; }
  previewDeploy(template, nameOrSalt, now, code) {
    const r = this._checkDeploy(null, { template, name: nameOrSalt, code }, timeOf(now)); return r.err ?? '';
  }

  // ---------------------------------------------------------------- anyone
  deposit(from, amount, now) {
    void from; void now;
    const a = toBig(amount); if (a === null) throw new VaultError('BadAmount', 'deposit');
    this.balance += a; this.deposited += a;
    this._emit('Deposited', { from, amount: a });
  }

  // ---------------------------------------------------------------- owner ops
  setMandate(caller, now, args = {}) {
    this._owner(caller);
    const t = timeOf(now);
    const bad = (why) => { throw new VaultError('BadMandate', why); };
    const { agent } = args;
    if (isEmptyAddr(agent) || typeof agent !== 'string') bad('agent');
    const expiresAt = toBig(args.expires_at ?? args.expiresAt);
    const perDrawCap = toBig(args.per_draw_cap ?? args.perDrawCap);
    const periodSecs = toBig(args.period_secs ?? args.periodSecs);
    const periodCap = toBig(args.period_cap ?? args.periodCap);
    const totalCap = toBig(args.total_cap ?? args.totalCap);
    const maxDeploys = toBig(args.max_deploys ?? args.maxDeploys);
    if (expiresAt === null || !(t < expiresAt && expiresAt <= t + LIMITS.maxExpirySecs)) bad('expires_at');
    if (perDrawCap === null || periodCap === null || totalCap === null || !(0n < perDrawCap && perDrawCap <= periodCap && periodCap <= totalCap)) bad('caps');
    if (periodSecs === null || periodSecs < LIMITS.minPeriodSecs || periodSecs > LIMITS.maxPeriodSecs) bad('period_secs');
    if (maxDeploys === null || maxDeploys > LIMITS.maxDeploys) bad('max_deploys');
    this.mandate = { agent, expiresAt, perDrawCap, periodSecs, periodCap, totalCap, maxDeploys, revoked: false, start: t };
    this.config.epoch += 1n;
    this.usage = { totalSpent: 0n, periodIndex: 0n, periodSpent: 0n, deploys: 0n };
    this._emit('MandateSet', { agent, epoch: this.config.epoch });
  }
  revoke(caller) {
    this._owner(caller);
    if (!this.mandate) throw new VaultError('NoMandate');
    this.mandate.revoked = true;
    this._emit('Revoked', { epoch: this.config.epoch });
  }
  pause(caller) { this._owner(caller); this.config.paused = true; this._emit('Paused'); }
  unpause(caller) { this._owner(caller); this.config.paused = false; this._emit('Unpaused'); }
  allowTemplate(caller, args = {}) {
    this._owner(caller);
    const id = args.template ?? args.template_id ?? args.id;
    const label = args.label ?? '';
    const deposit = toBig(args.deposit ?? 0);
    if (typeof id !== 'string' || id === '') throw new VaultError('BadTemplate', 'id');
    if (typeof label !== 'string' || utf8Len(label) > LIMITS.maxLabelBytes) throw new VaultError('BadTemplate', 'label > 64 bytes');
    if (deposit === null) throw new VaultError('BadTemplate', 'deposit');
    if (this.chain === 'evm' && deposit !== 0n) throw new VaultError('BadTemplate', 'EVM deposit must be 0');
    const initArgs = args.init_args ?? args.initArgs;
    if (this.chain === 'near' && initArgs !== undefined) {
      const s = typeof initArgs === 'string' ? initArgs : JSON.stringify(initArgs);
      if (s === undefined || utf8Len(s) > LIMITS.maxInitArgsBytes) throw new VaultError('BadTemplate', 'init_args > 1 KiB');
    }
    this.templates.set(id, { id, label, deposit, ...(this.chain === 'near' ? { initArgs: initArgs ?? null, initGas: args.init_gas ?? args.initGas ?? null } : {}) });
    this._emit('TemplateAllowed', { id, deposit });
  }
  disallowTemplate(caller, id) {
    this._owner(caller);
    if (!this.templates.delete(id)) throw new VaultError('TemplateNotAllowed');
    this._emit('TemplateDisallowed', { id });
  }
  withdraw(caller, amountIn) {
    this._owner(caller);
    const amount = toBig(amountIn);
    if (amount === null || amount === 0n) throw new VaultError('BadAmount');
    if (amount > this.balance) throw new VaultError('InsufficientBalance');
    this.balance -= amount; this._credit(this.config.owner, amount);
    this._emit('Withdrawn', { to: this.config.owner, amount });
  }
  transferOwnership(caller, to) {
    this._owner(caller);
    if (isEmptyAddr(to) || typeof to !== 'string' || to === this.config.owner) throw new VaultError('BadOwner');
    this.config.pendingOwner = to;
    this._emit('OwnershipTransferStarted', { to });
  }
  acceptOwnership(caller) {
    if (!this.config.pendingOwner || caller !== this.config.pendingOwner) throw new VaultError('Unauthorized', 'not pending owner');
    const old = this.config.owner;
    this.config.owner = caller; this.config.pendingOwner = null;
    this._emit('OwnershipTransferred', { from: old, to: caller });
  }

  // ---------------------------------------------------------------- agent ops
  draw(caller, amountIn, now) {
    const t = timeOf(now);
    const r = this._checkDraw(caller, amountIn, t);
    if (r.err) throw new VaultError(r.err);
    this._spend(r.amount, t);                  // effects before transfer
    this._credit(this.mandate.agent, r.amount); // transfer goes to mandate.agent only
    this._emit('Drawn', { agent: this.mandate.agent, amount: r.amount, epoch: this.config.epoch });
    return { amount: r.amount, to: this.mandate.agent };
  }
  /**
   * deploy(template, name|salt, code). `code` is the identity (hash) of the code being deployed and defaults to `template`.
   * Returns a receipt. On NEAR the real deploy is asynchronous: the receipt stays in `pendingDeploys` until the host calls
   * onDeployed(receipt) or onDeployFailed(receipt). On EVM a failed CREATE2 reverts the whole tx, so the host never calls either.
   */
  deploy(caller, args, now) {
    const t = timeOf(now);
    const r = this._checkDeploy(caller, args ?? {}, t);
    if (r.err) throw new VaultError(r.err);
    const deposit = r.tpl.deposit;
    const periodIndex = this.periodIndex(t);
    this.usage.deploys += 1n;                  // effects first (counters), then create
    this._spend(deposit, t);
    this.deployedDeposits += deposit;
    this.taken.add(r.key);
    const receipt = { id: ++this._seq, template: r.tpl.id, target: r.key, name: r.nameOrSalt, deposit, epoch: this.config.epoch, periodIndex };
    if (this.chain === 'near') this.pendingDeploys.set(receipt.id, receipt);
    this._emit('Deployed', { template: r.tpl.id, target: r.key, deposit, epoch: this.config.epoch });
    return receipt;
  }
  /** NEAR callback `on_deployed`: batch succeeded, the async window closes. Idempotent. */
  onDeployed(receipt) { return this.pendingDeploys.delete(receipt?.id); }
  /**
   * NEAR callback `on_deployed` on failure: reverse the counters and spend, refund the forwarded deposit to the vault
   * (a failed promise batch is atomic and refunds its attached deposit) and free the name. Counters are only reversed when the
   * mandate epoch is unchanged (a new mandate already reset them); period_spent only when still in the same period.
   * Idempotent: an unknown or already-settled receipt returns false.
   */
  onDeployFailed(receipt, { releaseName = true } = {}) {
    if (!receipt || !this.pendingDeploys.has(receipt.id)) return false;
    this.pendingDeploys.delete(receipt.id);
    this.balance += receipt.deposit; this.deployedDeposits -= receipt.deposit;
    if (releaseName) this.taken.delete(receipt.target);
    if (receipt.epoch === this.config.epoch) {
      this.usage.deploys -= 1n;
      this.usage.totalSpent -= receipt.deposit;
      if (this.usage.periodIndex === receipt.periodIndex) this.usage.periodSpent -= receipt.deposit;
    }
    this._emit('DeployFailed', { template: receipt.template, target: receipt.target, deposit: receipt.deposit });
    return true;
  }

  // ================================================================ payouts (contracts/near-vault/src/payouts.rs is the SOURCE OF TRUTH)
  // Token budgets reuse the NEAR mandate's clock, agent, expiry, revoke, pause and epoch. Usage is stamped with the epoch it was charged in
  // (a stale epoch reads as zero); allow / re-allow / disallow never reset it, set_mandate does (by bumping the epoch). The charge is
  // optimistic, `onPaid(failed)` reverses it. Amounts are BigInt in the token's smallest unit.
  _reserved(a) { return typeof a !== 'string' || a === '' || a === 'system' || /^0{64}$/.test(a) || a === this.vaultId; }
  _sent(token, to, delta) {
    const m = this.tokenSent.get(token) ?? new Map();
    const v = (m.get(to) ?? 0n) + delta;
    m.set(to, v < 0n ? 0n : v); this.tokenSent.set(token, m);
  }
  /**
   * All `pay` rules in Rust order: NoMandate, Unauthorized, Paused, MandateInactive, TokenNotAllowed, PayeeNotAllowed, BadAmount, PerPayCap,
   * PeriodCap, TotalCap, BadMemo (> 128 BYTES), InsufficientBalance (< 1 yocto of spendable NEAR for the ft_transfer deposit).
   * caller === null = preview (assume the bound agent). Returns { err } or { amount, lim, idx, memo }.
   */
  _checkPay(caller, { token, to, amount: amountIn, memo } = {}, t) {
    const gate = this._agentGate(caller, t); if (gate) return { err: gate };
    const lim = this.tokens.get(token);
    if (!lim) return { err: 'TokenNotAllowed' };
    if (!this.payees.has(to)) return { err: 'PayeeNotAllowed' };
    const amount = toBig(amountIn);
    if (amount === null || amount === 0n || amount > U128_MAX) return { err: 'BadAmount' };
    if (amount > lim.perPayCap) return { err: 'PerPayCap' };
    const u = this._usageIn(token, this.config.epoch);
    const idx = this._payPeriodIndex(t);
    if ((u.periodIndex === idx ? u.period : 0n) + amount > lim.periodCap) return { err: 'PeriodCap' };
    if (u.total + amount > lim.totalCap) return { err: 'TotalCap' };
    if (memo !== undefined && memo !== null && (typeof memo !== 'string' || utf8Len(memo) > LIMITS.maxMemoBytes)) return { err: 'BadMemo' };
    if (this.balance < 1n) return { err: 'InsufficientBalance' };
    return { amount, lim, idx, memo: memo ?? null };
  }
  /** preview_pay(token, to, amount): the error code `pay` would hit now ('' = ok). `caller` omitted = the bound agent (as on chain). */
  previewPay(token, to, amount, { caller = null, now, memo } = {}) {
    const r = this._checkPay(caller, { token, to, amount, memo }, timeOf(now)); return r.err ?? '';
  }

  allowToken(caller, args = {}) {
    this._owner(caller);
    const token = args.token;
    const per = toBig(args.per_pay_cap ?? args.perPayCap), period = toBig(args.period_cap ?? args.periodCap), total = toBig(args.total_cap ?? args.totalCap);
    if (this._reserved(token)) throw new VaultError('BadToken', 'invalid token account');
    if (per === null || period === null || total === null || !(per > 0n && per <= period && period <= total && total <= U128_MAX)) throw new VaultError('BadToken', 'token caps out of bounds');
    if (this.payees.has(token)) throw new VaultError('BadToken', 'token is an allowed payee');
    const updated = this.tokens.has(token);
    if (!updated && this.tokens.size >= LIMITS.maxTokens) throw new VaultError('BadToken', 'too many tokens');
    this.tokens.set(token, { perPayCap: per, periodCap: period, totalCap: total });
    this._emit('TokenAllowed', { token, perPayCap: per, periodCap: period, totalCap: total, updated });
  }
  disallowToken(caller, token) {
    this._owner(caller);
    if (!this.tokens.delete(token)) throw new VaultError('TokenNotAllowed', 'unknown token');
    this._emit('TokenDisallowed', { token });   // usage is kept: a later re-allow cannot reset it
  }
  allowPayee(caller, account) {
    this._owner(caller);
    if (this._reserved(account)) throw new VaultError('BadPayee', 'invalid payee account');
    if (this.tokens.has(account)) throw new VaultError('BadPayee', 'payee is an allowed token');
    if (this.payees.has(account)) return;      // idempotent, no event
    if (this.payees.size >= LIMITS.maxPayees) throw new VaultError('BadPayee', 'too many payees');
    this.payees.add(account);
    this._emit('PayeeAllowed', { payee: account });
  }
  disallowPayee(caller, account) {
    this._owner(caller);
    if (!this.payees.delete(account)) throw new VaultError('PayeeNotAllowed', 'unknown payee');
    this._emit('PayeeDisallowed', { payee: account });
  }
  /** Sends `amount` of `token` to the OWNER only. Works while paused / revoked / expired, for any token account. Nothing is charged. */
  withdrawToken(caller, token, amountIn) {
    this._owner(caller);
    if (this._reserved(token)) throw new VaultError('BadToken', 'invalid token account');
    const amount = toBig(amountIn);
    if (amount === null || amount === 0n || amount > U128_MAX) throw new VaultError('BadAmount');
    if (this.balance < 1n) throw new VaultError('InsufficientBalance', 'no NEAR for the 1 yocto deposit');
    const to = this.config.owner;
    this.balance -= this.callDeposit; this._sent(token, to, amount);
    this._emit('TokenWithdrawn', { token, to, amount });
    return { token, to, amount };
  }
  /** Callback of withdraw_token: only reports a failure (and the runtime refunds the call deposit). */
  onTokenWithdrawn({ token, to, amount } = {}, failed = true) {
    if (!failed) return false;
    const a = toBig(amount) ?? 0n;
    this.balance += this.callDeposit; this._sent(token, to, -a);
    this._emit('TokenWithdrawFailed', { token, to, amount: a });
    return true;
  }
  /** pay(token, to, amount, memo?): optimistic charge, then an ft_transfer(to, amount, memo) the host performs. Returns the transfer + receipt. */
  pay(caller, args, now) {
    const t = timeOf(now);
    const { token, to } = args ?? {};
    const r = this._checkPay(caller, args ?? {}, t);
    if (r.err) throw new VaultError(r.err);
    const epoch = this.config.epoch;
    const u = this._usageIn(token, epoch);
    if (u.periodIndex !== r.idx) { u.periodIndex = r.idx; u.period = 0n; }
    u.period += r.amount; u.total += r.amount;
    this.tokenUsage.set(token, u);
    this.balance -= this.callDeposit; this._sent(token, to, r.amount);
    this._emit('Paid', { agent: this.mandate.agent, token, to, amount: r.amount, memo: r.memo, epoch, totalSpent: u.total, periodSpent: u.period });
    return { token, to, amount: r.amount, memo: r.memo, epoch, periodIndex: r.idx };
  }
  /**
   * Callback `on_paid`. Success does nothing. On failure the charge is reversed ONLY when `epoch` is still the current one and the stored
   * record is of that epoch (a newer mandate has its own counters), the period only if the stored period is the one charged, saturating (a replay
   * cannot underflow); the token may already be disallowed. Always reports `PayFailed` { reversed }. Returns reversed (bool) or null on success.
   */
  onPaid({ epoch, periodIndex, period_index: pi, token, to, amount } = {}, failed = true) {
    if (!failed) return null;
    const ep = toBig(epoch) ?? -1n; const idx = toBig(periodIndex ?? pi) ?? -1n; const a = toBig(amount) ?? 0n;
    let reversed = false;
    if (ep === this.config.epoch) {
      const u = this.tokenUsage.get(token);
      if (u && u.epoch === ep) {
        u.total = u.total > a ? u.total - a : 0n;
        if (u.periodIndex === idx) u.period = u.period > a ? u.period - a : 0n;
        reversed = true;
      }
    }
    this.balance += this.callDeposit; this._sent(token, to, -a);
    this._emit('PayFailed', { token, to, amount: a, epoch: ep, reversed });
    return reversed;
  }

  // ---------------------------------------------------------------- dispatcher (conformance + backend pre-flight)
  /**
   * exec(op, caller, args, now): one entry point for every op. Throws VaultError on rejection.
   * Previews return the error code string ('' = ok) instead of throwing.
   */
  exec(op, caller, args = {}, now = 0) {
    switch (op) {
      case 'set_mandate': return this.setMandate(caller, now, args);
      case 'revoke': return this.revoke(caller);
      case 'pause': return this.pause(caller);
      case 'unpause': return this.unpause(caller);
      case 'allow_template': return this.allowTemplate(caller, args);
      case 'disallow_template': return this.disallowTemplate(caller, args.template ?? args.template_id ?? args.id);
      case 'withdraw': return this.withdraw(caller, args.amount);
      case 'transfer_ownership': return this.transferOwnership(caller, args.to ?? args.new_owner);
      case 'accept_ownership': return this.acceptOwnership(caller);
      case 'deposit': return this.deposit(caller, args.amount, now);
      case 'draw': return this.draw(caller, args.amount, now);
      case 'deploy': return this.deploy(caller, args, now);
      case 'preview_draw': return this.previewDraw(args.amount, now);
      case 'preview_deploy': return this.previewDeploy(args.template, args.name ?? args.salt, now, args.code);
      // payouts build only (see the block above); a v1 vault has no such methods
      case 'allow_token': return this.allowToken(caller, args);
      case 'disallow_token': return this.disallowToken(caller, args.token);
      case 'allow_payee': return this.allowPayee(caller, args.account ?? args.payee);
      case 'disallow_payee': return this.disallowPayee(caller, args.account ?? args.payee);
      case 'withdraw_token': return this.withdrawToken(caller, args.token, args.amount);
      case 'pay': return this.pay(caller, args, now);
      case 'preview_pay': return this.previewPay(args.token, args.to, args.amount, { now });
      case 'on_paid': return this.onPaid(args, args.failed ?? true);
      case 'on_token_withdrawn': return this.onTokenWithdrawn(args, args.failed ?? true);
      default: throw new TypeError(`unknown op "${op}"`);
    }
  }
}

/**
 * Remaining headroom for the agent right now. All amounts are BigInt (use budgetToJSON for the wire).
 * `blocked` is the first agent-gate error the agent would hit ('' = can act); `maxDraw` / `maxDeployDeposit` already
 * account for per-draw, period, total and available balance.
 */
export function describeBudget(model, now) {
  const t = timeOf(now);
  const m = model.mandate;
  const avail = model.available();
  const min = (...xs) => xs.reduce((a, b) => (b < a ? b : a));
  if (!m) {
    return { hasMandate: false, active: false, blocked: 'NoMandate', epoch: model.config.epoch, available: avail, paused: model.config.paused,
      perDraw: null, period: null, total: null, deploys: null, maxDraw: 0n, maxDeployDeposit: 0n, expiresIn: 0n };
  }
  const ps = model.periodState(t);
  const gate = model._agentGate(null, t) ?? '';
  const periodRemaining = m.periodCap > ps.spent ? m.periodCap - ps.spent : 0n;
  const totalRemaining = m.totalCap > model.usage.totalSpent ? m.totalCap - model.usage.totalSpent : 0n;
  const deploysRemaining = m.maxDeploys > model.usage.deploys ? m.maxDeploys - model.usage.deploys : 0n;
  const spendRoom = min(periodRemaining, totalRemaining, avail);
  const open = gate === '';
  return {
    hasMandate: true, agent: m.agent, active: open, blocked: gate, epoch: model.config.epoch, paused: model.config.paused, revoked: m.revoked,
    available: avail, expiresAt: m.expiresAt, expiresIn: m.expiresAt > t ? m.expiresAt - t : 0n,
    perDraw: { cap: m.perDrawCap },
    period: { index: ps.index, spent: ps.spent, cap: m.periodCap, remaining: periodRemaining, startsAt: ps.startsAt, resetsAt: ps.endsAt },
    total: { spent: model.usage.totalSpent, cap: m.totalCap, remaining: totalRemaining },
    deploys: { used: model.usage.deploys, max: m.maxDeploys, remaining: deploysRemaining },
    maxDraw: open ? min(m.perDrawCap, spendRoom) : 0n,
    maxDeployDeposit: open && deploysRemaining > 0n ? spendRoom : 0n,
  };
}

/** JSON-safe form of describeBudget (BigInt -> decimal string). */
export function budgetToJSON(b) {
  return JSON.parse(JSON.stringify(b, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

// ------------------------------------------------------------------ conformance executor
const STATE_KEYS = ['available', 'total_spent', 'period_spent', 'deploys', 'epoch', 'paused', 'revoked'];

/**
 * Execute one scenario of contracts/vault-conformance.json against the model on the given chain.
 * Returns { name, chain, skipped, steps, failures }. A failure is { step, op, field, expected, got }; nothing throws for a
 * mismatch so callers can report every discrepancy. Steps with `only` for the other chain are skipped; scenarios with `only`
 * for the other chain are skipped entirely.
 */
export function runScenario(scenario, chain = 'evm') {
  const res = { name: scenario.name, chain, skipped: false, steps: 0, failures: [] };
  if (scenario.only && scenario.only !== chain) { res.skipped = true; return res; }
  const model = new VaultModel({ chain, owner: 'owner', balance: toBig(scenario.setup?.balance ?? 0) ?? 0n });
  const fail = (step, op, field, expected, got) => res.failures.push({ step, op, field, expected, got });
  const show = (v) => (typeof v === 'bigint' ? v.toString() : v);
  scenario.steps.forEach((s, i) => {
    if (s.only && s.only !== chain) return;
    res.steps += 1;
    let got = 'ok';
    try {
      const out = model.exec(s.op, s.as, s.args ?? {}, s.t);
      if (typeof out === 'string') got = out === '' ? 'ok' : { err: out };   // previews
    } catch (e) {
      if (e instanceof VaultError) got = { err: e.code };
      else { fail(i, s.op, 'threw-non-VaultError', s.expect, String(e?.stack ?? e)); return; }
    }
    const want = s.expect;
    const same = want === 'ok' ? got === 'ok' : (typeof got === 'object' && got.err === want?.err);
    if (!same) fail(i, s.op, 'expect', want, got);
    if (!s.state) return;
    const obs = model.observe(s.t);
    for (const [k, v] of Object.entries(s.state)) {
      if (k === 'received' || k === 'agent_received') {
        const map = k === 'received' ? v : { [model.mandate?.agent ?? 'agent']: v };
        for (const [role, amt] of Object.entries(map)) {
          if (model.receivedBy(role) !== BigInt(amt)) fail(i, s.op, `received.${role}`, amt, show(model.receivedBy(role)));
        }
      } else if (STATE_KEYS.includes(k)) {
        const exp = typeof v === 'boolean' ? v : BigInt(v);
        if (obs[k] !== exp) fail(i, s.op, `state.${k}`, v, show(obs[k]));
      } else fail(i, s.op, `unknown-state-key.${k}`, v, undefined);
    }
  });
  return res;
}
