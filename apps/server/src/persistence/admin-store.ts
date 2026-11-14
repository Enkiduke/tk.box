import { z } from 'zod';
import type { Db } from './database.js';
import { AppError } from '../errors.js';

// Admin › Server › Users: Plex accounts the server owner made administrators of tk.box. Plex knows only the owner;
// these accounts are admins here alone. Only the owner changes the list.
export const plexAccountId = z.string().regex(/^\d{1,20}$/);
export type ExtraAdmin = { accountId: string; name: string; addedBy: string; addedAt: number };

export class AdminStore {
  constructor(private db: Db) {}
  has(accountId: string) { return !!this.db.prepare('SELECT 1 FROM extra_admins WHERE account_id=?').get(accountId); }
  list(): ExtraAdmin[] {
    return (this.db.prepare('SELECT account_id,name,added_by,added_at FROM extra_admins ORDER BY name COLLATE NOCASE').all() as Record<string, unknown>[])
      .map(r => ({ accountId: r.account_id as string, name: r.name as string, addedBy: r.added_by as string, addedAt: r.added_at as number }));
  }
  add(actor: string, accountId: string, name: string, ownerId: string, now = Date.now()) {
    plexAccountId.parse(accountId);
    if (accountId === ownerId) throw new AppError('VALIDATION_FAILED', 'The server owner is always an admin.', 400);
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO extra_admins VALUES(?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET name=excluded.name').run(accountId, name.trim().slice(0, 200) || accountId, actor, now);
      this.db.prepare('INSERT INTO audit(actor,event,at,detail) VALUES(?,?,?,?)').run(actor, 'admin_added', now, JSON.stringify({ accountId }));
    })();
    return this.list();
  }
  remove(actor: string, accountId: string, now = Date.now()) {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM extra_admins WHERE account_id=?').run(plexAccountId.parse(accountId));
      this.db.prepare('INSERT INTO audit(actor,event,at,detail) VALUES(?,?,?,?)').run(actor, 'admin_removed', now, JSON.stringify({ accountId }));
    })();
    return this.list();
  }
  revokePlexAccess(actor: string, key: string, accountId: string | null, now = Date.now()) {
    this.db.transaction(() => {
      if (accountId) {
        this.db.prepare('DELETE FROM extra_admins WHERE account_id=?').run(accountId);
        this.db.prepare('DELETE FROM sessions WHERE account_id=?').run(accountId);
      }
      this.db.prepare('INSERT INTO audit(actor,event,at,detail) VALUES(?,?,?,?)').run(actor, 'plex_access_revoked', now, JSON.stringify({ key, accountId }));
    })();
  }
}
