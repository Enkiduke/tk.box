import { z } from 'zod';
import {createHash} from 'node:crypto';
import {ArtworkCache} from './artwork-cache.js';
import type { Config } from '../config.js';
import { AppError, readOnly, requireThat, requireWritable } from '../errors.js';
import {type CatalogNode,catalogContainer,catalogDto,catalogQuery,groupRecentEpisodes,applyCatalogFilters,artworkPath,logoPath,versioned,type ArtworkKind,collectionsContainer,collectionDto,collectionArtwork,sortIndex,promotedHubs,promotedCollectionIds,type CatalogQuery,type CatalogAction,type CatalogCollection} from './plex-catalog.js';
import {languageKey,type CatalogItem,type CatalogPage} from '../../../../packages/contracts/src/index.js';

const accountSchema = z.object({ id: z.union([z.string(), z.number()]).transform(String), username: z.string().max(200).optional(), title: z.string().max(200).optional() });
const pinSchema = z.object({ id: z.number().int(), code: z.string(), expiresIn: z.number().positive(), authToken: z.string().nullable().optional() });
const resourceSchema = z.array(z.object({ clientIdentifier: z.string(), provides: z.string(), owned: z.boolean(), accessToken: z.string().min(1).optional() }));
const num = z.coerce.number().optional().catch(undefined), str = z.coerce.string().max(500).optional().catch(undefined);
// Plex's now-playing list. Every field is optional: clients report what they can, and one odd value must not hide every stream.
const sessionsSchema = z.object({ MediaContainer: z.object({ Metadata: z.array(z.object({
  type: str, title: str, grandparentTitle: str, parentTitle: str, ratingKey: str, grandparentRatingKey: str, parentRatingKey: str,
  year: num, index: num, parentIndex: num, duration: num, viewOffset: num, live: num,
  User: z.object({ id: str, title: str }).optional().catch(undefined),
  Player: z.object({ title: str, product: str, platform: str, state: str, address: str, remotePublicAddress: str, local: z.union([z.boolean(), z.coerce.number()]).optional().catch(undefined), machineIdentifier: str }).optional().catch(undefined),
  Session: z.object({ id: str, bandwidth: num, location: str }).optional().catch(undefined),
  Media: z.array(z.object({ videoCodec: str, audioCodec: str, width: num, height: num, container: str, bitrate: num, videoResolution: str,
    Part: z.array(z.object({ decision: str })).optional().catch(undefined) })).optional().catch(undefined),
  TranscodeSession: z.object({ videoDecision: str, audioDecision: str, sourceVideoCodec: str, sourceAudioCodec: str, videoCodec: str, audioCodec: str, container: str, sourceContainer: str,
    width: num, height: num, speed: num, throttled: z.union([z.boolean(), z.coerce.number()]).optional().catch(undefined) }).optional().catch(undefined)
})).default([]) }) });
export type PlexSession = z.infer<typeof sessionsSchema>['MediaContainer']['Metadata'][number];
const librariesSchema =z.object({ MediaContainer: z.object({ Directory: z.array(z.object({ key: z.string(), title: z.string(), type: z.string() })).default([]) }) });
export const metadataSchema = z.object({
  ratingKey: z.string(), librarySectionID: z.union([z.string(), z.number()]).transform(String),
  title: z.string(), duration: z.number().positive(), type: z.enum(['movie', 'episode']),
  year: z.number().int().optional(), grandparentTitle: z.string().max(500).optional(), grandparentRatingKey: z.union([z.string(), z.number()]).transform(String).optional(),
  parentIndex: z.number().int().nonnegative().optional(), index: z.number().int().nonnegative().optional(),
  viewOffset: z.number().optional(),
  viewCount: z.number().int().nonnegative().optional(), lastViewedAt: z.number().optional(),
  // Plex's detected intro and credits sections (requested with includeMarkers); `final` marks the closing credits.
  Marker: z.array(z.object({ type: z.string().max(40), startTimeOffset: z.number().nonnegative(), endTimeOffset: z.number().nonnegative(), final: z.union([z.boolean(), z.number()]).optional() })).max(50).optional(),
  Media: z.array(z.object({ container: z.string(), videoCodec: z.string(), audioCodec: z.string().optional(), bitrate: z.number().positive().optional(),
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
// The track for a viewer's preferred audio language, when the one that would play is in another language:
// the file's default among that language's tracks, else the first. Undefined keeps the usual choice.
export function audioForLanguage(item: PlexMetadata, language: string) {
  const { audio, fileDefault, plexSelected } = audioStreams(item), wanted = languageKey(language), current = plexSelected ?? fileDefault;
  if (!current || languageKey(current.languageCode) === wanted) return undefined;
  const matching = audio.filter(s => languageKey(s.languageCode) === wanted);
  return matching.find(s => s.default) ?? matching[0];
}
// The FFmpeg map for a custom channel's audio: English (the file's default English track first), else the file's
// default, else the first track. Plex's stream index is the file's stream index.
export function customAudioMap(item: PlexMetadata) {
  const { audio, fileDefault } = audioStreams(item), english = audio.filter(s => /^en(g)?$/i.test(s.languageCode ?? ''));
  const pick = english.find(s => s.default) ?? english[0] ?? fileDefault;
  return pick?.index === undefined ? '0:a:0?' : `0:${pick.index}`;
}
// `playingAudio` replaces Plex's selection flag with the track this session actually delivers.
export function mediaTracks(item: PlexMetadata, playingAudio?: string) {
  const streams = item.Media[0]?.Part[0]?.Stream ?? [], label = (s: (typeof streams)[number]) => s.extendedDisplayTitle ?? s.displayTitle ?? s.title ?? s.language ?? 'Unknown';
  return {
    audio: streams.filter(s => s.streamType === 2).map(s => ({ id: s.id, label: label(s), language: s.languageCode, selected: playingAudio === undefined ? !!s.selected : s.id === playingAudio })),
    subtitles: streams.filter(s => s.streamType === 3).map(s => ({ id: s.id, label: label(s), language: s.languageCode, forced: !!s.forced, selected: !!s.selected, supported: !!subtitleInputFormat(s.codec) && (!!s.key || s.index !== undefined) })),
  };
}
// The intro and credits sections the player offers to skip, in playback order. Commercial markers and empty ranges are dropped.
export function mediaMarkers(item: PlexMetadata) {
  return (item.Marker ?? []).flatMap(m => (m.type === 'intro' || m.type === 'credits') && m.endTimeOffset > m.startTimeOffset
    ? [{ type: m.type as 'intro' | 'credits', startMs: m.startTimeOffset, endMs: Math.min(m.endTimeOffset, item.duration), final: !!m.final }] : [])
    .sort((a, b) => a.startMs - b.startMs);
}
const decisionSchema = z.object({ MediaContainer: z.object({
  generalDecisionCode: z.coerce.number().optional(),
  Metadata: z.array(z.object({ Media: z.array(z.object({ Part: z.array(z.object({ Stream: z.array(z.object({ id: z.union([z.string(), z.number()]).transform(String).optional(), streamType: z.coerce.number(), decision: z.string().optional() })).default([]) })).default([]) })).default([]) })).default([])
}) });
// Plex's universal transcoder namespace. Every proxied path stays below one session directory.
export const transcodeRoot = '/video/:/transcode/universal/';
export type TranscodeProfile = { videoCodecs: string[]; audioCodecs: string[]; maxWidth?: number; maxHeight?: number; maxBitrateKbps?: number };
export type PlexMetadata = z.infer<typeof metadataSchema>;
const plexId = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform(String);
const leafContainer = z.object({ MediaContainer: z.object({ librarySectionID: plexId.optional(), totalSize: z.coerce.number().int().nonnegative().optional(), Metadata: z.array(z.object({
  ratingKey: plexId, type: z.string(), title: z.string().max(500), librarySectionID: plexId.optional(), duration: z.number().nonnegative().optional(),
  year: z.number().int().optional(), originallyAvailableAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), index: z.number().int().nonnegative().optional(), parentIndex: z.number().int().nonnegative().optional(),
  grandparentTitle: z.string().max(500).optional(), grandparentRatingKey: plexId.optional(), parentRatingKey: plexId.optional(),
  Media: z.array(z.object({ duration: z.number().nonnegative().optional(), videoCodec: z.string().max(40).optional(), width: z.number().positive().optional(), height: z.number().positive().optional(), container: z.string().max(40).optional() })).default([]),
})).default([]) }) });
type Leaf = z.infer<typeof leafContainer>['MediaContainer']['Metadata'][number];
const tooLarge = 'That selection has more than 5,000 programs. Pick a smaller collection, category or show.';
const collectionContainer = z.object({ MediaContainer: z.object({ librarySectionID: plexId.optional(), Metadata: z.array(z.object({
  ratingKey: plexId, type: z.string(), title: z.string().max(500), subtype: z.string().max(20).optional(), librarySectionID: plexId.optional(), childCount: z.coerce.number().int().nonnegative().optional(),
})).max(1000).default([]) }) });
// What a channel selection was: one title, or a group (show, season, collection or category) that expands into many.
export type ChannelRoot = { id: string; type: 'movie' | 'show' | 'season' | 'episode' | 'collection' | 'genre'; title: string; season?: number };
export type ChannelMedia = { mediaId: string; kind: 'movie' | 'episode'; title: string; showTitle?: string; showId?: string; seasonId?: string; season?: number; episode?: number; year?: number; date?: string; durationMs: number;
  video?: { codec?: string; width?: number; height?: number; container?: string } };
// `name` is the Plex account's display name, for Admin › Activity.
export type PlexGrant = { accountId: string; name?: string; role: 'admin' | 'viewer'; serverToken: string; libraries: { key: string; title: string; type: string }[] };

// Cache keys name a viewer's server token by digest, never the token itself.
const tokenScope=(grant:PlexGrant)=>createHash('sha256').update(grant.serverToken).digest('hex');
export class PlexAdapter {
  // Artwork paths end in when the art last changed, so one path at one size is always the same picture,
  // whoever asked for it: viewers share these bytes once their own metadata read has authorized the path.
  private images=new ArtworkCache(256*1024*1024,5000,24*3600000);
  private imageRequests=new Map<string,Promise<{bytes:Buffer;type:string}>>();
  // Metadata reads behind artwork and collections, per viewer token, reused briefly so a grid of posters asks Plex once per
  // title. Library scope is still checked against the grant on every use.
  private nodes=new Map<string,{until:number;read:Promise<unknown>}>();
  constructor(private config: Config, private clientId: string, private transport: typeof fetch = fetch) {}
  private headers(token?: string) {
    return { Accept: 'application/json', 'X-Plex-Product': 'tk.box', 'X-Plex-Version': '0.0.1',
      'X-Plex-Client-Identifier': this.clientId, ...(token ? { 'X-Plex-Token': token } : {}) };
  }
  // `sameOrigin` follows redirects that stay on the requested origin (Discover adds the viewer's preferred
  // services to some shelves that way); any other redirect is refused, so the token never leaves that host.
  private async json(url: URL, token?: string, method = 'GET', sameOrigin = false) {
    try {
      let response = await this.transport(url, { method, headers: this.headers(token), redirect: sameOrigin ? 'manual' : 'error', signal: AbortSignal.timeout(10000) });
      for (let hops = 0; sameOrigin && response.status >= 300 && response.status < 400; hops++) {
        const next = new URL(response.headers.get('location') ?? '', url);
        await response.body?.cancel();
        if (hops >= 3 || next.origin !== url.origin) throw new AppError('PLEX_UNAVAILABLE', 'Plex redirected the request elsewhere.', 502);
        response = await this.transport(next, { method, headers: this.headers(token), redirect: 'manual', signal: AbortSignal.timeout(10000) });
      }
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
      // Discover's watchlist actions answer with an empty body.
      const text = Buffer.concat(chunks).toString('utf8');
      return (text ? JSON.parse(text) : {}) as unknown;
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
    const name = account.title || account.username;
    return { accountId: account.id, ...(name ? { name } : {}), role: isOwner ? 'admin' : 'viewer', serverToken, libraries };
  }
  // The owner's Plex friends and Plex Home members, by Plex account, for choosing other admins. Read with the owner's
  // own account token; either list failing leaves it out.
  async plexUsers(accountToken: string) {
    const user = z.object({ id: z.union([z.string(), z.number()]).transform(String), title: z.string().max(200).nullish(), username: z.string().max(200).nullish(),
      home: z.boolean().nullish() }).passthrough();
    const list = (data: unknown) => z.array(z.unknown()).max(5000).catch([]).parse(Array.isArray(data) ? data : (data as { users?: unknown } | null)?.users)
      .flatMap(entry => { const parsed = user.safeParse(entry); return parsed.success && /^\d{1,20}$/.test(parsed.data.id) ? [parsed.data] : []; });
    const [friends, home] = await Promise.all([this.json(new URL('https://plex.tv/api/v2/friends'), accountToken).then(list, () => []),
      this.json(new URL('https://plex.tv/api/v2/home/users'), accountToken).then(list, () => [])]);
    const users = new Map<string, { accountId: string; name: string; username?: string; home: boolean }>();
    for (const [entries, inHome] of [[friends, false], [home, true]] as const) for (const u of entries)
      users.set(u.id, { accountId: u.id, name: u.title || u.username || `Plex user ${u.id}`, ...(u.username ? { username: u.username } : {}), home: inHome || !!users.get(u.id)?.home || !!u.home });
    return [...users.values()];
  }
  // Plex's cloud catalog (watchlist, Discover shelves, search), read with the viewer's own Plex account token.
  async discover(accountToken: string, path: string, query: Record<string, string | number> = {}, method = 'GET') {
    const url = new URL(path, 'https://discover.provider.plex.tv');
    requireThat(url.origin === 'https://discover.provider.plex.tv', 'INVALID_REQUEST', 'Discover requests stay on Plex.');
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    return this.json(url, accountToken, method, true);
  }
  // This server's copy of a title the viewer can open: titles with that name whose guid (plex://, imdb://, tmdb://, tvdb://) matches.
  async libraryMatch(grant: PlexGrant, kind: 'movie' | 'show', title: string, guids: string[]) {
    if (!guids.length || !title.trim()) return undefined;
    const matches = z.object({ MediaContainer: z.object({ Metadata: z.array(z.object({ ratingKey: plexId, guid: z.string().optional(), Guid: z.array(z.object({ id: z.string() })).optional() })).default([]) }) });
    const found = await Promise.all(grant.libraries.filter(l => l.type === kind).map(async library => {
      const url = new URL(`/library/sections/${library.key}/all`, this.config.PLEX_URL);
      for (const [key, value] of Object.entries({ type: kind === 'movie' ? '1' : '2', title: title.trim().slice(0, 100), includeGuids: '1', 'X-Plex-Container-Start': '0', 'X-Plex-Container-Size': '50' })) url.searchParams.set(key, value);
      const items = await this.json(url, grant.serverToken).then(data => matches.parse(data).MediaContainer.Metadata, () => []);
      return items.find(item => (item.guid && guids.includes(item.guid)) || item.Guid?.some(g => guids.includes(g.id)))?.ratingKey;
    }));
    return found.find(Boolean);
  }
  async metadata(grant: PlexGrant, ratingKey: string, options: { markers?: boolean } = {}) {
    requireThat(/^\d+$/.test(ratingKey), 'INVALID_MEDIA', 'Invalid Plex media identifier.');
    const url = new URL(`/library/metadata/${ratingKey}`, this.config.PLEX_URL); if (options.markers) url.searchParams.set('includeMarkers', '1');
    const result = z.object({ MediaContainer: z.object({ Metadata: z.array(metadataSchema) }) }).parse(await this.json(url, grant.serverToken));
    const item = result.MediaContainer.Metadata[0];
    requireThat(item && item.ratingKey === ratingKey && grant.libraries.some(l => l.key === item.librarySectionID), 'PLEX_ACCESS_DENIED', 'Media is not accessible to this account.', 403);
    return item;
  }
  private library(grant:PlexGrant,id:string) {
    requireThat(/^\d+$/.test(id),'INVALID_LIBRARY','Invalid library identifier.');
    const library=grant.libraries.find(l=>l.key===id&&['movie','show'].includes(l.type));
    requireThat(library,'PLEX_ACCESS_DENIED','Library is not accessible to this account.',403);return library;
  }
  private remembered<T>(key:string,read:()=>Promise<T>,ttl=60000,now=Date.now()):Promise<T> {
    const hit=this.nodes.get(key);if(hit&&hit.until>now)return hit.read as Promise<T>;
    const pending=read();this.nodes.delete(key);this.nodes.set(key,{until:now+ttl,read:pending});
    pending.catch(()=>{if(this.nodes.get(key)?.read===pending)this.nodes.delete(key);});
    while(this.nodes.size>5000)this.nodes.delete(this.nodes.keys().next().value!);
    return pending;
  }
  // Drops remembered metadata (after artwork or cleanup jobs change the library).
  forgetMetadata() {this.nodes.clear();}
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
  async catalogItem(grant:PlexGrant,id:string) {
    const {node,section}=await this.catalogNode(grant,id),item=catalogDto(node,section);
    // Plex tags a title with its collections' names only, so they are matched to the library's Collections by name.
    // The list is kept five minutes per viewer; when it can't be read the title simply shows no collections.
    const names=new Set(node.Collection?.map(c=>c.tag));
    if(!names.size||(node.type!=='movie'&&node.type!=='show'))return item;
    try {
      const {collections}=await this.remembered(`collections:${tokenScope(grant)}:${section}`,()=>this.catalogCollections(grant,section),300000);
      const found=collections.filter(c=>names.has(c.title)).slice(0,3).map(({id,title,count,kind,posterUrl})=>({id,title,count,kind,posterUrl}));
      return found.length?{...item,collections:found}:item;
    } catch {return item;}
  }
  // Viewer-requested watch state changes, written with the viewer's own server token so
  // they land in that account's Plex history. Never reachable from a playback session.
  async catalogWatchState(grant:PlexGrant,id:string,action:CatalogAction) {
    requireWritable();
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
  // Like Plex's Categories: each genre's tile shows the backdrop of a random title from it, a different title per
  // genre where the library has one, so tiles don't repeat the same art. Plex does the shuffling, so it costs nothing extra.
  // Kept ten minutes per viewer, so the tiles stay put while browsing and Plex isn't asked once per genre each visit.
  async catalogGenreArt(grant:PlexGrant,libraryId:string) {
    this.library(grant,libraryId);
    return this.remembered(`genre-art:${tokenScope(grant)}:${libraryId}`,()=>this.readGenreArt(grant,libraryId),600000);
  }
  private async readGenreArt(grant:PlexGrant,libraryId:string) {
    const library=this.library(grant,libraryId),{genres}=await this.catalogGenres(grant,libraryId);
    const section=z.union([z.string(),z.number()]).transform(String).optional();
    const page=z.object({MediaContainer:z.object({librarySectionID:section,Metadata:z.array(z.object({ratingKey:z.string().regex(/^\d+$/).max(20),art:z.string().max(500).optional(),librarySectionID:section})).max(8).default([])})});
    const candidates=async(genre:string)=>{
      const url=new URL(`/library/sections/${libraryId}/all`,this.config.PLEX_URL);
      url.searchParams.set('type',library.type==='movie'?'1':'2');url.searchParams.set('genre',genre);url.searchParams.set('sort','random');
      url.searchParams.set('X-Plex-Container-Start','0');url.searchParams.set('X-Plex-Container-Size','8');url.searchParams.set('includeFields','ratingKey,art,librarySectionID');
      // A genre whose lookup fails just keeps its plain tile.
      try {const container=page.parse(await this.json(url,grant.serverToken)).MediaContainer;return container.Metadata.filter(n=>artworkPath(n.art)&&(n.librarySectionID??container.librarySectionID??libraryId)===libraryId).map(n=>({id:n.ratingKey,art:n.art}));}
      catch {return [];}
    };
    const found:{id:string;art?:string}[][]=[];
    for(let i=0;i<genres.length;i+=6)found.push(...await Promise.all(genres.slice(i,i+6).map(g=>candidates(g.id))));
    const used=new Set<string>(),art:Record<string,string>={};
    genres.forEach((g,i)=>{const ids=found[i]??[],pick=ids.find(n=>!used.has(n.id))??ids[0];if(pick){used.add(pick.id);art[g.id]=versioned(`/api/v1/catalog/items/${pick.id}/artwork?kind=tile`,pick.art);}});
    return {art};
  }
  async catalogIndex(grant:PlexGrant,libraryId:string,input:Partial<CatalogQuery>) {
    const library=this.library(grant,libraryId),query=catalogQuery.parse(input);
    requireThat(['all','unwatched'].includes(query.shelf),'INVALID_INDEX','Jump navigation requires a full library listing.');
    if(query.sort!=='title')return this.sortedIndex(grant,libraryId,library.type,query,query.sort);
    const url=new URL(`/library/sections/${libraryId}/firstCharacter`,this.config.PLEX_URL);
    applyCatalogFilters(url,query,library.type);if(query.shelf==='unwatched')url.searchParams.set('unwatched','1');
    const result=z.object({MediaContainer:z.object({Directory:z.array(z.object({title:z.string().max(16),size:z.coerce.number().int().nonnegative().max(1000000)})).max(512).default([])})}).parse(await this.json(url,grant.serverToken));
    let offset=0;const entries=result.MediaContainer.Directory.map(row=>{const value={label:row.title,count:row.size,offset};offset+=row.size;return value;});
    return {entries:entries.filter(e=>e.count>0),total:offset};
  }
  // Plex only buckets by first letter, so other sorts read the sorted field for every item
  // (metadata only, in pages) and bucket the values in that order.
  private async sortedIndex(grant:PlexGrant,libraryId:string,type:string,query:CatalogQuery,sort:Exclude<CatalogQuery['sort'],'title'>) {
    const field=({newest:'addedAt',year:'year',rating:'rating',duration:'duration'} as const)[sort];
    const page=z.object({MediaContainer:z.object({Metadata:z.array(z.object({[field]:z.number().optional()})).max(500).default([]),totalSize:z.coerce.number().int().nonnegative().max(50000).optional()})});
    const fetchPage=async(start:number)=>{
      const url=new URL(`/library/sections/${libraryId}/all`,this.config.PLEX_URL);applyCatalogFilters(url,query,type);
      url.searchParams.set('X-Plex-Container-Start',String(start));url.searchParams.set('X-Plex-Container-Size','500');
      url.searchParams.set('includeFields',field);url.searchParams.set('excludeElements','Media,Role,Director,Writer,Country,Guid,Collection,Producer,Genre,Image');
      return page.parse(await this.json(url,grant.serverToken)).MediaContainer;
    };
    const first=await fetchPage(0),total=first.totalSize??first.Metadata.length,starts:number[]=[];
    for(let start=500;start<total;start+=500)starts.push(start);
    const pages=[first];for(let i=0;i<starts.length;i+=4)pages.push(...await Promise.all(starts.slice(i,i+4).map(fetchPage)));
    const values=pages.flatMap(p=>p.Metadata.map(node=>(node as Record<string,number|undefined>)[field])).slice(0,total);
    return {entries:sortIndex(sort,values),total:values.length};
  }
  // `hidden` gives the TMDb IDs of movies kept off the Recent shelf.
  async catalogPage(grant:PlexGrant,libraryId:string,input:Partial<CatalogQuery>,hidden?:()=>Set<number>):Promise<CatalogPage> {
    const library=this.library(grant,libraryId),query=catalogQuery.parse(input);
    const path=query.shelf==='continue'?'onDeck':query.shelf==='recent'?'recentlyAdded':'all';
    const url=new URL(`/library/sections/${libraryId}/${path}`,this.config.PLEX_URL);
    if(path==='all')applyCatalogFilters(url,query,library.type);
    else {if(query.q)url.searchParams.set('title',query.q);if(query.genre)url.searchParams.set('genre',query.genre);}
    url.searchParams.set('excludeElements','Media,Role,Director,Writer,Country,Guid,Collection,Producer');
    const read=async(start:number,size:number)=>{
      url.searchParams.set('X-Plex-Container-Start',String(start));url.searchParams.set('X-Plex-Container-Size',String(size));
      const container=catalogContainer.parse(await this.json(url,grant.serverToken)).MediaContainer;
      requireThat(container.Metadata.length<=size,'PLEX_PAGINATION_INVALID','Plex did not honor the requested page limit.',502);
      requireThat(container.offset===undefined||container.offset===start,'PLEX_PAGINATION_INVALID','Plex returned an unexpected page.',502);
      const items=container.Metadata.map(node=>{requireThat((node.librarySectionID??container.librarySectionID??libraryId)===libraryId,'PLEX_ACCESS_DENIED','Plex returned media outside the requested library.',403);return catalogDto(node,libraryId);});
      return {items,more:container.totalSize!==undefined?start+items.length<container.totalSize:items.length===size,total:container.totalSize};
    };
    // The first page of recent TV reads episodes, 60 at a time, until its cards are settled: a show past the last card
    // turns up, or Plex runs out.
    if(path==='recentlyAdded'&&library.type==='show'&&query.offset===0) {
      const items:CatalogItem[]=[],settled=()=>groupRecentEpisodes(items,query.limit+1).length>query.limit;let more=true;
      for(let start=0;more&&start<600&&!settled();start+=60){const page=await read(start,60);items.push(...page.items);more=page.more;}
      const cards=groupRecentEpisodes(items,query.limit+1);
      return {items:await this.withShowSummaries(grant,cards.slice(0,query.limit)),offset:0,limit:query.limit,hasMore:cards.length>query.limit||more};
    }
    // Recent movies leave out the hidden ones (known by their TMDb guid), reading 60 at a time from the newest until the
    // page is full.
    const hide=path==='recentlyAdded'&&library.type==='movie'?hidden?.():undefined;
    if(hide?.size) {
      url.searchParams.set('includeGuids','1');url.searchParams.set('excludeElements','Media,Role,Director,Writer,Country,Collection,Producer');
      const items:CatalogItem[]=[],end=query.offset+query.limit;let more=true;
      for(let start=0;more&&start<1200&&items.length<=end;start+=60){const page=await read(start,60);items.push(...page.items.filter(i=>!i.tmdbId||!hide.has(i.tmdbId)));more=page.more;}
      return {items:items.slice(query.offset,end),offset:query.offset,limit:query.limit,hasMore:items.length>end||more};
    }
    const {items,more,total}=await read(query.offset,query.limit);
    return {items,offset:query.offset,limit:query.limit,total,hasMore:more};
  }
  // Season and show cards grouped from episodes carry no description, so they take the series' own. A show that
  // can't be read keeps its card without one.
  private async withShowSummaries(grant:PlexGrant,cards:CatalogItem[]) {
    const showOf=(c:CatalogItem)=>!c.summary&&(c.type==='show'?c.id:c.type==='season'?c.showId:undefined);
    const ids=[...new Set(cards.map(showOf).filter((id):id is string=>!!id))];
    const summaries=new Map(await Promise.all(ids.map(async id=>{
      try {return [id,catalogContainer.parse(await this.json(new URL(`/library/metadata/${id}`,this.config.PLEX_URL),grant.serverToken)).MediaContainer.Metadata[0]?.summary??''] as const;}
      catch {return [id,''] as const;}
    })));
    return cards.map(c=>{const id=showOf(c),summary=id?summaries.get(id):undefined;return summary?{...c,summary}:c;});
  }
  // A library's titles added after `sinceMs`, newest first, read page by page until Plex's list gets back to then (at
  // most `max` entries; `complete` says it got there). TV episodes group into one card per show, as on the Recent shelf.
  async addedSince(grant:PlexGrant,libraryId:string,sinceMs:number,max=2000) {
    const library=this.library(grant,libraryId),size=100,items:CatalogItem[]=[];
    let complete=false;
    for(let offset=0;offset<max&&!complete;offset+=size) {
      const url=new URL(`/library/sections/${libraryId}/recentlyAdded`,this.config.PLEX_URL);
      url.searchParams.set('X-Plex-Container-Start',String(offset));url.searchParams.set('X-Plex-Container-Size',String(size));
      url.searchParams.set('excludeElements','Media,Role,Director,Writer,Country,Guid,Collection,Producer');
      const nodes=catalogContainer.parse(await this.json(url,grant.serverToken)).MediaContainer.Metadata;
      requireThat(nodes.length<=size,'PLEX_PAGINATION_INVALID','Plex did not honor the requested page limit.',502);
      complete=nodes.length<size;
      for(const node of nodes) {
        if((node.addedAt??0)*1000<=sinceMs){complete=true;break;}
        requireThat((node.librarySectionID??libraryId)===libraryId,'PLEX_ACCESS_DENIED','Plex returned media outside the requested library.',403);
        items.push(catalogDto(node,libraryId));
      }
    }
    return {items:library.type==='show'?groupRecentEpisodes(items):items,complete};
  }
  // Plex Media Server's notification feed, which pushes library changes as they happen. The token goes in a header,
  // which Node's WebSocket takes though the DOM typings don't.
  notificationSocket(grant:PlexGrant) {
    const url=new URL('/:/websockets/notifications',this.config.PLEX_URL);url.protocol=url.protocol==='https:'?'wss:':'ws:';
    return new WebSocket(url,{headers:this.headers(grant.serverToken)} as unknown as string[]);
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
  // The library's Collections view, A–Z like Plex.
  async catalogCollections(grant:PlexGrant,libraryId:string):Promise<{collections:CatalogCollection[]}> {
    this.library(grant,libraryId);
    const url=new URL(`/library/sections/${libraryId}/collections`,this.config.PLEX_URL);
    url.searchParams.set('sort','titleSort:asc');url.searchParams.set('X-Plex-Container-Start','0');url.searchParams.set('X-Plex-Container-Size','2000');
    const container=collectionsContainer.parse(await this.json(url,grant.serverToken)).MediaContainer;
    return {collections:container.Metadata.filter(c=>c.type==='collection'&&(c.librarySectionID??container.librarySectionID??libraryId)===libraryId).map(collectionDto)};
  }
  // Collections Plex promotes to this viewer's Home, in Plex's order. Read with the viewer's own token, so Plex
  // applies its own-home vs shared-home visibility; only hubs from the viewer's libraries are kept.
  async homeCollections(grant:PlexGrant) {
    const keys=grant.libraries.filter(l=>['movie','show'].includes(l.type)).map(l=>l.key);
    if(!keys.length)return {collections:[]};
    const url=new URL('/hubs/promoted',this.config.PLEX_URL);
    url.searchParams.set('contentDirectoryID',keys.join(','));url.searchParams.set('pinnedContentDirectoryID',keys.join(','));url.searchParams.set('count','1');
    // Each collection is read back like any other, which checks its library is the viewer's; one that fails is left off.
    const ids=promotedCollectionIds(promotedHubs.parse(await this.json(url,grant.serverToken))).slice(0,20);
    const found=await Promise.all(ids.map(id=>this.rememberedCollection(grant,id).then(({node,section})=>({id,title:node.title,libraryId:section}),()=>undefined)));
    return {collections:found.filter(c=>c!==undefined)};
  }
  private async rememberedCollection(grant:PlexGrant,id:string) {
    const {node,section}=await this.remembered(`collection:${tokenScope(grant)}:${id}`,()=>this.collectionNode(grant,id));
    this.library(grant,section);return {node,section};
  }
  private async collectionNode(grant:PlexGrant,id:string) {
    requireThat(/^\d+$/.test(id),'INVALID_MEDIA','Invalid Plex collection identifier.');
    const container=collectionsContainer.parse(await this.json(new URL(`/library/metadata/${id}`,this.config.PLEX_URL),grant.serverToken)).MediaContainer;
    const node=container.Metadata[0];requireThat(container.Metadata.length===1&&node?.ratingKey===id&&node.type==='collection','MEDIA_NOT_FOUND','That collection is unavailable.',404);
    const section=node.librarySectionID??container.librarySectionID;requireThat(section,'PLEX_ACCESS_DENIED','Collection library could not be verified.',403);
    this.library(grant,section);return {node,section};
  }
  async catalogCollection(grant:PlexGrant,id:string) {const {node,section}=await this.collectionNode(grant,id);return {...collectionDto(node),libraryId:section};}
  async catalogCollectionItems(grant:PlexGrant,id:string,input:Partial<CatalogQuery>):Promise<CatalogPage> {
    const {section}=await this.collectionNode(grant,id),query=catalogQuery.parse(input);
    const url=new URL(`/library/collections/${id}/children`,this.config.PLEX_URL);
    url.searchParams.set('X-Plex-Container-Start',String(query.offset));url.searchParams.set('X-Plex-Container-Size',String(query.limit));
    url.searchParams.set('excludeElements','Media,Role,Director,Writer,Country,Guid,Collection,Producer');
    const container=catalogContainer.parse(await this.json(url,grant.serverToken)).MediaContainer;
    requireThat(container.Metadata.length<=query.limit&&(container.offset===undefined||container.offset===query.offset),'PLEX_PAGINATION_INVALID','Plex returned an unexpected collection page.',502);
    const items=container.Metadata.map(child=>{requireThat((child.librarySectionID??container.librarySectionID??section)===section,'PLEX_ACCESS_DENIED','Plex returned media outside the collection’s library.',403);return catalogDto(child,section);});
    return {items,offset:query.offset,limit:query.limit,total:container.totalSize,hasMore:container.totalSize!==undefined?query.offset+items.length<container.totalSize:items.length===query.limit};
  }
  async collectionArtwork(grant:PlexGrant,id:string,version?:string,scale:1|2=1) {
    let {node}=await this.rememberedCollection(grant,id);
    if(version&&!collectionArtwork(node)?.endsWith(`/${version}`)){this.nodes.delete(`collection:${tokenScope(grant)}:${id}`);({node}=await this.rememberedCollection(grant,id));}
    const path=collectionArtwork(node);
    requireThat(path,'ARTWORK_NOT_FOUND','Artwork is unavailable.',404);
    return this.cachedArtwork(grant,path,'poster',scale);
  }
  // A movie, episode, season, whole show, collection or category as the playable items a custom channel would air,
  // with the media details needed to judge channel playback. Read with the administrator's grant. Shows and seasons
  // come in season then episode order. A collection keeps its Plex order and a category (genre) is A–Z; each show in
  // either expands in place, in episode order. Collections are `collection:<id>`, categories `genre:<library>:<genre>`.
  async channelMedia(grant:PlexGrant,id:string):Promise<{root:ChannelRoot;items:ChannelMedia[]}> {
    const items:ChannelMedia[]=[];
    const collection=/^collection:(\d{1,20})$/.exec(id),genre=/^genre:(\d{1,20}):(\d{1,20})$/.exec(id);
    if(collection||genre) {
      let section:string,title:string,path:string;const params:Record<string,string>={};
      if(collection) {
        const key=collection[1]!,container=collectionContainer.parse(await this.json(new URL(`/library/metadata/${key}`,this.config.PLEX_URL),grant.serverToken)).MediaContainer;
        const record=container.Metadata[0];requireThat(container.Metadata.length===1&&record?.ratingKey===key&&record.type==='collection','MEDIA_NOT_FOUND','That collection is unavailable.',404);
        section=record.librarySectionID??container.librarySectionID??'';requireThat(section,'PLEX_ACCESS_DENIED','Collection library could not be verified.',403);
        this.library(grant,section);title=record.title;path=`/library/collections/${key}/children`;
      } else {
        section=genre![1]!;const library=this.library(grant,section),match=(await this.catalogGenres(grant,section)).genres.find(g=>g.id===genre![2]);
        requireThat(match,'MEDIA_NOT_FOUND','That category is unavailable.',404);
        title=`${match.title} ${library.type==='movie'?'movies':'shows'}`;path=`/library/sections/${section}/all`;
        Object.assign(params,{type:library.type==='movie'?'1':'2',genre:match.id,sort:'titleSort:asc'});
      }
      for(const leaf of await this.leaves(grant,path,section,params)) {
        if(leaf.type==='show')for(const episode of await this.leaves(grant,`/library/metadata/${leaf.ratingKey}/allLeaves`,section))this.pushMedia(items,episode);
        else this.pushMedia(items,leaf);
      }
      return {root:{id,type:collection?'collection':'genre',title},items};
    }
    const {node,section}=await this.catalogNode(grant,id);
    const path=node.type==='show'?`/library/metadata/${id}/allLeaves`:node.type==='season'?`/library/metadata/${id}/children`:`/library/metadata/${id}`;
    for(const leaf of await this.leaves(grant,path,section,{},node.type==='movie'||node.type==='episode'))this.pushMedia(items,leaf);
    return {root:{id,type:node.type,title:node.type==='season'&&node.parentTitle?`${node.parentTitle} · ${node.title}`:node.title,season:node.type==='season'?node.index:undefined},items};
  }
  // Every page of a Plex listing, checked to stay inside the library. Capped so one selection can't flood a channel.
  private async leaves(grant:PlexGrant,path:string,section:string,params:Record<string,string>={},single=false) {
    const out:Leaf[]=[];
    for(let offset=0;;offset+=200) {
      const url=new URL(path,this.config.PLEX_URL);
      for(const [k,v] of Object.entries(params))url.searchParams.set(k,v);
      url.searchParams.set('X-Plex-Container-Start',String(offset));url.searchParams.set('X-Plex-Container-Size','200');
      url.searchParams.set('excludeElements','Role,Director,Writer,Country,Guid,Collection,Producer,Genre,Similar,Field');
      const container=leafContainer.parse(await this.json(url,grant.serverToken)).MediaContainer;
      for(const leaf of container.Metadata) {
        requireThat((leaf.librarySectionID??container.librarySectionID??section)===section,'PLEX_ACCESS_DENIED','Plex returned media outside the library.',403);
        out.push(leaf);
      }
      requireThat(out.length<=5000,'SELECTION_TOO_LARGE',tooLarge,413);
      if(single||container.Metadata.length<200||(container.totalSize!==undefined&&offset+200>=container.totalSize))break;
    }
    return out;
  }
  private pushMedia(items:ChannelMedia[],leaf:Leaf) {
    if(leaf.type!=='movie'&&leaf.type!=='episode')return;
    requireThat(items.length<5000,'SELECTION_TOO_LARGE',tooLarge,413);
    const media=leaf.Media[0];
    items.push({mediaId:leaf.ratingKey,kind:leaf.type,title:leaf.title,showTitle:leaf.grandparentTitle,showId:leaf.grandparentRatingKey,seasonId:leaf.parentRatingKey,
      season:leaf.type==='episode'?leaf.parentIndex:undefined,episode:leaf.type==='episode'?leaf.index:undefined,year:leaf.year,date:leaf.originallyAvailableAt,
      durationMs:Math.round(media?.duration??leaf.duration??0),video:media&&{codec:media.videoCodec,width:media.width,height:media.height,container:media.container}});
  }
  // The Plex collections of a movie or TV library, for the channel picker.
  async channelCollections(grant:PlexGrant,libraryId:string) {
    this.library(grant,libraryId);
    const url=new URL(`/library/sections/${libraryId}/collections`,this.config.PLEX_URL);
    url.searchParams.set('X-Plex-Container-Start','0');url.searchParams.set('X-Plex-Container-Size','1000');
    const container=collectionContainer.parse(await this.json(url,grant.serverToken)).MediaContainer;
    return {collections:container.Metadata.filter(c=>c.type==='collection'&&(c.librarySectionID??container.librarySectionID??libraryId)===libraryId)
      .map(c=>({id:`collection:${c.ratingKey}`,title:c.title,count:c.childCount,kind:c.subtype==='show'?'show' as const:'movie' as const}))};
  }
  // `version` is the `v` the page asked for: remembered metadata naming other art is read again, so a new address
  // (which browsers keep for good) never gets the old picture.
  async artwork(grant:PlexGrant,id:string,kind:ArtworkKind,version?:string,scale:1|2=1) {
    const pick=(node:CatalogNode)=>kind==='logo'?logoPath(node):artworkPath(kind==='backdrop'||kind==='tile'?node.art:node.thumb??node.parentThumb??node.grandparentThumb);
    const key=`item:${tokenScope(grant)}:${id}`,read=()=>this.remembered(key,()=>this.catalogNode(grant,id));
    let {node,section}=await read();
    if(version&&!pick(node)?.endsWith(`/${version}`)){this.nodes.delete(key);({node,section}=await read());}
    this.library(grant,section);
    const path=pick(node);requireThat(path,'ARTWORK_NOT_FOUND','Artwork is unavailable.',404);
    return this.cachedArtwork(grant,path,kind,scale);
  }
  // `scale` 2 is a double-size poster for high-density screens (other kinds are already large).
  private cachedArtwork(grant:PlexGrant,path:string,kind:ArtworkKind,scale:1|2=1) {
    if(kind!=='poster')scale=1;
    const cacheKey=JSON.stringify([path,kind,scale]);
    const cached=this.images.get(cacheKey);if(cached)return cached;
    let pending=this.imageRequests.get(cacheKey);
    if(!pending){pending=this.loadArtwork(path,kind,grant.serverToken,scale).then(image=>{this.images.set(cacheKey,image);return image;}).finally(()=>this.imageRequests.delete(cacheKey));this.imageRequests.set(cacheKey,pending);}
    return pending;
  }
  private async loadArtwork(path:string,kind:ArtworkKind,serverToken:string,scale:1|2) {
    const url=new URL('/photo/:/transcode',this.config.PLEX_URL),[width,height]=kind==='poster'?[360*scale,540*scale]:kind==='logo'?[800,400]:kind==='tile'?[800,450]:[1280,720];
    url.searchParams.set('url',path);url.searchParams.set('width',String(width));url.searchParams.set('height',String(height));url.searchParams.set('minSize','1');url.searchParams.set('upscale','0');
    // Logos are transparent; PNG keeps the transparency a JPEG transcode would fill in.
    if(kind==='logo')url.searchParams.set('format','png');
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
      ...(profile.maxHeight ? [`add-limitation(scope=videoCodec&scopeName=*&type=upperBound&name=video.height&value=${profile.maxHeight})`] : []),
      ...(profile.maxBitrateKbps ? [`add-limitation(scope=videoCodec&scopeName=*&type=upperBound&name=video.bitrate&value=${profile.maxBitrateKbps})`] : [])];
    return new URLSearchParams({ path: `/library/metadata/${ratingKey}`, mediaIndex: '0', partIndex: '0', protocol: 'hls', fastSeek: '1', directPlay: '0', directStream: '1', directStreamAudio: '1',
      copyts: '1', hasMDE: '1', location: 'lan', mediaBufferSize: '102400', subtitles: 'none', offset: '0', session, 'X-Plex-Session-Identifier': session,
      'X-Plex-Platform': 'Generic', 'X-Plex-Client-Platform': 'Generic', 'X-Plex-Client-Profile-Name': 'Generic', 'X-Plex-Client-Profile-Extra': extra.join('+'),
      // Plex follows the part's persisted selection (see selectAudioStream); the explicit ID keeps the request self-describing.
      ...(audioStreamId ? { audioStreamID: audioStreamId } : {}),
      // Plex's own bitrate ceiling (kbps), alongside the profile limitation above.
      ...(profile.maxBitrateKbps ? { maxVideoBitrate: String(profile.maxBitrateKbps) } : {}) });
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
    if (readOnly()) return;
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
  // Everything playing on the Plex server, from any Plex app (owner token only), for Admin › Activity. tk.box's own
  // streams appear too (its transcodes and timeline reports), so they are left out here; tk.box tracks them itself.
  async sessions(grant: PlexGrant) {
    const data = sessionsSchema.parse(await this.json(new URL('/status/sessions', this.config.PLEX_URL), grant.serverToken));
    return data.MediaContainer.Metadata.filter(m => m.Player?.machineIdentifier !== this.clientId);
  }
  async terminateSession(grant: PlexGrant, sessionId: string, reason: string) {
    requireWritable();
    const url = new URL('/status/sessions/terminate', this.config.PLEX_URL);
    url.searchParams.set('sessionId', sessionId); url.searchParams.set('reason', reason);
    const r = await this.transport(url, { headers: this.headers(grant.serverToken), redirect: 'error', signal: AbortSignal.timeout(10000) }).catch(() => undefined);
    await r?.body?.cancel();
    // Plex only lets Plex Pass servers end a stream.
    requireThat(r?.ok, r?.status === 401 || r?.status === 403 ? 'PLEX_TERMINATE_REFUSED' : 'PLEX_UNAVAILABLE', r?.status === 401 || r?.status === 403 ? 'Plex refused to stop that stream. Stopping other apps’ streams needs Plex Pass.' : 'Plex could not stop that stream.', 502);
  }
  async transcodeControl(grant: PlexGrant, action: 'ping' | 'stop', session: string) {
    const url = new URL(`${transcodeRoot}${action}`, this.config.PLEX_URL); url.searchParams.set('session', session);
    const r = await this.transport(url, { headers: this.headers(grant.serverToken), redirect: 'error', signal: AbortSignal.timeout(10000) });
    await r.body?.cancel(); requireThat(r.ok, 'PLEX_STREAM_FAILED', 'Plex transcoder is unavailable.', 502);
  }
  async reportVod(grant: PlexGrant, ratingKey: string, timeMs: number, state: 'playing' | 'paused' | 'stopped', durationMs: number) {
    if (readOnly()) return;  // Watch progress is a write too
    const url = new URL('/:/timeline', this.config.PLEX_URL);
    for (const [k, v] of Object.entries({ ratingKey, key: `/library/metadata/${ratingKey}`, time: Math.round(timeMs), state, duration: Math.round(durationMs) })) url.searchParams.set(k, String(v));
    // Only the VOD service can call this, after loading immutable session mode and ownership.
    try {
      const r = await this.transport(url, { headers: this.headers(grant.serverToken), redirect: 'error', signal: AbortSignal.timeout(10000) });
      await r.body?.cancel(); if (!r.ok) throw new Error();
    } catch { throw new AppError('PLEX_PROGRESS_FAILED', 'Plex progress could not be synchronized.', 502); }
  }
}

