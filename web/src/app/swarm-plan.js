// Pure scheduling for the swarm replay (no DOM). web/public/swarm.js is a static file that cannot import,
// so it carries a copy of the block between the BEGIN/END markers. swarm-plan.test.js checks the two copies are identical.
// Input: elements in document order, parents before children: [{ id, kind, agent?, parent?, len? }].
// Output: [{ id, agent, owner, start, duration, kind, deps, stolen, len }] with times in ms from the start of the build phase.
// BEGIN planTasks (keep in sync with web/src/app/swarm-plan.js)
function planTasks(elements, opts) {
  const agents = opts && opts.agents && opts.agents.length ? opts.agents.slice() : ['Copy', 'Layout', 'Style', 'Media', 'Check'];
  const totalMs = opts && opts.totalMs > 0 ? opts.totalMs : 16800;
  const steal = !(opts && opts.steal === false);
  const MIN = 120;
  const MAX = 1800;
  const KIND_AGENT = { text: 'Copy', box: 'Layout', line: 'Style', media: 'Media', button: 'Layout' };
  const BASE = { box: 1, text: 1, button: 0.8, line: 0.7, media: 1.3 };
  const index = {};
  const items = elements.map((el, i) => {
    index[el.id] = i;
    const kind = Object.prototype.hasOwnProperty.call(BASE, el.kind) ? el.kind : 'box';
    let owner = el.agent && agents.indexOf(el.agent) >= 0 ? el.agent : KIND_AGENT[kind];
    if (agents.indexOf(owner) < 0) owner = agents[i % agents.length];
    const len = kind === 'text' ? Math.max(0, el.len || 0) : 0;
    const weight = BASE[kind] + Math.min(len, 400) / 40;
    const parent = el.parent != null && index[el.parent] !== undefined && index[el.parent] < i ? index[el.parent] : -1;
    return { id: el.id, kind, owner, ownerIdx: agents.indexOf(owner), weight, parent, len };
  });
  const n = items.length;
  const queues = agents.map(() => []);
  items.forEach((it, i) => queues[it.ownerIdx].push(i));

  function simulate(unit) {
    const dur = items.map((it) => Math.round(Math.min(MAX, Math.max(MIN, it.weight * unit))));
    const free = agents.map(() => 0);
    const start = new Array(n).fill(-1);
    const end = new Array(n).fill(-1);
    const by = new Array(n).fill(-1);
    const ready = (i) => items[i].parent < 0 || start[items[i].parent] >= 0;
    const ready0 = (i) => (items[i].parent < 0 ? 0 : end[items[i].parent]);
    let left = n;
    let makespan = 0;
    while (left > 0) {
      let best = null;
      const consider = (a, i, stolen) => {
        const s = Math.max(free[a], ready0(i));
        if (!best || s < best.s || (s === best.s && (stolen ? 1 : 0) < (best.stolen ? 1 : 0)) || (s === best.s && stolen === best.stolen && i < best.i)) best = { a, i, s, stolen };
      };
      for (let a = 0; a < agents.length; a++) {
        const q = queues[a];
        let own = -1;
        for (let k = 0; k < q.length; k++) if (start[q[k]] < 0) { own = q[k]; break; }
        if (own >= 0 && ready(own)) consider(a, own, false);
        if (!steal) continue;
        for (let b = 0; b < agents.length; b++) {
          if (b === a) continue;
          for (let k = 0; k < queues[b].length; k++) {
            const i = queues[b][k];
            if (start[i] >= 0 || !ready(i)) continue;
            // help only when this agent can start it strictly earlier than its owner could
            if (Math.max(free[a], ready0(i)) < Math.max(free[b], ready0(i))) consider(a, i, true);
            break;
          }
        }
      }
      if (!best) break;
      start[best.i] = best.s;
      end[best.i] = best.s + dur[best.i];
      by[best.i] = best.a;
      free[best.a] = end[best.i];
      if (end[best.i] > makespan) makespan = end[best.i];
      left--;
    }
    return { dur, start, by, makespan };
  }

  let sim = simulate(MAX / 0.7 + 1);
  if (sim.makespan > totalMs) {
    sim = simulate(0);
    if (sim.makespan > totalMs) {
      // even the shortest allowed tasks do not fit: keep the clamp, the plan runs long
    } else {
      let lo = 0;
      let hi = MAX / 0.7 + 1;
      for (let k = 0; k < 32; k++) {
        const mid = (lo + hi) / 2;
        if (simulate(mid).makespan <= totalMs) lo = mid; else hi = mid;
      }
      sim = simulate(lo);
    }
  }
  return items.map((it, i) => ({
    id: it.id,
    agent: agents[sim.by[i]],
    owner: it.owner,
    start: sim.start[i],
    duration: sim.dur[i],
    kind: it.kind,
    deps: it.parent >= 0 ? [items[it.parent].id] : [],
    stolen: agents[sim.by[i]] !== it.owner,
    len: it.len,
  }));
}
// END planTasks

export { planTasks };
