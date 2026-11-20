import type { DownloadStats, DownloadStatsCount } from '../../../../packages/contracts/src/downloads.js';
import type { Grab } from '../persistence/library-store.js';

// Downloads › History › Stats: the grabs started in a period, counted by day, indexer, downloader and quality.
// Imported means imported (or seeding, or done after it); failed means the download failed, even when a later grab
// took over. A downloader's time is from being sent until it finished, over the grabs that have both.
export type StatsGrab = { grab: Pick<Grab, 'indexer' | 'downloader' | 'quality' | 'size' | 'state' | 'upgrade' | 'sentAt' | 'finishedAt'>; startedAt: number };

const IMPORTED = new Set(['imported', 'seeding', 'done']);
const OPEN = new Set(['sending', 'downloading', 'unpacking', 'importing']);
const blank = (): DownloadStatsCount => ({ grabs: 0, imported: 0, failed: 0, bytes: 0 });
const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

export function downloadStats(rows: readonly StatsGrab[]): DownloadStats {
  const totals = { ...blank(), cancelled: 0, active: 0, upgrades: 0 };
  const days = new Map<string, DownloadStatsCount>(), indexers = new Map<string, DownloadStatsCount>();
  const downloaders = new Map<string, DownloadStatsCount & { ms: number; timed: number; timedBytes: number }>();
  const qualities = new Map<string, { grabs: number; bytes: number }>();
  const add = (into: DownloadStatsCount, imported: boolean, failed: boolean, size: number) => {
    into.grabs++;
    if (imported) { into.imported++; into.bytes += size; }
    if (failed) into.failed++;
  };
  for (const { grab: g, startedAt } of rows) {
    const imported = IMPORTED.has(g.state), failed = g.state === 'failed', size = g.size ?? 0;
    add(totals, imported, failed, size);
    if (g.state === 'cancelled') totals.cancelled++;
    if (OPEN.has(g.state)) totals.active++;
    if (g.upgrade) totals.upgrades++;
    const day = dayOf(startedAt);
    add(days.get(day) ?? days.set(day, blank()).get(day)!, imported, failed, size);
    add(indexers.get(g.indexer) ?? indexers.set(g.indexer, blank()).get(g.indexer)!, imported, failed, size);
    const d = downloaders.get(g.downloader) ?? downloaders.set(g.downloader, { ...blank(), ms: 0, timed: 0, timedBytes: 0 }).get(g.downloader)!;
    add(d, imported, failed, size);
    if (!failed && g.sentAt !== undefined && g.finishedAt !== undefined && g.finishedAt > g.sentAt) {
      d.ms += g.finishedAt - g.sentAt; d.timed++; d.timedBytes += size;
    }
    const q = qualities.get(g.quality) ?? qualities.set(g.quality, { grabs: 0, bytes: 0 }).get(g.quality)!;
    q.grabs++;
    if (imported) q.bytes += size;
  }
  const byGrabs = <T extends { grabs: number }>(a: T, b: T) => b.grabs - a.grabs;
  return {
    totals,
    days: [...days].map(([day, c]) => ({ day, ...c })).sort((a, b) => a.day.localeCompare(b.day)),
    indexers: [...indexers].map(([name, c]) => ({ name, ...c })).sort(byGrabs),
    downloaders: [...downloaders].map(([name, { ms, timed, timedBytes, ...c }]) => ({ name, ...c,
      ...(timed ? { avgMs: Math.round(ms / timed) } : {}), ...(ms > 0 && timedBytes > 0 ? { avgSpeed: Math.round(timedBytes / (ms / 1000)) } : {}) })).sort(byGrabs),
    qualities: [...qualities].map(([name, q]) => ({ name, ...q })).sort(byGrabs),
  };
}
