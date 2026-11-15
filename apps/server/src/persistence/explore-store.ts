import { z } from 'zod';
import { exploreBrowseSources, tmdbExploreRows, type ExploreLayout } from '../../../../packages/contracts/src/index.js';
import type { Db } from './database.js';
import { AppError } from '../errors.js';

const exploreSource = z.enum(exploreBrowseSources);
export const exploreLayoutInput = z.object({
  order: z.array(exploreSource).max(exploreBrowseSources.length).refine(list => new Set(list).size === list.length, 'List each source once'),
  hidden: z.array(exploreSource).max(exploreBrowseSources.length),
  hiddenRows: z.array(z.string().max(820).regex(/^(plex|tmdb):\S+$/)).max(300),
  tmdbOrder: z.array(z.enum(tmdbExploreRows)).max(tmdbExploreRows.length).refine(list => new Set(list).size === list.length, 'List each row once').optional()
}).strict();
// The Plex watchlist is off until the administrator shows it.
export const defaultExploreLayout: ExploreLayout = { order: ['tmdb', 'plex'], hidden: [], hiddenRows: ['plex:watchlist'] };
export const tmdbRowOrder = (order: ExploreLayout['tmdbOrder'] = []) => [...order, ...tmdbExploreRows.filter(row => !order.includes(row))];
// Personal rows that were split by kind, or retired (the genre rows): each old id becomes its new rows in its place.
const renamedRows: Record<string, string[]> = { 'top-picks': ['top-movies', 'top-shows'], 'because-1': ['because-movie'], 'because-2': ['because-show'], 'genre-1': [], 'genre-2': [] };
const renamed = (list: unknown, prefix = '') => Array.isArray(list) ? [...new Set(list.flatMap(id => {
  if (typeof id !== 'string' || !id.startsWith(prefix)) return [id];
  const next = renamedRows[id.slice(prefix.length)];
  return next ? next.map(row => prefix + row) : [id];
}))] : list;
// Retire old browse sources and rows while preserving the viewer-facing order and visibility of current rows.
export function exploreLayout(value: Partial<ExploreLayout> | undefined): ExploreLayout {
  const drop = (list: unknown) => Array.isArray(list) ? list.filter(s => typeof s !== 'string' || !/^(trakt|seerr)(:|$)/.test(s)) : list;
  const saved = { ...defaultExploreLayout, ...value };
  const parsed = exploreLayoutInput.safeParse({ order: drop(saved.order), hidden: drop(saved.hidden), hiddenRows: renamed(drop(saved.hiddenRows), 'tmdb:'), tmdbOrder: renamed(saved.tmdbOrder) });
  const layout = parsed.success ? parsed.data : defaultExploreLayout;
  return { order: [...layout.order, ...defaultExploreLayout.order.filter(s => !layout.order.includes(s))], hidden: [...new Set(layout.hidden)], hiddenRows: [...new Set(layout.hiddenRows)], ...(layout.tmdbOrder && { tmdbOrder: tmdbRowOrder(layout.tmdbOrder) }) };
}
export class ExploreStore {
  constructor(private db: Db) {}
  // How Explore is laid out.
  layout(): ExploreLayout & { revision: number } {
    const row = this.db.prepare('SELECT revision,value FROM explore_layout WHERE id=1').get() as { revision: number; value: string } | undefined;
    return { revision: row?.revision ?? 0, ...exploreLayout(row ? JSON.parse(row.value) as Partial<ExploreLayout> : undefined) };
  }
  updateLayout(actor: string, expectedRevision: number, input: ExploreLayout, now = Date.now()) {
    const next = exploreLayout(exploreLayoutInput.parse(input));
    return this.db.transaction(() => {
      const { revision } = this.layout();
      if (revision !== expectedRevision) throw new AppError('REVISION_CONFLICT', 'Settings changed. Reload and retry.', 409);
      if (input.tmdbOrder === undefined) next.tmdbOrder = this.layout().tmdbOrder;
      this.db.prepare('INSERT INTO explore_layout VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value=excluded.value').run(revision + 1, JSON.stringify(next));
      this.db.prepare('INSERT INTO audit(actor,event,at,detail) VALUES(?,?,?,?)').run(actor, 'explore_layout_changed', now, JSON.stringify(next));
      return this.layout();
    })();
  }
}
