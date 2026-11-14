import { openDatabase, type Db } from '../../persistence/database.js';
import { migrate, type Migration } from '../../persistence/migrate.js';
import { watchHistoryMigrations } from './watch-history.js';
import { customChannelsMigrations } from './custom-channels.js';
import { iptvMigrations } from './iptv.js';
import { artworkMigrations } from './artwork.js';
import { exploreMigrations } from './explore.js';
import { cleanupMigrations } from './cleanup.js';

// Every module's migrations by module name, in mount order. mountModule runs a module's own as it mounts; this list
// lets tests and scripts get the full schema without mounting (tests/migrations.test.ts checks it matches the modules).
export const moduleMigrations: Readonly<Record<string, readonly Migration[]>> = {
  'watch-history': watchHistoryMigrations,
  'custom-channels': customChannelsMigrations,
  iptv: iptvMigrations,
  artwork: artworkMigrations,
  explore: exploreMigrations,
  cleanup: cleanupMigrations
};

export function migrateModules(db: Db) {
  for (const [owner, migrations] of Object.entries(moduleMigrations)) migrate(db, owner, migrations);
  return db;
}

// The database with every module's tables, for code that uses stores without mounting their modules.
export const openMigratedDatabase = (path: string) => migrateModules(openDatabase(path));
