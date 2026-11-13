import {lazy, Suspense, useState} from 'react';
import type {CalendarEntry, CalendarPage, ExploreItem} from '../../../packages/contracts/src/index.js';
import {Artwork, Empty, ErrorNotice, Icon, Loading} from './components.js';
import {link, useApi} from './hooks.js';
import './calendar.css';

const ExploreDialog = lazy(() => import('./explore.js').then(module => ({default: module.ExploreDialog})));
const dayFormat = new Intl.DateTimeFormat(undefined, {dateStyle: 'full', timeZone: 'UTC'});
const shortFormat = new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'});
const monthFormat = new Intl.DateTimeFormat(undefined, {month: 'long', year: 'numeric', timeZone: 'UTC'});
const weekdayFormat = new Intl.DateTimeFormat(undefined, {weekday: 'short', timeZone: 'UTC'});
const timeFormat = new Intl.DateTimeFormat(undefined, {timeStyle: 'short'});
const localDayFormat = new Intl.DateTimeFormat('sv-SE', {year: 'numeric', month: '2-digit', day: '2-digit'});
const dayAt = (day: string) => new Date(`${day}T00:00:00Z`);
const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const addDays = (day: string, days: number) => {
  const date = dayAt(day);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDay(date);
};
const validDay = (value: string | null) => value && /^(?:19|20|21)\d{2}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(+dayAt(value)) && isoDay(dayAt(value)) === value ? value : undefined;
const releaseLabels = {theatrical: 'In theaters', digital: 'Digital release', physical: 'Disc release'};

function MonthPicker({from, to, current, onPick}: {from: string; to: string; current: string; onPick: (day: string) => void}) {
  const [month, setMonth] = useState(`${from.slice(0, 7)}-01`);
  const first = dayAt(month);
  const start = addDays(month, -((first.getUTCDay() + 6) % 7));
  const range = shortFormat.formatRange(dayAt(from), dayAt(addDays(to, -1)));
  const step = (direction: number) => {
    const next = dayAt(month);
    next.setUTCMonth(next.getUTCMonth() + direction);
    setMonth(isoDay(next));
  };
  return <details className="calendar-picker">
    <summary aria-label={`Pick a date. Showing ${range}`}><Icon name="calendar" size={16}/> {range}</summary>
    <div className="calendar-month">
      <div className="calendar-month-heading">
        <button type="button" aria-label="Previous month" disabled={month <= '1900-01-01'} onClick={() => step(-1)}><Icon name="back" size={15}/></button>
        <strong aria-live="polite">{monthFormat.format(first)}</strong>
        <button type="button" aria-label="Next month" disabled={month >= '2199-12-01'} onClick={() => step(1)}><Icon name="next" size={15}/></button>
      </div>
      <div className="calendar-month-days">
        {Array.from({length: 7}, (_, i) => <span key={i}>{weekdayFormat.format(dayAt(addDays(start, i)))}</span>)}
        {Array.from({length: 42}, (_, i) => {
          const day = addDays(start, i);
          return <button type="button" key={day} className={day.slice(0, 7) === month.slice(0, 7) ? undefined : 'outside'}
            disabled={!validDay(day)} aria-label={dayFormat.format(dayAt(day))} aria-current={day === current ? 'date' : undefined}
            aria-pressed={day === from} data-in-range={day >= from && day < to || undefined}
            onClick={event => {event.currentTarget.closest('details')?.removeAttribute('open'); onPick(day);}}>{Number(day.slice(-2))}</button>;
        })}
      </div>
    </div>
  </details>;
}

function Entry({entry, current, onOpen}: {entry: CalendarEntry; current: string; onOpen: () => void}) {
  const episode = entry.kind === 'episode';
  const release = entry.kind === 'episode' ? `S${String(entry.season).padStart(2, '0')}E${String(entry.episode).padStart(2, '0')}` : releaseLabels[entry.kind];
  const upcoming = entry.airTime ? Date.parse(entry.airTime) > Date.now() : entry.day >= current;
  const status = entry.plexItemId ? 'In Library' : entry.availabilityUnknown ? 'Availability unknown' : upcoming ? 'Upcoming' : 'Not in Library';
  return <li>
    <button type="button" className="calendar-entry" onClick={onOpen}>
      <span className="calendar-poster"><Artwork key={entry.posterUrl} src={entry.posterUrl} fallback={<Icon name={episode ? 'shows' : 'movies'} size={25}/>}/></span>
      <span className="calendar-entry-text">
        <strong>{entry.title}</strong>
        <span className="calendar-entry-meta">{[entry.airTime && timeFormat.format(new Date(entry.airTime)), release, entry.episodeTitle].filter(Boolean).join(' · ')}</span>
        <span className={`calendar-status${entry.plexItemId ? ' available' : status === 'Upcoming' ? ' upcoming' : ''}`}>{status}</span>
      </span>
    </button>
  </li>;
}

export function Calendar({accountId, params, onOpen}: {accountId: string; params: URLSearchParams; onOpen: (id: string) => void}) {
  const current = localDayFormat.format(new Date()), from = validDay(params.get('from')) ?? current, to = addDays(from, 7);
  const previousWeek = validDay(addDays(from, -7)), nextWeek = validDay(to);
  const view = params.get('view') === 'list' ? 'list' : 'cards';
  const filter = params.get('titles');
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const data = useApi<CalendarPage>(`/calendar?${new URLSearchParams({from, to, zone, account: accountId})}`);
  const [selected, setSelected] = useState<ExploreItem>();
  const route = (changes: Record<string, string | undefined>) => link('calendar', {
    from: params.get('from') ?? undefined, titles: filter ?? undefined, view: view === 'list' ? view : undefined, ...changes,
  });
  const days = new Map<string, CalendarEntry[]>();
  for (const entry of data.data?.dates ?? []) {
    if ((filter === 'movies' && entry.kind === 'episode') || (filter === 'shows' && entry.kind !== 'episode')) continue;
    const entries = days.get(entry.day) ?? [];
    entries.push(entry);
    days.set(entry.day, entries);
  }
  const sources = Object.entries(data.data?.sources ?? {}).filter(([source]) => filter !== (source === 'Radarr' ? 'shows' : 'movies'));
  const failed = sources.filter(([, status]) => status === 'unavailable').map(([source]) => source);
  const disconnected = sources.filter(([, status]) => status === 'disconnected').map(([source]) => source);
  const open = (entry: CalendarEntry) => {
    if (entry.plexItemId) {onOpen(entry.plexItemId); return;}
    setSelected({key: entry.key, title: entry.title, year: entry.year, summary: entry.summary, posterUrl: entry.posterUrl,
      kind: entry.kind === 'episode' ? 'show' : 'movie', source: 'plex', ids: entry.ids});
  };
  return <div className="page calendar-page">
    <section className="calendar-controls" aria-label="Calendar controls">
      <nav aria-label="Calendar dates" className="calendar-dates">
        <div className="calendar-segment calendar-range">
          <a href={previousWeek ? route({from: previousWeek}) : undefined} aria-disabled={!previousWeek || undefined} aria-label="Previous week"><Icon name="back" size={16}/></a>
          <MonthPicker key={from} from={from} to={to} current={current} onPick={day => {window.location.hash = route({from: day});}}/>
          <a href={nextWeek ? route({from: nextWeek}) : undefined} aria-disabled={!nextWeek || undefined} aria-label="Next week"><Icon name="next" size={16}/></a>
        </div>
        <a className="calendar-today" href={route({from: undefined})}>Today</a>
      </nav>
      <div className="calendar-options">
        <nav aria-label="Calendar media type" className="calendar-segment">
          <a href={route({titles: undefined})} aria-current={filter !== 'movies' && filter !== 'shows' || undefined}>All</a>
          <a href={route({titles: 'movies'})} aria-current={filter === 'movies' || undefined}>Movies</a>
          <a href={route({titles: 'shows'})} aria-current={filter === 'shows' || undefined}>TV Shows</a>
        </nav>
        <nav aria-label="Calendar layout" className="calendar-segment calendar-layout">
          <a href={route({view: undefined})} aria-current={view === 'cards' || undefined}><Icon name="grid" size={15}/> Cards</a>
          <a href={route({view: 'list'})} aria-current={view === 'list' || undefined}><Icon name="list" size={15}/> List</a>
        </nav>
      </div>
    </section>
    {data.error && <ErrorNotice message={data.error.message} retry={data.reload}/>}
    {failed.length > 0 && <ErrorNotice message={`Could not load the calendar from ${failed.join(' and ')}.`} retry={data.reload}/>}
    {disconnected.length > 0 && <p className="muted">{disconnected.join(' and ')} {disconnected.length === 1 ? 'is' : 'are'} disconnected. An admin can connect {disconnected.length === 1 ? 'it' : 'them'} in Admin › Connections.</p>}
    {data.data?.plexUnavailable && <ErrorNotice message="Some Plex availability could not be checked." retry={data.reload}/>}
    {!data.data && data.loading ? <Loading/> : data.data && !days.size && sources.some(([, status]) => status === 'ready') ? <Empty title="No releases scheduled for these dates"/> : null}
    <div className={`calendar-days ${view}`}>
      {[...days].map(([day, entries]) => <section className="calendar-day" key={day} aria-label={dayFormat.format(dayAt(day))}>
        <h2>{day === current && <span>Today</span>}<time dateTime={day}>{dayFormat.format(dayAt(day))}</time></h2>
        <ul>{entries.map(entry => <Entry key={entry.key} entry={entry} current={current} onOpen={() => open(entry)}/>)}</ul>
      </section>)}
    </div>
    {selected && <Suspense fallback={<Loading/>}><ExploreDialog item={selected} onClose={() => setSelected(undefined)} onOpen={id => {setSelected(undefined); onOpen(id);}}/></Suspense>}
  </div>;
}
