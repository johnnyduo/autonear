// Pure rules check for the "Try the limits" box on the product pages (no DOM). web/public/contract-sim.js is a static file that
// cannot import, so it carries a copy of the block between the BEGIN/END markers. contract-sim-core.test.js checks the two copies are identical.
// Input: { method, allowed: [method names], amount, perCall, perPeriod, spent } in plain units.
// Output: { steps: [{ text, ok }], accepted, code, reason }. The code names follow the real vault (E_<Code>).
// BEGIN simulate
function simulate(input) {
  const i = input || {};
  const steps = [];
  const allowed = Array.isArray(i.allowed) ? i.allowed : [];
  const amount = Number(i.amount);
  const perCall = Math.max(0, Number(i.perCall) || 0);
  const perPeriod = Math.max(0, Number(i.perPeriod) || 0);
  const left = Math.max(0, perPeriod - Math.max(0, Number(i.spent) || 0));
  const method = String(i.method == null ? '' : i.method);
  const refuse = (code, reason) => ({ steps, accepted: false, code, reason });
  const onList = allowed.indexOf(method) >= 0;
  steps.push({ text: onList ? 'method ' + method + ' is on the allowlist' : 'method ' + method + ' is not on the allowlist', ok: onList });
  if (!onList) return refuse('E_TemplateNotAllowed', 'the method is not on the allowlist');
  const whole = isFinite(amount) && amount > 0 && Math.floor(amount) === amount;
  steps.push({ text: whole ? 'amount ' + amount + ' is a positive whole number' : 'amount is not a positive whole number', ok: whole });
  if (!whole) return refuse('E_BadAmount', 'the amount must be a positive whole number');
  const withinCall = amount <= perCall;
  steps.push({ text: withinCall ? 'amount ' + amount + ' is within the per-call cap of ' + perCall : 'amount ' + amount + ' is above the per-call cap of ' + perCall, ok: withinCall });
  if (!withinCall) {
    steps.push({ text: 'owner approval is needed above the cap', ok: false });
    return refuse('E_PerDrawCap', 'the amount is above the per-call cap');
  }
  const withinPeriod = amount <= left;
  steps.push({ text: withinPeriod ? 'amount ' + amount + ' is within the ' + left + ' left in this period' : 'amount ' + amount + ' is above the ' + left + ' left in this period', ok: withinPeriod });
  if (!withinPeriod) return refuse('E_PeriodCap', 'the amount is above what is left in this period');
  steps.push({ text: 'no owner approval needed at this amount', ok: true });
  return { steps, accepted: true, code: null, reason: 'every limit holds' };
}
// END simulate

export { simulate };
