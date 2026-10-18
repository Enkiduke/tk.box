// Channel stacks: several provider feeds of one station ("US: CNN FHD", "US CNN (S)") shown as one
// lineup row with selectable feeds. Stacking is presentation only; each feed keeps its own identity,
// number, favorites, guide mapping and health.
export type Quality = 'FHD' | 'HD' | '4K' | 'SD';
const QUALITY: [RegExp, Quality][] = [[/\b(fhd|1080[pi]?)\b/i, 'FHD'], [/\b(uhd|4k|2160p?)\b/i, '4K'], [/\b(hd|720p?)\b/i, 'HD'], [/\b(sd|480[pi]?|576[pi]?)\b/i, 'SD']];
// FHD and HD lead. 4K follows them because it is not transcoded and plays only on capable clients.
const RANK: Record<Quality | 'unknown', number> = { FHD: 4, HD: 3, '4K': 2, unknown: 1, SD: 0 };

export function quality(name: string): Quality | undefined { return QUALITY.find(([pattern]) => pattern.test(name))?.[1]; }
export const isBackup = (name: string) => /\b(backup|alt|alternate)\b/i.test(name);
export function stackKey(name: string) {
  const text=name.normalize('NFKC').toLowerCase(),prefix=text.match(/^\s*([a-z]{2}|usa|gbr|can)\s*[:|]\s*|^\s*(us|usa|uk|gb|ca)\s+/);
  const region=(prefix?.[1]??prefix?.[2]??'').replace(/^usa$/,'us').replace(/^(gb|gbr)$/,'uk').replace(/^can$/,'ca');
  const station=text.slice(prefix?.[0].length??0)
    .replace(/\((?:[ahs]|\d+|backup|alt|alternate)\)/g, ' ')   // Known feed letters, not language/region labels.
    .replace(/\b(fhd|uhd|hd|sd|4k|2160p?|1080[pi]?|720p?|480[pi]?|576[pi]?|hevc|h\.?26[45]|backup|alt|alternate)\b/g, ' ')
    .replace(/\+\s*(\d+)/g,' plus $1 ').replace(/-\s*(\d+)/g,' minus $1 ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return station?(region?`${region}:${station}`:station):'';
}
// Higher sorts first: quality, then primary feeds before backups.
export const feedRank = (name: string) => RANK[quality(name) ?? 'unknown'] * 2 + (isBackup(name) ? 0 : 1);
