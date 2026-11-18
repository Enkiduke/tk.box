import { z } from 'zod';
import type { Db } from './database.js';
import type { Vault } from '../security/vault.js';

// Keys for outside services that no feature's own settings hold (Admin › Connections), sealed. Keys are kept here,
// never in the environment.
export const SERVICE_KEYS = ['thesportsdb', 'plex', 'tmdb', 'tvdb', 'fanart', 'mdblist'] as const;
// The metadata and artwork providers (Admin › Connections › Metadata & artwork).
export const PROVIDER_KEYS = ['tmdb', 'tvdb', 'fanart', 'mdblist'] as const;
export type ProviderKeys = Partial<Record<typeof PROVIDER_KEYS[number], string>>;
export type ServiceKey = typeof SERVICE_KEYS[number];
// Omitted keeps a saved key; an empty string removes it. `plex` is the server owner's Plex token, which background
// work reads Plex with (services/plex-background.ts). `tmdb` is the TMDB key every module reads through ctx.tmdb; `tvdb`,
// `fanart` and `mdblist` are Artwork's and Collections' providers.
const key = z.string().trim().max(200).regex(/^[\w-]*$/).optional();
export const serviceKeysInput = z.object({ thesportsdb: key, plex: key, tmdb: key, tvdb: key, fanart: key, mdblist: key }).strict();

export class ServiceKeys {
  constructor(private db: Db, private vault: Vault) {}
  get(name: ServiceKey) {
    const row = this.db.prepare('SELECT sealed FROM service_keys WHERE name=?').get(name) as { sealed: string } | undefined;
    return row ? this.vault.open(row.sealed, `service-key:${name}`) : undefined;
  }
  // The saved provider keys (the artwork engine's, title pictures', the connection check's).
  providers(): ProviderKeys { return Object.fromEntries(PROVIDER_KEYS.flatMap(name => { const value = this.get(name); return value ? [[name, value]] : []; })); }
  // What the settings page shows: whether each key is saved, never the key itself.
  view() {
    const saved = new Set((this.db.prepare('SELECT name FROM service_keys').all() as { name: string }[]).map(r => r.name));
    return Object.fromEntries(SERVICE_KEYS.map(name => [name, saved.has(name)])) as Record<ServiceKey, boolean>;
  }
  update(actor: string, input: z.input<typeof serviceKeysInput>, now = Date.now()) {
    const valid = serviceKeysInput.parse(input);
    this.db.transaction(() => {
      for (const name of SERVICE_KEYS) {
        const given = valid[name];
        if (given === undefined) continue;
        if (given) this.db.prepare('INSERT INTO service_keys VALUES(?,?) ON CONFLICT(name) DO UPDATE SET sealed=excluded.sealed').run(name, this.vault.seal(given, `service-key:${name}`));
        else this.db.prepare('DELETE FROM service_keys WHERE name=?').run(name);
        this.db.prepare('INSERT INTO audit(actor,event,at,detail) VALUES(?,?,?,?)').run(actor, 'service_key_changed', now, JSON.stringify({ name, set: !!given }));
      }
    })();
    return this.view();
  }
}
