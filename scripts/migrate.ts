import { join } from 'node:path';
import { loadConfig } from '../apps/server/src/config.js';
import { openMigratedDatabase } from '../apps/server/src/modules/migrations/index.js';
const c = loadConfig(), db = openMigratedDatabase(join(c.DATA_DIR,'tk.box.sqlite'));
const rows = db.prepare('SELECT owner,COUNT(*) AS n FROM schema_migrations GROUP BY owner ORDER BY owner').all() as {owner:string; n:number}[];
db.close(); console.log(`SQLite schema is current (${rows.map(r => `${r.owner} ${r.n}`).join(', ')}).`);
