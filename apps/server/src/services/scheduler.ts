import type { Db } from '../persistence/database.js';
import { requireThat } from '../errors.js';
import { z } from 'zod';

export const playlistSchema = z.array(z.object({ occurrenceId: z.string().min(1), mediaId: z.string().min(1), title: z.string(), durationMs: z.number().int().positive().max(86400000), mediaOffsetMs: z.number().int().nonnegative().default(0) }).strict()).min(1).max(10000);
export type Entry = z.infer<typeof playlistSchema>[number];
export type Timeline = { revision: number; effectiveAt: number; entries: Entry[]; cutoverAfterEntryId?: string; nextEntryId: string; reason: 'INITIAL' | 'SUCCESSOR' | 'FIRST_ENTRY' };
export function validatePlaylist(entries: Entry[]) {
  const valid = playlistSchema.parse(entries);
  requireThat(new Set(valid.map(e => e.occurrenceId)).size === valid.length, 'DUPLICATE_OCCURRENCE', 'Repeated media needs distinct occurrence IDs.'); return valid;
}
export function resolveSlot(timeline: Timeline, now: number) {
  requireThat(Number.isSafeInteger(now) && now >= timeline.effectiveAt, 'CHANNEL_NOT_STARTED', 'Channel has not started.', 409);
  const total = timeline.entries.reduce((n, e) => n + e.durationMs, 0);
  requireThat(total > 0 && Number.isSafeInteger(total), 'INVALID_TIMELINE', 'Invalid channel timeline.');
  let offset = (now - timeline.effectiveAt) % total;
  for (const entry of timeline.entries) {
    if (offset < entry.durationMs) return { entry, revision: timeline.revision, start: now - offset, end: now - offset + entry.durationMs, offsetMs: entry.mediaOffsetMs + offset };
    offset -= entry.durationMs;
  }
  throw new Error('Invalid timeline');
}
export class ChannelScheduler {
  constructor(private db: Db) {}
  timeline(channelId: string, now: number): Timeline {
    const row = this.db.prepare('SELECT value FROM publications WHERE channel_id=? AND superseded=0 AND effective_at<=? ORDER BY effective_at DESC,revision DESC LIMIT 1').get(channelId, now) as {value: string} | undefined;
    requireThat(row, 'CHANNEL_NOT_STARTED', 'No published program at this time.', 404);
    return JSON.parse(row.value) as Timeline;
  }
  current(channelId: string, now: number) { return resolveSlot(this.timeline(channelId, now), now); }
  publish(channelId: string, entries: Entry[], expectedRevision: number, now: number, actor: string): Timeline {
    const valid = validatePlaylist(entries);
    requireThat(Number.isSafeInteger(now), 'INVALID_TIME', 'Invalid publication time.');
    return this.db.transaction(() => {
      const channel = this.db.prepare('SELECT revision FROM channels WHERE id=?').get(channelId) as {revision: number} | undefined;
      requireThat((channel?.revision ?? 0) === expectedRevision, 'REVISION_CONFLICT', 'Channel changed. Reload the draft.', 409);
      if (!channel) this.db.prepare('INSERT INTO channels VALUES(?,0)').run(channelId);
      const current = channel ? this.current(channelId, now) : undefined;
      const retainedIndex = current ? valid.findIndex(e => e.occurrenceId === current.entry.occurrenceId) : -1;
      const startIndex = retainedIndex >= 0 ? (retainedIndex + 1) % valid.length : 0;
      const ordered = [...valid.slice(startIndex), ...valid.slice(0, startIndex)];
      const publication: Timeline = { revision: expectedRevision + 1, effectiveAt: current?.end ?? now, entries: ordered,
        nextEntryId: ordered[0]!.occurrenceId, ...(current ? {cutoverAfterEntryId: current.entry.occurrenceId} : {}),
        reason: !current ? 'INITIAL' : retainedIndex >= 0 ? 'SUCCESSOR' : 'FIRST_ENTRY' };
      this.db.prepare('UPDATE publications SET superseded=1 WHERE channel_id=? AND superseded=0 AND effective_at>?').run(channelId, now);
      this.db.prepare('INSERT INTO publications(channel_id,revision,effective_at,value) VALUES(?,?,?,?)').run(channelId, publication.revision, publication.effectiveAt, JSON.stringify(publication));
      this.db.prepare('UPDATE channels SET revision=? WHERE id=?').run(publication.revision, channelId);
      this.db.prepare('INSERT INTO audit(actor,event,at,detail) VALUES(?,?,?,?)').run(actor, 'channel_published', now, JSON.stringify({channelId, revision: publication.revision, effectiveAt: publication.effectiveAt, nextEntryId: publication.nextEntryId, reason: publication.reason}));
      return publication;
    })();
  }
  guide(channelId: string, start: number, end: number) {
    requireThat(start < end && end - start <= 7 * 86400000, 'INVALID_WINDOW', 'Guide window must be at most seven days.');
    const slots: ReturnType<ChannelScheduler['current']>[] = []; let cursor = start;
    while (cursor < end) {
      requireThat(slots.length < 10000, 'GUIDE_LIMIT', 'Guide contains too many entries.');
      const slot = this.current(channelId, cursor); slots.push(slot); cursor = slot.end;
    }
    return slots;
  }
}
