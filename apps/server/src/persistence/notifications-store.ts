import type { Db } from './database.js';
import { prepared } from './statements.js';
import type { NotificationItem, NotificationList, NotificationTone } from '../../../../packages/contracts/src/index.js';

// The notifications module's rows (docs/NOTIFICATIONS.md). SQL for notifications lives here only.
// `to` is a Plex account id, or 'admins' for a system alert every admin shares.
export type NotificationTarget = string;
export const ADMINS: NotificationTarget = 'admins';
export type NewNotification = {
  to: NotificationTarget; kind: string; tone: NotificationTone; title: string; detail?: string; link?: string;
  // A condition's id ('connection.tmdb', 'job.artwork.run'). While one with this key is open, posting it again
  // updates that row (and shows it as unread again if what it says changed) instead of adding another.
  key?: string;
};
export type Resolution = { title: string; detail?: string };

const DAY = 86400000;
export const KEEP_MS = 30 * DAY, KEEP_ROWS = 200, LIST_LIMIT = 100;

type Raw = { id: number; audience: 'account' | 'admins'; account_id: string | null; kind: string; tone: NotificationTone; title: string; detail: string | null;
  link: string | null; key: string | null; created_at: number; updated_at: number; resolved_at: number | null; read_at?: number | null };
const audience = (to: NotificationTarget) => to === ADMINS ? { audience: 'admins' as const, account: null } : { audience: 'account' as const, account: to };
const item = (row: Raw): NotificationItem => ({
  id: row.id, audience: row.audience, kind: row.kind, tone: row.tone, title: row.title,
  ...(row.detail ? { detail: row.detail } : {}), ...(row.link ? { link: row.link } : {}),
  createdAt: row.created_at, updatedAt: row.updated_at, read: !!row.read_at, open: row.key !== null && row.resolved_at === null
});
// The rows an account sees: its own, and the shared admin rows when it is an admin; never ones it dismissed.
const VISIBLE = `FROM notifications n LEFT JOIN notification_reads r ON r.notification_id=n.id AND r.account_id=@account
  WHERE ((n.audience='account' AND n.account_id=@account) OR (n.audience='admins' AND @admin=1)) AND IFNULL(r.dismissed,0)=0`;
// An open condition is never pruned, however old.
const PRUNABLE = `NOT (key IS NOT NULL AND resolved_at IS NULL)`;

export class NotificationStore {
  constructor(private db: Db, private now = Date.now) {}

  // Adds a row, or updates the open one with the same key. `changed` is false when nothing new would show.
  post(n: NewNotification): { id: number; changed: boolean } {
    const { audience: who, account } = audience(n.to), now = this.now();
    const values = { kind: n.kind, tone: n.tone, title: n.title, detail: n.detail ?? null, link: n.link ?? null };
    return this.db.transaction(() => {
      if (n.key !== undefined) {
        const open = prepared(this.db, `SELECT * FROM notifications WHERE audience=? AND IFNULL(account_id,'')=? AND key=? AND resolved_at IS NULL`)
          .get(who, account ?? '', n.key) as Raw | undefined;
        if (open) {
          if (open.kind === values.kind && open.tone === values.tone && open.title === values.title && open.detail === values.detail && open.link === values.link)
            return { id: open.id, changed: false };
          prepared(this.db, `UPDATE notifications SET kind=@kind, tone=@tone, title=@title, detail=@detail, link=@link, updated_at=@now WHERE id=@id`)
            .run({ ...values, now, id: open.id });
          prepared(this.db, 'DELETE FROM notification_reads WHERE notification_id=?').run(open.id);
          return { id: open.id, changed: true };
        }
      }
      const id = Number(prepared(this.db, `INSERT INTO notifications(audience, account_id, kind, tone, title, detail, link, key, created_at, updated_at)
        VALUES(@who, @account, @kind, @tone, @title, @detail, @link, @key, @now, @now)`).run({ ...values, who, account, key: n.key ?? null, now }).lastInsertRowid);
      return { id, changed: true };
    })();
  }

  // Closes an open condition. With a resolution the row turns into it (a success, shown as unread again); without one it
  // only stops being open. False when no condition with that key was open.
  resolve(to: NotificationTarget, key: string, resolution?: Resolution): boolean {
    const { audience: who, account } = audience(to), now = this.now();
    return this.db.transaction(() => {
      const open = prepared(this.db, `SELECT id FROM notifications WHERE audience=? AND IFNULL(account_id,'')=? AND key=? AND resolved_at IS NULL`)
        .get(who, account ?? '', key) as { id: number } | undefined;
      if (!open) return false;
      if (resolution) {
        prepared(this.db, `UPDATE notifications SET tone='success', title=?, detail=?, resolved_at=?, updated_at=? WHERE id=?`)
          .run(resolution.title, resolution.detail ?? null, now, now, open.id);
        prepared(this.db, 'DELETE FROM notification_reads WHERE notification_id=?').run(open.id);
      } else prepared(this.db, 'UPDATE notifications SET resolved_at=?, updated_at=? WHERE id=?').run(now, now, open.id);
      return true;
    })();
  }

  // Newest first. `since`: only rows added or changed after it, for a page catching up after a live event.
  list(account: string, admin: boolean, since = 0, limit = LIST_LIMIT): NotificationList {
    const args = { account, admin: admin ? 1 : 0 };
    const rows = prepared(this.db, `SELECT n.*, r.read_at ${VISIBLE} AND n.updated_at>@since ORDER BY n.updated_at DESC, n.id DESC LIMIT @limit`)
      .all({ ...args, since, limit }) as Raw[];
    const { unread } = prepared(this.db, `SELECT COUNT(*) AS unread ${VISIBLE} AND r.read_at IS NULL`).get(args) as { unread: number };
    return { items: rows.map(item), unread };
  }

  // Marks rows read for this account: the ids given, or every row it sees. Returns how many were unread.
  markRead(account: string, admin: boolean, ids: number[] | 'all'): number {
    return this.upsert(account, admin, ids, false, 'read_at=COALESCE(notification_reads.read_at, excluded.read_at)', 'AND r.read_at IS NULL');
  }
  // Hides a row from this account's list (others' lists keep a shared admin row).
  dismiss(account: string, admin: boolean, id: number): boolean {
    return this.upsert(account, admin, [id], true, 'dismissed=1, read_at=COALESCE(notification_reads.read_at, excluded.read_at)', '') > 0;
  }
  // Clear all: hides every row this account sees. An open condition comes back if what it says changes. Returns how many.
  dismissAll(account: string, admin: boolean): number {
    return this.upsert(account, admin, 'all', true, 'dismissed=1, read_at=COALESCE(notification_reads.read_at, excluded.read_at)', '');
  }
  private upsert(account: string, admin: boolean, ids: number[] | 'all', dismissed: boolean, set: string, only: string) {
    const now = this.now(), args = { account, admin: admin ? 1 : 0, now, dismissed: dismissed ? 1 : 0 };
    return this.db.transaction(() => {
      const chosen = ids === 'all' ? '' : ids.length ? `AND n.id IN (${ids.map(id => Number(id)).filter(Number.isSafeInteger).join(',') || 'NULL'})` : 'AND 0';
      // Ids vary per call, so this statement is not shared through `prepared`.
      return this.db.prepare(`INSERT INTO notification_reads(notification_id, account_id, read_at, dismissed)
        SELECT n.id, @account, @now, @dismissed ${VISIBLE} ${chosen} ${only}
        ON CONFLICT(notification_id, account_id) DO UPDATE SET ${set}`).run(args).changes;
    })();
  }

  // Drops rows older than KEEP_MS, and past KEEP_ROWS per account (and for the admins' shared list), oldest first.
  // Open conditions stay. Returns how many went.
  prune(): number {
    return this.db.transaction(() => {
      const old = prepared(this.db, `DELETE FROM notifications WHERE updated_at<? AND ${PRUNABLE}`).run(this.now() - KEEP_MS).changes;
      const over = prepared(this.db, `DELETE FROM notifications WHERE id IN (SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY audience, IFNULL(account_id,'') ORDER BY updated_at DESC, id DESC) AS place
          FROM notifications WHERE ${PRUNABLE}) WHERE place>?)`).run(KEEP_ROWS).changes;
      return old + over;
    })();
  }
}
