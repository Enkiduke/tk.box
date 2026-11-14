import type Database from 'better-sqlite3';

// A named schema change. `up` is SQL or a function for changes that read the database first. Names are recorded per
// owner (`core` or a module's name) in schema_migrations and never run twice, so a migration is never edited once
// shipped: a later change is a new migration after it.
// `legacy` is the number the change had in the old single `migrations(version)` list; a database that already recorded
// that number has the change, so it is marked applied without running.
export type Migration = { name: string; legacy?: number; up: string | ((db: Database.Database) => void) };

// Applies the owner's migrations not yet recorded, in list order, in one transaction: all of them or none.
export function migrate(db: Database.Database, owner: string, migrations: readonly Migration[]) {
  const names = new Set<string>();
  for (const m of migrations) {
    if (names.has(m.name)) throw new Error(`Migrations of ${owner}: ${m.name} is listed twice.`);
    names.add(m.name);
  }
  db.transaction(() => {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(owner TEXT NOT NULL, name TEXT NOT NULL, applied_at INTEGER NOT NULL, PRIMARY KEY(owner,name))');
    const applied = new Set((db.prepare('SELECT name FROM schema_migrations WHERE owner=?').all(owner) as { name: string }[]).map(r => r.name));
    const legacyTable = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='migrations'").get();
    const hasLegacy = (version: number) => legacyTable && !!db.prepare('SELECT 1 FROM migrations WHERE version=?').get(version);
    const record = db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)');
    for (const m of migrations) {
      if (applied.has(m.name)) continue;
      if (m.legacy === undefined || !hasLegacy(m.legacy)) {
        if (typeof m.up === 'string') db.exec(m.up); else m.up(db);
      }
      record.run(owner, m.name, Date.now());
    }
  })();
}
