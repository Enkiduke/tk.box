import { RestrictedSourceFetcher } from './source-fetch.js';
import { norm, zonedDate, type SportsEvent } from '../services/sports-match.js';

// Event schedules from ESPN's public site API (unofficial and undocumented; every game of a day per
// league with live status) and TheSportsDB's free v1 key (fight cards and shows ESPN lacks).
// Only names, times and status are kept. Nothing from either service reaches viewers beyond titles.
const HOUR = 3600_000;
// Typical broadcast length per sport, used until a live status says otherwise.
export const DURATION: Record<string, number> = { football: 3.5, basketball: 2.5, baseball: 3.25, hockey: 3, soccer: 2, mma: 6, boxing: 5, wrestling: 3, racing: 3, golf: 10, default: 3 };
export const duration = (sport: string) => (DURATION[sport] ?? DURATION.default!) * HOUR;
export const DEFAULT_ESPN = ['football/nfl', 'football/college-football', 'basketball/nba', 'basketball/wnba', 'basketball/mens-college-basketball', 'basketball/womens-college-basketball', 'baseball/mlb', 'hockey/nhl', 'soccer/usa.1', 'soccer/eng.1', 'soccer/esp.1', 'soccer/ger.1', 'soccer/ita.1', 'soccer/fra.1', 'soccer/mex.1', 'soccer/eng.2', 'soccer/ned.1', 'soccer/por.1', 'soccer/sco.1', 'soccer/tur.1', 'soccer/bel.1', 'soccer/eng.w.1', 'soccer/uefa.champions', 'soccer/uefa.europa', 'mma/ufc', 'racing/f1', 'racing/nascar-premier', 'golf/pga'];
// Boxing and WWE. The free key returns one next and one past event per league.
export const DEFAULT_TSDB = ['4445', '4444'];
// Names for the built-in leagues, so settings can list them before their first download.
export const LEAGUE_NAMES: Record<string, string> = { 'football/nfl': 'NFL', 'football/college-football': 'College Football', 'basketball/nba': 'NBA', 'basketball/wnba': 'WNBA',
  'basketball/mens-college-basketball': "Men's College Basketball", 'basketball/womens-college-basketball': "Women's College Basketball", 'baseball/mlb': 'MLB', 'hockey/nhl': 'NHL',
  'soccer/usa.1': 'MLS', 'soccer/eng.1': 'Premier League', 'soccer/esp.1': 'La Liga', 'soccer/ger.1': 'Bundesliga', 'soccer/ita.1': 'Serie A', 'soccer/fra.1': 'Ligue 1', 'soccer/mex.1': 'Liga MX',
  'soccer/eng.2': 'EFL Championship', 'soccer/ned.1': 'Eredivisie', 'soccer/por.1': 'Primeira Liga', 'soccer/sco.1': 'Scottish Premiership', 'soccer/tur.1': 'Süper Lig', 'soccer/bel.1': 'Belgian Pro League',
  'soccer/eng.w.1': "Women's Super League", 'soccer/uefa.champions': 'UEFA Champions League', 'soccer/uefa.europa': 'UEFA Europa League', 'mma/ufc': 'UFC', 'racing/f1': 'Formula 1',
  'racing/nascar-premier': 'NASCAR Cup Series', 'golf/pga': 'PGA Tour', 'tsdb:4445': 'Boxing', 'tsdb:4444': 'WWE' };
const LEAGUE_SPORTS: Record<string, string> = { 'tsdb:4445': 'boxing', 'tsdb:4444': 'wrestling' };
// The sport of a configured league: the first part of an ESPN path, else the known TheSportsDB league.
export const leagueSport = (key: string) => LEAGUE_SPORTS[key] ?? (key.startsWith('tsdb:') ? 'sports' : key.split('/')[0]!);
// College scoreboards only list featured games unless asked for the whole division.
const EXTRA: Record<string, string> = { 'football/college-football': '&groups=80&limit=500', 'basketball/mens-college-basketball': '&groups=50&limit=500', 'basketball/womens-college-basketball': '&groups=50&limit=500' };

type Fetch = (url: string) => Promise<unknown>;
export const fetchJson = (fetcher = new RestrictedSourceFetcher()): Fetch => async url => JSON.parse((await fetcher.fetch({ url, headers: { accept: 'application/json', 'user-agent': 'tk.box' }, allowInsecureHttp: false })).toString('utf8'));

type EspnTeam = { displayName?: string; shortDisplayName?: string; name?: string; location?: string; abbreviation?: string; logo?: string };
type EspnEvent = { id: string; name: string; date: string; endDate?: string; status?: { type?: { state?: string } };
  competitions?: { competitors?: { homeAway?: string; team?: EspnTeam; athlete?: { displayName?: string; shortName?: string } }[] }[] };
const aliases = (...names: (string | undefined)[]) => [...new Set(names.filter((n): n is string => !!n && n.length > 2).map(n => norm(n).trim()))];
const state = (s?: string): SportsEvent['state'] => s === 'in' ? 'in' : s === 'post' ? 'post' : 'pre';
const https = (url: unknown) => typeof url === 'string' && /^https:\/\//i.test(url) ? url : undefined;
// Both teams' logos in the order the title names them, or none.
const pair = (a: unknown, b: unknown) => { const logos = [https(a), https(b)]; return logos.every(Boolean) ? logos as string[] : []; };

export function espnEvents(path: string, body: unknown): SportsEvent[] {
  const [sport = 'default', league = path] = path.split('/'), json = body as { events?: EspnEvent[]; leagues?: { abbreviation?: string; name?: string }[] };
  const leagueName = json.leagues?.[0]?.abbreviation ?? json.leagues?.[0]?.name ?? league;
  return (json.events ?? []).flatMap(e => {
    const start = Date.parse(e.date);
    if (!e.id || !e.name || !Number.isFinite(start)) return [];
    // Team sports list two teams; fight cards list one competition per bout and are matched by title.
    const competitors = e.competitions?.[0]?.competitors ?? [], teams = competitors.map(c => c.team).filter((t): t is EspnTeam => !!t);
    // ESPN titles games "Away at Home".
    const [away, home] = [...competitors].sort((a, b) => Number(a.homeAway !== 'away') - Number(b.homeAway !== 'away')).map(c => c.team?.logo);
    const end = e.endDate && sport === 'golf' ? Date.parse(e.endDate) : start + duration(sport);
    return [{ id: `espn:${e.id}`, source: 'espn' as const, sport, league: leagueName, leagueKey: path, title: e.name, start, end: Number.isFinite(end) && end > start ? end : start + duration(sport), state: state(e.status?.type?.state), timeKnown: true,
      sides: teams.length === 2 ? teams.map(t => aliases(t.displayName, t.shortDisplayName, t.name, t.location)) : [],
      abbreviations: teams.length === 2 && teams.every(t => t.abbreviation) ? teams.map(t => t.abbreviation!) : [], logos: teams.length === 2 ? pair(away, home) : [] }];
  });
}
type TsdbEvent = { idEvent: string; idLeague?: string | null; strEvent?: string; strSport?: string; strLeague?: string; strTimestamp?: string | null; dateEvent?: string | null; strTime?: string | null; strHomeTeam?: string | null; strAwayTeam?: string | null; strHomeTeamBadge?: string | null; strAwayTeamBadge?: string | null; strStatus?: string | null };
const SPORTS: Record<string, string> = { fighting: 'mma', 'american football': 'football', 'ice hockey': 'hockey', motorsport: 'racing' };
export function tsdbEvents(body: unknown): SportsEvent[] {
  return ((body as { events?: TsdbEvent[] | null }).events ?? []).flatMap(e => {
    // Times are UTC without a zone marker. Midnight usually means only the date is known.
    const raw = e.strTimestamp ?? (e.dateEvent ? `${e.dateEvent}T${e.strTime ?? '00:00:00'}` : undefined), start = raw ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}Z`) : NaN;
    if (!e.idEvent || !e.strEvent || !Number.isFinite(start)) return [];
    const league = e.strLeague ?? '', sportName = (e.strSport ?? '').toLowerCase();
    const sport = /boxing/i.test(league) ? 'boxing' : /wwe|aew|wrestl/i.test(league) ? 'wrestling' : SPORTS[sportName] ?? sportName;
    const timeKnown = !/T00:00(:00)?$/.test(raw!.replace(/Z$/, ''));
    const sides = e.strHomeTeam && e.strAwayTeam ? [aliases(e.strHomeTeam, e.strHomeTeam.split(' ').pop()), aliases(e.strAwayTeam, e.strAwayTeam.split(' ').pop())] : [];
    const finished = /^(FT|AET|PEN|Match Finished|Finished)$/i.test(e.strStatus ?? '');
    // A date-only event covers that evening in the Americas: 12:00 UTC to 08:00 UTC the next day.
    return [{ id: `tsdb:${e.idEvent}`, source: 'tsdb' as const, sport, league, leagueKey: e.idLeague ? `tsdb:${e.idLeague}` : `tsdb:${norm(league).trim() || sport}`, title: e.strEvent, start: timeKnown ? start : start + 12 * HOUR, end: timeKnown ? start + duration(sport) : start + 32 * HOUR, state: finished ? 'post' as const : 'pre' as const, timeKnown, sides, abbreviations: [], logos: sides.length ? pair(e.strHomeTeamBadge, e.strAwayTeamBadge) : [] }];
  });
}

// ESPN scoreboard dates are US Eastern calendar days.
export const espnDay = (at: number) => { const d = zonedDate(at, 'America/New_York'); return `${d.year}${String(d.month).padStart(2, '0')}${String(d.day).padStart(2, '0')}`; };
export const espnUrl = (path: string, day: string) => `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${day}${EXTRA[path] ?? ''}`;
export const tsdbUrls = (key: string, league: string) => [`https://www.thesportsdb.com/api/v1/json/${encodeURIComponent(key)}/eventsnextleague.php?id=${league}`, `https://www.thesportsdb.com/api/v1/json/${encodeURIComponent(key)}/eventspastleague.php?id=${league}`];
// Fight cards by day: three per day on the free key, which still catches cards a league list misses.
export const tsdbDayUrl = (key: string, day: string, sport: string) => `https://www.thesportsdb.com/api/v1/json/${encodeURIComponent(key)}/eventsday.php?d=${day}&s=${encodeURIComponent(sport)}`;
export const tsdbLeagueUrl = (key: string, league: string) => `https://www.thesportsdb.com/api/v1/json/${encodeURIComponent(key)}/lookupleague.php?id=${encodeURIComponent(league)}`;

// League logos for event channels with no logo of their own. ESPN's scoreboard names its league's logos;
// the version drawn for dark backgrounds suits the guide's tiles. TheSportsDB has a badge per league.
export function espnLeagueLogo(body: unknown) {
  const logos = (body as { leagues?: { logos?: { href?: string; rel?: string[] }[] }[] }).leagues?.[0]?.logos ?? [];
  return https((logos.find(l => l.rel?.includes('dark')) ?? logos[0])?.href);
}
export function tsdbLeagueLogo(body: unknown) {
  const league = (body as { leagues?: { strBadge?: string | null; strLogo?: string | null }[] | null }).leagues?.[0];
  return https(league?.strBadge) ?? https(league?.strLogo);
}
