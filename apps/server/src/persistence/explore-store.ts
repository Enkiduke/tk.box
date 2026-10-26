import { z } from 'zod';
import type { ExploreLayout } from '../../../../packages/contracts/src/index.js';
import type { Db } from './database.js';
import type { Vault } from '../security/vault.js';
import { AppError } from '../errors.js';

// Explore's server-wide Seerr connection; its API key is sealed.
const origin = z.string().trim().max(300).refine(value => {
  if (!value) return true;
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; } catch { return false; }
}, 'Use an http(s) address without a query or credentials').transform(value => value.replace(/\/+$/, ''));
export const exploreSettingsInput = z.object({
  seerrUrl: origin,
  // Omitted keeps the saved key; an empty string removes it.
  seerrApiKey: z.string().trim().max(200).regex(/^[\w=+/-]*$/).optional()
}).strict();
export type ExploreSettingsInput = z.infer<typeof exploreSettingsInput>;
const exploreSource = z.enum(['plex', 'seerr']);
export const exploreLayoutInput = z.object({
  order: z.array(exploreSource).max(2).refine(list => new Set(list).size === list.length, 'List each source once'),
  hidden: z.array(exploreSource).max(2),
  hiddenRows: z.array(z.string().max(820).regex(/^(plex|seerr):\S+$/)).max(300)
}).strict();
export const defaultExploreLayout: ExploreLayout = { order: ['plex', 'seerr'], hidden: [], hiddenRows: [] };
// A saved order missing a source (or none saved) lists the missing ones last, in the default order. Trakt, which
// Explore no longer reads, is dropped from layouts saved while it did.
export function exploreLayout(value: Partial<ExploreLayout> | undefined): ExploreLayout {
  const drop = (list: unknown) => Array.isArray(list) ? list.filter(s => typeof s !== 'string' || !/^trakt(:|$)/.test(s)) : list;
  const saved = { ...defaultExploreLayout, ...value };
  const parsed = exploreLayoutInput.safeParse({ order: drop(saved.order), hidden: drop(saved.hidden), hiddenRows: drop(saved.hiddenRows) });
  const layout = parsed.success ? parsed.data : defaultExploreLayout;
  return { order: [...layout.order, ...defaultExploreLayout.order.filter(s => !layout.order.includes(s))], hidden: [...new Set(layout.hidden)], hiddenRows: [...new Set(layout.hiddenRows)] };
}
type Stored = { seerrUrl: string; seerrKey?: string };

export class ExploreStore {
  constructor(private db: Db, private vault: Vault) {
    db.exec(`CREATE TABLE IF NOT EXISTS explore_settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS explore_layout(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL);
      DROP TABLE IF EXISTS explore_trakt_links;
      UPDATE explore_settings SET value=json_remove(value,'$.traktClientId','$.traktSecret') WHERE json_type(value,'$.traktClientId') IS NOT NULL OR json_type(value,'$.traktSecret') IS NOT NULL;`);
  }
  private stored() {
    const row = this.db.prepare('SELECT revision,value FROM explore_settings WHERE id=1').get() as { revision: number; value: string } | undefined;
    return { revision: row?.revision ?? 0, value: row ? JSON.parse(row.value) as Stored : { seerrUrl: '' } };
  }
  // What the settings page shows: never the secret itself.
  view() { const { revision, value } = this.stored(); return { revision, seerrUrl: value.seerrUrl, seerrKeySet: !!value.seerrKey }; }
  seerr() { const { value } = this.stored(); return value.seerrUrl ? { url: value.seerrUrl, ...(value.seerrKey ? { apiKey: this.vault.open(value.seerrKey, 'explore:seerr-key') } : {}) } : undefined; }
  // The saved key, for checking a new address with it before saving.
  seerrKey() { const { value } = this.stored(); return value.seerrKey ? this.vault.open(value.seerrKey, 'explore:seerr-key') : undefined; }
  update(actor: string, expectedRevision: number, input: ExploreSettingsInput, now = Date.now()) {
    const valid = exploreSettingsInput.parse(input);
    return this.db.transaction(() => {
      const { revision, value } = this.stored();
      if (revision !== expectedRevision) throw new AppError('REVISION_CONFLICT', 'Settings changed. Reload and retry.', 409);
      const key = valid.seerrApiKey === undefined ? value.seerrKey : valid.seerrApiKey ? this.vault.seal(valid.seerrApiKey, 'explore:seerr-key') : undefined;
      const next: Stored = { seerrUrl: valid.seerrUrl, ...(key ? { seerrKey: key } : {}) };
      this.db.prepare('INSERT INTO explore_settings VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value=excluded.value').run(revision + 1, JSON.stringify(next));
      this.db.prepare('INSERT INTO audit(actor,event,at,detail) VALUES(?,?,?,?)').run(actor, 'explore_settings_changed', now, JSON.stringify({ seerrUrl: next.seerrUrl, seerrKeySet: !!key }));
      return this.view();
    })();
  }
  // How Explore is laid out, apart from the connections so the two are saved separately.
  layout(): ExploreLayout & { revision: number } {
    const row = this.db.prepare('SELECT revision,value FROM explore_layout WHERE id=1').get() as { revision: number; value: string } | undefined;
    return { revision: row?.revision ?? 0, ...exploreLayout(row ? JSON.parse(row.value) as Partial<ExploreLayout> : undefined) };
  }
  updateLayout(actor: string, expectedRevision: number, input: ExploreLayout, now = Date.now()) {
    const next = exploreLayout(exploreLayoutInput.parse(input));
    return this.db.transaction(() => {
      const { revision } = this.layout();
      if (revision !== expectedRevision) throw new AppError('REVISION_CONFLICT', 'Settings changed. Reload and retry.', 409);
      this.db.prepare('INSERT INTO explore_layout VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value=excluded.value').run(revision + 1, JSON.stringify(next));
      this.db.prepare('INSERT INTO audit(actor,event,at,detail) VALUES(?,?,?,?)').run(actor, 'explore_layout_changed', now, JSON.stringify(next));
      return this.layout();
    })();
  }
}
