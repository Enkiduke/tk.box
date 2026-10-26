import { z } from 'zod';
import type { Db } from './database.js';
import { requireThat } from '../errors.js';
import { nextRun, scheduleEvery, type Schedule } from '../../../../packages/contracts/src/schedule.js';
import { hamming, SIMILAR, type ProbeResult } from '../services/stream-probe.js';
import { sportsDormant } from './sports-store.js';
import { guideMissing, healthHidden } from './listing.js';

// Channels are checked again on a schedule (at most hourly; null is manual only), or every intervalHours (0 is manual
// only). Neither keeps the current one.
export const healthPolicy = z.object({ intervalHours: z.number().int().min(0).max(168).optional(), schedule: scheduleEvery(60).nullable().optional(), hideFailing: z.boolean() }).strict();
export type HealthPolicy = { intervalHours: number; schedule: Schedule | null; hideFailing: boolean };
export type HealthStatus = 'unchecked' | 'online' | 'offline' | 'placeholder';
type Row = { channel_id: string; status: HealthStatus; reason: string | null; detail: string | null; fingerprint: string | null; frozen: number; checked_at: number | null; last_online: number | null; failures: number; due: number; priority: number; exempt: number };

// Every channel in a sweep is checked; failures are confirmed by a second check before anything is
// hidden, and only count while the provider is demonstrably serving other channels, so an outage or
// expired account never empties the lineup. One success restores a channel.
const DEFAULT_POLICY: HealthPolicy = { intervalHours: 24, schedule: { kind: 'every', minutes: 1440 }, hideFailing: true };
const CONFIRM_MS = 90_000, RETRY_MS = 15 * 60_000, DEFER_MS = 5 * 60_000, YIELD_MS = 60_000, REACHABLE_MS = 12 * 3600_000, PEER_MS = 48 * 3600_000;
const eligible = "c.present=1 AND c.conflict=0 AND c.listing<>'hidden'";
// Only channels a passing check would list are worth a connection: no event channel outside its event, and no
// regular channel kept out by a missing guide. "Always list" channels are listed regardless, so they are checked.
const listable = `(c.listing='always' OR NOT (${sportsDormant} OR ${guideMissing}))`;
const isDue = `((h.priority=1 AND h.due<=@now) OR (COALESCE(p.interval_hours,24)>0 AND COALESCE(h.due,0)<=@now)) AND ${listable}`;
const joins = 'FROM iptv_channels c LEFT JOIN iptv_channel_health h ON h.channel_id=c.id LEFT JOIN iptv_health_policies p ON p.source_id=c.source_id';

export class HealthStore {
  constructor(private db: Db) {}
  private audit(actor: string, event: string, id: string, now: number) { this.db.prepare('INSERT INTO audit(actor,event,at,detail) VALUES(?,?,?,?)').run(actor, event, now, JSON.stringify({ id })); }
  private sourceOf(channelId: string) { return (this.db.prepare(`SELECT c.source_id FROM iptv_channels c WHERE c.id=? AND ${eligible}`).get(channelId) as { source_id: string } | undefined)?.source_id; }
  private row(channelId: string) { return this.db.prepare('SELECT * FROM iptv_channel_health WHERE channel_id=?').get(channelId) as Row | undefined; }
  private save(channelId: string, values: Partial<Omit<Row, 'channel_id'>>) {
    const keys = Object.keys(values) as (keyof typeof values)[];
    this.db.prepare(`INSERT INTO iptv_channel_health(channel_id,${keys.join(',')}) VALUES(@channel_id,${keys.map(k => '@' + k).join(',')}) ON CONFLICT(channel_id) DO UPDATE SET ${keys.map(k => `${k}=excluded.${k}`).join(',')}`).run({ channel_id: channelId, ...values });
  }
  policy(sourceId: string): HealthPolicy {
    const row = this.db.prepare('SELECT interval_hours,schedule,hide_failing FROM iptv_health_policies WHERE source_id=?').get(sourceId) as { interval_hours: number; schedule: string | null; hide_failing: number } | undefined;
    if (!row) return { ...DEFAULT_POLICY };
    const schedule: Schedule | null = row.schedule ? JSON.parse(row.schedule) : row.interval_hours ? { kind: 'every', minutes: row.interval_hours * 60 } : null;
    return { intervalHours: row.interval_hours, schedule, hideFailing: !!row.hide_failing };
  }
  setPolicy(actor: string, sourceId: string, input: z.input<typeof healthPolicy>, now = Date.now()) {
    const v = healthPolicy.parse(input), source = this.db.prepare('SELECT kind FROM iptv_sources WHERE id=?').get(sourceId) as { kind: string } | undefined;
    requireThat(source, 'SOURCE_NOT_FOUND', 'Source not found.', 404); requireThat(source.kind === 'm3u', 'INVALID_POLICY', 'Channel checks apply to M3U sources only.');
    this.db.transaction(() => {
      const current = this.policy(sourceId).schedule;
      const schedule = v.schedule !== undefined ? v.schedule : v.intervalHours !== undefined ? v.intervalHours ? { kind: 'every', minutes: v.intervalHours * 60 } as const : null : current;
      // interval_hours is 0 while checks are manual only, else the nearest whole hours of an every-N schedule.
      const hours = !schedule ? 0 : schedule.kind === 'every' ? Math.min(168, Math.max(1, Math.round(schedule.minutes / 60))) : 24;
      this.db.prepare('INSERT INTO iptv_health_policies(source_id,interval_hours,schedule,connections,hide_failing) VALUES(?,?,?,1,?) ON CONFLICT(source_id) DO UPDATE SET interval_hours=excluded.interval_hours,schedule=excluded.schedule,hide_failing=excluded.hide_failing').run(sourceId, hours, schedule && JSON.stringify(schedule), Number(v.hideFailing));
      // A new schedule brings each channel's next check forward to its next run, never later than it was.
      const next = schedule && JSON.stringify(schedule) !== JSON.stringify(current) ? nextRun(schedule, now) : undefined;
      if (next !== undefined) this.db.prepare('UPDATE iptv_channel_health SET due=MIN(due,?) WHERE priority=0 AND channel_id IN (SELECT id FROM iptv_channels WHERE source_id=?)').run(next, sourceId);
      this.audit(actor, 'iptv_health_policy_changed', sourceId, now);
    })();
    return this.policy(sourceId);
  }
  dueSources(now = Date.now()) { return (this.db.prepare(`SELECT DISTINCT c.source_id AS id ${joins} WHERE ${eligible} AND ${isDue}`).all({ now }) as { id: string }[]).map(r => r.id); }
  // Requested checks first, then channels that have played (what viewers see), then the oldest results.
  due(sourceId: string, limit: number, skip: Set<string>, now = Date.now()) {
    return (this.db.prepare(`SELECT c.id ${joins} WHERE c.source_id=@source AND ${eligible} AND ${isDue} ORDER BY COALESCE(h.priority,0) DESC, h.last_online IS NOT NULL DESC, COALESCE(h.due,0), c.id LIMIT @limit`)
      .all({ source: sourceId, now, limit: limit + skip.size }) as { id: string }[]).map(r => r.id).filter(id => !skip.has(id)).slice(0, limit);
  }
  // On an event-driven source, only channels that are live or starting soon are worth checking.
  queueSource(sourceId: string, now = Date.now()) {
    return this.db.prepare(`INSERT INTO iptv_channel_health(channel_id,due,priority) SELECT c.id,@now,1 FROM iptv_channels c WHERE c.source_id=@source AND ${eligible} AND ${listable} ON CONFLICT(channel_id) DO UPDATE SET due=excluded.due,priority=1`).run({ now, source: sourceId }).changes;
  }
  // An event channel's earlier result says nothing about tonight's event: check it when it starts showing
  // as starting soon and again at the scheduled start, when providers usually switch the feed on.
  queueEvents(sourceId: string, now = Date.now()) {
    return this.db.prepare(`INSERT INTO iptv_channel_health(channel_id,due,priority) SELECT w.channel_id,@now,1 FROM sports_windows w JOIN iptv_channels c ON c.id=w.channel_id LEFT JOIN iptv_channel_health h ON h.channel_id=w.channel_id
      WHERE w.source_id=@source AND ${eligible} AND w.visible_from<=@now AND w.visible_until>@now AND COALESCE(h.priority,0)=0
        AND (COALESCE(h.checked_at,0)<CASE WHEN w.start<=@now THEN w.start ELSE w.visible_from END
          -- A feed often switches on late; one that is failing during its window is retried every 10 minutes.
          OR (h.status IN ('offline','placeholder') AND h.checked_at<@now-${10 * 60_000}))
      ON CONFLICT(channel_id) DO UPDATE SET due=excluded.due,priority=1`).run({ source: sourceId, now }).changes;
  }
  // Selected channels of one source. Hidden, missing and conflicting channels are never checked and are skipped.
  queueChannels(sourceId: string, ids: string[], now = Date.now()) {
    return this.db.transaction(() => ids.filter(id => this.sourceOf(id) === sourceId).map(id => this.save(id, { due: now, priority: 1 })).length)();
  }
  queueChannel(channelId: string, due = Date.now()) {
    requireThat(this.sourceOf(channelId), 'CHANNEL_NOT_FOUND', 'Channel not found.', 404);
    this.save(channelId, { due, priority: 1 });
  }
  // A relay that is delivering media is proof enough; no probe connection is spent on it.
  relayOnline(channelId: string, now = Date.now()) {
    const source = this.sourceOf(channelId); if (!source) return;
    this.save(channelId, { status: 'online', reason: 'LIVE_RELAY', failures: 0, last_online: now, checked_at: now, priority: 0, due: this.nextCheck(source, now) });
  }
  // When a channel checked at `now` is next due; with checks manual only, the sweep skips it whatever this says.
  private nextCheck(sourceId: string, now: number) { return nextRun(this.policy(sourceId).schedule ?? DEFAULT_POLICY.schedule!, now) ?? now + 24 * 3600_000; }
  private lastOnline(sourceId: string) { return (this.db.prepare('SELECT MAX(h.last_online) AS at FROM iptv_channel_health h JOIN iptv_channels c ON c.id=h.channel_id WHERE c.source_id=?').get(sourceId) as { at: number | null }).at; }
  private slates(sourceId: string) { return (this.db.prepare('SELECT fingerprint FROM iptv_offline_slates WHERE source_id=?').all(sourceId) as { fingerprint: string }[]).map(r => r.fingerprint); }
  // Applies one probe result. Returns what was decided, or undefined when the channel left the lineup meanwhile.
  record(channelId: string, r: ProbeResult, now = Date.now()) {
    return this.db.transaction(() => {
      const source = this.sourceOf(channelId); if (!source) return undefined;
      const row = this.row(channelId), status = row?.status ?? 'unchecked', policy = this.policy(source), next = this.nextCheck(source, now);
      if (r.verdict === 'inconclusive') { this.save(channelId, { due: now + (r.reason === 'CANCELLED' ? YIELD_MS : RETRY_MS) }); return { status, applied: false as const }; }
      let verdict = r.verdict, reason = r.reason, immediate = false;
      const fingerprint = r.informative && r.fingerprint ? r.fingerprint : null;
      if (fingerprint && verdict !== 'offline') {
        if (this.slates(source).some(s => hamming(s, fingerprint) <= SIMILAR)) { verdict = 'placeholder'; reason = 'KNOWN_SLATE'; immediate = true; }
        else if (verdict === 'online' && r.frozen) {
          // Several channels frozen on the same picture are the provider's own "unavailable" screen,
          // even with music under it. Distinct radio stations each show their own artwork.
          const peers = (this.db.prepare(`SELECT h.channel_id,h.fingerprint FROM iptv_channel_health h JOIN iptv_channels c ON c.id=h.channel_id WHERE c.source_id=? AND ${eligible} AND h.channel_id<>? AND h.frozen=1 AND h.fingerprint IS NOT NULL AND h.checked_at>?`).all(source, channelId, now - PEER_MS) as { channel_id: string; fingerprint: string }[])
            .filter(p => hamming(p.fingerprint, fingerprint) <= SIMILAR);
          if (peers.length >= 2) {
            verdict = 'placeholder'; reason = 'SHARED_SLATE'; immediate = true;
            for (const peer of peers) this.save(peer.channel_id, { status: 'placeholder', reason: 'SHARED_SLATE', failures: Math.max(1, this.row(peer.channel_id)?.failures ?? 0) });
          }
        }
      }
      const detail = JSON.stringify({ video: r.video, audio: r.audio, still: r.frozen && !r.silent, ms: r.elapsedMs, thumbnail: r.thumbnail });
      const observed = { reason, detail, fingerprint, frozen: Number(r.frozen), checked_at: now };
      if (verdict === 'online') { this.save(channelId, { ...observed, status: 'online', failures: 0, last_online: now, due: next, priority: 0 }); return { status: 'online' as const, applied: true as const }; }
      if (verdict === 'offline' && (this.lastOnline(source) ?? 0) <= now - REACHABLE_MS) {
        // Nothing from this provider has played recently: it may be down or refusing this server.
        // Retried after the rest of the sweep has had a chance to show the provider working.
        this.save(channelId, { due: now + DEFER_MS }); return { status, applied: false as const, deferred: true as const };
      }
      const failures = (row?.failures ?? 0) + 1;
      if (immediate || failures >= 2) this.save(channelId, { ...observed, status: verdict, failures, due: next, priority: 0 });
      else this.save(channelId, { ...observed, status, failures, due: now + CONFIRM_MS, priority: 1 });
      return { status: immediate || failures >= 2 ? verdict : status, applied: true as const };
    })();
  }
  markSlate(actor: string, channelId: string, now = Date.now()) {
    return this.db.transaction(() => {
      const source = this.sourceOf(channelId), row = this.row(channelId);
      requireThat(source && row?.fingerprint, 'SLATE_UNAVAILABLE', 'Check this channel first; its picture has no usable fingerprint.', 409);
      this.db.prepare('INSERT OR IGNORE INTO iptv_offline_slates VALUES(?,?,?)').run(source, row.fingerprint, now);
      const matches = (this.db.prepare(`SELECT h.channel_id,h.fingerprint FROM iptv_channel_health h JOIN iptv_channels c ON c.id=h.channel_id WHERE c.source_id=? AND h.fingerprint IS NOT NULL`).all(source) as { channel_id: string; fingerprint: string }[])
        .filter(m => hamming(m.fingerprint, row.fingerprint!) <= SIMILAR);
      for (const m of matches) this.save(m.channel_id, { status: 'placeholder', reason: 'KNOWN_SLATE', failures: Math.max(1, this.row(m.channel_id)?.failures ?? 0) });
      this.audit(actor, 'iptv_offline_slate_added', source, now);
      return { matched: matches.length };
    })();
  }
  clearSlates(actor: string, sourceId: string, now = Date.now()) {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM iptv_offline_slates WHERE source_id=?').run(sourceId);
      // Channels hidden only because of a learned screen are rechecked on their own merits.
      this.db.prepare("UPDATE iptv_channel_health SET due=?,priority=1 WHERE reason='KNOWN_SLATE' AND channel_id IN (SELECT id FROM iptv_channels WHERE source_id=?)").run(now, sourceId);
      this.audit(actor, 'iptv_offline_slates_cleared', sourceId, now);
    })();
  }
  summary(sourceId: string, now = Date.now()) {
    const rows = this.db.prepare(`SELECT COALESCE(h.status,'unchecked') AS status,COUNT(*) AS n,SUM(CASE WHEN ${listable} THEN 1 ELSE 0 END) AS listable,SUM(CASE WHEN ${isDue} THEN 1 ELSE 0 END) AS due,SUM(CASE WHEN h.priority=1 AND h.due>@now THEN 1 ELSE 0 END) AS confirming ${joins} WHERE c.source_id=@source AND ${eligible} GROUP BY 1`).all({ source: sourceId, now }) as { status: HealthStatus; n: number; listable: number; due: number; confirming: number }[];
    const count = (s: HealthStatus) => rows.find(r => r.status === s)?.n ?? 0;
    const hidden = (this.db.prepare(`SELECT COUNT(*) AS n FROM iptv_channels c WHERE c.source_id=? AND c.listing='auto' AND c.present=1 AND c.conflict=0 AND ${healthHidden}`).get(sourceId) as { n: number }).n;
    const times = this.db.prepare('SELECT MAX(h.checked_at) AS checked,MAX(h.last_online) AS online FROM iptv_channel_health h JOIN iptv_channels c ON c.id=h.channel_id WHERE c.source_id=?').get(sourceId) as { checked: number | null; online: number | null };
    return { online: count('online'), offline: count('offline'), placeholder: count('placeholder'),
      // Channels that could not be listed now are not waiting for a check.
      unchecked: rows.find(r => r.status === 'unchecked')?.listable ?? 0, hidden,
      due: rows.reduce((n, r) => n + (r.due ?? 0), 0), confirming: rows.reduce((n, r) => n + (r.confirming ?? 0), 0),
      lastChecked: times.checked, lastOnline: times.online, slates: this.slates(sourceId).length };
  }
  forSource(sourceId: string) {
    const rows = this.db.prepare('SELECT h.* FROM iptv_channel_health h JOIN iptv_channels c ON c.id=h.channel_id WHERE c.source_id=?').all(sourceId) as Row[];
    return new Map(rows.map(r => {
      const detail = r.detail ? JSON.parse(r.detail) as { video?: { codec: string; width?: number; height?: number }; still?: boolean; thumbnail?: boolean } : {};
      return [r.channel_id, { status: r.status, reason: r.reason, checkedAt: r.checked_at, lastOnline: r.last_online, failures: r.failures, queued: !!r.priority,
        still: !!detail.still, video: detail.video, thumbnail: !!detail.thumbnail, fingerprint: !!r.fingerprint }] as const;
    }));
  }
  channelIds() { return new Set((this.db.prepare('SELECT id FROM iptv_channels').all() as { id: string }[]).map(r => r.id)); }
}
