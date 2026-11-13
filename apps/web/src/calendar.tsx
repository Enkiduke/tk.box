import {lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import type {CalendarEntry, CalendarEpisodeLabel, CalendarPage, ExploreItem} from '../../../packages/contracts/src/index.js';
import {ErrorNotice, Icon, Loading} from './components.js';
import {link, useApi} from './hooks.js';
import {episodeRanges, groupCalendarEntries} from './calendar-episodes.js';
import './calendar.css';

const ExploreDialog = lazy(() => import('./explore.js').then(module => ({default: module.ExploreDialog})));
const dayFormat = new Intl.DateTimeFormat(undefined, {dateStyle: 'full', timeZone: 'UTC'});
const shortFormat = new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'});
const monthFormat = new Intl.DateTimeFormat(undefined, {month: 'long', year: 'numeric', timeZone: 'UTC'});
const weekdayFormat = new Intl.DateTimeFormat(undefined, {weekday: 'short', timeZone: 'UTC'});
const monthName = new Intl.DateTimeFormat(undefined, {month: 'short', timeZone: 'UTC'});
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
const episodeLabels: Record<CalendarEpisodeLabel, string> = {
  'series-premiere': 'Series premiere', 'season-premiere': 'Season premiere',
  'season-finale': 'Season finale', 'series-finale': 'Series finale',
};
const weekOf = (day: string) => addDays(day, -((dayAt(day).getUTCDay() + 6) % 7));
const batchDays = 28;
const matchesFilter = (entry: CalendarEntry, filter: string | null) =>
  filter === 'movies' ? entry.kind !== 'episode' : filter === 'shows' ? entry.kind === 'episode' : true;

function MonthPicker({from, active, current, onPick}: {from: string; active: string; current: string; onPick: (day: string) => void}) {
  const [browsing, setBrowsing] = useState<string>();
  const month = browsing ?? `${active.slice(0, 7)}-01`, to = addDays(from, 7);
  const first = dayAt(month);
  const start = addDays(month, -((first.getUTCDay() + 6) % 7));
  const range = shortFormat.formatRange(dayAt(from), dayAt(addDays(to, -1)));
  const step = (direction: number) => {
    const next = dayAt(month);
    next.setUTCMonth(next.getUTCMonth() + direction);
    setBrowsing(isoDay(next));
  };
  return <details className="calendar-picker" onToggle={event => {if (!event.currentTarget.open) setBrowsing(undefined);}}>
    <summary aria-label={`Pick a date. Showing ${range}`} title={range}><Icon name="calendar" size={16}/><span>{range}</span></summary>
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
            aria-pressed={day === active} data-in-range={day >= from && day < to || undefined}
            onClick={event => {event.currentTarget.closest('details')?.removeAttribute('open'); onPick(day);}}>{Number(day.slice(-2))}</button>;
        })}
      </div>
    </div>
  </details>;
}

function CardArtwork({entries, list, layer}: {entries: CalendarEntry[]; list: boolean; layer?: CalendarEntry}) {
  const posters = entries.map(entry => entry.posterUrl), backdrops = entries.map(entry => entry.backdropUrl);
  const stills = entries.map(entry => entry.stillUrl);
  const ordered = list ? [...posters, ...backdrops, ...stills]
    : entries.length > 1 ? [layer?.stillUrl, layer?.backdropUrl, ...backdrops, ...stills, ...posters] : [...stills, ...backdrops, ...posters];
  const choices = [...new Set(ordered.filter((url): url is string => !!url))];
  const [failed, setFailed] = useState<string[]>([]);
  const src = choices.find(url => !failed.includes(url));
  return src ? <img key={src} className={posters.includes(src) ? 'calendar-portrait' : undefined} src={src} alt="" loading="lazy" decoding="async"
    onError={() => setFailed(previous => [...previous, src])}/>
    : layer ? null : <span className="calendar-art-placeholder"><Icon name={entries[0]!.kind === 'episode' ? 'shows' : 'movies'} size={28}/></span>;
}

function Entry({entries, list, onOpen}: {entries: CalendarEntry[]; list: boolean; onOpen: (entry: CalendarEntry, plexId?: string) => void}) {
  const entry = entries[0]!, stacked = entries.length > 1;
  const episode = entry.kind === 'episode';
  const release = entry.kind === 'episode' ? `S${String(entry.season).padStart(2, '0')}E${String(entry.episode).padStart(2, '0')}` : releaseLabels[entry.kind];
  const playable = entries.filter(item => item.plexItemId);
  const available = playable.length === entries.length, unknown = entries.some(item => item.availabilityUnknown);
  const availabilityLabel = available ? 'In Library' : playable.length ? `${playable.length} of ${entries.length} episodes in Library` : 'Not in Library';
  const milestones = [...new Set(entries.flatMap(item => item.episodeLabel ? [episodeLabels[item.episodeLabel]] : []))];
  const label = episode ? milestones[0] ?? 'New episode' : release;
  const times = [...new Set(entries.map(item => item.airTime ? timeFormat.format(new Date(item.airTime)) : 'All day'))].join(' · ');
  const caption = stacked ? episodeRanges(entries) : [release, entry.episodeTitle].filter(Boolean).join(' · ');
  return <li>
    <button type="button" className="calendar-entry" data-stack={stacked || undefined}
      onClick={() => onOpen(entry, stacked ? playable.find(item => item.plexShowId)?.plexShowId ?? playable[0]?.plexItemId : entry.plexItemId)}>
      {!list && entries.slice(1, 3).reverse().map((item, index) => <span className="calendar-stack-layer" key={item.key}
        data-rear={entries.length > 2 && index === 0 || undefined} aria-hidden="true">
        <CardArtwork entries={entries} list={false} layer={item}/>
      </span>)}
      <span className="calendar-art" data-available={available || undefined}>
        <CardArtwork entries={entries} list={list}/>
        <span className="calendar-card-label" title={milestones.length > 1 ? milestones.join(' · ') : undefined}>{label}
          {milestones.length > 1 && <span className="sr-only">, {milestones.slice(1).join(', ')}</span>}
        </span>
        {(playable.length > 0 || !unknown) && <span className="calendar-availability" title={availabilityLabel}>
          <Icon name={available ? 'check' : playable.length ? 'info' : 'close'} size={16}/><span className="sr-only">{availabilityLabel}</span>
        </span>}
        <strong>{entry.title}</strong>
        {stacked && <span className="calendar-episode-count" title={`${entries.length} episodes`}>
          {entries.length}<span className="sr-only"> episodes</span>
        </span>}
      </span>
      <span className="calendar-caption">
        <span className="calendar-airtime">{times}</span>
        {episode && <span className="calendar-episode" title={stacked ? caption : undefined}>{caption}</span>}
        {unknown && <span>Availability unknown</span>}
      </span>
    </button>
  </li>;
}

type CalendarProps = {accountId: string; params: URLSearchParams; onOpen: (id: string) => void};

export function Calendar(props: CalendarProps) {
  const current = localDayFormat.format(new Date());
  const start = validDay(props.params.get('from')) ?? current;
  return <Agenda key={start} {...props} start={start} current={current}/>;
}

function Agenda({accountId, params, onOpen, start, current}: CalendarProps & {start: string; current: string}) {
  const firstWeek = weekOf(start);
  const [active, setActive] = useState(start);
  const [batches, setBatches] = useState<{from: string; page: CalendarPage}[]>([]);
  const [earlier, setEarlier] = useState<string>();
  const [later, setLater] = useState<string>();
  const [pickedDay, setPickedDay] = useState(start);
  const [selected, setSelected] = useState<ExploreItem>();
  const agenda = useRef<HTMLDivElement>(null), controls = useRef<HTMLElement>(null), endMarker = useRef<HTMLDivElement>(null);
  const restore = useRef<{element: HTMLElement; top: number}>(null);
  const from = weekOf(active), previousWeek = validDay(addDays(from, -7)), nextWeek = validDay(addDays(from, 7));
  const view = params.get('view') === 'list' ? 'list' : 'cards';
  const filter = params.get('titles');
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const path = (from: string | undefined) => from && `/calendar?${new URLSearchParams({from, to: addDays(from, batchDays), zone, account: accountId})}`;
  const initial = useApi<CalendarPage>(path(firstWeek));
  const before = useApi<CalendarPage>(path(earlier));
  const after = useApi<CalendarPage>(path(later));
  const pages = useMemo(() => [...batches, ...(initial.data ? [{from: firstWeek, page: initial.data}] : [])]
    .sort((a, b) => a.from.localeCompare(b.from)), [batches, firstWeek, initial.data]);
  const previousBatch = addDays(pages[0]?.from ?? firstWeek, -batchDays);
  const nextBatch = addDays(pages.at(-1)?.from ?? firstWeek, batchDays);
  const canReadEarlier = validDay(previousBatch) && previousBatch >= addDays(firstWeek, -364);
  const canReadLater = validDay(nextBatch) && nextBatch < addDays(firstWeek, 364);
  const hasSource = (page: CalendarPage) => Object.entries(page.sources).some(([source, state]) =>
    state === 'ready' && filter !== (source === 'Radarr' ? 'shows' : 'movies'));
  const ready = !!initial.data && hasSource(initial.data);
  const earlierUnavailable = !!before.data && !hasSource(before.data);
  const laterUnavailable = !!after.data && !hasSource(after.data);
  const dayGroups = useMemo(() => {
    const groups = new Map<string, CalendarEntry[]>();
    for (const {page} of pages) for (const entry of page.dates) {
      if (!matchesFilter(entry, filter)) continue;
      const entries = groups.get(entry.day) ?? [];
      entries.push(entry);
      groups.set(entry.day, entries);
    }
    return new Map([...groups].map(([day, entries]) => [day, groupCalendarEntries(entries)]));
  }, [pages, filter]);
  const viewportTop = () => (controls.current?.getBoundingClientRect().bottom ?? 0) + 10;

  useLayoutEffect(() => {
    if (!earlier || !before.data || earlierUnavailable) return;
    const element = agenda.current?.querySelector<HTMLElement>('[data-week]');
    if (element) restore.current = {element, top: element.getBoundingClientRect().top};
    const page = before.data;
    setBatches(previous => [...previous, {from: earlier, page}]);
    setEarlier(undefined);
  }, [earlier, before.data, earlierUnavailable]);
  useLayoutEffect(() => {
    const held = restore.current;
    if (!held || earlier) return;
    restore.current = null;
    window.scrollBy({top: held.element.getBoundingClientRect().top - held.top, behavior: 'instant'});
  }, [batches, earlier]);
  useEffect(() => {
    if (!later || !after.data || laterUnavailable) return;
    const page = after.data;
    setBatches(previous => [...previous, {from: later, page}]);
    setLater(undefined);
  }, [later, after.data, laterUnavailable]);

  function scrollToDay(day: string, exact = false) {
    const week = agenda.current?.querySelector<HTMLElement>(`[data-week="${weekOf(day)}"]`);
    if (!week) return false;
    const days = Array.from(week.querySelectorAll<HTMLElement>('[data-day]'));
    const target = days.find(element => exact ? element.dataset.day === day : element.dataset.day! >= day) ?? week;
    window.scrollBy({top: target.getBoundingClientRect().top - viewportTop(), behavior: 'instant'});
    setActive(target.dataset.day ?? day);
    return true;
  }

  useLayoutEffect(() => {
    if (ready) scrollToDay(pickedDay, true);
  }, [ready, pickedDay]);

  // Read only the nearest date markers during scrolling. Prepending keeps the previous content in place.
  useEffect(() => {
    const node = agenda.current;
    if (!node || !ready) return;
    const markers = Array.from(node.querySelectorAll<HTMLElement>('[data-week], [data-day]'));
    let previousY = window.scrollY, frame = 0;
    const update = () => {
      frame = 0;
      const top = viewportTop(), y = window.scrollY;
      let low = 0, high = markers.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (markers[middle]!.getBoundingClientRect().top <= top + 2) low = middle + 1;
        else high = middle;
      }
      const marker = markers[Math.max(0, low - 1)];
      if (marker) setActive(marker.dataset.day ?? marker.dataset.week!);
      if (y < previousY && canReadEarlier && !earlier && node.getBoundingClientRect().top > top - 360) setEarlier(previousBatch);
      previousY = y;
    };
    const schedule = () => {if (!frame) frame = requestAnimationFrame(update);};
    window.addEventListener('scroll', schedule, {passive: true});
    window.addEventListener('resize', schedule);
    return () => {window.removeEventListener('scroll', schedule);window.removeEventListener('resize', schedule);cancelAnimationFrame(frame);};
  }, [ready, batches, initial.data, view, filter, canReadEarlier, earlier, previousBatch]);

  useEffect(() => {
    const marker = endMarker.current, last = pages.at(-1)?.page;
    if (!marker || !ready || !canReadLater || later || !last || !hasSource(last) || !('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {observer.disconnect();setLater(nextBatch);}
    }, {rootMargin: '0px 0px 500px'});
    observer.observe(marker);
    return () => observer.disconnect();
  }, [ready, canReadLater, later, nextBatch, pages, filter]);

  const route = (changes: Record<string, string | undefined>) => link('calendar', {
    from: params.get('from') ?? undefined, titles: filter ?? undefined, view: view === 'list' ? view : undefined, ...changes,
  });
  const jump = (day: string, exact = false) => {
    if (exact && day !== pickedDay && agenda.current?.querySelector(`[data-week="${weekOf(day)}"]`)) {
      setPickedDay(day);
    } else if (!scrollToDay(day, exact)) {
      window.location.hash = route({from: day === current ? undefined : day});
    }
  };
  const sources = Object.entries(initial.data?.sources ?? {}).filter(([source]) => filter !== (source === 'Radarr' ? 'shows' : 'movies'));
  const failed = sources.filter(([, status]) => status === 'unavailable').map(([source]) => source);
  const disconnected = sources.filter(([, status]) => status === 'disconnected').map(([source]) => source);
  const open = (entry: CalendarEntry, plexId?: string) => {
    if (plexId) {onOpen(plexId); return;}
    setSelected({key: entry.key, title: entry.title, year: entry.year, summary: entry.summary, posterUrl: entry.posterUrl, backdropUrl: entry.backdropUrl,
      kind: entry.kind === 'episode' ? 'show' : 'movie', source: 'plex', ids: entry.ids});
  };
  return <div className="page calendar-page">
    <section ref={controls} className="calendar-controls" aria-label="Calendar controls">
      <nav aria-label="Calendar dates" className="calendar-dates">
        <div className="calendar-segment calendar-range">
          <button type="button" disabled={!previousWeek} aria-label="Previous week" onClick={() => previousWeek && jump(previousWeek)}><Icon name="back" size={16}/></button>
          <MonthPicker from={from} active={active} current={current} onPick={day => jump(day, true)}/>
          <button type="button" disabled={!nextWeek} aria-label="Next week" onClick={() => nextWeek && jump(nextWeek)}><Icon name="next" size={16}/></button>
        </div>
        {active !== current && <button type="button" className="calendar-today" aria-label="Back to today" title="Back to today"
          onClick={() => jump(current, true)}><Icon name="restart" size={16}/></button>}
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
    {initial.error && <ErrorNotice message={initial.error.message} retry={initial.reload}/>}
    {failed.length > 0 && <ErrorNotice message={`Could not load the calendar from ${failed.join(' and ')}.`} retry={initial.reload}/>}
    {disconnected.length > 0 && <p className="muted">{disconnected.join(' and ')} {disconnected.length === 1 ? 'is' : 'are'} disconnected. An admin can connect {disconnected.length === 1 ? 'it' : 'them'} in Admin › Connections.</p>}
    {initial.data?.plexUnavailable && <ErrorNotice message="Some Plex availability could not be checked." retry={initial.reload}/>}
    {!initial.data && initial.loading && <Loading/>}
    {ready && <>
      <div className="calendar-more">
        {before.loading ? <Loading/> : before.error || earlierUnavailable ? <ErrorNotice message={before.error?.message ?? 'Could not load earlier releases.'} retry={before.reload}/>
          : canReadEarlier && <button type="button" onClick={() => setEarlier(previousBatch)}>Earlier dates</button>}
      </div>
      <div ref={agenda} className={`calendar-days ${view}`}>
        {pages.flatMap(({from: batch, page}) => Array.from({length: batchDays / 7}, (_, index) => {
          const week = addDays(batch, index * 7), end = addDays(week, 7);
          const days = Array.from({length: 7}, (_, i) => addDays(week, i)).filter(day => dayGroups.has(day) || day === pickedDay);
          return <div className="calendar-week" key={week} data-week={week}>
            {!days.length && <p className="calendar-empty-week"><strong>{shortFormat.formatRange(dayAt(week), dayAt(addDays(end, -1)))}</strong>
              <span>{hasSource(page) ? 'No releases scheduled' : 'Release schedule unavailable'}</span></p>}
            {days.map(day => <section className="calendar-day" key={day} data-day={day} aria-label={dayFormat.format(dayAt(day))}>
              <h2><time dateTime={day} aria-current={day === current ? 'date' : undefined}><span className="sr-only">{dayFormat.format(dayAt(day))}</span>
                <span aria-hidden="true" className="calendar-date-stamp"><span>{weekdayFormat.format(dayAt(day))}</span><strong>{Number(day.slice(-2))}</strong><span>{monthName.format(dayAt(day))}</span></span>
                {day === current && <span className="calendar-date-today">Today</span>}</time></h2>
              {dayGroups.has(day) ? <ul>{dayGroups.get(day)!.map(entries => <Entry key={entries[0]!.key} entries={entries} list={view === 'list'} onOpen={open}/>)}</ul>
                : <p className="calendar-empty-day">{hasSource(page) ? 'No releases scheduled' : 'Release schedule unavailable'}</p>}
            </section>)}
          </div>;
        }))}
      </div>
      <div className="calendar-more" ref={endMarker}>
        {after.loading ? <Loading/> : after.error || laterUnavailable ? <ErrorNotice message={after.error?.message ?? 'Could not load later releases.'} retry={after.reload}/>
          : canReadLater && <button type="button" onClick={() => setLater(nextBatch)}>Later dates</button>}
      </div>
    </>}
    {selected && <Suspense fallback={<Loading/>}><ExploreDialog item={selected} onClose={() => setSelected(undefined)} onOpen={id => {setSelected(undefined); onOpen(id);}}/></Suspense>}
  </div>;
}
