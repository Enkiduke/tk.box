import { EARLY_COPIES, LADDER, rank, type Profile, type Quality, type ScoreRule } from './quality.js';
import type { Condition, Format, FormatField, FormatScores, Points } from './formats.js';

// Quality profiles v2 (docs/PROFILES.md, "The model"). Pure.
//
// - `tiers`, best first: each is one or more rungs taken as equal, ranked between themselves by score. The first
//   `preferred` tiers meet the cutoff; the rest are fallbacks, taken when nothing better is found and upgraded later.
// - `size`: a tier's smallest and largest file in MB (1024² bytes) a minute of runtime. Early copies have no limits.
// - `scores`: the profile's points for each format, or a ban. `minScore` rejects below it.
// - Score upgrades: a release at the file's tier or better replaces it when it scores at least `upgradeStep` more and
//   the file scores under `upgradeUntil`. With no `upgradeUntil`, score never upgrades (the legacy profiles).

export type Tier = { qualities: Quality[]; size?: [number, number] };
export type QualityProfile = {
  tiers: Tier[]; preferred: number;
  scores: FormatScores; minScore?: number; upgradeUntil?: number; upgradeStep: number;
};

// The runtime a size is worked out from when TMDB has none.
export const DEFAULT_RUNTIME = { movie: 110, show: 45 } as const;
const MB = 1024 ** 2, GB = 1024 ** 3;

// The tier a rung is in, or -1 when the profile doesn't take it.
export const tierOf = (profile: QualityProfile, quality: Quality) => profile.tiers.findIndex(t => t.qualities.includes(quality));
export const isPreferred = (profile: QualityProfile, quality: Quality) => { const t = tierOf(profile, quality); return t >= 0 && t < profile.preferred; };
export const allowsQuality = (profile: QualityProfile, quality: Quality) => tierOf(profile, quality) >= 0;
export const allows2160p = (profile: QualityProfile) => profile.tiers.some(t => t.qualities.some(q => q.endsWith('2160p')));
// The lowest rung that meets the cutoff: a file on a rung the profile doesn't take is judged against it by ladder rank.
export const cutoffRank = (profile: QualityProfile) =>
  Math.min(...profile.tiers.slice(0, profile.preferred).flatMap(t => t.qualities.map(rank)));
// A file meets the cutoff when its rung is in a preferred tier, or, on a rung the profile doesn't take, ranks at or
// above the lowest preferred rung. An early copy never does. Below it, the file is wanted (Wanted's "cutoff").
export function meetsCutoff(profile: QualityProfile, quality: Quality) {
  if (EARLY_COPIES.has(quality)) return false;
  const tier = tierOf(profile, quality);
  return tier >= 0 ? tier < profile.preferred : rank(quality) >= cutoffRank(profile);
}
// The rungs of the preferred tiers, best first, for a line of text ("WEBDL-1080p, Bluray-1080p").
export const preferredText = (profile: QualityProfile) => profile.tiers.slice(0, profile.preferred).flatMap(t => t.qualities).join(', ');

// A tier's size limits in bytes for a runtime in minutes; undefined when the tier has none.
export function sizeLimits(tier: Tier, runtimeMin: number): { min: number; max: number; target: number } | undefined {
  if (!tier.size) return undefined;
  const [min, max] = tier.size;
  return { min: min * MB * runtimeMin, max: max * MB * runtimeMin, target: (min + max) / 2 * MB * runtimeMin };
}

// ---- The legacy profiles and score rules ----
// Until the data moves (docs/PROFILES.md, build step 2) the store keeps phase-1 profiles and score rules. This turns
// them into a v2 profile and formats that pick the same releases: one tier per allowed rung, the cutoff's rung and
// above preferred, the GB range as MB a minute of the default runtime, and no score upgrades.

const LEGACY_FIELD = /^(codec|hdr|edition|group|language|flag|source|resolution):(.+)$/i;
function legacyCondition(pattern: string): Condition {
  const field = LEGACY_FIELD.exec(pattern.trim());
  if (!field) return { field: 'title', values: [pattern], required: true };
  const key = field[1]!.toLowerCase() as FormatField, value = field[2]!.trim();
  if (key === 'source' && value.toLowerCase() === 'remux') return { field: 'remux', values: [], required: true };
  return { field: key, values: [value], required: true };
}

export function fromLegacy(profile: Profile, rules: readonly ScoreRule[], kind: 'movie' | 'show'): { profile: QualityProfile; formats: Format[] } {
  const runtime = DEFAULT_RUNTIME[kind], [minGb, maxGb] = kind === 'movie' ? profile.movieSize : profile.episodeSize;
  const size: [number, number] = [minGb * GB / MB / runtime, maxGb * GB / MB / runtime];
  const allowed = [...LADDER].reverse().filter(q => profile.qualities.some(x => x.name === q && x.allowed));
  const tiers: Tier[] = allowed.map(q => ({ qualities: [q], ...(EARLY_COPIES.has(q) ? {} : { size }) }));
  const preferred = allowed.filter(q => !EARLY_COPIES.has(q) && rank(q) >= rank(profile.cutoff)).length;
  const formats: Format[] = [], scores: Record<string, Points> = {}, names = new Set<string>();
  for (const rule of rules) {
    if (rule.applies !== 'both' && rule.applies !== kind) continue;
    let name = rule.name;
    for (let i = 2; names.has(name); i++) name = `${rule.name} (${i})`;
    names.add(name);
    formats.push({ name, ...(rule.label ? { label: rule.label } : {}), category: rule.ban ? 'Unwanted' : 'Other', conditions: [legacyCondition(rule.pattern)] });
    scores[name] = rule.ban ? 'ban' : rule.points;
  }
  return { profile: { tiers, preferred: Math.max(preferred, 1), scores, upgradeStep: 1 }, formats };
}
