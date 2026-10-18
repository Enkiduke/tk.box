import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db } from './database.js';
import { requireThat } from '../errors.js';
import { ChannelScheduler, resolveSlot, type Entry, type Slot, type Timeline } from '../services/scheduler.js';
import { arrange, natural, MAX_ENTRIES, type ArrangeInput } from '../services/arrange.js';
import { eligibleVideoEncode } from '../streaming/policy.js';
import type { ChannelMedia } from '../providers/plex.js';
import type { Program } from '../providers/iptv.js';

// Why an entry cannot be published: nothing playable, no runtime, or it would need a video encode the server refuses.
export type EntryIssue = 'no_media' | 'no_duration' | 'incompatible';
export type DraftEntry = { entryId: string; mediaId: string; kind: 'movie' | 'episode'; title: string; showTitle?: string; showId?: string; season?: number; episode?: number;
  year?: number; date?: string; durationMs: number; sourceId?: string; issue?: EntryIssue };
type Row = { id: string; name: string; summary: string; logo_url: string | null; enabled: number; created_at: number; updated_at: number; revision: number; draft: string; published: string | null; number: number | null; position: number | null };
type SourceRow = { id: string; kind: 'show' | 'season'; plex_id: string; title: string; specials: number; auto_add: number; last_checked: number | null; last_result: string | null; last_error: string | null };
export type Selection = { root: { id: string; type: 'movie' | 'show' | 'season' | 'episode'; title: string; season?: number }; items: ChannelMedia[] };
export type GuideSlot = { start: number; end: number; program: Program | null; blank?: true };

const revision = z.number().int().nonnegative();
const logoUrl = z.string().trim().max(2000).url().refine(u => /^https?:\/\//i.test(u), 'Use an http(s) address.').nullable();
export const customCreate = z.object({ name: z.string().trim().min(1).max(120), number: z.number().int().min(1).max(999999).optional(), summary: z.string().trim().max(1000).default(''), logoUrl: logoUrl.optional() }).strict();
export const customEdit = z.object({ expectedRevision: revision, name: z.string().trim().min(1).max(120).optional(), number: z.number().int().min(1).max(999999).optional(), summary: z.string().trim().max(1000).optional(), logoUrl: logoUrl.optional(), enabled: z.boolean().optional() }).strict();
export const customOrder = z.object({ ids: z.array(z.string().uuid()).max(1000) }).strict();
export const draftAdd = z.object({ expectedRevision: revision, ids: z.array(z.string().regex(/^\d+$/).max(20)).min(1).max(100), at: z.number().int().nonnegative().optional(), specials: z.boolean().default(false) }).strict();
export const draftOrder = z.object({ expectedRevision: revision, entryIds: z.array(z.string().uuid()).max(MAX_ENTRIES) }).strict();
export const draftEntries = z.object({ expectedRevision: revision, entryIds: z.array(z.string().uuid()).min(1).max(MAX_ENTRIES) }).strict();
export const draftRevision = z.object({ expectedRevision: revision }).strict();

const label = (e: DraftEntry) => e.kind === 'episode' ? `S${e.season ?? '?'}E${e.episode ?? '?'} · ${e.title}` : e.year !== undefined ? String(e.year) : undefined;
// Guide/scheduler form of an entry: episodes air under their show's name.
const toEntry = (e: DraftEntry): Entry => ({ occurrenceId: e.entryId, mediaId: e.mediaId, title: e.kind === 'episode' ? e.showTitle ?? e.title : e.title, ...(label(e) ? { subtitle: label(e) } : {}), durationMs: e.durationMs, mediaOffsetMs: 0 });
const sameList = (a: DraftEntry[], b: DraftEntry[]) => a.length === b.length && a.every((e, i) => e.entryId === b[i]!.entryId);
const slotView = (s: Slot) => ({ title: s.entry.title, subtitle: s.entry.subtitle, start: s.start, end: s.end, entryId: s.entry.occurrenceId });
// Copying browser-safe H.264 needs no encode; anything else must be a verified 1080p-or-lower source.
export function entryIssue(m: ChannelMedia): EntryIssue | undefined {
  if (!m.video) return 'no_media';
  if (!(m.durationMs > 0) || m.durationMs > 86400000) return 'no_duration';
  if (m.video.codec?.toLowerCase() !== 'h264' && !eligibleVideoEncode({ codec: m.video.codec ?? '', width: m.video.width, height: m.video.height, container: m.video.container ?? '' })) return 'incompatible';
  return undefined;
}

// Custom channels: administrator-made lists of Plex movies and episodes that play one after another, looping, on the
// shared clock (services/scheduler.ts). Editing changes only the draft; publishing hands over at the end of the airing program.
export class CustomChannelStore {
  readonly scheduler: ChannelScheduler;
  constructor(private db: Db) { this.scheduler = new ChannelScheduler(db); }
  private row(id: string) {
    const row = this.db.prepare('SELECT c.*,n.number,n.position FROM custom_channels c LEFT JOIN lineup_numbers n ON n.channel_id=c.id WHERE c.id=?').get(id) as Row | undefined;
    requireThat(row, 'CHANNEL_NOT_FOUND', 'Channel not found.', 404); return row;
  }
  private rows() { return this.db.prepare('SELECT c.*,n.number,n.position FROM custom_channels c LEFT JOIN lineup_numbers n ON n.channel_id=c.id ORDER BY n.position,c.created_at').all() as Row[]; }
  private check(row: Row, expected: number) { requireThat(row.revision === expected, 'REVISION_CONFLICT', 'Channel changed. Reload and retry.', 409); }
  private audit(actor: string, event: string, detail: Record<string, unknown>, now: number) { this.db.prepare('INSERT INTO audit(actor,event,at,detail) VALUES(?,?,?,?)').run(actor, event, now, JSON.stringify(detail)); }
  private draft(row: Row) { return JSON.parse(row.draft) as DraftEntry[]; }
  private touch(id: string, now: number) { this.db.prepare('UPDATE custom_channels SET revision=revision+1,updated_at=? WHERE id=?').run(now, id); }
  private saveDraft(id: string, entries: DraftEntry[], now: number) {
    requireThat(entries.length <= MAX_ENTRIES, 'DRAFT_TOO_LARGE', `A channel can hold at most ${MAX_ENTRIES.toLocaleString()} programs.`, 413);
    this.db.prepare('UPDATE custom_channels SET draft=? WHERE id=?').run(JSON.stringify(entries), id); this.touch(id, now);
  }
  private number(id: string, number: number | undefined) {
    const existing = this.db.prepare('SELECT number,position FROM lineup_numbers WHERE channel_id=?').get(id) as { number: number; position: number } | undefined;
    if (number !== undefined) {
      const taken = this.db.prepare('SELECT channel_id FROM lineup_numbers WHERE number=? AND channel_id<>?').get(number, id);
      requireThat(!taken, 'NUMBER_CONFLICT', `Channel ${number} is already in use. Pick another number.`, 409);
    } else if (!existing) {
      const used = new Set((this.db.prepare('SELECT number FROM lineup_numbers').all() as { number: number }[]).map(n => n.number)); number = 1; while (used.has(number)) number++;
    }
    const tail = existing ? existing.position : ((this.db.prepare('SELECT MAX(position) AS tail FROM lineup_numbers').get() as { tail: number | null }).tail ?? -1) + 1;
    this.db.prepare('INSERT INTO lineup_numbers VALUES(?,?,?) ON CONFLICT(channel_id) DO UPDATE SET number=excluded.number').run(id, number ?? existing!.number, tail);
  }
  private status(row: Row, now: number) {
    const started = this.scheduler.startedAt(row.id), pending = this.scheduler.pending(row.id, now);
    const published = row.published ? JSON.parse(row.published) as DraftEntry[] : undefined, draft = this.draft(row);
    let current: ReturnType<typeof slotView> | undefined;
    if (started !== undefined && started <= now) current = slotView(this.scheduler.current(row.id, now));
    return { live: started !== undefined, startedAt: started, current, pending: pending && { effectiveAt: pending.effectiveAt, next: pending.entries[0]!.title, nextSubtitle: pending.entries[0]!.subtitle },
      changed: !published ? draft.length > 0 : !sameList(draft, published), publicationRevision: this.scheduler.revision(row.id) };
  }
  private summary(row: Row, now: number) {
    const draft = this.draft(row);
    return { id: row.id, name: row.name, summary: row.summary, logoUrl: row.logo_url, enabled: !!row.enabled, number: row.number, position: row.position, revision: row.revision,
      programs: draft.length, runtimeMs: draft.reduce((n, e) => n + e.durationMs, 0), issues: draft.filter(e => e.issue).length, ...this.status(row, now) };
  }
  list(now = Date.now()) { return this.rows().map(r => this.summary(r, now)); }
  detail(id: string, now = Date.now()) {
    const row = this.row(id), sources = this.db.prepare('SELECT * FROM custom_sources WHERE channel_id=? ORDER BY title').all(id) as SourceRow[];
    return { ...this.summary(row, now), entries: this.draft(row), sources: sources.map(s => ({ id: s.id, kind: s.kind, plexId: s.plex_id, title: s.title })) };
  }
  create(actor: string, input: z.input<typeof customCreate>, now = Date.now()) {
    const v = customCreate.parse(input), id = randomUUID();
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO custom_channels(id,name,summary,logo_url,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, v.name, v.summary, v.logoUrl ?? null, now, now);
      this.number(id, v.number); this.audit(actor, 'custom_channel_created', { id }, now);
    })();
    return this.detail(id, now);
  }
  edit(actor: string, id: string, input: z.input<typeof customEdit>, now = Date.now()) {
    const v = customEdit.parse(input);
    this.db.transaction(() => {
      const row = this.row(id); this.check(row, v.expectedRevision);
      this.db.prepare('UPDATE custom_channels SET name=?,summary=?,logo_url=?,enabled=? WHERE id=?').run(v.name ?? row.name, v.summary ?? row.summary, v.logoUrl === undefined ? row.logo_url : v.logoUrl, v.enabled === undefined ? row.enabled : Number(v.enabled), id);
      if (v.number !== undefined && v.number !== row.number) this.number(id, v.number);
      this.touch(id, now); this.audit(actor, 'custom_channel_edited', { id }, now);
    })();
    return this.detail(id, now);
  }
  remove(actor: string, id: string, expected: number, now = Date.now()) {
    this.db.transaction(() => {
      this.check(this.row(id), expected);
      this.db.prepare('DELETE FROM lineup_numbers WHERE channel_id=?').run(id);
      this.scheduler.forget(id);
      this.db.prepare('DELETE FROM custom_channels WHERE id=?').run(id);
      this.audit(actor, 'custom_channel_deleted', { id }, now);
    })();
  }
  // Lineup order among custom channels, keeping the lineup positions they already hold.
  reorder(actor: string, input: z.input<typeof customOrder>, now = Date.now()) {
    const { ids } = customOrder.parse(input);
    this.db.transaction(() => {
      const rows = this.rows();
      requireThat(ids.length === rows.length && new Set(ids).size === ids.length && rows.every(r => ids.includes(r.id)), 'REVISION_CONFLICT', 'Channels changed. Reload and retry.', 409);
      const positions = rows.map(r => r.position!).sort((a, b) => a - b), put = this.db.prepare('UPDATE lineup_numbers SET position=? WHERE channel_id=?');
      ids.forEach((id, i) => put.run(positions[i], id));
      this.audit(actor, 'custom_channels_reordered', { ids }, now);
    })();
    return this.list(now);
  }
  // Adds Plex selections (already read from Plex by the caller) to the draft. Shows and seasons expand in season then
  // episode order and are recorded as sources; a title already on the channel is skipped (repeats are added on purpose).
  addItems(actor: string, id: string, input: z.input<typeof draftAdd>, selections: Selection[], now = Date.now()) {
    const v = draftAdd.parse(input);
    return this.db.transaction(() => {
      const row = this.row(id); this.check(row, v.expectedRevision);
      const entries = this.draft(row), present = new Set(entries.map(e => e.mediaId)), added: DraftEntry[] = [];
      let skipped = 0, specials = 0;
      for (const { root, items } of selections) {
        let sourceId: string | undefined;
        if (root.type === 'show' || root.type === 'season') {
          const kind = root.type, existing = this.db.prepare('SELECT id FROM custom_sources WHERE channel_id=? AND kind=? AND plex_id=?').get(id, kind, root.id) as { id: string } | undefined;
          sourceId = existing?.id ?? randomUUID();
          if (!existing) this.db.prepare('INSERT INTO custom_sources(id,channel_id,kind,plex_id,title,specials) VALUES(?,?,?,?,?,?)').run(sourceId, id, kind, root.id, root.title, Number(v.specials));
        }
        // Specials (season 0) join a whole show only when asked for; an explicitly chosen season 0 is kept.
        const ordered = root.type === 'show' || root.type === 'season' ? [...items].sort((a, b) => natural(a, b)) : items;
        for (const m of ordered) {
          if (root.type === 'show' && m.season === 0 && !v.specials) { specials++; continue; }
          if (present.has(m.mediaId)) { skipped++; continue; }
          present.add(m.mediaId);
          const issue = entryIssue(m);
          added.push({ entryId: randomUUID(), mediaId: m.mediaId, kind: m.kind, title: m.title, showTitle: m.showTitle, showId: m.showId, season: m.season, episode: m.episode,
            year: m.year, date: m.date, durationMs: m.durationMs, ...(sourceId ? { sourceId } : {}), ...(issue ? { issue } : {}) });
        }
      }
      const at = Math.min(v.at ?? entries.length, entries.length);
      this.saveDraft(id, [...entries.slice(0, at), ...added, ...entries.slice(at)], now);
      return { channel: this.detail(id, now), added: added.length, skipped, specials, issues: added.filter(e => e.issue).length };
    })();
  }
  // A new order for some or all of the draft's entries; entries left out are removed. Entries keep their IDs.
  setOrder(actor: string, id: string, input: z.input<typeof draftOrder>, now = Date.now()) {
    const v = draftOrder.parse(input);
    return this.db.transaction(() => {
      const row = this.row(id); this.check(row, v.expectedRevision);
      const byId = new Map(this.draft(row).map(e => [e.entryId, e]));
      requireThat(new Set(v.entryIds).size === v.entryIds.length && v.entryIds.every(e => byId.has(e)), 'REVISION_CONFLICT', 'The program list changed. Reload and retry.', 409);
      this.saveDraft(id, v.entryIds.map(e => byId.get(e)!), now);
      return this.detail(id, now);
    })();
  }
  // Intentional repeats: a copy of each entry right after it, with its own entry ID.
  duplicate(actor: string, id: string, input: z.input<typeof draftEntries>, now = Date.now()) {
    const v = draftEntries.parse(input);
    return this.db.transaction(() => {
      const row = this.row(id); this.check(row, v.expectedRevision);
      const chosen = new Set(v.entryIds), entries = this.draft(row);
      requireThat(v.entryIds.every(e => entries.some(x => x.entryId === e)), 'REVISION_CONFLICT', 'The program list changed. Reload and retry.', 409);
      this.saveDraft(id, entries.flatMap(e => chosen.has(e.entryId) ? [e, { ...e, entryId: randomUUID() }] : [e]), now);
      return this.detail(id, now);
    })();
  }
  arrange(actor: string, id: string, expected: number, input: ArrangeInput, now = Date.now(), random?: () => number) {
    return this.db.transaction(() => {
      const row = this.row(id); this.check(row, expected);
      const entries = this.draft(row);
      requireThat(input.tool !== 'replicate' || entries.length * input.times <= MAX_ENTRIES, 'DRAFT_TOO_LARGE', `A channel can hold at most ${MAX_ENTRIES.toLocaleString()} programs.`, 413);
      this.saveDraft(id, arrange(entries, input, randomUUID, random), now);
      return this.detail(id, now);
    })();
  }
  // Back to the list as last published.
  discard(actor: string, id: string, input: z.input<typeof draftRevision>, now = Date.now()) {
    const v = draftRevision.parse(input);
    return this.db.transaction(() => {
      const row = this.row(id); this.check(row, v.expectedRevision);
      this.saveDraft(id, row.published ? JSON.parse(row.published) as DraftEntry[] : [], now);
      return this.detail(id, now);
    })();
  }
  private publishable(row: Row) {
    const entries = this.draft(row);
    requireThat(entries.length > 0, 'EMPTY_CHANNEL', 'Add at least one program before publishing.', 422);
    const issues = entries.filter(e => e.issue).length;
    requireThat(!issues, 'UNPLAYABLE_PROGRAMS', `Remove ${issues} program${issues === 1 ? '' : 's'} that can’t play on a channel before publishing.`, 422);
    return entries.map(toEntry);
  }
  // What publishing the draft now would do: the airing program, when the new list takes over, and what follows.
  preview(id: string, now = Date.now(), count = 12) {
    const row = this.row(id), { publication, current } = this.scheduler.plan(id, this.publishable(row), now);
    const upcoming: ReturnType<typeof slotView>[] = []; let cursor = publication.effectiveAt;
    while (upcoming.length < count) { const slot = resolveSlot(publication, cursor); upcoming.push(slotView(slot)); cursor = slot.end; }
    const pending = this.scheduler.pending(id, now);
    return { current: current && slotView(current), effectiveAt: publication.effectiveAt, reason: publication.reason, upcoming, replacesPending: !!pending, publicationRevision: this.scheduler.revision(id) };
  }
  publish(actor: string, id: string, input: z.input<typeof draftRevision> & { expectedPublication: number }, now = Date.now()) {
    const v = draftRevision.extend({ expectedPublication: revision }).strict().parse(input);
    return this.db.transaction(() => {
      const row = this.row(id); this.check(row, v.expectedRevision);
      const timeline: Timeline = this.scheduler.publish(id, this.publishable(row), v.expectedPublication, now, actor);
      this.db.prepare('UPDATE custom_channels SET published=draft WHERE id=?').run(id); this.touch(id, now);
      return { channel: this.detail(id, now), effectiveAt: timeline.effectiveAt, reason: timeline.reason };
    })();
  }

  // Viewer side: enabled channels that have gone on air.
  private viewable(now: number) { return this.rows().filter(r => r.enabled && r.number !== null && (this.scheduler.startedAt(r.id) ?? Infinity) <= now); }
  isVisible(id: string, now = Date.now()) { return this.viewable(now).some(r => r.id === id); }
  tune(id: string) { requireThat(this.isVisible(id), 'CHANNEL_NOT_FOUND', 'Channel not found.', 404); const r = this.row(id); return { id: r.id, name: r.name, number: r.number! }; }
  exists(id: string) { return !!this.db.prepare('SELECT 1 FROM custom_channels WHERE id=?').get(id); }
  stations(account: string, favoritesOnly: boolean, search: string, channelId?: string, now = Date.now()) {
    const favorites = new Set((this.db.prepare('SELECT channel_id FROM custom_favorites WHERE account_id=?').all(account) as { channel_id: string }[]).map(f => f.channel_id));
    return this.viewable(now).filter(r => (!favoritesOnly || favorites.has(r.id)) && (!channelId || r.id === channelId) && (!search || r.name.toLocaleLowerCase().includes(search) || String(r.number).includes(search)))
      .map(r => ({ id: r.id, sourceId: 'custom', name: r.name, number: r.number!, position: r.position!, type: 'custom' as const, favorite: favorites.has(r.id), logo: !!r.logo_url, feeds: [{ id: r.id, name: r.name, number: r.number! }] }));
  }
  // Guide rows for [start, end): exact program slots, blank before the channel first went on air.
  programs(id: string, start: number, end: number): GuideSlot[] {
    const started = this.scheduler.startedAt(id);
    if (started === undefined || started >= end) return [{ start, end, program: null, blank: true }];
    const rows: GuideSlot[] = started > start ? [{ start, end: started, program: null, blank: true }] : [];
    for (const s of this.scheduler.guide(id, Math.max(start, started), end))
      rows.push({ start: Math.max(start, s.start), end: Math.min(end, s.end), program: { channelId: id, start: s.start, end: s.end, title: s.entry.title, ...(s.entry.subtitle ? { subtitle: s.entry.subtitle } : {}) } });
    return rows;
  }
  favorite(account: string, id: string, value: boolean) {
    requireThat(this.isVisible(id), 'CHANNEL_NOT_FOUND', 'Channel not found.', 404);
    if (value) this.db.prepare('INSERT OR IGNORE INTO custom_favorites VALUES(?,?)').run(account, id);
    else this.db.prepare('DELETE FROM custom_favorites WHERE account_id=? AND channel_id=?').run(account, id);
  }
  favoriteIds(account: string) { return (this.db.prepare('SELECT channel_id FROM custom_favorites WHERE account_id=?').all(account) as { channel_id: string }[]).map(f => f.channel_id).filter(id => this.isVisible(id)); }
  logo(id: string) { requireThat(this.isVisible(id), 'CHANNEL_NOT_FOUND', 'Channel not found.', 404); return this.row(id).logo_url ?? undefined; }
}
