import { z } from 'zod';
import { exploreGenres } from '../../../../packages/contracts/src/index.js';
import { builtInRows, exploreLanguages, exploreParamBounds, exploreSignal, exploreSignalIds, isBuiltInRow, normalizeRowDef, sameRowDef,
  type ExploreRowDef, type ExploreRowSource } from '../../../../packages/contracts/src/explore-rows.js';
import type { Db } from './database.js';
import { AppError } from '../errors.js';

// Explore's rows, in one order across sources (explore_rows). `tmdb:<id>` rows are the built-in ones (definition null
// until changed) and custom ones (`tmdb:c-…`); `plex:<shelf>` rows are Plex Discover's shelves, which Plex lists
// itself. `plex:*` marks where shelves not placed yet go: shelves Plex adds later appear there, shown as it is.
export const PLEX_SLOT = 'plex:*';
const kind = z.enum(['movie', 'show']), both = z.enum(['movie', 'show', 'both']);
const source = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tmdb-discover'), kind: both, sort: z.enum(['popularity', 'rating', 'newest']), streaming: z.boolean().optional(), unreleased: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('tmdb-trending'), kind: both, window: z.enum(['day', 'week']) }).strict(),
  z.object({ type: z.literal('tmdb-upcoming'), kind }).strict(),
  z.object({ type: z.literal('recommendations'), kind, mode: z.enum(['top', 'because']) }).strict()
]);
const lists: Record<string, readonly string[]> = { genres: exploreGenres, languages: exploreLanguages };
export const exploreRowDefInput = z.object({
  title: z.string().trim().min(1).max(80),
  source,
  signals: z.array(z.object({ id: z.enum(exploreSignalIds), on: z.boolean(),
    params: z.record(z.string().max(20), z.union([z.number().finite(), z.array(z.string().max(20)).max(40)])) }).strict()).max(exploreSignalIds.length)
}).strict().superRefine((def, ctx) => {
  const seen = new Set<string>();
  def.signals.forEach((use, index) => {
    const meta = exploreSignal(use.id), path = ['signals', index];
    if (seen.has(use.id)) ctx.addIssue({ code: 'custom', path, message: 'List each signal once.' });
    seen.add(use.id);
    if (!meta.applies(def.source as ExploreRowSource)) ctx.addIssue({ code: 'custom', path, message: `${meta.label} isn't available for this row.` });
    const values = { ...meta.defaults, ...use.params };
    for (const [id, value] of Object.entries(use.params)) {
      const param = meta.params.find(p => p.id === id);
      if (!param) { ctx.addIssue({ code: 'custom', path: [...path, 'params', id], message: 'Unknown setting.' }); continue; }
      if ('list' in param) {
        if (!Array.isArray(value) || !value.every(v => lists[param.list]!.includes(v))) ctx.addIssue({ code: 'custom', path: [...path, 'params', id], message: `Choose ${param.label.toLowerCase()} from the list.` });
        continue;
      }
      if ('toggle' in param) {
        if (value !== 1) ctx.addIssue({ code: 'custom', path: [...path, 'params', id], message: `${param.label}: save 1, or leave it out.` });
        continue;
      }
      const { min, max, step } = exploreParamBounds(param, values), steps = typeof value === 'number' ? (value - min) / step : NaN;
      if (typeof value !== 'number' || value < min || value > max || Math.abs(steps - Math.round(steps)) > 1e-8)
        ctx.addIssue({ code: 'custom', path: [...path, 'params', id], message: `${meta.label}: use ${min} to ${max}.` });
    }
  });
}).transform(def => normalizeRowDef(def as ExploreRowDef));

// A built-in row keeps its source; only the trending window can change.
const fixedSource = (a: ExploreRowSource, b: ExploreRowSource) => {
  const plain = (s: ExploreRowSource) => JSON.stringify(s.type === 'tmdb-trending' ? { ...s, window: undefined } : s);
  return plain(a) === plain(b);
};
type Stored = { key: string; position: number | null; shown: number; definition: string | null; revision: number };
export type ExploreEntry = { key: string; shown: boolean; revision: number; definition?: ExploreRowDef; builtIn?: boolean; missing?: boolean };
type Shelf = { id: string };

export class ExploreStore {
  constructor(private db: Db) {}
  // The shelves already known, for reordering without asking Plex.
  private storedShelves() { return this.stored().filter(r => r.key.startsWith('plex:') && r.key !== PLEX_SLOT).map(r => ({ id: r.key.slice(5) })); }
  private stored() { return this.db.prepare('SELECT key,position,shown,definition,revision FROM explore_rows').all() as Stored[]; }
  // A TMDB row's definition: saved, or a built-in's own.
  definition(key: string): ExploreRowDef | undefined {
    const row = this.db.prepare('SELECT definition FROM explore_rows WHERE key=?').get(key) as { definition: string | null } | undefined;
    if (row?.definition) return JSON.parse(row.definition) as ExploreRowDef;
    const id = key.slice(5);
    return key.startsWith('tmdb:') && isBuiltInRow(id) ? builtInRows[id] : undefined;
  }
  // Every row in order. Built-in rows not saved yet go last; `shelves` (Plex's, in its order) fill the Plex slot where
  // they have no place of their own, and placed shelves Plex no longer lists are `missing`. Without `shelves`, no Plex rows.
  arrange(shelves?: Shelf[]): (ExploreEntry & { slot?: true })[] {
    const stored = this.stored(), byKey = new Map(stored.map(r => [r.key, r]));
    const placed = stored.filter(r => r.position !== null).sort((a, b) => a.position! - b.position!);
    if (!byKey.has(PLEX_SLOT)) placed.push({ key: PLEX_SLOT, position: null, shown: 1, definition: null, revision: 0 });
    for (const id of Object.keys(builtInRows)) if (!byKey.has(`tmdb:${id}`)) placed.push({ key: `tmdb:${id}`, position: null, shown: 1, definition: null, revision: 0 });
    for (const r of stored) if (r.position === null && r.key.startsWith('tmdb:') && (r.definition || isBuiltInRow(r.key.slice(5)))) placed.push(r);
    const listed = new Set(shelves?.map(s => `plex:${s.id}`));
    const entry = (r: Stored): ExploreEntry => {
      const id = r.key.slice(5), builtIn = r.key.startsWith('tmdb:') && isBuiltInRow(id);
      return { key: r.key, shown: !!r.shown, revision: r.revision, ...(builtIn && { builtIn }),
        ...(r.key.startsWith('tmdb:') && { definition: r.definition ? JSON.parse(r.definition) as ExploreRowDef : builtIn ? builtInRows[id as keyof typeof builtInRows] : undefined }) };
    };
    return placed.flatMap(r => {
      if (r.key === PLEX_SLOT) {
        const fresh = (shelves ?? []).filter(s => byKey.get(`plex:${s.id}`)?.position == null)
          .map(s => { const key = `plex:${s.id}`, saved = byKey.get(key); return { key, shown: saved ? !!saved.shown : !!r.shown, revision: 0 }; });
        return [...fresh, { key: PLEX_SLOT, shown: !!r.shown, revision: 0, slot: true as const }];
      }
      if (r.key.startsWith('plex:')) return shelves ? [{ ...entry(r), ...(!listed.has(r.key) && { missing: true }) }] : [];
      return entry(r).definition ? [entry(r)] : [];
    });
  }
  // Saves the order `arrange` gives (placing shelves that only filled the Plex slot), or `keys` moved to the front in that order.
  private place(entries: { key: string }[]) {
    const upsert = this.db.prepare('INSERT INTO explore_rows(key,position,shown) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET position=excluded.position');
    entries.forEach((e, i) => upsert.run(e.key, i, 1));
  }
  placeShelves(shelves: Shelf[]) {
    this.db.transaction(() => {
      const entries = this.arrange(shelves), stored = new Set(this.stored().filter(r => r.position !== null).map(r => r.key));
      if (entries.every(e => e.slot || stored.has(e.key))) return;
      const keep = this.db.prepare('INSERT INTO explore_rows(key,position,shown) VALUES(?,NULL,?) ON CONFLICT(key) DO NOTHING');
      for (const e of entries) keep.run(e.key, e.shown ? 1 : 0);
      this.place(entries);
    })();
  }
  // A new order: the keys given, each once. The Plex slot follows the last Plex row (or stays last).
  setOrder(actor: string, keys: string[], now = Date.now()) {
    this.db.transaction(() => {
      const all = this.arrange(this.storedShelves()).filter(e => !e.slot).map(e => e.key);
      const order = [...new Set(keys)].filter(k => all.includes(k));
      for (const key of all) if (!order.includes(key)) order.push(key);
      const lastPlex = order.map(k => k.startsWith('plex:')).lastIndexOf(true);
      order.splice(lastPlex < 0 ? order.length : lastPlex + 1, 0, PLEX_SLOT);
      const keep = this.db.prepare('INSERT INTO explore_rows(key,position,shown) VALUES(?,NULL,1) ON CONFLICT(key) DO NOTHING');
      for (const key of order) keep.run(key);
      this.place(order.map(key => ({ key })));
      this.audit(actor, 'explore_rows_ordered', now, { order });
    })();
  }
  setShown(actor: string, key: string, shown: boolean, now = Date.now()) {
    if (key.startsWith('tmdb:')) this.known(key);
    else if (!/^plex:\S+$/.test(key) || key === PLEX_SLOT) throw new AppError('EXPLORE_ROW_MISSING', 'This Explore row is unavailable.', 404);
    this.db.prepare('INSERT INTO explore_rows(key,position,shown) VALUES(?,NULL,?) ON CONFLICT(key) DO UPDATE SET shown=excluded.shown').run(key, shown ? 1 : 0);
    this.audit(actor, 'explore_row_shown', now, { key, shown });
  }
  private known(key: string) {
    const def = this.definition(key);
    if (!def) throw new AppError('EXPLORE_ROW_MISSING', 'This Explore row is unavailable.', 404);
    return def;
  }
  // A TMDB row's definition: a built-in's back to its own with `null`. `expectedRevision` guards against a save in between.
  setDefinition(actor: string, key: string, expectedRevision: number, input: unknown, now = Date.now()) {
    const id = key.slice(5), builtIn = key.startsWith('tmdb:') && isBuiltInRow(id) ? builtInRows[id] : undefined;
    return this.db.transaction(() => {
      this.known(key);
      const revision = (this.db.prepare('SELECT revision FROM explore_rows WHERE key=?').get(key) as { revision: number } | undefined)?.revision ?? 0;
      if (revision !== expectedRevision) throw new AppError('REVISION_CONFLICT', 'Someone saved this first. Reload and retry.', 409);
      let def = input === null ? undefined : exploreRowDefInput.parse(input);
      if (!def && !builtIn) throw new AppError('INVALID_REQUEST', 'A custom row has no default to go back to.', 400);
      if (def && builtIn && !fixedSource(def.source, builtIn.source)) throw new AppError('INVALID_REQUEST', 'A built-in row keeps its source.', 400);
      if (def && !builtIn && def.source.type === 'recommendations') throw new AppError('INVALID_REQUEST', 'Choose a TMDB source.', 400);
      if (def && builtIn && sameRowDef(def, builtIn)) def = undefined;
      this.db.prepare('INSERT INTO explore_rows(key,position,shown,definition,revision) VALUES(?,NULL,1,?,?) ON CONFLICT(key) DO UPDATE SET definition=excluded.definition,revision=excluded.revision')
        .run(key, def ? JSON.stringify(def) : null, revision + 1);
      this.audit(actor, 'explore_row_changed', now, { key, definition: def ?? null });
      return revision + 1;
    })();
  }
  // A custom row, placed after the row it was made from (or last).
  create(actor: string, input: unknown, after?: string, now = Date.now()) {
    const def = exploreRowDefInput.parse(input);
    if (def.source.type === 'recommendations') throw new AppError('INVALID_REQUEST', 'Choose a TMDB source.', 400);
    const slug = def.title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'row';
    return this.db.transaction(() => {
      let key = `tmdb:c-${slug}`;
      for (let n = 2; this.db.prepare('SELECT 1 FROM explore_rows WHERE key=?').get(key); n++) key = `tmdb:c-${slug}-${n}`;
      this.db.prepare('INSERT INTO explore_rows(key,position,shown,definition,revision) VALUES(?,NULL,1,?,1)').run(key, JSON.stringify(def));
      const order = this.arrange(this.storedShelves()).filter(e => !e.slot && e.key !== key).map(e => e.key), at = after ? order.indexOf(after) : -1;
      order.splice(at < 0 ? order.length : at + 1, 0, key);
      this.setOrder(actor, order, now);
      this.audit(actor, 'explore_row_created', now, { key, definition: def });
      return key;
    })();
  }
  remove(actor: string, key: string, now = Date.now()) {
    if (!key.startsWith('tmdb:c-')) throw new AppError('INVALID_REQUEST', 'Only custom rows can be deleted.', 400);
    const { changes } = this.db.prepare('DELETE FROM explore_rows WHERE key=?').run(key);
    if (!changes) throw new AppError('EXPLORE_ROW_MISSING', 'This Explore row is unavailable.', 404);
    this.audit(actor, 'explore_row_deleted', now, { key });
  }
  private audit(actor: string, event: string, at: number, detail: unknown) {
    this.db.prepare('INSERT INTO audit(actor,event,at,detail) VALUES(?,?,?,?)').run(actor, event, at, JSON.stringify(detail));
  }
}
