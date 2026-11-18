import { join } from 'node:path';
import { loadConfig } from '../apps/server/src/config.js';
import { openMigratedDatabase } from '../apps/server/src/modules/migrations/index.js';
import { Vault } from '../apps/server/src/security/vault.js';
// The vault lets a migration that re-seals a value run (artwork's TMDB key move).
const c = loadConfig(), vault = Vault.fromFile(c.SECRET_KEY_FILE ?? join(c.DATA_DIR, 'secret.key'), !c.SECRET_KEY_FILE);
const db = openMigratedDatabase(join(c.DATA_DIR,'tk.box.sqlite'), vault);
const rows = db.prepare('SELECT owner,COUNT(*) AS n FROM schema_migrations GROUP BY owner ORDER BY owner').all() as {owner:string; n:number}[];
db.close(); console.log(`SQLite schema is current (${rows.map(r => `${r.owner} ${r.n}`).join(', ')}).`);
