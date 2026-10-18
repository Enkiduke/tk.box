import { z } from 'zod';
import {createHash} from 'node:crypto';
import {ArtworkCache} from './artwork-cache.js';
import type { Config } from '../config.js';
import { AppError, requireThat } from '../errors.js';
import {catalogContainer,catalogDto,catalogQuery,groupRecentEpisodes,applyCatalogFilters,artworkPath,type CatalogQuery,type CatalogAction} from './plex-catalog.js';
import type {CatalogPage} from '../../../../packages/contracts/src/index.js';

const accountSchema = z.object({ id: z.union([z.string(), z.number()]).transform(String) });
const pinSchema = z.object({ id: z.number().int(), code: z.string(), expiresIn: z.number().positive(), authToken: z.string().nullable().optional() });
const resourceSchema = z.array(z.object({ clientIdentifier: z.string(), provides: z.string(), owned: z.boolean(), accessToken: z.string().min(1).optional() }));
const librariesSchema = z.object({ MediaContainer: z.object({ Directory: z.array(z.object({ key: z.string(), title: z.string(), type: z.string() })).default([]) }) });
export const metadataSchema = z.object({
  ratingKey: z.string(), librarySectionID: z.union([z.string(), z.number()]).transform(String),
  title: z.string(), duration: z.number().positive(), type: z.enum(['movie', 'episode']),
  viewOffset: z.number().optional(),
  viewCount: z.number().int().nonnegative().optional(), lastViewedAt: z.number().optional(),
  Media: z.array(z.object({ container: z.string(), videoCodec: z.string(), audioCodec: z.string().optional(),
    width: z.number().positive().optional(), height: z.number().positive().optional(),
    // `file` is the part's absolute path on the Plex host; same-host mode (LocalMedia) may read it from disk.
    Part: z.array(z.object({ key: z.string(), file: z.string().min(1).max(4096).optional(), Stream: z.array(z.object({ id: z.union([z.string(), z.number()]).transform(String), streamType: z.number(), codec: z.string().optional(), bitDepth: z.number().int().positive().optional(), languageCode: z.string().optional(), selected: z.union([z.boolean(), z.number()]).optional(),
      // Track menu details. `key` is present only for sidecar subtitle files; `index` is the container stream index.
      key: z.string().optional(), index: z.number().int().nonnegative().optional(), language: z.string().max(100).optional(), title: z.string().max(200).optional(),
      displayTitle: z.string().max(200).optional(), extendedDisplayTitle: z.string().max(300).optional(), forced: z.union([z.boolean(), z.number()]).optional(), default: z.union([z.boolean(), z.number()]).optional(), channels: z.number().int().positive().optional() })).optional() })) }))
});
// Text formats FFmpeg converts to WebVTT. Image subtitles (PGS, VobSub) would need a video encode to burn in.
const textSubtitleFormats: Record<string, string> = { srt: 'srt', subrip: 'srt', ass: 'ass', ssa: 'ass', vtt: 'webvtt', webvtt: 'webvtt', mov_text: 'mov_text', text: 'srt' };
export const subtitleInputFormat = (codec?: string) => codec ? textSubtitleFormats[codec.toLowerCase()] : undefined;
// The track a browser plays from the original file (container default, else the first),
// and the one Plex's transcoder uses (the account's persisted selection).
export function audioStreams(item: PlexMetadata) {
  const audio = (item.Media[0]?.Part[0]?.Stream ?? []).filter(s => s.streamType === 2);
  return { audio, fileDefault: audio.find(s => s.default) ?? audio[0], plexSelected: audio.find(s => s.selected) };
}
// `playingAudio` replaces Plex's selection flag with the track this session actually delivers.
export function mediaTracks(item: PlexMetadata, playingAudio?: string) {
  const streams = item.Media[0]?.Part[0]?.Stream ?? [], label = (s: (typeof streams)[number]) => s.extendedDisplayTitle ?? s.displayTitle ?? s.title ?? s.language ?? 'Unknown';
  return {
    audio: streams.filter(s => s.streamType === 2).map(s => ({ id: s.id, label: label(s), language: s.languageCode, selected: playingAudio === undefined ? !!s.selected : s.id === playingAudio })),
    subtitles: streams.filter(s => s.streamType === 3).map(s => ({ id: s.id, label: label(s), language: s.languageCode, forced: !!s.forced, selected: !!s.selected, supported: !!subtitleInputFormat(s.codec) && (!!s.key || s.index !== undefined) })),
  };
}
const decisionSchema = z.object({ MediaContainer: z.object({
  generalDecisionCode: z.coerce.number().optional(),
  Metadata: z.array(z.object({ Media: z.array(z.object({ Part: z.array(z.object({ Stream: z.array(z.object({ id: z.union([z.string(), z.number()]).transform(String).optional(), streamType: z.coerce.number(), decision: z.string().optional() })).default([]) })).default([]) })).default([]) })).default([])
}) });
// Plex's universal transcoder namespace. Every proxied path stays below one session directory.
export const transcodeRoot = '/video/:/transcode/universal/';
export type TranscodeProfile = { videoCodecs: string[]; audioCodecs: string[]; maxWidth?: number; maxHeight?: number };
export type PlexMetadata = z.infer<typeof metadataSchema>;
export type PlexGrant = { accountId: string; role: 'admin' | 'viewer'; serverToken: string; libraries: { key: string; title: string; type: string }[] };

export class PlexAdapter {
  private images=new ArtworkCache();
  private imageRequests=new Map<string,Promise<{bytes:Buffer;type:string}>>();
  constructor(private config: Config, private clientId: string, private transport: typeof fetch = fetch) {}
  private headers(token?: string) {
    return { Accept: 'application/json', 'X-Plex-Product': 'tk.box', 'X-Plex-Version': '0.0.1',
      'X-Plex-Client-Identifier': this.clientId, ...(token ? { 'X-Plex-Token': token } : {}) };
  }
  private async json(url: URL, token?: string, method = 'GET') {
    try {
      const response = await this.transport(url, { method, headers: this.headers(token), redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError(response.status === 401 || response.status === 403 ? 'PLEX_ACCESS_DENIED' : 'PLEX_UNAVAILABLE', 'Plex request could not be completed.', response.status === 401 || response.status === 403 ? 403 : 502);
      }
      const chunks: Uint8Array[] = []; let size = 0;
      const reader = response.body?.getReader();
      if (reader) try {
        while (true) {
          const {done, value: chunk} = await reader.read(); if (done) break;
          size += chunk.length;
          if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new AppError('PLEX_RESPONSE_LIMIT', 'Plex response exceeded its size limit.', 502); }
          chunks.push(chunk);
        }
      } finally { reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError('PLEX_UNAVAILABLE', 'Plex is unavailable or returned invalid data.', 502);
    }
  }
  async createPin() {
    return pinSchema.parse(await this.json(new URL('https://plex.tv/api/v2/pins?strong=true'), undefined, 'POST'));
  }
  async pollPin(id: number, code: string) {
    const url = new URL(`https://plex.tv/api/v2/pins/${id}`); url.searchParams.set('code', code);
    const pin = pinSchema.parse(await this.json(url));
    requireThat(pin.id === id && pin.code === code, 'INVALID_PIN', 'Plex linking challenge mismatch.', 403);
    return pin.authToken;
  }
  authUrl(code: string) {
    const q = new URLSearchParams({ clientID: this.clientId, code, 'context[device][product]': 'tk.box' });
    // No caller-controlled redirect or untrusted Host header participates in account linking.
    return `https://app.plex.tv/auth#?${q}`;
  }
  async serverIdentity(token?: string) {
    return z.object({MediaContainer:z.object({machineIdentifier:z.string().min(1)})}).parse(await this.json(new URL('/identity',this.config.PLEX_URL),token)).MediaContainer.machineIdentifier;
  }
  // Local setup only: derive the bootstrap administrator from verified ownership
  // of this fixed server, never from the first account that happens to sign in.
  async discoverOwner(accountToken: string) {
    const account=accountSchema.parse(await this.json(new URL('https://plex.tv/api/v2/user'),accountToken));
    const resources=resourceSchema.parse(await this.json(new URL('https://plex.tv/api/v2/resources?includeHttps=1'),accountToken));
    const machineId=await this.serverIdentity();
    requireThat(!this.config.PLEX_MACHINE_ID||this.config.PLEX_MACHINE_ID===machineId,'PLEX_SERVER_MISMATCH','Configured Plex server identity does not match.',403);
    const matches=resources.filter(r=>r.clientIdentifier===machineId&&r.provides.split(',').includes('server'));
    requireThat(matches.length===1&&matches[0]!.owned&&matches[0]!.accessToken,'PLEX_OWNER_REQUIRED','Sign in with the Plex account that owns the configured server.',403);
    requireThat(!this.config.PLEX_OWNER_ACCOUNT_ID||this.config.PLEX_OWNER_ACCOUNT_ID===account.id,'PLEX_OWNER_MISMATCH','Setup cannot replace an already configured owner.',403);
    const serverToken=matches[0]!.accessToken!;
    requireThat(await this.serverIdentity(serverToken)===machineId,'PLEX_SERVER_MISMATCH','Plex server identity changed during setup.',403);
    const libraries=librariesSchema.parse(await this.json(new URL('/library/sections',this.config.PLEX_URL),serverToken)).MediaContainer.Directory.filter(l=>['movie','show'].includes(l.type));
    requireThat(libraries.some(l=>l.type==='movie')&&libraries.some(l=>l.type==='show'),'PLEX_LIBRARIES_REQUIRED','The configured server must expose Movies and TV libraries to its owner.',403);
    const required=this.config.requiredLibraries.length?this.config.requiredLibraries:libraries.map(l=>l.key);
    requireThat(required.every(id=>libraries.some(l=>l.key===id))&&required.some(id=>libraries.some(l=>l.key===id&&l.type==='movie'))&&required.some(id=>libraries.some(l=>l.key===id&&l.type==='show')),'PLEX_LIBRARIES_REQUIRED','Required library IDs must identify accessible Movies and TV libraries.',403);
    requireThat(/^\d+$/.test(account.id)&&required.every(id=>/^\d+$/.test(id)),'PLEX_INVALID_ID','Plex returned invalid account or library identifiers.',502);
    return {ownerAccountId:account.id,machineId,requiredLibraryIds:required,libraries};
  }
  async authorize(accountToken: string): Promise<PlexGrant> {
    requireThat(this.config.plexConfigured, 'SETUP_REQUIRED', 'Configure Plex owner, machine and library IDs first.', 503);
    const [accountData,resourceData]=await Promise.all([this.json(new URL('https://plex.tv/api/v2/user'),accountToken),this.json(new URL('https://plex.tv/api/v2/resources?includeHttps=1'),accountToken)]);
    const account=accountSchema.parse(accountData),resources=resourceSchema.parse(resourceData);
    const matches = resources.filter(r => r.clientIdentifier === this.config.PLEX_MACHINE_ID && r.provides.split(',').includes('server'));
    requireThat(matches.length === 1 && matches[0]?.accessToken, 'PLEX_ACCESS_DENIED', 'This Plex account has no verified access to the configured server.', 403);
    const resource = matches[0]!;
    const serverToken = resource.accessToken!;
    const [identityData,libraryData]=await Promise.all([this.json(new URL('/identity',this.config.PLEX_URL),serverToken),this.json(new URL('/library/sections',this.config.PLEX_URL),serverToken)]);
    const identity = z.object({ MediaContainer: z.object({ machineIdentifier: z.string() }) }).parse(identityData);
    requireThat(identity.MediaContainer.machineIdentifier === this.config.PLEX_MACHINE_ID, 'PLEX_SERVER_MISMATCH', 'Configured Plex server identity does not match.', 403);
    const libraries = librariesSchema.parse(libraryData).MediaContainer.Directory;
    requireThat(this.config.requiredLibraries.every(id => libraries.some(l => l.key === id && ['movie', 'show'].includes(l.type))), 'PLEX_ACCESS_DENIED', 'Required Movies and TV library grants are missing.', 403);
    const isOwner = account.id === this.config.PLEX_OWNER_ACCOUNT_ID;
    requireThat(!isOwner || resource.owned, 'PLEX_ACCESS_DENIED', 'Configured owner does not own this Plex server.', 403);
    return { accountId: account.id, role: isOwner ? 'admin' : 'viewer', serverToken, libraries };
  }
  async metadata(grant: PlexGrant, ratingKey: string) {
    requireThat(/^\d+$/.test(ratingKey), 'INVALID_MEDIA', 'Invalid Plex media identifier.');
    const result = z.object({ MediaContainer: z.object({ Metadata: z.array(metadataSchema) }) }).parse(await this.json(new URL(`/library/metadata/${ratingKey}`, this.config.PLEX_URL), grant.serverToken));
    const item = result.MediaContainer.Metadata[0];
    requireThat(item && item.ratingKey === ratingKey && grant.libraries.some(l => l.key === item.librarySectionID), 'PLEX_ACCESS_DENIED', 'Media is not accessible to this account.', 403);
    return item;
  }
  private library(grant:PlexGrant,id:string) {
    requireThat(/^\d+$/.test(id),'INVALID_LIBRARY','Invalid library identifier.');
    const library=grant.libraries.find(l=>l.key===id&&['movie','show'].includes(l.type));
    requireThat(library,'PLEX_ACCESS_DENIED','Library is not accessible to this account.',403);return library;
  }
  private async catalogNode(grant:PlexGrant,id:string) {
    requireThat(/^\d+$/.test(id),'INVALID_MEDIA','Invalid Plex media identifier.');
    const container=catalogContainer.parse(await this.json(new URL(`/library/metadata/${id}`,this.config.PLEX_URL),grant.serverToken)).MediaContainer;
    const node=container.Metadata[0];requireThat(container.Metadata.length===1&&node?.ratingKey===id,'MEDIA_NOT_FOUND','Media is unavailable.',404);
    let section=node.librarySectionID??container.librarySectionID,ancestor=node.parentRatingKey;const visited=new Set([id]);
    // Some Plex versions omit the section on seasons; resolve only through actual
    // metadata ancestors, never a client-supplied library claim.
    for(let depth=0;!section&&ancestor&&depth<2;depth++) {
      requireThat(!visited.has(ancestor),'PLEX_ACCESS_DENIED','Invalid media ancestry.',403);visited.add(ancestor);
      const parent=catalogContainer.parse(await this.json(new URL(`/library/metadata/${ancestor}`,this.config.PLEX_URL),grant.serverToken)).MediaContainer;
      const record=parent.Metadata[0];requireThat(parent.Metadata.length===1&&record?.ratingKey===ancestor,'PLEX_ACCESS_DENIED','Media ancestry is unavailable.',403);
      section=record.librarySectionID??parent.librarySectionID;ancestor=record.parentRatingKey;
    }
    requireThat(section,'PLEX_ACCESS_DENIED','Media library could not be verified.',403);this.library(grant,section);
    return {node,section};
  }
  async catalogItem(grant:PlexGrant,id:string) {const {node,section}=await this.catalogNode(grant,id);return catalogDto(node,section);}
  // Viewer-requested watch state changes, written with the viewer's own server token so
  // they land in that account's Plex history. Never reachable from a playback session.
  async catalogWatchState(grant:PlexGrant,id:string,action:CatalogAction) {
    const {node}=await this.catalogNode(grant,id);
    requireThat(action!=='removeContinue'||node.type==='movie'||node.type==='episode','INVALID_MEDIA','Only movies and episodes appear in Continue Watching.');
    const url=new URL(action==='removeContinue'?'/actions/removeFromContinueWatching':action==='watched'?'/:/scrobble':'/:/unscrobble',this.config.PLEX_URL);
    if(action==='removeContinue')url.searchParams.set('ratingKey',id);
    else {url.searchParams.set('identifier','com.plexapp.plugins.library');url.searchParams.set('key',id);}
    try {
      const r=await this.transport(url,{method:'PUT',headers:this.headers(grant.serverToken),redirect:'error',signal:AbortSignal.timeout(10000)});
      await r.body?.cancel();if(!r.ok)throw new Error();
    } catch {throw new AppError('PLEX_UNAVAILABLE','Plex could not update this title.',502);}
  }
  async catalogGenres(grant:PlexGrant,libraryId:string) {
    this.library(grant,libraryId);
    const url=new URL(`/library/sections/${libraryId}/genre`,this.config.PLEX_URL);
    const result=z.object({MediaContainer:z.object({Directory:z.array(z.object({key:z.union([z.string().regex(/^\d+$/).max(20),z.number().int().nonnegative()]).transform(String),title:z.string().max(200)})).max(2000).default([])})}).parse(await this.json(url,grant.serverToken));
    return {genres:result.MediaContainer.Directory.map(({key,title})=>({id:key,title}))};
  }
  async catalogIndex(grant:PlexGrant,libraryId:string,input:Partial<CatalogQuery>) {
    const library=this.library(grant,libraryId),query=catalogQuery.parse(input);
    requireThat(query.sort==='title'&&['all','unwatched'].includes(query.shelf),'INVALID_INDEX','Alphabetical navigation requires a title-sorted library.');
    const url=new URL(`/library/sections/${libraryId}/firstCharacter`,this.config.PLEX_URL);
    applyCatalogFilters(url,query,library.type);if(query.shelf==='unwatched')url.searchParams.set('unwatched','1');
    const result=z.object({MediaContainer:z.object({Directory:z.array(z.object({title:z.string().max(16),size:z.coerce.number().int().nonnegative().max(1000000)})).max(512).default([])})}).parse(await this.json(url,grant.serverToken));
    let offset=0;const entries=result.MediaContainer.Directory.map(row=>{const value={label:row.title,count:row.size,offset};offset+=row.size;return value;});
    return {entries:entries.filter(e=>e.count>0),total:offset};
  }
  async catalogPage(grant:PlexGrant,libraryId:string,input:Partial<CatalogQuery>):Promise<CatalogPage> {
    const library=this.library(grant,libraryId),query=catalogQuery.parse(input);
    const path=query.shelf==='continue'?'onDeck':query.shelf==='recent'?'recentlyAdded':'all';
    const url=new URL(`/library/sections/${libraryId}/${path}`,this.config.PLEX_URL);
    if(path==='all')applyCatalogFilters(url,query,library.type);
    else {if(query.q)url.searchParams.set('title',query.q);if(query.genre)url.searchParams.set('genre',query.genre);}
    // The first page of recent TV over-fetches episodes so season batches can be grouped into full cards.
    const grouped=path==='recentlyAdded'&&library.type==='show'&&query.offset===0,size=grouped?60:query.limit;
    url.searchParams.set('X-Plex-Container-Start',String(query.offset));url.searchParams.set('X-Plex-Container-Size',String(size));
    url.searchParams.set('excludeElements','Media,Role,Director,Writer,Country,Guid,Collection,Producer');
    const container=catalogContainer.parse(await this.json(url,grant.serverToken)).MediaContainer;
    requireThat(container.Metadata.length<=size,'PLEX_PAGINATION_INVALID','Plex did not honor the requested page limit.',502);
    requireThat(container.offset===undefined||container.offset===query.offset,'PLEX_PAGINATION_INVALID','Plex returned an unexpected page.',502);
    const items=container.Metadata.map(node=>{requireThat((node.librarySectionID??container.librarySectionID??libraryId)===libraryId,'PLEX_ACCESS_DENIED','Plex returned media outside the requested library.',403);return catalogDto(node,libraryId);});
    if(grouped){const cards=groupRecentEpisodes(items);return {items:cards.slice(0,query.limit),offset:0,limit:query.limit,hasMore:cards.length>query.limit||(container.totalSize!==undefined?items.length<container.totalSize:items.length===size)};}
    return {items,offset:query.offset,limit:query.limit,total:container.totalSize,hasMore:container.totalSize!==undefined?query.offset+items.length<container.totalSize:items.length===query.limit};
  }
  async catalogChildren(grant:PlexGrant,id:string,input:Partial<CatalogQuery>):Promise<CatalogPage> {
    const {node,section}=await this.catalogNode(grant,id),query=catalogQuery.parse(input);
    requireThat(node.type==='show'||node.type==='season','INVALID_MEDIA','Only shows and seasons have browsable children.');
    const url=new URL(`/library/metadata/${id}/children`,this.config.PLEX_URL);
    url.searchParams.set('sort','index:asc');
    url.searchParams.set('X-Plex-Container-Start',String(query.offset));url.searchParams.set('X-Plex-Container-Size',String(query.limit));
    const container=catalogContainer.parse(await this.json(url,grant.serverToken)).MediaContainer;
    requireThat(container.Metadata.length<=query.limit&&(container.offset===undefined||container.offset===query.offset),'PLEX_PAGINATION_INVALID','Plex returned an unexpected child page.',502);
    const items=container.Metadata.map(child=>{
      requireThat((child.librarySectionID??container.librarySectionID??section)===section&&child.type===(node.type==='show'?'season':'episode')&&(!child.parentRatingKey||child.parentRatingKey===id),'PLEX_ACCESS_DENIED','Plex returned unrelated child media.',403);
      return catalogDto(child,section);
    });
    return {items,offset:query.offset,limit:query.limit,total:container.totalSize,hasMore:container.totalSize!==undefined?query.offset+items.length<container.totalSize:items.length===query.limit};
  }
  async artwork(grant:PlexGrant,id:string,kind:'poster'|'backdrop') {
    const {node}=await this.catalogNode(grant,id),path=artworkPath(kind==='backdrop'?node.art:node.thumb??node.parentThumb??node.grandparentThumb);
    requireThat(path,'ARTWORK_NOT_FOUND','Artwork is unavailable.',404);
    const cacheKey=createHash('sha256').update(JSON.stringify([grant.accountId,grant.serverToken,path,kind])).digest('hex');
    const cached=this.images.get(cacheKey);if(cached)return cached;
    let pending=this.imageRequests.get(cacheKey);
    if(!pending){pending=this.loadArtwork(path,kind,grant.serverToken).then(image=>{this.images.set(cacheKey,image);return image;}).finally(()=>this.imageRequests.delete(cacheKey));this.imageRequests.set(cacheKey,pending);}
    return pending;
  }
  private async loadArtwork(path:string,kind:'poster'|'backdrop',serverToken:string) {
    const url=new URL('/photo/:/transcode',this.config.PLEX_URL);
    url.searchParams.set('url',path);url.searchParams.set('width',kind==='poster'?'360':'1280');url.searchParams.set('height',kind==='poster'?'540':'720');url.searchParams.set('minSize','1');url.searchParams.set('upscale','0');
    try {
      const response=await this.transport(url,{headers:this.headers(serverToken),redirect:'error',signal:AbortSignal.timeout(10000)});
      const type=response.headers.get('content-type')?.split(';')[0];
      if(!response.ok||!type||!['image/jpeg','image/png','image/webp','image/gif'].includes(type)){await response.body?.cancel();throw new AppError('ARTWORK_NOT_FOUND','Artwork is unavailable.',404);}
      const reader=response.body?.getReader();requireThat(reader,'ARTWORK_NOT_FOUND','Artwork is unavailable.',404);let size=0;const chunks:Uint8Array[]=[];
      try {while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;requireThat(size<=6*1024*1024,'ARTWORK_LIMIT','Artwork exceeded its size limit.',502);chunks.push(chunk.value);}}
      finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      requireThat(size>0,'ARTWORK_NOT_FOUND','Artwork is unavailable.',404);return {bytes:Buffer.concat(chunks),type};
    }catch(error){if(error instanceof AppError)throw error;throw new AppError('ARTWORK_UNAVAILABLE','Artwork could not be loaded.',502);}
  }
  async directPart(grant: PlexGrant, item: PlexMetadata, range?: string, signal?: AbortSignal) {
    const key = item.Media[0]?.Part[0]?.key;
    requireThat(key && /^\/library\/parts\/\d+\/\d+\/file(?:\.[a-zA-Z0-9]+)?$/.test(key), 'SOURCE_INCOMPATIBLE', 'Unsupported Plex part reference.', 422);
    const connection = new AbortController(), timer = setTimeout(() => connection.abort(), 10000);
    let response: Response;
    try {response = await this.transport(new URL(key, this.config.PLEX_URL), { headers: { ...this.headers(grant.serverToken), ...(range ? { Range: range } : {}) }, redirect: 'error', signal: signal ? AbortSignal.any([signal, connection.signal]) : connection.signal });}
    catch {throw new AppError('PLEX_STREAM_FAILED', 'Plex media delivery failed.', 502);}
    finally {clearTimeout(timer);}
    if (![200, 206, 416].includes(response.status)) { await response.body?.cancel(); throw new AppError('PLEX_STREAM_FAILED', 'Plex media delivery failed.', 502); }
    const type = response.headers.get('content-type')?.split(';')[0] ?? '';
    if (response.status !== 416 && !/^(video\/|audio\/|application\/octet-stream$)/.test(type)) {await response.body?.cancel(); throw new AppError('SOURCE_INCOMPATIBLE', 'Plex returned an unsupported media type.', 422);}
    return response;
  }
  // A sidecar subtitle file is small and fetched alone; an embedded track needs the whole part.
  async subtitleSource(grant: PlexGrant, item: PlexMetadata, key: string | undefined, signal?: AbortSignal) {
    if (!key) return this.directPart(grant, item, undefined, signal);
    requireThat(/^\/library\/streams\/\d+$/.test(key), 'SOURCE_INCOMPATIBLE', 'Unsupported Plex subtitle reference.', 422);
    let response: Response;
    try { response = await this.transport(new URL(key, this.config.PLEX_URL), { headers: { ...this.headers(grant.serverToken), Accept: '*/*' }, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) }); }
    catch { throw new AppError('PLEX_STREAM_FAILED', 'Plex subtitle delivery failed.', 502); }
    if (!response.ok) { await response.body?.cancel(); throw new AppError('PLEX_STREAM_FAILED', 'Plex subtitle delivery failed.', 502); }
    return response;
  }
  // Generic profile fully described by X-Plex-Client-Profile-Extra, so Plex only
  // offers what this browser accepts. Subtitles are never burned in: that would
  // silently turn a stream copy into a video encode.
  transcodeParams(ratingKey: string, session: string, profile: TranscodeProfile, audioStreamId?: string) {
    const target = 'type=videoProfile&context=streaming&protocol=hls';
    const extra = [`add-transcode-target(${target}&container=mpegts&videoCodec=${profile.videoCodecs.join(',')}&audioCodec=${profile.audioCodecs.join(',')}&subtitleCodec=&replace=true)`,
      ...profile.audioCodecs.map(codec => `add-transcode-target-audio-codec(${target}&audioCodec=${codec})`),
      ...profile.audioCodecs.map(codec => `add-limitation(scope=videoAudioCodec&scopeName=${codec}&type=upperBound&name=audio.channels&value=${codec === 'mp3' ? 2 : 6})`),
      ...(profile.maxWidth ? [`add-limitation(scope=videoCodec&scopeName=*&type=upperBound&name=video.width&value=${profile.maxWidth})`] : []),
      ...(profile.maxHeight ? [`add-limitation(scope=videoCodec&scopeName=*&type=upperBound&name=video.height&value=${profile.maxHeight})`] : [])];
    return new URLSearchParams({ path: `/library/metadata/${ratingKey}`, mediaIndex: '0', partIndex: '0', protocol: 'hls', fastSeek: '1', directPlay: '0', directStream: '1', directStreamAudio: '1',
      copyts: '1', hasMDE: '1', location: 'lan', mediaBufferSize: '102400', subtitles: 'none', offset: '0', session, 'X-Plex-Session-Identifier': session,
      'X-Plex-Platform': 'Generic', 'X-Plex-Client-Platform': 'Generic', 'X-Plex-Client-Profile-Name': 'Generic', 'X-Plex-Client-Profile-Extra': extra.join('+'),
      // Plex follows the part's persisted selection (see selectAudioStream); the explicit ID keeps the request self-describing.
      ...(audioStreamId ? { audioStreamID: audioStreamId } : {}) });
  }
  async transcodeDecision(grant: PlexGrant, params: URLSearchParams) {
    const url = new URL(`${transcodeRoot}decision?${params}`, this.config.PLEX_URL);
    const result = decisionSchema.parse(await this.json(url, grant.serverToken)).MediaContainer;
    const streams = result.Metadata[0]?.Media[0]?.Part[0]?.Stream;
    requireThat(streams && (result.generalDecisionCode ?? 1000) < 2000, 'PLEX_TRANSCODE_REFUSED', 'Plex cannot prepare a browser-compatible stream for this title.', 422);
    const decision = (type: number) => { const s = streams.find(x => x.streamType === type); return s ? s.decision ?? 'copy' : undefined; };
    return { video: decision(1), audio: decision(2), audioStreamId: streams.find(x => x.streamType === 2)?.id };
  }
  // Plex's transcoder uses the part's selected audio stream, which Plex stores per
  // account and shares with that account's other Plex clients, exactly as Plex Web does.
  async selectAudioStream(grant: PlexGrant, item: PlexMetadata, streamId: string) {
    const part = item.Media[0]?.Part[0], partId = part?.key.match(/^\/library\/parts\/(\d+)\//)?.[1];
    requireThat(partId && /^\d+$/.test(streamId) && part?.Stream?.some(s => s.streamType === 2 && s.id === streamId), 'INVALID_AUDIO', 'Audio track is not part of this media.');
    const url = new URL(`/library/parts/${partId}`, this.config.PLEX_URL); url.searchParams.set('audioStreamID', streamId); url.searchParams.set('allParts', '1');
    try {
      const r = await this.transport(url, { method: 'PUT', headers: this.headers(grant.serverToken), redirect: 'error', signal: AbortSignal.timeout(10000) });
      await r.body?.cancel(); if (!r.ok) throw new Error();
    } catch { throw new AppError('PLEX_UNAVAILABLE', 'Plex could not switch the audio track.', 502); }
  }
  // Fetch one transcoder resource with the server token in a header only.
  async transcodeResource(grant: PlexGrant, path: string, signal?: AbortSignal) {
    const url = new URL(path, this.config.PLEX_URL);
    requireThat(url.origin === new URL(this.config.PLEX_URL).origin && url.pathname.startsWith(transcodeRoot), 'INVALID_MEDIA', 'Unsupported transcoder path.', 400);
    const connection = AbortSignal.timeout(60000);
    let response: Response;
    try { response = await this.transport(url, { headers: { ...this.headers(grant.serverToken), Accept: '*/*' }, redirect: 'error', signal: signal ? AbortSignal.any([signal, connection]) : connection }); }
    catch { throw new AppError('PLEX_STREAM_FAILED', 'Plex media delivery failed.', 502); }
    if (!response.ok) { await response.body?.cancel(); throw new AppError(response.status === 404 ? 'SESSION_NOT_FOUND' : 'PLEX_STREAM_FAILED', 'Plex media delivery failed.', response.status === 404 ? 404 : 502); }
    return { response, url };
  }
  async transcodeControl(grant: PlexGrant, action: 'ping' | 'stop', session: string) {
    const url = new URL(`${transcodeRoot}${action}`, this.config.PLEX_URL); url.searchParams.set('session', session);
    const r = await this.transport(url, { headers: this.headers(grant.serverToken), redirect: 'error', signal: AbortSignal.timeout(10000) });
    await r.body?.cancel(); requireThat(r.ok, 'PLEX_STREAM_FAILED', 'Plex transcoder is unavailable.', 502);
  }
  async reportVod(grant: PlexGrant, ratingKey: string, timeMs: number, state: 'playing' | 'paused' | 'stopped', durationMs: number) {
    const url = new URL('/:/timeline', this.config.PLEX_URL);
    for (const [k, v] of Object.entries({ ratingKey, key: `/library/metadata/${ratingKey}`, time: Math.round(timeMs), state, duration: Math.round(durationMs) })) url.searchParams.set(k, String(v));
    // Only the VOD service can call this, after loading immutable session mode and ownership.
    try {
      const r = await this.transport(url, { headers: this.headers(grant.serverToken), redirect: 'error', signal: AbortSignal.timeout(10000) });
      await r.body?.cancel(); if (!r.ok) throw new Error();
    } catch { throw new AppError('PLEX_PROGRESS_FAILED', 'Plex progress could not be synchronized.', 502); }
  }
}

