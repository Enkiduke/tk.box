import { join } from 'node:path';
import { loadConfig } from '../apps/server/src/config.js';
import { openDatabase } from '../apps/server/src/persistence/database.js';
const c = loadConfig(), db = openDatabase(join(c.DATA_DIR,'tk.box.sqlite'));
const row=db.prepare('SELECT MAX(version) AS version FROM migrations').get() as {version:number};
db.close(); console.log(`SQLite schema is current (version ${row.version}).`);
