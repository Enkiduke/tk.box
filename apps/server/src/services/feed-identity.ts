import type { M3uChannel } from '../providers/iptv.js';
import { digest } from '../security/vault.js';

export type SavedFeed = { id: string; identity: string; provider: M3uChannel };
export type IdentityConflict = { reason: 'changed' | 'ambiguous'; candidates: M3uChannel[] };
// Only exact repeated entries are duplicates. A guide ID, name or URL alone is not a feed identity.
export const entryKey = (p: M3uChannel) => digest(JSON.stringify([p.tvgId, p.name, p.group, p.streamUrl]));
const family = (p: M3uChannel) => JSON.stringify(p.tvgId ? ['id', p.tvgId] : ['name', p.name]);
function index<T>(values: T[], key: (v: T) => string | undefined) {
  const groups = new Map<string, T[]>();
  for (const v of values) { const k = key(v); if (k === undefined) continue; const group = groups.get(k); if (group) group.push(v); else groups.set(k, [v]); }
  return groups;
}

// Match in order of evidence, requiring uniqueness on BOTH sides of the whole snapshot (not just
// the leftovers). This prevents a disappearing HD feed from stealing an SD feed's saved settings.
export function planFeeds(previous: SavedFeed[], incoming: M3uChannel[]) {
  const entries = [...new Map(incoming.map(p => [entryKey(p), p])).values()];
  const prior = previous.filter(p => !p.identity.startsWith('retired:'));
  const matches = new Map<string, M3uChannel>(), used = new Set<M3uChannel>();
  const conflicts = new Map<string, IdentityConflict>();
  const keys: ((p: M3uChannel) => string | undefined)[] = [
    entryKey,
    p => JSON.stringify([p.tvgId, p.name, p.streamUrl]),
    p => JSON.stringify([p.tvgId, p.streamUrl]),
    p => JSON.stringify([p.tvgId, p.name, p.group]),
    p => JSON.stringify([p.tvgId, p.name]),
    // A provider can correct its guide ID without changing the feed itself.
    p => JSON.stringify([p.name, p.streamUrl]),
    p => p.tvgId ? family(p) : undefined
  ];
  for (const key of keys) {
    const oldGroups = index(prior, p => key(p.provider)), newGroups = index(entries, key);
    for (const [k, old] of oldGroups) {
      const candidates = newGroups.get(k);
      if (old.length !== 1 || candidates?.length !== 1) continue;
      const saved = old[0]!, p = candidates[0]!;
      if (matches.has(saved.id) || used.has(p)) continue;
      matches.set(saved.id, p); used.add(p);
      if (saved.provider.name !== p.name && saved.provider.streamUrl !== p.streamUrl)
        conflicts.set(saved.id, { reason: 'changed', candidates: [p] });
    }
  }
  const remaining = index(entries.filter(p => !used.has(p)), family), blocked = new Set<M3uChannel>();
  for (const saved of prior) {
    if (matches.has(saved.id)) continue;
    const candidates = remaining.get(family(saved.provider));
    if (!candidates?.length) continue;
    conflicts.set(saved.id, { reason: 'ambiguous', candidates });
    for (const p of candidates) blocked.add(p);
  }
  const present = new Set([...matches.keys(), ...conflicts.keys()]);
  return { entries, matches, conflicts, present, added: entries.filter(p => !used.has(p) && !blocked.has(p)) };
}
