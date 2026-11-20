import type { HistoryGraphs, HistoryListRow, HistoryMediaRank, HistorySessionDetail, HistorySort, HistorySummary, HistoryUsage, HistoryUserDetail, HistoryUserRank } from '../../../../packages/contracts/src/index.js';
import type { Db } from './database.js';
import { requireThat } from '../errors.js';
import type { HistoryMediaFilter, HistoryRange, HistorySessionFilter } from '../history-api.js';

// Admin › History's reports over watch-history's tables (modules/migrations/watch-history.ts). HistoryStore records;
// this reads. Its SQL lives here only.

type Range = HistoryRange;
type RawSession = Omit<HistoryListRow, 'title' | 'kind' | 'showTitle' | 'durationMs' | 'year' | 'season' | 'episode' | 'channelNumber' | 'stream'> &
  { metadata: string; stream: string };
const fields = `s.id,s.source,s.account_id AS accountId,s.account_name AS accountName,m.server_id AS serverId,m.rating_key AS ratingKey,
  m.metadata,s.client,s.ip,s.stream,s.started_at AS startedAt,s.ended_at AS endedAt,s.watch_ms AS watchMs,s.position_ms AS positionMs,s.end_reason AS endReason`;
const sessionDto = ({ metadata, stream, ...row }: RawSession): HistoryListRow => {
  const { title, type: kind, durationMs, showTitle, year, season, episode, number: channelNumber } = JSON.parse(metadata);
  return { ...row, title, kind, durationMs, showTitle, year, season, episode, channelNumber, stream: JSON.parse(stream) };
};
// How Sessions sort; empty values go last, then newest first (docs/UI.md).
const sortColumns: Record<HistorySort, string> = {
  started: 's.started_at',
  title: "lower(COALESCE(json_extract(m.metadata,'$.showTitle'),json_extract(m.metadata,'$.title')))",
  user: 'lower(COALESCE(s.account_name,s.account_id))',
  player: 'lower(s.client)',
  source: 's.source',
  watch: 's.watch_ms',
  progress: "CASE WHEN json_extract(m.metadata,'$.durationMs')>0 THEN MIN(1.0,CAST(s.position_ms AS REAL)/json_extract(m.metadata,'$.durationMs')) END"
};
const titleOf = (metadata: string) => {
  const m = JSON.parse(metadata) as { title: string; showTitle?: string; season?: number; episode?: number };
  return m.showTitle ? `${m.showTitle} · ${m.season != null && m.episode != null ? `S${m.season}E${m.episode}` : m.title}` : m.title;
};
// "Plex for Windows · windows" is player "Plex for Windows" on platform "Windows".
const playerOf = (client: string) => client.split(' · ')[0] || 'Unknown';
const platformOf = (client: string) => { const p = client.split(' · ')[1]; return p ? p[0]!.toUpperCase() + p.slice(1) : 'Unknown'; };
// Sessions counted by a name (case-insensitive), most used first.
function usage(rows: { name: string; watchMs: number; at: number }[]): HistoryUsage[] {
  const by = new Map<string, HistoryUsage>();
  for (const r of rows) {
    const key = r.name.toLowerCase(), u = by.get(key) ?? { name: r.name, sessions: 0, watchMs: 0, lastAt: 0 };
    u.sessions++; u.watchMs += r.watchMs; u.lastAt = Math.max(u.lastAt, r.at);
    by.set(key, u);
  }
  return [...by.values()].sort((a, b) => b.sessions - a.sessions || b.watchMs - a.watchMs).slice(0, 20);
}
// A session that ended a moment ago may still resume (PlaybackHistory's resume window), which would write it back.
const RESUME_GUARD_MS = 5 * 60000;
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

export class HistoryReports {
  constructor(private db: Db) {}
  summary(filter: HistoryRange): HistorySummary {
    const range = scope(filter, true), sessions = scope(filter);
    const days = this.db.prepare(`SELECT d.day,SUM(d.direct_ms+d.remux_ms+d.transcode_ms) AS watchMs
      FROM history_days d JOIN history_sessions s ON s.id=d.session_id${range.sql()}
      GROUP BY d.day ORDER BY d.day DESC LIMIT 366`).all(...range.bindings) as HistorySummary['days'];
    const totals = this.db.prepare(`SELECT COALESCE(SUM(d.direct_ms+d.remux_ms+d.transcode_ms),0) AS watchMs,
      COUNT(DISTINCT s.account_id) AS viewers FROM history_days d JOIN history_sessions s ON s.id=d.session_id${range.sql()}`)
      .get(...range.bindings) as Pick<HistorySummary, 'viewers' | 'watchMs'>;
    const delivery = this.db.prepare(`SELECT COUNT(*) AS sessions,COUNT(*) FILTER(WHERE mode='direct') AS direct,
      COUNT(*) FILTER(WHERE mode='remux') AS remux,COUNT(*) FILTER(WHERE mode='transcode') AS transcode
      FROM (SELECT CASE WHEN direct>=remux AND direct>=transcode THEN 'direct'
        WHEN remux>=transcode THEN 'remux' ELSE 'transcode' END AS mode
        FROM (SELECT SUM(d.direct_ms) AS direct,SUM(d.remux_ms) AS remux,SUM(d.transcode_ms) AS transcode
          FROM history_sessions s JOIN history_days d ON d.session_id=s.id${sessions.sql()} GROUP BY s.id))`).get(...sessions.bindings) as
      HistorySummary['delivery'] & { sessions: number };
    return { ...totals, days: days.reverse(), sessions: delivery.sessions, delivery: { direct: delivery.direct, remux: delivery.remux, transcode: delivery.transcode } };
  }
  users(filter: HistoryRange): HistoryUserRank[] {
    const range = scope(filter, true);
    const rows = this.db.prepare(`SELECT s.account_id AS id,COALESCE(MAX(s.account_name),'Plex user '||s.account_id) AS title,
      COUNT(DISTINCT s.id) AS sessions,SUM(d.direct_ms+d.remux_ms+d.transcode_ms) AS watchMs,1 AS viewers,
      MAX(s.started_at) AS lastAt,COUNT(DISTINCT s.client) AS players
      FROM history_days d JOIN history_sessions s ON s.id=d.session_id${range.sql()}
      GROUP BY s.account_id ORDER BY watchMs DESC,s.account_id LIMIT 100`).all(...range.bindings) as Omit<HistoryUserRank, 'lastTitle' | 'lastClient' | 'lastIp'>[];
    const last = this.db.prepare(`SELECT s.client,s.ip,m.metadata FROM history_sessions s JOIN history_media m ON m.id=s.media_id
      WHERE s.account_id=? AND s.started_at=? LIMIT 1`);
    return rows.map(row => {
      const l = last.get(row.id, row.lastAt) as { client: string; ip: string | null; metadata: string } | undefined;
      return { ...row, lastTitle: l ? titleOf(l.metadata) : '', lastClient: l?.client ?? '', lastIp: l?.ip ?? null };
    });
  }
  // One viewer's addresses, players and sources over the range.
  user(id: string, filter: HistoryRange): HistoryUserDetail {
    const range = scope({ ...filter, user: id });
    const rows = this.db.prepare(`SELECT COALESCE(s.ip,'') AS ip,s.client,s.source,s.watch_ms AS watchMs,s.started_at AS at
      FROM history_sessions s${range.sql()} ORDER BY s.started_at DESC LIMIT 20000`).all(...range.bindings) as
      { ip: string; client: string; source: string; watchMs: number; at: number }[];
    return { ips: usage(rows.map(r => ({ ...r, name: r.ip }))), players: usage(rows.map(r => ({ ...r, name: r.client }))),
      sources: usage(rows.map(r => ({ ...r, name: r.source }))) };
  }
  graphs(filter: HistoryRange): HistoryGraphs {
    const range = scope(filter), dayRange = scope(filter, true);
    const rows = this.db.prepare(`SELECT s.started_at AS startedAt,COALESCE(s.ended_at,s.observed_at) AS endedAt,s.watch_ms AS watchMs,s.client
      FROM history_sessions s${range.sql()} ORDER BY s.started_at DESC LIMIT 100000`).all(...range.bindings) as
      { startedAt: number; endedAt: number; watchMs: number; client: string }[];
    const weekdays = Array.from({ length: 7 }, () => ({ sessions: 0, watchMs: 0 })), hours = Array.from({ length: 24 }, () => ({ sessions: 0, watchMs: 0 }));
    const edges: [number, number][] = [];
    for (const r of rows) {
      const at = new Date(r.startedAt), w = weekdays[at.getDay()]!, h = hours[at.getHours()]!;
      w.sessions++; w.watchMs += r.watchMs; h.sessions++; h.watchMs += r.watchMs;
      edges.push([r.startedAt, 1], [Math.max(r.startedAt, r.endedAt), -1]);
    }
    // Most streams at once. Ends sort before starts at the same instant, so back-to-back plays don't count as overlapping.
    edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let open = 0, peak: HistoryGraphs['peak'] = null;
    for (const [at, change] of edges) { open += change; if (open > (peak?.streams ?? 0)) peak = { streams: open, at }; }
    const days = this.db.prepare(`SELECT d.day,SUM(d.direct_ms) AS direct,SUM(d.remux_ms) AS remux,SUM(d.transcode_ms) AS transcode
      FROM history_days d JOIN history_sessions s ON s.id=d.session_id${dayRange.sql()} GROUP BY d.day ORDER BY d.day DESC LIMIT 366`)
      .all(...dayRange.bindings) as HistoryGraphs['days'];
    return { weekdays, hours, peak, days: days.reverse(),
      players: usage(rows.map(r => ({ name: playerOf(r.client), watchMs: r.watchMs, at: r.startedAt }))),
      platforms: usage(rows.map(r => ({ name: platformOf(r.client), watchMs: r.watchMs, at: r.startedAt }))) };
  }
  // Removes one finished session and its totals.
  remove(id: string, now = Date.now()) {
    const row = this.db.prepare('SELECT ended_at AS endedAt,observed_at AS observedAt FROM history_sessions WHERE id=?').get(id) as
      { endedAt: number | null; observedAt: number } | undefined;
    requireThat(row, 'HISTORY_NOT_FOUND', 'This session could not be found.', 404);
    requireThat(row.endedAt !== null && now - row.observedAt >= RESUME_GUARD_MS, 'HISTORY_OPEN', 'This session ended too recently to delete. Try again in a few minutes.', 409);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM history_live_allocations WHERE session_id=?').run(id);
      this.db.prepare('DELETE FROM history_days WHERE session_id=?').run(id);
      this.db.prepare('DELETE FROM history_sessions WHERE id=?').run(id);
    })();
  }
  media(filter: HistoryMediaFilter): HistoryMediaRank[] {
    const range = scope(filter, true);
    const where = range.sql();
    const andWhere = where ? where + ' AND ' : ' WHERE ';
    const programs = filter.kind === 'all' || filter.kind === 'programs' ? this.db.prepare(`
      SELECT a.feed_id||':'||a.airing_id AS id,MAX(json_extract(a.details,'$.guide.title')) AS title,'program' AS kind,
        COUNT(DISTINCT s.id) AS sessions, SUM(a.watch_ms) AS watchMs,COUNT(DISTINCT s.account_id) AS viewers,MAX(s.started_at) AS lastAt
        FROM history_live_allocations a JOIN history_sessions s ON s.id=a.session_id
        JOIN history_days d ON d.session_id=a.session_id AND d.day=a.day${andWhere}a.details IS NOT NULL
        GROUP BY a.feed_id,a.airing_id ORDER BY watchMs DESC,id LIMIT 100`).all(...range.bindings) as HistoryMediaRank[] : [];
    if (filter.kind === 'programs') return programs;
    const kind = { all: undefined, movies: 'movie', shows: 'episode', episodes: 'episode', channels: 'channel' }[filter.kind];
    const show = filter.kind === 'shows';
    const rollups = filter.kind === 'all' ? 'VALUES (0), (1)' : show ? 'VALUES (1)' : 'VALUES (0)';
    const items = this.db.prepare(`WITH watched AS (
      SELECT s.id,s.account_id,s.media_id,s.started_at AS at,d.direct_ms+d.remux_ms+d.transcode_ms AS ms
        FROM history_days d JOIN history_sessions s ON s.id=d.session_id${where}
      UNION ALL
      SELECT s.id,s.account_id,a.media_id,s.started_at AS at,a.watch_ms AS ms FROM history_live_allocations a
        JOIN history_sessions s ON s.id=a.session_id JOIN history_days d ON d.session_id=a.session_id AND d.day=a.day
        ${andWhere}a.media_id IS NOT NULL
    )
    SELECT CASE WHEN r.column1=1 THEN m.server_id||':'||json_extract(m.metadata,'$.showId') ELSE CAST(MAX(m.id) AS TEXT) END AS id,
      CASE WHEN r.column1=1 THEN 'show' ELSE json_extract(m.metadata,'$.type') END AS kind,
      MAX(CASE WHEN r.column1=1 THEN json_extract(m.metadata,'$.showTitle') ELSE json_extract(m.metadata,'$.title') END) AS title,
      COUNT(DISTINCT w.id) AS sessions,
      SUM(w.ms) AS watchMs,COUNT(DISTINCT w.account_id) AS viewers,MAX(w.at) AS lastAt,MAX(m.server_id) AS serverId,
      CASE WHEN r.column1=1 THEN MAX(json_extract(m.metadata,'$.showId')) ELSE MAX(m.rating_key) END AS ratingKey,
      CASE WHEN r.column1=1 THEN NULL ELSE MAX(json_extract(m.metadata,'$.showTitle')) END AS showTitle,
      CASE WHEN r.column1=1 THEN NULL ELSE MAX(json_extract(m.metadata,'$.season')) END AS season,
      CASE WHEN r.column1=1 THEN NULL ELSE MAX(json_extract(m.metadata,'$.episode')) END AS episode,
      CASE WHEN r.column1=1 THEN NULL ELSE MAX(json_extract(m.metadata,'$.year')) END AS year
    FROM watched w JOIN history_media m ON m.id=w.media_id CROSS JOIN (${rollups}) r
    WHERE (r.column1=0 OR (json_extract(m.metadata,'$.type')='episode' AND json_extract(m.metadata,'$.showId') IS NOT NULL))
    ${kind ? "AND json_extract(m.metadata,'$.type')=?" : ''}
    GROUP BY m.server_id,kind,CASE WHEN r.column1=1 THEN json_extract(m.metadata,'$.showId') ELSE m.rating_key END
    ORDER BY watchMs DESC,id LIMIT 100`).all(...range.bindings, ...range.bindings, ...(kind ? [kind] : [])) as HistoryMediaRank[];
    for (const item of items) for (const key of ['showTitle', 'season', 'episode', 'year'] as const) if (item[key] === null) delete item[key];
    if (!programs.length) return items;
    return [...items, ...programs].sort((a, b) => b.watchMs - a.watchMs || a.id.localeCompare(b.id)).slice(0, 100);
  }
  sessions(filter: HistorySessionFilter): { items: HistoryListRow[]; next: string | undefined } {
    const range = scope(filter);
    const column = sortColumns[filter.sort], dir = filter.dir === 'asc' ? 'ASC' : 'DESC', offset = filter.cursor ?? 0;
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
    if (filter.media || (filter.show || filter.key) && filter.server) {
      const where = filter.media
        ? 'target.server_id=(SELECT server_id FROM history_media WHERE id=?) AND target.rating_key=(SELECT rating_key FROM history_media WHERE id=?)'
        : filter.show ? "target.server_id=? AND json_extract(target.metadata,'$.showId')=?"
        : "target.server_id=? AND (target.rating_key=? OR json_extract(target.metadata,'$.showId')=?)";
      range.where.push(`(EXISTS(SELECT 1 FROM history_media target WHERE target.id=s.media_id AND ${where})
        OR EXISTS(SELECT 1 FROM history_live_allocations a JOIN history_media target ON target.id=a.media_id WHERE a.session_id=s.id AND ${where}))`);
      const set = filter.media ? [filter.media, filter.media] : filter.show ? [filter.server!, filter.show] : [filter.server!, filter.key!, filter.key!];
      range.bindings.push(...set, ...set);
    }
    if (filter.airing) {
      const separator = filter.airing.indexOf(':');
      requireThat(separator > 0, 'HISTORY_AIRING', 'The program filter is invalid.');
      range.where.push('EXISTS(SELECT 1 FROM history_live_allocations a WHERE a.session_id=s.id AND a.feed_id=? AND a.airing_id=?)');
      range.bindings.push(filter.airing.slice(0, separator), filter.airing.slice(separator + 1));
    }
    const rows = (this.db.prepare(`SELECT ${fields} FROM history_sessions s JOIN history_media m ON m.id=s.media_id${range.sql()}
      ORDER BY ${column} IS NULL,${column} ${dir},s.started_at DESC,s.id DESC LIMIT ? OFFSET ?`).all(...range.bindings, filter.limit + 1, offset) as RawSession[]).map(sessionDto);
    const items = rows.slice(0, filter.limit);
    return { items, next: rows.length > items.length ? String(offset + filter.limit) : undefined };
  }
  session(id: string): HistorySessionDetail {
    const raw = this.db.prepare(`SELECT ${fields},s.observed_at AS observedAt FROM history_sessions s JOIN history_media m ON m.id=s.media_id WHERE s.id=?`)
      .get(id) as (RawSession & { observedAt: number }) | undefined;
    requireThat(raw, 'HISTORY_NOT_FOUND', 'This session could not be found.', 404);
    const { observedAt, ...session } = raw;
    const deliveryMs = this.db.prepare(`SELECT COALESCE(SUM(direct_ms),0) AS direct,COALESCE(SUM(remux_ms),0) AS remux,
      COALESCE(SUM(transcode_ms),0) AS transcode FROM history_days WHERE session_id=?`).get(id) as HistorySessionDetail['deliveryMs'];
    const allocations = this.db.prepare(`SELECT a.day,a.feed_id AS feedId,a.watch_ms AS watchMs,
      COALESCE(json_extract(m.metadata,'$.title'),json_extract(a.details,'$.guide.title')) AS title,
      a.details IS NOT NULL AS estimated FROM history_live_allocations a LEFT JOIN history_media m ON m.id=a.media_id
      WHERE a.session_id=? ORDER BY a.day,a.rowid LIMIT 100`).all(id) as HistorySessionDetail['allocations'];
    return { session: sessionDto(session), observedAt, deliveryMs, allocations };
  }
}
