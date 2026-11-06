/*
 * "Try the limits" on the concept pages. Nothing here talks to a network: it reads the form, runs simulate() and prints a short step log.
 * The rules check is a copy of web/src/app/contract-sim-core.js (a test keeps the two identical).
 * Markup contract: one element with data-sim="form" holding data-sim="method" (select), data-sim="allow" (checkboxes, value = method name),
 * "amount", "percall", "perperiod" (inputs), "percall-out", "perperiod-out" (text), "spent" (text), "meter" (bar), "log", "run", "reset".
 */
(function () {
  'use strict';

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

  const LINE_MS = 290; // a new line starts every 290 ms
  const TYPE_MS = 240; // and is typed in 240 ms

  function wire(form) {
    const q = (name) => form.querySelector('[data-sim="' + name + '"]');
    const els = { method: q('method'), amount: q('amount'), perCall: q('percall'), perPeriod: q('perperiod'), perCallOut: q('percall-out'), perPeriodOut: q('perperiod-out'), spent: q('spent'), meter: q('meter'), log: q('log'), run: q('run'), reset: q('reset') };
    if (!els.method || !els.amount || !els.perCall || !els.perPeriod || !els.log || !els.run) return;
    const allow = Array.prototype.slice.call(form.querySelectorAll('[data-sim="allow"]'));
    const still = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    let spent = 0;
    let timer = 0;

    function showLimits() {
      if (els.perCallOut) els.perCallOut.textContent = els.perCall.value;
      if (els.perPeriodOut) els.perPeriodOut.textContent = els.perPeriod.value;
      const cap = Number(els.perPeriod.value) || 0;
      if (els.spent) els.spent.textContent = spent + ' of ' + cap + ' used this period';
      if (els.meter) els.meter.style.width = (cap > 0 ? Math.min(100, (spent / cap) * 100) : 0) + '%';
    }

    function clearLog() {
      if (timer) { window.clearInterval(timer); timer = 0; }
      els.log.textContent = '';
      els.log.removeAttribute('aria-busy');
      els.run.disabled = false;
    }

    function print(result, amount) {
      const rows = result.steps.map((s) => ({ tag: s.ok ? 'pass' : 'fail', cls: s.ok ? 'ok' : 'no', text: s.text }));
      rows.push({ tag: result.accepted ? 'ACCEPTED' : 'REFUSED', cls: result.accepted ? 'done ok' : 'done no', text: result.accepted ? result.reason : result.code + ': ' + result.reason });
      const made = rows.map(() => null);
      const begin = window.performance.now();
      els.log.setAttribute('aria-busy', 'true');
      els.run.disabled = true;
      function tick() {
        const t = still ? 1e9 : window.performance.now() - begin;
        let finished = true;
        rows.forEach((row, k) => {
          const start = k * LINE_MS;
          if (t < start) { finished = false; return; }
          if (!made[k]) {
            const line = document.createElement('div');
            line.className = 'sim-line ' + row.cls;
            const tag = document.createElement('span');
            tag.className = 'sim-tag';
            tag.textContent = row.tag;
            const text = document.createElement('span');
            text.className = 'sim-text';
            line.appendChild(tag);
            line.appendChild(text);
            els.log.appendChild(line);
            made[k] = text;
          }
          const n = Math.min(row.text.length, Math.ceil(row.text.length * Math.min(1, (t - start) / TYPE_MS)));
          if (made[k].textContent.length !== n) made[k].textContent = row.text.slice(0, n);
          if (n < row.text.length) finished = false;
        });
        els.log.scrollTop = els.log.scrollHeight;
        if (finished) {
          window.clearInterval(timer);
          timer = 0;
          els.log.removeAttribute('aria-busy');
          els.run.disabled = false;
          if (result.accepted) { spent += amount; showLimits(); }
        }
      }
      tick();
      if (!timer && els.run.disabled) timer = window.setInterval(tick, 30);
    }

    function run() {
      if (timer) return;
      clearLog();
      const allowed = allow.filter((c) => c.checked).map((c) => c.value);
      print(simulate({ method: els.method.value, allowed, amount: els.amount.value, perCall: els.perCall.value, perPeriod: els.perPeriod.value, spent }), Number(els.amount.value));
    }

    form.addEventListener('submit', (e) => { e.preventDefault(); run(); });
    els.perCall.addEventListener('input', showLimits);
    els.perPeriod.addEventListener('input', showLimits);
    if (els.reset) els.reset.addEventListener('click', () => { spent = 0; clearLog(); showLimits(); });
    showLimits();
  }

  function boot() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-sim="form"]'), wire);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
}());
