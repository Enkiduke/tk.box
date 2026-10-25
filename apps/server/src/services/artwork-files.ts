import { createHash, randomUUID } from 'node:crypto';
import { copyFile, readFile, readdir, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { AppError, requireThat } from '../errors.js';

// Admin › Artwork's titles as the engine keeps them on disk: assets/<movies|tv|collections>/<title>[/Season NN], each with
// its poster and logo, the candidates set aside beside them (poster2, poster-1a2b3c4d) and its .artwork.json. Browsing,
// picking and pushing happen here; the engine's worker is only asked for what needs its renderer (previews, thumbnails it
// hasn't made yet, generated backgrounds, Live marks and Discard, which read its render records).
export const CATEGORIES = ['movies', 'tv', 'collections'] as const;
const EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.bmp', '.gif']);
const PICK = /^(poster|logo)(\d+|-[0-9a-f]{8})?$/i;
const SEASON = /^Season \d+$/;
const ROUTES = '/api/v1/admin/artwork';
const NO_KEY = 'This title has no Plex ID saved yet, so it can’t be pushed until the script has run for it once';
// The chart collections the engine makes ("Newly Released", "New Episodes") are listed first.
const CHARTS = ['newlyreleased', 'newepisodes'];
const collectionKey = (name: string) => name.trim().toLowerCase().replace(/\s+collection$/, '').replace(/[^a-z0-9]/g, '');

export type Kind = 'poster' | 'logo';
export type Meta = Record<string, unknown> & { type?: string; title?: string; year?: string | number; rating_key?: string | number; tmdb_id?: number; tvdb_id?: number; imdb_id?: string; no_logo?: boolean };
type Before = Record<string, string | boolean | null>;
export type Pending = { title: string; before?: Before };
// `kind` (collections only): chart, streaming, custom or collection, as the engine recorded it; a folder from before it did
// counts as a chart when it is named like one, else as a collection.
export type TitleRow = { id: string; cat: string; title: string; year?: string | number; first: boolean; thumb: string | null; kind?: string; service?: string };
type FileEntry = { name: string; thumb: string; full: string; kb: number; kept: boolean; size?: string; hash?: string; source?: string | null };
export type Section = { id: string; label: string | null; pv: string; rendered: FileEntry | null; poster: FileEntry | null; logo: FileEntry | null; posters: FileEntry[]; logos: FileEntry[] };
type Mark = { rel: string; before?: [string, string | boolean | null] };
type Plex = (path: string, params?: Record<string, string | number>) => Promise<{ status: number; data: unknown }>;

const natural = (name: string) => name.toLowerCase().replace(/\d+/g, n => n.padStart(6, '0'));
const isImage = (name: string) => EXTENSIONS.has(extname(name).toLowerCase());
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

// Width and height from an image's header (JPEG, PNG, GIF, BMP, WebP); undefined for anything else.
export function imageSize(data: Buffer): [number, number] | undefined {
  if (data.length >= 24 && data.readUInt32BE(0) === 0x89504e47) return [data.readUInt32BE(16), data.readUInt32BE(20)];
  if (data.length >= 10 && data.toString('latin1', 0, 3) === 'GIF') return [data.readUInt16LE(6), data.readUInt16LE(8)];
  if (data.length >= 26 && data.toString('latin1', 0, 2) === 'BM') return [data.readInt32LE(18), Math.abs(data.readInt32LE(22))];
  if (data.length >= 30 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = data.toString('latin1', 12, 16);
    if (chunk === 'VP8 ') return [data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff];
    if (chunk === 'VP8L') { const bits = data.readUInt32LE(21); return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1]; }
    if (chunk === 'VP8X') return [1 + data.readUIntLE(24, 3), 1 + data.readUIntLE(27, 3)];
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    for (let at = 2; at + 9 < data.length;) {
      if (data[at] !== 0xff) { at++; continue; }
      const marker = data[at + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { at += marker === 0xff ? 1 : 2; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [data.readUInt16BE(at + 7), data.readUInt16BE(at + 5)];
      at += 2 + data.readUInt16BE(at + 2);
    }
  }
  return undefined;
}
// The image type a picture's bytes are, for serving one; undefined when they aren't a picture the page can show.
export function imageType(data: Buffer) {
  if (data.length >= 4 && data.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (data.length >= 3 && data.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  return undefined;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { const value = JSON.parse(await readFile(path, 'utf8')) as unknown; return value && typeof value === 'object' && !Array.isArray(value) ? value as T : fallback; }
  catch { return fallback; }
}
// Written whole and then moved into place, so the engine never reads a half-written file.
async function atomicWrite(path: string, data: Buffer | string) {
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, data);
  try { await rename(temporary, path); } catch (e) { await unlink(temporary).catch(() => {}); throw e; }
}
const exists = (path: string) => stat(path).then(() => true, () => false);

export class ArtworkFiles {
  private pending?: Promise<Record<string, Pending>>;
  private sources?: Promise<Record<string, string>>;
  private rows = new Map<string, { at: number; row: TitleRow }>();
  private files = new Map<string, { hash: string; size?: string }>();
  private writing = Promise.resolve();
  constructor(private root: string, private cache: string, private config: string) {}

  // A folder or file under assets/, only ever <category>/<title>[/Season NN][/file].
  path(rel: string, depths: number[]) {
    const parts = String(rel).split('/');
    if (!depths.includes(parts.length) || !(CATEGORIES as readonly string[]).includes(parts[0]!) || parts.some(p => !p || p === '.' || p === '..' || p.includes('\\') || p.includes('\0')))
      throw new AppError('VALIDATION_FAILED', 'Unknown path');
    return join(this.root, ...parts);
  }
  async locate(rel: string) {
    const folder = this.path(rel, [2, 3]), season = rel.split('/').length === 3;
    requireThat(!season || SEASON.test(basename(folder)), 'VALIDATION_FAILED', 'Unknown folder');
    requireThat((await stat(folder).catch(() => undefined))?.isDirectory(), 'ARTWORK_NOT_FOUND', 'Folder not found', 404);
    return { title: season ? join(folder, '..') : folder, folder, titleRel: rel.split('/').slice(0, 2).join('/'), season: season ? Number(basename(folder).split(' ')[1]) : null };
  }
  meta(folder: string) { return readJson<Meta>(join(folder, '.artwork.json'), {}); }
  private async writeMeta(folder: string, change: (meta: Meta) => void) {
    const meta = await this.meta(folder);
    requireThat(Object.keys(meta).length, 'VALIDATION_FAILED', 'This title has no saved details yet, so run the script for it once first');
    change(meta);
    await atomicWrite(join(folder, '.artwork.json'), JSON.stringify(meta, null, 2));
  }
  private async url(path: string, rel: string, width: number) {
    const { mtimeNs } = await stat(path, { bigint: true });
    return `${ROUTES}/file?${new URLSearchParams({ p: rel, w: String(width), v: String(mtimeNs) })}`;
  }
  // The folder's one poster, logo, rendered or generated file (any image extension), or undefined.
  async source(folder: string, name: string) {
    const names = await readdir(folder).catch(() => [] as string[]);
    const matches = names.filter(n => isImage(n) && basename(n, extname(n)).toLowerCase() === name);
    requireThat(matches.length <= 1, 'VALIDATION_FAILED', `Keep exactly one ${name} file in ${folder}; found ${matches.length}`);
    return matches[0] && join(folder, matches[0]);
  }
  // A file's identity for the page (sha-256's first 8) and its size, read once per version of the file. Renames keep a
  // file's time, so a version is its file ID as well; set-aside names are hashed fresh all the same.
  private async identity(path: string) {
    const { ino, mtimeNs, size } = await stat(path, { bigint: true }), key = `${path}|${ino}|${mtimeNs}|${size}`;
    let hit = this.files.get(key);
    if (!hit) {
      const data = await readFile(path), dims = imageSize(data);
      hit = { hash: sha256(data).slice(0, 8), ...(dims ? { size: `${dims[0]}×${dims[1]}` } : {}) };
      this.files.set(key, hit);
      if (this.files.size > 5000) this.files.delete(this.files.keys().next().value!);
    }
    return hit;
  }

  async titles(): Promise<TitleRow[]> {
    const rows: TitleRow[] = [];
    for (const cat of CATEGORIES) {
      const base = join(this.root, cat);
      for (const entry of await readdir(base, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory()) continue;
        const folder = join(base, entry.name), id = `${cat}/${entry.name}`, at = (await stat(folder)).mtimeMs, hit = this.rows.get(id);
        // A folder's own time changes whenever a file in it is added, renamed or replaced (its .artwork.json too).
        if (hit && hit.at === at) { rows.push(hit.row); continue; }
        const meta = await this.meta(folder), names = await readdir(folder), title = String(meta.title || entry.name);
        const cover = ['rendered', 'poster'].map(n => names.find(f => isImage(f) && basename(f, extname(f)).toLowerCase() === n)).find(Boolean);
        const chart = cat === 'collections' && CHARTS.includes(collectionKey(title));
        const row: TitleRow = { id, cat, title, ...(meta.year ? { year: meta.year } : {}), first: chart,
          ...(cat === 'collections' ? { kind: typeof meta.kind === 'string' ? meta.kind : chart ? 'chart' : 'collection', ...(typeof meta.service === 'string' ? { service: meta.service } : {}) } : {}),
          thumb: cover ? await this.url(join(folder, cover), `${id}/${cover}`, 300) : null };
        this.rows.set(id, { at, row }); rows.push(row);
      }
    }
    return rows.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  }
  async find(ratingKey: string) {
    for (const cat of CATEGORIES) for (const entry of await readdir(join(this.root, cat), { withFileTypes: true }).catch(() => []))
      if (entry.isDirectory() && String((await this.meta(join(this.root, cat, entry.name))).rating_key) === ratingKey) return { id: `${cat}/${entry.name}` };
    return { id: null };
  }

  // Changes whenever a file the preview depends on does, so the page knows when to ask for a new one.
  private async version(folder: string, title: string) {
    const state: unknown[] = [(await stat(this.config).catch(() => undefined))?.mtimeMs ?? 0, !!(await this.meta(title)).no_logo];
    for (const [where, kind] of [[folder, 'poster'], [title, 'logo']] as const) {
      const path = await this.source(where, kind), info = path && await stat(path);
      state.push(path && info ? [basename(path), info.mtimeMs, info.size] : null);
    }
    return createHash('sha1').update(JSON.stringify(state)).digest('hex').slice(0, 10);
  }
  private async section(folder: string, rel: string, label: string | null, title: string): Promise<Section> {
    const found: Section = { id: rel, label, pv: await this.version(folder, title), rendered: null, poster: null, logo: null, posters: [], logos: [] };
    const sources = await this.sourceMap();
    for (const name of (await readdir(folder)).sort((a, b) => natural(a) < natural(b) ? -1 : natural(a) > natural(b) ? 1 : 0)) {
      const stem = basename(name, extname(name)), match = PICK.exec(stem), path = join(folder, name);
      if (!isImage(name) || !(match || stem.toLowerCase() === 'rendered')) continue;
      const info = await stat(path); if (!info.isFile()) continue;
      const { hash, size } = await this.identity(path), fileRel = `${rel}/${name}`;
      const entry: FileEntry = { name, thumb: await this.url(path, fileRel, 360), full: await this.url(path, fileRel, 1400), kb: Math.floor(info.size / 1024),
        kept: !!match?.[2]?.startsWith('-'), ...(size ? { size } : {}) };
      if (!match) { found.rendered = entry; continue; }
      // Names change as picks rename files; the contents don't
      Object.assign(entry, { hash, source: sources[hash] ?? null });
      const kind = match[1]!.toLowerCase() as Kind;
      if (match[2]) found[`${kind}s`].push(entry); else found[kind] = entry;
    }
    return found;
  }
  async detail(rel: string) {
    const folder = this.path(rel, [2]);
    requireThat((await stat(folder).catch(() => undefined))?.isDirectory(), 'ARTWORK_NOT_FOUND', 'Folder not found', 404);
    const meta = await this.meta(folder);
    const seasons = (await readdir(folder, { withFileTypes: true })).filter(e => e.isDirectory() && SEASON.test(e.name)).map(e => e.name).sort();
    return { id: rel, title: String(meta.title || basename(folder)), year: meta.year, key: meta.rating_key, tv: rel.startsWith('tv/'), no_logo: !!meta.no_logo,
      sections: [await this.section(folder, rel, null, folder), ...await Promise.all(seasons.map(s => this.section(join(folder, s), `${rel}/${s}`, s, folder)))] };
  }
  async generatedUrls(rel: string, name: string) {
    const path = join(this.path(rel, [2]), name), fileRel = `${rel}/${name}`;
    return { thumb: await this.url(path, fileRel, 360), full: await this.url(path, fileRel, 1400) };
  }
  // A saved file to show at `width` px: the engine's thumbnail of it when it has made one, else what it needs to make it.
  async thumbnail(rel: string, width: number) {
    const path = this.path(rel, [3, 4]);
    requireThat(isImage(path), 'VALIDATION_FAILED', 'Not an image');
    const info = await stat(path, { bigint: true }).catch(() => undefined);
    if (!info?.isFile()) throw new AppError('ARTWORK_NOT_FOUND', 'Not an image', 404);
    const key = sha256(`${rel}|${info.mtimeNs}|${info.size}|${width}`);
    for (const [suffix, type] of [['.jpg', 'image/jpeg'], ['.png', 'image/png']] as const) {
      const cached = join(this.cache, 'thumbs', key + suffix);
      const bytes = await readFile(cached).catch(() => undefined);
      // Still in use, so the engine's cache pruning keeps it
      if (bytes) { const now = new Date(); await utimes(cached, now, now).catch(() => {}); return { key, bytes, type }; }
    }
    return { key, bytes: undefined, type: undefined };
  }

  // Picks
  private async picked(folder: string, kind: string, name: string, candidate = false) {
    const match = PICK.exec(basename(name, extname(name))), path = join(folder, name);
    const ok = (kind === 'poster' || kind === 'logo') && basename(name) === name && !name.includes('\\') && isImage(name) && !!match && match[1]!.toLowerCase() === kind && (!candidate || !!match[2])
      && (await stat(path).catch(() => undefined))?.isFile();
    requireThat(ok, 'VALIDATION_FAILED', candidate ? 'Not a candidate file' : 'Not a poster or logo file');
    return path;
  }
  private async keptName(path: string, kind: Kind) { return `${kind}-${sha256(await readFile(path)).slice(0, 8)}${extname(path).toLowerCase()}`; }
  // Make `chosen` (or nothing) the folder's poster/logo; the old one stays beside it as poster-<hash>, never deleted, except a
  // collection's generated background, which is only ever kept as generated.png. Returns the name the old one is kept as.
  private async swap(folder: string, kind: Kind, chosen?: string) {
    const current = await this.source(folder, kind), generated = kind === 'poster' ? await this.source(folder, 'generated') : undefined;
    let kept = current && join(folder, await this.keptName(current, kind));
    if (current && generated && sha256(await readFile(current)) === sha256(await readFile(generated))) { await unlink(current); kept = generated; }
    else if (current && kept && await exists(kept)) await unlink(current);  // The same image is already kept
    else if (current && kept) await rename(current, kept);
    if (chosen && chosen === generated) await copyFile(chosen, join(folder, kind + extname(chosen).toLowerCase()));  // Copied, so it stays on offer
    else if (chosen) await rename(chosen, join(folder, kind + extname(chosen).toLowerCase()));
    return kept ? basename(kept) : null;
  }
  async select(rel: string, kind: Kind, name: string) {
    const { title, folder, titleRel } = await this.locate(rel);
    requireThat(kind === 'poster' || folder === title, 'VALIDATION_FAILED', 'Seasons use the series logo; change it on the series');
    const kept = await this.swap(folder, kind, await this.picked(folder, kind, name, true));
    const was = kind === 'logo' && !!(await this.meta(title)).no_logo;
    if (was) await this.writeMeta(title, meta => { delete meta.no_logo; });  // Picking a logo means wanting one
    if (!(await this.meta(title)).rating_key) return { warning: NO_KEY };
    await this.mark([{ rel: titleRel, before: [`${rel}|${kind}`, kept] }, ...was ? [{ rel: titleRel, before: [`${rel}|nologo`, true] as [string, boolean] }] : []]);
    return { warning: null };
  }
  async noLogo(rel: string, on: boolean) {
    const { title, folder, titleRel } = await this.locate(rel);
    requireThat(folder === title, 'VALIDATION_FAILED', 'Seasons use the series logo; change it on the series');
    const was = !!(await this.meta(title)).no_logo;
    if (was === on) return { warning: null };
    await this.writeMeta(title, meta => { delete meta.no_logo; if (on) meta.no_logo = true; });
    if (!(await this.meta(title)).rating_key) return { warning: NO_KEY };
    await this.mark([{ rel: titleRel, before: [`${rel}|nologo`, was] }]);
    return { warning: null };
  }
  async remove(rel: string, kind: Kind, name: string) { await unlink(await this.picked((await this.locate(rel)).folder, kind, name, true)); }

  // Titles changed since their last push, with the file in use before the first change at each spot (Discard puts it back).
  // tk.box keeps this list; the engine's worker is handed a title's entry when it needs it.
  private pendingMap() { return this.pending ??= readJson<Record<string, Pending>>(join(this.cache, 'web_pending.json'), {}); }
  private sourceMap() { return this.sources ??= readJson<Record<string, string>>(join(this.cache, 'web_sources.json'), {}); }
  async state(upload: boolean) { return { upload, pending: { ...await this.pendingMap() } }; }
  async entry(rel: string) { return (await this.pendingMap())[rel]; }
  private serialized(work: () => Promise<void>) { const next = this.writing.then(work); this.writing = next.catch(() => {}); return next; }
  // Marks a title changed (with what was in use before at that spot, kept from the first change on) or, with `clear`, pushed.
  async mark(marks: Mark[], clear = false) {
    const pending = await this.pendingMap();
    await this.serialized(async () => {
      for (const { rel, before } of marks) {
        if (clear) { delete pending[rel]; continue; }
        const entry = pending[rel] ?? { title: String((await this.meta(this.path(rel, [2]))).title || basename(rel)), before: {} };
        // Titles changed before this was recorded can't be put back
        if (before && entry.before && !(before[0] in entry.before)) entry.before[before[0]] = before[1];
        pending[rel] = entry;
      }
      await atomicWrite(join(this.cache, 'web_pending.json'), JSON.stringify(pending, null, 2));
    });
  }
  // Where a set-aside file (poster-<hash>) came from: the online picture it was downloaded from, so the page shows it in that
  // picture's place, a pasted link, or "own" for an upload or crop.
  async remember(name: string, source: string) {
    const match = /^(?:poster|logo)-([0-9a-f]{8})\.\w+$/.exec(name);
    if (!match) return;
    const sources = await this.sourceMap();
    await this.serialized(async () => { sources[match[1]!] = source; await atomicWrite(join(this.cache, 'web_sources.json'), JSON.stringify(sources)); });
  }

  // Pushes
  async key(rel: string) {
    const { folder } = await this.locate(rel), key = (await this.meta(folder)).rating_key;
    requireThat(key && /^\d+$/.test(String(key)), 'VALIDATION_FAILED', `${basename(folder)} has no Plex ID saved yet; run the script for it once first`);
    return String(key);
  }
  // The title's Plex ID, found again by its TMDb, TVDB or IMDb ID (and saved) when Plex has given it a new one: its file was
  // re-added, or its library rebuilt.
  async currentKey(rel: string, plex: Plex, libraries: { key: string; type: string }[]) {
    const key = await this.key(rel);
    if ((await plex(`/library/metadata/${key}`)).status !== 404) return key;
    const folder = this.path(rel, [2]), meta = await this.meta(folder), type = meta.type === 'movie' ? 'movie' : meta.type === 'tv' ? 'show' : undefined;
    const ids = ([['tmdb', meta.tmdb_id], ['tvdb', meta.tvdb_id], ['imdb', meta.imdb_id]] as const).filter(([, v]) => v).map(([name, v]) => `${name}://${v}`);
    requireThat(type && ids.length, 'ARTWORK_NOT_LINKED', `Plex no longer has ${basename(folder)} under its saved ID, and it has no TMDb, TVDB or IMDb ID to find it by`, 409);
    const items: { ratingKey: string; guids: string[] }[] = [];
    for (const library of libraries.filter(l => l.type === type)) {
      for (let start = 0; ; start += 500) {
        const page = (await plex(`/library/sections/${library.key}/all`, { includeGuids: 1, 'X-Plex-Container-Start': start, 'X-Plex-Container-Size': 500 })).data as { MediaContainer?: { totalSize?: number; size?: number; Metadata?: { ratingKey?: string; Guid?: { id?: string }[] }[] } } | undefined;
        const rows = page?.MediaContainer?.Metadata ?? [];
        items.push(...rows.flatMap(r => r.ratingKey ? [{ ratingKey: String(r.ratingKey), guids: (r.Guid ?? []).map(g => String(g.id ?? '')) }] : []));
        if (rows.length < 500 || start + rows.length >= (page?.MediaContainer?.totalSize ?? Infinity)) break;
      }
    }
    // TMDb first, then TVDB, then IMDb: the first ID any title in Plex matches decides
    const match = ids.map(id => items.find(i => i.guids.includes(id))).find(Boolean);
    requireThat(match, 'ARTWORK_NOT_LINKED', `Plex no longer has ${basename(folder)}: neither its saved Plex ID nor its TMDb, TVDB or IMDb ID is in your libraries`, 409);
    await this.writeMeta(folder, m => { m.rating_key = match.ratingKey; });
    return match.ratingKey;
  }
  // The job each title's push runs; tk.box marks each one pushed when it succeeds. A new logo reaches every season and every
  // episode card; --changed-only skips whatever didn't change, so shows with title cards (turned on, or already rendered)
  // always include them.
  async push(ids: string[] | undefined, episodes: boolean, plex: Plex, libraries: { key: string; type: string }[]) {
    const pending = await this.pendingMap(), chosen = ids ?? Object.keys(pending);
    requireThat(chosen.length, 'VALIDATION_FAILED', 'Nothing to push');
    return Promise.all(chosen.map(async rel => {
      const folder = this.path(rel, [2]), tv = rel.startsWith('tv/'), key = await this.currentKey(rel, plex, libraries);
      const cards = tv && (episodes || (await Promise.all((await readdir(folder, { withFileTypes: true })).filter(e => e.isDirectory() && SEASON.test(e.name))
        .map(e => readdir(join(folder, e.name), { withFileTypes: true }).then(inner => inner.some(i => i.isDirectory() && /^Episode \d+$/.test(i.name)))))).some(Boolean));
      return { id: rel, title: pending[rel]?.title || String((await this.meta(folder)).title || basename(rel)),
        args: ['--item', key, '--changed-only', ...tv ? ['--with-seasons'] : [], ...cards ? ['--with-episodes'] : []] };
    }));
  }
}
