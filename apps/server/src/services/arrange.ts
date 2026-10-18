import { z } from 'zod';

// One-click tools that rewrite a custom channel's draft list (behavior modelled on dizqueTV's programming tools).
// They only reorder, drop or copy entries: moved entries keep their IDs, copies get new ones.
export type ArrangeEntry = { entryId: string; mediaId: string; kind: 'movie' | 'episode'; title: string; showId?: string; showTitle?: string; season?: number; episode?: number; date?: string; year?: number };
export const arrangeInput = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('shuffle') }).strict(),
  // Runs of `size` episodes of a show stay together, and each show keeps its episode order.
  z.object({ tool: z.literal('blockShuffle'), size: z.number().int().min(1).max(20) }).strict(),
  z.object({ tool: z.literal('sortShows') }).strict(),
  z.object({ tool: z.literal('sortDate') }).strict(),
  z.object({ tool: z.literal('interleave') }).strict(),
  z.object({ tool: z.literal('removeDuplicates') }).strict(),
  z.object({ tool: z.literal('removeSpecials') }).strict(),
  z.object({ tool: z.literal('replicate'), times: z.number().int().min(2).max(10) }).strict(),
]);
export type ArrangeInput = z.infer<typeof arrangeInput>;
export const MAX_ENTRIES = 10000;

const MOVIES = '\0movies';
const groupKey = (e: ArrangeEntry) => e.kind === 'episode' ? `show:${e.showId ?? e.showTitle ?? e.title}` : MOVIES;
const missing = Number.MAX_SAFE_INTEGER;
export const natural = (a: { season?: number; episode?: number }, b: { season?: number; episode?: number }) => (a.season ?? missing) - (b.season ?? missing) || (a.episode ?? missing) - (b.episode ?? missing);
const text = (a = '', b = '') => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
// Groups in order of first appearance; each group keeps its current relative order.
function groups<T extends ArrangeEntry>(entries: T[]) {
  const map = new Map<string, T[]>();
  for (const e of entries) { const key = groupKey(e), list = map.get(key); if (list) list.push(e); else map.set(key, [e]); }
  return map;
}
const dated = (e: ArrangeEntry) => e.date ?? (e.year !== undefined ? `${String(e.year).padStart(4, '0')}-99-99` : undefined);

export function arrange<T extends ArrangeEntry>(entries: T[], input: ArrangeInput, newId: () => string, random: () => number = Math.random): T[] {
  const list = [...entries];
  switch (input.tool) {
    case 'shuffle':
      for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [list[i], list[j]] = [list[j]!, list[i]!]; }
      return list;
    case 'blockShuffle': {
      // Weighted by blocks left, so long shows spread across the whole list instead of bunching at the end.
      const queues = [...groups(list).values()].map(g => { const blocks: T[][] = []; for (let i = 0; i < g.length; i += input.size) blocks.push(g.slice(i, i + input.size)); return blocks; });
      const out: T[] = [];
      let left = queues.reduce((n, q) => n + q.length, 0);
      while (left > 0) {
        let pick = Math.floor(random() * left);
        const queue = queues.find(q => (pick -= q.length) < 0)!;
        out.push(...queue.shift()!); left--;
      }
      return out;
    }
    case 'sortShows': {
      const shows = [...groups(list.filter(e => e.kind === 'episode')).values()].map(g => [...g].sort(natural)).sort((a, b) => text(a[0]!.showTitle, b[0]!.showTitle));
      return [...shows.flat(), ...list.filter(e => e.kind === 'movie').sort((a, b) => text(a.title, b.title))];
    }
    case 'sortDate':
      return list.map((e, i) => ({ e, i })).sort((a, b) => {
        const x = dated(a.e), y = dated(b.e);
        if (x !== y) return x === undefined ? 1 : y === undefined ? -1 : x < y ? -1 : 1;
        return (groupKey(a.e) === groupKey(b.e) ? natural(a.e, b.e) : 0) || a.i - b.i;
      }).map(r => r.e);
    case 'interleave': {
      // One from each show in turn (movies count as one more show), keeping every show's order.
      const queues = [...groups(list).values()], out: T[] = [];
      while (out.length < list.length) for (const q of queues) { const next = q.shift(); if (next) out.push(next); }
      return out;
    }
    case 'removeDuplicates': {
      const seen = new Set<string>();
      return list.filter(e => !seen.has(e.mediaId) && !!seen.add(e.mediaId));
    }
    case 'removeSpecials':
      return list.filter(e => !(e.kind === 'episode' && e.season === 0));
    case 'replicate': {
      const out = [...list];
      for (let i = 1; i < input.times && out.length + list.length <= MAX_ENTRIES; i++) out.push(...list.map(e => ({ ...e, entryId: newId() })));
      return out;
    }
  }
}
