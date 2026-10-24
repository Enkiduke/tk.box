import { z } from 'zod';
import type { Db } from './database.js';
import type { Vault } from '../security/vault.js';
import { AppError } from '../errors.js';

// Admin › Server › Clean Up: the settings of the purge script (apps/cleanup/purge_requests.py), its Tautulli and Sonarr
// connections and its job history. The script reads none of this directly: before each run tk.box writes its JSON
// config (cleanupConfig). Keys are sealed. Seerr's connection is Explore's and Radarr's is Collections'.
const libraryId = z.string().regex(/^\d{1,10}$/);
const days = z.number().int().min(0).max(3650);
const label = z.string().trim().max(60).refine(value => ![...value].some(c => c.charCodeAt(0) < 32), 'No control characters');
const origin = z.string().trim().max(300).refine(value => { if (!value) return true; try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; } catch { return false; } }, 'Use an http(s) address').transform(value => value.replace(/\/+$/, ''));
const key = z.string().trim().max(200).regex(/^[\w-]*$/);
export const cleanupSettings = z.object({
  movieLibraries: z.array(libraryId).max(50), tvLibraries: z.array(libraryId).max(50),
  // A preview reports what would be deleted and changes nothing, in Plex or anywhere else.
  dryRun: z.boolean(),
  deleteFromRadarr: z.boolean(), deleteFromSonarr: z.boolean(), deleteFromSeerr: z.boolean(),
  // Rule 1: the requester watched it; days after anyone last watched it. Rule 2: the requester hasn't; days after it
  // was added. Rules 3 and 4 are for requests by exempt users: days after anyone's watch, or after an exempt user's.
  daysAfterWatched: days, daysAfterUnwatched: days, daysAfterAnyWatchExempt: days, daysAfterExemptWatch: days,
  // Plex account IDs, as Tautulli shows them.
  exemptUserIds: z.array(z.number().int().positive().max(2 ** 53)).max(100),
  exemptArrTags: z.array(label.pipe(z.string().min(1))).max(50),
  exemptIfInCollection: z.boolean(),
  seasons: z.object({ enabled: z.boolean(), protectLatest: z.boolean(), protectSpecials: z.boolean() }).strict(),
  leavingSoon: z.object({ enabled: z.boolean(), name: label.pipe(z.string().min(1)), days: z.number().int().min(1).max(365), poster: z.boolean() }).strict(),
  // Each day at a server-local time.
  schedule: z.object({ enabled: z.boolean(), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/) }).strict()
}).strict();
export type CleanupSettings = z.infer<typeof cleanupSettings>;
export const cleanupConnectionsInput = z.object({ tautulliUrl: origin, sonarrUrl: origin, tautulliKey: key.optional(), sonarrKey: key.optional() }).strict();
type Connections = { tautulliUrl: string; sonarrUrl: string; tautulliKey?: string; sonarrKey?: string };
// Nothing is deleted until an administrator turns previews off; the retention days are the script's own defaults.
const defaults: CleanupSettings = { movieLibraries: [], tvLibraries: [], dryRun: true, deleteFromRadarr: false, deleteFromSonarr: false, deleteFromSeerr: false,
  daysAfterWatched: 30, daysAfterUnwatched: 60, daysAfterAnyWatchExempt: 90, daysAfterExemptWatch: 180, exemptUserIds: [], exemptArrTags: [], exemptIfInCollection: false,
  seasons: { enabled: true, protectLatest: true, protectSpecials: true }, leavingSoon: { enabled: false, name: 'Leaving Soon', days: 7, poster: true },
  schedule: { enabled: false, time: '03:30' } };
export const holdKey = z.string().regex(/^(?:movie|tv):\d{1,10}(?::\d{1,4})?$/);
export type CleanupHold = { until: number; by: string; at: number };
export type CleanupJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
const job = (r: Record<string, unknown>) => ({ id: r.id as number, label: r.label as string, args: JSON.parse(r.args as string) as string[], script: 'cleanup' as const, actor: r.actor as string,
  status: r.status as CleanupJobStatus, createdAt: r.created_at as number, startedAt: r.started_at as number | null, finishedAt: r.finished_at as number | null, exitCode: r.exit_code as number | null });

export class CleanupStore {
  constructor(private db: Db, private vault: Vault) {
    db.exec(`CREATE TABLE IF NOT EXISTS cleanup_config(name TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cleanup_jobs(id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, args TEXT NOT NULL, actor TEXT NOT NULL, status TEXT NOT NULL,
        created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, exit_code INTEGER, output TEXT);`);
  }
  private row<T>(name: 'settings' | 'connections' | `state:${string}`) {
    const row = this.db.prepare('SELECT revision,value FROM cleanup_config WHERE name=?').get(name) as { revision: number; value: string } | undefined;
    return row && { revision: row.revision, value: JSON.parse(row.value) as T };
  }
  private write(name: string, revision: number, value: unknown) {
    this.db.prepare('INSERT INTO cleanup_config VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET revision=excluded.revision,value=excluded.value').run(name, revision, JSON.stringify(value));
  }
  settings(): CleanupSettings & { revision: number } {
    const row = this.row<Partial<CleanupSettings>>('settings');
    return { ...defaults, ...row?.value, revision: row?.revision ?? 0 };
  }
  update(actor: string, expectedRevision: number, input: CleanupSettings, now = Date.now()) {
    const value = cleanupSettings.parse(input);
    return this.db.transaction(() => {
      const revision = this.row('settings')?.revision ?? 0;
      if (revision !== expectedRevision) throw new AppError('REVISION_CONFLICT', 'Settings changed. Reload and retry.', 409);
      this.write('settings', revision + 1, value);
      this.db.prepare('INSERT INTO audit(actor,event,at,detail) VALUES(?,?,?,?)').run(actor, 'cleanup_settings_changed', now, JSON.stringify({ dryRun: value.dryRun, schedule: value.schedule }));
      return this.settings();
    })();
  }
  private storedConnections() { return this.row<Connections>('connections') ?? { revision: 0, value: { tautulliUrl: '', sonarrUrl: '' } }; }
  // What the Connections page shows: never the keys themselves.
  connectionsView() { const { revision, value: v } = this.storedConnections(); return { revision, tautulliUrl: v.tautulliUrl, sonarrUrl: v.sonarrUrl, tautulliKeySet: !!v.tautulliKey, sonarrKeySet: !!v.sonarrKey }; }
  connections() {
    const { value: v } = this.storedConnections(), open = (sealed: string | undefined, name: string) => sealed ? this.vault.open(sealed, `cleanup:${name}-key`) : undefined;
    return { tautulliUrl: v.tautulliUrl, sonarrUrl: v.sonarrUrl, tautulliKey: open(v.tautulliKey, 'tautulli'), sonarrKey: open(v.sonarrKey, 'sonarr') };
  }
  // Omitted keeps a saved key; an empty string removes it.
  updateConnections(actor: string, expectedRevision: number, input: z.input<typeof cleanupConnectionsInput>, now = Date.now()) {
    const valid = cleanupConnectionsInput.parse(input);
    return this.db.transaction(() => {
      const { revision, value } = this.storedConnections();
      if (revision !== expectedRevision) throw new AppError('REVISION_CONFLICT', 'Connections changed. Reload and retry.', 409);
      const seal = (given: string | undefined, saved: string | undefined, name: string) => given === undefined ? saved : given ? this.vault.seal(given, `cleanup:${name}-key`) : undefined;
      const tautulliKey = seal(valid.tautulliKey, value.tautulliKey, 'tautulli'), sonarrKey = seal(valid.sonarrKey, value.sonarrKey, 'sonarr');
      this.write('connections', revision + 1, { tautulliUrl: valid.tautulliUrl, sonarrUrl: valid.sonarrUrl, ...(tautulliKey ? { tautulliKey } : {}), ...(sonarrKey ? { sonarrKey } : {}) });
      this.db.prepare('INSERT INTO audit(actor,event,at,detail) VALUES(?,?,?,?)').run(actor, 'cleanup_connections_changed', now,
        JSON.stringify({ tautulliUrl: valid.tautulliUrl, sonarrUrl: valid.sonarrUrl, tautulliKeySet: !!tautulliKey, sonarrKeySet: !!sonarrKey }));
      return this.connectionsView();
    })();
  }
  // Clean Up › Status: titles an administrator chose to keep longer, by hold key (movie:<tmdb>, tv:<tmdb> or
  // tv:<tmdb>:<season>). A hold only ever moves a title's date later; the rule's own date wins once it is later still.
  holds(now = Date.now()) {
    const all = this.state<Record<string, CleanupHold>>('holds') ?? {};
    return Object.fromEntries(Object.entries(all).filter(([, hold]) => hold.until > now));
  }
  setHold(actor: string, key: string, until: number | null, now = Date.now()) {
    if (!holdKey.safeParse(key).success) throw new AppError('VALIDATION_FAILED', 'Not a title that can be held.', 400);
    return this.db.transaction(() => {
      const holds = this.holds(now);
      if (until === null) delete holds[key]; else holds[key] = { until, by: actor, at: now };
      this.setState('holds', holds);
      this.db.prepare('INSERT INTO audit(actor,event,at,detail) VALUES(?,?,?,?)').run(actor, until === null ? 'cleanup_hold_cleared' : 'cleanup_hold_set', now, JSON.stringify({ key, until }));
      return holds;
    })();
  }
  state<T>(name: string) { return this.row<T>(`state:${name}`)?.value; }
  setState(name: string, value: unknown) { this.write(`state:${name}`, 0, value); }

  addJob(actor: string, label: string, args: string[], now = Date.now()) {
    return Number(this.db.prepare("INSERT INTO cleanup_jobs(label,args,actor,status,created_at) VALUES(?,?,?,'queued',?)").run(label, JSON.stringify(args), actor, now).lastInsertRowid);
  }
  jobStarted(id: number, now = Date.now()) { this.db.prepare("UPDATE cleanup_jobs SET status='running',started_at=? WHERE id=?").run(now, id); }
  jobFinished(id: number, status: CleanupJobStatus, exitCode: number | null, output: string, now = Date.now()) {
    this.db.prepare('UPDATE cleanup_jobs SET status=?,exit_code=?,output=?,finished_at=? WHERE id=?').run(status, exitCode, output, now, id);
  }
  // A restart stops whatever was running or waiting.
  abandonJobs(now = Date.now()) { this.db.prepare("UPDATE cleanup_jobs SET status='canceled',finished_at=?,output=COALESCE(output,'')||? WHERE status IN ('queued','running')").run(now, '\n[tk.box restarted; this job was stopped]'); }
  jobs(limit = 30) { return (this.db.prepare('SELECT id,label,args,actor,status,created_at,started_at,finished_at,exit_code FROM cleanup_jobs ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[]).map(job); }
  job(id: number) {
    const row = this.db.prepare('SELECT id,label,args,actor,status,created_at,started_at,finished_at,exit_code,output FROM cleanup_jobs WHERE id=?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new AppError('NOT_FOUND', 'No such job.', 404);
    return { ...job(row), output: (row.output as string | null) ?? '' };
  }
  pruneJobs() { this.db.prepare('DELETE FROM cleanup_jobs WHERE id NOT IN (SELECT id FROM cleanup_jobs ORDER BY id DESC LIMIT 200)').run(); }
}
