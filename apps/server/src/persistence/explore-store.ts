import { z } from 'zod';
import type { Db } from './database.js';
import type { Vault } from '../security/vault.js';
import { AppError } from '../errors.js';

// Explore's server-wide connections (the Seerr address, the Trakt app registration) and each viewer's Trakt link.
// Secrets are sealed: the Trakt client secret and every viewer's Trakt tokens.
const origin = z.string().trim().max(300).refine(value => {
  if (!value) return true;
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; } catch { return false; }
}, 'Use an http(s) address without a query or credentials').transform(value => value.replace(/\/+$/, ''));
export const exploreSettingsInput = z.object({
  seerrUrl: origin,
  // Omitted keeps the saved key; an empty string removes it.
  seerrApiKey: z.string().trim().max(200).regex(/^[\w=+/-]*$/).optional(),
  traktClientId: z.string().trim().max(100).regex(/^[\w-]*$/),
  // Omitted keeps the saved secret; an empty string removes it.
  traktClientSecret: z.string().trim().max(100).regex(/^[\w-]*$/).optional()
}).strict();
export type ExploreSettingsInput = z.infer<typeof exploreSettingsInput>;
type Stored = { seerrUrl: string; seerrKey?: string; traktClientId: string; traktSecret?: string };
export type TraktTokens = { access: string; refresh: string; expires: number };

export class ExploreStore {
  constructor(private db: Db, private vault: Vault) {
    db.exec(`CREATE TABLE IF NOT EXISTS explore_settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS explore_trakt_links(account_id TEXT PRIMARY KEY REFERENCES users(account_id), encrypted_tokens TEXT NOT NULL, username TEXT, updated_at INTEGER NOT NULL);`);
  }
  private stored() {
    const row = this.db.prepare('SELECT revision,value FROM explore_settings WHERE id=1').get() as { revision: number; value: string } | undefined;
    return { revision: row?.revision ?? 0, value: row ? JSON.parse(row.value) as Stored : { seerrUrl: '', traktClientId: '' } };
  }
  // What the settings page shows: never the secret itself.
  view() { const { revision, value } = this.stored(); return { revision, seerrUrl: value.seerrUrl, seerrKeySet: !!value.seerrKey, traktClientId: value.traktClientId, traktSecretSet: !!value.traktSecret }; }
  seerr() { const { value } = this.stored(); return value.seerrUrl ? { url: value.seerrUrl, ...(value.seerrKey ? { apiKey: this.vault.open(value.seerrKey, 'explore:seerr-key') } : {}) } : undefined; }
  // The saved key, for checking a new address with it before saving.
  seerrKey() { const { value } = this.stored(); return value.seerrKey ? this.vault.open(value.seerrKey, 'explore:seerr-key') : undefined; }
  trakt() {
    const { value } = this.stored();
    return value.traktClientId && value.traktSecret ? { clientId: value.traktClientId, secret: this.vault.open(value.traktSecret, 'explore:trakt-secret') } : undefined;
  }
  update(actor: string, expectedRevision: number, input: ExploreSettingsInput, now = Date.now()) {
    const valid = exploreSettingsInput.parse(input);
    return this.db.transaction(() => {
      const { revision, value } = this.stored();
      if (revision !== expectedRevision) throw new AppError('REVISION_CONFLICT', 'Settings changed. Reload and retry.', 409);
      const secret = valid.traktClientSecret === undefined ? value.traktSecret : valid.traktClientSecret ? this.vault.seal(valid.traktClientSecret, 'explore:trakt-secret') : undefined;
      const key = valid.seerrApiKey === undefined ? value.seerrKey : valid.seerrApiKey ? this.vault.seal(valid.seerrApiKey, 'explore:seerr-key') : undefined;
      const next: Stored = { seerrUrl: valid.seerrUrl, ...(key ? { seerrKey: key } : {}), traktClientId: valid.traktClientId, ...(secret ? { traktSecret: secret } : {}) };
      this.db.prepare('INSERT INTO explore_settings VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value=excluded.value').run(revision + 1, JSON.stringify(next));
      this.db.prepare('INSERT INTO audit(actor,event,at,detail) VALUES(?,?,?,?)').run(actor, 'explore_settings_changed', now, JSON.stringify({ seerrUrl: next.seerrUrl, seerrKeySet: !!key, traktClientId: next.traktClientId, traktSecretSet: !!secret }));
      // Another Trakt app cannot use the old app's tokens.
      if (next.traktClientId !== value.traktClientId) this.db.prepare('DELETE FROM explore_trakt_links').run();
      return this.view();
    })();
  }
  traktLink(accountId: string) {
    const row = this.db.prepare('SELECT encrypted_tokens,username FROM explore_trakt_links WHERE account_id=?').get(accountId) as { encrypted_tokens: string; username: string | null } | undefined;
    return row && { tokens: JSON.parse(this.vault.open(row.encrypted_tokens, `trakt:${accountId}`)) as TraktTokens, username: row.username ?? undefined };
  }
  saveTraktLink(accountId: string, tokens: TraktTokens, username?: string, now = Date.now()) {
    this.db.prepare(`INSERT INTO explore_trakt_links VALUES(?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET encrypted_tokens=excluded.encrypted_tokens,username=COALESCE(excluded.username,username),updated_at=excluded.updated_at`)
      .run(accountId, this.vault.seal(JSON.stringify(tokens), `trakt:${accountId}`), username ?? null, now);
  }
  removeTraktLink(accountId: string) { this.db.prepare('DELETE FROM explore_trakt_links WHERE account_id=?').run(accountId); }
}
