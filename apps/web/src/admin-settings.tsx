// The IPTV, Live Sports and server playback sections of the Admin console.
import {useEffect,useState} from 'react';
import type {PlaybackSettings} from '../../../packages/contracts/src/index.js';
import {api} from './api.js';
import {useApi} from './hooks.js';
import {Empty,ErrorNotice,Icon,Loading,Modal} from './components.js';
import {Card,MoveButtons,SectionHead,Stat,Switch,code,date,moveTo,plural,remember,remembered,useDragOrder,useMutation} from './settings-ui.js';

type Source={id:string;name:string;kind:'m3u'|'xmltv';revision:number;intervalHours:number;remote:boolean;allowPrivateStreams:boolean;lastAttempt:number|null;lastSuccess:number|null;nextDue:number|null;lastError:string|null;candidateDigest:string|null;running:boolean;feedId?:string};
type Listing='auto'|'always'|'hidden';
type ListingState='listed'|'always'|'hidden'|'missing'|'conflict'|'no_event'|'failing'|'unverified'|'no_guide';
type Channel={id:string;name:string;tvgId:string;group:string;stack:string|null;stackKey:string;quality:string|null;listing:Listing;state:ListingState;event:boolean;guideExempt:boolean;present:boolean;conflict:boolean;number:number|null;position:number|null;firstSeen:number;lastSeen:number;missingSince:number|null};
type Summary=Partial<Record<ListingState,number>>;
type ChannelsView={channels:Channel[];summary:Summary};
type Group={name:string;channels:number;listed:number;mode:'auto'|'regular'|'events';detected:'regular'|'events';events:boolean;guideExempt:boolean};
type ListingPolicy={requireCheck:boolean;requireGuide:boolean;guideHours:number;alwaysOn:string[]};
type ListingView={policy:ListingPolicy;summary:Summary;groups:Group[]};
function Keywords({value,onChange,disabled}:{value:string[];onChange:(value:string[])=>void;disabled?:boolean}) {
  const [draft,setDraft]=useState('');
  const add=()=>{const word=draft.trim();if(word&&!value.includes(word)&&value.length<30)onChange([...value,word]);setDraft('');};
  return <div className="keywords">{value.map(word=><span key={word} className="keyword">{word}<button type="button" className="icon-button" aria-label={`Remove ${word}`} disabled={disabled} onClick={()=>onChange(value.filter(w=>w!==word))}><Icon name="close" size={12}/></button></span>)}
    <input aria-label="Add a keyword" placeholder={value.length?'Add…':'Add a keyword, e.g. 24/7'} value={draft} maxLength={60} disabled={disabled} onChange={e=>setDraft(e.target.value)} onBlur={add} onKeyDown={e=>{if(e.key==='Enter'||e.key===','){e.preventDefault();add();}else if(e.key==='Backspace'&&!draft&&value.length)onChange(value.slice(0,-1));}}/></div>;
}

// Why a channel is or is not listed, as the server reports it.
const states:Record<ListingState,{label:string;tone:''|'ok'|'warning'|'danger';detail:string}>={
  listed:{label:'Listed',tone:'ok',detail:'Meets this source’s listing rules.'},
  always:{label:'Always listed',tone:'ok',detail:'An administrator lists it whatever the rules say.'},
  unverified:{label:'Waiting for a check',tone:'',detail:'Lists once a channel check sees it play.'},
  failing:{label:'Failing checks',tone:'danger',detail:'Hidden until a check sees it play again.'},
  no_guide:{label:'No guide data',tone:'warning',detail:'Nothing in the guide now or within the look-ahead.'},
  no_event:{label:'No event on',tone:'',detail:'An event channel; lists while its event is live or starting soon.'},
  hidden:{label:'Hidden',tone:'',detail:'Hidden by an administrator.'},
  conflict:{label:'Identity conflict',tone:'warning',detail:'The playlist changed and its saved feed cannot be matched confidently. Review the entries to resolve it.'},
  missing:{label:'Missing',tone:'',detail:'No longer in the playlist. Its number and favorites are kept.'}};
const unlisted:ListingState[]=['unverified','failing','no_guide','no_event','conflict'];
const listedCount=(s:Summary)=>(s.listed??0)+(s.always??0);
function StateBadge({channel}:{channel:Channel}) {
  const s=states[channel.state];return <span className={`badge ${s.tone}`} title={s.detail}>{s.label}</span>;
}

function CreateSource({onClose,created,changed}:{onClose:()=>void;created:(source:Source,error:string)=>void;changed:()=>void}) {
  const [name,setName]=useState(''),[mode,setMode]=useState('remote'),[url,setUrl]=useState(''),[headers,setHeaders]=useState(''),[insecure,setInsecure]=useState(false),[file,setFile]=useState<File>(),[sports,setSports]=useState('');
  const mutation=useMutation(changed);
  return <Modal title="Add IPTV source" onClose={()=>{if(!mutation.busy)onClose();}}>
    <h2>Add a source</h2>
    
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    <form className="form-stack" onSubmit={e=>{e.preventDefault();void mutation.run(async()=>{
      let requestHeaders:Record<string,string>={};
      if(mode==='remote'&&headers.trim()){try{requestHeaders=JSON.parse(headers);}catch{throw new Error('Headers must be a JSON object.');}}
      if(mode==='upload'&&(!file||file.size>16*1024*1024))throw new Error('Choose a UTF-8 playlist no larger than 16 MiB.');
      const source=await api<Source>('/admin/iptv/sources','POST',{name,kind:'m3u',...(mode==='remote'?{endpoint:{url:url.trim(),headers:requestHeaders,allowInsecureHttp:insecure}}:{})});
      setUrl('');setHeaders('');
      let error='';
      try {
        // Set before the first import, so event channels are never swept by channel checks.
        await api(`/admin/iptv/sources/${source.id}/sports`,'PUT',{enabled:sports==='events',leadMinutes:30});
        if(mode==='remote')await api(`/admin/iptv/sources/${source.id}/refresh`,'POST',{});
        // Setting the type changed the source's revision.
        else if(file){const current=(await api<{sources:Source[]}>('/admin/iptv/sources')).sources.find(x=>x.id===source.id)!;await api(`/admin/iptv/sources/${source.id}/upload`,'POST',{expectedRevision:current.revision,text:await file.text()});}
      } catch {
        // Creation has succeeded. Show the saved source so retrying cannot create a duplicate.
        error=`The source was saved, but its first import failed. ${mode==='remote'?'Use Refresh now to retry, or replace its URL under Connection.':'Import a replacement file under Connection.'}`;
      }
      created(source,error);onClose();
    });}}>
      <label>Source name<input value={name} onChange={e=>setName(e.target.value)} required maxLength={120} autoFocus/></label>
      <div className="segmented-field"><span>Import from</span><div className="toggle-group" role="radiogroup" aria-label="Import from">{([['remote','Remote URL'],['upload','File upload']] as const).map(([value,label])=><button key={value} type="button" role="radio" aria-checked={mode===value} onClick={()=>{setMode(value);setFile(undefined);}}>{label}</button>)}</div></div>
      {mode==='remote'?<>
        <label>Playlist URL<input type="url" value={url} onChange={e=>setUrl(e.target.value)} required autoComplete="off" spellCheck={false} placeholder="https://provider.example/playlist.m3u"/><small>Stored encrypted.</small></label>
        <details><summary>Provider request options</summary><div className="form-stack"><label>Request headers (JSON)<textarea value={headers} onChange={e=>setHeaders(e.target.value)} autoComplete="off" placeholder={'{"User-Agent":"tk.box"}'}/></label><label className="checkbox-label"><input type="checkbox" checked={insecure} onChange={e=>setInsecure(e.target.checked)}/>This provider requires unencrypted HTTP</label></div></details>
      </>:<label>Playlist file<input type="file" accept=".m3u,.m3u8" required onChange={e=>setFile(e.target.files?.[0])}/></label>}
      <label>Source type<select value={sports} required onChange={e=>setSports(e.target.value)}><option value="" disabled>Choose…</option><option value="regular">Regular channels</option><option value="events">Sports and live events</option></select><small>Event channels list only while their event is on.</small></label>
      <div className="button-row"><button className="primary" disabled={mutation.busy} type="submit">{mutation.busy?'Importing…':'Add source'}</button><button type="button" disabled={mutation.busy} onClick={onClose}>Cancel</button></div>
    </form>
  </Modal>;
}
function Candidate({source,onClose,changed}:{source:Source;onClose:()=>void;changed:()=>void}) {
  const candidate=useApi<{revision:number;digest:string;incoming:{name:string;tvgId:string}[];missing:{id:string;name:string;number:number|null}[]}>(`/admin/iptv/sources/${source.id}/candidate`),mutation=useMutation(changed);
  return <Modal title="Review source snapshot" onClose={onClose}><h2>Review a substantial lineup change</h2><p>The latest import would remove most of this source’s existing channels. Your current lineup is still active.</p>{candidate.loading?<Loading/>:candidate.error?<ErrorNotice message={candidate.error.message} retry={candidate.reload}/>:candidate.data&&<><div className="form-columns"><div><h3>Incoming · {candidate.data.incoming.length}</h3><ul className="review-list">{candidate.data.incoming.map((c,i)=><li key={i}>{c.name}<small>{c.tvgId||'No provider ID'}</small></li>)}</ul></div><div><h3>Will be hidden · {candidate.data.missing.length}</h3><ul className="review-list">{candidate.data.missing.map(c=><li key={c.id}>{c.name}</li>)}</ul></div></div>{mutation.error&&<ErrorNotice message={mutation.error}/>}<button className="primary" disabled={mutation.busy} onClick={()=>void mutation.run(async()=>{await api(`/admin/iptv/sources/${source.id}/candidate/accept`,'POST',{expectedRevision:candidate.data!.revision,digest:candidate.data!.digest});onClose();})}>Apply this reviewed import</button></>}</Modal>;
}
function Mapping({source,channel,onClose,changed}:{source:Source;channel:Channel;onClose:()=>void;changed:()=>void}) {
  type Review={mapping?:{xmlId:string;method:string};reviewRevision:number;candidates:{exactId?:string;suggestions:{xmlId:string;reason:string}[]}};
  const review=useApi<Review>(source.feedId?`/admin/iptv/channels/${channel.id}/mapping?feedId=${source.feedId}`:undefined),[xmlId,setXmlId]=useState(''),mutation=useMutation(()=>{review.reload();changed();});
  return <Modal title="Channel guide match" onClose={onClose}><h2>{channel.name}</h2>{!source.feedId?<Empty title="No guide linked">Add an EPG to this source first, under Guide.</Empty>:review.loading?<Loading/>:review.error?<ErrorNotice message={review.error.message} retry={review.reload}/>:review.data&&<><p>Current guide: <strong>{review.data.mapping?.xmlId??'No guide data'}</strong>{review.data.mapping&&` · ${review.data.mapping.method==='admin'?'Chosen by an administrator':'Exact ID match'}`}</p>{review.data.candidates.suggestions.length>0&&<div className="form-stack"><h3>Suggested matches</h3><div className="button-row">{review.data.candidates.suggestions.map(c=><button key={c.xmlId} type="button" aria-pressed={xmlId===c.xmlId} onClick={()=>setXmlId(c.xmlId)}>{c.xmlId}</button>)}</div></div>}<form className="form-stack" onSubmit={e=>{e.preventDefault();void mutation.run(()=>api(`/admin/iptv/channels/${channel.id}/mapping`,'POST',{feedId:source.feedId,xmlId,expectedRevision:review.data!.reviewRevision}));}}><label>XMLTV channel ID<input value={xmlId} onChange={e=>setXmlId(e.target.value)} required maxLength={1024}/></label>{mutation.error&&<ErrorNotice message={mutation.error}/>}<button className="primary" disabled={mutation.busy||!xmlId}>Use this guide channel</button></form></>}</Modal>;
}
const listingOptions:[Listing,string,string][]=[['auto','Automatic','Follows this source’s listing rules.'],['always','Always list','Listed even if checks fail, guide data is missing or no event is on.'],['hidden','Hidden','Never listed for viewers.']];
function IdentityReview({channel,onClose,changed}:{channel:Channel;onClose:()=>void;changed:()=>void}) {
  type Review={revision:number;reason:'changed'|'ambiguous'|'legacy';current:{name:string;tvgId:string;group:string};candidates:{key:string;name:string;tvgId:string;group:string;quality:string|null}[]};
  const review=useApi<Review>(`/admin/iptv/channels/${channel.id}/identity`),mutation=useMutation(changed),[candidate,setCandidate]=useState(''),[separate,setSeparate]=useState(false);
  useEffect(()=>{setCandidate(review.data?.candidates.length===1?review.data.candidates[0]!.key:'');},[review.data]);
  const resolve=(action:'match'|'new')=>void mutation.run(async()=>{
    await api(`/admin/iptv/channels/${channel.id}/identity`,'POST',{expectedRevision:review.data!.revision,action,...(action==='match'?{candidate,separate}:{})});onClose();
  });
  return <Modal title="Review feed identity" onClose={()=>{if(!mutation.busy)onClose();}}><h2>{channel.name}</h2>
    {review.loading?<Loading/>:review.error?<ErrorNotice message={review.error.message} retry={review.reload}/>:review.data&&<>
      <p>{review.data.reason==='changed'?'The provider changed both this feed’s name and its stream address. Confirm whether it is still the same feed.':review.data.reason==='ambiguous'?'Several playlist entries could belong to this saved feed. Choose which entry should keep its number, favorites and settings.':'Review the incoming entry for this saved feed.'}</p>
      <p className="muted small">Saved entry: {review.data.current.name} · {review.data.current.tvgId||'No guide ID'} · {review.data.current.group||'Uncategorized'}</p>
      <fieldset className="listing-choices"><legend>Incoming playlist entries</legend>{review.data.candidates.map((p,i)=><label key={p.key} className={`listing-choice ${candidate===p.key?'selected':''}`}><input type="radio" name="identity-candidate" value={p.key} checked={candidate===p.key} disabled={mutation.busy} onChange={()=>setCandidate(p.key)}/><span><strong>{p.name}</strong><small>{[`Feed ${i+1}`,p.quality,p.tvgId||'No guide ID',p.group||'Uncategorized'].filter(Boolean).join(' · ')}</small></span></label>)}</fieldset>
      <label className="checkbox-label"><input type="checkbox" checked={separate} disabled={mutation.busy} onChange={e=>setSeparate(e.target.checked)}/>Keep the selected feed as its own channel</label>
      {mutation.error&&<ErrorNotice message={mutation.error}/>}
      <div className="button-row"><button className="primary" disabled={mutation.busy||!candidate} onClick={()=>resolve('match')}>Use selected entry</button><button disabled={mutation.busy||!review.data.candidates.length} onClick={()=>resolve('new')}>Import as new feeds</button></div>
      <p className="muted small">New feeds don’t inherit this feed’s number or favorites.</p>
    </>}
  </Modal>;
}
function EditChannel({source,channel,onClose,changed}:{source:Source;channel:Channel;onClose:()=>void;changed:()=>void}) {
  const [name,setName]=useState(channel.name),[number,setNumber]=useState(channel.number?.toString()??''),[position,setPosition]=useState(channel.position?.toString()??''),[listing,setListing]=useState(channel.listing),[providerName,setProviderName]=useState(false),mutation=useMutation(changed);
  const [stackMode,setStackMode]=useState(channel.stack===null?'auto':channel.stack===''?'separate':'custom'),[stack,setStack]=useState(channel.stack||'');
  return <Modal title="Edit channel" onClose={onClose}><h2>{channel.name}</h2><p className="muted small">{channel.group||'No category'} · {channel.tvgId||'No provider ID'} · <StateBadge channel={channel}/></p>
    <form className="form-stack" onSubmit={e=>{e.preventDefault();void mutation.run(async()=>{await api(`/admin/iptv/channels/${channel.id}`,'PATCH',{expectedRevision:source.revision,listing,displayName:providerName?null:name,stack:stackMode==='auto'?null:stackMode==='separate'?'':stack,...(number&&Number(number)!==channel.number?{number:Number(number)}:{}),...(position&&Number(position)!==channel.position?{position:Number(position)}:{})});onClose();});}}>
      <fieldset className="listing-choices"><legend>Listing</legend>{listingOptions.map(([value,label,detail])=><label key={value} className={`listing-choice ${listing===value?'selected':''}`}><input type="radio" name="listing" checked={listing===value} onChange={()=>setListing(value)}/><span><strong>{label}</strong><small>{detail}</small></span></label>)}</fieldset>
      <label>Display name<input value={name} onChange={e=>setName(e.target.value)} required maxLength={200}/></label>
      <label className="checkbox-label"><input type="checkbox" checked={providerName} onChange={e=>setProviderName(e.target.checked)}/>Use the provider’s name on future refreshes</label>
      <div className="form-columns"><label>Channel number<input type="number" min="1" max="999999" value={number} onChange={e=>setNumber(e.target.value)}/></label><label>Lineup position<input type="number" min="0" max="999999" value={position} onChange={e=>setPosition(e.target.value)}/></label></div>
      <div className="form-columns"><label>Feed stacking<select value={stackMode} onChange={e=>setStackMode(e.target.value)}><option value="auto">Automatic · by name or schedule</option><option value="custom">Stack with a station</option><option value="separate">Keep as its own channel</option></select><small>{stackMode==='auto'?'By station name or matching schedule.':stackMode==='separate'?'Never grouped.':'One guide row per station name.'}</small></label>{stackMode==='custom'&&<label>Station name<input value={stack} onChange={e=>setStack(e.target.value)} required maxLength={120} placeholder="CNN"/></label>}</div>
      {mutation.error&&<ErrorNotice message={mutation.error}/>}
      <div className="button-row"><button disabled={mutation.busy} className="primary">Save channel</button><button type="button" onClick={onClose}>Cancel</button></div>
    </form></Modal>;
}

type Health={status:'unchecked'|'online'|'offline'|'placeholder';reason:string|null;checkedAt:number|null;lastOnline:number|null;failures:number;queued:boolean;still:boolean;video?:{codec:string;width?:number;height?:number};thumbnail:boolean;fingerprint:boolean;checking:boolean};
type HealthView={policy:{intervalHours:number;hideFailing:boolean};summary:{online:number;offline:number;placeholder:number;unchecked:number;hidden:number;due:number;confirming:number;lastChecked:number|null;lastOnline:number|null;slates:number};checking:number;channels:Record<string,Health>};
const reasons:Record<string,string>={OK:'Playing',STILL_PICTURE:'Still picture with sound',LIVE_RELAY:'Playing for a viewer',FROZEN_SILENT:'Frozen picture with no sound',SILENT_AUDIO:'No sound',PLACEHOLDER_FILE:'Provider placeholder video',KNOWN_SLATE:'Matches a marked offline screen',SHARED_SLATE:'Same frozen screen as other channels',HTTP_NOT_FOUND:'Not found (HTTP 404)',HTTP_FORBIDDEN:'Access denied by provider',HTTP_SERVER_ERROR:'Provider server error',HTTP_ERROR:'Provider HTTP error',DNS_FAILED:'Stream host not found',CONNECTION_REFUSED:'Connection refused',TIMEOUT:'Timed out',INVALID_STREAM:'Not a playable stream',CONNECTION_LOST:'Connection dropped',STREAM_ENDED:'Stream stopped early',NO_MEDIA:'No video or audio'};
const failing=(h?:Health)=>h?.status==='offline'||h?.status==='placeholder';
function HealthBadge({health}:{health?:Health}) {
  // A first failure keeps the previous state until a recheck confirms it.
  const rechecking=!!health&&health.failures>0&&!failing(health);
  const label=health?.checking?'Checking…':rechecking?'Rechecking':!health||health.status==='unchecked'?(health?.queued?'Queued':'Not checked'):health.status==='online'?'Working':health.status==='offline'?'Offline':'Offline screen';
  const tone=health?.checking?'':rechecking?'warning':!health||health.status==='unchecked'?'':health.status==='online'?'ok':'danger';
  return <><span className={`dot-label ${tone}`}>{label}</span>{health&&(health.status!=='unchecked'||rechecking)&&health.reason&&<small>{reasons[health.reason]??code(health.reason)}</small>}{health?.checkedAt&&<small>Checked {date(health.checkedAt)}</small>}</>;
}
function ChecksPanel({source,health,changed}:{source:Source;health:ReturnType<typeof useApi<HealthView>>;changed:()=>void}) {
  const data=health.data,[interval,setInterval]=useState(24),[hide,setHide]=useState(true),[saved,setSaved]=useState(false),mutation=useMutation(()=>{health.reload();changed();});
  useEffect(()=>{if(data){setInterval(data.policy.intervalHours);setHide(data.policy.hideFailing);}},[data?.policy.intervalHours,data?.policy.hideFailing]);
  const s=data?.summary,busy=!!data&&(data.checking>0||data.summary.due>0);
  return <>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    {health.loading&&!data?<Loading/>:health.error?<ErrorNotice message={health.error.message} retry={health.reload}/>:s&&<>
      <Card title="Channel checks" description="Finds channels that fail, freeze or show an offline screen." actions={<button className="primary" disabled={mutation.busy} onClick={()=>void mutation.run(()=>api(`/admin/iptv/sources/${source.id}/health/check`,'POST',{}))}>Check all now</button>}>
        <div className="stat-grid"><Stat label="Working" value={s.online} tone="ok"/><Stat label="Offline" value={s.offline} tone={s.offline?'danger':undefined}/><Stat label="Offline screen" value={s.placeholder} tone={s.placeholder?'danger':undefined}/><Stat label="Not checked" value={s.unchecked}/></div>
        <p className="muted small" role="status">{busy?`Checking · ${data!.checking} in progress, ${s.due} waiting`:s.lastChecked?`Last check ${date(s.lastChecked)}`:'No checks yet'}{s.confirming?` · ${plural(s.confirming,'failure')} awaiting a recheck`:''}{s.hidden?` · ${plural(s.hidden,'channel')} hidden for failing`:''}{s.slates?` · ${plural(s.slates,'marked offline screen')}`:''}</p>
        {s.lastChecked&&(!s.lastOnline||s.lastOnline<Date.now()-12*3600000)&&<div className="notice"><span>No channel from this provider has played in the last 12 hours, so failures are not being applied. The provider may be down or refusing this server.</span></div>}
      </Card>
      <Card title="Check settings">
        <form className="form-stack" onSubmit={e=>{e.preventDefault();setSaved(false);void mutation.run(async()=>{await api(`/admin/iptv/sources/${source.id}/health`,'PUT',{intervalHours:interval,hideFailing:hide});setSaved(true);});}}>
          <Switch label="Hide channels that fail checks" description="Off keeps them listed, still checked." checked={hide} onChange={v=>{setHide(v);setSaved(false);}}/>
          <div className="form-columns">
            <label>Check every (hours)<input type="number" min="0" max="168" required value={interval} onChange={e=>{setInterval(Number(e.target.value));setSaved(false);}}/><small>0 = manual only</small></label>
          </div>
          <div className="button-row"><button className="primary" disabled={mutation.busy}>Save check settings</button>{s.slates>0&&<button type="button" disabled={mutation.busy} onClick={()=>void mutation.run(()=>api(`/admin/iptv/sources/${source.id}/health/slates`,'DELETE',{}))}>Forget offline screens</button>}{saved&&<span className="success" role="status">Saved.</span>}</div>
        </form>
      </Card>
    </>}
  </>;
}
type SportsView={policy:{enabled:boolean;leadMinutes:number};lastSync:number|null;lastError:string|null;events:number;summary:{matched:number;airing:number};channels:{channelId:string;name:string;title:string;league:string;start:number;end:number;state:string|null;matchedBy:string;airing:boolean}[]};
const matchedBy:Record<string,string>={event:'Channel name',epg_event:'Guide listing',name_time:'Time in channel name',epg:'Guide listing only'};
function SportsPanel({source,changed}:{source:Source;changed:()=>void}) {
  const sports=useApi<SportsView>(`/admin/iptv/sources/${source.id}/sports`),data=sports.data,[enabled,setEnabled]=useState(false),[lead,setLead]=useState(30),[saved,setSaved]=useState(false),mutation=useMutation(()=>{sports.reload();changed();});
  useEffect(()=>{if(data){setEnabled(data.policy.enabled);setLead(data.policy.leadMinutes);}},[data?.policy.enabled,data?.policy.leadMinutes]);
  // Windows open and close with the clock, so keep the list current while the panel is open.
  useEffect(()=>{if(!data?.policy.enabled)return;const timer=window.setInterval(sports.reload,60000);return()=>window.clearInterval(timer);},[data?.policy.enabled]);
  if(sports.loading&&!data)return <Loading/>;
  if(sports.error)return <ErrorNotice message={sports.error.message} retry={sports.reload}/>;
  if(!data)return null;
  return <>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    <Card title="Sports events" description="Channels list only while their matched event is live or starting soon.">
      <form className="form-stack" onSubmit={e=>{e.preventDefault();setSaved(false);void mutation.run(async()=>{await api(`/admin/iptv/sources/${source.id}/sports`,'PUT',{enabled,leadMinutes:lead});setSaved(true);});}}>
        <Switch label="Use sports events for this source" checked={enabled} onChange={v=>{setEnabled(v);setSaved(false);}}/>
        <label className="narrow">List before the start (minutes)<input type="number" min="0" max="720" required value={lead} disabled={!enabled} onChange={e=>{setLead(Number(e.target.value));setSaved(false);}}/><small>Stays 15 min after the end.</small></label>
        <div className="button-row"><button className="primary" disabled={mutation.busy}>Save sports settings</button>{saved&&<span className="success" role="status">Saved.</span>}</div>
      </form>
    </Card>
    {data.policy.enabled&&<Card title="Matched events">
      <div className="stat-grid"><Stat label="Airing now" value={data.summary.airing} tone={data.summary.airing?'ok':undefined}/><Stat label="Matched channels" value={data.summary.matched}/><Stat label="Scheduled events" value={data.events}/><Stat label="Schedule updated" value={<span className="stat-small">{date(data.lastSync)}</span>}/></div>
      {data.lastError&&<p className="muted small">Last schedule request failed: {code(data.lastError)}. It is retried automatically.</p>}
      {!data.channels.length?<Empty title="No channels matched yet">{data.lastSync?'No channel names a game or event scheduled from yesterday through the next two days.':'The first schedule download runs within a minute.'}</Empty>:<div className="table-scroll"><table><thead><tr><th>Channel</th><th>Event</th><th>When</th><th>Status</th></tr></thead><tbody>{data.channels.map(c=><tr key={c.channelId}><td><strong>{c.name}</strong><small>Matched by {matchedBy[c.matchedBy]??c.matchedBy}</small></td><td>{c.title}{c.league&&<small>{c.league}</small>}</td><td>{date(c.start)}<small>until {date(c.end)}</small></td><td><span className={`badge ${c.airing?'ok':''}`}>{c.airing?(c.state==='in'?'Live':'Showing'):c.start>Date.now()?'Upcoming':'Ended'}</span></td></tr>)}</tbody></table></div>}
    </Card>}
  </>;
}
function ChannelHealthDialog({channel,health,onClose,changed}:{channel:Channel;health?:Health;onClose:()=>void;changed:()=>void}) {
  const mutation=useMutation(changed),[result,setResult]=useState('');
  return <Modal title="Channel check" onClose={onClose}><h2>{channel.name}</h2>
    {health?.thumbnail?<img className="health-thumb" src={`/api/v1/admin/iptv/channels/${channel.id}/health/thumbnail?at=${health.checkedAt??0}`} alt={`Picture captured from ${channel.name} during its last check`}/>:<Empty title="No picture captured">{health?.checkedAt?'The last check did not receive a video frame.':'Run a check to capture a picture from this channel.'}</Empty>}
    <div className="health-cell"><HealthBadge health={health}/></div>
    {health?.video&&<p className="muted small">{health.video.codec.toUpperCase()}{health.video.width?` · ${health.video.width}×${health.video.height}`:''}{health.still&&health.status==='online'?' · still picture, kept because it has sound':''}</p>}
    {mutation.error&&<ErrorNotice message={mutation.error}/>}{result&&<p role="status" className="success">{result}</p>}
    <div className="button-row">
      <button className="primary" disabled={mutation.busy||health?.checking} onClick={()=>void mutation.run(async()=>{await api(`/admin/iptv/channels/${channel.id}/health/check`,'POST',{});setResult('Check queued. This list updates when it finishes.');})}>Check now</button>
      {health?.fingerprint&&health.reason!=='KNOWN_SLATE'&&<button disabled={mutation.busy} onClick={()=>void mutation.run(async()=>{const r=await api<{matched:number}>(`/admin/iptv/channels/${channel.id}/health/slate`,'POST',{});setResult(`Marked as an offline screen. ${r.matched} channel${r.matched===1?' matches':'s match'} it and ${r.matched===1?'is':'are'} hidden.`);})}>This is an offline screen</button>}
    </div>
    <p className="muted small">Marking an offline screen hides every channel showing it.</p>
  </Modal>;
}
function RemoveSource({source,sources,changed,removed,onClose}:{source:Source;sources:Source[];changed:()=>void;removed:()=>void;onClose:()=>void}) {
  const mutation=useMutation(changed),guide=source.kind==='xmltv',linked=sources.filter(s=>s.feedId===source.id);
  return <Modal title={guide?'Remove EPG':'Remove M3U source'} onClose={()=>{if(!mutation.busy)onClose();}}>
    <h2>Remove {source.name}?</h2>
    <p>{guide?'This removes the EPG, its saved listings and channel mappings. Linked channels stay available without this guide.':'This removes the M3U source and all its channels, favorites, guide mappings and reserved channel numbers. Its EPG is also removed unless another source uses it.'}</p>
    {guide&&linked.length>0&&<p className="muted">This EPG will be unlinked from: {linked.map(s=>s.name).join(', ')}.</p>}
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    <form onSubmit={e=>{e.preventDefault();void mutation.run(async()=>{await api(`/admin/iptv/sources/${source.id}`,'DELETE',{expectedRevision:source.revision});removed();});}}>
      <div className="button-row"><button className="danger" type="submit" disabled={mutation.busy}>{mutation.busy?'Removing…':guide?'Remove EPG':'Remove M3U source'}</button><button type="button" disabled={mutation.busy} onClick={onClose} autoFocus>Cancel</button></div>
    </form>
  </Modal>;
}
function GuidePanel({source,guide,changed}:{source:Source;guide?:Source;changed:()=>void}) {
  const [url,setUrl]=useState(''),[headers,setHeaders]=useState(''),[insecure,setInsecure]=useState(false),[interval,setInterval]=useState(guide?.intervalHours??6),[remove,setRemove]=useState(false),[saved,setSaved]=useState(false);
  const mutation=useMutation(changed),busy=mutation.busy||!!guide?.running;
  useEffect(()=>{setInterval(guide?.intervalHours??6);},[guide?.id,guide?.intervalHours]);
  useEffect(()=>{if(!guide?.running)return;const timer=window.setInterval(changed,3000);return()=>window.clearInterval(timer);},[guide?.running]);
  return <>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}{saved&&<p className="success" role="status">EPG saved.</p>}
    {guide?<Card title="Program guide (EPG)" description="Channels with matching XMLTV IDs get listings automatically." actions={<><button disabled={busy||!guide.remote} onClick={()=>{setSaved(false);void mutation.run(()=>api(`/admin/iptv/sources/${guide.id}/refresh`,'POST',{}));}}>{guide.running?'Refreshing…':'Refresh EPG'}</button><button className="danger" disabled={busy} onClick={()=>setRemove(true)}>Remove EPG</button></>}>
      <div className="stat-grid"><Stat label="Status" value={<span className="stat-small">{guide.lastError?code(guide.lastError):guide.lastSuccess?'Up to date':'Awaiting import'}</span>} tone={guide.lastError?'danger':guide.lastSuccess?'ok':undefined}/><Stat label="Last import" value={<span className="stat-small">{date(guide.lastSuccess)}</span>}/><Stat label="Next refresh" value={<span className="stat-small">{guide.remote?date(guide.nextDue):'Manual upload'}</span>}/></div>
    </Card>:<Card title="Program guide (EPG)" description="Channels with matching XMLTV IDs get listings automatically."/>}
    <Card title={guide?'Guide settings':'Add an EPG'}>
      <form className="form-stack" onSubmit={e=>{e.preventDefault();setSaved(false);void mutation.run(async()=>{
        if(!url.trim()&&(headers.trim()||insecure))throw new Error('Enter the EPG URL to replace its provider request options.');
        let requestHeaders:unknown={};
        if(headers.trim()){try{requestHeaders=JSON.parse(headers);}catch{throw new Error('Headers must be a JSON object.');}}
        const result=await api<{source:Source;guide:Source}>(`/admin/iptv/sources/${source.id}/guide`,'PUT',{expectedRevision:source.revision,intervalHours:interval,...(url.trim()?{endpoint:{url:url.trim(),headers:requestHeaders,allowInsecureHttp:insecure}}:{})});
        setUrl('');setHeaders('');setInsecure(false);
        if(result.guide.remote)try{await api(`/admin/iptv/sources/${result.guide.id}/refresh`,'POST',{});}catch{throw new Error('The EPG was saved for this source, but its import failed. Use Refresh EPG to retry, or enter a replacement EPG URL.');}
        setSaved(true);
      });}}>
        <label>{guide?'Replacement EPG URL':'EPG URL'}<input type="url" value={url} onChange={e=>setUrl(e.target.value)} required={!guide} disabled={busy} autoComplete="off" spellCheck={false} placeholder="https://provider.example/guide.xml.gz"/><small>{guide?'Blank keeps the current guide · ':''}XML or .gz</small></label>
        <label className="narrow">Refresh every (hours)<input type="number" min="1" max="168" required value={interval} disabled={busy} onChange={e=>setInterval(Number(e.target.value))}/></label>
        <details><summary>Provider request options</summary><div className="form-stack"><label>Request headers (JSON)<textarea value={headers} disabled={busy} onChange={e=>setHeaders(e.target.value)} autoComplete="off" placeholder={'{"User-Agent":"tk.box"}'}/></label><label className="checkbox-label"><input type="checkbox" checked={insecure} disabled={busy} onChange={e=>setInsecure(e.target.checked)}/>This provider requires unencrypted HTTP</label></div></details>
        {guide&&!guide.remote&&<label>Replacement guide file<input type="file" accept=".xml" disabled={busy} onChange={e=>{const input=e.currentTarget,file=input.files?.[0];if(file)void mutation.run(async()=>{
          if(file.size>16*1024*1024)throw new Error('File exceeds the 16 MiB import limit.');
          const text=await file.text(),result=await api<{guide:Source}>(`/admin/iptv/sources/${source.id}/guide`,'PUT',{expectedRevision:source.revision,intervalHours:interval});
          await api(`/admin/iptv/sources/${result.guide.id}/upload`,'POST',{expectedRevision:result.guide.revision,text});input.value='';
        });}}/></label>}
        <div className="button-row"><button className="primary" disabled={busy}>{mutation.busy?'Saving EPG…':guide?'Save EPG':'Add EPG'}</button></div>
      </form>
    </Card>
    {remove&&<Modal title="Remove source EPG" onClose={()=>{if(!mutation.busy)setRemove(false);}}><h2>Remove the EPG from {source.name}?</h2><p>Channels stay available without listings, unless this source requires guide data.</p><div className="button-row"><button className="danger" disabled={mutation.busy} onClick={()=>void mutation.run(async()=>{await api(`/admin/iptv/sources/${source.id}/guide`,'DELETE',{expectedRevision:source.revision});setRemove(false);setSaved(false);})}>Remove EPG</button><button disabled={mutation.busy} onClick={()=>setRemove(false)}>Cancel</button></div>{mutation.error&&<ErrorNotice message={mutation.error}/>}</Modal>}
  </>;
}

// Listing rules: channels list themselves. There is no approval step, only these rules and per-channel overrides.
const lookAhead=[0,1,2,3,6,12,24];
function ListingPanel({source,hasGuide,changed}:{source:Source;hasGuide:boolean;changed:()=>void}) {
  const view=useApi<ListingView>(`/admin/iptv/sources/${source.id}/listing`),data=view.data,[draft,setDraft]=useState<ListingPolicy>(),[saved,setSaved]=useState(false);
  const mutation=useMutation(()=>{view.reload();changed();}),groupMutation=useMutation(()=>{view.reload();changed();});
  useEffect(()=>{if(data)setDraft(data.policy);},[data?.policy.requireCheck,data?.policy.requireGuide,data?.policy.guideHours,data?.policy.alwaysOn.join('\n')]);
  const sports=useApi<SportsView>(`/admin/iptv/sources/${source.id}/sports`),sportsOn=!!sports.data?.policy.enabled;
  if(view.loading&&!data)return <Loading/>;
  if(view.error)return <ErrorNotice message={view.error.message} retry={view.reload}/>;
  if(!data||!draft)return null;
  const set=(patch:Partial<ListingPolicy>)=>{setSaved(false);setDraft(d=>d&&{...d,...patch});};
  const dirty=JSON.stringify(draft)!==JSON.stringify(data.policy);
  const saveGroup=(group:Group,patch:Partial<Pick<Group,'mode'|'guideExempt'>>)=>void groupMutation.run(()=>api(`/admin/iptv/sources/${source.id}/groups`,'PUT',{expectedRevision:source.revision,name:group.name,mode:group.mode,guideExempt:group.guideExempt,...patch}));
  return <>
    <Card title="Listing rules" description="Channels list automatically when they meet these rules.">
      {mutation.error&&<ErrorNotice message={mutation.error}/>}
      <form className="form-stack" onSubmit={e=>{e.preventDefault();setSaved(false);void mutation.run(async()=>{await api(`/admin/iptv/sources/${source.id}/listing`,'PUT',{expectedRevision:source.revision,...draft});setSaved(true);});}}>
        <Switch label="Wait for a passing check" description="Unlisted until a check sees them play." checked={draft.requireCheck} onChange={v=>set({requireCheck:v})}/>
        <Switch label="Only list channels with guide data" description={<>Only while a program is airing or starting soon. {!hasGuide&&<strong className="warning-text">No EPG yet: this unlists regular channels.</strong>}</>} checked={draft.requireGuide} onChange={v=>set({requireGuide:v})}/>
        {draft.requireGuide&&<div className="nested">
          <label className="narrow">Look ahead<select value={draft.guideHours} onChange={e=>set({guideHours:Number(e.target.value)})}>{lookAhead.map(h=><option key={h} value={h}>{h===0?'Only what is airing now':`Airing now or within ${plural(h,'hour')}`}</option>)}</select></label>
          <div className="field"><span>Always-on keywords</span><Keywords value={draft.alwaysOn} onChange={v=>set({alwaysOn:v})}/><small>Matching channels never need guide data.</small></div>
        </div>}
        <div className="button-row"><button className="primary" disabled={mutation.busy||!dirty}>Save listing rules</button>{dirty&&<button type="button" onClick={()=>setDraft(data.policy)}>Discard changes</button>}{saved&&<span className="success" role="status">Saved. The lineup has been updated.</span>}</div>
      </form>
    </Card>
    <Card title="Categories" description={sportsOn?undefined:'Turn on sports events to use event categories.'}>
      {groupMutation.error&&<ErrorNotice message={groupMutation.error}/>}
      {!data.groups.length?<Empty title="No categories yet">Import the playlist to see its categories.</Empty>:<div className="table-scroll"><table className="groups-table"><thead><tr><th>Category</th><th>Listed</th><th>Rules</th><th>Needs guide data</th></tr></thead><tbody>{data.groups.map(g=><tr key={g.name}>
        <td><strong>{g.name||'Uncategorized'}</strong><small>{plural(g.channels,'channel')}</small></td>
        <td><span className="meter" aria-label={`${g.listed} of ${g.channels} listed`}><span style={{width:`${g.channels?g.listed/g.channels*100:0}%`}}/></span><small>{g.listed} of {g.channels}</small></td>
        <td><select aria-label={`Rules for ${g.name||'Uncategorized'}`} value={g.mode} disabled={groupMutation.busy||!sportsOn} onChange={e=>saveGroup(g,{mode:e.target.value as Group['mode']})}><option value="auto">Automatic · {g.detected==='events'?'events':'regular'}</option><option value="regular">Regular channels</option><option value="events">Event channels</option></select></td>
        <td>{g.events?<span className="muted small">Events · not needed</span>:<input type="checkbox" role="switch" className="switch" aria-label={`${g.name||'Uncategorized'} needs guide data`} checked={!g.guideExempt} disabled={groupMutation.busy} onChange={e=>saveGroup(g,{guideExempt:!e.target.checked})}/>}</td>
      </tr>)}</tbody></table></div>}
      {!draft.requireGuide&&data.groups.length>0&&<p className="muted small">Guide data is only required while that rule is on.</p>}
    </Card>
  </>;
}

const filters:[string,string,(c:Channel)=>boolean][]=[['all','All channels',()=>true],['listed','Listed',c=>c.state==='listed'||c.state==='always'],['unlisted','Not listed',c=>unlisted.includes(c.state)],
  ...(Object.keys(states) as ListingState[]).map(s=>[s,states[s].label,(c:Channel)=>c.state===s] as [string,string,(c:Channel)=>boolean])];
const PAGE=100;
function ChannelsPanel({source,channels,health,filter,setFilter,changed}:{source:Source;channels:ReturnType<typeof useApi<ChannelsView>>;health:Record<string,Health>;filter:string;setFilter:(f:string)=>void;changed:()=>void}) {
  const [search,setSearch]=useState(''),[selected,setSelected]=useState<string[]>([]),[shown,setShown]=useState(PAGE),[mapping,setMapping]=useState<Channel>(),[edit,setEdit]=useState<Channel>(),[identity,setIdentity]=useState<Channel>(),[inspect,setInspect]=useState<Channel>(),[notice,setNotice]=useState('');
  const mutation=useMutation(changed);
  useEffect(()=>{setSelected([]);},[source.revision]);
  useEffect(()=>{setNotice('');},[selected]);
  useEffect(()=>{setShown(PAGE);},[filter,search]);
  const entries=channels.data?.channels??[],match=filters.find(f=>f[0]===filter)?.[2]??(()=>true),q=search.toLocaleLowerCase();
  const filtered=entries.filter(c=>match(c)&&(!q||[c.name,c.tvgId,c.group,String(c.number??'')].some(v=>v.toLocaleLowerCase().includes(q))));
  const visible=filtered.slice(0,shown),selectable=filtered.slice(0,500).map(c=>c.id),stackSize=new Map<string,number>();
  for(const c of entries)stackSize.set(c.stackKey,(stackSize.get(c.stackKey)??0)+1);
  // Hidden channels are never checked, so the count can be lower than the selection.
  const check=()=>void mutation.run(async()=>{const r=await api<{queued:number}>(`/admin/iptv/sources/${source.id}/health/check-channels`,'POST',{ids:selected});setNotice(r.queued?`${r.queued} check${r.queued===1?'':'s'} queued. This list updates as they finish.${r.queued<selected.length?' Hidden channels are not checked.':''}`:'Hidden channels are not checked.');});
  const bulk=(listing:Listing)=>void mutation.run(()=>api(`/admin/iptv/sources/${source.id}/channels/listing`,'POST',{expectedRevision:source.revision,ids:selected,listing}));
  return <>
    <div className="channel-toolbar">
      <label className="search-field"><Icon name="search" size={16}/><input aria-label="Find a channel" placeholder="Find by name, provider ID or category" value={search} maxLength={120} onChange={e=>{setSearch(e.target.value);setSelected([]);}}/></label>
      <select aria-label="Show channels" value={filter} onChange={e=>{setFilter(e.target.value);setSelected([]);}}>{filters.map(([f,label,test])=>{const n=entries.filter(test).length;return (f==='all'||n>0||f===filter)&&<option key={f} value={f}>{label} · {n}</option>;})}</select>
    </div>
    {selected.length>0&&<div className="bulk-bar" role="region" aria-label="Selected channels"><strong>{selected.length} selected</strong><div className="button-row"><button disabled={mutation.busy} onClick={check}>Check now</button><button disabled={mutation.busy} onClick={()=>bulk('auto')}>List automatically</button><button disabled={mutation.busy} onClick={()=>bulk('always')}>Always list</button><button disabled={mutation.busy} onClick={()=>bulk('hidden')}>Hide</button><button className="text-button" onClick={()=>setSelected([])}>Clear</button></div>{notice&&<p role="status" className="success">{notice}</p>}</div>}
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    {channels.loading&&!channels.data?<Loading/>:channels.error?<ErrorNotice message={channels.error.message} retry={channels.reload}/>:!filtered.length?<Empty title="No channels in this view">{entries.length?'Try another filter or search.':'Import a playlist to see its channels.'}</Empty>:<>
      <div className="table-scroll"><table className="channel-table"><thead><tr><th className="selection-cell"><input type="checkbox" aria-label={`Select ${selectable.length===filtered.length?'all':'the first 500'} channels in this view`} disabled={mutation.busy} checked={selectable.length>0&&selectable.every(id=>selected.includes(id))} onChange={e=>setSelected(e.target.checked?selectable:[])}/></th><th>Channel</th><th>Listing</th><th>Check</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{visible.map(c=><tr key={c.id} className={selected.includes(c.id)?'selected':''}>
        <td className="selection-cell"><input type="checkbox" aria-label={`Select ${c.name}`} disabled={mutation.busy||selected.length>=500&&!selected.includes(c.id)} checked={selected.includes(c.id)} onChange={e=>{const checked=e.target.checked;setSelected(ids=>checked?[...ids,c.id]:ids.filter(id=>id!==c.id));}}/></td>
        <td><strong>{c.name}</strong><small>{[c.group||'Uncategorized',c.tvgId||'No provider ID',c.quality,c.event?'Event channel':undefined,(stackSize.get(c.stackKey)??0)>1&&!c.stackKey.startsWith('solo:')?`Stack · ${stackSize.get(c.stackKey)} feeds`:undefined].filter(Boolean).join(' · ')}</small>{c.missingSince&&<small>Missing since {date(c.missingSince)}</small>}</td>
        <td><StateBadge channel={c}/>{c.listing!=='auto'&&c.state!=='hidden'&&c.state!=='always'&&<small>Set to {c.listing==='always'?'always list':'hidden'}</small>}</td>
        <td className="health-cell">{c.present&&!c.conflict&&c.listing!=='hidden'?<HealthBadge health={health[c.id]}/>:<span className="muted small">—</span>}</td>
        <td><div className="row-actions">{c.conflict&&c.present&&<button disabled={mutation.busy} onClick={()=>setIdentity(c)}>Review identity</button>}<button onClick={()=>setEdit(c)}>Edit</button><button disabled={c.conflict||!source.feedId} title={source.feedId?undefined:'Add an EPG first'} onClick={()=>setMapping(c)}>Guide</button>{c.present&&!c.conflict&&c.listing!=='hidden'&&<button onClick={()=>setInspect(c)}>Check</button>}</div></td>
      </tr>)}</tbody></table></div>
      <div className="list-footer"><span className="muted small">Showing {visible.length} of {filtered.length}</span>{shown<filtered.length&&<button onClick={()=>setShown(n=>n+PAGE)}>Show {Math.min(PAGE,filtered.length-shown)} more</button>}</div>
    </>}
    {mapping&&<Mapping source={source} channel={mapping} changed={changed} onClose={()=>setMapping(undefined)}/>}
    {identity&&<IdentityReview channel={identity} changed={changed} onClose={()=>setIdentity(undefined)}/>}
    {inspect&&<ChannelHealthDialog channel={inspect} health={health[inspect.id]} changed={changed} onClose={()=>setInspect(undefined)}/>}
    {edit&&<EditChannel source={source} channel={edit} changed={changed} onClose={()=>setEdit(undefined)}/>}
  </>;
}
function OverviewPanel({source,guide,summary,total,openChannels,openTab,review}:{source:Source;guide?:Source;summary:Summary;total:number;openChannels:(filter:string)=>void;openTab:(tab:string)=>void;review:()=>void}) {
  const waiting=unlisted.reduce((n,s)=>n+(summary[s]??0),0);
  return <>
    {source.candidateDigest&&<div className="notice"><span>A substantial lineup change is waiting for review. Your current lineup stays active until you apply it.</span><button onClick={review}>Review changes</button></div>}
    <div className="stat-grid">
      <button className="stat-button" onClick={()=>openChannels('listed')}><Stat label="Listed" value={listedCount(summary)} tone="ok" hint={`of ${plural(total,'channel')}`}/></button>
      <button className="stat-button" onClick={()=>openChannels('unlisted')}><Stat label="Not listed" value={waiting} hint="by the rules"/></button>
      <button className="stat-button" onClick={()=>openChannels('hidden')}><Stat label="Hidden" value={summary.hidden??0} hint="by you"/></button>
      <button className="stat-button" onClick={()=>openChannels('missing')}><Stat label="Missing" value={summary.missing??0} hint="from the playlist"/></button>
    </div>
    <Card title="Not listed" actions={<button onClick={()=>openTab('listing')}>Listing rules</button>}>
      {waiting?<ul className="reason-list">{unlisted.filter(s=>summary[s]).map(s=><li key={s}><button onClick={()=>openChannels(s)}><span className={`badge ${states[s].tone}`}>{states[s].label}</span><span className="muted small grow">{states[s].detail}</span><strong>{summary[s]}</strong><Icon name="next" size={16}/></button></li>)}</ul>:<p className="muted small">{total?'Every channel the rules allow is listed.':'No channels imported yet.'}</p>}
    </Card>
    <Card title="Imports">
      <dl className="detail-grid">
        <div><dt>Status</dt><dd><span className={`dot-label ${source.lastError?'danger':source.lastSuccess?'ok':''}`}>{source.lastError?code(source.lastError):source.lastSuccess?'Up to date':'Awaiting import'}</span></dd></div>
        <div><dt>Last successful import</dt><dd>{date(source.lastSuccess)}</dd></div>
        <div><dt>Next refresh</dt><dd>{source.remote?date(source.nextDue):'Manual upload'}</dd></div>
        <div><dt>Program guide</dt><dd><button className="link-button" onClick={()=>openTab('guide')}>{guide?guide.lastError?'Needs attention':guide.lastSuccess?`Imported ${date(guide.lastSuccess)}`:'Awaiting import':'Not added'}</button></dd></div>
      </dl>
    </Card>
  </>;
}
function ConnectionPanel({source,sources,changed,removed}:{source:Source;sources:Source[];changed:()=>void;removed:()=>void}) {
  const [interval,setInterval]=useState(source.intervalHours),[replacement,setReplacement]=useState(''),[insecure,setInsecure]=useState(false),[providerHeaders,setProviderHeaders]=useState(''),[remove,setRemove]=useState(false),[saved,setSaved]=useState('');
  const [lan,setLan]=useState(source.allowPrivateStreams),mutation=useMutation(changed);
  useEffect(()=>{setInterval(source.intervalHours);setLan(source.allowPrivateStreams);},[source.revision]);
  return <>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}{saved&&<p className="success" role="status">{saved}</p>}
    <Card title="Refresh">
      <form className="inline-form" onSubmit={e=>{e.preventDefault();setSaved('');void mutation.run(async()=>{await api(`/admin/iptv/sources/${source.id}`,'PATCH',{expectedRevision:source.revision,intervalHours:interval});setSaved('Refresh interval saved.');});}}>
        <label>Refresh the playlist every (hours)<input type="number" min="1" max="168" required value={interval} disabled={!source.remote} onChange={e=>setInterval(Number(e.target.value))}/>{!source.remote&&<small>Uploaded playlists don’t refresh.</small>}</label>
        <button disabled={mutation.busy||!source.remote}>Save</button>
      </form>
    </Card>
    <Card title="Local network streams" description="Channels play only from internet addresses, so a playlist can’t point tk.box at devices on your network. Allow it for a tuner or server on your own network, such as an HDHomeRun.">
      <form className="inline-form" onSubmit={e=>{e.preventDefault();setSaved('');void mutation.run(async()=>{await api(`/admin/iptv/sources/${source.id}`,'PATCH',{expectedRevision:source.revision,intervalHours:source.intervalHours,allowPrivateStreams:lan});setSaved(lan?'Local network streams allowed.':'Local network streams blocked.');});}}>
        <label className="checkbox-label"><input type="checkbox" checked={lan} onChange={e=>setLan(e.target.checked)}/>Allow streams on my local network</label>
        <button disabled={mutation.busy||lan===source.allowPrivateStreams}>Save</button>
      </form>
    </Card>
    {source.remote?<Card title="Playlist URL" description="Channels, numbers and favorites are kept.">
      <form className="form-stack" onSubmit={e=>{e.preventDefault();setSaved('');void mutation.run(async()=>{let headers:unknown={};try{headers=providerHeaders.trim()?JSON.parse(providerHeaders):{};}catch{throw new Error('Headers must be a JSON object.');}await api(`/admin/iptv/sources/${source.id}/endpoint`,'PUT',{expectedRevision:source.revision,endpoint:{url:replacement,headers,allowInsecureHttp:insecure}});setReplacement('');setProviderHeaders('');setSaved('Playlist URL replaced. The next refresh uses it.');});}}>
        <label>New URL<input type="url" value={replacement} onChange={e=>setReplacement(e.target.value)} required autoComplete="off" spellCheck={false}/></label>
        <details><summary>Provider request options</summary><div className="form-stack"><label>Request headers (JSON)<textarea value={providerHeaders} onChange={e=>setProviderHeaders(e.target.value)} autoComplete="off"/></label><label className="checkbox-label"><input type="checkbox" checked={insecure} onChange={e=>setInsecure(e.target.checked)}/>This provider requires unencrypted HTTP</label></div></details>
        <div className="button-row"><button disabled={mutation.busy}>Replace URL</button></div>
      </form>
    </Card>:<Card title="Playlist file" description="Channels, numbers and favorites are kept.">
      <label>Choose a UTF-8 playlist<input type="file" accept=".m3u,.m3u8" disabled={mutation.busy} onChange={e=>{const input=e.currentTarget,file=input.files?.[0];if(file)void mutation.run(async()=>{if(file.size>16*1024*1024)throw new Error('File exceeds the 16 MiB import limit.');await api(`/admin/iptv/sources/${source.id}/upload`,'POST',{expectedRevision:source.revision,text:await file.text()});input.value='';setSaved('Playlist imported.');});}}/></label>
    </Card>}
    <Card title="Remove source" className="danger-zone" description="Deletes its channels, favorites and numbers." actions={<button className="danger" onClick={()=>setRemove(true)}>Remove source</button>}/>
    {remove&&<RemoveSource source={source} sources={sources} changed={changed} removed={removed} onClose={()=>setRemove(false)}/>}
  </>;
}
const sourceTabs=[['overview','Overview'],['channels','Channels'],['listing','Listing'],['guide','Guide'],['checks','Checks'],['sports','Sports'],['connection','Connection']] as const;
function SourceDetail({source,sources,changed,removed,back}:{source:Source;sources:Source[];changed:()=>void;removed:()=>void;back:()=>void}) {
  const [tab,setTabState]=useState(()=>remembered('sourceTab','overview')),[filter,setFilter]=useState('all'),[candidate,setCandidate]=useState(false);
  const setTab=(t:string)=>{setTabState(t);remember('sourceTab',t);};
  const channels=useApi<ChannelsView>(`/admin/iptv/sources/${source.id}/channels`),health=useApi<HealthView>(`/admin/iptv/sources/${source.id}/health`);
  // Follow running checks without hammering the server.
  const checking=!!health.data&&(health.data.checking>0||health.data.summary.due>0),confirming=!!health.data?.summary.confirming;
  useEffect(()=>{if(!checking&&!confirming)return;const timer=window.setInterval(()=>{health.reload();channels.reload();},checking?3000:10000);return()=>window.clearInterval(timer);},[checking,confirming]);
  useEffect(()=>{if(!source.running)return;const timer=window.setInterval(changed,3000);return()=>window.clearInterval(timer);},[source.running]);
  const refreshAll=()=>{changed();channels.reload();health.reload();};
  const mutation=useMutation(refreshAll),guide=sources.find(s=>s.id===source.feedId),summary=channels.data?.summary??{},total=(channels.data?.channels??[]).filter(c=>c.present).length;
  const openChannels=(f:string)=>{setFilter(f);setTab('channels');};
  return <section className="source-detail">
    <button className="back-link" onClick={back}><Icon name="back" size={16}/>All sources</button>
    <div className="source-head">
      <div className="source-title"><span className={`status-dot ${source.lastError?'danger':source.lastSuccess?'ok':''}`} aria-hidden="true"/><div><h2>{source.name}</h2><p className="muted small">{source.remote?`Remote playlist · refreshes every ${source.intervalHours}h`:'Uploaded playlist'} · {channels.data?`${listedCount(summary)} of ${plural(total,'channel')} listed`:'Loading channels…'}</p></div></div>
      {source.remote&&<div className="button-row"><button disabled={source.running||mutation.busy} onClick={()=>void mutation.run(()=>api(`/admin/iptv/sources/${source.id}/refresh`,'POST',{}))}><Icon name="restart" size={16}/>{source.running?'Refreshing…':'Refresh now'}</button></div>}
    </div>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    <div className="subtabs" role="tablist" aria-label={`${source.name} settings`}>{sourceTabs.map(([id,label])=><button key={id} role="tab" aria-selected={tab===id} onClick={()=>setTab(id)}>{label}{id==='channels'&&channels.data?<span className="count">{total}</span>:null}</button>)}</div>
    <div role="tabpanel" className="source-panel">
      {tab==='overview'&&<OverviewPanel source={source} guide={guide} summary={summary} total={total} openChannels={openChannels} openTab={setTab} review={()=>setCandidate(true)}/>}
      {tab==='channels'&&<ChannelsPanel source={source} channels={channels} health={health.data?.channels??{}} filter={filter} setFilter={setFilter} changed={refreshAll}/>}
      {tab==='listing'&&<ListingPanel source={source} hasGuide={!!guide} changed={refreshAll}/>}
      {tab==='guide'&&<GuidePanel source={source} guide={guide} changed={refreshAll}/>}
      {tab==='checks'&&<ChecksPanel source={source} health={health} changed={refreshAll}/>}
      {tab==='sports'&&<SportsPanel source={source} changed={refreshAll}/>}
      {tab==='connection'&&<ConnectionPanel source={source} sources={sources} changed={changed} removed={removed}/>}
    </div>
    {candidate&&<Candidate source={source} changed={refreshAll} onClose={()=>setCandidate(false)}/>}
  </section>;
}
type IptvSettingsView={revision:number;maxConnections:number;connections:{limit:number;viewers:number;checks:number}};
// Server-wide: shared by every source, viewer and channel check.
function IptvAppSettings() {
  const view=useApi<IptvSettingsView>('/admin/iptv/settings'),[max,setMax]=useState(1),[saved,setSaved]=useState(false),mutation=useMutation(view.reload),data=view.data;
  useEffect(()=>{if(data)setMax(data.maxConnections);},[data?.revision]);
  // Usage changes as people tune in; keep it current while the page is open.
  useEffect(()=>{const timer=window.setInterval(view.reload,10000);return()=>window.clearInterval(timer);},[]);
  if(view.loading&&!data)return <Loading/>;
  if(view.error&&!data)return <ErrorNotice message={view.error.message} retry={view.reload}/>;
  if(!data)return null;
  const used=data.connections.viewers+data.connections.checks,changed=max!==data.maxConnections;
  return <form className="setting-line" onSubmit={e=>{e.preventDefault();setSaved(false);void mutation.run(async()=>{await api('/admin/iptv/settings','PUT',{expectedRevision:data.revision,maxConnections:max});setSaved(true);});}}>
    <label htmlFor="iptv-max-connections" className="grow"><strong>Max connections</strong><small className="muted">{used} of {data.connections.limit} in use · shared by all sources</small></label>
    {mutation.error&&<span className="danger small">{mutation.error}</span>}{saved&&!changed&&<span role="status" className="success small">Saved</span>}
    {changed&&<button className="primary" disabled={mutation.busy}>Save</button>}
    <input id="iptv-max-connections" type="number" min="1" max="16" required value={max} onChange={e=>{setMax(Number(e.target.value));setSaved(false);}}/>
  </form>;
}
export function SourceSettings() {
  const drag=useDragOrder(),sources=useApi<{sources:Source[]}>('/admin/iptv/sources'),[selected,setSelected]=useState(()=>remembered('source','')),[create,setCreate]=useState(false),[importError,setImportError]=useState('');
  const choose=(id:string)=>{setSelected(id);remember('source',id);setImportError('');};
  const playlists=sources.data?.sources.filter(s=>s.kind==='m3u')??[],source=playlists.find(s=>s.id===selected),ordering=useMutation(sources.reload);
  // Saved right away: this is the order the Live TV guide groups channels in.
  const reorder=(from:number,to:number)=>void ordering.run(()=>api('/admin/iptv/sources/order','PUT',{ids:moveTo(playlists.map(s=>s.id),from,to)}));
  if(source)return <>{importError&&<ErrorNotice message={importError} dismiss={()=>setImportError('')}/>}<SourceDetail key={source.id} source={source} sources={sources.data!.sources} changed={sources.reload} removed={()=>choose('')} back={()=>choose('')}/></>;
  return <>
    <SectionHead title="IPTV"/>
    <IptvAppSettings/>
    <div className="section-heading"><div><h3>Sources</h3><p className="muted small">Live TV groups channels in this order.</p></div><button className="primary" onClick={()=>setCreate(true)}>Add source</button></div>
    {importError&&<ErrorNotice message={importError} dismiss={()=>setImportError('')}/>}{ordering.error&&<ErrorNotice message={ordering.error}/>}
    {sources.loading&&!sources.data?<Loading/>:sources.error?<ErrorNotice message={sources.error.message} retry={sources.reload}/>:playlists.length?<ul className="source-rows">{playlists.map((s,i)=>{const guide=sources.data!.sources.find(g=>g.id===s.feedId),attention=!!s.lastError||!!s.candidateDigest||!!guide?.lastError;return <li key={s.id} className="source-item" {...drag('sources',i,reorder,playlists.length>1&&!ordering.busy)}>{playlists.length>1&&<MoveButtons name={s.name} index={i} count={playlists.length} disabled={ordering.busy} onMove={to=>reorder(i,to)}/>}<button className="source-row" onClick={()=>choose(s.id)}>
      <span className={`status-dot ${attention?'danger':s.lastSuccess?'ok':''}`} aria-hidden="true"/>
      <span className="source-row-main"><strong>{s.name}</strong><small>{s.remote?`Remote · every ${s.intervalHours}h`:'File upload'} · {s.lastSuccess?`Imported ${date(s.lastSuccess)}`:'Waiting for import'}</small></span>
      <span className="source-row-tags">{s.candidateDigest&&<span className="badge warning">Review needed</span>}{s.lastError&&<span className="badge danger">{code(s.lastError)}</span>}<span className={`badge ${guide?guide.lastError?'danger':'ok':''}`}>{guide?guide.lastError?'EPG error':'EPG':'No EPG'}</span></span>
      <Icon name="next" size={18}/>
    </button></li>;})}</ul>:<Empty title="No sources yet">Add an M3U playlist to get started.</Empty>}
    {create&&<CreateSource changed={sources.reload} created={(s,error)=>{choose(s.id);setImportError(error);}} onClose={()=>setCreate(false)}/>}
  </>;
}
type CustomBuffer={bytes:number;maxBytesPerChannel:number;stations:number;delayedViewers:number;bufferedMs:number;storagePressure:boolean};
const size=(bytes:number)=>bytes>=1024**3?`${(bytes/1024**3).toFixed(1)} GB`:`${Math.round(bytes/1024**2)} MB`;
export function ServerPlaybackSettings() {
  const data=useApi<PlaybackSettings&{revision:number;activeVideoEncoders:number;customBuffer:CustomBuffer}>('/admin/settings/playback'),[limit,setLimit]=useState(2),[minutes,setMinutes]=useState(30),[saved,setSaved]=useState(false),mutation=useMutation(data.reload);
  useEffect(()=>{if(data.data){setLimit(data.data.maxConcurrentCpuVideoTranscodes);setMinutes(data.data.pauseRetentionMinutes);}},[data.data?.revision]);
  return <>{data.loading&&!data.data?<Loading/>:data.error?<ErrorNotice message={data.error.message} retry={data.reload}/>:data.data&&<Card title="Encoding & buffering">
      <form className="form-stack narrow" onSubmit={e=>{e.preventDefault();setSaved(false);void mutation.run(async()=>{await api('/admin/settings/playback','PATCH',{expectedRevision:data.data!.revision,maxConcurrentCpuVideoTranscodes:limit,pauseRetentionMinutes:minutes});setSaved(true);});}}>
        <label>Maximum concurrent CPU video encoders<input type="number" min="1" max="16" required value={limit} onChange={e=>setLimit(Number(e.target.value))}/><small>{data.data.activeVideoEncoders} active · Direct Play and remux don’t count</small></label>
        <label>Maximum pause retention (minutes)<input type="number" min="5" max="120" required value={minutes} onChange={e=>setMinutes(Number(e.target.value))}/><small>How far behind live a viewer can fall on Plex channels.</small></label>
        {minutes<data.data.pauseRetentionMinutes&&<div className="notice"><span>Applies now: anyone over {minutes} min behind live must Go Live.{data.data.customBuffer.delayedViewers>0&&` ${data.data.customBuffer.delayedViewers} viewer${data.data.customBuffer.delayedViewers===1?' is':'s are'} behind live right now.`}</span></div>}
        <dl className="detail-grid">
          <div><dt>Pause buffer in use</dt><dd>{data.data.customBuffer.stations?`${size(data.data.customBuffer.bytes)} across ${data.data.customBuffer.stations} channel${data.data.customBuffer.stations===1?'':'s'}`:'Nothing playing'}</dd></div>
          <div><dt>Longest buffered window</dt><dd>{data.data.customBuffer.bufferedMs?`${Math.floor(data.data.customBuffer.bufferedMs/60000)} min ${Math.floor(data.data.customBuffer.bufferedMs/1000)%60} s`:'—'}</dd></div>
          <div><dt>Viewers behind live</dt><dd>{data.data.customBuffer.delayedViewers}</dd></div>
          <div><dt>Disk cap per channel</dt><dd>{size(data.data.customBuffer.maxBytesPerChannel)}</dd></div>
        </dl>
        {data.data.customBuffer.storagePressure&&<div className="notice error"><span>Low disk space: Plex channels keep only about 90 seconds.</span></div>}
        {mutation.error&&<ErrorNotice message={mutation.error}/>}
        <div className="button-row"><button disabled={mutation.busy} className="primary">Save settings</button>{saved&&<span role="status" className="success">Saved.</span>}</div>
      </form>
    </Card>}</>;
}
type League={key:string;name:string;sport:string;configured:boolean;upcoming:number};
type SportsSettingsValue={leagueMode:'all'|'selected';leagues:string[];unscheduled:boolean;sportOrder:string[];leagueOrder:string[];placement:'top'|'bottom';numberStart:number|null};
type SportsSettingsView={settings:SportsSettingsValue&{revision:number};leagues:League[];lastSync:number|null;lastError:string|null};
const sportNames:Record<string,string>={football:'American football',basketball:'Basketball',baseball:'Baseball',hockey:'Hockey',soccer:'Soccer',mma:'MMA',boxing:'Boxing',wrestling:'Wrestling',racing:'Motorsport',golf:'Golf',tennis:'Tennis',rugby:'Rugby',cricket:'Cricket',cycling:'Cycling',darts:'Darts',curling:'Curling',sports:'Other sports'};
// Server-wide: which leagues event channels are shown for, the order sports and leagues appear in, and their numbers.
export function LiveSportsSettings() {
  const view=useApi<SportsSettingsView>('/admin/sports/settings'),[draft,setDraft]=useState<SportsSettingsValue>(),[saved,setSaved]=useState(false),[open,setOpen]=useState<string[]>([]),mutation=useMutation(view.reload),drag=useDragOrder();
  useEffect(()=>{if(view.data){const {revision:_,...value}=view.data.settings;setDraft(value);}},[view.data?.settings.revision]);
  const head=<SectionHead title="Live Sports"/>;
  if(view.loading&&!view.data)return <>{head}<Loading/></>;
  if(view.error)return <>{head}<ErrorNotice message={view.error.message} retry={view.reload}/></>;
  if(!view.data||!draft)return head;
  const data=view.data,selecting=draft.leagueMode==='selected';
  const set=(patch:Partial<SportsSettingsValue>)=>{setSaved(false);setDraft(d=>d&&{...d,...patch});};
  const rank=(l:League)=>{const i=draft.leagueOrder.indexOf(l.key);return i<0?draft.leagueOrder.length:i;};
  // Only shown leagues compete for a place, so when selecting they are listed first.
  const hidden=(l:League)=>Number(selecting&&!draft.leagues.includes(l.key));
  const leaguesOf=(sport:string)=>data.leagues.filter(l=>l.sport===sport).sort((a,b)=>hidden(a)-hidden(b)||rank(a)-rank(b)||a.name.localeCompare(b.name));
  // The order saved is the order on screen.
  const shownOrder=(sport?:string,moved?:string[])=>draft.sportOrder.flatMap(s=>s===sport&&moved?moved:leaguesOf(s).map(l=>l.key));
  const moveSport=(from:number,to:number)=>set({sportOrder:moveTo(draft.sportOrder,from,to)});
  const moveLeague=(sport:string)=>(from:number,to:number)=>set({leagueOrder:shownOrder(sport,moveTo(leaguesOf(sport).map(l=>l.key),from,to))});
  const choose=(keys:string[],on:boolean)=>set({leagues:on?[...new Set([...draft.leagues,...keys])]:draft.leagues.filter(k=>!keys.includes(k))});
  const toggle=(sport:string)=>setOpen(o=>o.includes(sport)?o.filter(s=>s!==sport):[...o,sport]);
  return <>{head}
    <p className="muted small" role="status">{data.lastSync?`Schedules last downloaded ${date(data.lastSync)}`:'Schedules download while a source uses sports events.'}{data.lastError?` · Last error: ${code(data.lastError)}`:''}</p>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    <form className="form-stack" onSubmit={e=>{e.preventDefault();void mutation.run(async()=>{await api('/admin/sports/settings','PUT',{expectedRevision:data.settings.revision,...draft,leagueOrder:shownOrder()});setSaved(true);});}}>
      <Card title="Leagues">
        <div className="toggle-group" role="radiogroup" aria-label="Leagues shown"><button type="button" role="radio" aria-checked={!selecting} onClick={()=>set({leagueMode:'all'})}>Every league</button><button type="button" role="radio" aria-checked={selecting} onClick={()=>set({leagueMode:'selected'})}>Only leagues I select</button></div>
        <Switch label="Also show channels with no scheduled game" checked={draft.unscheduled} onChange={v=>set({unscheduled:v})}/>
        {selecting&&!draft.leagues.length&&<div className="notice"><span>No leagues are selected.{draft.unscheduled?' Only channels with no scheduled game will show.':' No event channels will show.'}</span></div>}
      </Card>
      <Card title="Order" description="By sport, then league, then start time.">
        <ol className="sports-order">{draft.sportOrder.map((sport,i)=>{const leagues=leaguesOf(sport),on=leagues.filter(l=>draft.leagues.includes(l.key)).length,expanded=open.includes(sport)||(selecting&&leagues.length>0&&open.length===0&&i===0);return <li key={sport} className="sports-sport" {...drag('sports',i,moveSport)}>
          <div className="sports-row sports-sport-head"><span className="sports-rank">{i+1}</span>
            <button type="button" className="sports-expand" aria-expanded={expanded} disabled={!leagues.length} onClick={()=>toggle(sport)}><strong>{sportNames[sport]??sport}</strong><small className="muted">{leagues.length?(selecting?`${on} of ${leagues.length} shown`:plural(leagues.length,'league')):'Detected by name only'}</small></button>
            {selecting&&leagues.length>0&&<span className="button-row sports-bulk"><button type="button" onClick={()=>choose(leagues.map(l=>l.key),true)}>All</button><button type="button" onClick={()=>choose(leagues.map(l=>l.key),false)}>None</button></span>}
            <MoveButtons name={sportNames[sport]??sport} index={i} count={draft.sportOrder.length} onMove={to=>moveSport(i,to)}/></div>
          {expanded&&leagues.length>0&&<ol className="sports-leagues">{leagues.map((l,j)=><li key={l.key} className="sports-row" {...drag(`leagues:${sport}`,j,moveLeague(sport))}>
            {selecting?<label className="checkbox-label grow"><input type="checkbox" checked={draft.leagues.includes(l.key)} onChange={e=>choose([l.key],e.target.checked)}/>{l.name}</label>:<span className="grow">{l.name}</span>}
            <small className="muted">{l.upcoming?`${plural(l.upcoming,'game')} scheduled`:'No games scheduled'}{!l.configured&&' · not downloaded'}</small>
            <MoveButtons name={l.name} index={j} count={leagues.length} onMove={to=>moveLeague(sport)(j,to)}/>
          </li>)}</ol>}
        </li>;})}</ol>
      </Card>
      <Card title="Guide placement and numbers">
        <div className="form-columns">
          <label>Live events in the guide<select value={draft.placement} onChange={e=>set({placement:e.target.value as 'top'|'bottom'})}><option value="top">Above other channels</option><option value="bottom">Below other channels</option></select></label>
          {draft.numberStart!==null&&<label>Event numbers start at<input type="number" min="1" max="99999" required value={draft.numberStart} onChange={e=>set({numberStart:Number(e.target.value)})}/></label>}
        </div>
        <Switch label="Number event channels in their own block" description={draft.numberStart!==null?`Lowest free number from ${draft.numberStart} up.`:'Lowest free channel number.'} checked={draft.numberStart!==null} onChange={v=>set({numberStart:v?1000:null})}/>
      </Card>
      <div className="button-row sticky-actions"><button className="primary" disabled={mutation.busy}>Save Live Sports settings</button>{saved&&<span className="success" role="status">Saved. The lineup has been updated.</span>}</div>
    </form>
  </>;
}
