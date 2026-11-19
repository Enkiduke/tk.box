// Conversion choices, Plex's ladder from 20 Mbps down to 480p. Each caps output height and video bitrate.
export const qualityTiers = [
  { id: '1080p-20', label: '1080p HD (High)', height: 1080, bitrateKbps: 20000 },
  { id: '1080p-12', label: '1080p HD (Medium)', height: 1080, bitrateKbps: 12000 },
  { id: '1080p-10', label: '1080p HD', height: 1080, bitrateKbps: 10000 },
  { id: '1080p-8', label: '1080p HD', height: 1080, bitrateKbps: 8000 },
  { id: '720p-4', label: '720p HD (High)', height: 720, bitrateKbps: 4000 },
  { id: '720p-3', label: '720p HD (Medium)', height: 720, bitrateKbps: 3000 },
  { id: '720p-2', label: '720p HD', height: 720, bitrateKbps: 2000 },
  { id: '480p-1.5', label: '480p', height: 480, bitrateKbps: 1500 }
] as const;
export type QualityTier = typeof qualityTiers[number];
export const qualityIds = ['auto', 'original', ...qualityTiers.map(t => t.id)] as const;
export type Quality = typeof qualityIds[number];

// Languages a viewer can prefer for audio and subtitles, by ISO 639-2/T code. Plex tags tracks with
// three-letter codes in either the /T or /B form, so both (and two-letter tags) compare through `languageKey`.
export const preferredLanguages = [
  ['eng', 'English'], ['spa', 'Spanish'], ['fra', 'French'], ['deu', 'German'], ['ita', 'Italian'], ['por', 'Portuguese'],
  ['nld', 'Dutch'], ['swe', 'Swedish'], ['nor', 'Norwegian'], ['dan', 'Danish'], ['fin', 'Finnish'], ['pol', 'Polish'],
  ['ces', 'Czech'], ['hun', 'Hungarian'], ['ron', 'Romanian'], ['ell', 'Greek'], ['tur', 'Turkish'], ['rus', 'Russian'],
  ['ukr', 'Ukrainian'], ['heb', 'Hebrew'], ['ara', 'Arabic'], ['hin', 'Hindi'], ['tha', 'Thai'], ['vie', 'Vietnamese'],
  ['ind', 'Indonesian'], ['msa', 'Malay'], ['zho', 'Chinese'], ['jpn', 'Japanese'], ['kor', 'Korean']
] as const;
const languageAliases: Record<string, string> = {
  fre: 'fra', ger: 'deu', dut: 'nld', cze: 'ces', rum: 'ron', gre: 'ell', chi: 'zho', may: 'msa', nob: 'nor', nno: 'nor',
  en: 'eng', es: 'spa', fr: 'fra', de: 'deu', it: 'ita', pt: 'por', nl: 'nld', sv: 'swe', no: 'nor', nb: 'nor', nn: 'nor', da: 'dan',
  fi: 'fin', pl: 'pol', cs: 'ces', hu: 'hun', ro: 'ron', el: 'ell', tr: 'tur', ru: 'rus', uk: 'ukr', he: 'heb', ar: 'ara', hi: 'hin',
  th: 'tha', vi: 'vie', id: 'ind', ms: 'msa', zh: 'zho', ja: 'jpn', ko: 'kor'
};
export const languageKey = (code?: string | null) => {const c = code?.trim().toLowerCase() ?? ''; return languageAliases[c] ?? c;};
