import { AppError, requireThat, requireWritable } from '../errors.js';
import { remoteJson } from '../providers/remote-json.js';
import type { TmdbTitles } from '../providers/tmdb-titles.js';
import type { RequestStatus, RequestStore } from '../persistence/requests-store.js';

// One-time copy of Seerr's requests (docs/REQUESTS.md, step 3), so Clean Up keeps who asked for what. Self-contained:
// it goes when Seerr is removed (step 7). The address and key are used for this run only and not saved. Running it
// again adds only requests not yet copied (`seerr_id`). Nothing is sent to Radarr or Sonarr, except requests Seerr still
// held for approval: every request is approved now, so those are queued to send.
type SeerrRequest = { id?: number; status?: number; type?: string; createdAt?: string;
  media?: { tmdbId?: number; tvdbId?: number | null; status?: number; mediaAddedAt?: string | null };
  seasons?: { seasonNumber?: number }[]; requestedBy?: { plexId?: number | null; displayName?: string; plexUsername?: string; email?: string } };
export type SeerrImportResult = { imported: number; skipped: number; declined: number; withoutPlexId: number };

const PAGE = 100;
const time = (value?: string | null) => { const at = value ? Date.parse(value) : NaN; return Number.isFinite(at) ? at : undefined; };

export async function importSeerr(store: RequestStore, tmdb: Pick<TmdbTitles, 'get'>, url: string, apiKey: string, transport: typeof fetch = fetch): Promise<SeerrImportResult> {
  requireWritable();
  const base = url.replace(/\/+$/, ''), all: SeerrRequest[] = [], seen = new Set<number>();
  for (let skip = 0; ; skip += PAGE) {
    const target = new URL(`${base}/api/v1/request`);
    for (const [k, v] of Object.entries({ take: String(PAGE), skip: String(skip), filter: 'all', sort: 'added' })) target.searchParams.set(k, v);
    const response = await remoteJson(target, { headers: { 'X-Api-Key': apiKey } }, 'Seerr', transport, 20000);
    if (response.status === 401 || response.status === 403) throw new AppError('SEERR_KEY_REJECTED', 'Seerr did not accept that API key.', 400);
    requireThat(response.status === 200, 'SEERR_UNAVAILABLE', `Seerr answered ${response.status}.`, 502);
    const data = response.data as { results?: SeerrRequest[]; pageInfo?: { results?: number } } | undefined, page = data?.results ?? [];
    let repeated = false;
    for (const r of page) { if (typeof r.id !== 'number' || seen.has(r.id)) { repeated = true; continue; } seen.add(r.id); all.push(r); }
    const total = data?.pageInfo?.results;
    if (repeated || page.length < PAGE || (typeof total === 'number' && all.length >= total)) break;
  }
  const result: SeerrImportResult = { imported: 0, skipped: 0, declined: 0, withoutPlexId: 0 }, done = store.importedSeerrIds();
  const wanted = all.filter(r => {
    if (done.has(r.id!)) { result.skipped++; return false; }
    if (r.status === 3) { result.declined++; return false; }
    if ((r.type !== 'movie' && r.type !== 'tv') || !(r.media?.tmdbId && r.media.tmdbId > 0)) { result.skipped++; return false; }
    return true;
  });
  // Titles from TMDB, six at a time (TmdbTitles limits and caches its own reads).
  const titles = new Map<string, { title: string; year?: number }>();
  const keys = [...new Set(wanted.map(r => `${r.type === 'tv' ? 'tv' : 'movie'}/${r.media!.tmdbId}`))];
  for (let i = 0; i < keys.length; i += 6) await Promise.all(keys.slice(i, i + 6).map(async key => {
    const raw = await tmdb.get(`/${key}`).catch(() => undefined) as { title?: string; name?: string; release_date?: string; first_air_date?: string } | undefined;
    const date = raw?.release_date || raw?.first_air_date;
    if (raw?.title || raw?.name) titles.set(key, { title: (raw.title || raw.name)!, ...(date && /^\d{4}/.test(date) ? { year: Number(date.slice(0, 4)) } : {}) });
  }));
  for (const r of wanted) {
    const media = r.media!, kind = r.type === 'tv' ? 'show' as const : 'movie' as const, key = `${r.type === 'tv' ? 'tv' : 'movie'}/${media.tmdbId}`;
    const plexId = r.requestedBy?.plexId, addedAt = time(media.mediaAddedAt);
    // Seerr's media status: 5 available, 4 partly available. A request still waiting for approval (1) is sent now.
    const status: RequestStatus = media.status === 5 ? 'available' : media.status === 4 ? 'partial' : r.status === 1 ? 'queued' : 'requested';
    const seasons = kind === 'show' ? [...new Set((r.seasons ?? []).map(s => s.seasonNumber).filter((n): n is number => Number.isInteger(n) && n! > 0))] : [];
    if (!plexId) result.withoutPlexId++;
    const named = titles.get(key), created = time(r.createdAt);
    store.insert({ kind, tmdbId: media.tmdbId!, ...(media.tvdbId ? { tvdbId: media.tvdbId } : {}), title: named?.title ?? `TMDB ${media.tmdbId}`, ...(named?.year ? { year: named.year } : {}),
      ...(plexId ? { accountId: String(plexId) } : {}), accountName: r.requestedBy?.displayName || r.requestedBy?.plexUsername || r.requestedBy?.email || 'Seerr user',
      ...(created ? { createdAt: created } : {}), status, seerrId: r.id!, ...(status === 'available' && addedAt ? { availableAt: addedAt } : {}),
      seasons: seasons.map(season => ({ season, ...(status === 'available' && addedAt ? { availableAt: addedAt } : {}) })) });
    result.imported++;
  }
  return result;
}
