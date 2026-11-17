import type { ParsedRelease } from './release-name.js';
import type { Quality } from './quality.js';

// Formats (docs/PROFILES.md, "The model"): named tests on a release, defined once and scored by each profile. Pure.
//
// A format matches when every required condition holds and, if it has others, at least one of them does. A negated condition holds when its test fails. A format with no conditions matches nothing.

export const FORMAT_FIELDS = ['quality', 'resolution', 'source', 'remux', 'codec', 'hdr', 'audio', 'atmos', 'service', 'group', 'edition', 'language', 'flag', 'title'] as const;
export type FormatField = typeof FORMAT_FIELDS[number];
// Fields that are true or false; their values are ignored.
export const BOOLEAN_FIELDS: ReadonlySet<FormatField> = new Set(['remux', 'atmos']);
export const FLAGS = ['proper', 'repack', 'real', 'freeleech', 'hardcoded', '3d', 'seasonpack', 'multiseason', 'obfuscated'] as const;
export const FORMAT_CATEGORIES = ['Quality', 'Service', 'Audio', 'HDR', 'Codec', 'Groups', 'Edition', 'Unwanted', 'Other'] as const;
export type FormatCategory = typeof FORMAT_CATEGORIES[number];

// `values`: the condition holds when the release has any of them. `title` values are regular expressions on the name.
export type Condition = { field: FormatField; values: string[]; required?: boolean; negate?: boolean };
// `label` fills {[Custom Formats]} in file names whenever the format matches, whatever a profile scores it.
export type Format = { name: string; label?: string; category: FormatCategory; conditions: Condition[] };

// What a format is tested against: the parse, the rung the pick gave it, and what the indexer said (freeleech).
export type Scored = { parsed: ParsedRelease; quality?: Quality; freeleech?: boolean };

// A profile's points for a format, or 'ban' to reject what it matches. A format a profile doesn't list counts for nothing.
export type Points = number | 'ban';
export type FormatScores = Readonly<Record<string, Points>>;

const CODECS: Record<string, string> = { x264: 'h264', h264: 'h264', avc: 'h264', x265: 'h265', h265: 'h265', hevc: 'h265', av1: 'av1', xvid: 'xvid', divx: 'xvid' };
// Audio names a condition may use for several codecs.
const AUDIO_SETS: Record<string, string[]> = { lossless: ['truehd', 'dtsx', 'dtshdma', 'flac', 'pcm'], ddplus: ['eac3'], ddp: ['eac3'], dd: ['ac3'] };
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9+]/g, '');

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

// One value against the release.
function has(field: FormatField, raw: string, { parsed, quality, freeleech }: Scored): boolean {
  const v = norm(raw);
  switch (field) {
    case 'quality': return !!quality && norm(quality) === v;
    case 'resolution': return parsed.resolution !== undefined && (v === `${parsed.resolution}p` || v === String(parsed.resolution));
    case 'source': return !!parsed.source && norm(parsed.source) === v;
    case 'codec': return !!parsed.codec && (CODECS[v] ?? v) === parsed.codec;
    case 'hdr': return v === 'sdr' ? parsed.hdr.length === 0 : parsed.hdr.some(h => norm(h) === v);
    case 'audio': { const codec = parsed.audio.codec && norm(parsed.audio.codec); return !!codec && (AUDIO_SETS[v] ?? [v]).includes(codec); }
    case 'service': return !!parsed.service && norm(parsed.service) === v;
    case 'group': return !!parsed.group && norm(parsed.group) === v;
    case 'edition': return parsed.editions.some(e => norm(e) === v || norm(e).startsWith(v));
    case 'language':
      if (v === 'foreign') return parsed.languages.some(l => l !== 'English');
      return parsed.languages.some(l => norm(l) === v);
    case 'flag':
      switch (v) {
        case 'proper': return parsed.proper;
        case 'repack': return parsed.repack;
        case 'real': return parsed.real;
        case 'freeleech': return !!freeleech;
        case 'hardcoded': return parsed.hardcodedSubs;
        case '3d': return parsed.threeD;
        case 'seasonpack': return parsed.seasonPack;
        case 'multiseason': return parsed.multiSeason;
        case 'obfuscated': return parsed.obfuscated;
        default: return false;
      }
    case 'title': return regexOf(raw)?.test(parsed.name) ?? false;
    default: return false;
  }
}

export function conditionHolds(c: Condition, release: Scored): boolean {
  const raw = c.field === 'remux' ? release.parsed.remux
    : c.field === 'atmos' ? release.parsed.audio.atmos
    : c.values.some(value => has(c.field, value, release));
  return c.negate ? !raw : raw;
}

export function formatMatches(format: Pick<Format, 'conditions'>, release: Scored): boolean {
  if (!format.conditions.length) return false;
  const required = format.conditions.filter(c => c.required), others = format.conditions.filter(c => !c.required);
  return required.every(c => conditionHolds(c, release)) && (!others.length || others.some(c => conditionHolds(c, release)));
}

// `parts`: each matching format the profile scores, with what it added (0 for a ban), in format order. `matched` names
// them; `labels` come from every matching format with a label.
export type Score = { score: number; bans: string[]; labels: string[]; matched: string[]; parts: { name: string; points: number; ban: boolean }[] };

export function scoreFormats(release: Scored, formats: readonly Format[], scores: FormatScores): Score {
  const result: Score = { score: 0, bans: [], labels: [], matched: [], parts: [] };
  for (const format of formats) {
    const points = Object.hasOwn(scores, format.name) ? scores[format.name] : undefined;
    if ((points === undefined || points === 0) && !format.label) continue;
    if (!formatMatches(format, release)) continue;
    if (format.label && !result.labels.includes(format.label)) result.labels.push(format.label);
    if (points === undefined || points === 0) continue;
    result.matched.push(format.name);
    if (points === 'ban') { result.bans.push(format.name); result.parts.push({ name: format.name, points: 0, ban: true }); }
    else { result.score += points; result.parts.push({ name: format.name, points, ban: false }); }
  }
  return result;
}
