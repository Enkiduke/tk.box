import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { HistoryGraphs, HistoryListRow, HistoryMediaRank, HistorySessionDetail, HistorySource, HistorySummary, HistoryUsage,
  HistoryUserDetail, HistoryUserRank } from '../../../packages/contracts/src/index.js';
import { api, ApiClientError } from './api.js';
import { ErrorNotice, Icon } from './components.js';
import { invalidate, link, replaceRoute, timecode, useApi, useApiAll, useDebounced } from './hooks.js';
import { ACTIONS, ColumnsMenu, Dash, IconAction, Loaded, Panel, Pill, RowActions, Segmented, Table, Tabs, Tag, When, matches,
  useColumns, usePaged, useSorted, type Column, type SortState, type Tone } from './manage-ui.js';
import { SectionHead, Stat } from './settings-ui.js';
import { NowPlaying, useLiveActivity } from './activity-admin.js';
import './history-admin.css';

// Admin › Activity: what is playing now, and the watch history behind it (History, Titles, Users, Graphs), all for
// one period and source chosen in the header.

const base = '/admin/history';
type Tab = 'now' | 'history' | 'titles' | 'users' | 'graphs';
const tabIds: Tab[] = ['now', 'history', 'titles', 'users', 'graphs'];
const oldTabs: Record<string, Tab> = { sessions: 'history', media: 'titles' };
const periods = [['7', '7 d'], ['30', '30 d'], ['90', '90 d'], ['365', '1 y'], ['all', 'All']] as const;
type Period = typeof periods[number][0];
const sourceOptions = [['', 'All'], ['vod', 'tk.box'], ['plex', 'Plex'], ['iptv', 'IPTV'], ['custom', 'Custom']] as const;
const sources: Record<HistorySource, string> = { vod: 'tk.box', plex: 'Plex app', iptv: 'IPTV', custom: 'Custom channel' };
const delivery: Record<string, string> = { direct: 'Direct Play', remux: 'Direct Stream', transcode: 'Transcode' };
const deliveryTone: Record<string, Tone> = { direct: 'ok', remux: 'active', transcode: 'wait' };
const resultLabel: Record<string, string> = { ended: 'Reached end', stopped: 'Stopped', replacing: 'Stream replaced', idle: 'Timed out',
  interrupted: 'Interrupted', revoked: 'Signed out', admin: 'Stopped by admin' };
const exact = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const shortDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const watch = (ms: number) => ms < 60000 ? `${Math.floor(ms / 1000)}s` :
  `${ms >= 3600000 ? `${Math.floor(ms / 3600000)}h ` : ''}${Math.floor(ms / 60000) % 60}m`;
const userName = (row: HistoryListRow) => row.accountName ?? `Plex user ${row.accountId}`;
const episodeTag = (season?: number, episode?: number) => season != null && episode != null ? `S${season}E${episode}` : undefined;
const decision = (d: string) => ({ copy: 'Copy', transcode: 'Transcode', directplay: 'Direct Play' }[d.toLowerCase()] ?? d);
const percent = (row: HistoryListRow) => row.durationMs && row.durationMs > 0 ? Math.min(100, Math.round(row.positionMs / row.durationMs * 100)) : undefined;
const route = (params: URLSearchParams, change: Record<string, string | undefined>) => link('admin', { ...Object.fromEntries(params), section: 'activity', ...change });
type Change = (change: Record<string, string | undefined>) => void;
// Everything a tab's own filters set; cleared when the tab changes.
const tabParams = { q: undefined, kind: undefined, type: undefined, user: undefined, media: undefined, show: undefined, server: undefined,
  airing: undefined, sort: undefined, dir: undefined, session: undefined, cursor: undefined };

export function ActivityPage({ params }: { params: URLSearchParams }) {
  const requested = params.get('tab') ?? 'now', tab = tabIds.find(t => t === (oldTabs[requested] ?? requested)) ?? 'now';
  const days: Period = periods.find(([id]) => id === params.get('days'))?.[0] ?? '30';
  const source = sourceOptions.find(([id]) => id === params.get('source'))?.[0] ?? '';
  const filter = new URLSearchParams({ days });
  if (source) filter.set('source', source);
  const set: Change = change => replaceRoute(route(params, change));
  const live = useLiveActivity();
  return <>
    <SectionHead title="Activity" description={live.summary}>
      {tab !== 'now' && <div className="activity-filters">
        <Segmented label="Period" value={days} options={periods} onChange={v => set({ days: v === '30' ? undefined : v })} />
        <Segmented label="Source" value={source} options={sourceOptions} onChange={v => set({ source: v || undefined })} />
      </div>}
    </SectionHead>
    <Tabs label="Activity" value={tab} onChange={t => set({ ...tabParams, tab: t === 'now' ? undefined : t })} tabs={[
      { id: 'now', label: 'Now playing', count: live.view?.streams.length, tone: 'active' }, { id: 'history', label: 'History' },
      { id: 'titles', label: 'Titles' }, { id: 'users', label: 'Users' }, { id: 'graphs', label: 'Graphs' }]} />
    {tab === 'now' ? <NowPlaying live={live} /> :
      tab === 'history' ? <History params={params} filter={filter} set={set} /> :
      tab === 'titles' ? <Titles key={filter.toString()} params={params} filter={filter} set={set} /> :
      tab === 'users' ? <Users key={filter.toString()} params={params} filter={filter} set={set} /> :
      <Graphs filter={filter} days={days} />}
  </>;
}

// ---- History ----

// Back-to-back plays of one title by one viewer (within 3 h of each other) show as one row, as Tautulli groups them.
const GROUP_GAP_MS = 3 * 3600000;
type Play = { id: string; rows: HistoryListRow[] };
function grouped(rows: HistoryListRow[]): Play[] {
  const plays: Play[] = [];
  for (const row of rows) {
    const last = plays.at(-1), oldest = last?.rows.at(-1);
    if (last && oldest && oldest.accountId === row.accountId && oldest.serverId === row.serverId && oldest.ratingKey === row.ratingKey &&
        oldest.startedAt - (row.endedAt ?? row.startedAt) < GROUP_GAP_MS) last.rows.push(row);
    else plays.push({ id: row.id, rows: [row] });
  }
  return plays;
}
const sessionKinds = [['', 'All'], ['movie', 'Movies'], ['episode', 'Episodes'], ['channel', 'Channels']] as const;
const groupings = [['on', 'Grouped'], ['off', 'Every play']] as const;
// The player shows under the viewer's name; its own column (sortable) is optional. IP addresses are recorded from
// 2026-11-19, so older plays have none.
const historyColumns = [['player', 'Player', false], ['ip', 'IP address', false], ['stream', 'Stream', true], ['progress', 'Progress', true], ['ended', 'Ended', false]] as const;
const PAGE = 100;
type SessionPage = { items: HistoryListRow[]; next?: string };

function History({ params, filter, set }: { params: URLSearchParams; filter: URLSearchParams; set: Change }) {
  const [draft, setDraft] = useState(params.get('q') ?? ''), q = useDebounced(draft.trim(), 300);
  useEffect(() => { if (q !== (params.get('q') ?? '')) set({ q: q || undefined }); }, [q]);
  const sortKey = params.get('sort'), sort: SortState = sortKey ? { key: sortKey, dir: params.get('dir') === 'asc' ? 1 : -1 } : { key: 'started', dir: -1 };
  const query = new URLSearchParams(filter);
  for (const key of ['q', 'media', 'airing', 'show', 'server', 'user']) { const value = params.get(key); if (value) query.set(key, value); }
  if (params.get('type')) query.set('kind', params.get('type')!);
  query.set('sort', sort.key); query.set('dir', sort.dir === 1 ? 'asc' : 'desc');
  const [pages, setPages] = useState(1);
  useEffect(() => setPages(1), [query.toString()]);
  const view = useApiAll<SessionPage>(Array.from({ length: pages }, (_, i) => `${base}/sessions?${query}&limit=${PAGE}&cursor=${i * PAGE}`));
  const rows = view.data.flatMap(page => page?.items ?? []), next = view.data.at(-1)?.next;
  const grouping = params.get('group') !== 'off' && sort.key === 'started';
  const plays = grouping ? grouped(rows) : rows.map(row => ({ id: row.id, rows: [row] }));
  const columns = useColumns('activity-history', historyColumns), has = columns.has;
  const [open, setOpen] = useState<string>(), [failure, setFailure] = useState<string>();
  const onSort = (key: string, first: 1 | -1) => {
    const nextSort = sort.key !== key ? { key, dir: first } : sort.dir === first ? { key, dir: -first } : undefined;
    set({ sort: nextSort && !(nextSort.key === 'started' && nextSort.dir === -1) ? nextSort.key : undefined, dir: nextSort ? nextSort.dir === 1 ? 'asc' : 'desc' : undefined });
  };
  const remove = (play: Play) => {
    const first = play.rows[0]!, many = play.rows.length > 1;
    if (!window.confirm(`Delete ${many ? `these ${play.rows.length} plays` : 'this play'} of ${first.showTitle ?? first.title} by ${userName(first)} from history?`)) return;
    setFailure(undefined);
    void Promise.all(play.rows.map(r => api(`${base}/sessions/${r.id}`, 'DELETE')))
      .catch((e: ApiClientError) => setFailure(e.message)).finally(() => invalidate(base));
  };
  // A filter from another tab (a viewer, a title) names itself from the first row and can be cleared.
  const scoped = ['user', 'media', 'show', 'airing'].some(k => params.has(k));
  const scopeName = rows[0] && (params.has('user') ? userName(rows[0]) : rows[0].showTitle && (params.has('show') || !params.has('media')) ? rows[0].showTitle : rows[0].title);
  const cols: Column[] = [{ label: 'Title', sort: 'title' }, { label: 'User', width: 160, sort: 'user' },
    ...(has('player') ? [{ label: 'Player', width: 170, sort: 'player' }] : []), ...(has('ip') ? [{ label: 'IP address', width: 120 }] : []),
    ...(has('stream') ? [{ label: 'Stream', width: 130, sort: 'source' }] : []), { label: 'Started', width: 100, sort: 'started', desc: true },
    { label: 'Watched', width: 108, num: true, sort: 'watch', desc: true }, ...(has('progress') ? [{ label: 'Progress', width: 108, num: true, sort: 'progress', desc: true }] : []),
    ...(has('ended') ? [{ label: 'Ended', width: 120 }] : []), ACTIONS];
  return <>
    {failure && <ErrorNotice message={failure} dismiss={() => setFailure(undefined)} />}
    <Panel flush title={scoped ? <span className="history-scope">Plays · {scopeName ?? '…'}
      <button type="button" className="icon-button" title="Show every play" aria-label="Clear filter"
        onClick={() => set({ user: undefined, media: undefined, show: undefined, server: undefined, airing: undefined })}><Icon name="close" size={14} /></button></span> : 'Plays'}
      actions={<>
        <label className="ui-search"><Icon name="search" size={15} /><input type="search" placeholder="Title, show or viewer" aria-label="Search plays" value={draft} maxLength={80} onChange={e => setDraft(e.target.value)} /></label>
        <Segmented label="Media type" value={sessionKinds.find(([id]) => id === params.get('type'))?.[0] ?? ''} options={sessionKinds} onChange={v => set({ type: v || undefined })} />
        <span title={sort.key === 'started' ? undefined : 'Plays group when sorted by Started'}>
          <Segmented label="Grouping" value={grouping ? 'on' : 'off'} options={groupings} onChange={v => set({ group: v === 'off' ? 'off' : undefined, sort: undefined, dir: undefined })} /></span>
        <ColumnsMenu columns={columns} />
      </>}>
      {view.error && !rows.length ? <ErrorNotice message={(view.error as Error).message} retry={view.retry} /> :
        <Table posters columns={cols} sort={sort} onSort={onSort}
          empty={!view.loading && !plays.length ? 'No plays match' : view.loading && !rows.length ? 'Loading…' : undefined}
          more={next && <div className="ui-more"><button type="button" disabled={view.loading} onClick={() => setPages(p => p + 1)}>Show {PAGE} more</button></div>}>
          {plays.map(play => {
            const first = play.rows[0]!, last = play.rows.at(-1)!, live = play.rows.some(r => r.endedAt === null), expanded = open === play.id;
            const total = play.rows.reduce((n, r) => n + r.watchMs, 0), pct = percent(first), toggle = () => setOpen(expanded ? undefined : play.id);
            const sub = first.kind === 'episode' ? [episodeTag(first.season, first.episode), first.title].filter(Boolean).join(' · ')
              : first.kind === 'channel' ? first.channelNumber != null ? `Channel ${first.channelNumber}` : 'Channel' : undefined;
            return [<tr key={play.id}>
              <td><div className="history-title">
                <button type="button" className="ui-expand" aria-expanded={expanded} aria-label={`${expanded ? 'Hide' : 'Show'} details`} onClick={toggle}><Icon name={expanded ? 'up' : 'down'} size={14} /></button>
                <Thumb kind={first.kind} serverId={first.serverId} ratingKey={first.ratingKey} />
                <div><button type="button" className="ui-title-name history-link" onClick={toggle} title={first.showTitle ?? first.title}>{first.showTitle ?? first.title}</button>
                  {first.kind === 'movie' && first.year ? <span className="ui-title-year">{first.year}</span> : null}
                  {play.rows.length > 1 && <span className="ui-title-tags"><Tag>{play.rows.length} plays</Tag></span>}
                  {sub && <small title={sub}>{sub}</small>}</div>
              </div></td>
              <td><a className="history-user" href={route(params, { user: first.accountId })} title={`Plays by ${userName(first)}`}>{userName(first)}</a>
                {!has('player') && <small title={first.client}>{first.client}</small>}</td>
              {has('player') && <td><span className="history-cut" title={first.client}>{first.client}</span></td>}
              {has('ip') && <td className="history-mono">{first.ip ?? <Dash />}</td>}
              {has('stream') && <td className="history-stream"><Pill tone={deliveryTone[first.stream.delivery]}>{delivery[first.stream.delivery] ?? 'Unknown'}</Pill><small>{sources[first.source]}</small></td>}
              <td><When at={last.startedAt} /></td>
              <td className="num">{watch(total)}</td>
              {has('progress') && <td className="num">{live ? <Pill tone="active">Playing</Pill> : pct !== undefined ? `${pct}%` : <Dash />}</td>}
              {has('ended') && <td>{live ? <Dash /> : resultLabel[first.endReason ?? ''] ?? 'Ended'}</td>}
              <td><RowActions>
                <IconAction icon="info" label="Details" onClick={toggle} />
                <IconAction icon="trash" label={live ? 'Still playing' : 'Delete from history'} disabled={live} onClick={() => remove(play)} />
              </RowActions></td>
            </tr>, expanded && <tr key={`${play.id}:detail`} className="ui-release-detail"><td colSpan={cols.length}><PlayDetail play={play} /></td></tr>];
          })}
        </Table>}
    </Panel>
  </>;
}

function Thumb({ kind, serverId, ratingKey }: { kind: string; serverId?: string; ratingKey?: string }) {
  const [failed, setFailed] = useState(false);
  const src = !ratingKey ? undefined : kind === 'channel' ? serverId === 'iptv' ? `/api/v1/iptv/channels/${encodeURIComponent(ratingKey)}/logo` : undefined
    : kind === 'program' ? undefined : `/api/v1/catalog/items/${encodeURIComponent(ratingKey)}/artwork?kind=poster`;
  return <span className={`ui-poster history-thumb${kind === 'channel' ? ' logo' : ''}`} aria-hidden="true">
    {src && !failed ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
      : <Icon name={kind === 'channel' || kind === 'program' ? 'live' : kind === 'movie' ? 'film' : 'shows'} size={14} />}</span>;
}

function PlayDetail({ play }: { play: Play }) {
  const first = play.rows[0]!;
  const view = useApi<HistorySessionDetail>(`${base}/sessions/${encodeURIComponent(first.id)}`);
  return <Loaded view={view}>{({ session: row, observedAt, deliveryMs, allocations }) => {
    const pct = percent(row), stream = row.stream, modes = Object.entries(deliveryMs ?? {}).filter(([, ms]) => ms > 0);
    const facts = (items: [string, ReactNode][]) => <dl className="history-facts">{items.filter(([, v]) => v !== undefined && v !== '' && v !== false)
      .map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
    return <div className="history-detail">
      <div className="ui-detail">
        <div><h4>Playback</h4>{facts([
          ['Started', exact.format(row.startedAt)],
          [row.endedAt === null ? 'Last seen' : 'Ended', exact.format(row.endedAt ?? observedAt)],
          ['Watched', <>{watch(row.watchMs)}{row.source === 'plex' && <span className="muted"> · estimated from Plex</span>}</>],
          ['Position', row.durationMs && <>{timecode(Math.min(row.positionMs, row.durationMs) / 1000)} / {timecode(row.durationMs / 1000)}{pct !== undefined && ` · ${pct}%`}
            <span className="history-bar"><span style={{ width: `${pct ?? 0}%` }} /></span></>],
          ['Result', row.endedAt === null ? 'Playing' : resultLabel[row.endReason ?? ''] ?? 'Ended']])}</div>
        <div><h4>Stream</h4>{facts([
          ['Source', sources[row.source]],
          ['Delivery', <>{delivery[stream.delivery] ?? 'Unknown'}{modes.length > 1 && <span className="muted"> · {modes.map(([m, ms]) => `${delivery[m]} ${watch(ms)}`).join(', ')}</span>}</>],
          ['Video', stream.video && decision(stream.video)], ['Audio', stream.audio && decision(stream.audio)],
          ['Resolution', [stream.sourceHeight && `${stream.sourceHeight}p`, stream.outputHeight ? `→ ${stream.outputHeight}p` : stream.maxHeight && `→ ${stream.maxHeight}p max`].filter(Boolean).join(' ')]])}</div>
        <div><h4>Viewer</h4>{facts([['User', userName(row)], ['Player', row.client], ['IP address', row.ip ?? 'Not recorded']])}</div>
      </div>
      {play.rows.length > 1 && <ol className="ui-steps history-plays" aria-label="Plays">{play.rows.map(r => <li key={r.id}>
        <time dateTime={new Date(r.startedAt).toISOString()}>{exact.format(r.startedAt)}</time>
        <span>{watch(r.watchMs)}{percent(r) !== undefined && ` · ${percent(r)}%`}</span>
        <span>{delivery[r.stream.delivery]} · {r.client}</span></li>)}</ol>}
      {allocations.some(a => a.title) && <ol className="ui-steps history-plays" aria-label="Programs viewed">{allocations.map((a, i) => <li key={i}>
        <time>{a.day}</time><span>{watch(a.watchMs)}</span><span>{a.title ?? 'Unattributed channel time'}{a.estimated ? ' · estimated' : ''}</span></li>)}</ol>}
    </div>;
  }}</Loaded>;
}

// ---- Titles ----

const titleKinds = [['all', 'All'], ['movies', 'Movies'], ['shows', 'Shows'], ['episodes', 'Episodes'], ['channels', 'Channels'], ['programs', 'Programs']] as const;
const kindLabels: Record<HistoryMediaRank['kind'], string> = { movie: 'Movie', show: 'Show', episode: 'Episode', channel: 'Channel', program: 'IPTV program' };

function Titles({ params, filter, set }: { params: URLSearchParams; filter: URLSearchParams; set: Change }) {
  const kind = titleKinds.find(([id]) => id === params.get('kind'))?.[0] ?? 'all';
  const [query, setQuery] = useState('');
  const view = useApi<HistoryMediaRank[]>(`${base}/media?${filter}&kind=${kind}`);
  const all = (view.data ?? []).filter(r => matches(query, r.title, r.showTitle));
  const { rows, sort, onSort } = useSorted(all, { title: r => r.title, type: r => kindLabels[r.kind], last: r => r.lastAt, viewers: r => r.viewers,
    plays: r => r.sessions, watch: r => r.watchMs }, { key: 'watch', dir: -1 });
  const { rows: shown, more } = usePaged(rows, `${kind}:${query}`);
  const plays = (r: HistoryMediaRank) => {
    const colon = r.id.lastIndexOf(':');
    return route(params, { ...tabParams, tab: 'history', media: r.kind === 'show' || r.kind === 'program' ? undefined : r.id,
      server: r.kind === 'show' ? r.id.slice(0, colon) : undefined, show: r.kind === 'show' ? r.id.slice(colon + 1) : undefined,
      airing: r.kind === 'program' ? r.id : undefined });
  };
  return <Panel flush title="Titles" actions={<>
    <label className="ui-search"><Icon name="search" size={15} /><input type="search" placeholder="Search titles" aria-label="Search titles" value={query} onChange={e => setQuery(e.target.value)} /></label>
    <Segmented label="Kind" value={kind} options={titleKinds} onChange={v => set({ kind: v === 'all' ? undefined : v })} />
    {view.data && <span className="ui-count">{all.length}</span>}
  </>}>
    <Loaded view={view}>{() => <Table posters more={more} sort={sort} onSort={onSort} empty={all.length ? undefined : 'Nothing watched in this period'}
      columns={[{ label: 'Title', sort: 'title' }, { label: 'Type', width: 130, sort: 'type' }, { label: 'Last watched', width: 120, sort: 'last', desc: true },
        { label: 'Viewers', width: 90, num: true, sort: 'viewers', desc: true }, { label: 'Plays', width: 90, num: true, sort: 'plays', desc: true },
        { label: 'Watch time', width: 120, num: true, sort: 'watch', desc: true }]}>
      {shown.map(r => {
        const sub = r.kind === 'episode' ? [r.showTitle, episodeTag(r.season, r.episode)].filter(Boolean).join(' · ') : r.kind === 'program' ? 'Matched from the guide' : undefined;
        return <tr key={`${r.kind}:${r.id}`}>
          <td><div className="ui-title"><Thumb kind={r.kind} serverId={r.serverId} ratingKey={r.ratingKey} /><div>
            <a className="ui-title-name" href={plays(r)} title={`Plays of ${r.title}`}>{r.title}</a>{r.kind === 'movie' && r.year ? <span className="ui-title-year">{r.year}</span> : null}
            {sub && <small title={sub}>{sub}</small>}</div></div></td>
          <td>{kindLabels[r.kind]}</td><td><When at={r.lastAt} /></td>
          <td className="num">{r.viewers.toLocaleString()}</td><td className="num">{r.sessions.toLocaleString()}</td><td className="num">{watch(r.watchMs)}</td>
        </tr>;
      })}
    </Table>}</Loaded>
  </Panel>;
}

// ---- Users ----

function Users({ params, filter, set }: { params: URLSearchParams; filter: URLSearchParams; set: Change }) {
  const [query, setQuery] = useState(''), [open, setOpen] = useState<string>();
  const view = useApi<HistoryUserRank[]>(`${base}/users?${filter}`);
  const all = (view.data ?? []).filter(r => matches(query, r.title, r.lastClient, r.lastIp ?? undefined));
  const { rows, sort, onSort } = useSorted(all, { name: r => r.title, last: r => r.lastAt, played: r => r.lastTitle,
    players: r => r.players, plays: r => r.sessions, watch: r => r.watchMs }, { key: 'watch', dir: -1 });
  const cols: Column[] = [{ label: 'User', sort: 'name' }, { label: 'Last seen', width: 110, sort: 'last', desc: true }, { label: 'Last played', width: 260, sort: 'played' },
    { label: 'Players', width: 90, num: true, sort: 'players', desc: true },
    { label: 'Plays', width: 90, num: true, sort: 'plays', desc: true }, { label: 'Watch time', width: 120, num: true, sort: 'watch', desc: true }, ACTIONS];
  return <Panel flush title="Users" actions={<>
    <label className="ui-search"><Icon name="search" size={15} /><input type="search" placeholder="Search users, players, IPs" aria-label="Search users" value={query} onChange={e => setQuery(e.target.value)} /></label>
    {view.data && <span className="ui-count">{all.length}</span>}
  </>}>
    <Loaded view={view}>{() => <Table columns={cols} sort={sort} onSort={onSort} empty={all.length ? undefined : 'Nobody watched in this period'}>
      {rows.map(r => {
        const expanded = open === r.id, toggle = () => setOpen(expanded ? undefined : r.id), client = [r.lastClient, r.lastIp].filter(Boolean).join(' · ');
        return [<tr key={r.id}>
          <td><div className="history-title">
            <button type="button" className="ui-expand" aria-expanded={expanded} aria-label={`${expanded ? 'Hide' : 'Show'} ${r.title}’s players and addresses`} onClick={toggle}><Icon name={expanded ? 'up' : 'down'} size={14} /></button>
            <div><button type="button" className="ui-title-name history-link" onClick={toggle}>{r.title}</button><small title={client}>{client}</small></div>
          </div></td>
          <td><When at={r.lastAt} /></td><td><span className="history-cut" title={r.lastTitle}>{r.lastTitle || <Dash />}</span></td>
          <td className="num">{r.players}</td><td className="num">{r.sessions.toLocaleString()}</td><td className="num">{watch(r.watchMs)}</td>
          <td><RowActions><IconAction icon="list" label={`Plays by ${r.title}`} onClick={() => set({ ...tabParams, tab: 'history', user: r.id })} /></RowActions></td>
        </tr>, expanded && <tr key={`${r.id}:detail`} className="ui-release-detail"><td colSpan={cols.length}><UserDetail id={r.id} filter={filter} /></td></tr>];
      })}
    </Table>}</Loaded>
  </Panel>;
}

function UserDetail({ id, filter }: { id: string; filter: URLSearchParams }) {
  const view = useApi<HistoryUserDetail>(`${base}/users/${id}?${filter}`);
  const list = (title: string, items: HistoryUsage[], name: (u: HistoryUsage) => string) => <div><h4>{title}</h4>
    <ul className="history-usage">{items.map(u => <li key={u.name}><span title={name(u)}>{name(u)}</span><small>{u.sessions} {u.sessions === 1 ? 'play' : 'plays'} · <When at={u.lastAt} /></small></li>)}</ul></div>;
  return <Loaded view={view}>{d => <div className="ui-detail">
    {list('IP addresses', d.ips, u => u.name || 'Not recorded')}
    {list('Players', d.players, u => u.name)}
    {list('Sources', d.sources, u => sources[u.name as HistorySource] ?? u.name)}
  </div>}</Loaded>;
}

// ---- Graphs ----

const DAY_MS = 86400000;
const dayKey = (at: number) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hourName = (h: number) => `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`;
const modes = ['direct', 'remux', 'transcode'] as const;

function Graphs({ filter, days }: { filter: URLSearchParams; days: Period }) {
  const summary = useApi<HistorySummary>(`${base}/summary?${filter}`), graphs = useApi<HistoryGraphs>(`${base}/graphs?${filter}`);
  return <Loaded view={summary}>{s => <Loaded view={graphs}>{g => {
    // Every day of the period, with nothing watched as an empty slot, so gaps show as gaps.
    const today = new Date(); today.setHours(12, 0, 0, 0);
    const count = days === 'all' ? Math.min(366, g.days.length ? Math.round((today.getTime() - Date.parse(`${g.days[0]!.day}T12:00:00`)) / DAY_MS) + 1 : 1) : Number(days);
    const byDay = new Map(g.days.map(d => [d.day, d]));
    const series = Array.from({ length: count }, (_, i) => { const day = dayKey(today.getTime() - (count - 1 - i) * DAY_MS); return byDay.get(day) ?? { day, direct: 0, remux: 0, transcode: 0 }; });
    const total = (d: typeof series[number]) => d.direct + d.remux + d.transcode, top = Math.max(1, ...series.map(total));
    const share = (n: number) => s.sessions ? `${Math.round(n / s.sessions * 100)}%` : '—';
    return <div className="history-graphs">
      <div className="history-stats">
        <Stat label="Watch time" value={watch(s.watchMs)} />
        <Stat label="Plays" value={s.sessions.toLocaleString()} />
        <Stat label="Viewers" value={s.viewers.toLocaleString()} />
        <Stat label="Direct Play" value={share(s.delivery.direct)} hint={`${share(s.delivery.remux)} stream · ${share(s.delivery.transcode)} transcode`} />
        <Stat label="Most at once" value={g.peak ? `${g.peak.streams}` : '—'} hint={g.peak ? exact.format(g.peak.at) : undefined} />
      </div>
      <Panel title="Daily watch time" actions={<ul className="history-legend">{modes.map(m => <li key={m}><i data-mode={m} />{delivery[m]}</li>)}</ul>}>
        <div className="history-chart">
          <span className="history-axis-top">{watch(top)}</span>
          <div className="history-days" style={{ gap: count > 90 ? 1 : 2 } as CSSProperties}>{series.map(d => {
            const label = `${shortDay.format(Date.parse(`${d.day}T12:00:00`))} · ${watch(total(d))}${total(d) ? ` (${modes.filter(m => d[m]).map(m => `${delivery[m]} ${watch(d[m])}`).join(', ')})` : ''}`;
            return <div key={d.day} className="history-col" title={label} aria-label={label}>
              <div className="history-stack" style={{ height: `${total(d) / top * 100}%` }}>{[...modes].reverse().filter(m => d[m]).map(m =>
                <span key={m} data-mode={m} style={{ flexGrow: d[m] }} />)}</div></div>;
          })}</div>
          <div className="history-axis">{[series[0], series[Math.floor(series.length / 2)], series.at(-1)].map((d, i) => d && <span key={i}>{shortDay.format(Date.parse(`${d.day}T12:00:00`))}</span>)}</div>
        </div>
      </Panel>
      <div className="history-pair">
        <Panel title="Plays by day of week"><Bars items={g.weekdays.map((d, i) => ({ label: weekdayNames[i]!, ...d }))} /></Panel>
        <Panel title="Plays by hour"><Bars items={g.hours.map((d, i) => ({ label: hourName(i), ...d }))} every={3} /></Panel>
      </div>
      <div className="history-pair">
        <Panel flush title="Players"><UsageTable items={g.players} /></Panel>
        <Panel flush title="Platforms"><UsageTable items={g.platforms} /></Panel>
      </div>
    </div>;
  }}</Loaded>}</Loaded>;
}

// One series of plays as bars, every `every`th label shown under them.
function Bars({ items, every = 1 }: { items: { label: string; sessions: number; watchMs: number }[]; every?: number }) {
  const top = Math.max(1, ...items.map(i => i.sessions));
  return <div className="history-chart small">
    <span className="history-axis-top">{top}</span>
    <div className="history-days">{items.map(i => {
      const label = `${i.label} · ${i.sessions} ${i.sessions === 1 ? 'play' : 'plays'} · ${watch(i.watchMs)}`;
      return <div key={i.label} className="history-col" title={label} aria-label={label}><div className="history-stack" style={{ height: `${i.sessions / top * 100}%` }}><span data-mode="one" style={{ flexGrow: 1 }} /></div></div>;
    })}</div>
    <div className="history-axis even">{items.map((i, n) => <span key={i.label}>{n % every === 0 ? i.label : ''}</span>)}</div>
  </div>;
}

function UsageTable({ items }: { items: HistoryUsage[] }) {
  const top = Math.max(1, ...items.map(i => i.sessions));
  return <Table empty={items.length ? undefined : 'Nothing yet'} columns={[{ label: 'Name' }, { label: 'Plays', width: 140 }, { label: 'Watch time', width: 120, num: true }, { label: 'Last', width: 110 }]}>
    {items.slice(0, 10).map(i => <tr key={i.name}><td><span className="history-cut" title={i.name}>{i.name}</span></td>
      <td><span className="history-meter"><span style={{ width: `${i.sessions / top * 100}%` }} /></span><b className="history-meter-n">{i.sessions}</b></td>
      <td className="num">{watch(i.watchMs)}</td><td><When at={i.lastAt} /></td></tr>)}
  </Table>;
}
