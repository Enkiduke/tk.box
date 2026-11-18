import type {CalendarEntry} from '../../../packages/contracts/src/index.js';

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
