// When a seeding torrent is removed (docs/ARR-REPLACEMENT.md, "Import and seeding" › Seeding). Pure.
//
// The rule: ratio at least `ratio` and seeded at least `minDays`, or seeded `maxDays`, whichever comes first (settings,
// default 2, 14 and 28). Apart from the settings, IPTorrents' minimum is enforced here and can't be lowered: a torrent is
// never removed before it has seeded 14 days or reached ratio 1. Settings below the floor are raised to it.

export const IPT_FLOOR = { days: 14, ratio: 1 } as const;
export type SeedingSettings = { ratio: number; minDays: number; maxDays: number };
export type Seeded = { ratio: number; seedingSeconds: number };
export type SeedingDecision = {
  remove: boolean; reason?: string;
  // When it will be removed: the earliest certain time (the ratio already met, or the longest seeding).
  removeAt: number;
  // The days and ratio the rule uses, after the floor.
  rule: SeedingSettings;
};

const DAY = 86400000;
const finite = (n: number, fallback: number) => Number.isFinite(n) ? n : fallback;

export function seedingRule(settings: SeedingSettings): SeedingSettings {
  return {
    ratio: Math.max(finite(settings.ratio, 2), IPT_FLOOR.ratio),
    minDays: Math.max(finite(settings.minDays, 14), IPT_FLOOR.days),
    maxDays: Math.max(finite(settings.maxDays, 28), IPT_FLOOR.days),
  };
}

export const meetsFloor = (seeded: Seeded) => seeded.seedingSeconds >= IPT_FLOOR.days * 86400 || seeded.ratio >= IPT_FLOOR.ratio;

// `at` is when qBittorrent's figures were read.
export function seedingDecision(seeded: Seeded, settings: SeedingSettings, at: number): SeedingDecision {
  const rule = seedingRule(settings);
  const seconds = Math.max(0, finite(seeded.seedingSeconds, 0)), ratio = Math.max(0, finite(seeded.ratio, 0)), days = seconds / 86400;
  const byMax = at + Math.max(0, rule.maxDays * DAY - seconds * 1000);
  const ratioMet = ratio >= rule.ratio;
  const removeAt = ratioMet ? Math.min(byMax, at + Math.max(0, rule.minDays * DAY - seconds * 1000)) : byMax;
  let reason: string | undefined;
  if (ratioMet && days >= rule.minDays) reason = `ratio ${ratio.toFixed(2)} after ${days.toFixed(1)} days`;
  else if (days >= rule.maxDays) reason = `seeded ${days.toFixed(1)} days`;
  const remove = !!reason && meetsFloor({ ratio, seedingSeconds: seconds });
  return { remove, ...(remove ? { reason } : {}), removeAt, rule };
}
