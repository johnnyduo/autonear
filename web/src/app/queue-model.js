// Pure helpers for the "Up next" list in the council score box (no React, no DOM), so they run in plain Node tests.
// Rows come from GET /api/council: queue[] = { oppId, title, slug, support, verdict, pageReady, contractTemplate, page: 'published' | 'built' | 'none' }, in rank order.
import { GO_AT, score } from './build-model.js';

export const FIRST_ROWS = 4;

/** The product the server shows by default: the first page-ready product whose page is not published. Null when there is none. */
export const queueHead = (queue) => (Array.isArray(queue) ? queue : []).find((x) => x.pageReady && x.page !== 'published')?.oppId ?? null;

/** One status tag per row: { key, text }. A stored page wins over the score. */
export function queueTag(item, words, goAt = GO_AT) {
  if (item?.page === 'published') return { key: 'published', text: words.tagPublished };
  if (item?.page === 'built') return { key: 'built', text: words.tagBuilt };
  if (item?.pageReady) return { key: 'ready', text: words.tagReady };
  return { key: 'needs', text: words.tagNeeds(score(goAt)) };
}

/** The rows to draw. Collapsed: the first `limit`, plus the focused row when it ranks lower, so the marked row is never hidden. */
export function visibleQueue(queue, { showAll = false, focus = null, limit = FIRST_ROWS } = {}) {
  const all = Array.isArray(queue) ? queue : [];
  if (showAll || all.length <= limit) return all;
  const head = all.slice(0, limit); const f = all.slice(limit).find((x) => x.oppId === focus);
  return f ? [...head, f] : head;
}

/** The toggle only exists when some row is hidden or the list is expanded. */
export const hasToggle = (queue, limit = FIRST_ROWS) => (Array.isArray(queue) ? queue.length : 0) > limit;
