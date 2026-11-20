import type { Migration } from '../../persistence/migrate.js';
import { builtInRows, isBuiltInRow, sameRowDef } from '../../../../../packages/contracts/src/explore-rows.js';
import { legacyLayout, legacyRowDef } from '../../services/explore/legacy.js';

// Rows become definitions in one order (persistence/explore-store.ts): the old source order, hidden sources and rows,
// TMDB row order and ranking settings are converted with the same effect, then the old record goes.
function rows(db: import('better-sqlite3').Database) {
  db.exec(`CREATE TABLE explore_rows(key TEXT PRIMARY KEY, position INTEGER, shown INTEGER NOT NULL DEFAULT 1, definition TEXT, revision INTEGER NOT NULL DEFAULT 0)`);
  const saved = db.prepare('SELECT value FROM explore_layout WHERE id=1').get() as { value: string } | undefined;
  let value: unknown;
  try { value = saved ? JSON.parse(saved.value) : undefined; } catch { value = undefined; }
  const layout = legacyLayout(value), insert = db.prepare('INSERT OR IGNORE INTO explore_rows VALUES(?,?,?,?,0)');
  let position = 0;
  for (const source of layout.order) {
    const off = layout.hidden.includes(source);
    if (source === 'plex') {
      insert.run('plex:*', position++, off ? 0 : 1, null);
      continue;
    }
    const ids = [...(layout.tmdbOrder ?? []).filter(isBuiltInRow), ...Object.keys(builtInRows).filter(id => !layout.tmdbOrder?.includes(id))];
    for (const id of [...new Set(ids)].filter(isBuiltInRow)) {
      const options = layout.ranking?.[id];
      let def;
      try { def = options && typeof options === 'object' ? legacyRowDef(id, options as never) : undefined; } catch { def = undefined; }
      insert.run(`tmdb:${id}`, position++, off || layout.hiddenRows.includes(`tmdb:${id}`) ? 0 : 1, def && !sameRowDef(def, builtInRows[id]) ? JSON.stringify(def) : null);
    }
  }
  // Hidden Plex shelves keep their place among Plex's own until Admin › Explore places them.
  for (const key of layout.hiddenRows) if (/^plex:\S+$/.test(key)) insert.run(key, null, 0, null);
  db.exec('DROP TABLE explore_layout');
}

// ExploreStore created these on every start before migrations were per module, so they keep IF NOT EXISTS.
export const exploreMigrations: Migration[] = [
  { name: 'settings-layout', up: `CREATE TABLE IF NOT EXISTS explore_settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS explore_layout(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL);` },
  // Trakt was removed: its links and saved client keys go.
  { name: 'drop-trakt', up: `DROP TABLE IF EXISTS explore_trakt_links;
      UPDATE explore_settings SET value=json_remove(value,'$.traktClientId','$.traktSecret') WHERE json_type(value,'$.traktClientId') IS NOT NULL OR json_type(value,'$.traktSecret') IS NOT NULL;` },
  // Seerr was replaced by tk.box's requests: its address and sealed key, the table's only contents, go.
  { name: 'drop-seerr', up: `DROP TABLE IF EXISTS explore_settings` },
  { name: 'rows', up: rows }
];
