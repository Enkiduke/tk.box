import {useState,type ReactNode} from 'react';
import type {DownloaderView,IndexerView} from '../../../packages/contracts/src/downloads.js';
import {ApiClientError,api} from './api.js';
import {IptorrentsEditor,NzbGeekEditor,OpenSubtitlesEditor,QbittorrentEditor,SabnzbdEditor} from './download-connections.js';
import type {SubtitlesView} from '../../../packages/contracts/src/subtitles.js';
import {invalidate,link,useApi} from './hooks.js';
import {ErrorNotice,Icon,Loading,Modal} from './components.js';
import {date,SectionHead,useMutation} from './settings-ui.js';
import {toast} from './toasts.js';

type KeysView={plex:boolean;thesportsdb:boolean;tmdb:boolean;tvdb:boolean;fanart:boolean;mdblist:boolean};
type PlexHealth={account:boolean;server:boolean;admin:'working'|'missing'|'failed'|'unverified';checkedAt:number};
type FeedHealth={state:'idle'|'waiting'|'working'|'warning'|'backoff';lastSuccess:number|null;lastChecked:number|null;failedRequests:number;retryAt:number|null};
type SportsHealth=Record<'espn'|'tsdb',FeedHealth>;
type HealthStatus={label:string;tone?:'success'|'warning';detail?:string;timestamp?:string};
type ServiceHealth={state:'working'|'limited'|'failed';checkedAt:number;detail?:string};

type Draft={address:string;key:string|null};
type SavedSettings={
  keySaved:boolean;
  address?:{value:string;placeholder:string;hint?:string};
  removableKey?:boolean;
  save?:(draft:Draft)=>Promise<unknown>;
};
type Connection={
  name:string;
  description:string;
  keyLabel?:string;
  keyHint?:string;
  settings?:SavedSettings;
  settingsError?:string;
  refreshing?:boolean;
  retry?:()=>void;
  builtIn?:boolean;
  health?:HealthStatus;
  credential?:string;
  // Its own settings form in place of the address-and-key editor.
  editor?:(close:()=>void)=>ReactNode;
};

// The metadata and artwork providers' keys, saved with the other service keys.
const artworkProviders=[
  ['tmdb','TMDb','Movies and TV in Explore, Requests, Calendar, Artwork, and Collections.','themoviedb.org › Settings › API'],
  ['tvdb','TVDB','TV series and season artwork.','thetvdb.com › Dashboard › API keys'],
  ['fanart','Fanart.tv','Additional posters, backgrounds, and logos for Artwork.','fanart.tv › Profile'],
  ['mdblist','MDBList','List import and discovery in Collections.','mdblist.com › Preferences'],
] as const;

function readSettings<T>(view:ReturnType<typeof useApi<T>>,read:(data:T)=>SavedSettings) {
  return {
    settings:view.data===undefined?undefined:read(view.data),
    settingsError:view.error?.message,
    refreshing:view.loading,
    retry:view.reload,
  };
}

function isConfigured(settings:SavedSettings|undefined) {
  return !!settings?.keySaved && (settings.address===undefined || !!settings.address.value);
}

function connectionStatus(connection:Connection):HealthStatus {
  const {settings,settingsError,health}=connection;
  if(settingsError)return {label:'Settings unavailable',tone:'warning',detail:settingsError};
  if(health)return health;
  if(!settings)return {label:'Loading…'};
  if(isConfigured(settings))return {label:'Checking…'};
  if(settings.address?.value)return {label:'API key missing',tone:'warning',detail:'Add an API key to complete setup.'};
  if(settings.address&&settings.keySaved)return {label:'Disabled',detail:'Add a server address to use the saved key.'};
  return {label:'Not set up'};
}

function plexStatus({account,server,admin,checkedAt}:PlexHealth):HealthStatus {
  const issues=[
    !account&&'Plex account access failed.',
    !server&&'The media server or its libraries could not be reached.',
    admin==='failed'&&'The saved admin token could not access Plex.',
    admin==='missing'&&'Add the admin token to enable scheduled and background jobs.',
    admin==='unverified'&&'The saved admin token could not be verified during this check.',
  ].filter(Boolean);
  const status=!account&&!server?'Unavailable':!account||!server||admin==='failed'?'Needs attention':admin==='missing'?'Limited':'Working';
  return {label:status,tone:status==='Working'?'success':'warning',detail:issues.join(' '),timestamp:`Checked ${date(checkedAt)}`};
}

function feedStatus({state,lastSuccess,lastChecked,failedRequests,retryAt}:FeedHealth):HealthStatus {
  if(state==='idle')return {label:'Idle',detail:'Schedules download when an IPTV source uses Live Events.'};
  if(state==='waiting')return {label:'Awaiting sync'};
  const timestamp=[
    lastSuccess!==null&&`Last successful download ${date(lastSuccess)}`,
    lastChecked!==null&&lastChecked!==lastSuccess&&`Last attempt ${date(lastChecked)}`,
    retryAt!==null&&`Retries after ${date(retryAt)}`,
  ].filter(Boolean).join(' · ');
  if(state==='working')return {label:'Working',tone:'success',timestamp};
  return {label:state==='backoff'?'Waiting to retry':'Needs attention',tone:'warning',
    detail:`${failedRequests} schedule ${failedRequests===1?'request has':'requests have'} failed and will retry automatically.`,timestamp};
}

function readHealth<T>(view:ReturnType<typeof useApi<T>>,read:(data:T)=>HealthStatus):HealthStatus {
  if(view.error)return {label:'Status unavailable',tone:'warning',detail:view.error.name==='TimeoutError'?'The status check timed out.':view.error.message};
  if(view.data===undefined)return {label:'Checking…'};
  return read(view.data);
}

function editAction(connection:Connection,settings:SavedSettings) {
  if(connection.builtIn)return 'Manage';
  return settings.keySaved||settings.address?.value?'Edit':'Add';
}

function categoryStatus(connections:Connection[]) {
  const statuses=connections.map(connectionStatus);
  const issues=statuses.filter(status=>status.tone==='warning').length;
  const working=statuses.some(status=>status.tone==='success');
  const configured=connections.filter(item=>item.builtIn||isConfigured(item.settings)).length;
  const loading=statuses.some(status=>['Checking…','Loading…','Awaiting check','Awaiting sync'].includes(status.label));
  const tone=issues?'warning':loading?'checking':working?'success':'idle';
  const summary=issues?`${issues} ${issues===1?'issue':'issues'}`:loading?'Checking status':working?'Working':'Idle or not set up';
  return {tone,summary,configured,count:configured?`${configured}/${connections.length}`:'–'};
}

export function ConnectionsRecovery({params}:{params:URLSearchParams}) {
  const keys=useApi<KeysView>('/admin/keys');
  if(keys.error)return <ErrorNotice message={keys.error.message} retry={keys.reload}/>;
  if(!keys.data)return <Loading/>;
  return <ConnectionsSettings params={params}/>;
}

export function ConnectionsSettings({params}:{params:URLSearchParams}) {
  const [editing,setEditing]=useState<Connection>();
  const serviceKeys=useApi<KeysView>('/admin/keys');
  const plex=useApi<PlexHealth>('/admin/connections/plex');
  const sports=useApi<SportsHealth>('/admin/connections/sports');
  const services=useApi<Record<string,ServiceHealth>>('/admin/connections/services');
  const indexers=useApi<IndexerView[]>('/admin/indexers');
  const downloaders=useApi<DownloaderView[]>('/admin/downloaders');
  const subtitles=useApi<SubtitlesView>('/admin/subtitles');

  const serviceStatus=(id:string)=>readHealth(services,results=>{
    const result=results[id];
    if(!result)return {label:'Awaiting check'};
    const {state,checkedAt,detail}=result;
    return {label:state==='working'?'Working':state==='limited'?'Limited':'Needs attention',
      tone:state==='working'?'success':'warning',detail,timestamp:`Checked ${date(checkedAt)}`};
  });
  const keySettings=(name:keyof KeysView)=>readSettings(serviceKeys,data=>({
    keySaved:data[name],
    removableKey:true,
    save:async ({key})=>{
      await api('/admin/keys','PUT',{[name]:key??''});
      invalidate('/admin/keys');
      invalidate(name==='plex'?'/admin/connections/plex':name==='thesportsdb'?'/admin/connections/sports':'/admin/connections/services');
      if(name==='plex')invalidate('/admin/cleanup/users');
    },
  }));
  const nzbgeek=indexers.data?.find(item=>item.name==='nzbgeek');
  const sabnzbd=downloaders.data?.find(item=>item.name==='sabnzbd');
  const iptorrents=indexers.data?.find(item=>item.name==='iptorrents');
  const qbittorrent=downloaders.data?.find(item=>item.name==='qbittorrent');
  const subtitleView=subtitles.data;
  const nzbgeekStatus=(item:IndexerView):HealthStatus=>
    !item.secretSet?{label:'Not set up'}
    :!item.enabled?{label:'Off'}
    :item.pausedUntil?{label:'Paused',tone:'warning',detail:`Paused until ${date(item.pausedUntil)}.`}
    :item.lastError?{label:'Needs attention',tone:'warning',detail:item.lastError}
    :item.lastOkAt?{label:'Working',tone:'success',timestamp:`Last worked ${date(item.lastOkAt)}`}
    :{label:'Not used yet'};
  const searchConnections:Connection[]=[
    {
      name:'NZBGeek',description:'Usenet releases for movies and TV.',
      health:readHealth(indexers,()=>nzbgeek?nzbgeekStatus(nzbgeek):{label:'Not set up'}),
      ...readSettings(indexers,()=>({keySaved:!!nzbgeek?.secretSet})),
      ...(nzbgeek?{editor:(close:()=>void)=><NzbGeekEditor indexer={nzbgeek} onClose={close}/>}:{}),
    },
    {
      name:'SABnzbd',description:'Downloads Usenet releases.',
      health:readHealth(downloaders,()=>sabnzbd?.url&&sabnzbd.secretSet?{label:'Set up'}:sabnzbd?.url?{label:'API key missing',tone:'warning',detail:'Add an API key to complete setup.'}:{label:'Not set up'}),
      ...readSettings(downloaders,()=>({keySaved:!!sabnzbd?.secretSet,address:{value:sabnzbd?.url??'',placeholder:'http://127.0.0.1:8080'}})),
      ...(sabnzbd?{editor:(close:()=>void)=><SabnzbdEditor downloader={sabnzbd} onClose={close}/>}:{}),
    },
    {
      name:'IPTorrents',description:'Torrents for movies, when Usenet has nothing better.',
      health:readHealth(indexers,()=>!iptorrents?.iptorrents?.cookieSet&&!iptorrents?.iptorrents?.rssSet?{label:'Not set up'}:nzbgeekStatus(iptorrents)),
      ...readSettings(indexers,()=>({keySaved:!!iptorrents?.secretSet})),
      ...(iptorrents?{editor:(close:()=>void)=><IptorrentsEditor indexer={iptorrents} onClose={close}/>}:{}),
    },
    {
      name:'qBittorrent',description:'Downloads and seeds torrents.',
      health:readHealth(downloaders,()=>qbittorrent?.url?{label:'Set up'}:{label:'Not set up'}),
      ...readSettings(downloaders,()=>({keySaved:!!qbittorrent?.secretSet,address:{value:qbittorrent?.url??'',placeholder:'http://127.0.0.1:8080'}})),
      ...(qbittorrent?{editor:(close:()=>void)=><QbittorrentEditor downloader={qbittorrent} onClose={close}/>}:{}),
    },
    {
      name:'OpenSubtitles',description:'English subtitles for movies and shows.',
      health:readHealth(subtitles,s=>!s.login.apiKey||!s.login.username||!s.login.password?{label:'Not set up'}
        :s.blocked?{label:'Needs attention',tone:'warning',detail:s.blocked}:!s.enabled?{label:'Off'}:{label:'Set up',tone:'success'}),
      ...readSettings(subtitles,s=>({keySaved:s.login.apiKey&&s.login.password})),
      ...(subtitleView?{editor:(close:()=>void)=><OpenSubtitlesEditor view={subtitleView} onClose={close}/>}:{}),
    },
  ];
  const groups:{id:string;title:string;icon:string;connections:Connection[]}[]=[
    {id:'media',title:'Media & requests',icon:'live',connections:[
      {
        name:'Plex',description:'Sign-in, media libraries, and scheduled jobs.',
        keyLabel:'Admin token',builtIn:true,health:readHealth(plex,plexStatus),
        keyHint:'In Plex, open a title and choose Get Info › View XML. Copy the X-Plex-Token value from the address.',
        ...keySettings('plex'),
      },
    ]},
    {id:'indexers',title:'Indexers & downloaders',icon:'search',connections:searchConnections},
    {id:'metadata',title:'Metadata & artwork',icon:'image',connections:[
      ...artworkProviders.map(([id,name,description,keyHint]):Connection=>({
        name,description,keyHint,
        health:serviceKeys.data?.[id]?serviceStatus(id):undefined,
        ...keySettings(id),
      })),
      // No key: TVmaze is free (data CC BY-SA, credited here).
      {name:'TVmaze',description:'Episode air times. Data from tvmaze.com.',builtIn:true,
        health:serviceStatus('tvmaze')},
    ]},
    {id:'live-events',title:'Live Events',icon:'star',connections:[
      {
        name:'ESPN',description:'Scores and schedules for Live Events.',builtIn:true,
        health:readHealth(sports,data=>feedStatus(data.espn)),
      },
      {
        name:'TheSportsDB',description:'Additional league schedules for Live Events.',builtIn:true,
        health:readHealth(sports,data=>feedStatus(data.tsdb)),
        credential:serviceKeys.error||!serviceKeys.data?undefined:serviceKeys.data.thesportsdb?'Using custom key':'Using free key',
        keyHint:'Optional. Live Events uses the free key when you leave this blank.',
        ...keySettings('thesportsdb'),
      },
    ]},
  ];
  const group=groups.find(item=>item.id===params.get('category'))??groups[0]!;
  const categoryLink=(id:string)=>link('admin',{section:'connections',category:id});
  const issues=groups.flatMap(({id,connections})=>connections.flatMap(connection=>{
    const status=connectionStatus(connection);
    return status.tone==='warning'?[{id,name:connection.name,label:status.label,detail:status.detail}]:[];
  }));
  const refresh=()=>{
    plex.reload();sports.reload();services.reload();indexers.reload();downloaders.reload();subtitles.reload();
    if(serviceKeys.error)serviceKeys.reload();
  };
  const refreshingStatus=plex.loading||sports.loading||services.loading||indexers.loading||downloaders.loading||subtitles.loading;
  return <>
    <SectionHead title="Connections" description="Manage connected services and see their latest status.">
      <button type="button" disabled={refreshingStatus} onClick={refresh}><Icon name="restart" size={15}/>{refreshingStatus?'Refreshing…':'Refresh status'}</button>
    </SectionHead>
    <div aria-live="polite">
      {issues.length>0&&<section className="connections-issues" aria-labelledby="connections-issues-heading">
        <h3 id="connections-issues-heading"><Icon name="info" size={17}/>{issues.length} {issues.length===1?'connection needs':'connections need'} attention</h3>
        <ul>{issues.map(({id,name,label,detail})=><li key={name}>
          <a href={link('admin',{section:'connections',category:id,service:name})}><strong>{name}</strong><span>{detail??label}</span><Icon name="next" size={14}/></a>
        </li>)}</ul>
      </section>}
    </div>
    <section className="connections" aria-labelledby="connections-heading">
      <header className="connections-head">
        <h3 id="connections-heading">Linked apps</h3>
        <span className="muted small">Keys and tokens are stored encrypted.</span>
      </header>
      <div className="connections-layout">
        <nav className="connections-nav" aria-label="Connection categories">
          {groups.map(({id,title,icon,connections})=>{
            const {tone,summary,configured,count}=categoryStatus(connections);
            return <a key={id} aria-current={id===group.id?'page':undefined} href={categoryLink(id)}>
              <span className="connections-icon"><Icon name={icon} size={16}/></span>
              <span>{title}</span>
              <span className="connections-count" data-tone={tone} title={summary}>
                <span aria-hidden="true">{count}</span>
                <span className="sr-only">{configured} of {connections.length} set up. {summary}</span>
              </span>
            </a>;
          })}
        </nav>
        <section className="connections-services" id="connections-services" aria-labelledby="connections-category">
          <h4 id="connections-category">{group.title}</h4>
          <ul className="connections-list">
            {group.connections.map(connection=>{
              const {name,description,settings,settingsError,refreshing,retry}=connection;
              const {label,tone,detail,timestamp}=connectionStatus(connection);
              const action=settings&&editAction(connection,settings);
              return <li className="connections-row" data-selected={params.get('service')===name||undefined} key={name}>
                <div className="connections-info">
                  <strong>{name}</strong>
                  <p>{description}</p>
                  {settings?.address?.value&&<small className="connections-address">Address · {settings.address.value}</small>}
                  {connection.credential&&<small className="connections-address">{connection.credential}</small>}
                  {detail&&<small className="connections-address">{detail}</small>}
                  {timestamp&&<small className="connections-address">{timestamp}</small>}
                </div>
                <span className={`badge connections-status ${tone??''}`}>{label}</span>
                {settingsError
                  ? <button type="button" disabled={refreshing} aria-label={`Retry loading ${name} settings`} onClick={retry}>Retry</button>
                  : action&&<button type="button" disabled={refreshing} aria-label={`${action} ${name}`} onClick={()=>setEditing(connection)}>
                    {action}
                  </button>}
              </li>;
            })}
          </ul>
          
        </section>
      </div>
    </section>
    {editing?.settings&&(editing.editor
      ? <Modal title={`${editAction(editing,editing.settings)} ${editing.name}`} onClose={()=>setEditing(undefined)}>
        <div className="connections-editor">
          <h3>{editAction(editing,editing.settings)} {editing.name}</h3>
          <p className="muted small">{editing.description}</p>
          {editing.editor(()=>setEditing(undefined))}
        </div>
      </Modal>
      : <ConnectionEditor connection={editing} settings={editing.settings} onClose={()=>setEditing(undefined)}
        onSaved={()=>{toast.success(`${editing.name} settings saved`);setEditing(undefined);}}/>)}
  </>;
}

function ConnectionEditor({connection,settings,onClose,onSaved}:{connection:Connection;settings:SavedSettings;onClose:()=>void;onSaved:()=>void}) {
  const {name,description,keyHint,keyLabel='API key'}=connection;
  const {address,keySaved,removableKey}=settings;
  const [draft,setDraft]=useState<Draft>({address:address?.value??'',key:''});
  const [conflict,setConflict]=useState(false);
  const mutation=useMutation(()=>{});
  const removing=draft.key===null;
  const values={address:draft.address.trim(),key:draft.key?.trim()??null};
  const changed=values.address!==(address?.value??'')||values.key!=='';
  const title=`${editAction(connection,settings)} ${name}`;
  const update=(patch:Partial<Draft>)=>setDraft(current=>({...current,...patch}));
  const close=()=>{if(!mutation.busy)onClose();};
  return <Modal title={title} onClose={close}>
    <div className="connections-editor">
      <h3>{title}</h3>
      <p className="muted small">{description}</p>
      <form className="form-stack" onSubmit={async e=>{
        e.preventDefault();
        if(!changed||conflict)return;
        const saved=await mutation.run(async()=>{
          try{await settings.save?.(values);}
          catch(error){
            if(error instanceof ApiClientError&&error.code==='REVISION_CONFLICT'){
              setConflict(true);
              connection.retry?.();
            }
            throw error;
          }
        });
        if(saved)onSaved();
      }}>
        {address&&<label>Server address
          <input type="url" placeholder={address.placeholder} value={draft.address} maxLength={300}
            disabled={mutation.busy}
            onChange={e=>update({address:e.target.value})} aria-describedby={address.hint?'connection-address-hint':undefined}/>
          {address.hint&&<small id="connection-address-hint">{address.hint}</small>}
        </label>}
        <div className="connections-field">
          <label htmlFor="connection-key">{keyLabel}</label>
          <div className="connections-field-control">
            <input id="connection-key" type="password" autoComplete="off" maxLength={200} value={draft.key??''} disabled={removing||mutation.busy}
              aria-describedby="connection-key-hint" placeholder={removing?'Removed when you save':keySaved?'Saved. Enter a new value to replace it.':undefined}
              onChange={e=>update({key:e.target.value})}/>
            {keySaved&&removableKey&&<button type="button" disabled={mutation.busy} onClick={()=>update({key:removing?'':null})}>{removing?'Keep':'Remove'}</button>}
          </div>
          <small id="connection-key-hint" className="muted">{keyHint}</small>
        </div>
        {mutation.error&&<ErrorNotice message={conflict?'These settings changed while the editor was open. Reopen the editor to use the latest settings.':mutation.error}/>}
        <div className="button-row">
          <button className="primary" disabled={mutation.busy||!changed||conflict}>{mutation.busy?'Saving…':'Save settings'}</button>
          <button type="button" disabled={mutation.busy} onClick={close}>{conflict?'Close':'Cancel'}</button>
        </div>
      </form>
    </div>
  </Modal>;
}
