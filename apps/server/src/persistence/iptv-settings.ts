import { z } from 'zod';
import type { Db } from './database.js';
import { AppError } from '../errors.js';

// Server-wide IPTV settings. `maxConnections` is the provider's simultaneous stream limit, shared by
// every source, viewer and channel check.
export const iptvSettings = z.object({ maxConnections: z.number().int().min(1).max(16) }).strict();
export type IptvSettings = z.infer<typeof iptvSettings>;
const DEFAULT_SETTINGS: IptvSettings = { maxConnections: 1 };

export class IptvSettingsStore {
  constructor(private db: Db) {}
  get() {
    const row = this.db.prepare('SELECT revision,value FROM iptv_settings WHERE id=1').get() as { revision: number; value: string } | undefined;
    return { revision: row?.revision ?? 0, ...(row ? iptvSettings.parse({ ...DEFAULT_SETTINGS, ...JSON.parse(row.value) }) : DEFAULT_SETTINGS) };
  }
  update(actor: string, expectedRevision: number, value: IptvSettings, now = Date.now()) {
    const valid = iptvSettings.parse(value);
    return this.db.transaction(() => {
      const current = this.get().revision;
      if (current !== expectedRevision) throw new AppError('REVISION_CONFLICT', 'Settings changed. Reload and retry.', 409);
      this.db.prepare('INSERT INTO iptv_settings VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value=excluded.value').run(current + 1, JSON.stringify(valid));
      this.db.prepare('INSERT INTO audit(actor,event,at,detail) VALUES(?,?,?,?)').run(actor, 'iptv_settings_changed', now, JSON.stringify(valid));
      return this.get();
    })();
  }
}
