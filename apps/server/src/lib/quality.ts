import type { ParsedRelease } from './release-name.js';

// The quality ladder, lowest first (docs/ARR-REPLACEMENT.md, "Quality ladder"). Its order is fixed; profiles only say
// which rungs are allowed and where the cutoff is. The names match Radarr's {Quality Full}.
export const LADDER = [
  'CAM', 'TELESYNC', 'TELECINE', 'SCREENER', 'DVD',
  'HDTV-720p', 'WEBRip-720p', 'WEBDL-720p', 'Bluray-720p',
  'HDTV-1080p', 'WEBRip-1080p', 'WEBDL-1080p', 'Bluray-1080p', 'Remux-1080p',
  'HDTV-2160p', 'WEBRip-2160p', 'WEBDL-2160p', 'Bluray-2160p', 'Remux-2160p',
] as const;
export type Quality = typeof LADDER[number];

// The early-copy rungs: allowed only while Early copies is on, and free of the size limits.
export const EARLY_COPIES: ReadonlySet<Quality> = new Set<Quality>(['CAM', 'TELESYNC', 'TELECINE', 'SCREENER']);

export const isQuality = (name: string): name is Quality => (LADDER as readonly string[]).includes(name);
export const rank = (quality: Quality) => LADDER.indexOf(quality);

// The rung a parsed release sits on. Undefined when the name doesn't say enough (a WEB-DL with no resolution, SD TV).
export function qualityOf(parsed: Pick<ParsedRelease, 'source' | 'resolution' | 'remux'>): Quality | undefined {
  const { source, resolution, remux } = parsed;
  if (source === 'CAM' || source === 'TELESYNC' || source === 'TELECINE' || source === 'SCREENER' || source === 'DVD') return source;
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

// pick_profiles.value. Sizes are in GB (1024³ bytes), as Radarr shows them.
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

export const allowed = (profile: Profile, quality: Quality) => profile.qualities.some(q => q.name === quality && q.allowed);
export const allows2160p = (profile: Profile) => profile.qualities.some(q => q.allowed && q.name.endsWith('2160p'));

// ---- Score rules ----

// score_rules rows. A pattern is a regex on the release name, or a parsed field: codec:x264, hdr:DV, edition:IMAX,
// group:FLUX, language:foreign, language:French, flag:hardcoded, flag:freeleech, flag:proper, source:WEBRip,
// resolution:720p.
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

// What a rule is tested against: the parse, plus what the indexer said (IPTorrents' freeleech).
export type Scored = { parsed: ParsedRelease; freeleech?: boolean };

const CODEC_NAMES: Record<string, string> = { x264: 'h264', h264: 'h264', 'h.264': 'h264', avc: 'h264', x265: 'h265', h265: 'h265', 'h.265': 'h265', hevc: 'h265', av1: 'av1', xvid: 'xvid', divx: 'xvid' };
const FIELD = /^(codec|hdr|edition|group|language|flag|source|resolution):(.+)$/i;
const lower = (s: string) => s.toLowerCase().replace(/[^a-z0-9+]/g, '');
const regexCache = new Map<string, RegExp | null>();
function regexOf(pattern: string) {
  if (!regexCache.has(pattern)) {
    let re: RegExp | null = null;
    try { re = new RegExp(pattern, 'i'); } catch { /* an invalid pattern matches nothing */ }
    if (regexCache.size > 500) regexCache.clear();
    regexCache.set(pattern, re);
  }
  return regexCache.get(pattern) ?? null;
}

export function ruleMatches(rule: Pick<ScoreRule, 'pattern'>, { parsed, freeleech }: Scored): boolean {
  const field = FIELD.exec(rule.pattern.trim());
  if (!field) return regexOf(rule.pattern)?.test(parsed.name) ?? false;
  const [, key, raw] = field as unknown as [string, string, string];
  const value = lower(raw);
  switch (key.toLowerCase()) {
    case 'codec': return !!parsed.codec && (CODEC_NAMES[raw.toLowerCase()] ?? value) === parsed.codec;
    case 'hdr': return parsed.hdr.some(h => lower(h) === value);
    case 'edition': return parsed.editions.some(e => lower(e) === value || lower(e).startsWith(value));
    case 'group': return !!parsed.group && lower(parsed.group) === value;
    case 'language': return value === 'foreign' ? parsed.languages.some(l => l !== 'English') : parsed.languages.some(l => lower(l) === value);
    case 'source': return !!parsed.source && (lower(parsed.source) === value || (value === 'remux' && parsed.remux));
    case 'resolution': return parsed.resolution !== undefined && `${parsed.resolution}p` === value;
    case 'flag':
      switch (value) {
        case 'hardcoded': return parsed.hardcodedSubs;
        case 'freeleech': return !!freeleech;
        case 'proper': return parsed.proper;
        case 'repack': return parsed.repack;
        case '3d': return parsed.threeD;
        default: return false;
      }
    default: return false;
  }
}

export type Score = { score: number; bans: string[]; labels: string[]; matched: string[] };
// A release's score is the sum of the rules that match it; a matching ban rule rejects it. Rules with a label fill
// {[Custom Formats]}, in rule order.
export function scoreRelease(release: Scored, rules: readonly ScoreRule[], kind: 'movie' | 'show'): Score {
  const result: Score = { score: 0, bans: [], labels: [], matched: [] };
  for (const rule of rules) {
    if (rule.applies !== 'both' && rule.applies !== kind) continue;
    if (!ruleMatches(rule, release)) continue;
    result.matched.push(rule.name);
    if (rule.ban) result.bans.push(rule.name);
    else result.score += rule.points;
    if (rule.label && !result.labels.includes(rule.label)) result.labels.push(rule.label);
  }
  return result;
}
