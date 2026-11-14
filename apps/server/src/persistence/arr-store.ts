import { z } from 'zod';
import type { Db } from './database.js';
import type { Vault } from '../security/vault.js';
import { AppError } from '../errors.js';
import { prepared } from './statements.js';
import type { ArrService } from '../providers/arr-tags.js';

// The one Radarr and one Sonarr tk.box talks to: Calendar, Collections' seasonal downloads, Clean Up and requests all
// read them here. Keys are sealed.
export const arrNames = ['radarr', 'sonarr'] as const;
export type ArrName = typeof arrNames[number];
const origin = z.string().trim().max(300).refine(value => { if (!value) return true; try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; } catch { return false; } }, 'Use an http(s) address').transform(value => value.replace(/\/+$/, ''));
// Omitted keeps a saved key; an empty string removes it.
export const arrConnectionInput = z.object({ url: origin, key: z.string().trim().max(200).regex(/^[\w-]*$/).optional() }).strict();
type Row = { revision: number; url: string; sealed_key: string | null; key_context: string | null };

export class ArrStore {
  constructor(private db: Db, private vault: Vault) {}
  private row(name: ArrName) { return prepared(this.db, 'SELECT revision,url,sealed_key,key_context FROM arr_connections WHERE name=?').get(name) as Row | undefined; }
  connection(name: ArrName): ArrService {
    const row = this.row(name);
    return { url: row?.url ?? '', ...(row?.sealed_key && row.key_context ? { key: this.vault.open(row.sealed_key, row.key_context) } : {}) };
  }
  // What Admin › Connections shows: never the keys themselves.
  view() {
    return Object.fromEntries(arrNames.map(name => { const row = this.row(name); return [name, { revision: row?.revision ?? 0, url: row?.url ?? '', keySet: !!row?.sealed_key }]; })) as Record<ArrName, { revision: number; url: string; keySet: boolean }>;
  }
  update(actor: string, name: ArrName, expectedRevision: number, input: z.input<typeof arrConnectionInput>, now = Date.now()) {
    const { url, key } = arrConnectionInput.parse(input);
    return this.db.transaction(() => {
      const row = this.row(name), revision = row?.revision ?? 0;
      if (revision !== expectedRevision) throw new AppError('REVISION_CONFLICT', 'Connections changed. Reload and retry.', 409);
      const context = `arr:${name}-key`;
      const [sealed, sealedWith] = key === undefined ? [row?.sealed_key ?? null, row?.key_context ?? null] : key ? [this.vault.seal(key, context), context] : [null, null];
      prepared(this.db, 'INSERT INTO arr_connections VALUES(?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET revision=excluded.revision,url=excluded.url,sealed_key=excluded.sealed_key,key_context=excluded.key_context')
        .run(name, revision + 1, url, sealed, sealedWith);
      prepared(this.db, 'INSERT INTO audit(actor,event,at,detail) VALUES(?,?,?,?)').run(actor, 'arr_connection_changed', now, JSON.stringify({ name, url, keySet: !!sealed }));
      return this.view()[name];
    })();
  }
}
