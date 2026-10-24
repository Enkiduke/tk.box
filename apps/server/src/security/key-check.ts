import type { Db } from '../persistence/database.js';
import { AppError } from '../errors.js';
import type { Vault } from './vault.js';

const CONTEXT = 'key-check';
// Sealed values an install may already hold, with the context each was sealed under, to vouch for the key the first time.
const samples: { table: string; query: string; context: (row: Record<string, string>) => string; value: string }[] = [
  { table: 'service_keys', query: 'SELECT name,sealed FROM service_keys LIMIT 1', context: r => `service-key:${r.name}`, value: 'sealed' },
  { table: 'iptv_sources', query: 'SELECT id,encrypted_endpoint FROM iptv_sources WHERE encrypted_endpoint IS NOT NULL LIMIT 1', context: r => `iptv:endpoint:${r.id}`, value: 'encrypted_endpoint' },
  { table: 'sessions', query: 'SELECT hash,encrypted_credential FROM sessions LIMIT 1', context: r => r.hash!, value: 'encrypted_credential' }
];

// Proves the key opens this database's sealed values before anything reads them, so a key from another install (or a
// fresh one made after the real key went missing) stops startup with a clear reason instead of failing feature by
// feature. The database keeps a sealed marker; an install from before the marker is checked against a value it holds.
export function checkKey(db: Db, vault: Vault) {
  db.exec('CREATE TABLE IF NOT EXISTS key_check(id INTEGER PRIMARY KEY CHECK(id=1), sealed TEXT NOT NULL)');
  const opens = (sealed: string, context: string) => { try { vault.open(sealed, context); return true; } catch { return false; } };
  const marker = db.prepare('SELECT sealed FROM key_check WHERE id=1').get() as { sealed: string } | undefined;
  if (marker) { if (!opens(marker.sealed, CONTEXT)) throw mismatch(); return; }
  for (const sample of samples) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(sample.table)) continue;
    const row = db.prepare(sample.query).get() as Record<string, string> | undefined;
    if (!row) continue;
    if (!opens(row[sample.value]!, sample.context(row))) throw mismatch();
    break;
  }
  db.prepare('INSERT OR IGNORE INTO key_check VALUES(1,?)').run(vault.seal('tk.box', CONTEXT));
}
const mismatch = () => new AppError('SECRET_KEY_MISMATCH', 'The encryption key cannot decrypt this database. SECRET_KEY_FILE or DATA_DIR points at another install’s key, or the key was replaced. Use the key that belongs to this data folder.', 500);
