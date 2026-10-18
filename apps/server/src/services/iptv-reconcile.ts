import { randomUUID } from 'node:crypto';
import type { M3uChannel, M3uSnapshot } from '../providers/iptv.js';
import { requireThat } from '../errors.js';

export type ImportedChannel = { id: string; provider: M3uChannel; status: 'pending' | 'approved' | 'ignored' | 'conflict'; present: boolean; adminEnabled: boolean; number?: number; order?: number; displayName?: string; missingSince?: number };
export type ImportState = { sourceId: string; revision: number; autoAddNewChannels: boolean; refreshIntervalHours: number; channels: ImportedChannel[] };
export const newSource = (sourceId: string): ImportState => ({ sourceId, revision: 0, autoAddNewChannels: false, refreshIntervalHours: 12, channels: [] });
// Pure reconciliation spike. The caller must establish transport completeness BEFORE committing.
// A syntactically valid M3U alone cannot prove a provider delivered a complete snapshot.
export function reconcile(state: ImportState, snapshot: M3uSnapshot, expectedRevision: number, completeTransport: boolean, reservedNumbers: number[], now: number): ImportState {
  requireThat(expectedRevision === state.revision, 'REVISION_CONFLICT', 'Source revision changed.', 409);
  requireThat(completeTransport && snapshot.channels.length, 'UNTRUSTED_SNAPSHOT', 'Incomplete or empty snapshot cannot replace the lineup.');
  const result: ImportState = structuredClone(state); result.revision++;
  const reserved = new Set([...reservedNumbers, ...state.channels.flatMap(c => c.number ? [c.number] : [])]);
  const seen = new Set<string>();
  for (const entry of snapshot.channels) {
    // Missing provider IDs remain a review concern; do not infer stable identity from names/URLs.
    if (!entry.tvgId) {
      if (!result.channels.some(c => !c.provider.tvgId && c.provider.streamUrl === entry.streamUrl)) result.channels.push({ id: randomUUID(), provider: entry, status: 'conflict', present: false, adminEnabled: false });
      continue;
    }
    if (seen.has(entry.tvgId)) continue; seen.add(entry.tvgId);
    const duplicates = snapshot.channels.filter(c => c.tvgId === entry.tvgId).length !== 1;
    const old = result.channels.find(c => c.provider.tvgId === entry.tvgId);
    // Stable IDs can be recycled. Name changes need manual corroboration in this conservative spike.
    const conflict = duplicates || !!(old && old.provider.name !== entry.name);
    if (old) {
      if (conflict) { old.status = 'conflict'; old.present = false; continue; }
      old.provider = entry; old.present = true; delete old.missingSince;
    } else {
      const admitted = state.autoAddNewChannels && !conflict;
      let number: number | undefined;
      if (admitted) { number = 1; while (reserved.has(number)) number++; reserved.add(number); }
      result.channels.push({ id: randomUUID(), provider: entry, status: conflict ? 'conflict' : admitted ? 'approved' : 'pending', present: !conflict, adminEnabled: true, ...(number ? {number, order: reserved.size} : {}) });
    }
  }
  for (const c of result.channels) if (c.status === 'approved' && !seen.has(c.provider.tvgId)) { c.present = false; c.missingSince ??= now; }
  return result;
}
export const viewerChannels = (state: ImportState) => state.channels.filter(c => c.status === 'approved' && c.present && c.adminEnabled).map(c => ({ id: c.id, name: c.displayName ?? c.provider.name, number: c.number, order: c.order }));
