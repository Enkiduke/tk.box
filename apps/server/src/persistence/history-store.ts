import type { Db } from './database.js';
import Database from 'better-sqlite3';
import type { PlexMetadata } from '../providers/plex.js';

export type HistoryMedia = {
  serverId: string;
  ratingKey: string;
  libraryId: string;
  title: string;
  type: 'movie' | 'episode';
  durationMs: number;
  year?: number;
  showId?: string;
  showTitle?: string;
  seasonId?: string;
  season?: number;
  episode?: number;
};
export function plexHistoryMedia(serverId: string, item: PlexMetadata): HistoryMedia {
  return { serverId, ratingKey: item.ratingKey, libraryId: item.librarySectionID, title: item.title,
    type: item.type, durationMs: item.duration, year: item.year, showId: item.grandparentRatingKey,
    showTitle: item.grandparentTitle, seasonId: item.parentRatingKey, season: item.parentIndex, episode: item.index };
}
export type HistoryDelivery = 'direct' | 'remux' | 'transcode';
export type HistoryChannel = { type: 'channel'; serverId: 'iptv' | 'custom'; ratingKey: string; title: string; number: number };
export type HistoryTarget = HistoryMedia | HistoryChannel;
export type HistoryAiring = {
  id: string; start: number; end: number; media?: HistoryMedia; delivery?: HistoryDelivery;
  guide?: { title: string; subtitle?: string; category?: string; estimated: true };
};
export type LiveAllocation = { day: string; feedId: string; airing?: HistoryAiring; watchMs: number };
export type HistoryDay = Record<HistoryDelivery, number>;
export type HistoryEnd = 'ended' | 'stopped' | 'replacing' | 'idle' | 'interrupted' | 'revoked' | 'admin';
export type HistorySession = {
  source?: 'plex';
  id: string;
  generation: string;
  media: HistoryTarget;
  accountId: string;
  accountName?: string;
  client: string;
  stream: { delivery: HistoryDelivery; video?: string; audio?: string; sourceHeight?: number; sourceWidth?: number; outputHeight?: number; maxHeight?: number };
  startedAt: number;
  observedAt: number;
  positionMs: number;
  watchMs: number;
  end?: HistoryEnd;
};
type Checkpoint = { session: HistorySession; days: ReadonlyMap<string, HistoryDay>; live?: Iterable<LiveAllocation> };
type ResumeRow = Omit<HistorySession, 'media' | 'stream'> & Pick<HistoryMedia, 'serverId' | 'ratingKey'> & { metadata: string; stream: string };

export class HistoryStore {
  private db?: Db;

  constructor(private appDb: Db) {}

  private connection() {
    // History retries busy writes in the scheduler. Streaming uses the app connection's own timeout.
    if (!this.db) {
      this.db = this.appDb.memory ? this.appDb : new Database(this.appDb.name, { fileMustExist: true, timeout: 5 });
      if (this.db !== this.appDb) this.db.pragma('foreign_keys = ON');
    }
    return this.db;
  }

  close() {
    if (this.db && this.db !== this.appDb) this.db.close();
    this.db = undefined;
  }

  // Clean Up: each account's latest watch of each movie, show and season on this Plex server, in tk.box's player or
  // Plex's own apps. Any time watched counts; channels don't.
  latestWatches(serverId: string) {
    return this.connection().prepare(`WITH w AS (SELECT m.rating_key AS rk,json_extract(m.metadata,'$.type') AS type,
        json_extract(m.metadata,'$.showId') AS show,json_extract(m.metadata,'$.seasonId') AS season,s.account_id AS account,s.started_at AS at
        FROM history_sessions s JOIN history_media m ON m.id=s.media_id WHERE s.source IN ('vod','plex') AND s.watch_ms>0 AND m.server_id=?)
      SELECT 'movie' AS scope,rk AS ratingKey,account,MAX(at) AS at FROM w WHERE type='movie' GROUP BY rk,account
      UNION ALL SELECT 'show',show,account,MAX(at) FROM w WHERE type='episode' AND show IS NOT NULL GROUP BY show,account
      UNION ALL SELECT 'season',season,account,MAX(at) FROM w WHERE type='episode' AND season IS NOT NULL GROUP BY season,account`)
      .all(serverId) as { scope: 'movie' | 'show' | 'season'; ratingKey: string; account: string; at: number }[];
  }

  recover(since: number): HistorySession[] {
    const db = this.connection();
    return db.transaction(() => {
      db.prepare("UPDATE history_sessions SET ended_at=observed_at,end_reason='interrupted' WHERE ended_at IS NULL").run();
      const rows = db.prepare(`SELECT s.id,s.generation,CASE WHEN s.source='plex' THEN 'plex' END AS source,s.account_id AS accountId,s.account_name AS accountName,s.client,s.started_at AS startedAt,
        s.observed_at AS observedAt,s.position_ms AS positionMs,s.watch_ms AS watchMs,s.end_reason AS end,
        m.server_id AS serverId,m.rating_key AS ratingKey,m.metadata,s.stream
        FROM history_sessions s JOIN history_media m ON m.id=s.media_id
        WHERE s.observed_at>=? AND s.end_reason IN ('interrupted','replacing','idle')
        ORDER BY s.observed_at DESC LIMIT 512`).all(since) as ResumeRow[];
      return rows.map(({ serverId, ratingKey, metadata, stream, ...session }) => ({
        ...session, media: { ...JSON.parse(metadata), serverId, ratingKey }, stream: JSON.parse(stream)
      }));
    })();
  }

  checkpoint(batch: Checkpoint[]) {
    const db = this.connection();
    const media = db.prepare(`INSERT INTO history_media(server_id,rating_key,metadata) VALUES(?,?,?)
      ON CONFLICT(server_id,rating_key,metadata) DO NOTHING`);
    const findMedia = db.prepare('SELECT id FROM history_media WHERE server_id=? AND rating_key=? AND metadata=?');
    const writeSession = db.prepare(`INSERT INTO history_sessions
      (id,source,account_id,account_name,media_id,client,stream,generation,started_at,observed_at,ended_at,end_reason,watch_ms,position_ms)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      stream=excluded.stream,generation=excluded.generation,observed_at=excluded.observed_at,ended_at=excluded.ended_at,
      end_reason=excluded.end_reason,watch_ms=excluded.watch_ms,position_ms=excluded.position_ms`);
    const writeDay = db.prepare(`INSERT INTO history_days(session_id,day,direct_ms,remux_ms,transcode_ms) VALUES(?,?,?,?,?)
      ON CONFLICT(session_id,day) DO UPDATE SET direct_ms=direct_ms+excluded.direct_ms,
      remux_ms=remux_ms+excluded.remux_ms,transcode_ms=transcode_ms+excluded.transcode_ms`);
    const writeLive = db.prepare(`INSERT INTO history_live_allocations(session_id,day,feed_id,airing_id,media_id,details,watch_ms)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(session_id,day,feed_id,airing_id) DO UPDATE SET watch_ms=watch_ms+excluded.watch_ms`);
    const targetId = (target: HistoryTarget) => {
      const { serverId, ratingKey, ...snapshot } = target;
      const metadata = JSON.stringify(snapshot);
      media.run(serverId, ratingKey, metadata);
      return (findMedia.get(serverId, ratingKey, metadata) as { id: number }).id;
    };
    db.transaction(() => {
      for (const { session: s, days, live } of batch) {
        const source = s.source ?? (s.media.type === 'channel' ? s.media.serverId : 'vod');
        writeSession.run(s.id, source, s.accountId, s.accountName ?? null, targetId(s.media), s.client, JSON.stringify(s.stream), s.generation,
          s.startedAt, s.observedAt, s.end ? s.observedAt : null, s.end ?? null, s.watchMs, s.positionMs);
        for (const [day, time] of days) writeDay.run(s.id, day, time.direct, time.remux, time.transcode);
        for (const { day, feedId, airing, watchMs } of live ?? []) {
          const details = airing?.guide && JSON.stringify({ start: airing.start, end: airing.end, guide: airing.guide });
          writeLive.run(s.id, day, feedId, airing?.id ?? '', airing?.media ? targetId(airing.media) : null, details ?? null, watchMs);
        }
      }
    })();
  }
}
