import type { Candidate } from '../lib/pick-rules.js';
import type { DownloadStatus } from '../providers/download-status.js';
import type { OutKind } from '../persistence/library-store.js';

// Slow and stalled downloads (docs/STALLS.md). Pure: what the 30-second download check saw becomes a verdict every
// VERDICT_POLLS polls, verdicts become strikes, and OUT_AT strikes put a download out (the library then swaps it for a
// better release, or keeps it as Only source).

const MINUTE = 60000, HOUR = 60 * MINUTE;
export const VERDICT_POLLS = 4;
// No verdicts this soon after the send: a torrent is still finding its peers.
export const WARM_UP = 2 * MINUTE;
export const OUT_AT = 3;
// Usenet: stuck grabbing or fetching the NZB's articles this long is out; post-processing this long fails.
export const PRE_DOWNLOAD_LIMIT = 30 * MINUTE, POST_LIMIT = 2 * HOUR;
// Only source: looked at again for a better release this often; fails dead this long, or still running this long
// after the send.
export const RECHECK = HOUR, DEAD_CEILING = 2 * HOUR, CEILING = 24 * HOUR;
// A skipped release is picked again after this.
export const SKIP_FOR = 7 * 24 * HOUR;
// A swap's better torrent: at least this many seeders, and this many times the current swarm's.
export const SWAP_SEEDERS = 5, SWAP_FACTOR = 3;
const PRE_DOWNLOAD = new Set(['grabbing', 'fetching']);

export type Sample = { at: number; left?: number; waiting: boolean; metadata: boolean };
// What the check keeps per grab, in memory: the samples since the last verdict, whether the last Dead verdict asked
// for a reannounce, how many verdicts in a row saw no complete copy, and since when a Usenet job has been in its
// current stage.
export type Watch = { samples: Sample[]; reannounced: boolean; noCopy: number; stage?: { name: string; since: number } };
export const newWatch = (): Watch => ({ samples: [], reannounced: false, noCopy: 0 });

export type Verdict = 'waiting' | 'dead' | 'slow' | 'healthy';
export type Budget = { movie: number; episode: number };
// The projected time left a download may have, in ms: a movie's; an episode's for each episode a multi-episode
// release holds, up to three; three episodes' for a season pack.
export function budgetMs(budget: Budget, kind: 'movie' | 'episode' | 'pack', episodes = 1) {
  return (kind === 'movie' ? budget.movie : budget.episode * (kind === 'pack' ? 3 : Math.min(Math.max(episodes, 1), 3))) * MINUTE;
}

// One verdict from a full window. Waiting when the downloader held it at any point; dead when nothing moved or it is
// still fetching metadata; slow when what's left at the window's speed would take longer than the budget.
export function judge(samples: readonly Sample[], budget: number): { verdict: Verdict; speed?: number; leftMs?: number } {
  if (samples.some(s => s.waiting)) return { verdict: 'waiting' };
  const first = samples[0], last = samples[samples.length - 1];
  if (!first || !last || first.left === undefined || last.left === undefined || last.at <= first.at) return { verdict: 'waiting' };
  if (last.metadata) return { verdict: 'dead', speed: 0 };
  const speed = (first.left - last.left) / ((last.at - first.at) / 1000);
  if (speed <= 0) return { verdict: 'dead', speed: 0 };
  const leftMs = last.left / speed * 1000;
  return { verdict: leftMs > budget ? 'slow' : 'healthy', speed, leftMs };
}

// No complete copy anywhere in the swarm: qBittorrent's availability under 1 and the tracker counting no seeds.
export const noCompleteCopy = (s: Pick<DownloadStatus, 'availability' | 'swarmSeeds'>) =>
  s.availability !== undefined && s.availability < 1 && s.swarmSeeds === 0;

// A verdict's strikes. `clientOk`: the downloader itself is fine (connected, no alternative speed limits, and not
// every download in it standing still); without it nothing is judged. `slowCounts`: slowness strikes (not for Usenet,
// whose speed is the line's). `canReannounce`: a torrent. The first Dead verdict strikes once and asks for a
// reannounce; one after that is confirmed and strikes twice. A Healthy one clears the strikes.
export type Step = { strikes: number; reannounce: boolean; out?: OutKind; watch: Watch };
export function strike(watch: Watch, strikes: number, verdict: Verdict, opts: { clientOk: boolean; slowCounts: boolean; canReannounce: boolean; noCopy: boolean }): Step {
  const next: Watch = { ...watch, samples: [] };
  if (verdict === 'waiting' || !opts.clientOk) return { strikes, reannounce: false, watch: { ...next, noCopy: 0 } };
  next.noCopy = opts.noCopy ? watch.noCopy + 1 : 0;
  if (next.noCopy >= 2) return { strikes: Math.max(strikes, OUT_AT), reannounce: false, out: 'dud', watch: next };
  if (verdict === 'healthy') return { strikes: 0, reannounce: false, watch: { ...next, reannounced: false } };
  if (verdict === 'slow') {
    if (!opts.slowCounts) return { strikes, reannounce: false, watch: next };
    const total = strikes + 1;
    return { strikes: total, reannounce: false, watch: next, ...(total >= OUT_AT ? { out: 'slow' as const } : {}) };
  }
  // Dead.
  // A Usenet job has nothing to reannounce, but still gets a second window before it counts as confirmed.
  const confirmed = watch.reannounced;
  const total = strikes + (confirmed ? 2 : 1);
  return { strikes: total, reannounce: !confirmed && opts.canReannounce, watch: { ...next, reannounced: true }, ...(total >= OUT_AT ? { out: confirmed ? 'dud' as const : 'slow' as const } : {}) };
}

// A Usenet job's stage clock: Grabbing or Fetching for PRE_DOWNLOAD_LIMIT is out.
export function stageClock(watch: Watch, stage: string | undefined, now: number): { watch: Watch; stuck: boolean } {
  if (!stage || !PRE_DOWNLOAD.has(stage)) return { watch: { ...watch, stage: undefined }, stuck: false };
  const since = watch.stage?.name === stage ? watch.stage.since : now;
  return { watch: { ...watch, stage: { name: stage, since } }, stuck: now - since >= PRE_DOWNLOAD_LIMIT };
}

// Whether a release is likely faster than the download it would replace: Usenet, or a torrent with at least
// SWAP_SEEDERS seeders and SWAP_FACTOR times the current swarm's seeds (none known counts as none).
export function likelyFaster(release: Pick<Candidate, 'protocol' | 'seeders'>, currentSeeds: number | undefined) {
  if (release.protocol === 'usenet') return true;
  return release.seeders !== undefined && release.seeders >= Math.max(SWAP_SEEDERS, SWAP_FACTOR * (currentSeeds ?? 0));
}

// The worst tier a swap may take: the current one when it is just slow, one down for a confirmed dud.
export const swapTierLimit = (current: number, tiers: number, kind: OutKind) => current < 0 ? tiers - 1 : kind === 'dud' ? Math.min(current + 1, tiers - 1) : current;
