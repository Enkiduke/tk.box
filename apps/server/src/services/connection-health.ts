import {AppError} from '../errors.js';
import type {ArtworkKeys} from '../persistence/artwork-store.js';
import {remoteJson} from '../providers/remote-json.js';

// The library's side: SABnzbd and qBittorrent are checked with their own Test. The indexers report their own state
// (last error, paused).
type DownloaderName = 'sabnzbd'|'qbittorrent';
export type LibraryHealth = {downloaders:{view():{name:DownloaderName;url:string;secretSet:boolean}[];test(name:DownloaderName):Promise<unknown>}};
type Result = {state:'working'|'limited'|'failed';checkedAt:number;detail?:string};

// `tvmaze`: check TVmaze too (it needs no key, so there is nothing saved to tell).
export function connectionHealth(artworkKeys:()=>ArtworkKeys,
  transports:{tmdb?:typeof fetch;other?:typeof fetch} = {}, library?:LibraryHealth, options:{tvmaze?:boolean} = {}) {
  // Share checks if two admins open the page at the same time. A settings change gets a fresh check.
  let pending: {config:string;result:Promise<Record<string,Result>>} | undefined;
  return () => {
    const {tmdb,tvdb,fanart,mdblist} = artworkKeys();
    const downloaders = library ? library.downloaders.view().filter(d=>d.url) : [];
    const config = JSON.stringify([tmdb,tvdb,fanart,mdblist,downloaders]);
    if (pending?.config === config) return pending.result;

    const checks: Record<string,Promise<Result>> = {};
    const run = (id:string, check:()=>Promise<void>, limited?:string) => {
      checks[id] = Promise.resolve().then(check).then(() => ({state:limited?'limited':'working',checkedAt:Date.now(),detail:limited}), error => ({
        state:'failed',checkedAt:Date.now(),
        detail:error instanceof AppError ? error.message : 'The check could not be completed.',
      }));
    };
    const json = async (url:URL, service:string, valid:(body:unknown)=>boolean,
      init:Parameters<typeof remoteJson>[1]={}, transport=transports.other) => {
      const {status,data} = await remoteJson(url,init,service,transport,7000);
      if (status===401||status===403) throw new AppError('KEY_REJECTED','Access was refused. Check the saved API key.');
      if (status===429) throw new AppError('RATE_LIMITED','The service is rate-limiting requests. Check again later.');
      if (status>=400) throw new AppError('REMOTE_ERROR',`The service returned HTTP ${status}.`);
      if (!valid(data)) throw new AppError('INVALID_RESPONSE','The service returned an unexpected response.');
    };
    const object = (data:unknown) => data !== null && typeof data === 'object' ? data as Record<string,unknown> : undefined;

    for (const d of downloaders) run(d.name,async()=>{await library!.downloaders.test(d.name);});
    if (tmdb) run('tmdb',()=>json(new URL(`https://api.themoviedb.org/3/movie/603?api_key=${encodeURIComponent(tmdb)}`),
      'TMDb',data=>object(data)?.id===603,{},transports.tmdb));
    if (tvdb) run('tvdb',()=>json(new URL('https://api4.thetvdb.com/v4/login'),'TVDB',
      data=>typeof object(object(data)?.data)?.token==='string',{method:'POST',body:{apikey:tvdb}}));
    if (fanart) run('fanart',()=>json(new URL('https://webservice.fanart.tv/v3/movies/603'),'Fanart.tv',
      data=>object(data)?.tmdb_id==='603'||object(data)?.tmdb_id===603,{headers:{'api-key':fanart}}));
    if (options.tvmaze) run('tvmaze',()=>json(new URL('https://api.tvmaze.com/shows/1'),'TVmaze',data=>object(data)?.id===1));
    if (mdblist) run('mdblist',()=>json(new URL(`https://api.mdblist.com/lists/top?apikey=${encodeURIComponent(mdblist)}`),'MDBList',Array.isArray));

    const result = Promise.all(Object.entries(checks).map(async ([id,check])=>[id,await check] as const))
      .then(entries=>Object.fromEntries(entries)).finally(()=>{if(pending?.result===result)pending=undefined;});
    pending = {config,result};
    return result;
  };
}
