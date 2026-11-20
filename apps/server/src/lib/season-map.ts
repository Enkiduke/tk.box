// A show match (Admin › Requests or a show's dialog › Match): the TVDB series a show is filed under, for a show TMDB
// gives no TVDB id or the wrong one. When TVDB counts the show as seasons of another series (Netflix's Monster
// anthology: TMDB's "Monster: The Lizzie Borden Story" season 1 is TVDB's Monster season 4), `seasons` maps each of
// the show's TMDB seasons to the series' season. Everything in tk.box keeps TMDB's numbers; only the file names, the
// indexer searches by TVDB id and what Plex reports use the series'. Episode numbers are the same in both.
export type SeasonMap = Readonly<Record<string, number>>;
export type ShowMatch = { tmdbId: number; tvdbId: number; series: { title: string; year?: number }; seasons?: SeasonMap; at: number; by: string };

// A map that changes nothing is no map: the show is the series.
export function cleanSeasonMap(seasons: Readonly<Record<string, number>> | undefined): SeasonMap | undefined {
  const entries = Object.entries(seasons ?? {}).filter(([s, t]) => Number.isInteger(Number(s)) && Number(s) > 0 && Number.isInteger(t) && t > 0);
  return entries.some(([s, t]) => Number(s) !== t) ? Object.fromEntries(entries.sort((a, b) => Number(a[0]) - Number(b[0]))) : undefined;
}

// The series' season for a TMDB season; one the map doesn't name keeps its number.
export const tvdbSeasonOf = (seasons: SeasonMap | undefined, season: number) => seasons?.[String(season)] ?? season;

// The TMDB season a series season is, or undefined when the show has no season there (another show's).
export function tmdbSeasonOf(seasons: SeasonMap | undefined, season: number): number | undefined {
  if (!seasons) return season;
  const hit = Object.entries(seasons).find(([, t]) => t === season);
  return hit ? Number(hit[0]) : undefined;
}

// `season:episode` keys from the series' numbers into the show's, leaving out the series' other seasons.
export function toShowKeys(seasons: SeasonMap, keys: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const key of keys) {
    const [t, e] = key.split(':').map(Number);
    const s = tmdbSeasonOf(seasons, t!);
    if (s !== undefined) out.add(`${s}:${e}`);
  }
  return out;
}

// Which TVDB season each TMDB season most likely is: the one whose first episode aired within 3 days of the TMDB
// season's, else the one with the same number when it exists. A TMDB season with neither is left out.
export function suggestSeasons(tmdb: readonly { season: number; firstAired?: string }[], tvdb: readonly { season: number; firstAired?: string }[]): Record<string, number> {
  const day = (d: string) => Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
  const out: Record<string, number> = {};
  for (const s of tmdb) {
    let best: { season: number; gap: number } | undefined;
    if (s.firstAired) for (const t of tvdb) {
      if (!t.firstAired) continue;
      const gap = Math.abs(day(s.firstAired) - day(t.firstAired));
      if (Number.isFinite(gap) && gap <= 3 * 86400000 && (!best || gap < best.gap)) best = { season: t.season, gap };
    }
    const season = best?.season ?? (tvdb.some(t => t.season === s.season) ? s.season : undefined);
    if (season !== undefined) out[String(s.season)] = season;
  }
  return out;
}
