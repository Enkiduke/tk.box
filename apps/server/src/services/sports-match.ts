// Sports event matching: which provider channel carries which scheduled event, and when it airs.
// Sports categories list hundreds of event channels whose names go stale ("PPV 3: Canelo vs X" months
// after the fight). A channel is only worth showing while a real, scheduled event it names is on.
export type SportsEvent = {
  // leagueKey stays the same across fetches: the ESPN sport/league path or "tsdb:<league ID>". league is its display name.
  id: string; source: 'espn' | 'tsdb'; sport: string; league: string; leagueKey: string; title: string;
  start: number; end: number; state: 'pre' | 'in' | 'post'; timeKnown: boolean;
  // Alias lists for each side (teams or fighters), already normalized.
  sides: string[][]; abbreviations: string[];
  // Both teams' logo addresses in title order ("Away at Home", "Home vs Away"), when the schedule names them.
  logos?: string[];
};
export type Window = { eventId: string | null; title: string; league: string; start: number; end: number; state: SportsEvent['state'] | null; matchedBy: 'event' | 'epg_event' | 'name_time' | 'epg'; sport?: Sport; leagueKey?: string };
export type ChannelInput = { id: string; name: string; group: string; programs: { start: number; end: number; title: string; subtitle?: string }[] };

export const norm = (s: string) => ` ${s.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en').replace(/&/g, ' and ').replace(/@/g, ' at ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
const has = (text: string, phrase: string) => phrase.length > 2 && text.includes(` ${phrase.trim()} `);
const STOP = new Set(['vs', 'v', 'at', 'the', 'and', 'of', 'fc', 'cf', 'sc', 'afc', 'de', 'la', 'el', 'live', 'game', 'match', 'event', 'week', 'round', 'rd', 'day', 'night', 'fight', 'championship', 'cup', 'tour', 'open', 'grand', 'prix', 'presented', 'by']);
const SPLIT = /\s+(?:vs\.?|v\.?|versus|at|@)\s+/i;
// "No event", "Off air", "Next game: …" and replays are what providers show between live events.
export const PLACEHOLDER = /\b(no (live )?(event|game|match|programming)s?|off ?air|sign ?off|tba|tbd|to be (announced|determined)|coming soon|not scheduled|no information|event (has )?ended|stay tuned|(next|upcoming) (game|event|match|fight)s?|replays?|re-?airs?|reruns?|encore|highlights)\b/i;

// Last significant word of each side of "A vs. B": surnames for fighters, nicknames for teams.
function versusPair(title: string) {
  const parts = title.replace(/^[^:]*:\s*/, m => /\bvs?\.?\b|@/i.test(m) ? m : '').split(SPLIT);
  if (parts.length !== 2) return undefined;
  const last = (s: string) => norm(s.replace(/\(.*?\)|\[.*?\]/g, '')).trim().split(' ').filter(w => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)).pop();
  const a = last(parts[0]!), b = last(parts[1]!);
  return a && b && a !== b ? [a, b] as const : undefined;
}
const sportWords: Record<string, string[]> = { football: ['football', 'nfl', 'ncaaf', 'cfb'], basketball: ['basketball', 'nba', 'wnba', 'ncaab'], baseball: ['baseball', 'mlb'], hockey: ['hockey', 'nhl'], soccer: ['soccer', 'football', 'futbol'], mma: ['mma', 'ufc'], boxing: ['boxing', 'fight'], wrestling: ['wwe', 'aew', 'wrestling'], golf: ['golf', 'pga', 'lpga'], racing: ['racing', 'f1', 'formula', 'nascar', 'indycar'] };
const contextWords = (e: SportsEvent) => [...norm(e.league).trim().split(' '), ...(sportWords[e.sport] ?? [e.sport])].filter(w => w.length > 1);

// A rematch scores every channel against every event, so what depends on the event alone is worked out once.
const facts = new WeakMap<SportsEvent, { pair: ReturnType<typeof versusPair>; numbered?: string; words: string[]; context: string[]; abbreviations?: RegExp }>();
function eventFacts(e: SportsEvent) {
  let f = facts.get(e);
  if (f) return f;
  const title = norm(e.title), context = contextWords(e), numbered = title.match(/ ([a-z]{2,}) (\d{2,4}) /);
  const [a, b] = e.abbreviations.map(x => x.toLowerCase());
  f = { pair: versusPair(e.title), ...(numbered ? { numbered: `${numbered[1]} ${numbered[2]}` } : {}), context,
    words: title.trim().split(' ').filter(w => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w) && !context.includes(w)),
    ...(e.abbreviations.length === 2 ? { abbreviations: new RegExp(` (?:${a} (?:vs?|at) ${b}|${b} (?:vs?|at) ${a}) `) } : {}) };
  facts.set(e, f);
  return f;
}
// The same text is scored against every event in a row.
let lastText: string | undefined, lastNorm = '';
const normText = (text: string) => text === lastText ? lastNorm : (lastText = text, lastNorm = norm(text));

// How strongly a text names an event: 0 none, higher is more specific.
export function eventScore(text: string, e: SportsEvent) {
  const t = normText(text), { pair, numbered, words, context, abbreviations } = eventFacts(e);
  let score = 0;
  if (e.sides.length === 2 && e.sides.every(side => side.some(alias => has(t, alias)))) score = 4;
  else if (abbreviations?.test(t)) score = 3;
  if (!score && pair && has(t, pair[0]) && has(t, pair[1])) score = 3;
  // Numbered cards: "UFC 333", "Bellator 312".
  if (!score && numbered && has(t, numbered)) score = 3;
  // Titled shows and tournaments ("WWE Raw", "Butterfield Bermuda Championship"): every distinctive
  // title word plus the league or sport.
  if (!score && !pair) {
    if (words.length && words.every(w => has(t, w)) && context.some(w => has(t, w) || t.includes(` ${w} `))) score = words.length > 1 ? 2 : 1;
  }
  if (score && context.some(w => t.includes(` ${w} `))) score += 0.5;
  return score;
}

const ZONES: Record<string, string> = { et: 'America/New_York', est: 'America/New_York', edt: 'America/New_York', ct: 'America/Chicago', cst: 'America/Chicago', cdt: 'America/Chicago', mt: 'America/Denver', mst: 'America/Denver', mdt: 'America/Denver', pt: 'America/Los_Angeles', pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles', uk: 'Europe/London', bst: 'Europe/London', gmt: 'UTC', utc: 'UTC', cet: 'Europe/Paris', cest: 'Europe/Paris' };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// Building a formatter is far slower than using one, and matching converts times for every channel.
const formatters = new Map<string, Intl.DateTimeFormat>();
const formatter = (zone: string, time: boolean) => {
  const key = `${zone} ${time}`;
  let f = formatters.get(key);
  if (!f) formatters.set(key, f = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', ...(time ? { hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric' } as const : {}) }));
  return f;
};
function offset(zone: string, at: number) {
  const parts = Object.fromEntries(formatter(zone, true).formatToParts(at).map(p => [p.type, Number(p.value)]));
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) - Math.floor(at / 1000) * 1000;
}
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, zone: string) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offset(zone, guess);
  return guess - offset(zone, first);
}
export const zonedDate = (at: number, zone: string) => {
  const p = Object.fromEntries(formatter(zone, false).formatToParts(at).map(x => [x.type, Number(x.value)]));
  return { year: p.year!, month: p.month!, day: p.day! };
};

// Date and time written in a channel name or listing: "10/18 8:00PM ET", "Oct 18 @ 20:00", "2026-10-18 13:00".
// Without a year, the occurrence nearest to now is used. Returns the date's midnight when only a date is written.
export function nameTime(name: string, now: number, defaultZone = 'America/New_York') {
  const s = name.toLowerCase();
  let month: number | undefined, day: number | undefined, year: number | undefined;
  const iso = s.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  const numeric = s.match(/(?<![\d:])(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?(?![\d:])/);
  const named = s.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS.join('|')})[a-z]*\\.?\\b|\\b(${MONTHS.join('|')})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`));
  if (iso) { year = Number(iso[1]); month = Number(iso[2]); day = Number(iso[3]); }
  else if (named) { month = MONTHS.indexOf((named[2] ?? named[3])!) + 1; day = Number(named[1] ?? named[4]); }
  else if (numeric) { month = Number(numeric[1]); day = Number(numeric[2]); if (numeric[3]) year = Number(numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]); if (month > 12 && day <= 12) [month, day] = [day, month]; }
  const clock = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) ?? s.match(/(?<![\d/.])(\d{1,2}):(\d{2})(?![\d/])/);
  const zoneWord = s.match(/\b(et|est|edt|ct|cst|cdt|mt|mst|mdt|pt|pst|pdt|uk|bst|gmt|utc|cet|cest)\b/)?.[1];
  const zone = zoneWord ? ZONES[zoneWord]! : defaultZone;
  let hour: number | undefined, minute = 0;
  if (clock) { hour = Number(clock[1]) % (clock[3] ? 12 : 24); minute = Number(clock[2] ?? 0); if (clock[3] === 'pm') hour += 12; if (hour > 23 || minute > 59) hour = undefined; }
  if (!month || !day || month > 12 || day > 31) return hour === undefined ? undefined : { at: undefined, hour, minute, zone };
  const today = zonedDate(now, zone), candidates = year ? [year] : [today.year - 1, today.year, today.year + 1];
  const at = candidates.map(y => zonedTime(y, month!, day!, hour ?? 0, minute, zone)).sort((a, b) => Math.abs(a - now) - Math.abs(b - now))[0]!;
  return { at, hour, minute, zone, dateOnly: hour === undefined, explicit: !!zoneWord };
}

// Providers write each channel family's times in one zone without saying which ("Football Event 11ⓧ: … 11:30"
// is UK time, "FNTZ 06: … 11:15 AM" Eastern). The family is the name before its slot number or first separator.
export const family = (name: string) => norm(name.split(/\d|[:|]/)[0] ?? '').trim();
const CANDIDATE_ZONES = ['America/New_York', 'Europe/London', 'Europe/Paris', 'UTC', 'America/Chicago', 'America/Los_Angeles'];
// Learns each family's zone from channels that name a scheduled event: the zone in which the written time
// equals the event's start. A family keeps the default zone unless another zone explains more channels.
export function learnZones(channels: Pick<ChannelInput, 'name'>[], events: SportsEvent[], now: number, defaultZone: string) {
  const votes = new Map<string, Map<string, number>>();
  for (const c of channels) {
    const written = nameTime(c.name, now, defaultZone);
    if (written?.at === undefined || written.dateOnly || written.explicit) continue;
    const named = events.filter(e => e.timeKnown && eventScore(c.name, e) > 0);
    for (const zone of CANDIDATE_ZONES) {
      const at = nameTime(c.name, now, zone)!.at!;
      if (!named.some(e => Math.abs(at - e.start) <= 10 * 60_000)) continue;
      const tally = votes.get(family(c.name)) ?? new Map<string, number>();
      tally.set(zone, (tally.get(zone) ?? 0) + 1); votes.set(family(c.name), tally); break;
    }
  }
  const zones = new Map<string, string>();
  for (const [name, tally] of votes) {
    const [zone, n] = [...tally].sort((a, b) => b[1] - a[1])[0]!;
    if (zone !== defaultZone && n > (tally.get(defaultZone) ?? 0)) zones.set(name, zone);
  }
  return zones;
}

const DAY = 86400_000, HOUR = 3600_000;
// A written date or time that contradicts an event means a recycled or stale listing.
function consistent(text: string, e: SportsEvent, now: number, zone: string) {
  const written = nameTime(text, now, zone);
  if (!written) return true;
  if (written.at !== undefined) return written.dateOnly ? Math.abs(written.at - zonedDay(e.start, written.zone)) <= DAY : !e.timeKnown || Math.abs(written.at - e.start) <= 4 * HOUR;
  return true;
}
const zonedDay = (at: number, zone: string) => { const d = zonedDate(at, zone); return zonedTime(d.year, d.month, d.day, 0, 0, zone); };

function bestEvent(text: string, events: SportsEvent[], now: number, zone: string) {
  let best: { e: SportsEvent; score: number } | undefined;
  for (const e of events) {
    const score = eventScore(text, e);
    if (!score || !consistent(text, e, now, zone)) continue;
    const better = !best || score > best.score || (score === best.score && (rank(e, now) < rank(best.e, now)));
    if (better) best = { e, score };
  }
  return best?.e;
}
// Live first, then the next to start, then the most recently finished; ESPN before TheSportsDB.
const rank = (e: SportsEvent, now: number) => (e.state === 'in' || (e.start <= now && e.end > now) ? 0 : e.start > now ? 1 + (e.start - now) / DAY : 10 + (now - e.end) / DAY) + (e.source === 'tsdb' ? 0.01 : 0);

const fromEvent = (e: SportsEvent, matchedBy: Window['matchedBy']): Window => ({ eventId: e.id, title: e.title, league: e.league, leagueKey: e.leagueKey, start: e.start, end: e.end, state: e.state, matchedBy, sport: e.sport as Sport });
// The window a channel should be shown for: the current one, else the next. Past windows mean the listing is stale.
// `allow` drops candidates an administrator excluded (a league turned off), so a later allowed one can still win.
export function channelWindow(c: ChannelInput, events: SportsEvent[], now: number, options: { zone: string; nameHours: number; zones?: Map<string, string>; allow?: (w: Window) => boolean }): Window | undefined {
  const text = `${c.name} ${c.group}`, candidates: Window[] = [], zone = options.zones?.get(family(c.name)) ?? options.zone;
  const named = bestEvent(c.name, events, now, zone) ?? (c.group ? bestEvent(text, events, now, zone) : undefined);
  if (named) {
    // A date-only listing (common for boxing) takes its time from the channel name when it has one.
    const written = named.timeKnown ? undefined : nameTime(c.name, now, zone);
    const start = written?.hour !== undefined ? zonedTime(...ymd(named.start, written.zone), written.hour, written.minute, written.zone) : named.start;
    candidates.push({ ...fromEvent(named, 'event'), start, end: Math.max(named.end, start + (named.end - named.start)) });
  }
  for (const p of c.programs) {
    const listing = `${p.title} ${p.subtitle ?? ''}`;
    if (PLACEHOLDER.test(listing)) continue;
    const e = bestEvent(listing, events, now, options.zone);
    if (e) candidates.push(fromEvent(e, 'epg_event'));
    else if (liveListing(listing, p, events)) candidates.push({ eventId: null, title: p.title, league: '', start: p.start, end: p.end, state: null, matchedBy: 'epg' });
  }
  if (!named) {
    const written = nameTime(c.name, now, zone);
    if (written?.at !== undefined && !written.dateOnly && !PLACEHOLDER.test(c.name))
      candidates.push({ eventId: null, title: cleanTitle(c.name), league: '', start: written.at, end: written.at + options.nameHours * HOUR, state: null, matchedBy: 'name_time' });
  }
  const chosen = candidates.filter(w => w.end > now && (options.allow?.(w) ?? true)).sort((a, b) => a.start - b.start || order(a) - order(b))[0];
  return chosen && { ...chosen, sport: sportOf(`${c.name} ${c.group} ${chosen.league} ${chosen.title}`, chosen.sport) };
}
// A listing that names no known event still counts when it is a matchup ("Bayern vs Dortmund") or a league
// show while that league is playing ("NFL Red Zone" on a Sunday). A team channel's listing ("NBA: Oklahoma City
// Thunder") with no game of that team on is filler.
function liveListing(listing: string, p: { start: number; end: number }, events: SportsEvent[]) {
  if (/\s(vs\.?|v|versus|at|@)\s/i.test(listing)) return true;
  const t = norm(listing), league = (e: SportsEvent) => norm(e.league).trim();
  const mentioned = events.filter(e => league(e).length > 1 && t.includes(` ${league(e)} `));
  if (mentioned.some(e => e.sides.some(side => side.some(alias => has(t, alias))))) return false;
  return mentioned.some(e => e.start < p.end && e.end > p.start);
}
// Which sport a channel carries, for its fallback icon. Schedule sports win; otherwise the name, group, league
// and title decide, most specific first. Providers say "football" for soccer unless it is American football.
export const SPORTS = ['boxing', 'mma', 'wrestling', 'football', 'basketball', 'baseball', 'hockey', 'golf', 'racing', 'tennis', 'cycling', 'rugby', 'cricket', 'darts', 'curling', 'soccer'] as const;
export type Sport = typeof SPORTS[number] | 'sports';
const SPORT_WORDS: [Sport, RegExp][] = [
  ['boxing', /\bboxing\b|\bboxeo\b|\bboxen\b|title fight/],
  ['mma', /\bufc\b|\bmma\b|bellator|\bpfl\b|one championship|one fight night|cage warriors/],
  ['wrestling', /\bwwe\b|\baew\b|wrestl|\bsmackdown\b|\bnxt\b|\braw\b/],
  ['football', /\bnfl\b|ncaaf|college football|\bcfl\b|\bufl\b|red ?zone|american football|sunday ticket/],
  ['basketball', /\bnba\b|\bwnba\b|ncaab|basketball|euroleague|\bnbl\b/],
  ['baseball', /\bmlb\b|baseball|\bnpb\b|\bkbo\b/],
  ['hockey', /\bnhl\b|hockey|\bkhl\b|\bahl\b/],
  ['golf', /\bgolf\b|\bpga\b|\blpga\b|\bliv golf\b|ryder cup/],
  ['racing', /\bf1\b|formula ?[1e]|nascar|indycar|motogp|\bracing\b|grand prix|\brally\b|\bwrc\b|supercars|\bfia\b|\bwec\b|\bimsa\b|hours of|free practice|qualifying|endurance|speedway|lucas oil|\bdirt\b|late model|sprint car|\bstss\b|drivers? multiview|\b[1-9]00 no \d+\b/],
  ['tennis', /tennis|\batp\b|\bwta\b|wimbledon|roland garros/],
  ['cycling', /cycling|cyclo ?cross|superprestige|\bhg cross\b|\bvelo\b|\d+(\.\d+)?\s?km\b|\bstage \d+\b|giro d|vuelta|tour de france|\bclassic\b.*\bmen\b|\bmen\b.*\bclassic\b/],
  ['rugby', /rugby|\bnrl\b|six nations|super rugby/],
  ['cricket', /cricket|\bipl\b|\bt20\b|test match|\bbbl\b/],
  ['darts', /\bdarts?\b|\bpdc\b|winmau/],
  ['curling', /curling|\bgsoc\b|grand slam of curling/],
  ['soccer', /soccer|football|futbol|futebol|futsal|\bliga\b|league|bundesliga|serie a|ligue|eredivisie|premier|championship|\bcup\b|\bcopa\b|\bcoppa\b|\bfc\b|\bsc\b|\bcf\b|\bafc\b|united|uefa|fifa|\bmls\b|fawsl|ekstraklasa|superliga|allsvenskan|divisie|calcio|\bhnl\b|\bnb i\b|\bprimera\b|\bliga\d|\bdeportivo\b|\batletico\b|\bsporting\b/]];
export function sportOf(text: string, scheduled?: string): Sport {
  if (scheduled && (SPORTS as readonly string[]).includes(scheduled)) return scheduled as Sport;
  const t = norm(text);
  return SPORT_WORDS.find(([, words]) => words.test(t))?.[0] ?? 'sports';
}
// The event an event channel carries, as its viewer-facing name: the matchup alone, without slot, country,
// league, date or channel tag. "Bundesliga 09ⓧ: Borussia Monchengladbach vs. TSG Hoffenheim | Sunday, 18 October
// 2026 16:30" → "Borussia Monchengladbach vs. TSG Hoffenheim". Names without a matchup keep the cleaned title.
const MATCHUP = /\s(vs\.?|v|versus|at|@)\s/i;
export function eventChannelName(raw: string) {
  for (const text of [cleanTitle(raw), raw.replace(new RegExp(WHEN.source, 'gi'), ' ')]) {
    const part = text.split(/\s*\|\s*|:\s+/).map(s => s.trim()).find(s => MATCHUP.test(` ${s} `));
    if (part) return part.replace(/^\d{1,4}\S{0,3}\s+/, '').replace(/\s{2,}/g, ' ').trim();
  }
  // Races and tournaments: "Men | Cittadella Bassano del Grappa (158km): Veneto Classic" → "Veneto Classic".
  const title = cleanTitle(raw), last = title.split(/:\s+/).pop()!.trim();
  return last.length >= 6 ? last : title;
}
// What tells feeds of one event apart in the feed picker: the provider's slot ("Bundesliga 09", "FNTZ 06",
// "Sportsnet+ 09", "NFL 02") and any stream qualifier ("Away Stream").
export function channelTag(raw: string) {
  const slot = raw.match(/^\s*([^:|]{1,24}?\d{1,4})\S{0,3}\s*[:|]/)?.[1] ?? raw.match(/:\s*([^:]{1,24}?\d{1,4})\S{0,3}\s*$/)?.[1] ?? raw.match(/^\s*([\p{L}+ ]{2,20}?)\s*\|\s*(\d{1,4})\b/u)?.slice(1).join(' ');
  const qualifier = raw.split('|').map(s => s.trim()).find(s => /\b(home|away|alt(ernate)?|backup|spanish|english|french|feed|stream)\b/i.test(s) && !MATCHUP.test(` ${s} `));
  return [slot?.trim(), qualifier].filter(Boolean).join(' · ') || raw;
}
export function byGroup<T extends { group: string }>(channels: T[]) {
  const groups = new Map<string, T[]>();
  for (const c of channels) { const list = groups.get(c.group); if (list) list.push(c); else groups.set(c.group, [c]); }
  return groups;
}
// Channels carrying the same event share a guide row with selectable feeds. Scheduled events group by ID;
// others by the matchup's two sides (or the title) on the same UTC day, so "FAWSL: Aston Villa vs Liverpool"
// and "Aston Villa v Liverpool | Sunday" combine.
export function stackKey(w: Window) {
  if (w.eventId) return `event:${w.eventId}`;
  const pair = versusPair(cleanTitle(w.title)), day = new Date(w.start).toISOString().slice(0, 10);
  return `match:${pair ? [...pair].sort().join(':') : norm(cleanTitle(w.title)).trim()}:${day}`;
}
const order = (w: Window) => ['event', 'epg_event', 'name_time', 'epg'].indexOf(w.matchedBy);
const ymd = (at: number, zone: string) => { const d = zonedDate(at, zone); return [d.year, d.month, d.day] as const; };
// "PPV 04: UFC 333 | 10/24 10PM ET" → "UFC 333"; "Celtic vs Hearts @ Oct 18" → "Celtic vs Hearts";
// "Bulgaria, Bulgarian Cup | Burgas vs. Botev | Sunday, 18 October 2026" → "Bulgaria, Bulgarian Cup | Burgas vs. Botev"
const WHEN = new RegExp(String.raw`\b((mon|tues?|wed(nes)?|thu(rs)?|fri|sat(ur)?|sun)(day)?\b,?\s*)?(\d{1,2}(st|nd|rd|th)?\s+(${MONTHS.join('|')})[a-z]*\.?(\s+\d{4})?|(${MONTHS.join('|')})[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?(,?\s+\d{4})?|20\d{2}-\d{1,2}-\d{1,2}|\d{1,2}[/.]\d{1,2}([/.]\d{2,4})?)\b|\b\d{1,2}(:\d{2})?\s*(am|pm)\b|(?<![\d/.])\d{1,2}:\d{2}\b|\b(et|est|edt|ct|cst|cdt|mt|pt|pst|pdt|uk|bst|gmt|utc|cet|cest)\b`, 'gi');
// Everything from the first written date or time on is schedule detail or a repeated channel tag.
export const cleanTitle = (name: string) => {
  const body = name.replace(/^[\p{L}+ ]{1,20}\d{1,4}\S{0,3}\s*[:|-]\s*/u, ''), at = body.search(new RegExp(WHEN.source, 'i'));
  const title = (at > 0 ? body.slice(0, at) : body).replace(/[([]\s*$/g, '').replace(/(\s*[|@,(-]\s*)+$/g, '').replace(/\s{2,}/g, ' ').trim();
  return title || name;
};
