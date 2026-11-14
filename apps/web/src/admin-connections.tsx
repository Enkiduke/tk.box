import {useState} from 'react';
import {ApiClientError,api} from './api.js';
import {invalidate,link,useApi} from './hooks.js';
import {ErrorNotice,Icon,Modal} from './components.js';
import {date,SectionHead,useMutation} from './settings-ui.js';

type KeyName='tmdb'|'tvdb'|'fanart'|'mdblist';
type ArtworkView={settings:{revision:number;keysSet:Record<KeyName,boolean>}&Record<string,unknown>};
type ArrView=Record<'radarr'|'sonarr',{revision:number;url:string;keySet:boolean}>;
type CleanupView={revision:number;tautulliUrl:string;tautulliKeySet:boolean};
type SeerrView={revision:number;seerrUrl:string;seerrKeySet:boolean};
type KeysView={plex:boolean;thesportsdb:boolean};
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
  save:(draft:Draft)=>Promise<unknown>;
};
type Connection={
  name:string;
  description:string;
  keyLabel?:string;
  keyHint?:string;
  settings?:SavedSettings;
  unavailable?:boolean;
  refreshing?:boolean;
  retry?:()=>void;
  builtIn?:boolean;
  health?:HealthStatus;
  credential?:string;
};

const artworkProviders=[
  ['tmdb','TMDb','Movies and TV in Explore, Artwork, Collections, and Calendar.','themoviedb.org › Settings › API'],
  ['tvdb','TVDB','TV series and season artwork.','thetvdb.com › Dashboard › API keys'],
  ['fanart','Fanart.tv','Additional posters, backgrounds, and logos for Artwork.','fanart.tv › Profile'],
  ['mdblist','MDBList','List import and discovery in Collections.','mdblist.com › Preferences'],
] as const;

function readSettings<T>(view:ReturnType<typeof useApi<T>>,read:(data:T)=>SavedSettings) {
  return {
    settings:view.data===undefined?undefined:read(view.data),
    unavailable:!!view.error,
    refreshing:view.loading,
    retry:view.reload,
  };
}

function isConfigured(settings:SavedSettings|undefined) {
  return !!settings?.keySaved && (settings.address===undefined || !!settings.address.value);
}

function connectionStatus(connection:Connection):HealthStatus {
  const {settings,unavailable,health}=connection;
  if(health)return health;
  if(unavailable)return {label:'Settings unavailable',tone:'warning',detail:'Could not load the saved settings.'};
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
  if(view.error)return {label:'Status unavailable',tone:'warning',detail:'Use Refresh status to try again.'};
  if(view.data===undefined)return {label:'Checking…'};
  return read(view.data);
}

function editAction(connection:Connection,settings:SavedSettings) {
  if(connection.builtIn)return 'Manage';
  return settings.keySaved||settings.address?.value?'Edit':'Add';
}

export function ConnectionsSettings({params}:{params:URLSearchParams}) {
  const [editing,setEditing]=useState<Connection>();
  const [saved,setSaved]=useState<{category:string;message:string}>();
  const serviceKeys=useApi<KeysView>('/admin/keys');
  const plex=useApi<PlexHealth>('/admin/connections/plex');
  const sports=useApi<SportsHealth>('/admin/connections/sports');
  const services=useApi<Record<string,ServiceHealth>>('/admin/connections/services');
  const explore=useApi<SeerrView>('/admin/explore/settings');
  const artwork=useApi<ArtworkView>('/admin/artwork');
  const arr=useApi<ArrView>('/admin/arr');
  const cleanup=useApi<CleanupView>('/admin/cleanup/connections');

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
      invalidate(name==='plex'?'/admin/connections/plex':'/admin/connections/sports');
    },
  }));
  const arrApps:Connection[]=([
    ['radarr','Radarr','Movie releases in Calendar, seasonal downloads in Collections, and movie management in Clean Up.','http://radarr:7878'],
    ['sonarr','Sonarr','TV air dates in Calendar and episode management in Clean Up.','http://sonarr:8989'],
  ] as const).map(([id,name,description,placeholder])=>({
    name,description,keyHint:`${name} › Settings › General`,
    health:arr.data?.[id].url&&arr.data[id].keySet?serviceStatus(id):undefined,
    ...readSettings(arr,data=>({
      keySaved:data[id].keySet,
      address:{value:data[id].url,placeholder,hint:'Leave blank to disable this connection.'},
      save:async ({address,key})=>{
        await api(`/admin/arr/${id}`,'PUT',{expectedRevision:data[id].revision,url:address,...(key?{key}:{})});
        invalidate('/admin/arr');invalidate('/admin/cleanup');invalidate('/admin/artwork/collections');invalidate('/calendar');
        invalidate('/admin/connections/services');
      },
    })),
  }));
  const tautulli:Connection={
    name:'Tautulli',description:'Plex watch history for Clean Up.',keyHint:'Tautulli › Settings › Web Interface',
    health:cleanup.data?.tautulliUrl&&cleanup.data.tautulliKeySet?serviceStatus('tautulli'):undefined,
    ...readSettings(cleanup,data=>({
      keySaved:data.tautulliKeySet,
      address:{value:data.tautulliUrl,placeholder:'http://tautulli:8181',hint:'Leave blank to disable this connection.'},
      save:async ({address,key})=>{
        await api('/admin/cleanup/connections','PUT',{expectedRevision:data.revision,tautulliUrl:address,...(key?{tautulliKey:key}:{})});
        invalidate('/admin/cleanup');
        invalidate('/admin/connections/services');
      },
    })),
  };
  const groups:{id:string;title:string;icon:string;connections:Connection[]}[]=[
    {id:'media',title:'Media & requests',icon:'live',connections:[
      {
        name:'Plex',description:'Sign-in, media libraries, and scheduled jobs.',
        keyLabel:'Admin token',builtIn:true,health:readHealth(plex,plexStatus),
        keyHint:'In Plex, open a title and choose Get Info › View XML. Copy the X-Plex-Token value from the address.',
        ...keySettings('plex'),
      },
      {
        name:'Seerr',description:'Movie and TV requests in Explore and request data in Clean Up.',
        health:explore.data?.seerrUrl?serviceStatus('seerr'):undefined,
        keyHint:'Seerr › Settings › General. Add a key for availability and request badges in Explore and request data in Clean Up.',
        ...readSettings(explore,data=>({
          keySaved:data.seerrKeySet,
          address:{value:data.seerrUrl,placeholder:'https://requests.example.com',hint:'Clearing the address turns off requests and removes the saved key.'},
          save:async ({address,key})=>{
            await api('/admin/explore/settings','PUT',{
              expectedRevision:data.revision,seerrUrl:address,...(key||!address?{seerrApiKey:address?key:''}:{}),
            });
            invalidate('/admin/explore/settings');
            invalidate('/explore/');
            invalidate('/admin/connections/services');
          },
        })),
      },
    ]},
    {id:'downloads',title:'Downloads & Clean Up',icon:'download',connections:[
      ...arrApps,
      tautulli,
    ]},
    {id:'metadata',title:'Metadata & artwork',icon:'image',connections:artworkProviders.map(([id,name,description,keyHint])=>({
      name,description,keyHint,
      health:artwork.data?.settings.keysSet[id]?serviceStatus(id):undefined,
      ...readSettings(artwork,({settings:{revision,keysSet,...settings}})=>({
        keySaved:keysSet[id],
        removableKey:true,
        save:async ({key})=>{
          await api('/admin/artwork/settings','PUT',{expectedRevision:revision,...settings,[`${id}Key`]:key??''});
          invalidate('/admin/artwork');
          invalidate('/admin/connections/services');
        },
      })),
    }))},
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
    if(connection.unavailable&&status.tone!=='warning')return [{id,name:connection.name,label:'Settings unavailable',detail:undefined}];
    return status.tone==='warning'?[{id,name:connection.name,label:status.label,detail:status.detail}]:[];
  }));
  const refresh=()=>{
    plex.reload();sports.reload();services.reload();
    for(const view of [serviceKeys,explore,artwork,arr,cleanup])if(view.error)view.reload();
  };
  const refreshingStatus=plex.loading||sports.loading||services.loading;
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
            const known=connections.every(item=>item.builtIn||item.settings&&!item.unavailable);
            const count=connections.filter(item=>item.builtIn||isConfigured(item.settings)).length;
            const issueCount=issues.filter(item=>item.id===id).length;
            return <a key={id} aria-current={id===group.id?'page':undefined} href={categoryLink(id)}>
              <span className="connections-icon"><Icon name={icon} size={16}/></span>
              <span>{title}</span>
              {issueCount>0
                ? <span className="connections-count" data-warning="true">{issueCount} {issueCount===1?'issue':'issues'}</span>
                : known&&<span className="connections-count" aria-label={`${count} of ${connections.length} set up`}>{count}/{connections.length}</span>}
            </a>;
          })}
        </nav>
        <section className="connections-services" id="connections-services" aria-labelledby="connections-category">
          <h4 id="connections-category">{group.title}</h4>
          <ul className="connections-list">
            {group.connections.map(connection=>{
              const {name,description,settings,unavailable,refreshing,retry}=connection;
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
                {unavailable
                  ? <button type="button" disabled={refreshing} aria-label={`Retry loading ${name} settings`} onClick={retry}>Retry</button>
                  : action&&<button type="button" disabled={refreshing} aria-label={`${action} ${name}`} onClick={()=>{setSaved(undefined);setEditing(connection);}}>
                    {action}
                  </button>}
              </li>;
            })}
          </ul>
          <div className="connections-feedback success small" role="status">{saved?.category===group.id?saved.message:''}</div>
        </section>
      </div>
    </section>
    {editing?.settings&&<ConnectionEditor connection={editing} settings={editing.settings} onClose={()=>setEditing(undefined)}
      onSaved={()=>{setSaved({category:group.id,message:`${editing.name} settings saved.`});setEditing(undefined);}}/>}
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
          try{await settings.save(values);}
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
