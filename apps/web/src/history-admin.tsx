import { useState, type CSSProperties } from 'react';
import type { HistoryListRow, HistoryMediaRank, HistoryRank, HistorySessionDetail, HistorySource, HistorySummary } from '../../../packages/contracts/src/index.js';
import { Empty, ErrorNotice, Icon, Loading, Modal } from './components.js';
import { link, replaceRoute, timecode, useApi } from './hooks.js';
import { Card, Stat } from './settings-ui.js';
import './history-admin.css';

const base = '/admin/history';
const sources: Record<HistorySource, string> = { vod: 'tk.box VOD', plex: 'Plex app', iptv: 'IPTV', custom: 'Custom Channel' };
const periods = [['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['365', '1 year'], ['all', 'All time']] as const;
const kinds = [['all', 'All'], ['movies', 'Movies'], ['shows', 'Shows'], ['episodes', 'Episodes'], ['channels', 'Channels'], ['programs', 'IPTV programs']] as const;
const sessionKinds = [['', 'All'], ['movie', 'Movies'], ['episode', 'Episodes'], ['channel', 'Channels']] as const;
const mediaLabels: Record<HistoryMediaRank['kind'], string> = { movie: 'Movie', show: 'Show', episode: 'Episode', channel: 'Channel', program: 'IPTV program · Estimated' };
const delivery: Record<string, string> = { direct: 'Direct Play', remux: 'Direct Stream', transcode: 'Transcode' };
const resultLabel: Record<string, string> = { ended: 'Reached end', stopped: 'Stopped', replacing: 'Stream replaced', idle: 'Timed out', interrupted: 'Interrupted', revoked: 'Signed out', admin: 'Stopped by admin' };
const formatDate = (ms: number) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const watch = (ms: number) => ms < 60000 ? `${Math.floor(ms / 1000)}s` :
  `${ms >= 3600000 ? `${Math.floor(ms / 3600000)}h ` : ''}${Math.floor(ms / 60000) % 60}m`;
const userName = (row: HistoryListRow) => row.accountName ?? `Plex user ${row.accountId}`;
const dateLabel = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const timeLabel = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
const sessionTitle = (row: HistoryListRow) => row.kind === 'episode' && row.showTitle ? row.showTitle : row.title;
const sessionSubtitle = (row: HistoryListRow) => {
  if (row.kind === 'episode') {
    const episode = row.season != null && row.episode != null ? `S${row.season}E${row.episode}` : undefined;
    return [row.showTitle && row.title, episode].filter(Boolean).join(' · ');
  }
  if (row.kind === 'movie') return row.year;
  return row.kind === 'channel' && row.channelNumber != null ? `Channel ${row.channelNumber}` : undefined;
};
function playbackPosition({ durationMs, positionMs }: HistoryListRow) {
  if (!durationMs || durationMs < 0 || !Number.isFinite(durationMs) || !Number.isFinite(positionMs)) return;
  const position = Math.max(0, Math.min(positionMs, durationMs));
  return { position, durationMs, label: `${timecode(position / 1000)} / ${timecode(durationMs / 1000)}` };
}
const deliveryLabel = (mode: string) => delivery[mode] ?? 'Unknown';
const decisionLabel = (decision: string) => ({ copy: 'Copy', transcode: 'Transcode', directplay: 'Direct Play' }[decision.toLowerCase()] ?? decision);
type Page = 'media' | 'users' | 'sessions';
type SessionPage = { items: HistoryListRow[]; next?: string };
const route = (params: URLSearchParams, change: Record<string, string | undefined>) => link('admin', { ...Object.fromEntries(params), section: 'activity', ...change });

export function HistoryAdmin({ params }: { params: URLSearchParams }) {
  const requested = params.get('tab');
  const page: Page = requested === 'users' || requested === 'sessions' ? requested : 'media';
  const days = params.get('days') ?? '30', source = params.get('source') ?? '', user = params.get('user') ?? '';
  const filter = new URLSearchParams({ days });
  if (source) filter.set('source', source);
  if (user) filter.set('user', user);
  const set = (change: Record<string, string | undefined>) => replaceRoute(route(params, { cursor: undefined, session: undefined, ...change }));
  return <section className="history-admin" aria-labelledby="activity-history-heading">
    <h3 id="activity-history-heading">History</h3>
    <div className="subtabs" role="tablist" aria-label="History">
      {(['media', 'users', 'sessions'] as const).map(tab => <button key={tab} type="button" role="tab" aria-selected={page === tab}
        onClick={() => set({ tab, q: undefined, media: undefined, airing: undefined, show: undefined, server: undefined, user: undefined, type: undefined })}>
        {{ media: 'Media', users: 'Users', sessions: 'Sessions' }[tab]}
      </button>)}
    </div>
    <div className="history-controls">
      <label>Date range <select value={days} onChange={e => set({ days: e.target.value })}>{periods.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
      <label>Source <select value={source} onChange={e => set({ source: e.target.value })}><option value="">All sources</option>
        {Object.entries(sources).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
      {user && <button type="button" onClick={() => set({ user: undefined })}>Clear user filter</button>}
      {page === 'sessions' && ['media', 'airing', 'show'].some(key => params.has(key)) &&
        <button type="button" onClick={() => set({ media: undefined, airing: undefined, show: undefined, server: undefined })}>Clear media filter</button>}
    </div>
    {page === 'sessions' ? <Sessions key={params.get('q') ?? ''} params={params} filter={filter} set={set} /> :
      <>
        <Summary filter={filter.toString()} />
        {page === 'media' || user ? <MediaRanks params={params} filter={filter} set={set} /> :
          <RankTable path={`${base}/users?${filter}`} title="Viewers" action={row => route(params, { user: row.id })} />}
        {page === 'users' && user && <a className="small" href={route(params, { tab: 'sessions' })}>View this user’s sessions</a>}
      </>}
    {params.get('session') && <SessionDialog key={params.get('session')} id={params.get('session')!}
      close={() => set({ session: undefined, cursor: params.get('cursor') ?? undefined })} />}
  </section>;
}

function Summary({ filter }: { filter: string }) {
  const data = useApi<HistorySummary>(`${base}/summary?${filter}`);
  if (data.error) return <ErrorNotice message={data.error.message} retry={data.reload} />;
  if (!data.data) return <Loading />;
  const { sessions, viewers, watchMs, days, delivery: modes } = data.data;
  const recent = days.slice(-30), largest = Math.max(1, ...recent.map(day => day.watchMs));
  return <>
    <div className="history-stats">
      <Stat label="Watch time" value={watch(watchMs)} />
      <Stat label="Sessions started" value={sessions.toLocaleString()} />
      <Stat label="Viewers" value={viewers.toLocaleString()} />
      <Stat label="Transcode sessions" value={modes.transcode.toLocaleString()} />
      <Stat label="Direct Play sessions" value={modes.direct.toLocaleString()} />
    </div>
    {recent.length > 1 && <Card title="Daily watch time" description={days.length > 30 ? 'Last 30 days with recorded activity · server time' : 'Server time'}>
      <div className="history-trend" aria-label="Daily watch time">{recent.map(day =>
        <div key={day.day} title={`${day.day} · ${watch(day.watchMs)}`} aria-label={`${day.day} · ${watch(day.watchMs)}`}
          style={{ '--watch-height': `${Math.max(2, day.watchMs / largest * 100)}%` } as React.CSSProperties} />)}</div>
    </Card>}
  </>;
}

type Change = (change: Record<string, string | undefined>) => void;
function MediaTypeButtons({ options, value, onChange }: {
  options: readonly (readonly [string, string])[]; value: string; onChange: (value: string) => void;
}) {
  return <div className="segmented-field">
    <span>Media type</span>
    <div className="toggle-group history-types" role="radiogroup" aria-label="Media type">
      {options.map(([id, label]) => <button key={id} type="button" role="radio" aria-checked={value === id} onClick={() => onChange(id)}>{label}</button>)}
    </div>
  </div>;
}

function MediaRanks({ params, filter, set }: { params: URLSearchParams; filter: URLSearchParams; set: Change }) {
  const kind = kinds.find(([id]) => id === params.get('kind'))?.[0] ?? 'all';
  const query = new URLSearchParams(filter);
  query.set('kind', kind);
  return <>
    <MediaTypeButtons options={kinds} value={kind} onChange={value => set({ kind: value === 'all' ? undefined : value })} />
    <RankTable<HistoryMediaRank> path={`${base}/media?${query}`} title={kind === 'all' ? 'Media' : kinds.find(([id]) => id === kind)?.[1] ?? 'Media'}
      description={kind === 'programs' ? 'Program matches use the IPTV guide and relay clock.' : undefined}
      subtitle={kind === 'all' ? row => mediaLabels[row.kind] : undefined}
      action={row => {
        const colon = row.id.lastIndexOf(':');
        return route(params, { tab: 'sessions', cursor: undefined, q: undefined, type: undefined,
          media: row.kind === 'show' || row.kind === 'program' ? undefined : row.id,
          server: row.kind === 'show' ? row.id.slice(0, colon) : undefined,
          show: row.kind === 'show' ? row.id.slice(colon + 1) : undefined,
          airing: row.kind === 'program' ? row.id : undefined });
      }} />
  </>;
}

function RankTable<T extends HistoryRank>({ path, title, description, action, subtitle }: {
  path: string; title: string; description?: string; action: (row: T) => string; subtitle?: (row: T) => string;
}) {
  const data = useApi<T[]>(path);
  return <Card title={title} description={description}>
    {data.error ? <ErrorNotice message={data.error.message} retry={data.reload} /> : !data.data ? <Loading /> :
      data.data.length === 0 ? <Empty title="No viewing recorded for this selection" /> :
      <div className="history-table"><table><thead><tr><th>Name</th><th>Watch time</th><th>Sessions</th><th>Viewers</th></tr></thead>
        <tbody>{data.data.map((row, index) => <tr key={`${row.id}:${index}`}>
          <td><a href={action(row)}>{row.title}</a>{subtitle && <small>{subtitle(row)}</small>}</td><td>{watch(row.watchMs)}</td><td>{row.sessions.toLocaleString()}</td><td>{row.viewers.toLocaleString()}</td>
        </tr>)}</tbody></table></div>}
  </Card>;
}

function Sessions({ params, filter, set }: { params: URLSearchParams; filter: URLSearchParams; set: Change }) {
  const search = params.get('q') ?? '';
  const [draft, setDraft] = useState(search);
  const query = new URLSearchParams(filter);
  for (const key of ['cursor', 'q', 'media', 'airing', 'show', 'server', 'sort']) {
    const value = params.get(key);
    if (value) query.set(key, value);
  }
  if (params.get('type')) query.set('kind', params.get('type')!);
  const data = useApi<SessionPage>(`${base}/sessions?${query}`);
  return <>
    <form className="history-controls" onSubmit={e => { e.preventDefault(); set({ q: draft.trim() || undefined }); }}>
      <label>Search sessions <input type="search" value={draft} onChange={e => setDraft(e.target.value)} maxLength={80} placeholder="Title, show or viewer" /></label>
      <button type="submit">Search</button>
      {search && <button type="button" onClick={() => { setDraft(''); set({ q: undefined }); }}>Clear search</button>}
      <MediaTypeButtons options={sessionKinds} value={params.get('type') ?? ''} onChange={value => set({ type: value || undefined })} />
      <label>Sort <select value={params.get('sort') ?? 'newest'} onChange={e => set({ sort: e.target.value })}>
        <option value="newest">Newest</option><option value="longest">Longest watch time</option>
      </select></label>
    </form>
    <Card title="Viewing sessions">
      {data.error ? <ErrorNotice message={data.error.message} retry={data.reload} /> : !data.data ? <Loading /> :
        data.data.items.length === 0 ? <Empty title="No sessions match these filters" /> :
        <div className="history-table history-session-table"><table>
          <thead><tr><th scope="col">Title or channel</th><th scope="col">Viewer</th><th scope="col">Playback</th><th scope="col">Started</th><th scope="col">Watch time</th></tr></thead>
          <tbody>{data.data.items.map(row => {
            const subtitle = sessionSubtitle(row), progress = playbackPosition(row);
            return <tr key={row.id}>
              <td><a className="history-session-title" href={route(params, { session: row.id })}>
                <Icon name={row.kind === 'episode' ? 'shows' : row.kind === 'channel' ? 'live' : 'film'} size={15} />
                <span>{sessionTitle(row)}{subtitle && <small>{subtitle}</small>}</span>
              </a></td>
              <td>{userName(row)}<small>{row.client}</small></td>
              <td>{sources[row.source]}<small>{deliveryLabel(row.stream.delivery)}</small></td>
              <td><time dateTime={new Date(row.startedAt).toISOString()}>{dateLabel.format(row.startedAt)}<small>{timeLabel.format(row.startedAt)}</small></time></td>
              <td className="history-session-watch">
                <span className="history-watch-value">{watch(row.watchMs)}
                  {progress && <span className="history-progress-ring" role="img"
                    aria-label={`Last playback position ${progress.label}`} title={`Last playback position ${progress.label}`}
                    style={{ '--playback-progress': progress.position / progress.durationMs } as CSSProperties} />}
                </span>
                {row.endedAt === null && <small className="history-session-open">In progress</small>}
              </td>
            </tr>;
          })}</tbody>
        </table></div>}
      <div className="history-controls">
        {params.has('cursor') && <a href={route(params, { cursor: undefined })}>Newest</a>}
        {data.data?.next && <a href={route(params, { cursor: data.data.next })}>Older sessions</a>}
      </div>
    </Card>
  </>;
}

function SessionDialog({ id, close }: { id: string; close: () => void }) {
  const data = useApi<HistorySessionDetail>(`${base}/sessions/${encodeURIComponent(id)}`);
  const detail = data.data, row = detail?.session;
  return <Modal title={row ? [sessionTitle(row), sessionSubtitle(row)].filter(Boolean).join(' · ') : 'Session details'} onClose={close}>
    {data.error ? <ErrorNotice message={data.error.message} retry={data.reload} /> : !detail ? <Loading /> : <SessionDetails detail={detail} />}
  </Modal>;
}

function SessionDetails({ detail }: { detail: HistorySessionDetail }) {
  const { session: row, observedAt, deliveryMs, allocations } = detail;
  const subtitle = sessionSubtitle(row), progress = playbackPosition(row), stream = row.stream;
  const status = row.endedAt === null ? 'In progress' : row.endReason ? resultLabel[row.endReason] ?? row.endReason : 'Ended';
  const modes = Object.entries(deliveryMs ?? {}).filter(([, ms]) => ms > 0);
  const media = row.kind === 'movie' || row.kind === 'episode';
  return <div className="history-session-detail">
    <header className="history-session-heading">
      {media && <img className="history-poster" loading="lazy" alt="" src={`/api/v1/catalog/items/${encodeURIComponent(row.ratingKey)}/artwork?kind=poster`}
        onError={e => { e.currentTarget.hidden = true; }} />}
      <div><h2>{sessionTitle(row)}</h2>{subtitle && <p className="muted">{subtitle}</p>}</div>
    </header>
    <div className="history-table"><table className="history-detail-table" aria-label="Session details"><tbody>
      <tr><th scope="row">Viewer</th><td>{userName(row)}<small>{row.client}</small></td></tr>
      <tr><th scope="row">Status</th><td>{status}</td></tr>
      <tr><th scope="row">Started</th><td>{formatDate(row.startedAt)}</td></tr>
      {row.endedAt !== null ? <tr><th scope="row">Ended</th><td>{formatDate(row.endedAt)}</td></tr> :
        observedAt != null && <tr><th scope="row">Last observed</th><td>{formatDate(observedAt)}</td></tr>}
      <tr><th scope="row">Watch time</th><td>{watch(row.watchMs)}{row.source === 'plex' && <small>Estimated from Plex progress</small>}</td></tr>
      {progress && <tr><th scope="row">Last position</th><td>
        {progress.label}
        <progress className="history-position" aria-label="Last reported position in the title" value={progress.position} max={progress.durationMs} />
      </td></tr>}
      <tr><th scope="row">Playback</th><td>{sources[row.source]} · {deliveryLabel(stream.delivery)}
        {modes.length > 1 && <small>{modes.map(([mode, ms]) => `${deliveryLabel(mode)} ${watch(ms)}`).join(' · ')}</small>}
      </td></tr>
      {(stream.video || stream.audio) && <tr><th scope="row">Stream</th><td>
        {[stream.video && `Video ${decisionLabel(stream.video)}`, stream.audio && `Audio ${decisionLabel(stream.audio)}`].filter(Boolean).join(' · ')}
      </td></tr>}
      {(stream.sourceHeight || stream.outputHeight || stream.maxHeight) && <tr><th scope="row">Resolution</th><td>
        {[stream.sourceHeight && `Source ${stream.sourceHeight}p`, stream.outputHeight ? `Output ${stream.outputHeight}p` :
          stream.maxHeight && `Output limit ${stream.maxHeight}p`].filter(Boolean).join(' · ')}
      </td></tr>}
    </tbody></table></div>
    {allocations.some(item => item.title) && <section aria-label="Programs viewed">
      <h3>Programs viewed</h3>
      <div className="history-table"><table>
        <thead><tr><th scope="col">Program</th><th scope="col">Server date</th><th scope="col">Watch time</th></tr></thead>
        <tbody>{allocations.map((item, index) => <tr key={index}>
          <td>{item.title ?? 'Unattributed channel time'}{item.estimated ? <small>Estimated</small> : null}</td><td>{item.day}</td><td>{watch(item.watchMs)}</td>
        </tr>)}</tbody>
      </table></div>
    </section>}
  </div>;
}
