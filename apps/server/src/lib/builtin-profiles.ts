import type { Condition, Format, Points } from './formats.js';
import type { QualityProfile, Tier } from './profiles.js';
import type { Quality } from './quality.js';
import { BANNED_GROUPS, EFFICIENT_GROUPS, GOOD_WEB_GROUPS, TOP_ENCODERS_GROUPS, TOP_UHD_GROUPS } from './builtin-groups.js';

// The built-in formats and the five profiles (docs/PROFILES.md, "The five profiles"). Seeded by the profiles-v2
// migration; Reset puts a built-in profile back to these. Scores are on a small scale: the tier does the heavy lifting
// (Dictionarry's 280000-point resolution formats), so a score only ranks releases inside a tier and drives upgrades.
// Groups stay under each profile's upgrade step, so a group alone never re-downloads a file.

const req = (field: Condition['field'], ...values: string[]): Condition => ({ field, values, required: true });
const any = (field: Condition['field'], ...values: string[]): Condition => ({ field, values });
const not = (field: Condition['field'], ...values: string[]): Condition => ({ field, values, required: true, negate: true });
const f = (name: string, category: Format['category'], conditions: Condition[], label?: string): Format => ({ name, ...(label ? { label } : {}), category, conditions });

export const BUILTIN_FORMATS: Format[] = [
  // Quality
  f('WEB-DL', 'Quality', [req('source', 'WEBDL')]),
  f('1080p', 'Quality', [req('resolution', '1080p')]),
  // Service
  f('Movies Anywhere', 'Service', [req('service', 'MA')]),
  f('Amazon', 'Service', [req('service', 'AMZN')]),
  f('Disney+', 'Service', [req('service', 'DSNP')]),
  f('Apple TV+', 'Service', [req('service', 'ATVP')]),
  f('Max', 'Service', [any('service', 'HMAX', 'MAX')]),
  f('Netflix', 'Service', [req('service', 'NF')]),
  f('iTunes', 'Service', [req('service', 'iT')]),
  f('Other services', 'Service', [any('service', 'PCOK', 'HULU', 'PMTP', 'CRAV', 'STAN')]),
  // Audio
  f('Lossless audio', 'Audio', [req('audio', 'lossless')]),
  f('Atmos', 'Audio', [req('atmos')]),
  f('DD+', 'Audio', [req('audio', 'EAC3')]),
  f('DD', 'Audio', [req('audio', 'AC3')]),
  f('DTS', 'Audio', [any('audio', 'DTS', 'DTS-HD')]),
  f('AAC', 'Audio', [req('audio', 'AAC')]),
  f('Opus', 'Audio', [req('audio', 'Opus')]),
  // HDR
  f('Dolby Vision', 'HDR', [req('hdr', 'DV')], 'DV'),
  f('HDR10+', 'HDR', [req('hdr', 'HDR10+')]),
  f('HDR10', 'HDR', [any('hdr', 'HDR10', 'HDR')]),
  f('HDR or DV', 'HDR', [any('hdr', 'DV', 'HDR10+', 'HDR10', 'HDR', 'HLG')]),
  f('DV without fallback', 'HDR', [req('hdr', 'DV'), not('hdr', 'HDR10+', 'HDR10', 'HDR')]),
  // Codec
  f('x265', 'Codec', [req('codec', 'x265')]),
  f('AV1', 'Codec', [req('codec', 'AV1')]),
  f('Xvid', 'Codec', [req('codec', 'Xvid')]),
  // Groups
  f('Good WEB-DL groups', 'Groups', [req('source', 'WEBDL'), any('group', ...GOOD_WEB_GROUPS)]),
  f('Top encoders', 'Groups', [req('source', 'BluRay'), not('resolution', '2160p'), any('group', ...TOP_ENCODERS_GROUPS)]),
  f('Top UHD encoders', 'Groups', [req('source', 'BluRay'), req('resolution', '2160p'), any('group', ...TOP_UHD_GROUPS)]),
  f('Efficient encoders', 'Groups', [any('group', ...EFFICIENT_GROUPS)]),
  f('Banned groups', 'Groups', [any('group', ...BANNED_GROUPS)]),
  // Edition
  f('IMAX', 'Edition', [req('edition', 'IMAX')], 'IMAX'),
  // Unwanted
  f('Remux', 'Unwanted', [req('remux')]),
  f('Full disc', 'Unwanted', [req('title', String.raw`\b(BDMV|BD25|BD50|BD66|BD100|COMPLETE[ ._-]+(UHD[ ._-]+)?BLURAY)\b`)]),
  f('Upscaled', 'Unwanted', [req('title', String.raw`\b(upscaled?|AI[ ._-]?upscale)\b`)]),
  f('3D', 'Unwanted', [req('flag', '3d')]),
  f('Hardcoded subs', 'Unwanted', [req('flag', 'hardcoded')]),
  f('Foreign language', 'Unwanted', [req('language', 'foreign')]),
  // Other
  f('Freeleech', 'Other', [req('flag', 'freeleech')]),
];

const SD: Quality[] = ['DVD', 'Bluray-576p', 'Bluray-480p', 'WEBDL-480p', 'WEBRip-480p'];
// Last in every profile; only taken while Early copies is on, and free of size limits.
const EARLY: Quality[] = ['SCREENER', 'TELECINE', 'TELESYNC', 'CAM'];
const tier = (qualities: Quality[], size?: [number, number]): Tier => ({ qualities, ...(size ? { size } : {}) });

// Shared parts of the scores.
const SERVICES: Record<string, Points> = { 'Movies Anywhere': 30, Amazon: 25, 'Disney+': 25, 'Apple TV+': 20, Max: 20, Netflix: 10, iTunes: 10, 'Other services': 5 };
const LOSSY_AUDIO: Record<string, Points> = { 'DD+': 6, Atmos: 4, DD: 4, DTS: 3, AAC: 2 };
const HARD_BANS: Record<string, Points> = { 'Banned groups': 'ban', '3D': 'ban', 'Hardcoded subs': 'ban', 'Foreign language': 'ban' };
const BANS: Record<string, Points> = { ...HARD_BANS, Remux: 'ban', 'Full disc': 'ban', Upscaled: 'ban', AV1: 'ban', Xvid: 'ban' };

export type BuiltIn = 'standard' | 'quality' | 'best' | 'lite' | 'any';
export const BUILTIN_PROFILES: { key: BuiltIn; name: string; profile: QualityProfile }[] = [
  // 1080p Balanced: clean SDR 1080p WEB-DLs, ranked by service, then audio and group. ~4–8 GB a movie.
  { key: 'standard', name: 'Standard', profile: {
    tiers: [
      tier(['WEBDL-1080p'], [15, 130]),
      tier(['Bluray-1080p'], [20, 160]),
      tier(['WEBRip-1080p', 'WEBDL-720p', 'Bluray-720p'], [8, 80]),
      tier(['WEBRip-720p', 'HDTV-1080p', 'HDTV-720p'], [6, 70]),
      tier(SD, [2, 40]),
      tier(EARLY),
    ],
    preferred: 2,
    scores: { ...SERVICES, ...LOSSY_AUDIO, 'Good WEB-DL groups': 5, Freeleech: 2, IMAX: 3, ...BANS, x265: 'ban', 'HDR or DV': 'ban' },
    upgradeUntil: 40, upgradeStep: 15,
  } },
  // 1080p Quality: transparent x264 Blu-ray encodes from the best encoders, else a WEB-DL, else any Blu-ray. ~10–15 GB.
  { key: 'quality', name: 'Quality', profile: {
    tiers: [
      tier(['Bluray-1080p', 'WEBDL-1080p'], [20, 220]),
      tier(['WEBRip-1080p', 'WEBDL-720p', 'Bluray-720p'], [8, 100]),
      tier(['WEBRip-720p', 'HDTV-1080p', 'HDTV-720p'], [6, 70]),
      tier(SD, [2, 40]),
      tier(EARLY),
    ],
    preferred: 1,
    scores: { 'Top encoders': 80, 'WEB-DL': 25, ...SERVICES, ...LOSSY_AUDIO, 'Lossless audio': 6, 'Good WEB-DL groups': 5, Freeleech: 2, IMAX: 3,
      ...BANS, x265: 'ban', 'HDR or DV': 'ban' },
    upgradeUntil: 80, upgradeStep: 15,
  } },
  // 2160p: DV/HDR WEB-DLs and the best UHD Blu-ray encodes, falling back to Quality's 1080p. ~15–30 GB.
  { key: 'best', name: 'Best', profile: {
    tiers: [
      tier(['WEBDL-2160p', 'Bluray-2160p'], [60, 450]),
      tier(['Bluray-1080p', 'WEBDL-1080p'], [20, 220]),
      tier(['WEBRip-2160p', 'WEBRip-1080p', 'WEBDL-720p', 'Bluray-720p'], [8, 300]),
      tier(SD, [2, 40]),
      tier(EARLY),
    ],
    preferred: 1,
    scores: { 'Top UHD encoders': 60, 'Top encoders': 40, 'Dolby Vision': 20, 'HDR10+': 15, HDR10: 10, ...SERVICES, 'Movies Anywhere': 30, iTunes: 25,
      'Lossless audio': 10, Atmos: 8, 'DD+': 5, DD: 3, DTS: 3, 'Good WEB-DL groups': 5, Freeleech: 2, IMAX: 5, ...BANS, 'DV without fallback': 'ban' },
    upgradeUntil: 80, upgradeStep: 15,
  } },
  // 720p/1080p High Efficiency: small x265 encodes from efficient groups; lossless audio and HDR banned. ~1.5–4 GB.
  { key: 'lite', name: 'Lite', profile: {
    tiers: [
      tier(['WEBDL-1080p', 'WEBRip-1080p', 'Bluray-1080p', 'HDTV-1080p', 'WEBDL-720p', 'WEBRip-720p', 'Bluray-720p', 'HDTV-720p'], [4, 45]),
      tier([...SD, 'SDTV'], [2, 25]),
      tier(EARLY),
    ],
    preferred: 1,
    scores: { 'Efficient encoders': 40, x265: 30, '1080p': 10, Opus: 6, AAC: 5, 'DD+': 3, DD: 2, DTS: -5, Atmos: -3, Freeleech: 2,
      ...BANS, 'Lossless audio': 'ban', 'HDR or DV': 'ban' },
    upgradeUntil: 70, upgradeStep: 20,
  } },
  // Anything at all, for titles nothing else finds: SD TV and names with no quality too. No size limits.
  { key: 'any', name: 'Any', profile: {
    tiers: [
      tier(['WEBDL-1080p', 'Bluray-1080p', 'WEBRip-1080p']),
      tier(['WEBDL-720p', 'Bluray-720p', 'WEBRip-720p', 'HDTV-1080p', 'HDTV-720p']),
      tier([...SD, 'SDTV']),
      tier(['Unknown']),
      tier(EARLY),
    ],
    preferred: 1,
    scores: { ...SERVICES, ...LOSSY_AUDIO, 'Good WEB-DL groups': 5, Freeleech: 2, ...HARD_BANS },
    upgradeUntil: 40, upgradeStep: 15,
  } },
];

export const builtInProfile = (key: string) => BUILTIN_PROFILES.find(p => p.key === key);
