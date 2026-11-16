import { qualityFull, type Quality } from './quality.js';
import type { ParsedRelease } from './release-name.js';

// Movie and show folder and file names (docs/ARR-REPLACEMENT.md, "Naming"): the Radarr and Sonarr formats in use,
// reproduced. Movies:
//   Folder: {Movie CleanTitle} ({Release Year}) {tmdb-{TmdbId}}
//   File:   {Movie CleanTitle} {(Release Year)} {tmdb-{TmdbId}} {edition-{Edition Tags}} {[Custom Formats]}{[Quality Full]}
//           {[MediaInfo 3D]}{[MediaInfo VideoDynamicRangeType]}{[Mediainfo AudioCodec}{ Mediainfo AudioChannels]}
//           {[Mediainfo VideoCodec]}{-Release Group}
// Shows:
//   Series folder: {Series TitleYear} {tvdb-{TvdbId}}     Season folder: Season {season:00}
//   File:   {Series TitleYear} - S{season:00}E{episode:00} - {Episode CleanTitle} {[Custom Formats]}{[Quality Full]}
//           {[MediaInfo VideoDynamicRangeType]}{[Mediainfo AudioCodec}{ Mediainfo AudioChannels]}{[MediaInfo VideoCodec]}
//           {-Release Group}
// Optional tokens vanish with their brackets when empty, and double spaces collapse.

export const MOVIES_ROOT = '/srv/media/movies';
export const SHOWS_ROOT = '/srv/media/tv';

// Radarr's {Movie CleanTitle} (FileNameBuilder.CleanTitle), checked against the folders Radarr made: `&` becomes `and`,
// a slash a space (Face/Off stays two words), and Radarr's "scenify" characters go: punctuation standing alone between
// spaces, `'` `:` `?` `,` (and the like) before a space, the end or a contraction (Freddy's → Freddys,
// Avatar: Fire and Ash → Avatar Fire and Ash), and brackets. Accents are removed. Then the file-name pass: a colon still
// left (10:30) is replaced the "smart" way (`-`), characters not allowed in file names go, and spaces collapse.
const SCENIFY_REMOVE = /(?<=\s)(,|<|>|\/|\\|;|:|'|"|\||`|’|~|!|\?|@|\$|%|\^|\*|-|_|=)(?=\s)|('|`|’|:|\?|,)(?=(?:(?:s|m|t|ve|ll|d|re)\s)|\s|$)|(\(|\)|\[|\]|\{|\})/gi;
export function cleanTitle(title: string) {
  return fileNameText(title.replace(/&/g, 'and').replace(/[\\/]/g, ' ').replace(SCENIFY_REMOVE, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC'));
}
// The file-name pass alone, for tokens that aren't clean titles ({Edition Tags}, the group): colons the smart way,
// characters not allowed in file names removed (a slash leaves a space), spaces collapsed.
export function fileNameText(text: string) {
  return text.replace(/[\\/]/g, ' ').replace(/\s*:\s*/g, m => /\s/.test(m) ? ' - ' : '-').replace(/[<>"|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ').trim();
}

export type MovieNaming = { title: string; year?: number; tmdbId: number };
// What a file's name says about it, the same for movies and episodes (an episode has no editions).
export type MediaFile = {
  quality: Quality; proper?: boolean; repack?: boolean;
  // Labels of the formats that matched, in order.
  customFormats?: readonly string[];
  // ffprobe facts, already named (see the helpers below).
  dynamicRange?: string; audioCodec?: string; audioChannels?: string; videoCodec?: string;
  group?: string;
};
export type MovieFile = MediaFile & {
  // The parsed editions ("Director's Cut", "IMAX").
  editions?: readonly string[];
};

const optional = (value: string | undefined, wrap: (v: string) => string) => value ? wrap(value) : '';
const tidy = (name: string) => name.replace(/\s{2,}/g, ' ').trim();

// {[Custom Formats]}{[Quality Full]}{[MediaInfo VideoDynamicRangeType]}{[Mediainfo AudioCodec}{ Mediainfo AudioChannels]}
// {[MediaInfo VideoCodec]}{-Release Group}: the tail both formats share ({[MediaInfo 3D]} is always empty: 3D is banned).
function mediaTokens(file: MediaFile) {
  const formats = file.customFormats?.length ? file.customFormats.join(' ') : undefined;
  // One bracket around audio codec and channels; either may be missing.
  const audio = [file.audioCodec, file.audioChannels].filter(Boolean).join(' ') || undefined;
  const group = file.group ? fileNameText(file.group).replace(/\s+/g, '') : undefined;
  return optional(formats, f => `[${f}]`) + `[${qualityFull(file.quality, file)}]`
    + optional(file.dynamicRange, d => `[${d}]`) + optional(audio, a => `[${a}]`) + optional(file.videoCodec, v => `[${v}]`)
    + optional(group, g => `-${g}`);
}
const withExtension = (extension: string) => extension.startsWith('.') ? extension : `.${extension}`;

// The folder format's brackets are outside the year token, so a movie with no year keeps an empty `()`, as Radarr's
// folders do (Slauson Rec () {tmdb-1459346}). In the file name they're inside it ({(Release Year)}) and vanish.
export function movieFolder(movie: MovieNaming) {
  return tidy(`${cleanTitle(movie.title)} (${movie.year ?? ''}) {tmdb-${movie.tmdbId}}`);
}

// Without the extension.
export function movieFileName(movie: MovieNaming, file: MovieFile) {
  const editions = file.editions?.length ? fileNameText(file.editions.join(' ')) : undefined;
  return tidy([
    cleanTitle(movie.title),
    optional(movie.year ? String(movie.year) : undefined, y => `(${y})`),
    `{tmdb-${movie.tmdbId}}`,
    optional(editions, e => `{edition-${e}}`),
    mediaTokens(file),
  ].join(' '));
}

export const moviePath = (movie: MovieNaming, file: MovieFile, extension: string, root = MOVIES_ROOT, folder?: string) =>
  `${root}/${folder ?? movieFolder(movie)}/${movieFileName(movie, file)}${withExtension(extension)}`;

// ---- Shows ----

export type ShowNaming = { title: string; year?: number; tvdbId: number };
export type EpisodeNaming = { season: number; episode: number; title?: string };

// Sonarr's file-name pass as the names it made show (checked against all 236 series and 5874 episode files, 2026-11-15;
// its settings say "Replace Illegal Characters" off): colons and `\ / < > ? * | "` are removed (10:00 A.M. → 1000 A.M,
// Happily Ever After? → Happily Ever After), and spaces collapse. Accents stay, unlike Radarr's.
export function sonarrFileName(text: string) {
  return text.replace(/[:\\/<>?*|"\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim();
}

// Sonarr's {Episode CleanTitle}: Radarr's clean-title rules without removing accents (No Más! stays), then the
// file-name pass; a run of dots becomes one, and dots at either end go (...And the Bags → And the Bags, A.M. → A.M).
// Characters not allowed in file names go first, so an apostrophe they leave at the end goes too (Dyin'? → Dyin).
export function episodeCleanTitle(title: string) {
  return sonarrFileName(sonarrFileName(title.replace(/&/g, 'and').replace(/[\\/]/g, ' ')).replace(SCENIFY_REMOVE, ''))
    .replace(/\.{2,}/g, '.').replace(/^\.+|\.+$/g, '').trim();
}

// {Series TitleYear}: the title with ` (year)`, unless the title already ends with its year in brackets (Sonarr's rule).
export function seriesTitleYear(show: Pick<ShowNaming, 'title' | 'year'>) {
  const title = show.title.trim();
  return sonarrFileName(show.year && !/\(\d{4}\)$/.test(title) ? `${title} (${show.year})` : title);
}
export const seriesFolder = (show: ShowNaming) => tidy(`${seriesTitleYear(show)} {tvdb-${show.tvdbId}}`);
const pad2 = (n: number) => String(n).padStart(2, '0');
export const seasonFolder = (season: number) => `Season ${pad2(season)}`;

// A multi-episode file's clean title: Sonarr drops a trailing part number ("It's Time (1)", "Pilot Part 2") and, when
// every title is then the same, names it once (Its Time); otherwise the clean titles are joined by ` and `
// (Move On and But Im Not).
const PART = /\s*(?:\((?:part\s*)?\d{1,2}\)|part\s*\d{1,2})$/i;
export function episodeTitles(titles: readonly (string | undefined)[]) {
  const named = titles.filter((t): t is string => !!t?.trim());
  if (named.length > 1) {
    const bare = named.map(t => t.replace(PART, '').trim());
    if (bare.every(t => t === bare[0])) return episodeCleanTitle(bare[0]!) || undefined;
  }
  return named.map(episodeCleanTitle).filter(Boolean).join(' and ') || undefined;
}

// Sonarr shortens the episode title so the name (with its extension) stays within 255 bytes, ending it with `...`.
const MAX_NAME_BYTES = 255;
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

// Without the extension. Several episodes make Sonarr's Prefixed Range (S01E01-E03).
export function episodeFileName(show: Pick<ShowNaming, 'title' | 'year'>, episodes: readonly EpisodeNaming[], file: MediaFile, extension = '.mkv') {
  const sorted = [...episodes].sort((a, b) => a.season - b.season || a.episode - b.episode);
  const first = sorted[0], last = sorted[sorted.length - 1];
  if (!first || !last) throw new Error('An episode file needs at least one episode.');
  const numbers = `S${pad2(first.season)}E${pad2(first.episode)}${sorted.length > 1 ? `-E${pad2(last.episode)}` : ''}`;
  const build = (title: string | undefined) => tidy([`${seriesTitleYear(show)} - ${numbers}`, optional(title, t => `- ${t}`), mediaTokens(file)].join(' '));
  const clean = episodeTitles(sorted.map(e => e.title));
  const room = MAX_NAME_BYTES - bytes(withExtension(extension));
  if (!clean || bytes(build(clean)) <= room) return build(clean);
  let cut = clean;
  while (cut && bytes(build(`${cut}...`)) > room) cut = cut.slice(0, -1).trimEnd();
  return build(cut ? `${cut}...` : undefined);
}

export const episodePath = (show: ShowNaming, episodes: readonly EpisodeNaming[], file: MediaFile, extension: string, root = SHOWS_ROOT, folder?: string) =>
  `${root}/${folder ?? seriesFolder(show)}/${seasonFolder(episodes[0]?.season ?? 1)}/${episodeFileName(show, episodes, file, extension)}${withExtension(extension)}`;

// ---- ffprobe facts as the names use them ----

// VideoCodec: x264 or x265 when the release names the encoder, otherwise ffprobe's codec (h264, h265, AV1).
export function videoCodecName(parsed: Pick<ParsedRelease, 'encoder'> | undefined, probeCodec?: string) {
  if (parsed?.encoder) return parsed.encoder;
  switch (probeCodec?.toLowerCase()) {
    case 'h264': case 'avc': return 'h264';
    case 'hevc': case 'h265': return 'h265';
    case 'av1': return 'AV1';
    case 'mpeg4': return 'XviD';
    case undefined: case '': return undefined;
    default: return probeCodec;
  }
}

// AudioCodec from ffprobe's codec_name and profile: EAC3, EAC3 Atmos, TrueHD Atmos, DTS-HD MA, AAC…
export function audioCodecName(codec?: string, profile = '') {
  const atmos = /atmos|joc/i.test(profile) ? ' Atmos' : '';
  switch (codec?.toLowerCase()) {
    case 'eac3': return `EAC3${atmos}`;
    case 'truehd': return `TrueHD${atmos}`;
    case 'ac3': return 'AC3';
    case 'aac': return 'AAC';
    case 'flac': return 'FLAC';
    case 'opus': return 'Opus';
    case 'mp3': return 'MP3';
    case 'dts':
      if (/dts:x|dts-x/i.test(profile)) return 'DTS-X';
      if (/ma/i.test(profile)) return 'DTS-HD MA';
      if (/hra|hd/i.test(profile)) return 'DTS-HD HRA';
      if (/es/i.test(profile)) return 'DTS-ES';
      return 'DTS';
    case undefined: case '': return undefined;
    default: return codec!.toLowerCase().startsWith('pcm') ? 'PCM' : codec!.toUpperCase();
  }
}

// AudioChannels from ffprobe's channel count: 2.0, 5.1, 7.1.
export function audioChannelsName(channels?: number) {
  if (!channels || channels < 1) return undefined;
  return channels >= 6 ? `${channels - 1}.1` : channels === 3 ? '2.1' : `${channels}.0`;
}

// VideoDynamicRangeType from ffprobe's colour transfer and side data: DV, HDR10+, HDR10, HLG, or nothing for SDR.
// DV with an HDR10 base layer is named "DV HDR10", as Radarr does.
export function dynamicRangeName(video: { transfer?: string; dolbyVision?: boolean; hdr10Plus?: boolean }) {
  const pq = video.transfer === 'smpte2084', hlg = video.transfer === 'arib-std-b67';
  const base = video.hdr10Plus ? 'HDR10+' : pq ? 'HDR10' : hlg ? 'HLG' : '';
  return [video.dolbyVision ? 'DV' : '', base].filter(Boolean).join(' ') || undefined;
}
