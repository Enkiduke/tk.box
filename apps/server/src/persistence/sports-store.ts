import { z } from 'zod';
import type { Db } from './database.js';
import { requireThat } from '../errors.js';
import { AppError } from '../errors.js';
import { SPORTS, stackKey, type SportsEvent, type Window } from '../services/sports-match.js';

export const NOW = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
// SQL predicate (channel alias `c`): an event channel (its group follows events) with no event on right now.
// Shared with the listing rule, like healthHidden.
export const sportsHidden = `(c.event=1 AND NOT EXISTS(SELECT 1 FROM sports_windows w WHERE w.channel_id=c.id AND w.visible_from<=${NOW} AND w.visible_until>${NOW}))`;
// Channel checks only spend connections on event channels that are live or starting soon (`@now` bound by HealthStore).
export const sportsDormant = `(c.event=1 AND NOT EXISTS(SELECT 1 FROM sports_windows w WHERE w.channel_id=c.id AND w.visible_from<=@now AND w.visible_until>@now))`;
export const sportsPolicy = z.object({ enabled: z.boolean(), leadMinutes: z.number().int().min(0).max(720) }).strict();
export type SportsPolicy = z.infer<typeof sportsPolicy>;
// Shown for a short while after the final whistle, so a viewer is not cut off mid-celebration.
export const GRACE_MS = 15 * 60_000;

// Live Sports settings, shared by every event-driven source. "selected" shows only the listed leagues;
// unscheduled covers channels matched by a written time or a guide listing alone, which belong to no league.
export const SPORT_ORDER = ['football', 'basketball', 'baseball', 'hockey', 'soccer', 'mma', 'boxing', 'wrestling', 'racing', 'golf', 'tennis', 'rugby', 'cricket', 'cycling', 'darts', 'curling', 'sports'] as const;
const leagueKey = z.string().min(1).max(80).regex(/^[\w.:/-]+$/);
export const sportsSettings = z.object({
  leagueMode: z.enum(['all', 'selected']), leagues: z.array(leagueKey).max(300), unscheduled: z.boolean(),
  sportOrder: z.array(z.enum([...SPORTS, 'sports'])).max(40), leagueOrder: z.array(leagueKey).max(300),
  placement: z.enum(['top', 'bottom']), numberStart: z.number().int().min(1).max(99_999).nullable()
}).strict();
export type SportsSettings = z.infer<typeof sportsSettings>;
const DEFAULT_SETTINGS: SportsSettings = { leagueMode: 'all', leagues: [], unscheduled: true, sportOrder: [...SPORT_ORDER], leagueOrder: [], placement: 'bottom', numberStart: null };
export function readSportsSettings(db: Db): SportsSettings & { revision: number } {
  const row = db.prepare('SELECT revision,value FROM sports_settings WHERE id=1').get() as { revision: number; value: string } | undefined;
  const value = row ? sportsSettings.parse({ ...DEFAULT_SETTINGS, ...JSON.parse(row.value) }) : DEFAULT_SETTINGS;
  // Sports added since the order was saved go after the ones the administrator placed.
  return { revision: row?.revision ?? 0, ...value, sportOrder: [...new Set([...value.sportOrder, ...SPORT_ORDER])] };
}
// Whether a matched window may be shown under the settings.
export const allowed = (s: SportsSettings) => (w: Pick<Window, 'eventId' | 'leagueKey'>) =>
  w.eventId ? s.leagueMode === 'all' || (!!w.leagueKey && s.leagues.includes(w.leagueKey)) : s.unscheduled;
// Guide order of an event channel: its sport, then its league within the sport. Leagues not placed come after
// placed ones, and unscheduled matches after every league.
export function eventRank(s: SportsSettings) {
  const sports = new Map<string, number>(s.sportOrder.map((sport, i) => [sport, i])), leagues = new Map(s.leagueOrder.map((key, i) => [key, i]));
  return (sport: string | null, key: string | null) => [sports.get(sport ?? 'sports') ?? sports.size, key ? leagues.get(key) ?? leagues.size : leagues.size + 1] as const;
}
type EventRow = { id: string; source: SportsEvent['source']; sport: string; league: string; league_key: string | null; title: string; start: number; end: number; state: SportsEvent['state']; time_known: number; sides: string; abbreviations: string; ended_at: number | null };
type WindowRow = { channel_id: string; event_id: string | null; title: string; league: string; start: number; end: number; visible_from: number; visible_until: number; state: string | null; matched_by: Window['matchedBy']; sport: string | null; league_key: string | null };

export class SportsStore {
  // `changed` reclassifies a source's channels into regular and event channels (IptvStore.relist).
  constructor(private db: Db, private changed: (sourceId: string) => void = () => {}) {}
  policy(sourceId: string): SportsPolicy {
    const row = this.db.prepare('SELECT enabled,lead_minutes FROM sports_policies WHERE source_id=?').get(sourceId) as { enabled: number; lead_minutes: number } | undefined;
    return { enabled: !!row?.enabled, leadMinutes: row?.lead_minutes ?? 30 };
  }
  setPolicy(actor: string, sourceId: string, input: z.input<typeof sportsPolicy>, now = Date.now()) {
    const v = sportsPolicy.parse(input), source = this.db.prepare('SELECT kind FROM iptv_sources WHERE id=?').get(sourceId) as { kind: string } | undefined;
    requireThat(source, 'SOURCE_NOT_FOUND', 'Source not found.', 404); requireThat(source.kind === 'm3u', 'INVALID_POLICY', 'Sports events apply to M3U sources only.');
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO sports_policies VALUES(?,?,?) ON CONFLICT(source_id) DO UPDATE SET enabled=excluded.enabled,lead_minutes=excluded.lead_minutes').run(sourceId, Number(v.enabled), v.leadMinutes);
      // Turned off, every group is regular again: its channels list by the regular rules.
      if (!v.enabled) this.db.prepare('DELETE FROM sports_windows WHERE source_id=?').run(sourceId);
      this.db.prepare('UPDATE iptv_sources SET revision=revision+1 WHERE id=?').run(sourceId);
      this.db.prepare('INSERT INTO audit(actor,event,at,detail) VALUES(?,?,?,?)').run(actor, 'sports_policy_changed', now, JSON.stringify({ id: sourceId }));
      this.changed(sourceId);
    })();
    return this.policy(sourceId);
  }
  settings() { return readSportsSettings(this.db); }
  setSettings(actor: string, expectedRevision: number, input: z.input<typeof sportsSettings>, now = Date.now()) {
    const v = sportsSettings.parse(input);
    return this.db.transaction(() => {
      const current = this.settings().revision;
      if (current !== expectedRevision) throw new AppError('REVISION_CONFLICT', 'Live Sports settings changed. Reload and retry.', 409);
      this.db.prepare('INSERT INTO sports_settings VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value=excluded.value').run(current + 1, JSON.stringify(v));
      this.db.prepare('INSERT INTO audit(actor,event,at,detail) VALUES(?,?,?,?)').run(actor, 'sports_settings_changed', now, JSON.stringify(v));
      return this.settings();
    })();
  }
  // Leagues seen in downloaded schedules, with how many games each has from `from` on.
  leagues(from: number) {
    return this.db.prepare('SELECT league_key AS key,MAX(league) AS name,MAX(sport) AS sport,SUM(end>=?) AS upcoming FROM sports_events WHERE league_key IS NOT NULL GROUP BY league_key').all(from) as { key: string; name: string; sport: string; upcoming: number }[];
  }
  sources() { return (this.db.prepare("SELECT p.source_id AS id,p.lead_minutes FROM sports_policies p JOIN iptv_sources s ON s.id=p.source_id WHERE p.enabled=1 AND s.kind='m3u'").all() as { id: string; lead_minutes: number }[]); }
  // A live status only moves forward; the end follows it: still playing extends, finished closes.
  upsert(events: SportsEvent[], now = Date.now()) {
    const get = this.db.prepare('SELECT state,ended_at FROM sports_events WHERE id=?');
    const put = this.db.prepare(`INSERT INTO sports_events(id,source,sport,league,title,start,end,state,time_known,sides,abbreviations,ended_at,updated_at,league_key,logos)
      VALUES(@id,@source,@sport,@league,@title,@start,@end,@state,@time_known,@sides,@abbreviations,@ended_at,@now,@leagueKey,@logos)
      ON CONFLICT(id) DO UPDATE SET sport=excluded.sport,league=excluded.league,league_key=excluded.league_key,title=excluded.title,start=excluded.start,end=excluded.end,state=excluded.state,time_known=excluded.time_known,sides=excluded.sides,abbreviations=excluded.abbreviations,logos=excluded.logos,ended_at=excluded.ended_at,updated_at=excluded.updated_at`);
    this.db.transaction(() => {
      for (const e of events) {
        const old = get.get(e.id) as { state: string; ended_at: number | null } | undefined;
        const ended = e.state === 'post' ? old?.ended_at ?? (old?.state === 'in' ? now : Math.min(now, e.end)) : null;
        const end = e.state === 'in' ? Math.max(e.end, now + GRACE_MS) : ended ?? e.end;
        put.run({ ...e, end, time_known: Number(e.timeKnown), sides: JSON.stringify(e.sides), abbreviations: JSON.stringify(e.abbreviations), logos: e.logos?.length === 2 ? JSON.stringify(e.logos) : null, ended_at: ended, now });
      }
    })();
  }
  prune(now = Date.now()) { this.db.prepare('DELETE FROM sports_events WHERE end<?').run(now - 36 * 3600_000); }
  events(from: number, to: number): SportsEvent[] {
    return (this.db.prepare('SELECT * FROM sports_events WHERE end>=? AND start<=? ORDER BY start').all(from, to) as EventRow[])
      .map(r => ({ id: r.id, source: r.source, sport: r.sport, league: r.league, leagueKey: r.league_key ?? '', title: r.title, start: r.start, end: r.end, state: r.state, timeKnown: !!r.time_known, sides: JSON.parse(r.sides), abbreviations: JSON.parse(r.abbreviations) }));
  }
  // Replaces a source's windows in one transaction. Returns channels whose window is newly open or about to.
  replaceWindows(sourceId: string, leadMinutes: number, windows: Map<string, Window>) {
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM sports_windows WHERE source_id=?').run(sourceId);
      const put = this.db.prepare('INSERT INTO sports_windows(channel_id,source_id,event_id,title,league,start,end,visible_from,visible_until,state,matched_by,stack_key,sport,league_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      for (const [channelId, w] of windows) put.run(channelId, sourceId, w.eventId, w.title.slice(0, 300), w.league.slice(0, 120), w.start, w.end, w.start - leadMinutes * 60_000, w.end + GRACE_MS, w.state, w.matchedBy, stackKey(w).slice(0, 300), w.sport ?? 'sports', w.leagueKey || null);
    })();
  }
  windows(sourceId: string) { return new Map((this.db.prepare('SELECT * FROM sports_windows WHERE source_id=?').all(sourceId) as WindowRow[]).map(r => [r.channel_id, r])); }
  window(channelId: string) { return this.db.prepare('SELECT * FROM sports_windows WHERE channel_id=?').get(channelId) as WindowRow | undefined; }
  // A league's logo address as last published. A new address drops the saved image so it is downloaded again.
  setLogoUrl(key: string, url: string, now = Date.now()) {
    this.db.prepare(`INSERT INTO sports_league_logos(league_key,url,checked_at) VALUES(?,?,?)
      ON CONFLICT(league_key) DO UPDATE SET bytes=CASE WHEN url IS excluded.url THEN bytes ELSE NULL END,type=CASE WHEN url IS excluded.url THEN type ELSE NULL END,url=excluded.url,checked_at=excluded.checked_at`).run(key, url, now);
  }
  logosMissing() { return this.db.prepare('SELECT league_key AS key,url FROM sports_league_logos WHERE url IS NOT NULL AND bytes IS NULL').all() as { key: string; url: string }[]; }
  saveLogo(key: string, url: string, image: { type: string; bytes: Buffer }) {
    this.db.prepare('UPDATE sports_league_logos SET type=?,bytes=? WHERE league_key=? AND url=?').run(image.type, image.bytes, key, url);
  }
  count(from: number) { return (this.db.prepare('SELECT COUNT(*) AS n FROM sports_events WHERE end>=?').get(from) as { n: number }).n; }
}
