import type {CalendarEntry, CalendarEpisodeLabel} from '../../../packages/contracts/src/index.js';

const episodeLabels: Record<CalendarEpisodeLabel, string> = {
  'series-premiere': 'Series premiere', 'season-premiere': 'Season premiere',
  'season-finale': 'Season finale', 'series-finale': 'Series finale',
};

export function episodeReleaseLabel(entries: CalendarEntry[]): string {
  if (entries.length === 1) {
    const milestone = entries[0]!.episodeLabel;
    return milestone ? episodeLabels[milestone] : 'New episode';
  }
  const finale = entries.find(entry => entry.episodeLabel === 'season-finale' || entry.episodeLabel === 'series-finale');
  if (!finale?.season || !finale.episode || entries.some(entry => entry.season !== finale.season)) return 'New episodes';
  const episodes = new Set(entries.map(entry => entry.episode));
  if (episodes.size !== finale.episode) return 'New episodes';
  for (let number = 1; number <= finale.episode; number++) {
    if (!episodes.has(number)) return 'New episodes';
  }
  return 'Full season';
}

// Group by the movie or series (titleKey) and local day.
export function groupCalendarEntries(entries: CalendarEntry[]): CalendarEntry[][] {
  const groups = new Map<string, CalendarEntry[]>();
  for (const entry of entries) {
    const key = `${entry.day}:${entry.titleKey}`;
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  return [...groups.values()];
}

export function episodeRanges(entries: CalendarEntry[]): string {
  const seasons = new Map<number, Set<number>>();
  for (const {season, episode} of entries) {
    if (season === undefined || episode === undefined) continue;
    const numbers = seasons.get(season) ?? new Set<number>();
    numbers.add(episode);
    seasons.set(season, numbers);
  }
  return [...seasons].sort(([a], [b]) => a - b).map(([season, numbers]) => {
    const ranges: {first: number; last: number}[] = [];
    for (const number of [...numbers].sort((a, b) => a - b)) {
      const range = ranges.at(-1);
      if (range && number === range.last + 1) range.last = number;
      else ranges.push({first: number, last: number});
    }
    const caption = ranges.map(({first, last}) => first === last ? String(first) : `${first}–${last}`).join(', ');
    return `${season === 0 ? 'Specials' : `Season ${season}`}, ${numbers.size === 1 ? 'Episode' : 'Episodes'} ${caption}`;
  }).join(' · ');
}

// A card shows a backdrop at about 285×160, so it asks for a smaller copy than the 1280-wide one the details dialog
// uses: TMDB's w780 through the image proxy, or the 800×450 tile Plex transcodes from the same picture.
export function cardBackdrop(url: string): string {
  const parsed = new URL(url, 'https://tk.box');
  if (parsed.pathname === '/api/v1/explore/image') {
    const source = parsed.searchParams.get('u');
    if (!source?.startsWith('https://image.tmdb.org/t/p/w1280/')) return url;
    parsed.searchParams.set('u', source.replace('/t/p/w1280/', '/t/p/w780/'));
  } else if (/^\/api\/v1\/catalog\/items\/[^/]+\/artwork$/.test(parsed.pathname) && parsed.searchParams.get('kind') === 'backdrop') {
    parsed.searchParams.set('kind', 'tile');
  } else return url;
  return parsed.pathname + parsed.search;
}
