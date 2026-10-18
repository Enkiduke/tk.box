import {useEffect,useRef,useState} from 'react';
import type {Principal,PlaybackSettings} from '../../../packages/contracts/src/index.js';
import {api} from './api.js';
import {useApi} from './hooks.js';
import {Empty,ErrorNotice,Loading,Modal} from './components.js';

type Source={id:string;name:string;kind:'m3u'|'xmltv';revision:number;intervalHours:number;autoAddNewChannels:boolean;remote:boolean;lastAttempt:number|null;lastSuccess:number|null;nextDue:number|null;lastError:string|null;candidateDigest:string|null;running:boolean;feedId?:string};
type Channel={id:string;name:string;tvgId:string;group:string;stack:string|null;stackKey:string;quality:string|null;approval:'pending'|'approved'|'ignored';present:boolean;conflict:boolean;enabled:boolean;number:number|null;position:number|null;firstSeen:number;lastSeen:number;missingSince:number|null};
const date=(value:number|null)=>value===null?'—':new Intl.DateTimeFormat(undefined,{dateStyle:'short',timeStyle:'short'}).format(value);
function useMutation(changed:()=>void) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const lock=useRef(false);
  return {busy,error,run:async(action:()=>Promise<unknown>)=>{if(lock.current)return false;lock.current=true;setBusy(true);setError('');try{await action();changed();return true;}catch(e){setError((e as Error).message);changed();return false;}finally{lock.current=false;setBusy(false);}}};
}
function CreateSource({onClose,created,changed}:{onClose:()=>void;created:(source:Source,error:string)=>void;changed:()=>void}) {
  const [name,setName]=useState(''),[mode,setMode]=useState('remote'),[url,setUrl]=useState(''),[headers,setHeaders]=useState(''),[insecure,setInsecure]=useState(false),[file,setFile]=useState<File>(),[sports,setSports]=useState('auto');
  const mutation=useMutation(changed);
  return <Modal title="Add IPTV source" onClose={()=>{if(!mutation.busy)onClose();}}>
    <h2>Add a source</h2>
    <p className="muted">Import live channels from an M3U playlist. Add an EPG directly in this source’s settings after importing.</p>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    <form className="form-stack" onSubmit={e=>{e.preventDefault();void mutation.run(async()=>{
      let requestHeaders:Record<string,string>={};
      if(mode==='remote'&&headers.trim()){try{requestHeaders=JSON.parse(headers);}catch{throw new Error('Headers must be a JSON object.');}}
      if(mode==='upload'&&(!file||file.size>16*1024*1024))throw new Error('Choose a UTF-8 playlist no larger than 16 MiB.');
      const source=await api<Source>('/admin/iptv/sources','POST',{name,kind:'m3u',...(mode==='remote'?{endpoint:{url:url.trim(),headers:requestHeaders,allowInsecureHttp:insecure}}:{})});
      setUrl('');setHeaders('');
      let error='';
      try {
        // Set before the first import, so a sports playlist is never swept by channel checks.
        if(sports!=='auto')await api(`/admin/iptv/sources/${source.id}/sports`,'PUT',{enabled:sports==='events',leadMinutes:30});
        if(mode==='remote')await api(`/admin/iptv/sources/${source.id}/refresh`,'POST',{});
        else if(file)await api(`/admin/iptv/sources/${source.id}/upload`,'POST',{expectedRevision:source.revision,text:await file.text()});
      } catch {
        // Creation has succeeded. Show the saved source so retrying cannot create a duplicate.
        error=`The source was saved, but its first import failed. Check the source below and ${mode==='remote'?'use Refresh now to retry or replace its remote endpoint':'import a replacement file'}.`;
      }
      created(source,error);onClose();
    });}}>
      <label>Source name<input value={name} onChange={e=>setName(e.target.value)} required maxLength={120} autoFocus/></label>
      <label>Import from<select value={mode} onChange={e=>{setMode(e.target.value);setFile(undefined);}}><option value="remote">Remote URL</option><option value="upload">File upload</option></select></label>
      {mode==='remote'?<>
        <label>Source URL<input type="url" value={url} onChange={e=>setUrl(e.target.value)} required autoComplete="off" spellCheck={false} placeholder="https://provider.example/playlist"/></label>
        <details><summary>Provider request options</summary><label>Request headers (JSON)<textarea value={headers} onChange={e=>setHeaders(e.target.value)} autoComplete="off" placeholder={'{"User-Agent":"tk.box"}'}/></label><label className="checkbox-label"><input type="checkbox" checked={insecure} onChange={e=>setInsecure(e.target.checked)}/>This provider requires unencrypted HTTP</label></details>
        <p className="muted small">Credentials are stored encrypted and are never included in viewer responses.</p>
      </>:<label>Playlist file<input type="file" accept=".m3u,.m3u8" required onChange={e=>setFile(e.target.files?.[0])}/></label>}
      <label>Sports events<select value={sports} onChange={e=>setSports(e.target.value)}><option value="auto">Detect automatically</option><option value="events">Event playlist · show only live and starting-soon events</option><option value="regular">Regular channels</option></select><small>Event playlists (PPV, “Football Event 04”, dated matchups) are only checked and listed while an event is live or about to start.</small></label>
      <div className="button-row"><button className="primary" disabled={mutation.busy} type="submit">{mutation.busy?'Importing…':'Add source'}</button><button type="button" disabled={mutation.busy} onClick={onClose}>Cancel</button></div>
    </form>
  </Modal>;
}
function Candidate({source,onClose,changed}:{source:Source;onClose:()=>void;changed:()=>void}) {
  const candidate=useApi<{revision:number;digest:string;incoming:{name:string;tvgId:string}[];missing:{id:string;name:string;number:number|null}[]}>(`/admin/iptv/sources/${source.id}/candidate`),mutation=useMutation(changed);
  return <Modal title="Review source snapshot" onClose={onClose}><h2>Review a substantial lineup change</h2><p>The latest import would remove most of this source’s existing channels. Your current lineup is still active.</p>{candidate.loading?<Loading/>:candidate.error?<ErrorNotice message={candidate.error.message} retry={candidate.reload}/>:candidate.data&&<><div className="form-columns"><div><h3>Incoming · {candidate.data.incoming.length}</h3><ul className="review-list">{candidate.data.incoming.map((c,i)=><li key={i}>{c.name}<small>{c.tvgId||'No provider ID'}</small></li>)}</ul></div><div><h3>Will be hidden · {candidate.data.missing.length}</h3><ul className="review-list">{candidate.data.missing.map(c=><li key={c.id}>{c.number!==null?`${c.number} · `:''}{c.name}</li>)}</ul></div></div>{mutation.error&&<ErrorNotice message={mutation.error}/>}<button className="primary" disabled={mutation.busy} onClick={()=>void mutation.run(async()=>{await api(`/admin/iptv/sources/${source.id}/candidate/accept`,'POST',{expectedRevision:candidate.data!.revision,digest:candidate.data!.digest});onClose();})}>Apply this reviewed import</button></>}</Modal>;
}
function Mapping({source,channel,onClose}:{source:Source;channel:Channel;onClose:()=>void}) {
  type Review={mapping?:{xmlId:string;method:string};reviewRevision:number;candidates:{exactId?:string;suggestions:{xmlId:string;reason:string}[]}};
  const review=useApi<Review>(source.feedId?`/admin/iptv/channels/${channel.id}/mapping?feedId=${source.feedId}`:undefined),[xmlId,setXmlId]=useState(''),mutation=useMutation(review.reload);
  return <Modal title="Channel guide mapping" onClose={onClose}><h2>{channel.name}</h2>{!source.feedId?<Empty title="No guide linked">Add an EPG to this M3U source first.</Empty>:review.loading?<Loading/>:review.error?<ErrorNotice message={review.error.message} retry={review.reload}/>:review.data&&<><p>Current guide: <strong>{review.data.mapping?.xmlId??'No guide data'}</strong>{review.data.mapping&&` · ${review.data.mapping.method==='admin'?'Administrator approved':'Exact ID match'}`}</p>{review.data.candidates.suggestions.length>0&&<div><h3>Suggested matches</h3><p className="muted small">Suggestions are inactive until you explicitly approve a match.</p>{review.data.candidates.suggestions.map(c=><button key={c.xmlId} onClick={()=>setXmlId(c.xmlId)}>{c.xmlId}</button>)}</div>}<form className="form-stack" onSubmit={e=>{e.preventDefault();void mutation.run(()=>api(`/admin/iptv/channels/${channel.id}/mapping`,'POST',{feedId:source.feedId,xmlId,expectedRevision:review.data!.reviewRevision}));}}><label>XMLTV channel ID<input value={xmlId} onChange={e=>setXmlId(e.target.value)} required maxLength={1024}/></label>{mutation.error&&<ErrorNotice message={mutation.error}/>}<button className="primary" disabled={mutation.busy||!xmlId}>Approve mapping</button></form></>}</Modal>;
}
function EditChannel({source,channel,onClose,changed}:{source:Source;channel:Channel;onClose:()=>void;changed:()=>void}) {
  const [name,setName]=useState(channel.name),[number,setNumber]=useState(channel.number?.toString()??''),[position,setPosition]=useState(channel.position?.toString()??''),[enabled,setEnabled]=useState(channel.enabled),[providerName,setProviderName]=useState(false),mutation=useMutation(changed);
  const [stackMode,setStackMode]=useState(channel.stack===null?'auto':channel.stack===''?'separate':'custom'),[stack,setStack]=useState(channel.stack||'');
  return <Modal title="Edit channel" onClose={onClose}><h2>Edit {channel.name}</h2><form className="form-stack" onSubmit={e=>{e.preventDefault();void mutation.run(async()=>{await api(`/admin/iptv/channels/${channel.id}`,'PATCH',{expectedRevision:source.revision,enabled,displayName:providerName?null:name,stack:stackMode==='auto'?null:stackMode==='separate'?'':stack,...(number?{number:Number(number)}:{}),...(position?{position:Number(position)}:{})});onClose();});}}><label>Display name<input value={name} onChange={e=>setName(e.target.value)} required maxLength={200}/></label><label className="checkbox-label"><input type="checkbox" checked={providerName} onChange={e=>setProviderName(e.target.checked)}/>Use the provider’s name on future refreshes</label><div className="form-columns"><label>Channel number<input type="number" min="1" max="999999" value={number} onChange={e=>setNumber(e.target.value)}/></label><label>Lineup position<input type="number" min="0" max="999999" value={position} onChange={e=>setPosition(e.target.value)}/></label></div><div className="form-columns"><label>Feed stacking<select value={stackMode} onChange={e=>setStackMode(e.target.value)}><option value="auto">Automatic · by station name</option><option value="custom">Stack with a station</option><option value="separate">Keep as its own channel</option></select><small>{stackMode==='auto'?`Groups with other “${channel.stackKey.startsWith('solo:')?channel.name:channel.stackKey}” feeds. FHD, then HD, plays by default.`:stackMode==='separate'?'Never grouped with other feeds.':'Feeds with the same station name share one guide row.'}</small></label>{stackMode==='custom'&&<label>Station name<input value={stack} onChange={e=>setStack(e.target.value)} required maxLength={120} placeholder="CNN"/></label>}</div><label className="checkbox-label"><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/>Enabled for viewers</label>{mutation.error&&<ErrorNotice message={mutation.error}/>}<button disabled={mutation.busy} className="primary">Save channel</button></form></Modal>;
}
type Health={status:'unchecked'|'online'|'offline'|'placeholder';reason:string|null;checkedAt:number|null;lastOnline:number|null;failures:number;exempt:boolean;queued:boolean;still:boolean;video?:{codec:string;width?:number;height?:number};thumbnail:boolean;fingerprint:boolean;checking:boolean};
type HealthView={policy:{intervalHours:number;connections:number;hideFailing:boolean};summary:{online:number;offline:number;placeholder:number;unchecked:number;hidden:number;due:number;confirming:number;lastChecked:number|null;lastOnline:number|null;slates:number};checking:number;channels:Record<string,Health>};
const reasons:Record<string,string>={OK:'Playing',STILL_PICTURE:'Still picture with sound',LIVE_RELAY:'Playing for a viewer',FROZEN_SILENT:'Frozen picture with no sound',SILENT_AUDIO:'No sound',PLACEHOLDER_FILE:'Provider placeholder video',KNOWN_SLATE:'Matches a marked offline screen',SHARED_SLATE:'Same frozen screen as other channels',HTTP_NOT_FOUND:'Not found (HTTP 404)',HTTP_FORBIDDEN:'Access denied by provider',HTTP_SERVER_ERROR:'Provider server error',HTTP_ERROR:'Provider HTTP error',DNS_FAILED:'Stream host not found',CONNECTION_REFUSED:'Connection refused',TIMEOUT:'Timed out',INVALID_STREAM:'Not a playable stream',CONNECTION_LOST:'Connection dropped',STREAM_ENDED:'Stream stopped early',NO_MEDIA:'No video or audio'};
const failing=(h?:Health)=>h?.status==='offline'||h?.status==='placeholder';
function HealthBadge({health}:{health?:Health}) {
  // A first failure keeps the previous state until a recheck confirms it.
  const rechecking=!!health&&health.failures>0&&!failing(health);
  const label=health?.checking?'Checking…':rechecking?'Rechecking':!health||health.status==='unchecked'?(health?.queued?'Queued':'Not checked'):health.status==='online'?'Working':health.status==='offline'?'Offline':'Offline screen';
  const tone=health?.checking?'':rechecking?'warning':!health||health.status==='unchecked'?'':health.status==='online'?'ok':'danger';
  return <><span className={`badge ${tone}`}>{label}</span>{health&&(health.status!=='unchecked'||rechecking)&&<small>{health.reason?reasons[health.reason]??health.reason.replaceAll('_',' ').toLowerCase():''}{health.exempt&&failing(health)?' · always shown':''}</small>}{health?.checkedAt&&<small>Checked {date(health.checkedAt)}</small>}</>;
}
function HealthPanel({source,health,changed}:{source:Source;health:ReturnType<typeof useApi<HealthView>>;changed:()=>void}) {
  const data=health.data,[interval,setInterval]=useState(24),[connections,setConnections]=useState(1),[hide,setHide]=useState(true),mutation=useMutation(()=>{health.reload();changed();});
  useEffect(()=>{if(data){setInterval(data.policy.intervalHours);setConnections(data.policy.connections);setHide(data.policy.hideFailing);}},[data?.policy.intervalHours,data?.policy.connections,data?.policy.hideFailing]);
  const s=data?.summary,busy=!!data&&(data.checking>0||data.summary.due>0);
  return <section className="health-panel"><div className="section-heading"><div><h3>Channel checks</h3><p className="muted small">Each check opens the stream like a viewer would, then looks for channels that fail to load, freeze on a still screen with no sound, or show the provider’s offline screen. Failures are rechecked before a channel is hidden, and a channel that works again comes back automatically.</p></div><button className="primary" disabled={mutation.busy||!data} onClick={()=>void mutation.run(()=>api(`/admin/iptv/sources/${source.id}/health/check`,'POST',{}))}>Check all channels now</button></div>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    {health.loading&&!data?<Loading/>:health.error?<ErrorNotice message={health.error.message} retry={health.reload}/>:s&&<>
      <dl className="status-grid"><div><dt>Working</dt><dd>{s.online}</dd></div><div><dt>Offline</dt><dd>{s.offline}</dd></div><div><dt>Offline screen</dt><dd>{s.placeholder}</dd></div><div><dt>Not checked</dt><dd>{s.unchecked}</dd></div></dl>
      <p className="muted small" role="status">{busy?`Checking · ${data!.checking} in progress, ${s.due} waiting`:s.lastChecked?`Last check ${date(s.lastChecked)}`:'No checks yet'}{s.confirming?` · ${s.confirming} failure${s.confirming===1?'':'s'} awaiting a recheck`:''}{s.hidden?` · ${s.hidden} approved channel${s.hidden===1?' is':'s are'} hidden from viewers`:''}{s.slates?` · ${s.slates} marked offline screen${s.slates===1?'':'s'}`:''}</p>
      {s.lastChecked&&(!s.lastOnline||s.lastOnline<Date.now()-12*3600000)&&<div className="notice"><span>No channel from this provider has played in the last 12 hours, so failures are not being applied. The provider may be down or refusing this server.</span></div>}
      <form className="toolbar" onSubmit={e=>{e.preventDefault();void mutation.run(()=>api(`/admin/iptv/sources/${source.id}/health`,'PUT',{intervalHours:interval,connections,hideFailing:hide}));}}>
        <label>Check every (hours)<input type="number" min="0" max="168" required value={interval} onChange={e=>setInterval(Number(e.target.value))}/><small>0 checks only on request</small></label>
        <label>Provider connections<input type="number" min="1" max="8" required value={connections} onChange={e=>setConnections(Number(e.target.value))}/><small>Checks pause while viewers use them</small></label>
        <label className="checkbox-label grow"><input type="checkbox" checked={hide} onChange={e=>setHide(e.target.checked)}/>Hide channels that fail checks from viewers</label>
        <button disabled={mutation.busy}>Save check settings</button>
        {s.slates>0&&<button type="button" disabled={mutation.busy} onClick={()=>void mutation.run(()=>api(`/admin/iptv/sources/${source.id}/health/slates`,'DELETE',{}))}>Forget offline screens</button>}
      </form>
    </>}
  </section>;
}
type SportsView={policy:{enabled:boolean;leadMinutes:number};lastSync:number|null;lastError:string|null;events:number;summary:{matched:number;airing:number};channels:{channelId:string;name:string;title:string;league:string;start:number;end:number;state:string|null;matchedBy:string;airing:boolean}[]};
const matchedBy:Record<string,string>={event:'Channel name',epg_event:'Guide listing',name_time:'Time in channel name',epg:'Guide listing only'};
function SportsPanel({source,changed}:{source:Source;changed:()=>void}) {
  const sports=useApi<SportsView>(`/admin/iptv/sources/${source.id}/sports`),data=sports.data,[enabled,setEnabled]=useState(false),[lead,setLead]=useState(30),mutation=useMutation(()=>{sports.reload();changed();});
  useEffect(()=>{if(data){setEnabled(data.policy.enabled);setLead(data.policy.leadMinutes);}},[data?.policy.enabled,data?.policy.leadMinutes]);
  // Windows open and close with the clock, so keep the list current while the panel is open.
  useEffect(()=>{if(!data?.policy.enabled)return;const timer=window.setInterval(sports.reload,60000);return()=>window.clearInterval(timer);},[data?.policy.enabled]);
  return <section className="health-panel"><div className="section-heading"><div><h3>Sports events</h3><p className="muted small">For sports categories full of event channels. Each channel is matched to a scheduled game, fight or race (ESPN and TheSportsDB schedules, the channel name and the linked guide). Channels are approved, listed and checked only while their event is live or starting soon, then return to review when it ends. Everything else stays pending and is never checked. Playlists that look like event listings turn this on when first imported. Which leagues show, and in what order, is set under Live Sports.</p></div></div>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    {sports.loading&&!data?<Loading/>:sports.error?<ErrorNotice message={sports.error.message} retry={sports.reload}/>:data&&<>
      <form className="toolbar" onSubmit={e=>{e.preventDefault();void mutation.run(()=>api(`/admin/iptv/sources/${source.id}/sports`,'PUT',{enabled,leadMinutes:lead}));}}>
        <label className="checkbox-label grow"><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/>Show channels only while their event is on</label>
        <label>Show before start (minutes)<input type="number" min="0" max="720" required value={lead} onChange={e=>setLead(Number(e.target.value))}/></label>
        <button disabled={mutation.busy}>Save sports settings</button>
      </form>
      {data.policy.enabled&&<><dl className="status-grid"><div><dt>Airing now</dt><dd>{data.summary.airing}</dd></div><div><dt>Matched channels</dt><dd>{data.summary.matched}</dd></div><div><dt>Scheduled events</dt><dd>{data.events}</dd></div><div><dt>Schedule updated</dt><dd>{date(data.lastSync)}</dd></div></dl>
        {data.lastError&&<p className="muted small">Last schedule request failed: {data.lastError.replaceAll('_',' ').toLowerCase()}. It is retried automatically.</p>}
        {!data.channels.length?<Empty title="No channels matched yet">{data.lastSync?'No channel names a game or event scheduled from yesterday through the next two days.':'The first schedule download runs within a minute.'}</Empty>:<div className="table-scroll"><table><thead><tr><th>Channel</th><th>Event</th><th>When</th><th>Status</th></tr></thead><tbody>{data.channels.map(c=><tr key={c.channelId}><td><strong>{c.name}</strong><small>Matched by {matchedBy[c.matchedBy]??c.matchedBy}</small></td><td>{c.title}{c.league&&<small>{c.league}</small>}</td><td>{date(c.start)}<small>until {date(c.end)}</small></td><td><span className={`badge ${c.airing?'ok':''}`}>{c.airing?(c.state==='in'?'Live':'Showing'):c.start>Date.now()?'Upcoming':'Ended'}</span></td></tr>)}</tbody></table></div>}
      </>}
    </>}
  </section>;
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
      <label className="checkbox-label"><input type="checkbox" checked={!!health?.exempt} disabled={mutation.busy} onChange={e=>{const exempt=e.target.checked;void mutation.run(()=>api(`/admin/iptv/channels/${channel.id}/health`,'PATCH',{exempt}));}}/>Always show, even if checks fail</label>
    </div>
    <p className="muted small">Mark a picture as an offline screen when the provider shows a “channel unavailable” card. Every channel showing the same screen is hidden, including ones with music or animation.</p>
  </Modal>;
}
function RemoveSource({source,sources,changed,removed,onClose}:{source:Source;sources:Source[];changed:()=>void;removed:()=>void;onClose:()=>void}) {
  const mutation=useMutation(changed),guide=source.kind==='xmltv',linked=sources.filter(s=>s.feedId===source.id);
  return <Modal title={guide?'Remove EPG':'Remove M3U source'} onClose={()=>{if(!mutation.busy)onClose();}}>
    <h2>Remove {source.name}?</h2>
    <p>{guide?'This removes the EPG, its saved listings and channel mappings. Linked channels stay available without this guide.':'This removes the M3U source and all its channels, favorites, guide mappings and reserved channel numbers. Its EPG is also removed unless another source uses it.'}</p>
    {guide&&linked.length>0&&<p className="muted">This EPG will be unlinked from: {linked.map(s=>s.name).join(', ')}.</p>}
    <p className="muted small">Removal cannot be undone. You can add the source again later.</p>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    <form onSubmit={e=>{e.preventDefault();void mutation.run(async()=>{await api(`/admin/iptv/sources/${source.id}`,'DELETE',{expectedRevision:source.revision});removed();});}}>
      <div className="button-row"><button className="danger" type="submit" disabled={mutation.busy}>{mutation.busy?'Removing…':guide?'Remove EPG':'Remove M3U source'}</button><button type="button" disabled={mutation.busy} onClick={onClose} autoFocus>Cancel</button></div>
    </form>
  </Modal>;
}
function ProgramGuide({source,guide,changed}:{source:Source;guide?:Source;changed:()=>void}) {
  const [url,setUrl]=useState(''),[headers,setHeaders]=useState(''),[insecure,setInsecure]=useState(false),[interval,setInterval]=useState(guide?.intervalHours??6),[remove,setRemove]=useState(false),[saved,setSaved]=useState(false);
  const mutation=useMutation(changed),busy=mutation.busy||!!guide?.running;
  useEffect(()=>{setInterval(guide?.intervalHours??6);},[guide?.id,guide?.intervalHours]);
  useEffect(()=>{if(!guide?.running)return;const timer=window.setInterval(changed,3000);return()=>window.clearInterval(timer);},[guide?.running]);
  return <section className="health-panel">
    <div className="section-heading"><div><h3>Program guide (EPG)</h3><p className="muted small">Add an XMLTV guide directly to {source.name}. Channels with matching XMLTV IDs receive listings automatically.</p></div>{guide&&<div className="button-row"><button disabled={busy||!guide.remote} onClick={()=>{setSaved(false);void mutation.run(()=>api(`/admin/iptv/sources/${guide.id}/refresh`,'POST',{}));}}>{guide.running?'Refreshing…':'Refresh EPG'}</button><button className="danger" disabled={busy} onClick={()=>setRemove(true)}>Remove EPG</button></div>}</div>
    {guide&&<dl className="status-grid"><div><dt>Last EPG import</dt><dd>{date(guide.lastSuccess)}</dd></div><div><dt>Next EPG refresh</dt><dd>{guide.remote?date(guide.nextDue):'Uploaded file · manual import'}</dd></div><div><dt>EPG status</dt><dd>{guide.lastError?guide.lastError.replaceAll('_',' ').toLowerCase():guide.lastSuccess?'Up to date':'Awaiting import'}</dd></div></dl>}
    {mutation.error&&<ErrorNotice message={mutation.error}/>}{saved&&<p className="success" role="status">EPG saved.</p>}
    <form className="form-stack" onSubmit={e=>{e.preventDefault();setSaved(false);void mutation.run(async()=>{
      if(!url.trim()&&(headers.trim()||insecure))throw new Error('Enter the EPG URL to replace its provider request options.');
      let requestHeaders:unknown={};
      if(headers.trim()){try{requestHeaders=JSON.parse(headers);}catch{throw new Error('Headers must be a JSON object.');}}
      const result=await api<{source:Source;guide:Source}>(`/admin/iptv/sources/${source.id}/guide`,'PUT',{expectedRevision:source.revision,intervalHours:interval,...(url.trim()?{endpoint:{url:url.trim(),headers:requestHeaders,allowInsecureHttp:insecure}}:{})});
      setUrl('');setHeaders('');setInsecure(false);
      if(result.guide.remote)try{await api(`/admin/iptv/sources/${result.guide.id}/refresh`,'POST',{});}catch{throw new Error('The EPG was saved for this source, but its import failed. Use Refresh EPG to retry, or enter a replacement EPG URL.');}
      setSaved(true);
    });}}>
      <label>{guide?'Replacement EPG URL':'EPG URL'}<input type="url" value={url} onChange={e=>setUrl(e.target.value)} required={!guide} disabled={busy} autoComplete="off" spellCheck={false} placeholder="https://provider.example/guide.xml.gz"/>{guide&&<small>Leave blank to keep this source’s current guide.</small>}</label>
      <label>EPG refresh every (hours)<input type="number" min="1" max="168" required value={interval} disabled={busy} onChange={e=>setInterval(Number(e.target.value))}/></label>
      <details><summary>EPG provider request options</summary><label>Request headers (JSON)<textarea value={headers} disabled={busy} onChange={e=>setHeaders(e.target.value)} autoComplete="off" placeholder={'{"User-Agent":"tk.box"}'}/></label><label className="checkbox-label"><input type="checkbox" checked={insecure} disabled={busy} onChange={e=>setInsecure(e.target.checked)}/>This provider requires unencrypted HTTP</label></details>
      <p className="muted small">XML and gzip-compressed guides are supported. Credentials are stored encrypted. The guide imports when saved and refreshes on its own schedule.</p>
      <div className="button-row"><button className="primary" disabled={busy}>{mutation.busy?'Saving EPG…':guide?'Save EPG':'Add EPG'}</button></div>
    </form>
    {guide&&!guide.remote&&<details><summary>Import a replacement guide file</summary><label>XMLTV file<input type="file" accept=".xml" disabled={busy} onChange={e=>{const input=e.currentTarget,file=input.files?.[0];if(file)void mutation.run(async()=>{
      if(file.size>16*1024*1024)throw new Error('File exceeds the 16 MiB import limit.');
      const text=await file.text(),result=await api<{guide:Source}>(`/admin/iptv/sources/${source.id}/guide`,'PUT',{expectedRevision:source.revision,intervalHours:interval});
      await api(`/admin/iptv/sources/${result.guide.id}/upload`,'POST',{expectedRevision:result.guide.revision,text});input.value='';
    });}}/></label></details>}
    {remove&&<Modal title="Remove source EPG" onClose={()=>{if(!mutation.busy)setRemove(false);}}><h2>Remove the EPG from {source.name}?</h2><p>Channels stay available without program listings. Guides used by other sources are kept.</p><div className="button-row"><button className="danger" disabled={mutation.busy} onClick={()=>void mutation.run(async()=>{await api(`/admin/iptv/sources/${source.id}/guide`,'DELETE',{expectedRevision:source.revision});setRemove(false);setSaved(false);})}>Remove EPG</button><button disabled={mutation.busy} onClick={()=>setRemove(false)}>Cancel</button></div>{mutation.error&&<ErrorNotice message={mutation.error}/>}</Modal>}
  </section>;
}
function SourceDetail({source,sources,changed,removed}:{source:Source;sources:Source[];changed:()=>void;removed:()=>void}) {
  const channels=useApi<{channels:Channel[]}>(source.kind==='m3u'?`/admin/iptv/sources/${source.id}/channels`:undefined),[interval,setInterval]=useState(source.intervalHours),[auto,setAuto]=useState(source.autoAddNewChannels),[filter,setFilter]=useState('all'),[candidate,setCandidate]=useState(false),[mapping,setMapping]=useState<Channel>(),[edit,setEdit]=useState<Channel>();
  const [replacement,setReplacement]=useState(''),[insecure,setInsecure]=useState(false),[providerHeaders,setProviderHeaders]=useState(''),[remove,setRemove]=useState(false);
  const [reviewSearch,setReviewSearch]=useState(''),[selected,setSelected]=useState<string[]>([]);
  const health=useApi<HealthView>(source.kind==='m3u'?`/admin/iptv/sources/${source.id}/health`:undefined),[inspect,setInspect]=useState<Channel>(),checks=health.data?.channels??{};
  // Follow running checks without hammering the server.
  const checking=!!health.data&&(health.data.checking>0||health.data.summary.due>0),confirming=!!health.data?.summary.confirming;
  useEffect(()=>{if(!checking&&!confirming)return;const timer=window.setInterval(health.reload,checking?3000:10000);return()=>window.clearInterval(timer);},[checking,confirming]);
  const healthFilter=(c:Channel)=>filter==='working'?checks[c.id]?.status==='online':filter==='failing'?failing(checks[c.id]):filter==='unchecked'?!checks[c.id]||checks[c.id]!.status==='unchecked':undefined;
  const reviewable=(c:Channel)=>c.approval==='pending'&&c.present&&!c.conflict;
  const mutation=useMutation(()=>{changed();channels.reload();});
  useEffect(()=>{setSelected([]);},[source.revision]);
  const bulk=(approval:'approved'|'ignored')=>void mutation.run(()=>api(`/admin/iptv/sources/${source.id}/channels/review`,'POST',{expectedRevision:source.revision,ids:selected,approval}));
  useEffect(()=>{setInterval(source.intervalHours);setAuto(source.autoAddNewChannels);},[source.revision]);
  const update=(channel:Channel,value:Record<string,unknown>)=>void mutation.run(()=>api(`/admin/iptv/channels/${channel.id}`,'PATCH',{expectedRevision:source.revision,...value}));
  const entries=channels.data?.channels??[],filtered=entries.filter(c=>(healthFilter(c)??(filter==='all'||filter==='missing'&&!c.present||filter==='conflict'&&c.conflict||c.approval===filter))&&(!reviewSearch||[c.name,c.tvgId,c.group,String(c.number??'')].some(value=>value.toLocaleLowerCase().includes(reviewSearch.toLocaleLowerCase())))),selectable=filtered.filter(reviewable).slice(0,100);
  return <section className="panel source-detail"><div className="section-heading"><div><p className="eyebrow">{source.kind==='m3u'?'M3U CHANNEL SOURCE':'XMLTV GUIDE'}</p><h2>{source.name}</h2></div><div className="button-row"><button disabled={!source.remote||source.running||mutation.busy} onClick={()=>void mutation.run(()=>api(`/admin/iptv/sources/${source.id}/refresh`,'POST',{}))}>{source.running?'Refreshing…':'Refresh now'}</button><button className="danger" disabled={mutation.busy} onClick={()=>setRemove(true)}>{source.kind==='xmltv'?'Remove EPG':'Remove source'}</button></div></div>{mutation.error&&<ErrorNotice message={mutation.error}/>}<dl className="status-grid"><div><dt>Last attempt</dt><dd>{date(source.lastAttempt)}</dd></div><div><dt>Last successful import</dt><dd>{date(source.lastSuccess)}</dd></div><div><dt>Next refresh</dt><dd>{source.remote?date(source.nextDue):'Uploaded file · manual import'}</dd></div><div><dt>Status</dt><dd>{source.lastError?source.lastError.replaceAll('_',' ').toLowerCase():source.lastSuccess?'Up to date':'Awaiting import'}</dd></div></dl>{source.candidateDigest&&<div className="notice"><span>A substantial lineup change is waiting for review.</span><button onClick={()=>setCandidate(true)}>Review changes</button></div>}<form className="toolbar" onSubmit={e=>{e.preventDefault();void mutation.run(()=>api(`/admin/iptv/sources/${source.id}`,'PATCH',{expectedRevision:source.revision,intervalHours:interval,...(source.kind==='m3u'?{autoAddNewChannels:auto}:{})}));}}><label>Refresh every (hours)<input type="number" min="1" max="168" required value={interval} onChange={e=>setInterval(Number(e.target.value))}/></label>{source.kind==='m3u'&&<label className="checkbox-label grow"><input type="checkbox" checked={auto} onChange={e=>setAuto(e.target.checked)}/>Automatically add future new channels</label>}<button disabled={mutation.busy}>Save policy</button></form><ProgramGuide source={source} guide={sources.find(s=>s.id===source.feedId)} changed={changed}/><details><summary>Import a replacement file</summary><label>Choose a UTF-8 {source.kind==='m3u'?'playlist':'guide'}<input type="file" accept={source.kind==='m3u'?'.m3u,.m3u8':'.xml'} disabled={mutation.busy} onChange={e=>{const input=e.currentTarget,file=input.files?.[0];if(file)void mutation.run(async()=>{if(file.size>16*1024*1024)throw new Error('File exceeds the 16 MiB import limit.');await api(`/admin/iptv/sources/${source.id}/upload`,'POST',{expectedRevision:source.revision,text:await file.text()});input.value='';});}}/></label></details><details><summary>Replace remote endpoint</summary><form className="form-stack" onSubmit={e=>{e.preventDefault();void mutation.run(async()=>{let headers:unknown={};try{headers=providerHeaders.trim()?JSON.parse(providerHeaders):{};}catch{throw new Error('Headers must be a JSON object.');}await api(`/admin/iptv/sources/${source.id}/endpoint`,'PUT',{expectedRevision:source.revision,endpoint:{url:replacement,headers,allowInsecureHttp:insecure}});setReplacement('');setProviderHeaders('');});}}><label>New URL<input type="url" value={replacement} onChange={e=>setReplacement(e.target.value)} required autoComplete="off"/></label><label>Replacement headers (JSON)<textarea value={providerHeaders} onChange={e=>setProviderHeaders(e.target.value)} autoComplete="off"/></label><label className="checkbox-label"><input type="checkbox" checked={insecure} onChange={e=>setInsecure(e.target.checked)}/>This provider requires unencrypted HTTP</label><button disabled={mutation.busy}>Replace endpoint</button></form></details>{source.kind==='m3u'&&<><SportsPanel source={source} changed={()=>{changed();channels.reload();}}/><HealthPanel source={source} health={health} changed={channels.reload}/><div className="section-heading"><h3>Channel review</h3><select aria-label="Channel review filter" value={filter} onChange={e=>{setFilter(e.target.value);setSelected([]);}}>{['all','pending','approved','ignored','conflict','missing'].map(f=><option key={f} value={f}>{f[0]!.toUpperCase()+f.slice(1)} · {f==='all'?entries.length:entries.filter(c=>f==='missing'?!c.present:f==='conflict'?c.conflict:c.approval===f).length}</option>)}<optgroup label="Channel checks">{([['working','Working'],['failing','Failing'],['unchecked','Not checked']] as const).map(([f,label])=><option key={f} value={f}>{label} · {entries.filter(c=>{const h=checks[c.id];return f==='working'?h?.status==='online':f==='failing'?failing(h):!h||h.status==='unchecked';}).length}</option>)}</optgroup></select></div><div className="review-toolbar"><label className="grow">Find a channel<input aria-label="Search channel review" placeholder="Name, provider ID, group or number" value={reviewSearch} maxLength={120} onChange={e=>{setReviewSearch(e.target.value);setSelected([]);}}/></label><div className="button-row"><button className="primary" disabled={!selected.length||mutation.busy} onClick={()=>bulk('approved')}>Approve selected{selected.length?` · ${selected.length}`:''}</button><button disabled={!selected.length||mutation.busy} onClick={()=>bulk('ignored')}>Ignore selected</button></div></div><p className="muted small">Select up to 100 pending channels to review together. Channels with identity conflicts require individual reconciliation.</p>{channels.loading&&!channels.data?<Loading/>:channels.error?<ErrorNotice message={channels.error.message} retry={channels.reload}/>:!filtered.length?<Empty title="No channels in this view">Import a playlist or select another review filter.</Empty>:<div className="table-scroll"><table><thead><tr><th className="selection-cell"><input type="checkbox" aria-label="Select visible pending channels (up to 100)" disabled={mutation.busy||!selectable.length} checked={!!selectable.length&&selectable.every(c=>selected.includes(c.id))} onChange={e=>setSelected(e.target.checked?selectable.map(c=>c.id):[])}/></th><th>Channel</th><th>Number</th><th>Status</th><th>Health</th><th>Actions</th></tr></thead><tbody>{filtered.map(c=><tr key={c.id}><td className="selection-cell">{reviewable(c)&&<input type="checkbox" aria-label={`Select ${c.name}`} disabled={mutation.busy||selected.length>=100&&!selected.includes(c.id)} checked={selected.includes(c.id)} onChange={e=>{const checked=e.target.checked;setSelected(ids=>checked?[...ids,c.id]:ids.filter(id=>id!==c.id));}}/>}</td><td><strong>{c.name}</strong><small>{c.group||'No group'} · {c.tvgId||'No provider ID'}{c.quality&&` · ${c.quality}`}</small>{!c.stackKey.startsWith('solo:')&&(entries.filter(e=>e.stackKey===c.stackKey).length>1)&&<small>Stack · {c.stackKey} · {entries.filter(e=>e.stackKey===c.stackKey).length} feeds</small>}<small>Seen {date(c.lastSeen)}{c.missingSince?` · Missing since ${date(c.missingSince)}`:''}</small></td><td>{c.number??'Unassigned'}</td><td><span className={`badge ${c.conflict?'warning':''}`}>{c.conflict?'Identity conflict':!c.present?'Missing':!c.enabled?'Disabled':c.approval}</span></td><td className="health-cell">{c.present&&!c.conflict&&c.approval!=='ignored'?<HealthBadge health={checks[c.id]}/>:<span className="muted small">—</span>}</td><td><div className="button-row">{c.approval!=='approved'&&!c.conflict&&c.present&&<button disabled={mutation.busy} onClick={()=>update(c,{approval:'approved'})}>Approve</button>}{c.approval!=='ignored'&&<button disabled={mutation.busy} onClick={()=>update(c,{approval:'ignored'})}>Ignore</button>}{c.conflict&&c.present&&c.tvgId&&<button disabled={mutation.busy} onClick={()=>update(c,{acceptIdentity:true})}>Reconcile identity</button>}{c.approval==='approved'&&<button onClick={()=>setEdit(c)}>Edit</button>}<button disabled={c.conflict||!source.feedId} onClick={()=>setMapping(c)}>Guide match</button>{c.present&&!c.conflict&&c.approval!=='ignored'&&<button onClick={()=>setInspect(c)}>Check</button>}</div></td></tr>)}</tbody></table></div>}</>}{candidate&&<Candidate source={source} changed={changed} onClose={()=>setCandidate(false)}/ >}{mapping&&<Mapping source={source} channel={mapping} onClose={()=>setMapping(undefined)}/ >}{remove&&<RemoveSource source={source} sources={sources} changed={changed} removed={removed} onClose={()=>setRemove(false)}/ >}{inspect&&<ChannelHealthDialog channel={inspect} health={checks[inspect.id]} changed={health.reload} onClose={()=>setInspect(undefined)}/>}{edit&&<EditChannel source={source} channel={edit} changed={()=>{changed();channels.reload();}} onClose={()=>setEdit(undefined)}/ >}</section>;
}
function SourceSettings() {
  const sources=useApi<{sources:Source[]}>('/admin/iptv/sources'),[selected,setSelected]=useState(''),[create,setCreate]=useState(false),[importError,setImportError]=useState('');
  const playlists=sources.data?.sources.filter(s=>s.kind==='m3u')??[],source=playlists.find(s=>s.id===selected);
  return <><div className="section-heading"><div><h2>IPTV sources</h2><p className="muted">Manage playlists, their program guides and channel approval.</p></div><button className="primary" onClick={()=>setCreate(true)}>Add source</button></div>
    {importError&&<ErrorNotice message={importError}/>}
    {sources.loading&&!sources.data?<Loading/>:sources.error?<ErrorNotice message={sources.error.message} retry={sources.reload}/>:playlists.length?<div className="source-list">{playlists.map(s=>{const guide=sources.data!.sources.find(g=>g.id===s.feedId);return <button className={`source-card ${selected===s.id?'selected':''}`} key={s.id} onClick={()=>{setSelected(s.id);setImportError('');}}><span className="badge">M3U</span><strong>{s.name}</strong><span>{s.lastError?'Needs attention':s.lastSuccess?'Imported':'Waiting for import'} · {s.remote?`Every ${s.intervalHours}h`:'File upload'}</span><span>{guide?guide.lastError?'EPG needs attention':guide.lastSuccess?'EPG imported':'EPG awaiting import':'No EPG added'}</span></button>;})}</div>:<Empty title="Add your first IPTV source">Connect an M3U playlist to discover live channels, then add its EPG in the source’s settings.</Empty>}
    {source&&<SourceDetail key={source.id} source={source} sources={sources.data!.sources} changed={sources.reload} removed={()=>{setSelected('');setImportError('');}}/>}
    {create&&<CreateSource changed={sources.reload} created={(s,error)=>{setSelected(s.id);setImportError(error);}} onClose={()=>setCreate(false)}/>}
  </>;
}
function PlaybackSettingsForm() {
  const data=useApi<PlaybackSettings&{revision:number;activeVideoEncoders:number}>('/admin/settings/playback'),[limit,setLimit]=useState(2),[minutes,setMinutes]=useState(30),[saved,setSaved]=useState(false),mutation=useMutation(data.reload);
  useEffect(()=>{if(data.data){setLimit(data.data.maxConcurrentCpuVideoTranscodes);setMinutes(data.data.pauseRetentionMinutes);}},[data.data?.revision]);
  return <section className="panel"><h2>Playback & buffering</h2><p className="muted">Set the server-wide CPU encoder ceiling and custom-channel pause retention.</p>{data.loading&&!data.data?<Loading/>:data.error?<ErrorNotice message={data.error.message} retry={data.reload}/>:data.data&&<form className="form-stack narrow" onSubmit={e=>{e.preventDefault();setSaved(false);void mutation.run(async()=>{await api('/admin/settings/playback','PATCH',{expectedRevision:data.data!.revision,maxConcurrentCpuVideoTranscodes:limit,pauseRetentionMinutes:minutes});setSaved(true);});}}><label>Maximum concurrent CPU video encoders<input type="number" min="1" max="16" required value={limit} onChange={e=>setLimit(Number(e.target.value))}/><small>{data.data.activeVideoEncoders} active app-managed encoders. Direct Play and remux do not use video-encoder slots.</small></label><label>Maximum pause retention (minutes)<input type="number" min="5" max="120" required value={minutes} onChange={e=>setMinutes(Number(e.target.value))}/><small>Actual retained time can be shorter under storage limits.</small></label><p className="muted small">Video encoding remains limited to eligible 1080p-or-lower sources. Lowering this ceiling leaves existing jobs running and applies to new admissions.</p>{mutation.error&&<ErrorNotice message={mutation.error}/ >}{saved&&<p role="status" className="success">Settings saved.</p>}<button disabled={mutation.busy} className="primary">Save settings</button></form>}</section>;
}
type League={key:string;name:string;sport:string;configured:boolean;upcoming:number};
type SportsSettingsValue={leagueMode:'all'|'selected';leagues:string[];unscheduled:boolean;sportOrder:string[];leagueOrder:string[];placement:'top'|'bottom';numberStart:number|null};
type SportsSettingsView={settings:SportsSettingsValue&{revision:number};leagues:League[];lastSync:number|null;lastError:string|null};
const sportNames:Record<string,string>={football:'American football',basketball:'Basketball',baseball:'Baseball',hockey:'Hockey',soccer:'Soccer',mma:'MMA',boxing:'Boxing',wrestling:'Wrestling',racing:'Motorsport',golf:'Golf',tennis:'Tennis',rugby:'Rugby',cricket:'Cricket',cycling:'Cycling',darts:'Darts',curling:'Curling',sports:'Other sports'};
const move=<T,>(list:T[],i:number,by:number)=>{const j=i+by;if(j<0||j>=list.length)return list;const next=[...list];[next[i],next[j]]=[next[j]!,next[i]!];return next;};
// Server-wide: which leagues event channels are shown for, the order sports and leagues appear in, and their numbers.
function LiveSportsSettings() {
  const view=useApi<SportsSettingsView>('/admin/sports/settings'),[draft,setDraft]=useState<SportsSettingsValue>(),[saved,setSaved]=useState(false),mutation=useMutation(view.reload);
  useEffect(()=>{if(view.data){const {revision:_,...value}=view.data.settings;setDraft(value);}},[view.data?.settings.revision]);
  if(view.loading&&!view.data)return <Loading/>;
  if(view.error)return <ErrorNotice message={view.error.message} retry={view.reload}/>;
  if(!view.data||!draft)return null;
  const data=view.data,selecting=draft.leagueMode==='selected';
  const set=(patch:Partial<SportsSettingsValue>)=>{setSaved(false);setDraft(d=>d&&{...d,...patch});};
  const rank=(l:League)=>{const i=draft.leagueOrder.indexOf(l.key);return i<0?draft.leagueOrder.length:i;};
  // Only shown leagues compete for a place, so when selecting they are listed first.
  const hidden=(l:League)=>Number(selecting&&!draft.leagues.includes(l.key));
  const leaguesOf=(sport:string)=>data.leagues.filter(l=>l.sport===sport).sort((a,b)=>hidden(a)-hidden(b)||rank(a)-rank(b)||a.name.localeCompare(b.name));
  // The order saved is the order on screen.
  const shownOrder=(sport?:string,moved?:string[])=>draft.sportOrder.flatMap(s=>s===sport&&moved?moved:leaguesOf(s).map(l=>l.key));
  const moveLeague=(sport:string,i:number,by:number)=>set({leagueOrder:shownOrder(sport,move(leaguesOf(sport).map(l=>l.key),i,by))});
  const choose=(keys:string[],on:boolean)=>set({leagues:on?[...new Set([...draft.leagues,...keys])]:draft.leagues.filter(k=>!keys.includes(k))});
  return <section className="panel"><div className="section-heading"><div><h2>Live Sports</h2><p className="muted">Choose which leagues' event channels appear, the order sports and leagues are listed in, and how event channels are numbered. These settings apply to every playlist using sports events.</p></div></div>
    <p className="muted small" role="status">{data.lastSync?`Schedules last downloaded ${date(data.lastSync)}`:'Schedules download while a playlist uses sports events.'}{data.lastError?` · Last error: ${data.lastError.replaceAll('_',' ').toLowerCase()}`:''}</p>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    <form className="form-stack" onSubmit={e=>{e.preventDefault();void mutation.run(async()=>{await api('/admin/sports/settings','PUT',{expectedRevision:data.settings.revision,...draft,leagueOrder:shownOrder()});setSaved(true);});}}>
      <fieldset className="sports-fieldset"><legend>Leagues</legend>
        <label className="checkbox-label"><input type="radio" name="league-mode" checked={!selecting} onChange={()=>set({leagueMode:'all'})}/>Show every league</label>
        <label className="checkbox-label"><input type="radio" name="league-mode" checked={selecting} onChange={()=>set({leagueMode:'selected'})}/>Show only the leagues I select</label>
        <label className="checkbox-label"><input type="checkbox" checked={draft.unscheduled} onChange={e=>set({unscheduled:e.target.checked})}/>Also show event channels that match no scheduled game</label>
        <small className="muted">These are matched only by a time in the channel name or a guide listing, so they belong to no league. Turn this off to show only the leagues above.</small>
        {selecting&&!draft.leagues.length&&<div className="notice"><span>No leagues are selected.{draft.unscheduled?' Only channels with no scheduled game will show.':' No event channels will show.'}</span></div>}
      </fieldset>
      <fieldset className="sports-fieldset"><legend>Order</legend>
        <p className="muted small">Live events are listed by sport, then by league within each sport, then by start time. Channels with no scheduled game come after the leagues of their sport.</p>
        <ol className="sports-order">{draft.sportOrder.map((sport,i)=>{const leagues=leaguesOf(sport),on=leagues.filter(l=>draft.leagues.includes(l.key)).length;return <li key={sport} className="sports-sport">
          <div className="sports-row sports-sport-head"><span className="sports-rank">{i+1}</span><strong>{sportNames[sport]??sport}</strong><small className="muted">{leagues.length?(selecting?`${on} of ${leagues.length} shown`:`${leagues.length} league${leagues.length===1?'':'s'}`):'Channels detected by name only'}</small>
            {selecting&&leagues.length>0&&<span className="button-row sports-bulk"><button type="button" onClick={()=>choose(leagues.map(l=>l.key),true)}>All</button><button type="button" onClick={()=>choose(leagues.map(l=>l.key),false)}>None</button></span>}
            <span className="sports-move"><button type="button" className="icon-button" aria-label={`Move ${sportNames[sport]??sport} up`} disabled={i===0} onClick={()=>set({sportOrder:move(draft.sportOrder,i,-1)})}>↑</button><button type="button" className="icon-button" aria-label={`Move ${sportNames[sport]??sport} down`} disabled={i===draft.sportOrder.length-1} onClick={()=>set({sportOrder:move(draft.sportOrder,i,1)})}>↓</button></span></div>
          {leagues.length>0&&<ol className="sports-leagues">{leagues.map((l,j)=><li key={l.key} className="sports-row">
            {selecting?<label className="checkbox-label grow"><input type="checkbox" checked={draft.leagues.includes(l.key)} onChange={e=>choose([l.key],e.target.checked)}/>{l.name}</label>:<span className="grow">{l.name}</span>}
            <small className="muted">{l.upcoming?`${l.upcoming} game${l.upcoming===1?'':'s'} scheduled`:'No games scheduled'}{!l.configured&&' · not downloaded'}</small>
            <span className="sports-move"><button type="button" className="icon-button" aria-label={`Move ${l.name} up`} disabled={j===0} onClick={()=>moveLeague(sport,j,-1)}>↑</button><button type="button" className="icon-button" aria-label={`Move ${l.name} down`} disabled={j===leagues.length-1} onClick={()=>moveLeague(sport,j,1)}>↓</button></span>
          </li>)}</ol>}
        </li>;})}</ol>
      </fieldset>
      <fieldset className="sports-fieldset"><legend>Guide placement and numbers</legend>
        <div className="toolbar">
          <label>Live events in the guide<select value={draft.placement} onChange={e=>set({placement:e.target.value as 'top'|'bottom'})}><option value="top">Above other channels</option><option value="bottom">Below other channels</option></select></label>
          <label className="checkbox-label"><input type="checkbox" checked={draft.numberStart!==null} onChange={e=>set({numberStart:e.target.checked?1000:null})}/>Number event channels in their own block</label>
          {draft.numberStart!==null&&<label>Starting at<input type="number" min="1" max="99999" required value={draft.numberStart} onChange={e=>set({numberStart:Number(e.target.value)})}/></label>}
        </div>
        <small className="muted">{draft.numberStart!==null?`Event channels take the lowest free number from ${draft.numberStart} up. Changing the start moves live event channels into the new block, except ones a viewer has favorited.`:'Event channels take the lowest free channel number.'}</small>
      </fieldset>
      <div className="button-row"><button className="primary" disabled={mutation.busy}>Save Live Sports settings</button>{saved&&<span className="success" role="status">Saved. The lineup has been updated.</span>}</div>
    </form>
  </section>;
}
export function Settings({me,onLogout}:{me:Principal;onLogout:()=>void}) {
  const [tab,setTab]=useState('sources');
  return <><div className="page-heading"><p className="eyebrow">YOUR tk.box</p><h1>Settings</h1><p>{me.role==='admin'?'Manage sources and shared playback settings.':'Your account and connection.'}</p></div><section className="account-panel panel"><div><h2>Plex account</h2><p>Account {me.accountId} · <span className="badge">{me.role==='admin'?'Administrator':'Viewer'}</span></p></div><button onClick={onLogout}>Sign out</button></section>{me.role==='admin'&&<><div className="tabs" role="tablist" aria-label="Settings sections"><button role="tab" aria-selected={tab==='sources'} onClick={()=>setTab('sources')}>IPTV sources</button><button role="tab" aria-selected={tab==='sports'} onClick={()=>setTab('sports')}>Live Sports</button><button role="tab" aria-selected={tab==='playback'} onClick={()=>setTab('playback')}>Playback & buffering</button></div><div role="tabpanel">{tab==='sources'?<SourceSettings/>:tab==='sports'?<LiveSportsSettings/>:<PlaybackSettingsForm/>}</div></>}</>;
}
