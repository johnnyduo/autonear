// Hash routing helpers. `?fixture=1` (demo) and `?activity=1` (drawer) live inside the hash so Back/Forward behave and links stay shareable.
export const hashParts = () => { const [path, q = ''] = (location.hash || '#/').replace(/^#\/?/, '').split('?'); return { segs: path.split('/').filter(Boolean), q: new URLSearchParams(q) }; };
export const href = (path, { demo = false, activity = false } = {}) => { const q = new URLSearchParams(); if (demo) q.set('fixture', '1'); if (activity) q.set('activity', '1'); const s = q.toString(); return `#/${path}${s ? `?${s}` : ''}`; };
export const goto = (path, opts) => { location.hash = href(path, opts); };
export const APP_ROUTES = ['home', 'council', 'approvals', 'watch', 'vault'];
export const parseRoute = () => {
  const { segs, q } = hashParts();
  let name = segs[0] ?? 'home'; if (name === 'overview') name = 'home';
  return { name, params: segs.slice(1), demo: q.get('fixture') === '1', activity: q.get('activity') === '1' };
};
