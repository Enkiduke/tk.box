import type Database from 'better-sqlite3';

// Prepared statements by SQL text, one cache per connection and shared by every store on it, so a query is parsed once
// instead of on every call. Only for SQL built from constants or fixed fragments; the cap is a guard against SQL that
// varies per call (it is cleared, not grown). Don't call .pluck(), .raw(), .expand() or .safeIntegers() on a shared
// statement (that changes it for every caller), and don't run one again while its .iterate() is still open.
const caches = new WeakMap<Database.Database, Map<string, Database.Statement>>();
const LIMIT = 1000;

export function prepared(db: Database.Database, sql: string) {
  let cache = caches.get(db);
  if (!cache) caches.set(db, cache = new Map());
  let statement = cache.get(sql);
  if (!statement) {
    if (cache.size >= LIMIT) cache.clear();
    cache.set(sql, statement = db.prepare(sql));
  }
  return statement;
}
