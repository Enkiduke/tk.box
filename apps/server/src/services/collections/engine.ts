import type { PlexAdapter } from '../../providers/plex.js';
import type { ArtworkCollections } from '../../persistence/artwork-store.js';
import type { CollectionsStore, KeptRow } from '../../persistence/collections-store.js';
import { readOnly } from '../../errors.js';
import { CollectionsPlex, plexItem, type Item, type PlexCollection } from './plex.js';
import { SEASONAL_PRESETS } from './presets.js';
import { CHARTS, CollectionError, VISIBILITY, collectionActive, collectionKey, franchiseName, sameMember, streamingServices, validateAutomatic, validateCollections,
  type Automatic, type Definition, type Member, type Visibility } from './rules.js';
import { COLLECTION_UNIVERSES, CollectionSources, ProviderError, collectionSource, mapLimit, type Tmdb } from './sources.js';

// tk.box's collections engine: the Plex collections tk.box keeps.
// - Franchise collections from TMDb, "<Service> Shows" streaming collections and the "Newly Released" / "New Episodes"
//   smart collections, made and kept in line with the libraries. Each franchise or streaming one can be turned off.
// - tk.box's collections are what Plex holds: one turned off or removed in tk.box is deleted from Plex (its titles stay).
// - Custom and seasonal collections defined in tk.box (by hand, from a curated universe or a public list), with tk.box's
//   library fetching a seasonal collection's missing movies and, when asked, removing them again once its season ends.
// - Discover: the public lists and universes the Collections page offers, the TMDb collections a library has only part
//   of, and a preview of what one would hold, from the Discover index the full run keeps.
// A run's lines are the engine's, word for word, so the Jobs tab reads as it did. Nothing changes Plex without `apply`.
export type EngineContext = {
  plex: PlexAdapter; token: string;
  // Artwork's chosen libraries, by ID or title.
  libraries: string[];
  tmdb: Tmdb; mdblistKey?: string;
  collections: ArtworkCollections; upload: boolean;
  store: CollectionsStore;
  say: (line: string) => void;
  // A collection this run made in Plex, so it gets its poster straight away.
  created?: (name: string, ratingKey: string) => void;
  signal?: AbortSignal; transport?: typeof fetch;
};
type Group = { name: string; type: 1 | 2; keys: string[]; drop?: string[]; library: string; label: string };
const MOVIE_DAYS = 30, LIST_DAYS = 7, DAY_MS = 86400000;
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const message = (e: unknown) => (e as Error)?.message ?? String(e);
export class Canceled extends Error {}

class Builder {
  counts = { create: 0, update: 0, same: 0, smart: 0, delete: 0 }; failures = 0;
  existing = new Map<string, PlexCollection>(); byKey = new Map<string, PlexCollection>(); kept: KeptRow[] = []; wanted = new Set<string>();
  server = ''; root = ''; prefix: string;
  private constructor(private engine: CollectionsEngine, private apply: boolean) { this.prefix = apply ? '' : 'PLAN '; }
  // The collections already in Plex are read once up front.
  static async create(engine: CollectionsEngine, apply: boolean) {
    const b = new Builder(engine, apply);
    for (const kind of ['movie', 'show'] as const)
      for (const c of await engine.plex.collections(kind)) {
        const id = `${c.library}\0${collectionKey(c.title)}`;
        if (!b.existing.has(id)) b.existing.set(id, c);
        b.byKey.set(c.rating_key, c);
      }
    if (apply) { b.server = `server://${await engine.plex.machine()}/com.plexapp.plugins.library`; b.root = `${b.server}/library/metadata/`; }
    return b;
  }
  private get say() { return this.engine.say; }
  failed(name: string, library: string, error: unknown) { this.failures++; this.say(`ERROR collection ${name} [${library}]: ${message(error)}`); }
  // Deletes one collection from Plex (never its titles). False only if Plex refused; one already gone is fine. `listed`:
  // Plex just listed it, so it's there even if the collections read up front didn't include it.
  async remove(ratingKey: string, name: string, library: string, why: string, listed = false) {
    if (!this.byKey.has(ratingKey) && !listed) return true;
    this.counts.delete++;
    this.say(`${this.prefix}DELETE ${name} [${library}]: ${why}`);
    try { if (this.apply) await this.engine.plex.send('DELETE', `/library/collections/${ratingKey}`); return true; }
    catch (e) { this.failed(name, library, e); return false; }
  }
  async make(params: { type: number; title: string; smart: 0 | 1; sectionId: string; uri: string }) {
    const made = ((await this.engine.plex.send('POST', '/library/collections', params)).Metadata ?? [])[0] as { ratingKey?: unknown } | undefined;
    const key = made?.ratingKey === undefined ? '' : String(made.ratingKey);
    if (!/^\d+$/.test(key)) return undefined;
    this.say(`CREATED ${params.title}: Plex ID ${key}`);
    this.engine.created?.(params.title, key);
    return key;
  }
  // Plex lists collections by sort title and "!" sorts before letters, so this puts one at the front of the list. The
  // chart collections use !001 and the streaming services !002, so they follow the charts, each group by name.
  async leadList(section: string, ratingKey: string, title: string, library: string, rank = '!001') {
    const sort = `${rank} ${title}`, entry = await this.engine.plex.metadata(ratingKey);
    if (entry && entry.titleSort === sort) return;
    this.say(`${this.prefix}SORT ${title} [${library}]: first in the collections list`);
    if (this.apply) await this.engine.plex.send('PUT', `/library/sections/${section}/all`, { type: 18, id: ratingKey, 'titleSort.value': sort, 'titleSort.locked': 1 });
  }
  // Where a collection shows in Plex: your Home, friends' Homes and the library's recommendations.
  async showIn(section: string, name: string, library: string, ratingKey: string | undefined, visibility: Visibility, active = true) {
    const entries = Object.entries(visibility) as [keyof typeof VISIBILITY, boolean][];
    const params = Object.fromEntries(entries.map(([key, value]) => [VISIBILITY[key], value && active ? 1 : 0]));
    this.say(`${this.prefix}VISIBILITY ${name} [${library}]: ` + entries.map(([k, v]) => `${k}=${v && active ? 'on' : 'off'}`).join(', '));
    if (!this.apply || ratingKey === undefined) return;
    const path = `/hubs/sections/${section}/manage`, hub = ((await this.engine.plex.read(path, { metadataItemId: ratingKey })).Hub ?? [])[0] as Record<string, unknown> | undefined;
    const flag = (v: unknown) => v === true || v === 1 || v === '1' ? 1 : 0;
    if (hub) {
      const identifier = hub.identifier;
      if (!identifier) throw new CollectionError('Plex returned a hub without an identifier');
      if (Object.entries(params).some(([k, v]) => flag(hub[k]) !== v)) await this.engine.plex.send('PUT', `${path}/${encodeURIComponent(String(identifier))}`, params);
    } else if (Object.values(params).some(Boolean)) await this.engine.plex.send('POST', path, { ...params, metadataItemId: ratingKey });
  }
  // Franchise, streaming and custom collections: create the missing ones, add to (and with `sync` trim) the rest. One
  // the admin turned off (in `settings`) comes out of Plex instead, and one with a visibility setting has it applied. One
  // with the name of a custom collection (in `claimed`) is that collection's to keep. Every one that qualifies or is
  // claimed is noted in `wanted`.
  async groups(groups: Group[], titles: Map<string, string>, sections: Map<string, string>, minimum: number, sync: boolean, settings = new Map<string, Automatic>(), claimed = new Set<string>()) {
    const plex = this.engine.plex, counts = this.counts, prefix = this.prefix, listed = new Map<string, Map<string, [string, boolean][]>>();
    for (const group of [...groups].sort((a, b) => cmp(a.library, b.library) || cmp(a.name.toLowerCase(), b.name.toLowerCase()))) {
      this.engine.check();
      const { library, label, name } = group, id = `${library}\0${collectionKey(name)}`, setting = settings.get(id) ?? {} as Partial<Automatic>;
      if (claimed.has(id)) { this.wanted.add(id); this.say(`SKIP ${name} [${library}]: kept as one of tk.box's custom collections`); continue; }
      // Titles the admin removed come out even when membership only adds.
      const drop = new Set([...(group.drop ?? []), ...(setting.exclude ?? [])]), want = group.keys.filter(k => !drop.has(k));
      if (want.length < minimum) continue;
      const service = label.startsWith('stream:');  // The streaming services lead the collections list, after the charts
      let kept: KeptRow = { name, library, kind: service ? 'streaming' : 'franchise', items: want.length };
      this.wanted.add(id);
      try {
        const current = this.existing.get(id), section = sections.get(library)!;
        if (setting.enabled === false) {
          this.kept.push({ ...kept, off: true });
          if (current && !current.smart) await this.remove(current.rating_key, current.title, library, 'turned off in tk.box');
          continue;
        }
        if (service && current) await this.leadList(section, current.rating_key, current.title, library, '!002');  // Kometa's, smart or not, too: only its sort title changes
        if (current?.smart) {
          counts.smart++;
          this.say(`SKIP ${current.title} [${library}]: a smart collection can't be edited by hand; delete it in Plex to let tk.box rebuild it`);
          continue;
        }
        if (!current) {
          if (!listed.has(library)) listed.set(library, await plex.collectionTitles(section));
          if (listed.get(library)!.has(collectionKey(name))) {  // Asked fresh, whatever it holds: never make a second one
            this.say(`SKIP ${name} [${library}]: a collection with that name is already in Plex`);
            counts.same++; continue;
          }
          this.say(`${prefix}CREATE ${name} [${library}]: ${want.length} ${group.type === 2 ? 'shows' : 'movies'}`);
          counts.create++;
          let created: string | undefined;
          if (this.apply) {
            created = await this.make({ type: group.type, title: name, smart: 0, sectionId: section, uri: this.root + want.join(',') });
            if (created) {  // Release-date order, as Kometa's collections had
              await plex.send('PUT', `/library/metadata/${created}/prefs`, { collectionSort: 0 });
              if (service) await this.leadList(section, created, name, library, '!002');
              this.kept.push({ ...kept, rating_key: created });
            }
          }
          if (setting.visibility) await this.showIn(section, name, library, this.apply ? created : undefined, setting.visibility);
          continue;
        }
        kept = { ...kept, name: current.title, rating_key: current.rating_key };
        const have = await plex.members(current.rating_key);
        const add = want.filter(k => !have.has(k)), wanted = new Set(want);
        const remove = sync ? [...have.keys()].filter(k => !wanted.has(k)) : [...have.keys()].filter(k => drop.has(k));
        this.kept.push(kept);
        if (setting.visibility) await this.showIn(section, current.title, library, current.rating_key, setting.visibility);
        if (!add.length && !remove.length) { counts.same++; continue; }
        counts.update++;
        this.say(`${prefix}UPDATE ${current.title} [${library}]: ${[...add.map(k => `+${titles.get(k) ?? k}`), ...remove.map(k => `-${have.get(k)}`)].join('; ')}`);
        if (this.apply) {
          if (add.length) await plex.send('PUT', `/library/collections/${current.rating_key}/items`, { uri: this.root + add.join(',') });
          for (const k of remove) await plex.send('DELETE', `/library/collections/${current.rating_key}/items/${k}`);
        }
      } catch (e) { if (e instanceof Canceled) throw e; this.failed(name, library, e); }
    }
  }
  // The "Newly Released" and "New Episodes" smart collections: one each, first in the list, with the asked date window.
  async charts(days: { movie: number; show: number }) {
    const plex = this.engine.plex, counts = this.counts, prefix = this.prefix;
    for (const [kind, name, plexType, field, defaultDays] of CHARTS) {
      const window = days[kind] ?? defaultDays;
      for (const [key, library] of await plex.sections(kind)) {
        this.engine.check();
        const uri = `${this.server}/library/sections/${key}/all?type=${plexType}&sort=originallyAvailableAt%3Adesc&${field}%3E%3E=-${window}d`;
        try {
          let current = this.existing.get(`${library}\0${collectionKey(name)}`);
          const present = (await plex.collectionTitles(key)).get(collectionKey(name)) ?? [];  // Asked again, fresh: never make a second one
          // Only one is kept: the oldest smart one. Extra smart copies are deleted; a same-named collection that isn't
          // smart is somebody's own and is only mentioned.
          const smart = present.filter(([, s]) => s).sort((a, b) => Number(a[0]) - Number(b[0]));
          for (const [ratingKey] of smart.slice(1)) {
            counts.delete++;
            this.say(`${prefix}DELETE ${name} [${library}]: extra copy (id ${ratingKey}); keeping id ${smart[0]![0]}`);
            if (this.apply) await plex.send('DELETE', `/library/collections/${ratingKey}`);
          }
          if (smart.length) current = this.byKey.get(smart[0]![0]) ?? current;
          if (present.length - Math.max(smart.length - 1, 0) > 1) this.say(`NOTE ${name} [${library}]: another collection with this name isn't a smart collection, so it's left alone`);
          if (!current && present.length) { this.say(`SKIP ${name} [${library}]: a collection with that name is already in Plex`); counts.same++; continue; }
          if (current) {
            await this.leadList(key, current.rating_key, current.title, library);
            // One that exists is only touched to change its date window; a filter we can't read is left as it is.
            const entry = await plex.metadata(current.rating_key);
            let content = String(entry?.content ?? '');
            try { content = decodeURIComponent(content); } catch { /* left as it is */ }
            const found = new RegExp(`${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>>=-(\\d+)d`).exec(content);
            if (!found || Number(found[1]) === window) { counts.same++; continue; }
            counts.update++;
            this.say(`${prefix}UPDATE ${current.title} [${library}]: last ${found[1]} days -> last ${window} days`);
            if (this.apply) await plex.send('PUT', `/library/collections/${current.rating_key}/items`, { uri });
            continue;
          }
          this.say(`${prefix}CREATE ${name} [${library}]: smart collection of ${kind === 'movie' ? 'movies released' : 'episodes aired'} in the last ${window} days`);
          counts.create++;
          if (this.apply) {
            const created = await this.make({ type: plexType, title: name, smart: 1, sectionId: key, uri });
            if (created) await this.leadList(key, created, name, library);
          }
        } catch (e) { if (e instanceof Canceled) throw e; this.failed(name, library, e); }
      }
    }
  }
  // With them turned off, the "Newly Released" and "New Episodes" smart collections come out of Plex.
  async dropCharts() {
    for (const [kind, name] of CHARTS)
      for (const [key, library] of await this.engine.plex.sections(kind)) {
        try {
          for (const [ratingKey, smart] of (await this.engine.plex.collectionTitles(key)).get(collectionKey(name)) ?? [])
            if (smart) await this.remove(ratingKey, name, library, 'Newly Released and New Episodes are turned off in tk.box', true);
        } catch (e) { this.failed(name, library, e); }
      }
  }
  summary() {
    const c = this.counts;
    this.say(`${this.prefix}Collections: ${c.create} to create, ${c.update} to update, ${c.same} unchanged` + (c.delete ? `, ${c.delete} extra to delete` : '')
      + (c.smart ? `, ${c.smart} smart collections skipped` : '') + '.' + (this.apply ? '' : ' Nothing was changed.'));
  }
}

// The Plex titles a collection holds, the members it couldn't find, and how many of those matched more than one title.
export function collectionMembers(entry: Pick<Definition, 'members' | 'rules' | 'source'>, items: Item[]) {
  const selected = new Set<string>(), missing: Member[] = [];
  let ambiguous = 0;
  for (const member of entry.members ?? []) {
    const matches = items.filter(item => Object.entries(member).every(([k, v]) => String((item as Record<string, unknown>)[k] ?? '').toLowerCase() === String(v).toLowerCase()));
    if (matches.length > 1) ambiguous++;
    if (matches.length !== 1) { if (matches.length || !entry.source) missing.push(member); }
    else selected.add(matches[0]!.rating_key);
  }
  const rules = entry.rules ?? {};
  if (Object.keys(rules).length)
    for (const item of items) {
      const year = Number(item.year) || 0;
      if (rules.genres?.length && !rules.genres.some(g => item.genres.some(h => h.toLowerCase() === g.toLowerCase()))) continue;
      if ((rules.year_from !== undefined && year < rules.year_from) || (rules.year_to !== undefined && (!year || year > rules.year_to))) continue;
      if (!item.title.toLowerCase().includes((rules.title_contains ?? '').toLowerCase())) continue;
      selected.add(item.rating_key);
    }
  return { keys: items.filter(i => selected.has(i.rating_key)).map(i => i.rating_key), missing, ambiguous };
}

export class CollectionsEngine {
  readonly plex: CollectionsPlex;
  readonly sources: CollectionSources;
  readonly say: (line: string) => void;
  readonly created?: (name: string, ratingKey: string) => void;
  constructor(private ctx: EngineContext) {
    this.plex = new CollectionsPlex(ctx.plex, ctx.token, ctx.libraries);
    this.say = ctx.say; this.created = ctx.created;
    this.sources = new CollectionSources({ tmdb: ctx.tmdb, mdblistKey: ctx.mdblistKey, region: ctx.collections.franchise.region, plex: ctx.plex, token: ctx.token, transport: ctx.transport, scan: kind => this.plex.scan(kind) });
  }
  check() { if (this.ctx.signal?.aborted) throw new Canceled('Canceled.'); }
  private get tmdbReady() { return this.ctx.tmdb.configured(); }
  // The custom and seasonal definitions: the saved ones, or the seasonal presets (all off) until they are first saved.
  definitions() { return clone(validateCollections(this.ctx.collections.definitions ?? SEASONAL_PRESETS, collectionSource)); }
  private async identify(item: Item) {
    if (item.tmdb_id || !this.tmdbReady) return;
    for (const [field, source] of [['imdb_id', 'imdb_id'], ['tvdb_id', 'tvdb_id']] as const)
      if (item[field] && (field !== 'tvdb_id' || item.type === 'tv')) {
        const results = await this.sources.tmdb(`/find/${item[field]}`, { external_source: source });
        const matches = (results[item.type === 'movie' ? 'movie_results' : 'tv_results'] ?? []) as { id: number }[];
        if (matches.length === 1) { item.tmdb_id = matches[0]!.id; return; }
      }
  }

  // all / custom: show (plan) or make (apply) the collections; apply needs Send results to Plex. Returns the exit code.
  async sync(modeIn: 'plan' | 'apply', custom: boolean, today = new Date()) {
    let mode = modeIn;
    this.definitions(); validateAutomatic(this.ctx.collections.automatic);
    if (readOnly() && mode === 'apply') { this.say('READ-ONLY: previewing collection changes. Plex will not be updated.'); mode = 'plan'; }
    if (mode === 'apply' && !this.ctx.upload) throw new CollectionError('Applying collections changes Plex. Turn on Send results to Plex in Artwork settings first.');
    const earlier = this.ctx.store.kept().collections, kept: KeptRow[] = [];
    let failed: number;
    if (custom) {
      failed = await this.customCollections(mode === 'apply', today, undefined, kept, earlier);
      kept.push(...earlier.filter(r => r.kind !== 'custom'));
    } else failed = await this.buildCollections(mode === 'apply', kept, earlier, today);
    if (mode === 'apply') {
      this.ctx.store.setKept(kept);
      if (!custom) {  // Its TMDb lookups are fresh in the cache now, so the Discover index costs little more
        try { await this.buildIndex(); } catch (e) { if (e instanceof Canceled) throw e; this.say(`ERROR Discover index: ${message(e)}`); }
      }
    } else if (readOnly() && !custom && !failed) this.ctx.store.setKept(kept.filter(r => r.rating_key));  // The preview's grid: collections the plan found in Plex
    return failed ? 1 : 0;
  }
  // A newly added title (a movie's, show's, season's or episode's key) joins the custom collections it matches, and only
  // those: nothing is removed and no other collection changes. Applies when results go to Plex, else prints the plan.
  async added(ratingKey: string) {
    this.definitions();
    const item = await this.plex.addedItem(ratingKey);
    if (!item) return 0;
    return await this.customCollections(!readOnly() && this.ctx.upload, new Date(), item) ? 1 : 0;
  }

  // The custom and seasonal collections. tk.box's list is what Plex holds: one turned off comes out of Plex (found by
  // name), and so does one removed from the list (by the Plex ID an earlier run recorded in `earlier`). Each one that is
  // on is added to `kept`; a removed one that couldn't be deleted stays in it, to be tried again. A newly added title
  // (`addedItem`) only ever adds.
  private async customCollections(apply: boolean, today: Date, addedItem?: Item, kept: KeptRow[] = [], earlier: KeptRow[] = []) {
    let definitions = this.definitions();
    if (addedItem) definitions = definitions.filter(e => e.enabled !== false && e.library === addedItem.library && e.type === addedItem.type && collectionActive(e.schedule, today));
    // Resolve every enabled feed before any changes, seasonal deletion included.
    for (const entry of definitions) {
      this.check();
      const source = entry.source;
      if (entry.enabled !== false && source && (source.refresh ?? true)) {
        const result = await this.sources.fetch(source.url, entry.type, source.limit, { choose: source, exclude: entry.exclude, today });
        entry.members = result.items.map(r => r.member);
      }
    }
    // Titles the admin removed stay out, whether they were picked or came from a list.
    for (const entry of definitions) entry.members = (entry.members ?? []).filter(m => !(entry.exclude ?? []).some(x => sameMember(x, m)));
    const enabled = definitions.filter(e => e.enabled !== false);
    // Until tk.box saves its collections the seasonal presets stand in, all off; only saved ones come out of Plex.
    const off = this.ctx.collections.definitions && !addedItem ? definitions.filter(e => e.enabled === false) : [];
    const named = new Set(definitions.map(e => `${e.library}\0${collectionKey(e.name)}`));
    const gone = addedItem ? [] : earlier.filter(r => r.kind === 'custom' && r.rating_key && !named.has(`${r.library}\0${collectionKey(r.name)}`));
    if (!enabled.length && (addedItem || (!off.length && !gone.length))) { this.say('No enabled custom collections. Nothing was changed.'); return 0; }
    const kinds = [...new Set(enabled.map(e => e.type === 'tv' ? 'show' as const : 'movie' as const))].sort();
    const libraries = new Map<string, Map<string, string>>();
    for (const kind of kinds) libraries.set(kind, new Map((await this.plex.sections(kind)).map(([key, title]) => [title, key])));
    const sections = new Map([...libraries.values()].flatMap(m => [...m.entries()]));
    for (const entry of enabled)
      if (!libraries.get(entry.type === 'tv' ? 'show' : 'movie')!.has(entry.library)) throw new CollectionError(`Collection library '${entry.library}' must name a configured library of its type`);
    const items = enabled.length ? await this.plex.scan() : [];
    let acquireFailed = 0;
    if (!addedItem && enabled.length) {
      try { await this.seasonalAcquire(definitions, items, apply, today); }
      catch (e) { if (e instanceof Canceled) throw e; acquireFailed = 1; this.say(`ERROR Downloads: ${message(e)}. Plex collection syncing will continue`); }
    }
    const builder = await Builder.create(this, apply);
    for (const entry of off) {
      const current = builder.existing.get(`${entry.library}\0${collectionKey(entry.name)}`);
      if (current && !current.smart) await builder.remove(current.rating_key, current.title, entry.library, 'turned off in tk.box');
    }
    for (const row of gone) if (!await builder.remove(row.rating_key!, row.name, row.library, 'removed from tk.box\'s collections')) kept.push(row);
    for (const entry of enabled) {
      this.check();
      const { name, library } = entry, active = collectionActive(entry.schedule, today);
      let current = builder.existing.get(`${library}\0${collectionKey(name)}`), keys: string[] = [];
      try {
        const candidates = items.filter(i => i.library === library && i.type === entry.type);
        const found = collectionMembers(entry, candidates), dropped = collectionMembers({ members: entry.exclude ?? [] }, candidates).keys;
        keys = found.keys.filter(k => !dropped.includes(k));
        if (active) {
          if (addedItem) { keys = keys.filter(k => k === addedItem.rating_key); if (!keys.length) continue; }
          this.say(`${apply ? '' : 'PLAN '}MATCH ${name} [${library}]: ${keys.length} existing Plex ${entry.type === 'tv' ? 'shows' : 'movies'}; enabled`);
          // A title missing from Plex can't be in the collection, but one that matches several might be: nothing comes
          // out while any is unclear.
          if (found.ambiguous) this.say(`WARN ${name} [${library}]: ${found.ambiguous} members match more than one title; no members removed`);
          else if (found.missing.length) this.say(`NOTE ${name} [${library}]: ${found.missing.length} members not in Plex`);
          if (!keys.length) this.say(`SKIP ${name} [${library}]: no matching titles; membership left alone`);
          else {
            await builder.groups([{ name, type: entry.type === 'tv' ? 2 : 1, keys, drop: dropped, library, label: 'custom' }], new Map(candidates.map(i => [i.rating_key, i.title])), sections, 1, !addedItem && !found.ambiguous);
            if (!current && apply) current = (await this.plex.collections(entry.type === 'tv' ? 'show' : 'movie')).find(c => c.library === library && collectionKey(c.title) === collectionKey(name));
          }
        } else this.say(`${builder.prefix}SEASON ${name} [${library}]: outside ${entry.schedule}; keep collection`);
        if (!addedItem && entry.visibility) await builder.showIn(sections.get(library)!, name, library, current?.rating_key, entry.visibility, active);
      } catch (e) { if (e instanceof Canceled) throw e; builder.failed(name, library, e); }
      if (!addedItem) kept.push({ name, library, kind: 'custom', items: keys.length, ...(current ? { rating_key: current.rating_key } : {}) });
    }
    builder.summary();
    return builder.failures + acquireFailed;
  }

  // Seasonal and rotating collections that download: tk.box's library adds the movies active acquiring collections want
  // and Plex lacks, each recorded in the journal with the collections that wanted it. Once every one of them lets it go
  // (a seasonal one's season ended, or it left a rotating one's list, not while watched, nor when the list came back less
  // than half as long), the library deletes it with its files, but only one it added for collections and that nobody has
  // requested or kept since.
  private async seasonalAcquire(definitions: Definition[], items: Item[], apply: boolean, today: Date) {
    if (!definitions.some(e => e.acquire && e.enabled !== false)) return;
    if (readOnly()) { this.say('READ-ONLY: acquisition and removal skipped'); return; }
    const store = this.ctx.store;
    if (store.journalBroken()) throw new CollectionError('Cannot read collections-tkbox.json; tk.box acquisition and removal refused. Restore it from backup');
    const movies = store.downloads(), lists = store.listSizes();
    const identity = (e: Definition) => `${e.library}:${collectionKey(e.name)}`;
    const acquiring = (e: Definition) => e.enabled !== false && e.acquire && e.type === 'movie' && collectionActive(e.schedule, today);
    const owners = new Map(definitions.map(e => [identity(e), e]));
    const activeIds = new Set<number>(), wanted = new Map<number, Set<string>>();
    for (const entry of definitions) {
      if (entry.enabled === false || !collectionActive(entry.schedule, today) || entry.type !== 'movie') continue;
      const ids = (entry.members ?? []).flatMap(m => m.tmdb_id ? [m.tmdb_id] : []);
      const candidates = items.filter(i => i.library === entry.library && i.type === entry.type), keys = new Set(collectionMembers(entry, candidates).keys);
      for (const id of ids) activeIds.add(id);
      for (const i of candidates) if (keys.has(i.rating_key) && i.tmdb_id) activeIds.add(i.tmdb_id);
      if (acquiring(entry)) for (const id of ids) wanted.set(id, (wanted.get(id) ?? new Set()).add(identity(entry)));
    }
    const present = new Set(items.flatMap(i => i.type === 'movie' && i.tmdb_id ? [i.tmdb_id] : []));
    const missing = [...wanted.keys()].filter(id => !present.has(id)).sort((a, b) => a - b);
    for (const id of missing) {
      this.say(`${apply ? ' ' : 'PLAN '}TK.BOX ADD tmdb:${id}`);
      if (apply) movies.set(id, [...new Set([...(movies.get(id) ?? []), ...wanted.get(id)!])].sort());
    }
    // Movies already recorded that other acquiring collections now share: all of them must let go before removal.
    for (const [id, record] of movies) {
      const shared = wanted.get(id) ?? new Set();
      if (apply && [...shared].some(o => !record.includes(o))) movies.set(id, [...new Set([...record, ...shared])].sort());
    }
    // A list that suddenly shrank is more likely a bad answer than a new week: nothing leaves it on this run.
    const held = new Set<string>();
    for (const entry of definitions)
      if (entry.enabled !== false && entry.cleanup === 'rotate') {
        const owner = identity(entry), count = (entry.members ?? []).filter(m => m.tmdb_id !== undefined).length;
        if (count < (lists[owner] ?? 0) / 2) { held.add(owner); this.say(`WARN ${entry.name} [${entry.library}]: the list has ${count} movies, down from ${lists[owner]}; none are removed this run`); }
        if (apply) lists[owner] = count;
      }
    const releases = (e: Definition | undefined) => {
      if (!e || e.enabled === false) return false;
      if (e.cleanup === 'rotate') return !held.has(identity(e));
      return (e.cleanup ?? 'keep') === 'remove-delete' && !collectionActive(e.schedule, today);
    };
    const removals: number[] = [];
    let playing: Set<number> | false | undefined;
    for (const [id, record] of [...movies]) {
      if (activeIds.has(id)) continue;
      const responsible = record.map(o => owners.get(o));
      if (!responsible.length || !responsible.every(releases)) continue;
      if (responsible.some(e => e?.cleanup === 'rotate')) {
        if (playing === undefined) playing = await this.plex.playing().then(keys => new Set(items.flatMap(i => keys.has(i.rating_key) && i.tmdb_id ? [i.tmdb_id] : [])), () => false as const);
        if (playing === false || playing.has(id)) { this.say(`KEEP tmdb:${id}: left the list, but ` + (playing === false ? 'Plex didn\'t say what is playing' : 'someone is watching it')); continue; }
      }
      this.say(`${apply ? ' ' : 'PLAN '}TK.BOX REMOVE + DELETE FILES tmdb:${id} (added for collections)`);
      if (apply) { removals.push(id); movies.delete(id); }
    }
    if (apply) store.saveDownloads(movies, lists, { add: missing, remove: removals });
  }

  // What the franchise (with `franchises`) and streaming collections should hold, from TMDb, and how many lookups failed.
  private async wantedCollections(streaming: 'off' | 'originals' | 'available', region: string, franchises: boolean) {
    const groups = new Map<string, Group>(), titles = new Map<string, string>();
    let failed = 0;
    const add = (library: string, label: string, name: string, type: 1 | 2, item: Item) => {
      titles.set(item.rating_key, item.title);
      const id = `${library}\0${label}`, group = groups.get(id) ?? { name, type, keys: [], library, label };
      groups.set(id, group);
      if (!group.keys.includes(item.rating_key)) group.keys.push(item.rating_key);
    };
    const safe = <T, R>(fn: (v: T) => Promise<R>, empty: R) => async (v: T) => { this.check(); try { return await fn(v); } catch (e) { if (e instanceof Canceled) throw e; failed++; return empty; } };
    const movies = franchises ? (await this.plex.scan('movie')).filter(m => m.tmdb_id) : [];
    const ids = [...new Set(movies.map(m => m.tmdb_id!))].sort((a, b) => a - b);
    const found = await mapLimit(ids, 6, safe(async (id: number) => ((await this.sources.tmdb(`/movie/${id}`)).belongs_to_collection ?? {}) as { id?: number; name?: string }, {}));
    const franchise = new Map(ids.map((id, i) => [id, found[i]!]));
    for (const movie of movies) { const f = franchise.get(movie.tmdb_id!)!; if (f.id) add(movie.library, String(f.id), franchiseName(f as { id: number; name?: string }), 1, movie); }
    if (streaming !== 'off') {
      const shows = await this.plex.scan('show');
      const services = await mapLimit(shows, 6, safe(async (show: Item) => {
        await this.identify(show);
        if (!show.tmdb_id) return [] as string[];
        return streamingServices(await this.sources.tmdb(`/tv/${show.tmdb_id}`, { append_to_response: 'watch/providers' }), streaming, region);
      }, [] as string[]));
      shows.forEach((show, i) => { for (const service of services[i]!) add(show.library, 'stream:' + service, `${service} Shows`, 2, show); });
    }
    return { groups: [...groups.values()], titles, failed };
  }

  // Collections like Kometa's franchise and streaming defaults, with no Kometa: one per TMDb movie collection with at
  // least `minItems` of your movies in a library; one "<Service> Shows" per streaming service with at least that many of
  // your shows; and the "Newly Released" / "New Episodes" smart collections. Existing ones with the same name are adopted
  // and brought in line (added to, and with `sync` trimmed); smart ones are skipped. One turned off is deleted, and so is
  // one an earlier run kept that no longer qualifies, but only when every TMDb lookup worked. Then the custom ones.
  private async buildCollections(apply: boolean, kept: KeptRow[], earlier: KeptRow[], today: Date) {
    const f = this.ctx.collections.franchise;
    let sync = f.mode === 'sync';
    if ((f.franchises || f.streaming !== 'off') && !this.tmdbReady) throw new CollectionError('Franchise and streaming collections need a TMDb API key');
    const sections = new Map<string, string>();
    for (const kind of ['movie', 'show'] as const) for (const [key, title] of await this.plex.sections(kind)) sections.set(title, key);
    const { groups, titles, failed } = await this.wantedCollections(f.streaming, f.region, f.franchises);
    if (failed) { sync = false; this.say(`WARN ${failed} TMDb lookups failed; collections are only added to this run, never trimmed or deleted`); }  // A partial picture must never remove anything
    const builder = await Builder.create(this, apply);
    // A custom collection named like a franchise one (one added from Discover's Partly owned) takes it over.
    const claimed = new Set(this.definitions().map(e => `${e.library}\0${collectionKey(e.name)}`));
    await builder.groups(groups, titles, sections, f.minItems, sync, validateAutomatic(this.ctx.collections.automatic), claimed);
    kept.push(...builder.kept);
    for (const row of earlier) {
      if ((row.kind !== 'franchise' && row.kind !== 'streaming') || builder.wanted.has(`${row.library}\0${collectionKey(row.name)}`)) continue;
      if (failed || !row.rating_key) { if (failed) kept.push(row); continue; }
      if (!await builder.remove(row.rating_key, row.name, row.library, `no longer one of the ${row.kind} collections`)) kept.push(row);
    }
    if (f.recent) await builder.charts({ movie: f.recentMovieDays, show: f.recentEpisodeDays }); else await builder.dropCharts();
    builder.summary();
    return builder.failures + await this.customCollections(apply, today, undefined, kept, earlier);
  }

  // Discover's index, which Partly owned and Universes read so they open at once: each movie's TMDb collection, those
  // collections' parts and each universe's list. Only what is missing or stale is asked for again; movies no longer in
  // Plex (and collections none of them is in) are dropped. What you own is matched with Plex when Discover opens.
  // Returns the number of lookups that failed.
  private async indexMovies(ids: number[], force: boolean, now: number) {
    const store = this.ctx.store, known = store.indexMovies();
    const stale = ids.filter(id => force || !known.has(id) || now - known.get(id)!.checkedAt > MOVIE_DAYS * DAY_MS);
    await mapLimit(stale, 6, async id => {
      this.check();
      try { store.setIndexMovie(id, ((await this.sources.tmdb(`/movie/${id}`)).belongs_to_collection?.id as number | undefined) ?? null, now); }
      catch (e) { if (e instanceof Canceled) throw e; }  // A failed lookup keeps what was there
    });
    const after = store.indexMovies();
    return new Set(ids.flatMap(id => after.get(id)?.collection ? [after.get(id)!.collection!] : []));
  }
  private async indexCollections(ids: number[], force: boolean, now: number) {
    const store = this.ctx.store, known = store.indexCollections();
    const stale = ids.filter(id => force || !known.has(id) || now - known.get(id)!.checkedAt > LIST_DAYS * DAY_MS);
    await mapLimit(stale, 6, async id => {
      this.check();
      try {
        const detail = await this.sources.tmdb(`/collection/${id}`);
        if (Array.isArray(detail.parts)) store.setIndexCollection(id, franchiseName({ id, ...detail }), (detail.parts as Record<string, any>[]).filter(p => p.id)
          .map(p => ({ id: p.id as number, title: (p.title as string) || String(p.id), release_date: (p.release_date as string) || '' })), now);
      } catch (e) { if (e instanceof Canceled) throw e; }
    });
  }
  private async indexUniverses(force: boolean, now: number) {
    const store = this.ctx.store, known = store.indexUniverses(), wanted: [string, string, string, 'movie' | 'tv', boolean][] = [];
    for (const [key, name, url, kinds] of COLLECTION_UNIVERSES) {
      const imdb = collectionSource(url)[0] === 'imdb';
      for (const kind of kinds) {
        const cached = known.get(`${key}:${kind}`);
        if (force || !cached || now - cached.checkedAt > LIST_DAYS * DAY_MS || (imdb && !cached.imdbSeries)) wanted.push([key, name, url, kind, imdb]);
      }
    }
    let failed = 0;
    await mapLimit(wanted, 4, async ([key, name, url, kind, imdb]) => {
      this.check();
      try { store.setIndexUniverse(`${key}:${kind}`, (await this.sources.fetch(url, kind, 250, { resolve: false })).items.map(r => r.member), now, imdb); }
      catch (e) { if (e instanceof Canceled) throw e; failed++; this.say(`WARN ${name} (${kind}, ${collectionSource(url)[0]}): ${message(e)}`); }
    });
    return failed;
  }
  async buildIndex(force = false, now = Date.now()) {
    const store = this.ctx.store, movies = (await this.plex.scan('movie')).filter(m => m.tmdb_id);
    const ids = [...new Set(movies.map(m => m.tmdb_id!))].sort((a, b) => a - b);
    this.say(`INDEX ${ids.length} movies`);
    store.pruneIndex(new Set(ids), new Set([...store.indexCollections().keys()]));
    const collections = this.tmdbReady ? await this.indexMovies(ids, force, now) : new Set<number>();
    store.pruneIndex(new Set(ids), collections);
    await this.indexCollections([...collections].sort((a, b) => a - b), force, now);
    let failed = await this.indexUniverses(force, now);
    const knownMovies = store.indexMovies(), knownCollections = store.indexCollections();
    failed += ids.filter(id => !knownMovies.has(id)).length + [...collections].filter(id => !knownCollections.has(id)).length;
    store.setIndexBuilt(now);
    this.say(`INDEX ${knownCollections.size} TMDb collections and ${store.indexUniverses().size} universe lists saved` + (failed ? `; ${failed} lookups failed and are tried again next time` : ''));
    return failed;
  }
  // Newly added movies join the Discover index straight away: their TMDb collection, and its parts read again.
  async indexAdded(ratingKeys: string[], now = Date.now()) {
    const ids: number[] = [];
    for (const key of ratingKeys) {
      this.check();
      const node = await this.plex.metadata(key, { includeGuids: 1 }).catch(() => undefined);  // An episode, or gone again
      if (!node || node.type !== 'movie') continue;
      const item = plexItem(node, String(node.librarySectionTitle ?? ''));
      await this.identify(item);
      if (item.tmdb_id) ids.push(item.tmdb_id);
    }
    if (!ids.length) { this.say('INDEX No newly added movies with a TMDb ID'); return 0; }
    const collections = await this.indexMovies(ids, true, now);
    await this.indexCollections([...collections].sort((a, b) => a - b), true, now);
    this.say(`INDEX ${ids.length} newly added movies, in ${collections.size} TMDb collections`);
    return 0;
  }
  // How many movies each library has of each TMDb collection now, from a Plex scan and the Discover index.
  private async franchiseCounts() {
    const store = this.ctx.store, movies = store.indexMovies(), collections = store.indexCollections(), counts = new Map<string, number>();
    for (const movie of await this.plex.scan('movie')) {
      const entry = movie.tmdb_id ? movies.get(movie.tmdb_id) : undefined, collection = entry?.collection ? collections.get(entry.collection) : undefined;
      if (collection) { const key = `${movie.library}\0${collection.name}`; counts.set(key, (counts.get(key) ?? 0) + 1); }
    }
    return [...counts].sort(([a], [b]) => cmp(a, b)).map(([key, items]) => { const [library, name] = key.split('\0') as [string, string]; return { library, name, items }; });
  }
  // The TMDb movie collections each library holds some but not all of the released movies of, closest to complete first,
  // and how many movies in Plex the index hasn't read yet.
  private async partlyOwned(query: string, today = new Date()) {
    const store = this.ctx.store, movies = store.indexMovies(), collections = store.indexCollections(), day = isoDay(today);
    const owned = new Map<string, Set<number>>(), unread = new Set<number>();
    for (const movie of (await this.plex.scan('movie')).filter(m => m.tmdb_id)) {
      const entry = movies.get(movie.tmdb_id!);
      if (!entry) unread.add(movie.tmdb_id!);
      else if (entry.collection && collections.has(entry.collection)) { const key = `${movie.library}\0${entry.collection}`; owned.set(key, (owned.get(key) ?? new Set()).add(movie.tmdb_id!)); }
    }
    const rows: Record<string, unknown>[] = [];
    for (const [key, have] of owned) {
      const [library, id] = key.split('\0') as [string, string], detail = collections.get(Number(id))!;
      // Movies not out yet aren't missing; a part with no date isn't out either.
      const missing = detail.parts.filter(p => !have.has(p.id) && (p.release_date || '9999') <= day);
      if (!missing.length || !detail.name.toLowerCase().includes(query.toLowerCase())) continue;
      const titles = [...missing].sort((a, b) => cmp(a.release_date, b.release_date)).map(p => `${p.title} (${p.release_date.slice(0, 4)})`);
      const more = titles.length > 5 ? ` and ${titles.length - 5} more` : '';
      rows.push({ name: detail.name, url: `https://www.themoviedb.org/collection/${id}/`, type: 'movie', provider: 'tmdb', library, owned: have.size, total: have.size + missing.length,
        description: `${have.size} of ${have.size + missing.length} in ${library}. Missing ${titles.slice(0, 5).join(', ')}${more}` });
    }
    rows.sort((a, b) => ((a.total as number) - (a.owned as number)) - ((b.total as number) - (b.owned as number)) || (b.owned as number) - (a.owned as number)
      || cmp((a.name as string).toLowerCase(), (b.name as string).toLowerCase()) || cmp(a.library as string, b.library as string));
    return { rows, unread: unread.size };
  }
  // The Collections page's Discover: recommendations, a provider's lists, universes, partly owned TMDb collections, or a
  // preview of one list.
  async discover(data: { mode?: string; provider?: string; query?: string; type?: 'movie' | 'tv'; universe?: string; url?: string; limit?: number; filter?: unknown; sort?: unknown; candidates?: boolean }) {
    const mode = data.mode ?? 'recommendations';
    try {
      if (mode === 'preview') {
        const preset = data.universe ? COLLECTION_UNIVERSES.find(r => r[0] === data.universe) : undefined;
        if (data.universe && (!preset || !preset[3].includes(data.type ?? 'movie'))) throw new CollectionError('Unknown universe or unsupported media type');
        const result = await this.sources.fetch(preset ? preset[2] : data.url, data.type ?? 'movie', data.limit,
          { choose: { ...('filter' in data ? { filter: data.filter } : {}), ...('sort' in data ? { sort: data.sort } : {}) }, candidates: data.candidates === true });
        if (preset) result.name = preset[1];
        return result;
      }
      const provider = data.provider ?? 'all', query = String(data.query ?? '').slice(0, 200);
      if (mode === 'universes' || mode === 'partial' || mode === 'franchises') {  // From the Discover index, matched with Plex now
        const built = this.ctx.store.indexBuilt(), index = { built: built === null ? null : built / 1000 };
        if (mode === 'franchises') return { results: built !== null ? await this.franchiseCounts() : [], index };
        if (mode === 'universes') return { results: await this.sources.universes(query, data.type ?? 'movie', new Map([...this.ctx.store.indexUniverses()].map(([k, v]) => [k, v.members]))), index };
        const { rows, unread } = await this.partlyOwned(query);
        return { results: rows, index: { ...index, unread } };
      }
      return { results: mode === 'browse' ? await this.sources.discover(provider, query) : this.sources.recommendations(provider, query) };
    } catch (e) {
      if (e instanceof ProviderError || (e as { code?: string }).code) throw new CollectionError('Provider request failed; check API credentials, rate limits and provider availability');
      throw e;
    }
  }
}
