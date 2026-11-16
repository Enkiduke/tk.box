// The release-name parser (docs/ARR-REPLACEMENT.md, "The parser"). Pure: a name in, what it says out. Everything after
// the title (resolution, source, codecs, flags) is read only from the part after the title and year, so a title word
// like "Web", "French" or "Real" is never taken for a tag.

export type Resolution = 2160 | 1080 | 720 | 576 | 480;
export type Source = 'CAM' | 'TELESYNC' | 'TELECINE' | 'SCREENER' | 'DVD' | 'HDTV' | 'WEBRip' | 'WEBDL' | 'BluRay';
export type VideoCodec = 'h264' | 'h265' | 'av1' | 'xvid';
export type Hdr = 'DV' | 'HDR10+' | 'HDR10' | 'HDR' | 'HLG';
export type AudioCodec = 'TrueHD' | 'DTS-X' | 'DTS-HD MA' | 'DTS-HD' | 'DTS' | 'EAC3' | 'AC3' | 'AAC' | 'FLAC' | 'Opus' | 'MP3' | 'PCM';
export type Edition = "Director's Cut" | 'Extended' | 'Theatrical' | 'Unrated' | 'IMAX' | 'Remastered';

export type ParsedRelease = {
  name: string;
  // As the name gives it, separators turned to spaces. Empty for an obfuscated name.
  title: string;
  year?: number;
  // Episodes: S01E02 gives season 1, episodes [2]; S01E01E02, S01E01-E02 and S01E01-02 give [1, 2]. A season pack has
  // a season and no episodes. A multi-season pack (S01-S03, Seasons 1-3, Complete Series) sets multiSeason only.
  season?: number;
  episodes: number[];
  seasonPack: boolean;
  multiSeason: boolean;
  resolution?: Resolution;
  source?: Source;
  remux: boolean;
  codec?: VideoCodec;
  // 'x264' or 'x265' when the name names the encoder (naming's VideoCodec uses it).
  encoder?: 'x264' | 'x265';
  hdr: Hdr[];
  audio: { codec?: AudioCodec; atmos: boolean; channels?: string };
  // The streaming service a WEB release came from, as the scene writes it: AMZN, NF, DSNP, ATVP, HMAX, MAX, MA, iT…
  service?: string;
  proper: boolean; repack: boolean; real: boolean;
  hardcodedSubs: boolean;
  editions: Edition[];
  group?: string;
  // Scene language markers, named in English: 'Multi', 'French', 'German'…
  languages: string[];
  threeD: boolean;
  obfuscated: boolean;
  // Ids written into the name ({tmdb-44115}, tt0111161), as Radarr's and Sonarr's own file names carry them.
  ids: { tmdb?: number; imdb?: string };
};

const A = '(?<![A-Za-z0-9])', Z = '(?![A-Za-z0-9])';
// A tag standing on its own between separators.
const tag = (source: string, flags = 'i') => new RegExp(`${A}(?:${source})${Z}`, flags);
// An audio tag, which may run straight into its channels (DDP5.1, AAC2.0).
const audioTag = (source: string) => new RegExp(`${A}(?:${source})(?![A-Za-z])`, 'i');

// The tokens that end a title: episode and season markers, resolutions, sources, codecs, audio, HDR and release flags.
// Matched at a token's start. Words that are also ordinary title words (WEB, CAM, PROPER, DV) only count in capitals.
const STOP = new RegExp(`^(?:${[
  'S\\d{1,2}(?:[ ._-]?E\\d{1,3})*', '\\d{1,2}x\\d{2,3}', 'S\\d{1,2}S\\d{1,2}', '[Ss]eason[ ._-]?\\d{1,2}', '[Ss]easons', 'COMPLETE', '[Cc]omplete[ ._-][Ss]eries',
  '(?:2160|1080|720|576|480)[pPiI]', '4K', 'UHD',
  '(?:HD-?)?CAM(?:-?Rip)?', 'CAMRip', '(?:HD-?)?TS(?:-?Rip)?', 'TELESYNC', 'PDVD', '(?:HD-?)?TC', 'TELECINE',
  '(?:DVD|BD|WEB)?-?SCR(?:EENER)?', 'DVD(?:-?Rip|-?R|5|9)?', 'HDTV(?:Rip)?', 'PDTV', 'SDTV', 'TVRip',
  'WEB', '[Ww][Ee][Bb][ ._-]?(?:[Dd][Ll](?:[Rr][Ii][Pp])?|[Rr][Ii][Pp])', '[Bb][Ll][Uu]-?[Rr][Aa][Yy]', '[Bb][Dd][Rr][Ii][Pp]', '[Bb][Rr][Rr][Ii][Pp]', '[Rr][Ee][Mm][Uu][Xx]',
  '[xXhH][ .]?26[45]', 'HEVC', 'AVC', 'AV1', '[Xx][Vv][Ii][Dd]', 'DivX', '10bit', '8bit',
  'DDP?\\+?\\d', 'DDPA?', 'E?AC-?3', 'DTS', 'TrueHD', 'TRUEHD', 'Atmos', 'ATMOS', 'AAC', 'FLAC',
  'HDR(?:10)?(?:\\+|Plus)?', 'DoVi', 'DOVI', 'DV', 'HLG', 'SDR',
  'PROPER', 'REPACK', 'RERIP', 'iNTERNAL', 'INTERNAL', 'HC', 'KORSUB', 'MULT[iI]', 'DUAL', 'DUBBED', 'SUBBED',
  'AMZN', 'NF', 'DSNP', 'HMAX', 'ATVP', 'PCOK', 'HULU', 'PMTP', 'iT', 'CRAV', '3D', 'H-?SBS', 'Half-?SBS',
].join('|')})(?=$|[^A-Za-z0-9])`);
// A name in lower case throughout (show.name.s01e01.720p.hdtv.x264-killers) has no capitals to tell tags by.
const STOP_ANY_CASE = new RegExp(STOP.source, 'i');

const LANGUAGES: Record<string, string> = {
  MULTI: 'Multi', MULTIS: 'Multi', ENGLISH: 'English', FRENCH: 'French', TRUEFRENCH: 'French', VFF: 'French', VFQ: 'French', VF2: 'French', VOSTFR: 'French', SUBFRENCH: 'French',
  GERMAN: 'German', ITALIAN: 'Italian', ITA: 'Italian', SPANISH: 'Spanish', CASTELLANO: 'Spanish', LATINO: 'Spanish', DUTCH: 'Dutch', FLEMISH: 'Dutch',
  NORDIC: 'Nordic', SWEDISH: 'Swedish', DANISH: 'Danish', FINNISH: 'Finnish', NORWEGIAN: 'Norwegian', POLISH: 'Polish', PL: 'Polish',
  RUSSIAN: 'Russian', RUS: 'Russian', JAPANESE: 'Japanese', KOREAN: 'Korean', CHINESE: 'Chinese', MANDARIN: 'Chinese', CANTONESE: 'Chinese',
  HINDI: 'Hindi', TAMIL: 'Tamil', TELUGU: 'Telugu', PORTUGUESE: 'Portuguese', CZECH: 'Czech', HUNGARIAN: 'Hungarian', TURKISH: 'Turkish',
  HEBREW: 'Hebrew', THAI: 'Thai', GREEK: 'Greek', ARABIC: 'Arabic', UKRAINIAN: 'Ukrainian', ROMANIAN: 'Romanian', VIETNAMESE: 'Vietnamese',
};
// Scene capitals: every letter upper case but i (MULTi, iTALiAN, NORDiC). A title word (French, German) isn't.
const sceneCase = (token: string) => token.length > 1 && token.replace(/i/g, 'I') === token.toUpperCase() && /[A-Z]/.test(token);
const languageOf = (token: string, anyCase = false) => anyCase || sceneCase(token) ? LANGUAGES[token.toUpperCase()] : undefined;

// Trailing words a title without a year sheds: editions, languages and flags written before the first stop token.
const TITLE_TAIL = /^(?:EXTENDED|UNRATED|THEATRICAL|REMASTERED|IMAX|UNCUT|DC|CUT|EDITION|DIRECTORS?|DIRECTOR'?S|LIMITED|FESTIVAL|STV|READNFO)$/i;

// Re-posters' and indexers' suffixes after the real group (Radarr strips the same ones).
const REPOST = /-(?:Obfuscated|Scrambled|postbot|xpost|AsRequested|AlternativeToRequested|Rakuv\w*|WhiteRev|BUYMORE|NZBGeek|Chamele0n|GEROV|iNC0GNiTO|4P|4Planet|RP|Rakuvfinhel|NZBgeek)$/i;
// Site tags in brackets at the very end ([rarbg], [TGx], [eztv]).
const SITE_TAG = /\s*\[(?:rarbg|rartv|eztv(?:\.re)?|ettv|TGx|EtHD|PublicHD|ion10|N1C|TGx)\]\s*$/i;
// What follows the last dash but isn't a group (WEB-DL, DTS-HD.MA, E01-02).
const NOT_GROUP = /^(?:DL|Rip|DLRip|HD|MA|X|ES|HRA|SBS|OU|TS|TC|CAM|Remux|\d+|\d+[pi]|[xh]26[45]|HEVC|AVC|AV1|WEB|WEBDL|WEBRip|HDTV|BluRay|Ray|DTS|AAC\d*|AC3|EAC3|DDP?\d*|FLAC|Atmos|HDR\d*\+?|DV|S\d+(?:E\d+)*|E\d+|Complete|PROPER|REPACK|INTERNAL|Subs?|Dubbed)$/i;
// Groups whose name holds a dash.
const DASHED_GROUPS = ['D-Z0N3', 'E-Mudded', 'Tigole-QxR'];
const EXTENSION = /\.(?:mkv|mp4|m4v|avi|wmv|mov|nzb|torrent)$/i;
const WEBSITE = /^\s*(?:\[\s*)?(?:www\.)[^\s\]]+\s*\]?\s*[-–]?\s*/i;

type Token = { text: string; at: number };
const tokens = (text: string): Token[] =>
  [...text.matchAll(/[^\s._[\](){}]+/g)].filter(m => /[^-]/.test(m[0])).map(m => ({ text: m[0], at: m.index }));

function splitGroup(body: string, stop: RegExp): { body: string; group?: string } {
  const yts = /[[(]\s*(YTS(?:\.[A-Z]{2,3})?|YIFY)\s*[\])]\s*$/i.exec(body) ?? /-(YTS\.[A-Z]{2,3})$/i.exec(body);
  if (yts) return { body: body.slice(0, yts.index).replace(/[\s-]+$/, ''), group: yts[1]!.toUpperCase().startsWith('YIFY') ? 'YIFY' : yts[1] };
  for (const group of DASHED_GROUPS) if (body.toLowerCase().endsWith(`-${group.toLowerCase()}`)) return { body: body.slice(0, -group.length - 1), group };
  const m = /-([^\s.\-[\](){}]+)\]?$/.exec(body);
  if (!m || NOT_GROUP.test(m[1]!)) return { body };
  // A group follows the tags: a name with no tag before its last dash (Spider-Man) has no group.
  const before = body.slice(0, m.index);
  if (!tokens(before).some(t => stop.test(before.slice(t.at)))) return { body };
  return { body: before, group: m[1]! };
}

// A year that can be a release year: 1900 to next year.
const yearOf = (token: string, thisYear: number) => {
  if (!/^(?:19|20)\d{2}$/.test(token)) return undefined;
  const year = Number(token);
  return year <= thisYear + 1 ? year : undefined;
};

const RESOLUTION = new RegExp(`${A}(2160|1080|720|576|480)[pi]${Z}`, 'i');
const SOURCES: [Source, RegExp][] = [
  ['SCREENER', tag('SCR|SCREENER|DVD-?SCR|BD-?SCR|WEB-?SCR')],
  ['CAM', tag('(?:HD-?)?CAM(?:-?Rip)?|NEWCAM')],
  ['TELESYNC', tag('(?:HD-?)?TS(?:-?Rip)?|TELESYNC|PDVD|PreDVD')],
  ['TELECINE', tag('(?:HD-?)?TC|TELECINE')],
  ['BluRay', tag('Blu-?Ray|BDRip|BRRip|BD-?Remux|BD25|BD50|UHD[ ._-]?BluRay')],
  ['WEBRip', tag('WEB-?Rip|WEB-?DL-?Rip')],
  ['WEBDL', tag('WEB-?DL|WEB|WEB-?HD')],
  ['HDTV', tag('HDTV(?:-?Rip)?|PDTV|SDTV|TVRip|DSR(?:ip)?')],
  ['DVD', tag('DVD(?:-?Rip|-?R|5|9)?|NTSC|PAL')],
];
const REMUX = tag('Remux');
const STREAMING = tag('AMZN|NF|DSNP|HMAX|ATVP|PCOK|HULU|PMTP|iT|CRAV|STAN', '');
// The service names, in capitals as the scene writes them. MA is Movies Anywhere, not DTS-HD MA.
const SERVICES: [string, RegExp][] = ['AMZN', 'NF', 'DSNP', 'ATVP', 'HMAX', 'MAX', 'PCOK', 'HULU', 'PMTP', 'iT', 'CRAV', 'STAN']
  .map(name => [name, tag(name, '')] as [string, RegExp]).concat([['MA', new RegExp(`(?<!HD[ ._-]?)${A}MA${Z}`)]]);
const CODECS: [VideoCodec, RegExp, ('x264' | 'x265')?][] = [
  ['h265', tag('x265'), 'x265'], ['h265', tag('h[ .]?265|HEVC')],
  ['h264', tag('x264'), 'x264'], ['h264', tag('h[ .]?264|AVC')],
  ['av1', tag('AV1')], ['xvid', tag('XviD|DivX')],
];
const HDRS: [Hdr, RegExp][] = [
  ['DV', tag('DV|DoVi|Dolby[ ._-]?Vision')],
  ['HDR10+', new RegExp(`${A}HDR10(?:\\+|Plus|P${Z})`, 'i')],
  ['HDR10', new RegExp(`${A}HDR10(?!\\+|Plus|P${Z})${Z}`, 'i')],
  ['HDR', tag('HDR')],
  ['HLG', tag('HLG')],
];
const AUDIO: [AudioCodec, RegExp][] = [
  ['TrueHD', audioTag('True-?HD')],
  ['DTS-X', audioTag('DTS[ ._-]?X')],
  ['DTS-HD MA', audioTag('DTS[ ._-]?HD[ ._-]?MA|DTS-?MA')],
  ['DTS-HD', audioTag('DTS[ ._-]?HD(?:[ ._-]?HRA)?|DTS-?HRA')],
  ['DTS', audioTag('DTS(?:[ ._-]?ES)?')],
  ['EAC3', audioTag('E-?AC-?3|DDPA|DDP|DD\\+')],
  ['AC3', audioTag('AC-?3|DD(?![+P])')],
  ['AAC', audioTag('AAC(?:-?LC)?')],
  ['FLAC', audioTag('FLAC')],
  ['Opus', audioTag('Opus')],
  ['MP3', audioTag('MP3')],
  ['PCM', audioTag('L?PCM')],
];
const ATMOS = new RegExp(`${A}(?:Atmos|DDPA)(?![A-Za-z])`, 'i');
const CHANNELS_AFTER = /^[ ._-]?(?:Atmos[ ._-]?)?([1-8])[ ._]([01])(?!\d)/i;
const CHANNELS = /(?<=^|[ ._\-[(])([1-8])[ ._]([01])(?=$|[ ._\-\])])/;
const EDITIONS: [Edition, RegExp][] = [
  ["Director's Cut", new RegExp(`${A}(?:Directors?'?s?[ ._-]?Cut|DC${Z})`, 'i')],
  ['Extended', tag('Extended(?:[ ._-]?(?:Cut|Edition|Version))?')],
  ['Theatrical', tag('Theatrical(?:[ ._-]?(?:Cut|Edition|Version))?')],
  ['Unrated', tag('Unrated(?:[ ._-]?(?:Cut|Edition))?')],
  ['IMAX', tag('IMAX(?:[ ._-]?Enhanced)?')],
  ['Remastered', tag('(?:4K[ ._-]?)?Remaster(?:ed)?')],
];
const HARDCODED = tag('HC|HC-?SUBS?|HARDSUBS?|HARDCODED|KORSUBS?|KOR-?SUB');
const THREE_D = tag('3D|H-?SBS|Half-?SBS|H-?OU|Half-?OU');

// Episodes and seasons. Tried in this order: single and multi-episode, 1x02, multi-season packs, season packs.
const EPISODES = new RegExp(`${A}S(\\d{1,2})[ ._]?E(\\d{1,3})((?:(?:-?E|-)\\d{1,3}(?![\\dpi]))*)${Z}`, 'i');
const CROSS = new RegExp(`${A}(\\d{1,2})x(\\d{2,3})${Z}`, 'i');
const MULTI_SEASON = [
  new RegExp(`${A}S(\\d{1,2})[ ._]?-[ ._]?S?(\\d{1,2})${Z}`, 'i'),
  new RegExp(`${A}S(\\d{1,2})[ ._]?S(\\d{1,2})${Z}`, 'i'),
  new RegExp(`${A}Seasons?[ ._-]?(\\d{1,2})[ ._-]?(?:-|to|&|and)[ ._-]?(?:Seasons?[ ._-]?)?(\\d{1,2})${Z}`, 'i'),
  new RegExp(`${A}Seasons${Z}`, 'i'),
  new RegExp(`${A}Complete[ ._-]?(?:Series|Box[ ._-]?Set)${Z}`, 'i'),
];
const PACK = [new RegExp(`${A}S(\\d{1,2})${Z}`, 'i'), new RegExp(`${A}Season[ ._-]?(\\d{1,2})${Z}`, 'i')];

function episodesOf(rest: string): Pick<ParsedRelease, 'season' | 'episodes' | 'seasonPack' | 'multiSeason'> {
  const single = EPISODES.exec(rest);
  if (single) {
    const episodes = [Number(single[2])];
    for (const part of single[3]!.matchAll(/(-?)(E?)(\d{1,3})/gi)) {
      const n = Number(part[3]), last = episodes[episodes.length - 1]!;
      // A dash makes a range (E01-E03, E01-03); a bare E adds one (E01E02).
      if (part[1] && n > last && n - last <= 50) for (let e = last + 1; e <= n; e++) episodes.push(e);
      else if (!episodes.includes(n)) episodes.push(n);
    }
    return { season: Number(single[1]), episodes, seasonPack: false, multiSeason: false };
  }
  const cross = CROSS.exec(rest);
  if (cross) return { season: Number(cross[1]), episodes: [Number(cross[2])], seasonPack: false, multiSeason: false };
  for (const re of MULTI_SEASON) {
    const m = re.exec(rest);
    if (m && (m[2] === undefined || Number(m[2]) !== Number(m[1]))) return { episodes: [], seasonPack: false, multiSeason: true };
  }
  for (const re of PACK) {
    const m = re.exec(rest);
    if (m) return { season: Number(m[1]), episodes: [], seasonPack: true, multiSeason: false };
  }
  return { episodes: [], seasonPack: false, multiSeason: false };
}

const looksObfuscated = (title: string) => {
  const t = title.replace(/\s+/g, '');
  return !/\s/.test(title.trim()) && t.length >= 16 && /\d/.test(t) && /[a-z]/i.test(t) && /^[a-z0-9]+$/i.test(t);
};

const first = <T>(list: [T, RegExp][], text: string) => list.find(([, re]) => re.test(text))?.[0];

// `thisYear` bounds what counts as a year (a title like "Blade Runner 2049" keeps its number).
export function parseRelease(raw: string, thisYear = new Date().getUTCFullYear()): ParsedRelease {
  const name = raw.trim();
  let body = name.replace(EXTENSION, '').replace(WEBSITE, '');
  for (let previous = ''; previous !== body;) { previous = body; body = body.replace(SITE_TAG, '').replace(REPOST, ''); }
  const lower = !/[A-Z]/.test(body), stopAt = lower ? STOP_ANY_CASE : STOP;
  const split = splitGroup(body.trim(), stopAt);
  body = split.body;
  const list = tokens(body);

  let stop = list.findIndex(t => stopAt.test(body.slice(t.at)));
  if (stop === -1) stop = list.length;
  let year: number | undefined, titleEnd = stop, restFrom = stop;
  for (let i = stop - 1; i >= 1; i--) {
    const y = yearOf(list[i]!.text, thisYear);
    if (y !== undefined) { year = y; titleEnd = i; restFrom = i + 1; break; }
  }
  if (year === undefined) {
    while (titleEnd > 1 && (TITLE_TAIL.test(list[titleEnd - 1]!.text) || languageOf(list[titleEnd - 1]!.text, lower))) titleEnd--;
    restFrom = titleEnd;
  }
  let title = list.slice(0, titleEnd).map(t => t.text).join(' ').replace(/\s+-\s+/g, ' ').replace(/\s+-$/, '').trim();
  const rest = restFrom < list.length ? body.slice(list[restFrom]!.at) : '';
  const obfuscated = (stop === list.length && year === undefined && looksObfuscated(title)) || (!title && !rest);
  if (obfuscated) title = '';

  const codec = CODECS.find(([, re]) => re.test(rest));
  const audioMatch = AUDIO.map(([codec, re]) => ({ codec, m: re.exec(rest) })).find(a => a.m);
  let channels: string | undefined;
  if (audioMatch?.m) {
    const after = CHANNELS_AFTER.exec(rest.slice(audioMatch.m.index + audioMatch.m[0].length));
    if (after) channels = `${after[1]}.${after[2]}`;
  }
  if (!channels) { const m = CHANNELS.exec(rest); if (m) channels = `${m[1]}.${m[2]}`; }
  const resolution = RESOLUTION.exec(rest)?.[1] ?? (tag('4K|UHD|2160').test(rest) ? '2160' : undefined);
  const remux = REMUX.test(rest);
  let source = first(SOURCES, rest);
  if (!source && remux) source = 'BluRay';
  if (!source && STREAMING.test(rest)) source = 'WEBDL';
  const service = SERVICES.find(([, re]) => re.test(rest));
  const languages = [...new Set(tokens(rest.replace(/-/g, ' ')).map(t => languageOf(t.text, lower)).filter((l): l is string => !!l))];
  const tmdb = /\{tmdb-(\d+)\}|tmdbid[-=](\d+)/i.exec(name), imdb = /(?<![a-z0-9])(tt\d{7,9})(?!\d)/i.exec(name);

  return {
    name, title, ...(year !== undefined ? { year } : {}),
    ...episodesOf(rest),
    ...(resolution ? { resolution: Number(resolution) as Resolution } : {}),
    ...(source ? { source } : {}), remux,
    ...(codec ? { codec: codec[0], ...(codec[2] ? { encoder: codec[2] } : {}) } : {}),
    hdr: HDRS.filter(([, re]) => re.test(rest)).map(([h]) => h),
    audio: { ...(audioMatch ? { codec: audioMatch.codec } : {}), atmos: ATMOS.test(rest), ...(channels ? { channels } : {}) },
    ...(service ? { service: service[0] } : {}),
    proper: tag('PROPER').test(rest), repack: tag('REPACK\\d?|RERIP\\d?').test(rest), real: tag('REAL', '').test(rest),
    hardcodedSubs: HARDCODED.test(rest),
    editions: EDITIONS.filter(([, re]) => re.test(rest)).map(([e]) => e),
    ...(split.group ? { group: split.group } : {}),
    languages, threeD: THREE_D.test(rest), obfuscated,
    ids: { ...(tmdb ? { tmdb: Number(tmdb[1] ?? tmdb[2]) } : {}), ...(imdb ? { imdb: imdb[1]!.toLowerCase() } : {}) },
  };
}

// ---- Matching a release to a title ----

const SMALL_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of']);
const FOLD: Record<string, string> = { 'ß': 'ss', 'æ': 'ae', 'ø': 'o', 'œ': 'oe', 'đ': 'd', 'ł': 'l', 'þ': 'th', 'ð': 'd' };

// Case, punctuation, & and "and", and diacritics don't count; nor do a, an, the, and, or, of after the first word.
export function normaliseTitle(title: string) {
  const words = title.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[ßæøœđłþð]/g, c => FOLD[c] ?? c)
    .replace(/&/g, ' and ').replace(/['’‘`´]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
  return words.filter((w, i) => i === 0 || !SMALL_WORDS.has(w)).join('');
}

// IMDb ids compare by number: NZBGeek sends 0111161, TMDB tt0111161.
export const imdbNumber = (id: string | number | undefined) => {
  if (id === undefined || id === '') return undefined;
  const n = Number(String(id).replace(/^tt/i, ''));
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

export type Match = { ok: boolean; reason: string };
export type MovieTitle = { title: string; year?: number; aliases?: readonly string[]; imdbId?: string };
export type ShowTitle = { title: string; year?: number; aliases?: readonly string[]; tvdbId?: number };
// What an indexer says the release is (NZBGeek's imdb and tvdbid attributes). When present it settles the match.
export type ReleaseIds = { imdb?: string | number; tvdbid?: string | number };

const withoutYear = (title: string) => title.replace(/\s*\(\d{4}\)\s*$/, '');

function namesMatch(parsed: ParsedRelease, titles: string[]): 'title' | 'title+year' | undefined {
  const wanted = new Set(titles.flatMap(t => [normaliseTitle(t), normaliseTitle(withoutYear(t))]).filter(Boolean));
  if (wanted.has(normaliseTitle(parsed.title))) return 'title';
  // A number that is part of the title (Wonder Woman 1984) was read as the year.
  if (parsed.year !== undefined && wanted.has(normaliseTitle(`${parsed.title} ${parsed.year}`))) return 'title+year';
  return undefined;
}

// A movie: the title or a TMDB alias, plus the year ±1 when the name carries one. An imdb attribute settles it.
export function matchMovie(parsed: ParsedRelease, movie: MovieTitle, ids: ReleaseIds = {}): Match {
  const theirs = imdbNumber(ids.imdb), ours = imdbNumber(movie.imdbId);
  if (theirs !== undefined && ours !== undefined) {
    return theirs === ours ? { ok: true, reason: 'IMDb id matches' }
      : { ok: false, reason: `IMDb id tt${String(theirs).padStart(7, '0')} isn't ${movie.imdbId}` };
  }
  if (!parsed.title) return { ok: false, reason: 'the name is obfuscated' };
  const how = namesMatch(parsed, [movie.title, ...(movie.aliases ?? [])]);
  if (!how) return { ok: false, reason: `title “${parsed.title}” isn't “${movie.title}”` };
  if (how === 'title' && parsed.year !== undefined && movie.year !== undefined && Math.abs(parsed.year - movie.year) > 1)
    return { ok: false, reason: `year ${parsed.year} isn't ${movie.year} ±1` };
  return { ok: true, reason: 'title matches' };
}

// A show: the title or an alias (season and episode are the pick rules' to check). A tvdbid attribute settles it.
export function matchShow(parsed: ParsedRelease, show: ShowTitle, ids: ReleaseIds = {}): Match {
  const theirs = ids.tvdbid === undefined || ids.tvdbid === '' ? undefined : Number(ids.tvdbid);
  if (theirs !== undefined && Number.isInteger(theirs) && theirs > 0 && show.tvdbId !== undefined)
    return theirs === show.tvdbId ? { ok: true, reason: 'TVDB id matches' } : { ok: false, reason: `TVDB id ${theirs} isn't ${show.tvdbId}` };
  if (!parsed.title) return { ok: false, reason: 'the name is obfuscated' };
  const titles = [show.title, ...(show.aliases ?? [])];
  if (show.year !== undefined) titles.push(`${withoutYear(show.title)} ${show.year}`);
  return namesMatch(parsed, titles) ? { ok: true, reason: 'title matches' } : { ok: false, reason: `title “${parsed.title}” isn't “${show.title}”` };
}
