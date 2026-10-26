import { hidesFromRecent } from '../../../../packages/contracts/src/collections.js';

// A collection's name as the collections engine compares it (collection_key in engine_common.py): case, punctuation and
// a trailing "Collection" ignored.
export const collectionKey = (name: string) => name.trim().toLowerCase().replace(/\s+collection$/, '').replace(/[^a-z0-9]/g, '');

// The TMDb IDs of the movies Radarr downloaded for custom collections that stay off Recently added. The collections
// engine's journal (collections-state.json) names each download's collections as "library:key"; a movie is hidden when
// any of them hides its downloads. One whose collections are all gone shows again.
export function hiddenDownloads(journal: unknown, definitions: Record<string, unknown>[] | null) {
  const hiding = new Set((definitions ?? []).filter(d => typeof d.name === 'string' && typeof d.library === 'string' && hidesFromRecent(d))
    .map(d => `${d.library as string}:${collectionKey(d.name as string)}`));
  const movies = (journal as { movies?: unknown } | null)?.movies, hidden = new Set<number>();
  if (!hiding.size || typeof movies !== 'object' || movies === null) return hidden;
  for (const [id, record] of Object.entries(movies)) {
    const owners = (record as { owners?: unknown } | null)?.owners;
    if (/^\d{1,10}$/.test(id) && Array.isArray(owners) && owners.some(o => hiding.has(o))) hidden.add(Number(id));
  }
  return hidden;
}
