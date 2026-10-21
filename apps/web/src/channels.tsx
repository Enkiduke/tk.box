import {useEffect,useState,type ReactNode} from 'react';
import type {CatalogItem,CatalogPage} from '../../../packages/contracts/src/index.js';
import {api} from './api.js';
import {useApi,useDebounced,useInfinitePages,invalidate,duration,clock} from './hooks.js';
import {Empty,ErrorNotice,FadeImage,Icon,Loading,Modal} from './components.js';
import {ChannelLogo} from './live.js';
import {Card,MoveButtons,SectionHead,Switch,code,moveTo,plural,useDragOrder,useMutation} from './settings-ui.js';

// Channel Manager: custom channels are lists of Plex movies and episodes that play one after another, looping.
// Every edit changes the draft; Publish hands over at the end of whatever is airing.
type Slot={title:string;subtitle?:string;start:number;end:number;entryId:string};
type Summary={id:string;name:string;summary:string;logoUrl:string|null;plexLogo:string|null;mainTitle:{id:string;title:string}|null;enabled:boolean;number:number|null;position:number|null;revision:number;programs:number;runtimeMs:number;issues:number;
  live:boolean;startedAt?:number;current?:Slot;pending?:{effectiveAt:number;next:string;nextSubtitle?:string};changed:boolean;publicationRevision:number};
type Issue='no_media'|'no_duration'|'incompatible';
type Entry={entryId:string;mediaId:string;kind:'movie'|'episode';title:string;showTitle?:string;showId?:string;season?:number;episode?:number;year?:number;date?:string;durationMs:number;sourceId?:string;issue?:Issue;addedAuto?:number};
type SyncResult={added:number;titles:string[];review:{title:string;issue:Issue}[];seeded?:boolean;waiting?:boolean};
type SourceKind='show'|'season'|'collection'|'genre';
type Source={id:string;kind:SourceKind;plexId:string;title:string;specials:boolean;autoAdd:boolean;lastChecked:number|null;lastResult:SyncResult|null;lastError:string|null;programs:number};
type Detail=Summary&{entries:Entry[];sources:Source[]};
type Preview={current?:Slot;effectiveAt:number;reason:'INITIAL'|'SUCCESSOR'|'FIRST_ENTRY';upcoming:Slot[];replacesPending:boolean;publicationRevision:number};
type AddResult={channel:Detail;added:number;skipped:number;specials:number;issues:number};
const base='/admin/custom-channels';
const changed=()=>{invalidate(base);invalidate('/guide');};
const issues:Record<Issue,string>={no_media:'No playable file',no_duration:'Unknown runtime',incompatible:'Can’t play on a channel'};
const issueHelp='Video above 1080p that isn’t H.264 would need a 4K encode, which the server never does.';
const sameDay=(a:number,b:number)=>new Date(a).toDateString()===new Date(b).toDateString();
const when=(ms:number)=>sameDay(ms,Date.now())?clock(ms):`${new Intl.DateTimeFormat(undefined,{weekday:'short'}).format(ms)} ${clock(ms)}`;
const stamp=(ms:number)=>new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(ms);
const episodeLabel=(e:{season?:number;episode?:number})=>`S${e.season??'?'} E${e.episode??'?'}`;
const poster=(e:Entry)=>`/api/v1/catalog/items/${e.showId??e.mediaId}/artwork?kind=poster`;
const grouped=(kind:string)=>kind==='collection'||kind==='genre';
const kindIcon:Record<string,string>={movie:'movies',episode:'shows',show:'shows',season:'shows',collection:'collection',genre:'tag'};
const kindLabel=(s:Source)=>s.kind==='show'?`Whole show${s.specials?' · with specials':''}`:s.kind==='season'?'One season':s.kind==='collection'?`Plex collection${s.specials?' · with specials':''}`:`Category${s.specials?' · with specials':''}`;
function Thumb({src,icon='movies'}:{src?:string;icon?:string}) {
  const [failed,setFailed]=useState(false);
  return <span className="program-thumb" aria-hidden="true">{src&&!failed?<FadeImage src={src} alt="" loading="lazy" decoding="async" onError={()=>setFailed(true)}/>:<Icon name={icon} size={16}/>}</span>;
}
// One status per channel, in order of what needs doing first.
type Tone='ok'|'warning'|'danger'|'';
function status(c:Summary):{label:string;tone:Tone} {
  if(c.issues)return {label:`${plural(c.issues,'program')} can’t play`,tone:'danger'};
  if(!c.live)return c.programs?{label:'Ready to publish',tone:'warning'}:{label:'No programs yet',tone:''};
  if(!c.enabled)return {label:'Hidden from Live TV',tone:''};
  if(c.changed)return {label:'Unpublished changes',tone:'warning'};
  if(c.pending)return {label:`Updates at ${when(c.pending.effectiveAt)}`,tone:'warning'};
  return {label:'On air',tone:'ok'};
}
const StatusBadge=({channel}:{channel:Summary})=>{const s=status(channel);return <span className={`badge ${s.tone}`}>{s.label}</span>;};
const Logo=({channel}:{channel:Summary})=><ChannelLogo channel={{id:channel.id,name:channel.name,logo:!!channel.logoUrl||channel.plexLogo!=='none'}} size={28}/>;

export function CustomChannelSettings() {
  const drag=useDragOrder(),list=useApi<{channels:Summary[]}>(base),[open,setOpen]=useState<{id:string;adding?:boolean}>(),[create,setCreate]=useState(false),ordering=useMutation(list.reload);
  const channels=list.data?.channels??[];
  if(open&&channels.some(c=>c.id===open.id))return <ChannelEditor key={open.id} id={open.id} startAdding={open.adding} back={()=>setOpen(undefined)}/>;
  const reorder=(from:number,to:number)=>void ordering.run(()=>api(`${base}/order`,'PUT',{ids:moveTo(channels.map(c=>c.id),from,to)}).then(changed));
  return <>
    <SectionHead title="Plex channels" description="24/7 channels from your Plex library.">
      {channels.length>0&&<button className="primary" onClick={()=>setCreate(true)}><Icon name="plus" size={16}/>New channel</button>}
    </SectionHead>
    {ordering.error&&<ErrorNotice message={ordering.error}/>}
    {list.loading&&!list.data?<Loading/>:list.error?<ErrorNotice message={list.error.message} retry={list.reload}/>:channels.length?<>
      <p className="muted small list-note">Live TV lists these first, in this order.</p>
      <ul className="source-rows">{channels.map((c,i)=><li key={c.id} className="source-item" {...drag('channels',i,reorder,channels.length>1&&!ordering.busy)}>
        {channels.length>1&&<MoveButtons name={c.name} index={i} count={channels.length} disabled={ordering.busy} onMove={to=>reorder(i,to)}/>}
        <button className="source-row" onClick={()=>setOpen({id:c.id})}>
          <Logo channel={c}/>
          <span className="source-row-main"><strong>{c.name}</strong><small>{c.live&&c.enabled&&c.current?<>Now: {c.current.title}{c.current.subtitle&&` · ${c.current.subtitle}`}</>:c.programs?`${plural(c.programs,'program')} · ${duration(c.runtimeMs)} per loop`:'Add programs to get started'}</small></span>
          <span className="source-row-tags"><StatusBadge channel={c}/></span><Icon name="next" size={18}/>
        </button></li>)}</ul>
    </>:<div className="channel-intro">
      <h3>Create your first channel</h3>
      <Steps/>
      <button className="primary" onClick={()=>setCreate(true)}><Icon name="plus" size={16}/>New channel</button>
    </div>}
    {create&&<CreateChannel onClose={()=>setCreate(false)} created={c=>{list.reload();setOpen({id:c.id,adding:true});}}/>}
  </>;
}
// The three steps from an empty channel to one on air; `at` marks the current one.
function Steps({at}:{at?:number}) {
  const steps=[['Add programs','Movies, shows, seasons, Plex collections or whole categories.'],['Put them in order','Drag to reorder, or use Arrange to shuffle or mix shows together.'],['Publish','The channel appears in Live TV and plays around the clock.']];
  return <ol className="channel-steps">{steps.map(([title,text],i)=><li key={title} className={at===i?'current':''}><span className="step-number" aria-hidden="true">{i+1}</span><span><strong>{title}</strong><small>{text}</small></span></li>)}</ol>;
}
function CreateChannel({onClose,created}:{onClose:()=>void;created:(c:Detail)=>void}) {
  const [name,setName]=useState(''),[number,setNumber]=useState(''),mutation=useMutation(changed);
  return <Modal title="New channel" onClose={()=>{if(!mutation.busy)onClose();}}>
    <h2>New channel</h2>
    <p className="muted">Nothing airs until you publish.</p>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    <form className="form-stack" onSubmit={e=>{e.preventDefault();void mutation.run(async()=>{const c=await api<Detail>(base,'POST',{name,...(number?{number:Number(number)}:{})});onClose();created(c);});}}>
      <label>Channel name<input value={name} onChange={e=>setName(e.target.value)} required maxLength={120} autoFocus placeholder="Saturday Morning Cartoons"/></label>
      <label>Channel number <span className="muted">(optional)</span><input type="number" min="1" max="999999" value={number} onChange={e=>setNumber(e.target.value)} placeholder="Next free number"/><small>Shared with IPTV.</small></label>
      <div className="button-row"><button className="primary" disabled={mutation.busy||!name.trim()}>Next: add programs</button><button type="button" disabled={mutation.busy} onClick={onClose}>Cancel</button></div>
    </form>
  </Modal>;
}

const tabs=[['programs','Programs'],['sources','Shows & collections'],['details','Details']] as const;
function ChannelEditor({id,back,startAdding}:{id:string;back:()=>void;startAdding?:boolean}) {
  const detail=useApi<Detail>(`${base}/${id}`),[local,setLocal]=useState<Detail>(),[tab,setTab]=useState<string>('programs'),[publish,setPublish]=useState(false),[notice,setNotice]=useState('');
  const mutation=useMutation(changed);
  const view=local&&(!detail.data||local.revision>=detail.data.revision)?local:detail.data;
  if(detail.loading&&!view)return <Loading/>;
  if(!view)return <ErrorNotice message={detail.error?.message??'Channel could not be loaded.'} retry={detail.reload}/>;
  // Every draft operation returns the updated channel, so rapid edits never send a stale revision.
  const apply=(path:string,method:string,body:Record<string,unknown>,done?:(r:unknown)=>void)=>void mutation.run(async()=>{
    setNotice('');const result=await api<Detail|AddResult>(`${base}/${id}${path}`,method,{expectedRevision:view.revision,...body});
    setLocal('channel' in result?result.channel:result);done?.(result);
  });
  const unpublished=view.entries.length>0&&(!view.live||view.changed),blocked=view.entries.some(e=>e.issue);
  return <section className="source-detail channel-editor">
    <button className="back-link" onClick={back}><Icon name="back" size={16}/>All channels</button>
    <div className="source-head">
      <div className="source-title"><Logo channel={view}/><div><h2>{view.name}</h2>
        <p className="muted small"><StatusBadge channel={view}/> {view.live&&view.current?<>Now: <strong>{view.current.title}</strong>{view.current.subtitle&&` · ${view.current.subtitle}`} · until {clock(view.current.end)}</>:view.entries.length?`${plural(view.entries.length,'program')} · ${duration(view.runtimeMs)} per loop`:null}</p></div></div>
    </div>
    {view.live&&!view.enabled&&<div className="notice subtle"><span>Hidden from Live TV. Its schedule keeps running, so it’s on time when you show it again.</span><button onClick={()=>setTab('details')}>Change</button></div>}
    {view.pending&&!view.changed&&<div className="notice subtle"><span>Your last publish goes on air at {when(view.pending.effectiveAt)}, when the current program ends, starting with <strong>{view.pending.next}</strong>.</span></div>}
    {mutation.error&&<ErrorNotice message={mutation.error} dismiss={()=>mutation.setError('')}/>}{notice&&<p className="success" role="status">{notice}</p>}
    <div className="subtabs" role="tablist" aria-label={`${view.name} settings`}>{tabs.map(([t,label])=><button key={t} role="tab" aria-selected={tab===t} onClick={()=>setTab(t)}>{label}{t==='programs'&&<span className="count">{view.entries.length}</span>}{t==='sources'&&view.sources.length>0&&<span className="count">{view.sources.length}</span>}</button>)}</div>
    <div role="tabpanel" className="source-panel">
      {tab==='programs'?<ProgramsPanel view={view} busy={mutation.busy} apply={apply} setNotice={setNotice} startAdding={startAdding}/>
        :tab==='sources'?<SourcesPanel view={view} updated={c=>setLocal(c)} setNotice={setNotice} addPrograms={()=>setTab('programs')}/>
        :<DetailsPanel view={view} saved={c=>{setLocal(c);setNotice('Channel details saved.');}} removed={()=>{changed();back();}}/>}
    </div>
    {unpublished&&<div className="publish-bar" role="region" aria-label="Unpublished changes">
      <span><strong>{view.live?'You have changes that aren’t on air yet':'This channel isn’t on air yet'}</strong>
        <small>{blocked?'Remove the programs that can’t play before publishing.':view.live?'The current program finishes first.':'Goes on air right away.'}</small></span>
      <div className="button-row">
        {view.live&&<button disabled={mutation.busy} onClick={()=>apply('/draft/discard','POST',{},()=>setNotice('Changes discarded. The list is back to what’s on air.'))}>Discard changes</button>}
        <button className="primary" disabled={mutation.busy||blocked} onClick={()=>view.live?setPublish(true):apply('/publish','POST',{expectedPublication:view.publicationRevision},()=>setNotice('Published. The channel is on air in Live TV.'))}>{view.live?'Review & publish':mutation.busy?'Publishing…':'Publish channel'}</button>
      </div>
    </div>}
    {publish&&<PublishDialog view={view} onClose={()=>setPublish(false)} published={(c,at)=>{setLocal(c);setPublish(false);setNotice(at>Date.now()+1000?`Published. The new list takes over at ${when(at)}, when the current program ends.`:'Published. The channel is on air in Live TV.');}}/>}
  </section>;
}

type Apply=(path:string,method:string,body:Record<string,unknown>,done?:(r:unknown)=>void)=>void;
type AddOptions={specials:boolean;autoAdd:boolean;atStart:boolean};
const PAGE=200;
const matches=(e:Entry,q:string)=>`${e.showTitle??''} ${e.title} ${e.kind==='episode'?episodeLabel(e):e.year??''}`.toLocaleLowerCase().includes(q);
function ProgramsPanel({view,busy,apply,setNotice,startAdding}:{view:Detail;busy:boolean;apply:Apply;setNotice:(s:string)=>void;startAdding?:boolean}) {
  const [selected,setSelected]=useState<string[]>([]),[shown,setShown]=useState(PAGE),[picker,setPicker]=useState(!!startAdding&&!view.entries.length),[arranging,setArranging]=useState(false),drag=useDragOrder();
  const [filter,setFilter]=useState(''),[undo,setUndo]=useState<{ids:string[];revision:number;label:string}>();
  const entries=view.entries,ids=entries.map(e=>e.entryId),q=filter.trim().toLocaleLowerCase();
  const sources=new Map(view.sources.map(s=>[s.id,s]));
  const rows=entries.map((e,i)=>({e,i})).filter(r=>!q||matches(r.e,q)),visible=rows.slice(0,shown),filtering=!!q;
  useEffect(()=>{setSelected(s=>s.filter(id=>ids.includes(id)));},[view.revision]);
  const order=(next:string[],done?:(r:unknown)=>void)=>apply('/draft/order','PUT',{entryIds:next},done);
  const remove=(drop:string[])=>{order(ids.filter(id=>!drop.includes(id)),()=>setNotice(`Removed ${plural(drop.length,'program')}. Discard changes to bring ${drop.length===1?'it':'them'} back.`));setSelected([]);};
  const moveSelected=(top:boolean)=>{const chosen=ids.filter(id=>selected.includes(id)),rest=ids.filter(id=>!selected.includes(id));order(top?[...chosen,...rest]:[...rest,...chosen]);};
  const reorder=(from:number,to:number)=>order(moveTo(ids,from,to));
  const problems=entries.filter(e=>e.issue);
  const allVisible=visible.length>0&&visible.every(r=>selected.includes(r.e.entryId));
  const add=(picked:string[],o:AddOptions)=>apply('/draft/add','POST',{ids:picked,specials:o.specials,autoAdd:o.autoAdd,...(o.atStart?{at:0}:{})},r=>{
    const {added,skipped,specials:left,issues:bad}=r as AddResult;setPicker(false);
    setNotice([`Added ${plural(added,'program')}${o.atStart?' to the top of the list':''}.`,skipped&&`${plural(skipped,'title')} already on the channel ${skipped===1?'was':'were'} skipped.`,left&&`${plural(left,'special')} left out.`,bad&&`${bad} can’t play on a channel.`].filter(Boolean).join(' '));
  });
  return <>
    {!entries.length?<div className="channel-intro compact">
      <h3>What should {view.name} play?</h3>
      <Steps at={0}/>
      <button className="primary" disabled={busy} onClick={()=>setPicker(true)}><Icon name="plus" size={16}/>Add programs</button>
    </div>:<>
      <div className="program-toolbar">
        <button className="primary" disabled={busy} onClick={()=>setPicker(true)}><Icon name="plus" size={16}/>Add programs</button>
        <button disabled={busy||entries.length<2} onClick={()=>setArranging(true)}><Icon name="sort" size={16}/>Arrange</button>
        <label className="search-field program-filter"><Icon name="search" size={16}/><input aria-label="Find in this list" placeholder="Find in this list" value={filter} maxLength={120} onChange={e=>{setFilter(e.target.value);setShown(PAGE);}}/></label>
      </div>
      {problems.length>0&&<div className="notice error" role="alert"><span>{plural(problems.length,'program')} can’t play on a channel and must be removed before publishing. {issueHelp}</span><button disabled={busy} onClick={()=>remove(problems.map(e=>e.entryId))}>Remove them</button></div>}
      {undo&&undo.revision===view.revision&&<div className="notice subtle" role="status"><span>{undo.label}</span><button disabled={busy} onClick={()=>order(undo.ids,()=>{setUndo(undefined);setNotice('Order restored.');})}>Undo</button></div>}
      {selected.length>0&&<div className="bulk-bar" role="region" aria-label="Selected programs"><strong>{selected.length} selected</strong><div className="button-row">
        <button disabled={busy} onClick={()=>moveSelected(true)}>Move to top</button><button disabled={busy} onClick={()=>moveSelected(false)}>Move to bottom</button>
        <button disabled={busy} onClick={()=>apply('/draft/duplicate','POST',{entryIds:selected})} title="Adds a second airing right after each">Air twice</button>
        <button disabled={busy} className="danger" onClick={()=>remove(selected)}>Remove</button><button className="text-button" onClick={()=>setSelected([])}>Clear</button></div></div>}
      <div className="program-head">
        <label className="checkbox-label"><input type="checkbox" checked={allVisible} disabled={!visible.length} onChange={e=>{const on=e.target.checked,v=visible.map(r=>r.e.entryId);setSelected(s=>on?[...new Set([...s,...v])]:s.filter(id=>!v.includes(id)));}}/>{filtering?`${plural(rows.length,'match')}`:`${plural(entries.length,'program')}`}</label>
        <span className="muted small">{filtering?'Clear the search to reorder':`${duration(view.runtimeMs)} per loop, then it starts over`}</span>
      </div>
      {!rows.length?<p className="muted program-none">Nothing in this list matches “{filter}”.</p>:<ol className="program-list">{visible.map(({e,i})=>{const source=e.sourceId?sources.get(e.sourceId):undefined;return <li key={e.entryId} className={`program-row ${selected.includes(e.entryId)?'selected':''}`} {...drag('programs',i,reorder,!busy&&!filtering&&entries.length>1)}>
        <input type="checkbox" aria-label={`Select ${e.showTitle??e.title} ${e.kind==='episode'?episodeLabel(e):''}`} checked={selected.includes(e.entryId)} onChange={ev=>{const on=ev.target.checked;setSelected(s=>on?[...s,e.entryId]:s.filter(id=>id!==e.entryId));}}/>
        <span className="program-index" aria-hidden="true">{i+1}</span>
        <Thumb src={poster(e)} icon={kindIcon[e.kind]}/>
        <span className="program-text">{e.kind==='episode'?<><strong>{e.showTitle??'Episode'}</strong><small>{episodeLabel(e)} · {e.title}{source&&grouped(source.kind)&&` · from ${source.title}`}</small></>:<><strong>{e.title}</strong><small>Movie{e.year?` · ${e.year}`:''}{source&&` · from ${source.title}`}</small></>}</span>
        {e.addedAuto&&<span className="badge" title={`Added automatically ${stamp(e.addedAuto)}`}>New</span>}
        {e.issue&&<span className="badge danger" title={e.issue==='incompatible'?issueHelp:undefined}>{issues[e.issue]}</span>}
        <span className="program-runtime">{duration(e.durationMs)}</span>
        <span className="program-actions"><MoveButtons name={e.title} index={i} count={entries.length} disabled={busy||filtering} onMove={to=>reorder(i,to)}/><button type="button" className="icon-button" aria-label={`Remove ${e.title}`} disabled={busy} onClick={()=>remove([e.entryId])}><Icon name="close" size={14}/></button></span>
      </li>;})}</ol>}
      {rows.length>PAGE&&<div className="list-footer"><span className="muted small">Showing {Math.min(shown,rows.length)} of {rows.length}</span>{shown<rows.length&&<button onClick={()=>setShown(n=>n+PAGE)}>Show {Math.min(PAGE,rows.length-shown)} more</button>}</div>}
    </>}
    {picker&&<ProgramPicker busy={busy} hasPrograms={entries.length>0} onClose={()=>setPicker(false)} add={add}/>}
    {arranging&&<ArrangeDialog busy={busy} onClose={()=>setArranging(false)} run={(arrange,label)=>apply('/draft/arrange','POST',{arrange},r=>{
      const next=r as Detail,kept=new Set(next.entries.map(e=>e.entryId));setArranging(false);
      // Reorders can be undone in one step; tools that drop or copy programs go back with Discard changes.
      if(ids.every(id=>kept.has(id))&&next.entries.length===ids.length)setUndo({ids,revision:next.revision,label:`${label} done.`});
      else setNotice(`${label} done. Discard changes to undo it.`);
    })}/>}
  </>;
}

const tools=[
  ['shuffle','Shuffle','Puts every program in random order.','Change the order'],
  ['blockShuffle','Shuffle in blocks','Shuffles runs of a few episodes at a time, keeping each show in episode order.','Change the order'],
  ['interleave','Mix shows together','Plays one program from each show in turn, keeping each show in episode order. Movies count as one show.','Change the order'],
  ['sortShows','Sort by show','Shows A–Z, each in season and episode order, then movies A–Z.','Change the order'],
  ['sortDate','Sort by release date','Oldest first. Programs without a date go last.','Change the order'],
  ['removeDuplicates','Remove repeats','Keeps only the first airing of each title.','Clean up'],
  ['removeSpecials','Remove specials','Removes season 0 episodes.','Clean up'],
  ['replicate','Repeat the whole list','Adds copies of the list after itself.','Make the loop longer'],
] as const;
type Tool=typeof tools[number][0];
const toolGroups=[...new Set(tools.map(t=>t[3]))];
function ArrangeDialog({busy,onClose,run}:{busy:boolean;onClose:()=>void;run:(arrange:Record<string,unknown>,label:string)=>void}) {
  const [tool,setTool]=useState<Tool>('shuffle'),[size,setSize]=useState(2),[times,setTimes]=useState(2);
  const label=tools.find(t=>t[0]===tool)![1];
  return <Modal title="Arrange programs" onClose={()=>{if(!busy)onClose();}}>
    <h2>Arrange programs</h2>
    <p className="muted">Rewrites the whole list in one step. Nothing changes on air until you publish.</p>
    <form className="form-stack" onSubmit={e=>{e.preventDefault();run({tool,...(tool==='blockShuffle'?{size}:tool==='replicate'?{times}:{})},label);}}>
      {toolGroups.map(heading=><fieldset key={heading} className="arrange-choices"><legend>{heading}</legend>{tools.filter(t=>t[3]===heading).map(([value,text,help])=><label key={value} className={`arrange-choice ${tool===value?'selected':''}`}><input type="radio" name="tool" checked={tool===value} onChange={()=>setTool(value)}/><span><strong>{text}</strong><small>{help}</small>
        {value==='blockShuffle'&&tool===value&&<span className="arrange-option">Episodes per block <input type="number" min="1" max="20" required value={size} onChange={e=>setSize(Number(e.target.value))}/></span>}
        {value==='replicate'&&tool===value&&<span className="arrange-option">Total copies <input type="number" min="2" max="10" required value={times} onChange={e=>setTimes(Number(e.target.value))}/></span>}
      </span></label>)}</fieldset>)}
      <div className="button-row"><button className="primary" disabled={busy}>{label}</button><button type="button" disabled={busy} onClick={onClose}>Cancel</button></div>
    </form>
  </Modal>;
}

// The Plex picker: browse a Movies or TV library by title, Plex collection or category (genre), drill into shows and
// seasons, and tick what to add. Shows, seasons, collections and categories are added whole, in episode order.
type Crumb={id:string;title:string;type:'show'|'season'};
type PickKind=CatalogItem['type']|'collection'|'genre';
type Pick={title:string;type:PickKind;tv:boolean};
type Picked=Map<string,Pick>;
type Mode='titles'|'collections'|'categories';
const modes=[['titles','Titles'],['collections','Collections'],['categories','Categories']] as const;
const MAX_PICK=100;
const pickTitle=(item:CatalogItem)=>item.type==='episode'?`${item.showTitle??''} ${episodeLabel({season:item.seasonNumber,episode:item.episodeNumber})}`.trim():item.type==='season'?`${item.parentTitle??''} · ${item.title}`:item.title;
function ProgramPicker({busy,hasPrograms,onClose,add}:{busy:boolean;hasPrograms:boolean;onClose:()=>void;add:(ids:string[],o:AddOptions)=>void}) {
  const libraries=useApi<{libraries:{key:string;title:string;type:string}[]}>('/libraries'),usable=(libraries.data?.libraries??[]).filter(l=>l.type==='movie'||l.type==='show');
  const [library,setLibrary]=useState<string>(),[mode,setMode]=useState<Mode>('titles'),[search,setSearch]=useState(''),[path,setPath]=useState<Crumb[]>([]),[picked,setPicked]=useState<Picked>(new Map());
  const [specials,setSpecials]=useState(false),[autoAdd,setAutoAdd]=useState(false),[atStart,setAtStart]=useState(false);
  const q=useDebounced(search),current=library??usable[0]?.key,lib=usable.find(l=>l.key===current),tv=lib?.type==='show',at=mode==='titles'?path.at(-1):undefined;
  const toggle=(id:string,pick:Pick)=>setPicked(old=>{const next=new Map(old);if(next.has(id))next.delete(id);else if(next.size<MAX_PICK)next.set(id,pick);return next;});
  const toggleItem=(item:CatalogItem)=>toggle(item.id,{title:pickTitle(item),type:item.type,tv:item.type!=='movie'});
  const open=(item:CatalogItem)=>{if(item.type==='show'||item.type==='season')setPath(p=>[...p,{id:item.id,title:item.title,type:item.type as 'show'|'season'}]);};
  const picks=[...picked.values()],groups=picks.some(p=>p.type!=='movie'&&p.type!=='episode'),anyGroup=picks.some(p=>grouped(p.type));
  const specialsApply=picks.some(p=>p.tv&&(p.type==='show'||grouped(p.type)));
  const results:ResultProps={picked,toggle,toggleItem,open};
  return <Modal title="Add programs" onClose={()=>{if(!busy)onClose();}}>
    <div className="picker">
      <div><h2>Add programs</h2></div>
      {libraries.error?<ErrorNotice message={libraries.error.message} retry={libraries.reload}/>:!libraries.data?<Loading/>:!usable.length?<p className="muted">No Movies or TV libraries are shared with this account.</p>:<>
        <div className="picker-head">
          {usable.length>1&&<label className="picker-library">Library<select value={current} onChange={e=>{setLibrary(e.target.value);setPath([]);}}>{usable.map(l=><option key={l.key} value={l.key}>{l.title}</option>)}</select></label>}
          <div className="segmented" role="group" aria-label="Browse by">{modes.map(([m,label])=><button key={m} type="button" aria-pressed={mode===m} onClick={()=>{setMode(m);setPath([]);}}>{label}</button>)}</div>
          {!at&&<label className="search-field"><Icon name="search" size={16}/><input aria-label={`Search ${mode}`} placeholder={mode==='titles'?`Search ${lib?.title??'titles'}`:mode==='collections'?'Find a collection':'Find a category'} value={search} maxLength={120} onChange={e=>setSearch(e.target.value)} autoFocus/></label>}
        </div>
        {path.length>0&&mode==='titles'&&<nav className="picker-crumbs" aria-label="Location"><button className="link-button" onClick={()=>setPath([])}><Icon name="back" size={14}/>{lib?.title??'Library'}</button>{path.map((c,i)=><span key={c.id}> › {i<path.length-1?<button className="link-button" onClick={()=>setPath(p=>p.slice(0,i+1))}>{c.title}</button>:<strong>{c.title}</strong>}</span>)}</nav>}
        <div className="picker-results">{current&&(mode==='collections'?<CollectionResults key={current} library={current} q={search} {...results}/>
          :mode==='categories'?<CategoryResults key={current} library={current} tv={tv} q={search} {...results}/>
          :at?<ChildResults key={at.id} parent={at} {...results}/>:<LibraryResults key={`${current}:${q}`} library={current} q={q} {...results}/>)}</div>
      </>}
      {picked.size>0&&<div className="pick-tray" aria-label="Selected">{[...picked].map(([id,p])=><button key={id} type="button" className="pick-chip" onClick={()=>setPicked(old=>{const next=new Map(old);next.delete(id);return next;})} aria-label={`Remove ${p.title} from the selection`}><Icon name={kindIcon[p.type]??'movies'} size={13}/><span>{p.title}</span><Icon name="close" size={11}/></button>)}
        <button type="button" className="text-button" onClick={()=>setPicked(new Map())}>Clear all</button></div>}
      {picked.size>0&&<div className="picker-options">
        {specialsApply&&<label className="checkbox-label"><input type="checkbox" checked={specials} onChange={e=>setSpecials(e.target.checked)}/>Include specials (season 0)</label>}
        {groups&&<label className="checkbox-label"><input type="checkbox" checked={autoAdd} onChange={e=>setAutoAdd(e.target.checked)}/>{anyGroup?'Add new titles automatically when they arrive in Plex':'Add new episodes automatically when they arrive in Plex'}</label>}
        {hasPrograms&&<label className="checkbox-label"><input type="checkbox" checked={atStart} onChange={e=>setAtStart(e.target.checked)}/>Add to the top of the list instead of the end</label>}
      </div>}
      <div className="picker-foot">
        <span className="grow muted small">{picked.size?picked.size>=MAX_PICK?`${MAX_PICK} selected, the most at once. Add these first.`:anyGroup?'Big collections and categories can take a moment to add.':'':'Nothing selected yet'}</span>
        <button disabled={busy} onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy||!picked.size} onClick={()=>add([...picked.keys()],{specials:specialsApply&&specials,autoAdd:groups&&autoAdd,atStart:hasPrograms&&atStart})}>{busy?'Adding…':picked.size?`Add ${picked.size} to channel`:'Add to channel'}</button>
      </div>
    </div>
  </Modal>;
}
type ResultProps={picked:Picked;toggle:(id:string,pick:Pick)=>void;toggleItem:(item:CatalogItem)=>void;open:(item:CatalogItem)=>void};
function LibraryResults({library,q,...rest}:{library:string;q:string}&ResultProps) {
  const query=new URLSearchParams({limit:'48',sort:'title',...(q?{q}:{})}).toString();
  const list=useInfinitePages<CatalogPage>(offset=>`/catalog/libraries/${library}/items?${query}&offset=${offset}`,48,`${library}:${query}`);
  return <PickList pages={list.pages} loading={list.loading} more={list.more} loadMore={list.loadMore} sentinel={list.sentinel} empty={q?'No matching titles.':'This library is empty.'} {...rest}/>;
}
function ChildResults({parent,...rest}:{parent:Crumb}&ResultProps) {
  const list=useInfinitePages<CatalogPage>(offset=>`/catalog/items/${parent.id}/children?limit=60&offset=${offset}`,60,parent.id);
  return <PickList pages={list.pages} loading={list.loading} more={list.more} loadMore={list.loadMore} sentinel={list.sentinel} empty={parent.type==='show'?'No seasons.':'No episodes.'} {...rest}/>;
}
function PickRow({id,pick,icon,src,title,detail,picked,toggle,children}:{id:string;pick:Pick;icon:string;src?:string;title:string;detail:string;picked:Picked;toggle:(id:string,pick:Pick)=>void;children?:ReactNode}) {
  const on=picked.has(id);
  return <li className={on?'selected':''}>
    <label className="pick-main"><input type="checkbox" checked={on} disabled={!on&&picked.size>=MAX_PICK} onChange={()=>toggle(id,pick)}/><Thumb src={src} icon={icon}/><span className="program-text"><strong>{title}</strong><small>{detail}</small></span></label>
    {children}
  </li>;
}
function PickList({pages,loading,more,loadMore,sentinel,empty,picked,toggle,toggleItem,open}:{pages:(CatalogPage|undefined)[];loading:boolean;more:boolean;loadMore:()=>void;sentinel:ReturnType<typeof useInfinitePages>['sentinel'];empty:string}&ResultProps) {
  const items=pages.flatMap(p=>p?.items??[]);
  if(!items.length)return loading?<Loading/>:pages[0]===undefined?<ErrorNotice message="Titles could not be loaded."/>:<p className="muted picker-empty">{empty}</p>;
  return <><ul className="pick-list">{items.map(item=>{const browsable=item.type==='show'||item.type==='season';return <PickRow key={item.id} id={item.id} pick={{title:pickTitle(item),type:item.type,tv:item.type!=='movie'}} picked={picked} toggle={()=>toggleItem(item)} icon={kindIcon[item.type]!}
    src={item.type==='episode'?item.showPosterUrl??item.posterUrl:item.posterUrl??item.showPosterUrl} title={item.type==='episode'?`${item.episodeNumber??'?'}. ${item.title}`:item.title}
    detail={item.type==='show'?`TV show${item.year?` · ${item.year}`:''}${item.episodeCount?` · ${plural(item.episodeCount,'episode')}`:''} · tick to add every episode`:item.type==='season'?`${item.episodeCount?plural(item.episodeCount,'episode'):'Season'} · tick to add the season`:[item.year,duration(item.durationMs)].filter(Boolean).join(' · ')}>
    {browsable&&<button className="pick-open" onClick={()=>open(item)} aria-label={`Browse ${item.title}`}>{item.type==='show'?'Seasons':'Episodes'}<Icon name="next" size={14}/></button>}
  </PickRow>;})}</ul><div ref={sentinel} className="list-more">{more?<button onClick={loadMore}>Load more</button>:loading&&'Loading…'}</div></>;
}
const find=(title:string,q:string)=>!q.trim()||title.toLocaleLowerCase().includes(q.trim().toLocaleLowerCase());
function CollectionResults({library,q,picked,toggle}:{library:string;q:string}&ResultProps) {
  const list=useApi<{collections:{id:string;title:string;count?:number;kind:'movie'|'show'}[]}>(`${base}/libraries/${library}/collections`);
  if(list.error)return <ErrorNotice message={list.error.message} retry={list.reload}/>;
  if(!list.data)return <Loading/>;
  const shown=list.data.collections.filter(c=>find(c.title,q));
  if(!shown.length)return <p className="muted picker-empty">{q?'No matching collections.':'This library has no Plex collections. Make one in Plex, then come back.'}</p>;
  return <ul className="pick-list">{shown.map(c=><PickRow key={c.id} id={c.id} pick={{title:c.title,type:'collection',tv:c.kind==='show'}} picked={picked} toggle={toggle} icon="collection" title={c.title}
    detail={`${c.count!==undefined?`${plural(c.count,c.kind==='show'?'show':'movie')} · `:''}${c.kind==='show'?'every episode, show by show':'in the collection’s order'}`}/>)}</ul>;
}
function CategoryResults({library,tv,q,picked,toggle}:{library:string;tv:boolean;q:string}&ResultProps) {
  const list=useApi<{genres:{id:string;title:string}[]}>(`/catalog/libraries/${library}/genres`);
  if(list.error)return <ErrorNotice message={list.error.message} retry={list.reload}/>;
  if(!list.data)return <Loading/>;
  const shown=list.data.genres.filter(g=>find(g.title,q));
  if(!shown.length)return <p className="muted picker-empty">{q?'No matching categories.':'This library has no categories.'}</p>;
  return <ul className="pick-list">{shown.map(g=><PickRow key={g.id} id={`genre:${library}:${g.id}`} pick={{title:`${g.title} ${tv?'shows':'movies'}`,type:'genre',tv}} picked={picked} toggle={toggle} icon="tag" title={g.title}
    detail={tv?`Every episode of every ${g.title} show, shows A–Z`:`Every ${g.title} movie, A–Z`}/>)}</ul>;
}

// Automatic new titles, per show, season, collection or category added to the channel. Off until turned on; turning it
// off keeps what was already added. New titles go on air at the end of whatever is airing, with no publish needed.
const holds:Record<Issue,string>={no_media:'no playable file yet',no_duration:'runtime unknown',incompatible:'can’t play on a channel'};
function syncSummary(s:Source) {
  if(s.lastError)return `Last check failed (${code(s.lastError)}). Programs are unchanged; it will try again.`;
  const r=s.lastResult;if(!r||!s.lastChecked)return s.autoAdd?'Not checked yet':undefined;
  const at=stamp(s.lastChecked),word=grouped(s.kind)?'title':'episode';
  if(r.waiting)return `Waiting for a Plex admin token (Admin › Connections) · ${at}`;
  if(r.seeded)return `Now keeping track of new ${word}s · ${at}`;
  return r.added?`Added ${plural(r.added,`new ${word}`)} · ${at}`:`Up to date · checked ${at}`;
}
function SourcesPanel({view,updated,setNotice,addPrograms}:{view:Detail;updated:(c:Detail)=>void;setNotice:(s:string)=>void;addPrograms:()=>void}) {
  const mutation=useMutation(changed),enabled=view.sources.filter(s=>s.autoAdd).length,[removing,setRemoving]=useState<Source>();
  const toggle=(s:Source,on:boolean)=>void mutation.run(async()=>{setNotice('');updated(await api<Detail>(`${base}/${view.id}/sources/${s.id}`,'PUT',{autoAdd:on}));});
  const check=()=>void mutation.run(async()=>{setNotice('');const r=await api<{checked:number;added:number;failed:number;channel:Detail}>(`${base}/${view.id}/sync`,'POST',{});updated(r.channel);
    setNotice([r.added?`Added ${plural(r.added,'new program')}.`:'Nothing new in Plex.',r.added&&view.live?'They go on air at the end of the current program.':'',r.failed?`${plural(r.failed,'source')} couldn’t be checked.`:''].filter(Boolean).join(' '));});
  if(!view.sources.length)return <Empty title="No shows or collections yet">When you add a whole show, season, collection or category, it’s listed here. You can then have new episodes and titles added automatically, or take the whole group off the channel at once. <button className="link-button" onClick={addPrograms}>Go to Programs</button></Empty>;
  return <>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    <div className="program-toolbar"><span className="muted small grow-left">Auto-add checks Plex hourly. Removed titles aren’t added back.</span>
      <button disabled={mutation.busy||!enabled} onClick={check} title={enabled?undefined:'Turn on automatic adding for at least one first'}><Icon name="restart" size={16}/>{mutation.busy?'Checking…':'Check Plex now'}</button></div>
    <ul className="source-rows">{view.sources.map(s=>{const summary=syncSummary(s),review=s.lastResult?.review??[];return <li key={s.id} className="show-source">
      <div className="show-source-head"><Thumb icon={kindIcon[s.kind]}/><span className="program-text"><strong>{s.title}</strong><small>{kindLabel(s)} · {plural(s.programs,'program')} on this channel</small></span>
        <button className="text-button danger-text" disabled={mutation.busy} onClick={()=>setRemoving(s)}>Remove</button></div>
      <Switch label={grouped(s.kind)?'Add new titles automatically':'Add new episodes automatically'} description={summary} checked={s.autoAdd} disabled={mutation.busy} onChange={on=>toggle(s,on)}/>
      {s.autoAdd&&!!s.lastResult?.titles.length&&<p className="muted small show-detail">Last added: {s.lastResult.titles.slice(0,5).join(', ')}{s.lastResult.titles.length>5&&` and ${s.lastResult.titles.length-5} more`}</p>}
      {review.length>0&&<p className="small show-detail warning-text">Waiting: {review.slice(0,5).map(r=>`${r.title} (${holds[r.issue]})`).join(', ')}{review.length>5&&` and ${review.length-5} more`}. These are tried again on the next check.</p>}
    </li>;})}</ul>
    {removing&&<Modal title="Remove from channel" onClose={()=>{if(!mutation.busy)setRemoving(undefined);}}>
      <h2>Remove {removing.title}?</h2>
      <p>Its {plural(removing.programs,'program')} come off the list and it’s no longer checked for new titles. {view.live?'What’s on air changes only when you publish.':''} Nothing in Plex changes.</p>
      {mutation.error&&<ErrorNotice message={mutation.error}/>}
      <div className="button-row"><button className="danger" disabled={mutation.busy} onClick={()=>void mutation.run(async()=>{updated(await api<Detail>(`${base}/${view.id}/sources/${removing.id}`,'DELETE',{expectedRevision:view.revision}));setNotice(`Removed ${removing.title}.${view.live?' Publish to take it off the air.':''}`);setRemoving(undefined);})}>Remove</button><button disabled={mutation.busy} onClick={()=>setRemoving(undefined)}>Cancel</button></div>
    </Modal>}
  </>;
}

function PublishDialog({view,onClose,published}:{view:Detail;onClose:()=>void;published:(c:Detail,effectiveAt:number)=>void}) {
  const preview=useApi<Preview>(`${base}/${view.id}/preview?revision=${view.revision}`),mutation=useMutation(changed),p=preview.data;
  return <Modal title="Publish channel" onClose={()=>{if(!mutation.busy)onClose();}}>
    <h2>{view.live?'Publish changes':'Put this channel on air'}</h2>
    {preview.loading&&!p?<Loading/>:preview.error?<ErrorNotice message={preview.error.message} retry={preview.reload}/>:p&&<>
      {p.current?<div className="handoff"><div><small>ON NOW · FINISHES AS PLANNED</small><strong>{p.current.title}</strong>{p.current.subtitle&&<span>{p.current.subtitle}</span>}<span>Ends {when(p.current.end)}</span></div><Icon name="next" size={20}/><div><small>THEN, FROM THE NEW LIST</small><strong>{p.upcoming[0]!.title}</strong>{p.upcoming[0]!.subtitle&&<span>{p.upcoming[0]!.subtitle}</span>}<span>Starts {when(p.effectiveAt)}</span></div></div>
        :<p>{view.name} appears in Live TV as soon as you publish, starting with <strong>{p.upcoming[0]!.title}</strong>. After the last program, the list starts over.</p>}
      {p.reason==='FIRST_ENTRY'&&<div className="notice"><span>The program on now isn’t in the new list, so after it ends the channel starts from the top of the list.</span></div>}
      {p.replacesPending&&<div className="notice"><span>This replaces the update that is already waiting to go on air.</span></div>}
      <h3 className="small-heading">Coming up</h3>
      <ol className="upcoming-list">{p.upcoming.map((s,i)=><li key={i}><time>{when(s.start)}</time><span><strong>{s.title}</strong>{s.subtitle&&<small>{s.subtitle}</small>}</span></li>)}</ol>
      {mutation.error&&<ErrorNotice message={mutation.error}/>}
      <div className="button-row"><button className="primary" disabled={mutation.busy} onClick={()=>void mutation.run(async()=>{const r=await api<{channel:Detail;effectiveAt:number}>(`${base}/${view.id}/publish`,'POST',{expectedRevision:view.revision,expectedPublication:p.publicationRevision});published(r.channel,r.effectiveAt);})}>{mutation.busy?'Publishing…':'Publish'}</button><button disabled={mutation.busy} onClick={onClose}>Cancel</button></div>
    </>}
  </Modal>;
}

// The shows and movies on the channel, A–Z, as the titles whose Plex logo it can use.
function logoTitles(entries:Entry[]) {
  const titles=new Map<string,string>();
  for(const e of entries){const id=e.kind==='episode'?e.showId:e.mediaId;if(id&&!titles.has(id))titles.set(id,(e.kind==='episode'?e.showTitle:undefined)??e.title);}
  return [...titles].map(([id,title])=>({id,title})).sort((a,b)=>a.title.localeCompare(b.title));
}
// The title's Plex logo, or its poster when it has none, as Live TV would show it.
function PlexLogoPreview({id}:{id:string}) {
  const [step,setStep]=useState(0);
  useEffect(()=>setStep(0),[id]);
  if(step>1)return <span className="plex-logo-preview muted">No Plex artwork</span>;
  return <span className="plex-logo-preview"><img src={`/api/v1/catalog/items/${id}/artwork?kind=${step?'poster':'logo'}`} alt="" onError={()=>setStep(s=>s+1)}/></span>;
}
function DetailsPanel({view,saved,removed}:{view:Detail;saved:(c:Detail)=>void;removed:()=>void}) {
  const [name,setName]=useState(view.name),[number,setNumber]=useState(String(view.number??'')),[summary,setSummary]=useState(view.summary),[logo,setLogo]=useState(view.logoUrl??''),[plexLogo,setPlexLogo]=useState(view.plexLogo??''),[enabled,setEnabled]=useState(view.enabled),[confirm,setConfirm]=useState(false);
  const mutation=useMutation(changed),remove=useMutation(()=>{});
  const dirty=name!==view.name||number!==String(view.number??'')||summary!==view.summary||logo!==(view.logoUrl??'')||plexLogo!==(view.plexLogo??'')||enabled!==view.enabled;
  const titles=logoTitles(view.entries),shown=plexLogo==='none'?undefined:plexLogo||view.mainTitle?.id;
  return <>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    <Card title="Channel details" description="Saves right away.">
      <form className="form-stack narrow" onSubmit={e=>{e.preventDefault();void mutation.run(async()=>saved(await api<Detail>(`${base}/${view.id}`,'PATCH',{expectedRevision:view.revision,name,summary,enabled,logoUrl:logo.trim()||null,plexLogo:plexLogo||null,...(number?{number:Number(number)}:{})})));}}>
        <label>Channel name<input value={name} onChange={e=>setName(e.target.value)} required maxLength={120}/></label>
        <label>Channel number<input type="number" min="1" max="999999" required value={number} onChange={e=>setNumber(e.target.value)}/><small>Shared with IPTV.</small></label>
        <label>Description <span className="muted">(optional)</span><textarea value={summary} onChange={e=>setSummary(e.target.value)} maxLength={1000} placeholder="Shown with the channel in Live TV"/></label>
        <label>Logo image address <span className="muted">(optional)</span><span className="logo-field">{logo.trim()&&/^https?:\/\//i.test(logo.trim())&&<img src={logo.trim()} alt="" className="logo-preview" onError={e=>{e.currentTarget.style.display='none';}} onLoad={e=>{e.currentTarget.style.display='';}}/>}<input type="url" value={logo} onChange={e=>setLogo(e.target.value)} maxLength={2000} placeholder="https://…/logo.png" spellCheck={false}/></span><small>PNG, JPEG, WebP or GIF up to 1 MB. Without one, Live TV uses the Plex logo below.</small></label>
        <label>Use Plex logo<span className="logo-field"><select value={plexLogo} onChange={e=>setPlexLogo(e.target.value)} disabled={!!logo.trim()}>
          <option value="">{view.mainTitle?`Automatic · ${view.mainTitle.title}`:'Automatic · no main show yet'}</option>
          {titles.map(t=><option key={t.id} value={t.id}>{t.title}</option>)}
          {plexLogo&&plexLogo!=='none'&&!titles.some(t=>t.id===plexLogo)&&<option value={plexLogo}>A title no longer on this channel</option>}
          <option value="none">None · show the channel’s initials</option>
        </select>{!logo.trim()&&shown&&<PlexLogoPreview id={shown}/>}</span>
          <small>{logo.trim()?'The logo address above is used instead.':'The current movie’s logo, or the channel’s main title.'}</small></label>
        <Switch label="Visible in Live TV" description="Hidden channels keep their schedule." checked={enabled} onChange={setEnabled}/>
        <div className="button-row"><button className="primary" disabled={mutation.busy||!dirty}>{dirty?'Save details':'Saved'}</button></div>
      </form>
    </Card>
    <Card title="Delete channel" className="danger-zone" description="Deletes its programs, schedule and number." actions={<button className="danger" onClick={()=>setConfirm(true)}>Delete channel</button>}/>
    {confirm&&<Modal title="Delete channel" onClose={()=>{if(!remove.busy)setConfirm(false);}}><h2>Delete {view.name}?</h2><p>This can’t be undone. Its {plural(view.entries.length,'program')} and schedule are deleted; nothing in Plex changes.</p>{remove.error&&<ErrorNotice message={remove.error}/>}<div className="button-row"><button className="danger" disabled={remove.busy} onClick={()=>void remove.run(async()=>{await api(`${base}/${view.id}`,'DELETE',{expectedRevision:view.revision});setConfirm(false);removed();})}>Delete channel</button><button disabled={remove.busy} onClick={()=>setConfirm(false)}>Cancel</button></div></Modal>}
  </>;
}
