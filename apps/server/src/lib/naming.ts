import { qualityFull, type Quality } from './quality.js';
import type { ParsedRelease } from './release-name.js';

// Movie folder and file names (docs/ARR-REPLACEMENT.md, "Naming"): the Radarr formats in use, reproduced.
//   Folder: {Movie CleanTitle} ({Release Year}) {tmdb-{TmdbId}}
//   File:   {Movie CleanTitle} {(Release Year)} {tmdb-{TmdbId}} {edition-{Edition Tags}} {[Custom Formats]}{[Quality Full]}
//           {[MediaInfo 3D]}{[MediaInfo VideoDynamicRangeType]}{[Mediainfo AudioCodec}{ Mediainfo AudioChannels]}
//           {[Mediainfo VideoCodec]}{-Release Group}
// Optional tokens vanish with their brackets when empty, and double spaces collapse. Show naming comes with phase 2.

export const MOVIES_ROOT = '/srv/media/movies';

// Clean-title rules: `:` becomes ` -`; characters not allowed in file names go (a slash leaves a space, so Face/Off
// stays two words); spaces collapse.
export function cleanTitle(title: string) {
  return title.replace(/\s*:/g, ' -').replace(/[\\/]/g, ' ').replace(/[<>"|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ').trim();
}

export type MovieNaming = { title: string; year?: number; tmdbId: number };
export type MovieFile = {
  quality: Quality; proper?: boolean; repack?: boolean;
  // The parsed editions ("Director's Cut", "IMAX").
  editions?: readonly string[];
  // Labels of the score rules that matched, in rule order.
  customFormats?: readonly string[];
  // ffprobe facts, already named (see the helpers below).
  dynamicRange?: string; audioCodec?: string; audioChannels?: string; videoCodec?: string;
  group?: string;
};

const optional = (value: string | undefined, wrap: (v: string) => string) => value ? wrap(value) : '';
const tidy = (name: string) => name.replace(/\s{2,}/g, ' ').trim();

export function movieFolder(movie: MovieNaming) {
  return tidy(`${cleanTitle(movie.title)} ${movie.year ? `(${movie.year})` : ''} {tmdb-${movie.tmdbId}}`);
}

// Without the extension.
export function movieFileName(movie: MovieNaming, file: MovieFile) {
  const editions = file.editions?.length ? cleanTitle(file.editions.join(' ')) : undefined;
  const formats = file.customFormats?.length ? file.customFormats.join(' ') : undefined;
  // {[Mediainfo AudioCodec}{ Mediainfo AudioChannels]}: one bracket around both; either may be missing.
  const audio = [file.audioCodec, file.audioChannels].filter(Boolean).join(' ') || undefined;
  const group = file.group ? cleanTitle(file.group).replace(/\s+/g, '') : undefined;
  return tidy([
    cleanTitle(movie.title),
    optional(movie.year ? String(movie.year) : undefined, y => `(${y})`),
    `{tmdb-${movie.tmdbId}}`,
    optional(editions, e => `{edition-${e}}`),
    optional(formats, f => `[${f}]`) + `[${qualityFull(file.quality, file)}]`
      // {[MediaInfo 3D]} is always empty: 3D is banned.
      + optional(file.dynamicRange, d => `[${d}]`) + optional(audio, a => `[${a}]`) + optional(file.videoCodec, v => `[${v}]`)
      + optional(group, g => `-${g}`),
  ].join(' '));
}

export const moviePath = (movie: MovieNaming, file: MovieFile, extension: string, root = MOVIES_ROOT, folder?: string) =>
  `${root}/${folder ?? movieFolder(movie)}/${movieFileName(movie, file)}${extension.startsWith('.') ? extension : `.${extension}`}`;

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
