import type { ArtworkStore, CollectionScheduleName, ScheduleName } from '../persistence/artwork-store.js';
import type { PlexAdapter, PlexGrant } from '../providers/plex.js';
import type { ArtworkEngine } from './artwork-engine.js';
import { PlexNotifications, type Finished } from './plex-notifications.js';
import { WAITING } from './plex-background.js';

// Artwork's and collections' schedules, run by tk.box instead of cron and a Tautulli hook. Each daily task runs once a
// day at its server-local time (or within two hours after, if tk.box was down then). Newly added titles are checked for
// as soon as Plex says it finished adding something to a watched library (its notification feed, once things settle),
// and every N minutes as well for anything a dropped feed missed. A check reads each library's recently added list back
// to a watermark, oldest first, and moves the watermark only past what it handled, so nothing is missed and nothing old
// is made again. Plex is read with the Plex admin token (services/plex-background.ts); without a working one, they wait.
// The nightly full collections run, which also builds Discover's index, waits while anyone is streaming, up to
// DEFER_MS after its time; newly added movies join that index every few minutes in one small job.
// Daily tasks by the name their state is kept under: artwork's, then the collections' (prefixed "collections-").
export const DAILY = {
  scrub: { label: 'Nightly: update changed titles', script: 'artwork', args: ['--changed-only'], upload: false },
  'collections-custom': { label: 'Nightly: custom and seasonal collections', script: 'collections', args: ['custom', 'apply'], upload: true },
  'collections-all': { label: 'Nightly: update every collection', script: 'collections', args: ['all', 'apply'], upload: true }
} as const;
type Daily = keyof typeof DAILY;
type StateName = ScheduleName | `collections-${CollectionScheduleName}` | 'index-added';
type AddedItem = { id: string; title: string; showTitle?: string; addedAt?: number };
export type ScheduleState = { lastRun?: number; note?: string };
const LATE_MS = 2 * 3600000, DEFER_MS = 4 * 3600000, INDEX_EVERY_MS = 15 * 60000;
// Daily tasks that wait while anyone is streaming (in tk.box or any Plex app).
const DEFERRED: readonly Daily[] = ['collections-all'];
// A check waits this long after Plex's last finished title, so a season or a scan arrives whole, but no longer than
// SETTLE_MAX_MS after the first. Each check queues at most MAX_QUEUED jobs; the rest wait for the next.
const SETTLE_MS = 30000, SETTLE_MAX_MS = 3 * 60000, MAX_QUEUED = 50;

// When a daily task at `time` (HH:MM, local) last fell due at or before `now`.
export function lastDue(time: string, now: Date) {
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  const due = new Date(now); due.setHours(hour, minute, 0, 0);
  if (due.getTime() > now.getTime()) due.setDate(due.getDate() - 1);
  return due.getTime();
}
// Plex gives addedAt in seconds.
const addedMs = (addedAt?: number) => addedAt === undefined ? 0 : addedAt < 1e11 ? addedAt * 1000 : addedAt;

export class ArtworkSchedule {
  private timer?: NodeJS.Timeout;
  private settle?: NodeJS.Timeout;
  private settleSince?: number;
  private ticking = false;
  private again = false;
  private libraries: PlexGrant['libraries'] = [];
  private notifications: PlexNotifications;
  constructor(private store: ArtworkStore, private engine: ArtworkEngine, private plex: PlexAdapter, private adminGrant: () => Promise<PlexGrant | undefined>,
    private log: (message: string, detail: Record<string, unknown>) => void = () => {}, private streaming: (grant: PlexGrant) => Promise<number> = async () => 0) {
    this.notifications = new PlexNotifications(() => this.openNotifications(), sections => this.finished(sections), log);
  }
  start() { this.timer = setInterval(() => void this.tick(), 60000); this.timer.unref(); this.notifications.start(); }
  close() { clearInterval(this.timer); clearTimeout(this.settle); this.notifications.close(); }
  // The feed is open only while a newly added check is on.
  private async openNotifications() {
    if (!this.store.settings().schedules.added.enabled && !this.store.collections().schedules.added.enabled) return undefined;
    const grant = await this.adminGrant().catch(() => undefined);
    if (!grant) return undefined;
    this.libraries = grant.libraries;
    return this.plex.notificationSocket(grant);
  }
  // The library sections the newly added checks that are on read.
  private watched() {
    const settings = this.store.settings(), collections = this.store.collections(), sections = new Set<string>();
    if (settings.schedules.added.enabled) for (const id of settings.libraries) sections.add(id);
    if (collections.schedules.added.enabled) {
      const titles = new Set((collections.definitions ?? []).filter(d => d.enabled !== false).map(d => d.library));
      for (const library of this.libraries) if (titles.has(library.title)) sections.add(library.key);
    }
    return sections;
  }
  // Plex finished adding something: if it was in a watched library, check once things settle.
  finished(sections: Finished, now = Date.now()) {
    if (sections !== 'any') { const watched = this.watched(); if (![...sections].some(s => watched.has(s))) return; }
    this.settleSince ??= now;
    clearTimeout(this.settle);
    this.settle = setTimeout(() => { this.settleSince = undefined; void this.tick(new Date(), true); }, Math.max(0, Math.min(SETTLE_MS, this.settleSince + SETTLE_MAX_MS - now)));
    this.settle.unref();
  }
  private state(name: StateName) { return this.store.state<ScheduleState>(`schedule:${name}`) ?? {}; }
  states() { return Object.fromEntries((['scrub', 'added'] as ScheduleName[]).map(name => [name, this.state(name)])) as Record<ScheduleName, ScheduleState>; }
  collectionStates() { return Object.fromEntries((['custom', 'all', 'added'] as CollectionScheduleName[]).map(name => [name, this.state(`collections-${name}`)])) as Record<CollectionScheduleName, ScheduleState>; }
  // `soon` runs the newly added checks that are on now, whenever they last ran.
  async tick(now = new Date(), soon = false) {
    if (this.ticking) { this.again ||= soon; return; }
    this.ticking = true;
    try {
      const settings = this.store.settings(), collections = this.store.collections(), schedules = settings.schedules, own = collections.schedules;
      const daily = { scrub: schedules.scrub, 'collections-custom': own.custom, 'collections-all': own.all };
      const dueDaily = (Object.keys(DAILY) as Daily[]).filter(name => {
        if (!daily[name].enabled) return false;
        const due = lastDue(daily[name].time, now);
        return (this.state(name).lastRun ?? 0) < due && now.getTime() - due < (DEFERRED.includes(name) ? DEFER_MS + LATE_MS : LATE_MS);
      });
      const every = (name: StateName, value: { enabled: boolean; minutes: number }) => value.enabled && (soon || now.getTime() - (this.state(name).lastRun ?? 0) >= value.minutes * 60000);
      const added = every('added', schedules.added), collectionsAdded = every('collections-added', own.added);
      const indexAdded = soon || now.getTime() - (this.state('index-added').lastRun ?? 0) >= INDEX_EVERY_MS;
      if (!dueDaily.length && !added && !collectionsAdded && !indexAdded) return;
      const grant = await this.adminGrant().catch(() => undefined);
      if (!grant) {
        for (const name of [...dueDaily, ...(added ? ['added' as const] : []), ...(collectionsAdded ? ['collections-added' as const] : [])]) this.note(name, WAITING);
        return;
      }
      const run = { token: grant.serverToken, libraries: grant.libraries };
      // Within DEFER_MS of its time, a deferred task waits for the streams to end; after that it runs anyway.
      const waiting = dueDaily.filter(name => DEFERRED.includes(name) && now.getTime() - lastDue(daily[name].time, now) < DEFER_MS);
      const streams = waiting.length ? await this.streaming(grant).catch(() => 0) : 0;
      for (const name of dueDaily) {
        const task = DAILY[name];
        if (streams && waiting.includes(name)) {
          const by = new Date(lastDue(daily[name].time, now) + DEFER_MS).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          this.note(name, `Waiting: ${streams} stream${streams === 1 ? ' is' : 's are'} playing. Runs when they stop, or at ${by}.`);
          continue;
        }
        this.store.setState(`schedule:${name}`, { lastRun: now.getTime(), note: task.upload && !settings.upload ? 'Skipped: Send results to Plex is off.' : 'Queued.' });
        // The full run builds the Discover index too; without it, the index is still built.
        const args = task.upload && !settings.upload ? name === 'collections-all' ? ['index', 'build'] : undefined : [...task.args];
        if (args && !this.engine.pending(args, task.script)) this.engine.enqueue('system:schedule', args[0] === 'index' ? 'Nightly: Discover index' : task.label, args, run, { script: task.script });
      }
      // Collections first, so a title joins its collections before its artwork is made. They check the libraries the
      // custom collections that are on use.
      if (collectionsAdded && !settings.upload) this.store.setState('schedule:collections-added', { lastRun: now.getTime(), note: 'Skipped: Send results to Plex is off.' });
      else if (collectionsAdded) {
        const titles = new Set((collections.definitions ?? []).filter(d => d.enabled !== false).map(d => d.library));
        await this.added('collections-added', grant.libraries.filter(l => titles.has(l.title)).map(l => l.key), grant, now, item => {
          const args = ['added', item.id];
          if (this.engine.pending(args, 'collections')) return false;
          this.engine.enqueue('system:schedule', `Collections for newly added: ${item.showTitle ?? item.title}`, args, run, { script: 'collections' });
          return true;
        });
      }
      if (added) await this.added('added', settings.libraries.filter(id => grant.libraries.some(l => l.key === id)), grant, now, item => {
        const args = ['--item', item.id, '--added'];
        if (this.engine.pending(args)) return false;
        this.engine.enqueue('system:schedule', `Newly added: ${item.showTitle ?? item.title}`, args, run);
        return true;
      });
      // Newly added movies join the Discover index, all of them in one job, whatever else is on.
      if (indexAdded) {
        const ids: string[] = [];
        await this.added('index-added', grant.libraries.filter(l => l.type === 'movie').map(l => l.key), grant, now, item => { ids.push(item.id); return true; });
        if (ids.length) this.engine.enqueue('system:schedule', `Discover index: ${ids.length} newly added movie${ids.length === 1 ? '' : 's'}`, ['index', 'added', ...ids], run, { script: 'collections' });
      }
    } catch (e) { this.log('artwork schedule failed', { error: (e as Error).message }); }
    finally {
      this.ticking = false;
      if (this.again) { this.again = false; void this.tick(new Date(), true); }
    }
  }
  // Each library's titles added since this check's watermark, one job each (a show's new episodes count once), oldest
  // first; `queue` says whether it queued one (false: already queued). The watermark moves only past what was handled,
  // so titles over the limit, or every library when Plex didn't answer for one, come next time. The first check only
  // sets it.
  private async added(name: 'added' | 'collections-added' | 'index-added', libraries: string[], grant: PlexGrant, now: Date, queue: (item: AddedItem) => boolean) {
    const mark = `${name}:watermark`, watermark = this.store.state<number>(mark);
    const done = (note: string) => this.store.setState(`schedule:${name}`, { lastRun: now.getTime(), note });
    if (watermark === undefined) { this.store.setState(mark, now.getTime()); return done('Watching for titles added from now on.'); }
    const found: (AddedItem & { at: number })[] = [];
    for (const library of libraries) {
      const page = await this.plex.addedSince(grant, library, watermark).catch(() => undefined);
      if (!page) return done('Plex didn’t answer; trying again next check.');
      if (!page.complete) this.log('newly added check read only the newest titles', { library, check: name });
      for (const item of page.items) found.push({ ...item, at: addedMs(item.addedAt) });
    }
    found.sort((a, b) => a.at - b.at);
    let newest = watermark, queued = 0, handled = 0;
    for (const item of found) {
      // Titles added in the same second as the last one handled come again next time, so none is skipped.
      if (queued >= MAX_QUEUED) { if (item.at <= newest) newest = item.at - 1; break; }
      if (queue(item)) queued++;
      handled++; newest = Math.max(newest, item.at);
    }
    this.store.setState(mark, newest);
    const left = found.length - handled, titles = (n: number) => `${n} newly added title${n === 1 ? '' : 's'}`;
    done(left ? `Queued ${titles(queued)}; ${left} more next check.` : queued ? `Queued ${titles(queued)}.` : 'Nothing new.');
  }
  private note(name: StateName, note: string) { this.store.setState(`schedule:${name}`, { ...this.state(name), note }); }
}
