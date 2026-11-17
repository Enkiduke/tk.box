import type { ParsedRelease } from './release-name.js';

// The quality ladder, lowest first (docs/ARR-REPLACEMENT.md, "Quality ladder"; docs/PROFILES.md). Its order is fixed;
// profiles say which rungs they take and in what order. The names are the library's {Quality Full}. Unknown is a release
// whose name doesn't say its quality; only a profile that lists it takes one.
export const LADDER = [
  'Unknown', 'CAM', 'TELESYNC', 'TELECINE', 'SCREENER',
  'SDTV', 'DVD', 'WEBRip-480p', 'WEBDL-480p', 'Bluray-480p', 'Bluray-576p',
  'HDTV-720p', 'WEBRip-720p', 'WEBDL-720p', 'Bluray-720p',
  'HDTV-1080p', 'WEBRip-1080p', 'WEBDL-1080p', 'Bluray-1080p', 'Remux-1080p',
  'HDTV-2160p', 'WEBRip-2160p', 'WEBDL-2160p', 'Bluray-2160p', 'Remux-2160p',
] as const;
export type Quality = typeof LADDER[number];

// The early-copy rungs: allowed only while Early copies is on, and free of the size limits.
export const EARLY_COPIES: ReadonlySet<Quality> = new Set<Quality>(['CAM', 'TELESYNC', 'TELECINE', 'SCREENER']);

export const isQuality = (name: string): name is Quality => (LADDER as readonly string[]).includes(name);
export const rank = (quality: Quality) => LADDER.indexOf(quality);

// The rung a parsed release sits on. Undefined when the name doesn't say enough (a WEB-DL with no resolution); never
// Unknown, which is the pick's to give. HDTV with no resolution is SD TV; 576p WEB goes on the 480p rungs.
export function qualityOf(parsed: Pick<ParsedRelease, 'source' | 'resolution' | 'remux'>): Quality | undefined {
  const { source, resolution, remux } = parsed;
  if (source === 'CAM' || source === 'TELESYNC' || source === 'TELECINE' || source === 'SCREENER' || source === 'DVD') return source;
  if (source === 'HDTV' && (resolution === undefined || resolution === 480 || resolution === 576)) return 'SDTV';
  if (resolution === 480 || resolution === 576) {
    if (remux) return undefined;
    if (source === 'BluRay') return `Bluray-${resolution}p`;
    if (source === 'WEBDL') return 'WEBDL-480p';
    if (source === 'WEBRip') return 'WEBRip-480p';
    return undefined;
  }
  if (resolution !== 720 && resolution !== 1080 && resolution !== 2160) return undefined;
  if (remux) return resolution === 720 ? undefined : `Remux-${resolution}p`;
  switch (source) {
    case 'HDTV': return `HDTV-${resolution}p`;
    case 'WEBRip': return `WEBRip-${resolution}p`;
    case 'WEBDL': return `WEBDL-${resolution}p`;
    case 'BluRay': return `Bluray-${resolution}p`;
    default: return undefined;
  }
}

// {Quality Full}: the rung, plus " Proper" or " Repack".
export const qualityFull = (quality: Quality, flags: { proper?: boolean; repack?: boolean } = {}) =>
  `${quality}${flags.repack ? ' Repack' : flags.proper ? ' Proper' : ''}`;

// Phase 1's pick_profiles.value and score_rules rows, kept for the migrations that seed and convert them
// (modules/migrations/library.ts) and for fromLegacy. Sizes are in GB (1024³ bytes). A rule's pattern is a field:value
// (codec:x264, hdr:DV, group:FLUX, source:remux…) or a regex on the release name.
export type Profile = {
  qualities: { name: Quality; allowed: boolean }[];
  cutoff: Quality;
  movieSize: [number, number];
  episodeSize: [number, number];
};

// The default "1080p": the 720p and 1080p rungs but Remux, and the early copies (which Early copies gates).
export const DEFAULT_PROFILE_NAME = '1080p';
export const defaultProfile = (): Profile => ({
  qualities: LADDER.map(name => ({ name, allowed: EARLY_COPIES.has(name) || (/-(?:720|1080)p$/.test(name) && !name.startsWith('Remux')) })),
  cutoff: 'WEBDL-1080p',
  movieSize: [2, 20],
  episodeSize: [0.5, 5],
});

export type ScoreRule = { name: string; label?: string; pattern: string; points: number; ban: boolean; applies: 'movie' | 'show' | 'both' };

export const defaultScoreRules = (): ScoreRule[] => [
  { name: 'x264', pattern: 'codec:x264', points: 10, ban: false, applies: 'both' },
  { name: 'Freeleech', pattern: 'flag:freeleech', points: 10, ban: false, applies: 'both' },
  { name: 'Dolby Vision', label: 'DV', pattern: 'hdr:DV', points: 5, ban: false, applies: 'both' },
  { name: 'IMAX', label: 'IMAX', pattern: 'edition:IMAX', points: 5, ban: false, applies: 'both' },
  { name: 'Hardcoded subs', pattern: 'flag:hardcoded', points: 0, ban: true, applies: 'both' },
  { name: 'Foreign language', pattern: 'language:foreign', points: 0, ban: true, applies: 'both' },
  { name: '3D / upscaled', pattern: '\\b(3D|upscaled?|AI.?upscale)\\b', points: 0, ban: true, applies: 'both' },
];
