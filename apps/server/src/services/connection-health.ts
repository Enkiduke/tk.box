import {AppError} from '../errors.js';
import type {ArtworkKeys} from '../persistence/artwork-store.js';
import type {ArrService} from '../providers/arr-tags.js';
import {remoteJson} from '../providers/remote-json.js';
import {Seerr,type SeerrConnection} from '../providers/seerr.js';

type Services = {seerr?:SeerrConnection;radarr:ArrService;sonarr:ArrService;tautulli:ArrService};
type Result = {state:'working'|'limited'|'failed';checkedAt:number;detail?:string};

export function connectionHealth(services:()=>Services, artworkKeys:()=>ArtworkKeys,
  transports:{tmdb?:typeof fetch;seerr?:typeof fetch;other?:typeof fetch} = {}) {
  const seerr = new Seerr(()=>undefined,transports.seerr);
  // Share checks if two admins open the page at the same time. A settings change gets a fresh check.
  let pending: {config:string;result:Promise<Record<string,Result>>} | undefined;
  return () => {
    const {seerr:request,radarr,sonarr,tautulli} = services(), {tmdb,tvdb,fanart,mdblist} = artworkKeys();
    const config = JSON.stringify([request,radarr,sonarr,tautulli,tmdb,tvdb,fanart,mdblist]);
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

    if (request) run('seerr',async () => {
      if (request.apiKey) await seerr.checkKey(request.url,request.apiKey);
      else await seerr.publicSettings(request.url,true);
    },request.apiKey?undefined:'Seerr is reachable. Add an API key for availability badges and Clean Up.');
    for (const [id,name,service] of [['radarr','Radarr',radarr],['sonarr','Sonarr',sonarr]] as const) {
      if (service.url&&service.key) run(id,()=>json(new URL(`${service.url}/api/v3/system/status`),name,
        data=>typeof object(data)?.version==='string',{headers:{'X-Api-Key':service.key!}}));
    }
    if (tautulli.url&&tautulli.key) run('tautulli',async () => {
      const url = new URL(`${tautulli.url}/api/v2`);
      url.search = new URLSearchParams({cmd:'get_tautulli_info',apikey:tautulli.key!}).toString();
      await json(url,'Tautulli',data=>{
        const response = object(object(data)?.response);
        if (response?.result==='error') throw new AppError('REMOTE_ERROR','Tautulli refused the request. Check the saved API key.');
        return response?.result==='success'&&typeof object(response.data)?.tautulli_version==='string';
      });
    });
    if (tmdb) run('tmdb',()=>json(new URL(`https://api.themoviedb.org/3/movie/603?api_key=${encodeURIComponent(tmdb)}`),
      'TMDb',data=>object(data)?.id===603,{},transports.tmdb));
    if (tvdb) run('tvdb',()=>json(new URL('https://api4.thetvdb.com/v4/login'),'TVDB',
      data=>typeof object(object(data)?.data)?.token==='string',{method:'POST',body:{apikey:tvdb}}));
    if (fanart) run('fanart',()=>json(new URL('https://webservice.fanart.tv/v3/movies/603'),'Fanart.tv',
      data=>object(data)?.tmdb_id==='603'||object(data)?.tmdb_id===603,{headers:{'api-key':fanart}}));
    if (mdblist) run('mdblist',()=>json(new URL(`https://api.mdblist.com/lists/top?apikey=${encodeURIComponent(mdblist)}`),'MDBList',Array.isArray));

    const result = Promise.all(Object.entries(checks).map(async ([id,check])=>[id,await check] as const))
      .then(entries=>Object.fromEntries(entries)).finally(()=>{if(pending?.result===result)pending=undefined;});
    pending = {config,result};
    return result;
  };
}
