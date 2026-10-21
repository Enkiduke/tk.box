import {useEffect,useState} from 'react';
import {api} from './api.js';
import {useApi,invalidate} from './hooks.js';
import {ErrorNotice,Loading} from './components.js';
import {Card,SectionHead,useMutation} from './settings-ui.js';
import {ServerExploreSettings} from './explore-settings.js';

// Admin › Connections: every key and outside service tk.box connects to, in one place; none are set in the environment.
// Only what connects (keys, addresses, Radarr's root folder) belongs here; options that change what a feature does stay with it.
// Most cards save through the endpoint of the feature that uses it (Explore, Artwork, Collections, Clean Up); keys no feature's
// settings hold (the Plex admin token, TheSportsDB) are saved through /admin/keys.
export function ConnectionsSettings() {
  return <><SectionHead title="Connections" description="Stored encrypted and never shown again."/>
    <PlexToken/>
    <ServerExploreSettings/>
    <ArtworkKeys/>
    <RadarrConnection/>
    <CleanupConnections/>
    <SportsKey/>
  </>;
}

type KeyName='tmdb'|'tvdb'|'fanart'|'mdblist';
type ArtworkView={settings:{revision:number;keysSet:Record<KeyName,boolean>}&Record<string,unknown>};
const emptyKeys={tmdb:'',tvdb:'',fanart:'',mdblist:''};
function ArtworkKeys() {
  const view=useApi<ArtworkView>('/admin/artwork'),[keys,setKeys]=useState<Record<KeyName,string|null>>(emptyKeys),[done,setDone]=useState(false),mutation=useMutation(view.reload);
  useEffect(()=>setKeys(emptyKeys),[view.data?.settings.revision]);
  if(view.loading&&!view.data)return <Card title="Artwork providers"><Loading/></Card>;
  if(view.error&&!view.data)return <Card title="Artwork providers"><ErrorNotice message={view.error.message} retry={view.reload}/></Card>;
  if(!view.data)return null;
  const {revision,keysSet,...settings}=view.data.settings;
  const setKey=(name:KeyName,value:string|null)=>{setDone(false);setKeys(k=>({...k,[name]:value}));};
  const keyField=(name:KeyName,label:string,hint:string)=>{const removing=keys[name]===null;return <label>{label}
    <span className="setting-line"><input className="grow" type="password" autoComplete="off" maxLength={200} disabled={removing} value={keys[name]??''} placeholder={removing?'Removed when you save':keysSet[name]?'Saved — enter a new one to replace it':''} onChange={e=>setKey(name,e.target.value)}/>
      {keysSet[name]&&<button type="button" onClick={()=>setKey(name,removing?'':null)}>{removing?'Keep':'Remove'}</button>}</span><small>{hint}</small></label>;};
  const given=Object.fromEntries(Object.entries(keys).filter(([,v])=>v===null||v.trim()).map(([k,v])=>[`${k}Key`,v===null?'':v.trim()]));
  // The artwork settings are saved as a whole, so the rest go back unchanged.
  const save=()=>void mutation.run(async()=>{await api('/admin/artwork/settings','PUT',{expectedRevision:revision,...settings,...given});invalidate('/admin/artwork');setDone(true);});
  return <Card title="Artwork providers" description="For Artwork and Collections.">
    <form className="form-stack" onSubmit={e=>{e.preventDefault();save();}}>
      <div className="form-columns">
        {keyField('tmdb','TMDb API key','themoviedb.org › Settings › API')}
        {keyField('fanart','Fanart.tv API key','fanart.tv › Profile')}
        {keyField('tvdb','TVDB API key','thetvdb.com › Dashboard › API keys')}
        {keyField('mdblist','MDBList API key','Optional · mdblist.com › Preferences')}
      </div>
      {mutation.error&&<ErrorNotice message={mutation.error}/>}
      <div className="button-row"><button className="primary" disabled={mutation.busy||!Object.keys(given).length}>Save provider keys</button>{done&&<span className="success" role="status">Saved.</span>}</div>
    </form>
  </Card>;
}

type Radarr={url:string;rootFolder:string;qualityProfileId:number;search:boolean};
type CollectionsView={revision:number;definitions:unknown[]|null;franchise:Record<string,unknown>;radarr:Radarr;schedules:Record<string,unknown>;radarrKeySet:boolean};
function RadarrConnection() {
  const view=useApi<CollectionsView>('/admin/artwork/collections'),[draft,setDraft]=useState<Radarr>(),[key,setKey]=useState(''),[done,setDone]=useState(false),mutation=useMutation(view.reload);
  useEffect(()=>{if(view.data){setDraft(view.data.radarr);setKey('');}},[view.data?.revision]);
  const title='Radarr',description='Optional · seasonal downloads and Clean Up.';
  if(view.loading&&!view.data)return <Card title={title}><Loading/></Card>;
  if(view.error&&!view.data)return <Card title={title}><ErrorNotice message={view.error.message} retry={view.reload}/></Card>;
  if(!view.data||!draft)return null;
  const data=view.data,set=(patch:Partial<Radarr>)=>{setDone(false);setDraft({...draft,...patch});};
  // Collections are saved as a whole, so their definitions, franchise options, schedules and Radarr download options go back unchanged.
  const save=()=>void mutation.run(async()=>{await api('/admin/artwork/collections','PUT',{expectedRevision:data.revision,value:{definitions:data.definitions,franchise:data.franchise,radarr:draft,schedules:data.schedules},...(key.trim()?{radarrKey:key.trim()}:{})});invalidate('/admin/artwork/collections');setDone(true);});
  return <Card title={title} description={description}>
    <form className="form-stack" onSubmit={e=>{e.preventDefault();save();}}>
      <div className="form-columns">
        <label>Radarr address<input type="url" placeholder="http://radarr:7878" value={draft.url} onChange={e=>set({url:e.target.value})}/></label>
        <label>API key<input type="password" autoComplete="off" value={key} placeholder={data.radarrKeySet?'Saved — enter a new one to replace it':''} onChange={e=>{setKey(e.target.value);setDone(false);}}/><small>Radarr › Settings › General</small></label>
        <label>Root folder<input placeholder="/movies" value={draft.rootFolder} onChange={e=>set({rootFolder:e.target.value})}/></label>
      </div>
      {mutation.error&&<ErrorNotice message={mutation.error}/>}
      <div className="button-row"><button className="primary" disabled={mutation.busy}>Save Radarr</button>{done&&<span className="success" role="status">Saved.</span>}</div>
    </form>
  </Card>;
}

// Tautulli and Sonarr, which only Clean Up uses. Each card saves its own service; the other's goes back unchanged.
type CleanupConnectionsView={revision:number;tautulliUrl:string;sonarrUrl:string;tautulliKeySet:boolean;sonarrKeySet:boolean};
function CleanupConnections() {
  const view=useApi<CleanupConnectionsView>('/admin/cleanup/connections');
  if(view.loading&&!view.data)return <Card title="Tautulli"><Loading/></Card>;
  if(view.error&&!view.data)return <Card title="Tautulli"><ErrorNotice message={view.error.message} retry={view.reload}/></Card>;
  if(!view.data)return null;
  return <>
    <ServiceConnection service="tautulli" title="Tautulli" description="Watch history for Clean Up." placeholder="http://tautulli:8181" hint="Tautulli › Settings › Web Interface" data={view.data} changed={view.reload}/>
    <ServiceConnection service="sonarr" title="Sonarr" description="Optional · lets Clean Up delete from Sonarr." placeholder="http://sonarr:8989" hint="Sonarr › Settings › General" data={view.data} changed={view.reload}/>
  </>;
}
function ServiceConnection({service,title,description,placeholder,hint,data,changed}:{service:'tautulli'|'sonarr';title:string;description:string;placeholder:string;hint:string;data:CleanupConnectionsView;changed:()=>void}) {
  const [url,setUrl]=useState(data[`${service}Url`]),[key,setKey]=useState(''),[done,setDone]=useState(false),mutation=useMutation(changed);
  useEffect(()=>{setUrl(data[`${service}Url`]);setKey('');},[data.revision]);
  const save=()=>void mutation.run(async()=>{await api('/admin/cleanup/connections','PUT',{expectedRevision:data.revision,tautulliUrl:data.tautulliUrl,sonarrUrl:data.sonarrUrl,[`${service}Url`]:url,...(key.trim()?{[`${service}Key`]:key.trim()}:{})});invalidate('/admin/cleanup');setDone(true);});
  return <Card title={title} description={description}>
    <form className="form-stack" onSubmit={e=>{e.preventDefault();save();}}>
      <div className="form-columns">
        <label>{title} address<input type="url" placeholder={placeholder} value={url} onChange={e=>{setUrl(e.target.value);setDone(false);}}/></label>
        <label>API key<input type="password" autoComplete="off" maxLength={200} value={key} placeholder={data[`${service}KeySet`]?'Saved — enter a new one to replace it':''} onChange={e=>{setKey(e.target.value);setDone(false);}}/><small>{hint}</small></label>
      </div>
      {mutation.error&&<ErrorNotice message={mutation.error}/>}
      <div className="button-row"><button className="primary" disabled={mutation.busy}>Save {title}</button>{done&&<span className="success" role="status">Saved.</span>}</div>
    </form>
  </Card>;
}

// The server owner's Plex token, which background work reads Plex with. The server checks it with Plex before saving.
function PlexToken() {
  const view=useApi<{plex:boolean}>('/admin/keys'),[token,setToken]=useState<string|null>(''),[done,setDone]=useState(false),mutation=useMutation(view.reload);
  if(view.loading&&!view.data)return <Card title="Plex"><Loading/></Card>;
  if(view.error&&!view.data)return <Card title="Plex"><ErrorNotice message={view.error.message} retry={view.reload}/></Card>;
  if(!view.data)return null;
  const saved=view.data.plex,removing=token===null,changed=removing||!!token?.trim();
  const save=()=>void mutation.run(async()=>{await api('/admin/keys','PUT',{plex:removing?'':token!.trim()});setToken('');setDone(true);});
  return <Card title="Plex" description="The owner’s token, used by schedules and background jobs.">
    <form className="form-stack" onSubmit={e=>{e.preventDefault();save();}}>
      <label className="narrow">Admin token
        <span className="setting-line"><input className="grow" type="password" autoComplete="off" maxLength={200} disabled={removing} value={token??''} placeholder={removing?'Removed when you save':saved?'Saved — enter a new one to replace it':'Not set'} onChange={e=>{setToken(e.target.value);setDone(false);}}/>
          {saved&&<button type="button" onClick={()=>{setToken(removing?'':null);setDone(false);}}>{removing?'Keep':'Remove'}</button>}</span>
        <small>Plex › any title › Get Info › View XML, at the end of the address.</small></label>
      {mutation.error&&<ErrorNotice message={mutation.error}/>}
      <div className="button-row"><button className="primary" disabled={mutation.busy||!changed}>Save Plex token</button>{done&&<span className="success" role="status">Saved.</span>}</div>
    </form>
  </Card>;
}

function SportsKey() {
  const view=useApi<{thesportsdb:boolean}>('/admin/keys'),[key,setKey]=useState<string|null>(''),[done,setDone]=useState(false),mutation=useMutation(view.reload);
  if(view.loading&&!view.data)return <Card title="TheSportsDB"><Loading/></Card>;
  if(view.error&&!view.data)return <Card title="TheSportsDB"><ErrorNotice message={view.error.message} retry={view.reload}/></Card>;
  if(!view.data)return null;
  const saved=view.data.thesportsdb,removing=key===null,changed=removing||!!key?.trim();
  const save=()=>void mutation.run(async()=>{await api('/admin/keys','PUT',{thesportsdb:removing?'':key!.trim()});setKey('');setDone(true);});
  return <Card title="TheSportsDB" description="Extra Live Sports leagues.">
    <form className="form-stack" onSubmit={e=>{e.preventDefault();save();}}>
      <label className="narrow">API key
        <span className="setting-line"><input className="grow" type="password" autoComplete="off" maxLength={200} disabled={removing} value={key??''} placeholder={removing?'Removed when you save':saved?'Saved — enter a new one to replace it':'Using the free key'} onChange={e=>{setKey(e.target.value);setDone(false);}}/>
          {saved&&<button type="button" onClick={()=>{setKey(removing?'':null);setDone(false);}}>{removing?'Keep':'Remove'}</button>}</span>
        <small>Optional. The free key is used if empty.</small></label>
      {mutation.error&&<ErrorNotice message={mutation.error}/>}
      <div className="button-row"><button className="primary" disabled={mutation.busy||!changed}>Save TheSportsDB key</button>{done&&<span className="success" role="status">Saved.</span>}</div>
    </form>
  </Card>;
}
