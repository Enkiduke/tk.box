import type { Db } from './database.js';
import { Vault } from '../security/vault.js';
import { requireThat } from '../errors.js';
import { z } from 'zod';

const interval = z.number().int().min(1).max(168);
type SourceRow = {id: string; kind: 'm3u' | 'xmltv'; interval_hours: number; remote: number; revision: number; last_attempt: number | null; last_success: number | null; next_due: number | null; last_error: string | null; encrypted_snapshot: string | null};
// Durable last-good cache prototype. Fetch/SSRF policy and background job runner are later gates.
export class SourceSnapshots {
  constructor(private db: Db, private vault: Vault) {
    db.exec(`CREATE TABLE IF NOT EXISTS source_snapshots(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('m3u','xmltv')),
      interval_hours INTEGER NOT NULL CHECK(interval_hours BETWEEN 1 AND 168), remote INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,last_attempt INTEGER,last_success INTEGER,next_due INTEGER,last_error TEXT,encrypted_snapshot TEXT);`);
  }
  create(id: string, kind: 'm3u' | 'xmltv', remote: boolean, now: number) {
    const hours = kind === 'm3u' ? 12 : 6;
    this.db.prepare('INSERT INTO source_snapshots(id,kind,interval_hours,remote,next_due) VALUES(?,?,?,?,?)').run(id, kind, hours, Number(remote), remote ? now + hours * 3600000 : null);
  }
  private row(id: string) { const row = this.db.prepare('SELECT * FROM source_snapshots WHERE id=?').get(id) as SourceRow | undefined; requireThat(row, 'SOURCE_NOT_FOUND', 'Source not found.', 404); return row; }
  status(id: string) { const {encrypted_snapshot: _, ...row} = this.row(id); return row; }
  setInterval(id: string, hours: number, now: number) {
    interval.parse(hours); const row = this.row(id);
    this.db.prepare('UPDATE source_snapshots SET interval_hours=?,next_due=? WHERE id=?').run(hours, row.remote ? now + hours * 3600000 : null, id);
  }
  snapshot<T>(id: string): T | undefined {
    const row = this.row(id); return row.encrypted_snapshot ? JSON.parse(this.vault.open(row.encrypted_snapshot, id)) as T : undefined;
  }
  commit(id: string, expectedRevision: number, validatedSnapshot: unknown, complete: boolean, now: number) {
    requireThat(complete && validatedSnapshot !== undefined, 'UNTRUSTED_SNAPSHOT', 'Only complete validated imports may replace source data.');
    this.db.transaction(() => {
      const row = this.row(id);
      requireThat(row.revision === expectedRevision, 'REVISION_CONFLICT', 'Source changed during import.', 409);
      this.db.prepare('UPDATE source_snapshots SET revision=revision+1,last_attempt=?,last_success=?,last_error=NULL,next_due=?,encrypted_snapshot=? WHERE id=?').run(now, now, row.remote ? now + row.interval_hours * 3600000 : null, this.vault.seal(JSON.stringify(validatedSnapshot), id), id);
    })();
  }
  fail(id: string, now: number) {
    const row = this.row(id);
    this.db.prepare('UPDATE source_snapshots SET last_attempt=?,last_error=?,next_due=? WHERE id=?').run(now, 'SOURCE_REFRESH_FAILED', row.remote ? now + row.interval_hours * 3600000 : null, id);
  }
}
