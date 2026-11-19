import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './database.js';
import { prepared } from './statements.js';
import type { Member } from '../services/collections/rules.js';

// What the collections engine keeps between runs (artwork module, migration collections-tables): the collections the last
// applying run kept, the movies collections downloaded with the collections that wanted each (the journal), and the
// Discover index. Small values (when the index was built, the rotating lists' sizes, the downloads waiting for the
// library) are in artwork_state.
export type KeptRow = { name: string; library: string; kind: 'franchise' | 'streaming' | 'custom'; items: number; rating_key?: string; off?: boolean };
export type KeptCollections = { updated: string | null; collections: KeptRow[] };
export type IndexPart = { id: number; title: string; release_date: string };
export type IndexCollection = { name: string; parts: IndexPart[]; checkedAt: number };
export type IndexUniverse = { members: Member[]; checkedAt: number; imdbSeries: boolean };
export type Acquisitions = { add: number[]; remove: number[] };

export class CollectionsStore {
  constructor(private db: Db) {}
  private state<T>(key: string): T | undefined { const row = prepared(this.db, 'SELECT value FROM artwork_state WHERE key=?').get(key) as { value: string } | undefined; return row && JSON.parse(row.value) as T; }
  private setState(key: string, value: unknown) {
    if (value === undefined) prepared(this.db, 'DELETE FROM artwork_state WHERE key=?').run(key);
    else prepared(this.db, 'INSERT INTO artwork_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }

  kept(): KeptCollections {
    const rows = prepared(this.db, 'SELECT name,library,kind,items,rating_key,off FROM artwork_kept_collections ORDER BY position').all() as { name: string; library: string; kind: KeptRow['kind']; items: number; rating_key: string | null; off: number }[];
    return { updated: this.state<string>('collections:kept-updated') ?? null,
      collections: rows.map(r => ({ name: r.name, library: r.library, kind: r.kind, items: r.items, ...(r.rating_key ? { rating_key: r.rating_key } : {}), ...(r.off ? { off: true } : {}) })) };
  }
  // What an applying run kept: for the Collections page, and so the next run knows which Plex collections are tk.box's
  // to delete once they're removed or no longer qualify.
  setKept(rows: KeptRow[], today = new Date()) {
    const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
    const sorted = [...rows].sort((a, b) => cmp(a.kind, b.kind) || cmp(a.library, b.library) || cmp(a.name.toLowerCase(), b.name.toLowerCase()));
    this.db.transaction(() => {
      prepared(this.db, 'DELETE FROM artwork_kept_collections').run();
      const insert = prepared(this.db, 'INSERT INTO artwork_kept_collections VALUES(?,?,?,?,?,?,?)');
      sorted.forEach((r, i) => insert.run(r.library, r.name, r.kind, r.items, r.rating_key ?? null, r.off ? 1 : 0, i));
      this.setState('collections:kept-updated', `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`);
    })();
  }

  // The journal: each downloaded movie and the collections ("library:key") that wanted it.
  downloads() {
    return new Map((prepared(this.db, 'SELECT tmdb_id,owners FROM artwork_collection_downloads').all() as { tmdb_id: number; owners: string }[]).map(r => [r.tmdb_id, JSON.parse(r.owners) as string[]]));
  }
  listSizes() { return this.state<Record<string, number>>('collections:list-sizes') ?? {}; }
  // A run's changes to the journal and the downloads the library is to add and remove, in one transaction: the library
  // takes them after the job (takeAcquisitions), so a crash between the two can't lose or repeat one.
  saveDownloads(downloads: Map<number, string[]>, listSizes: Record<string, number>, acquire: Acquisitions) {
    this.db.transaction(() => {
      prepared(this.db, 'DELETE FROM artwork_collection_downloads').run();
      const insert = prepared(this.db, 'INSERT INTO artwork_collection_downloads VALUES(?,?)');
      for (const [id, owners] of downloads) insert.run(id, JSON.stringify(owners));
      this.setState('collections:list-sizes', listSizes);
      if (acquire.add.length || acquire.remove.length) {
        const waiting = this.state<Acquisitions>('collections:acquire') ?? { add: [], remove: [] };
        this.setState('collections:acquire', { add: [...new Set([...waiting.add, ...acquire.add])], remove: [...new Set([...waiting.remove, ...acquire.remove])] });
      }
    })();
  }
  takeAcquisitions(): Acquisitions {
    return this.db.transaction(() => { const found = this.state<Acquisitions>('collections:acquire') ?? { add: [], remove: [] }; this.setState('collections:acquire', undefined); return found; })();
  }

  // Discover's index.
  indexBuilt() { return this.state<number>('discover:built') ?? null; }
  setIndexBuilt(at: number) { this.setState('discover:built', at); }
  indexMovies() {
    return new Map((prepared(this.db, 'SELECT tmdb_id,collection_id,checked_at FROM artwork_discover_movies').all() as { tmdb_id: number; collection_id: number | null; checked_at: number }[])
      .map(r => [r.tmdb_id, { collection: r.collection_id, checkedAt: r.checked_at }]));
  }
  setIndexMovie(tmdbId: number, collection: number | null, at: number) {
    prepared(this.db, 'INSERT INTO artwork_discover_movies VALUES(?,?,?) ON CONFLICT(tmdb_id) DO UPDATE SET collection_id=excluded.collection_id,checked_at=excluded.checked_at').run(tmdbId, collection, at);
  }
  indexCollections() {
    return new Map((prepared(this.db, 'SELECT id,name,parts,checked_at FROM artwork_discover_collections').all() as { id: number; name: string; parts: string; checked_at: number }[])
      .map(r => [r.id, { name: r.name, parts: JSON.parse(r.parts) as IndexPart[], checkedAt: r.checked_at } satisfies IndexCollection]));
  }
  setIndexCollection(id: number, name: string, parts: IndexPart[], at: number) {
    prepared(this.db, 'INSERT INTO artwork_discover_collections VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,parts=excluded.parts,checked_at=excluded.checked_at').run(id, name, JSON.stringify(parts), at);
  }
  indexUniverses() {
    return new Map((prepared(this.db, 'SELECT key,members,checked_at,imdb_series FROM artwork_discover_universes').all() as { key: string; members: string; checked_at: number; imdb_series: number }[])
      .map(r => [r.key, { members: JSON.parse(r.members) as Member[], checkedAt: r.checked_at, imdbSeries: !!r.imdb_series } satisfies IndexUniverse]));
  }
  setIndexUniverse(key: string, members: Member[], at: number, imdbSeries: boolean) {
    prepared(this.db, 'INSERT INTO artwork_discover_universes VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET members=excluded.members,checked_at=excluded.checked_at,imdb_series=excluded.imdb_series').run(key, JSON.stringify(members), at, imdbSeries ? 1 : 0);
  }
  // Movies no longer in Plex leave the index, and so do collections none of them is in.
  pruneIndex(movies: Set<number>, collections: Set<number>) {
    this.db.transaction(() => {
      for (const id of this.indexMovies().keys()) if (!movies.has(id)) prepared(this.db, 'DELETE FROM artwork_discover_movies WHERE tmdb_id=?').run(id);
      for (const id of this.indexCollections().keys()) if (!collections.has(id)) prepared(this.db, 'DELETE FROM artwork_discover_collections WHERE id=?').run(id);
    })();
  }

  // Files an older tk.box kept these in, imported once each and then deleted. A journal that can't be read is left in
  // place, and acquisition refuses to run until it is restored (`journalBroken`).
  importFiles(dir: string, log: (message: string, detail: Record<string, unknown>) => void = () => {}) {
    const read = (name: string) => { const file = join(dir, name); return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, any> : undefined; };
    const once = (flag: string, file: string, run: () => void) => {
      if (!this.state<boolean>(flag)) {
        try { run(); this.setState(flag, true); }
        catch (e) { log('a collections file could not be imported', { flag, error: (e as Error).message }); return; }
      }
      try { rmSync(join(dir, file), { force: true }); } catch (e) { log('an imported collections file could not be deleted', { file, error: (e as Error).message }); }
    };
    once('import:acquire', 'collections-acquire.json', () => {
      const file = read('collections-acquire.json'), ids = (v: unknown) => Array.isArray(v) ? v.filter((n): n is number => Number.isSafeInteger(n) && n > 0) : [];
      if (file) this.saveDownloads(this.downloads(), this.listSizes(), { add: ids(file.tmdb_ids), remove: ids(file.remove_ids) });
    });
    once('import:kept', 'kept_collections.json', () => {
      const file = read('kept_collections.json'), rows = Array.isArray(file?.collections) ? file!.collections as KeptRow[] : [];
      const valid = rows.filter(r => r && typeof r.name === 'string' && typeof r.library === 'string' && ['franchise', 'streaming', 'custom'].includes(r.kind));
      if (!valid.length) return;
      this.setKept(valid.map(r => ({ ...r, items: Number(r.items) || 0 })));
      if (typeof file?.updated === 'string') this.setState('collections:kept-updated', file.updated);
    });
    once('import:journal', 'collections-tkbox.json', () => {
      let file: Record<string, any> | undefined;
      try { file = read('collections-tkbox.json'); }
      catch { this.setState('collections:journal-broken', true); throw new Error('collections-tkbox.json is unreadable'); }
      if (!file) return;
      if (file.version !== 1 || typeof file.movies !== 'object' || file.movies === null) { this.setState('collections:journal-broken', true); throw new Error('collections-tkbox.json is invalid'); }
      const downloads = new Map<number, string[]>();
      for (const [id, record] of Object.entries(file.movies as Record<string, { owners?: unknown }>))
        if (/^\d{1,10}$/.test(id) && Array.isArray(record?.owners)) downloads.set(Number(id), record.owners.filter((o): o is string => typeof o === 'string'));
      this.db.transaction(() => {
        prepared(this.db, 'DELETE FROM artwork_collection_downloads').run();
        const insert = prepared(this.db, 'INSERT INTO artwork_collection_downloads VALUES(?,?)');
        for (const [id, owners] of downloads) insert.run(id, JSON.stringify(owners));
        this.setState('collections:list-sizes', typeof file!.lists === 'object' && file!.lists ? file!.lists : {});
        this.setState('collections:journal-broken', undefined);
      })();
    });
    once('import:discover-index', 'discover-index.json', () => {
      const file = read('discover-index.json');
      if (!file || file.version !== 1) return;
      const seconds = (value: unknown) => typeof value === 'number' ? Math.round(value * 1000) : 0;
      this.db.transaction(() => {
        for (const [id, entry] of Object.entries((file.movies ?? {}) as Record<string, [number | null, number]>))
          if (/^\d+$/.test(id) && Array.isArray(entry)) this.setIndexMovie(Number(id), entry[0] || null, seconds(entry[1]));
        for (const [id, entry] of Object.entries((file.collections ?? {}) as Record<string, { name: string; parts: IndexPart[]; read: number }>))
          if (/^\d+$/.test(id) && entry && Array.isArray(entry.parts)) this.setIndexCollection(Number(id), String(entry.name), entry.parts, seconds(entry.read));
        for (const [key, entry] of Object.entries((file.universes ?? {}) as Record<string, { members: Member[]; read: number; imdb_series?: boolean }>))
          if (entry && Array.isArray(entry.members)) this.setIndexUniverse(key, entry.members, seconds(entry.read), !!entry.imdb_series);
        if (typeof file.built === 'number') this.setIndexBuilt(seconds(file.built));
      })();
    });
  }
  journalBroken() { return !!this.state<boolean>('collections:journal-broken'); }
}
