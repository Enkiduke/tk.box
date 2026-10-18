import type { Program } from '../providers/iptv.js';

const FILLER = /^\s*(no (program(me)?s?|programming|information|info|data|listings?|epg)( available)?|to be (announced|determined)|tba|tbd|off ?air|sign ?off|close ?down|channel off ?air)\s*\.?\s*$/i;
const text = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

// Compare the entire current/upcoming window, not just a few coincidentally shared shows.
// Expired guides, placeholders and a single repeated generic listing are not evidence.
export function scheduleSignature(programs: readonly Program[], now: number): string | undefined {
  const slots = programs.filter(p => p.end > now && p.start < now + 48 * 3600000)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (slots.length < 3 || slots.some(p => !p.title.trim() || FILLER.test(p.title) || p.continuous || p.end <= p.start)) return;
  let run = 1, longest = 1;
  for (let i = 1; i < slots.length; i++) {
    if (slots[i]!.start < slots[i - 1]!.end) return;
    run = slots[i]!.start === slots[i - 1]!.end ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  const values = slots.map(p => [p.start, p.end, text(p.title), text(p.subtitle ?? '')]);
  if (longest < 3 || new Set(values.map(p => JSON.stringify(p.slice(2)))).size < 2) return;
  return JSON.stringify(values);
}

type Candidate = { id: string; key: string; automatic: boolean; programs?: readonly Program[] };

// Called separately for each playlist. Move whole name stacks together so untagged backup
// feeds follow their station, but never bridge conflicting guides or explicit manual stacks.
export function scheduleStackKeys(candidates: readonly Candidate[], now: number): Map<string, string> {
  const groups = new Map<string, Candidate[]>(), result = new Map(candidates.map(c => [c.id, c.key]));
  for (const c of candidates) { const group = groups.get(c.key); if (group) group.push(c); else groups.set(c.key, [c]); }
  const signatures = new Map<string, string[]>();
  for (const [key, group] of groups) {
    if (group.some(c => !c.automatic)) continue;
    const guides = group.filter(c => c.programs !== undefined).map(c => scheduleSignature(c.programs!, now));
    if (!guides.length || guides.some(s => !s || s !== guides[0])) continue;
    const signature = guides[0]!, keys = signatures.get(signature);
    if (keys) keys.push(key); else signatures.set(signature, [key]);
  }
  for (const keys of signatures.values()) {
    const canonical = [...keys].sort()[0]!;
    for (const key of keys) for (const c of groups.get(key)!) result.set(c.id, canonical);
  }
  return result;
}
