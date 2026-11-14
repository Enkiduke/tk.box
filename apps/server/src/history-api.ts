import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { historySources, type HistoryListRow, type HistoryMediaRank, type HistoryRank, type HistorySessionDetail, type HistorySummary } from '../../../packages/contracts/src/index.js';
import type { Db } from './persistence/database.js';
import { requireThat } from './errors.js';
import { TtlCache } from './lib/ttl-cache.js';

const periods = z.enum(['7', '30', '90', '365', 'all']);
const rangeQuery = z.object({ days: periods.default('30'), source: z.enum(historySources).optional(),
  user: z.string().regex(/^\d{1,40}$/).optional() });
const sessionQuery = rangeQuery.extend({ cursor: z.string().regex(/^\d{1,16}:[\da-f-]{36}$/).optional(), q: z.string().trim().max(80).optional(),
  media: z.coerce.number().int().positive().optional(), show: z.string().regex(/^\d{1,40}$/).optional(), server: z.string().max(100).optional(),
  airing: z.string().max(1800).optional(), kind: z.enum(['movie', 'episode', 'channel']).optional(), sort: z.enum(['newest', 'longest']).default('newest') });
const mediaQuery = rangeQuery.extend({ kind: z.enum(['all', 'movies', 'shows', 'episodes', 'channels', 'programs']).default('all') });
type Range = z.infer<typeof rangeQuery>;
type RawSession = Omit<HistoryListRow, 'title' | 'kind' | 'showTitle' | 'durationMs' | 'year' | 'season' | 'episode' | 'channelNumber' | 'stream'> &
  { metadata: string; stream: string };
const fields = `s.id,s.source,s.account_id AS accountId,s.account_name AS accountName,m.server_id AS serverId,m.rating_key AS ratingKey,
  m.metadata,s.client,s.stream,s.started_at AS startedAt,s.ended_at AS endedAt,s.watch_ms AS watchMs,s.position_ms AS positionMs,s.end_reason AS endReason`;
const sessionDto = ({ metadata, stream, ...row }: RawSession): HistoryListRow => {
  const { title, type: kind, durationMs, showTitle, year, season, episode, number: channelNumber } = JSON.parse(metadata);
  return { ...row, title, kind, durationMs, showTitle, year, season, episode, channelNumber, stream: JSON.parse(stream) };
};
const dayKey = (date: Date) => [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(n => String(n).padStart(2, '0')).join('-');
function rangeStart(days: Range['days']) {
  if (days === 'all') return undefined;
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - Number(days) + 1);
  return since;
}
function scope(range: Range, days = false) {
  const where: string[] = [];
  const bindings: (string | number)[] = [];
  const since = rangeStart(range.days);
  if (since) {
    where.push(days ? 'd.day>=?' : 's.started_at>=?');
    bindings.push(days ? dayKey(since) : since.getTime());
  }
  if (range.source) { where.push('s.source=?'); bindings.push(range.source); }
  if (range.user) { where.push('s.account_id=?'); bindings.push(range.user); }
  return { where, bindings, sql: () => where.length ? ` WHERE ${where.join(' AND ')}` : '' };
}

// Admin › History. Every route is admin-only, checked before the cache is read.
export function registerHistory(app: FastifyInstance, db: Db) {
  const asAdmin = { config: { access: 'admin' as const } };
  const cache = new TtlCache<unknown>(32);
  const cached = <T>(key: string, load: () => T): T => cache.remember(key, 30000, load) as T;
  app.get('/api/v1/admin/history/summary', asAdmin, async req => {
    const filter = rangeQuery.parse(req.query);
    return cached(`summary:${JSON.stringify(filter)}`, (): HistorySummary => {
      const range = scope(filter, true), sessions = scope(filter);
      const days = db.prepare(`SELECT d.day,SUM(d.direct_ms+d.remux_ms+d.transcode_ms) AS watchMs
        FROM history_days d JOIN history_sessions s ON s.id=d.session_id${range.sql()}
        GROUP BY d.day ORDER BY d.day DESC LIMIT 366`).all(...range.bindings) as HistorySummary['days'];
      const totals = db.prepare(`SELECT COALESCE(SUM(d.direct_ms+d.remux_ms+d.transcode_ms),0) AS watchMs,
        COUNT(DISTINCT s.account_id) AS viewers FROM history_days d JOIN history_sessions s ON s.id=d.session_id${range.sql()}`)
        .get(...range.bindings) as Pick<HistorySummary, 'viewers' | 'watchMs'>;
      const delivery = db.prepare(`SELECT COUNT(*) AS sessions,COUNT(*) FILTER(WHERE mode='direct') AS direct,
        COUNT(*) FILTER(WHERE mode='remux') AS remux,COUNT(*) FILTER(WHERE mode='transcode') AS transcode
        FROM (SELECT CASE WHEN direct>=remux AND direct>=transcode THEN 'direct'
          WHEN remux>=transcode THEN 'remux' ELSE 'transcode' END AS mode
          FROM (SELECT SUM(d.direct_ms) AS direct,SUM(d.remux_ms) AS remux,SUM(d.transcode_ms) AS transcode
            FROM history_sessions s JOIN history_days d ON d.session_id=s.id${sessions.sql()} GROUP BY s.id))`).get(...sessions.bindings) as
        HistorySummary['delivery'] & { sessions: number };
      return { ...totals, days: days.reverse(), sessions: delivery.sessions, delivery: { direct: delivery.direct, remux: delivery.remux, transcode: delivery.transcode } };
    });
  });
  app.get('/api/v1/admin/history/users', asAdmin, async req => {
    const filter = rangeQuery.parse(req.query);
    return cached(`users:${JSON.stringify(filter)}`, () => {
      const range = scope(filter, true);
      return db.prepare(`SELECT s.account_id AS id,COALESCE(MAX(s.account_name),'Plex user '||s.account_id) AS title,
        COUNT(DISTINCT s.id) AS sessions,SUM(d.direct_ms+d.remux_ms+d.transcode_ms) AS watchMs,1 AS viewers
        FROM history_days d JOIN history_sessions s ON s.id=d.session_id${range.sql()}
        GROUP BY s.account_id ORDER BY watchMs DESC,s.account_id LIMIT 100`).all(...range.bindings) as HistoryRank[];
    });
  });
  app.get('/api/v1/admin/history/media', asAdmin, async req => {
    const filter = mediaQuery.parse(req.query);
    return cached(`media:${JSON.stringify(filter)}`, () => {
      const range = scope(filter, true);
      const where = range.sql();
      const andWhere = where ? where + ' AND ' : ' WHERE ';
      const programs = filter.kind === 'all' || filter.kind === 'programs' ? db.prepare(`
        SELECT a.feed_id||':'||a.airing_id AS id,MAX(json_extract(a.details,'$.guide.title')) AS title,'program' AS kind,
          COUNT(DISTINCT s.id) AS sessions, SUM(a.watch_ms) AS watchMs,COUNT(DISTINCT s.account_id) AS viewers
          FROM history_live_allocations a JOIN history_sessions s ON s.id=a.session_id
          JOIN history_days d ON d.session_id=a.session_id AND d.day=a.day${andWhere}a.details IS NOT NULL
          GROUP BY a.feed_id,a.airing_id ORDER BY watchMs DESC,id LIMIT 100`).all(...range.bindings) as HistoryMediaRank[] : [];
      if (filter.kind === 'programs') return programs;
      const kind = { all: undefined, movies: 'movie', shows: 'episode', episodes: 'episode', channels: 'channel' }[filter.kind];
      const show = filter.kind === 'shows';
      const rollups = filter.kind === 'all' ? 'VALUES (0), (1)' : show ? 'VALUES (1)' : 'VALUES (0)';
      const items = db.prepare(`WITH watched AS (
        SELECT s.id,s.account_id,s.media_id,d.direct_ms+d.remux_ms+d.transcode_ms AS ms
          FROM history_days d JOIN history_sessions s ON s.id=d.session_id${where}
        UNION ALL
        SELECT s.id,s.account_id,a.media_id,a.watch_ms AS ms FROM history_live_allocations a
          JOIN history_sessions s ON s.id=a.session_id JOIN history_days d ON d.session_id=a.session_id AND d.day=a.day
          ${andWhere}a.media_id IS NOT NULL
      )
      SELECT CASE WHEN r.column1=1 THEN m.server_id||':'||json_extract(m.metadata,'$.showId') ELSE CAST(MAX(m.id) AS TEXT) END AS id,
        CASE WHEN r.column1=1 THEN 'show' ELSE json_extract(m.metadata,'$.type') END AS kind,
        MAX(CASE WHEN r.column1=1 THEN json_extract(m.metadata,'$.showTitle') ELSE json_extract(m.metadata,'$.title') END) AS title,
        COUNT(DISTINCT w.id) AS sessions,
        SUM(w.ms) AS watchMs,COUNT(DISTINCT w.account_id) AS viewers
      FROM watched w JOIN history_media m ON m.id=w.media_id CROSS JOIN (${rollups}) r
      WHERE (r.column1=0 OR (json_extract(m.metadata,'$.type')='episode' AND json_extract(m.metadata,'$.showId') IS NOT NULL))
      ${kind ? "AND json_extract(m.metadata,'$.type')=?" : ''}
      GROUP BY m.server_id,kind,CASE WHEN r.column1=1 THEN json_extract(m.metadata,'$.showId') ELSE m.rating_key END
      ORDER BY watchMs DESC,id LIMIT 100`).all(...range.bindings, ...range.bindings, ...(kind ? [kind] : [])) as HistoryMediaRank[];
      if (!programs.length) return items;
      return [...items, ...programs].sort((a, b) => b.watchMs - a.watchMs || a.id.localeCompare(b.id)).slice(0, 100);
    });
  });
  app.get('/api/v1/admin/history/sessions', asAdmin, async req => {
    const filter = sessionQuery.parse(req.query), range = scope(filter);
    const column = filter.sort === 'longest' ? 's.watch_ms' : 's.started_at';
    if (filter.cursor) {
      const [time, id] = filter.cursor.split(':');
      range.where.push(`(${column},s.id)<(?,?)`);
      range.bindings.push(Number(time), id!);
    }
    if (filter.kind) {
      range.where.push("json_extract(m.metadata,'$.type')=?");
      range.bindings.push(filter.kind);
    }
    if (filter.q) {
      range.where.push(`(instr(lower(json_extract(m.metadata,'$.title')),lower(?))>0
        OR instr(lower(json_extract(m.metadata,'$.showTitle')),lower(?))>0
        OR instr(lower(COALESCE(s.account_name,'')),lower(?))>0 OR s.account_id=?)`);
      range.bindings.push(filter.q, filter.q, filter.q, filter.q);
    }
    if (filter.media || filter.show && filter.server) {
      const where = filter.media
        ? 'target.server_id=(SELECT server_id FROM history_media WHERE id=?) AND target.rating_key=(SELECT rating_key FROM history_media WHERE id=?)'
        : "target.server_id=? AND json_extract(target.metadata,'$.showId')=?";
      range.where.push(`(EXISTS(SELECT 1 FROM history_media target WHERE target.id=s.media_id AND ${where})
        OR EXISTS(SELECT 1 FROM history_live_allocations a JOIN history_media target ON target.id=a.media_id WHERE a.session_id=s.id AND ${where}))`);
      const pair = filter.media ? [filter.media, filter.media] : [filter.server!, filter.show!];
      range.bindings.push(...pair, ...pair);
    }
    if (filter.airing) {
      const separator = filter.airing.indexOf(':');
      requireThat(separator > 0, 'HISTORY_AIRING', 'The program filter is invalid.');
      range.where.push('EXISTS(SELECT 1 FROM history_live_allocations a WHERE a.session_id=s.id AND a.feed_id=? AND a.airing_id=?)');
      range.bindings.push(filter.airing.slice(0, separator), filter.airing.slice(separator + 1));
    }
    const rows = (db.prepare(`SELECT ${fields} FROM history_sessions s JOIN history_media m ON m.id=s.media_id${range.sql()}
      ORDER BY ${column} DESC,s.id DESC LIMIT 51`).all(...range.bindings) as RawSession[]).map(sessionDto);
    const items = rows.slice(0, 50), last = items.at(-1);
    return { items, next: rows.length > items.length && last ? `${filter.sort === 'longest' ? last.watchMs : last.startedAt}:${last.id}` : undefined };
  });
  app.get('/api/v1/admin/history/sessions/:id', asAdmin, async (req): Promise<HistorySessionDetail> => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const raw = db.prepare(`SELECT ${fields},s.observed_at AS observedAt FROM history_sessions s JOIN history_media m ON m.id=s.media_id WHERE s.id=?`)
      .get(id) as (RawSession & { observedAt: number }) | undefined;
    requireThat(raw, 'HISTORY_NOT_FOUND', 'This session could not be found.', 404);
    const { observedAt, ...session } = raw;
    const deliveryMs = db.prepare(`SELECT COALESCE(SUM(direct_ms),0) AS direct,COALESCE(SUM(remux_ms),0) AS remux,
      COALESCE(SUM(transcode_ms),0) AS transcode FROM history_days WHERE session_id=?`).get(id) as HistorySessionDetail['deliveryMs'];
    const allocations = db.prepare(`SELECT a.day,a.feed_id AS feedId,a.watch_ms AS watchMs,
      COALESCE(json_extract(m.metadata,'$.title'),json_extract(a.details,'$.guide.title')) AS title,
      a.details IS NOT NULL AS estimated FROM history_live_allocations a LEFT JOIN history_media m ON m.id=a.media_id
      WHERE a.session_id=? ORDER BY a.day,a.rowid LIMIT 100`).all(id) as HistorySessionDetail['allocations'];
    return { session: sessionDto(session), observedAt, deliveryMs, allocations };
  });
}
