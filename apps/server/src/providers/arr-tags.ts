import { AppError, requireWritable } from '../errors.js';
import { remoteJson, remoteMessage } from './remote-json.js';

// Clean Up's Keep for a show: puts a tag on it in Sonarr, made if Sonarr doesn't have it yet. Shows are found by TMDB
// ID (Sonarr v4 records shows' TMDB IDs). The tag is added with the bulk editor, so nothing else about the show
// changes. Movies are kept by tk.box's library instead.
export type ArrService = { url: string; key?: string };

export async function tagArrTitle(service: ArrService, tmdbId: number, label: string, transport: typeof fetch = fetch) {
  requireWritable();
  const name = 'Sonarr';
  if (!service.url || !service.key) throw new AppError('CLEANUP_ARR_MISSING', `Connect ${name} in Admin › Connections to keep titles by tag.`, 409);
  const call = async (path: string, init: { method?: string; body?: unknown } = {}, maxBytes?: number) => {
    const response = await remoteJson(new URL(`${service.url}/api/v3/${path}`), { ...init, headers: { 'X-Api-Key': service.key! } }, name, transport, 15000, maxBytes);
    if (response.status >= 400) throw new AppError('CATALOG_UNAVAILABLE', response.status === 401 ? `${name} refused the API key.` : remoteMessage(response.data) ?? `${name} answered ${response.status}.`, 502);
    return response.data;
  };
  const titles = await call('series', {}, 64 * 1024 * 1024) as { id?: unknown; tmdbId?: unknown; tags?: unknown }[] | undefined;
  const title = Array.isArray(titles) ? titles.find(t => t.tmdbId === tmdbId) : undefined;
  if (typeof title?.id !== 'number') throw new AppError('CLEANUP_ARR_NOT_FOUND', `${name} has no show with TMDB ID ${tmdbId}.`, 404);
  const tags = await call('tag') as { id?: unknown; label?: unknown }[] | undefined;
  let tag = (Array.isArray(tags) ? tags : []).find(t => typeof t.label === 'string' && t.label.toLowerCase() === label.toLowerCase())?.id;
  if (typeof tag !== 'number') tag = ((await call('tag', { method: 'POST', body: { label } })) as { id?: unknown } | undefined)?.id;
  if (typeof tag !== 'number') throw new AppError('CATALOG_UNAVAILABLE', `${name} didn't make the tag “${label}”.`, 502);
  if (Array.isArray(title.tags) && title.tags.includes(tag)) return;
  await call('series/editor', { method: 'PUT', body: { seriesIds: [title.id], tags: [tag], applyTags: 'add' } });
}
