import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { playbackSettings, type PlaybackSettings } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { migrate, type Migration } from './migrate.js';

// Tables every part of the server shares: settings, audit, accounts and sign-in, the channel number lineup (IPTV and
// custom channels), service keys, admins and the key check. Each module owns its other tables and migrates them as it
// is mounted (modules/migrations/); openMigratedDatabase applies them all without mounting, for tests and scripts.
export const coreMigrations: Migration[] = [
  { name: 'base', legacy: 1, up: db => {
    db.exec(`CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, actor TEXT NOT NULL, event TEXT NOT NULL, at INTEGER NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users(account_id TEXT PRIMARY KEY, allowed INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES users(account_id), encrypted_credential TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_challenges(hash TEXT PRIMARY KEY, pin_id INTEGER NOT NULL, code TEXT NOT NULL, expires INTEGER NOT NULL, last_poll INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS playback_sessions(id TEXT PRIMARY KEY, session_hash TEXT NOT NULL REFERENCES sessions(hash) ON DELETE CASCADE,
        mode TEXT NOT NULL CHECK(mode IN ('plex_vod','custom_linear','iptv_live')), rating_key TEXT, expires INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS immutable_playback_mode BEFORE UPDATE OF mode ON playback_sessions
        BEGIN SELECT RAISE(ABORT,'Playback mode is immutable'); END;`);
    db.prepare('INSERT OR IGNORE INTO settings VALUES(1,0,?)').run(JSON.stringify({ maxConcurrentCpuVideoTranscodes: 2, pauseRetentionMinutes: 30 }));
  } },
  { name: 'lineup-numbers', legacy: 2, up: 'CREATE TABLE IF NOT EXISTS lineup_numbers(channel_id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE CHECK(number>0), position INTEGER NOT NULL CHECK(position>=0))' },
  // These three were created by their store (or the key check) on every start, so they keep IF NOT EXISTS.
  { name: 'service-keys', up: 'CREATE TABLE IF NOT EXISTS service_keys(name TEXT PRIMARY KEY, sealed TEXT NOT NULL)' },
  { name: 'extra-admins', up: 'CREATE TABLE IF NOT EXISTS extra_admins(account_id TEXT PRIMARY KEY, name TEXT NOT NULL, added_by TEXT NOT NULL, added_at INTEGER NOT NULL)' },
  { name: 'key-check', up: 'CREATE TABLE IF NOT EXISTS key_check(id INTEGER PRIMARY KEY CHECK(id=1), sealed TEXT NOT NULL)' }
];

export function openDatabase(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  db.pragma('foreign_keys = ON'); db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 5000');
  migrate(db, 'core', coreMigrations);
  return db;
}
export type Db = ReturnType<typeof openDatabase>;
export class SettingsStore {
  constructor(private db: Db) {}
  get() {
    const row = this.db.prepare('SELECT revision,value FROM settings WHERE id=1').get() as {revision: number; value: string};
    return { revision: row.revision, ...playbackSettings.parse(JSON.parse(row.value)) };
  }
  update(actor: string, expectedRevision: number, value: PlaybackSettings) {
    const valid = playbackSettings.parse(value);
    return this.db.transaction(() => {
      const result = this.db.prepare('UPDATE settings SET revision=revision+1,value=? WHERE id=1 AND revision=?').run(JSON.stringify(valid), expectedRevision);
      if (!result.changes) throw new AppError('REVISION_CONFLICT', 'Settings changed. Reload and retry.', 409);
      this.db.prepare('INSERT INTO audit(actor,event,at,detail) VALUES(?,?,?,?)').run(actor, 'playback_settings_changed', Date.now(), JSON.stringify(valid));
      return this.get();
    })();
  }
}
