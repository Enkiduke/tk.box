import {useEffect,useState} from 'react';
import type {CatalogItem,CatalogPage} from '../../../packages/contracts/src/index.js';
import {api} from './api.js';
import {useApi,useDebounced,useInfinitePages,invalidate,duration,clock} from './hooks.js';
import {Empty,ErrorNotice,Icon,Loading,Modal} from './components.js';
import {Card,SectionHead,Switch,move,plural,useMutation} from './settings-ui.js';

// Channel Manager: custom channels are lists of Plex movies and episodes that play one after another, looping.
// Every edit changes the draft; Publish hands over at the end of whatever is airing.
type Slot={title:string;subtitle?:string;start:number;end:number;entryId:string};
type Summary={id:string;name:string;summary:string;logoUrl:string|null;enabled:boolean;number:number|null;position:number|null;revision:number;programs:number;runtimeMs:number;issues:number;
  live:boolean;startedAt?:number;current?:Slot;pending?:{effectiveAt:number;next:string;nextSubtitle?:string};changed:boolean;publicationRevision:number};
type Issue='no_media'|'no_duration'|'incompatible';
type Entry={entryId:string;mediaId:string;kind:'movie'|'episode';title:string;showTitle?:string;showId?:string;season?:number;episode?:number;year?:number;date?:string;durationMs:number;sourceId?:string;issue?:Issue};
type Detail=Summary&{entries:Entry[];sources:{id:string;kind:'show'|'season';plexId:string;title:string}[]};
type Preview={current?:Slot;effectiveAt:number;reason:'INITIAL'|'SUCCESSOR'|'FIRST_ENTRY';upcoming:Slot[];replacesPending:boolean;publicationRevision:number};
type AddResult={channel:Detail;added:number;skipped:number;specials:number;issues:number};
const base='/admin/custom-channels';
const changed=()=>{invalidate(base);invalidate('/guide');};
const issues:Record<Issue,string>={no_media:'No playable file',no_duration:'Unknown runtime',incompatible:'Can’t play on a channel'};
const issueHelp='Video above 1080p that isn’t H.264 would need a 4K encode, which the server never does.';
const sameDay=(a:number,b:number)=>new Date(a).toDateString()===new Date(b).toDateString();
const when=(ms:number)=>sameDay(ms,Date.now())?clock(ms):`${new Intl.DateTimeFormat(undefined,{weekday:'short'}).format(ms)} ${clock(ms)}`;
const episodeLabel=(e:{season?:number;episode?:number})=>`S${e.season??'?'} E${e.episode??'?'}`;
const poster=(e:Entry)=>`/api/v1/catalog/items/${e.showId??e.mediaId}/artwork?kind=poster`;
function Thumb({src}:{src?:string}) {
  const [failed,setFailed]=useState(false);
  return <span className="program-thumb" aria-hidden="true">{src&&!failed?<img src={src} alt="" loading="lazy" decoding="async" onError={()=>setFailed(true)}/>:<Icon name="movies" size={16}/>}</span>;
}
function StatusTags({channel}:{channel:Summary}) {
  return <span className="source-row-tags">
    {!channel.enabled&&<span className="badge">Disabled</span>}
    {channel.pending?<span className="badge warning">Update at {when(channel.pending.effectiveAt)}</span>:null}
    {channel.changed&&<span className="badge warning">{channel.live?'Unpublished changes':'Not published'}</span>}
    {channel.issues>0&&<span className="badge danger">{plural(channel.issues,'problem')}</span>}
    {channel.live&&channel.enabled&&<span className="badge ok">On air</span>}
  </span>;
}

export function CustomChannelSettings() {
  const list=useApi<{channels:Summary[]}>(base),[open,setOpen]=useState<string>(),[create,setCreate]=useState(false),ordering=useMutation(list.reload);
  const channels=list.data?.channels??[];
  if(open&&channels.some(c=>c.id===open))return <ChannelEditor key={open} id={open} back={()=>setOpen(undefined)}/>;
  const reorder=(i:number,by:number)=>void ordering.run(()=>api(`${base}/order`,'PUT',{ids:move(channels.map(c=>c.id),i,by)}).then(changed));
  return <>
    <SectionHead title="Custom channels" description="24/7 channels made from your Plex movies and shows. Each channel plays its programs one after another and starts over at the end. Everyone tuned in sees the same program."/>
    <div className="section-heading"><div><h3>Channels</h3><p className="muted small">Live TV lists custom channels first, in this order.</p></div><button className="primary" onClick={()=>setCreate(true)}>Create channel</button></div>
    {ordering.error&&<ErrorNotice message={ordering.error}/>}
    {list.loading&&!list.data?<Loading/>:list.error?<ErrorNotice message={list.error.message} retry={list.reload}/>:channels.length?<ul className="source-rows">{channels.map((c,i)=><li key={c.id} className="source-item">
      {channels.length>1&&<span className="source-move"><button type="button" className="icon-button" aria-label={`Move ${c.name} up`} disabled={i===0||ordering.busy} onClick={()=>reorder(i,-1)}>↑</button><button type="button" className="icon-button" aria-label={`Move ${c.name} down`} disabled={i===channels.length-1||ordering.busy} onClick={()=>reorder(i,1)}>↓</button></span>}
      <button className="source-row" onClick={()=>setOpen(c.id)}>
        <span className={`status-dot ${c.issues?'danger':c.live&&c.enabled?'ok':''}`} aria-hidden="true"/>
        <span className="source-row-main"><strong>{c.number!==null&&`${c.number} · `}{c.name}</strong><small>{plural(c.programs,'program')}{c.runtimeMs>0&&` · ${duration(c.runtimeMs)} per loop`}{c.current&&c.enabled&&` · Now: ${c.current.title}`}</small></span>
        <StatusTags channel={c}/><Icon name="next" size={18}/>
      </button></li>)}</ul>:<Empty title="Create your first channel">Pick movies, whole shows, seasons or single episodes from Plex. Programs play in the order you set, around the clock.</Empty>}
    {create&&<CreateChannel onClose={()=>setCreate(false)} created={c=>{list.reload();setOpen(c.id);}}/>}
  </>;
}
function CreateChannel({onClose,created}:{onClose:()=>void;created:(c:Detail)=>void}) {
  const [name,setName]=useState(''),[number,setNumber]=useState(''),[summary,setSummary]=useState(''),mutation=useMutation(changed);
  return <Modal title="Create channel" onClose={()=>{if(!mutation.busy)onClose();}}>
    <h2>Create a channel</h2>
    <p className="muted">Name it, then add programs from Plex. Nothing airs until you publish.</p>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    <form className="form-stack" onSubmit={e=>{e.preventDefault();void mutation.run(async()=>{const c=await api<Detail>(base,'POST',{name,summary,...(number?{number:Number(number)}:{})});onClose();created(c);});}}>
      <label>Channel name<input value={name} onChange={e=>setName(e.target.value)} required maxLength={120} autoFocus placeholder="Saturday Morning Cartoons"/></label>
      <label>Channel number<input type="number" min="1" max="999999" value={number} onChange={e=>setNumber(e.target.value)} placeholder="Next free number"/><small>Shared with IPTV channels; each number can be used once.</small></label>
      <label>Description<textarea value={summary} onChange={e=>setSummary(e.target.value)} maxLength={1000}/></label>
      <div className="button-row"><button className="primary" disabled={mutation.busy}>Create channel</button><button type="button" disabled={mutation.busy} onClick={onClose}>Cancel</button></div>
    </form>
  </Modal>;
}

const tabs=[['programs','Programs'],['details','Details']] as const;
function ChannelEditor({id,back}:{id:string;back:()=>void}) {
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
  return <section className="source-detail">
    <button className="back-link" onClick={back}><Icon name="back" size={16}/>All channels</button>
    <div className="source-head">
      <div className="source-title"><span className={`status-dot ${view.issues?'danger':view.live&&view.enabled?'ok':''}`} aria-hidden="true"/><div><h2>{view.number!==null&&`${view.number} · `}{view.name}</h2>
        <p className="muted small">{!view.live?'Not on air yet':view.current?<>Now: <strong>{view.current.title}</strong>{view.current.subtitle&&` · ${view.current.subtitle}`} · until {clock(view.current.end)}</>:'On air'}{view.pending&&<> · Next update at {when(view.pending.effectiveAt)}, starting with {view.pending.next}</>}</p></div></div>
      <div className="button-row">
        {view.changed&&view.live&&<button disabled={mutation.busy} onClick={()=>apply('/draft/discard','POST',{})}>Discard changes</button>}
        <button className="primary" disabled={mutation.busy||!view.entries.length} onClick={()=>setPublish(true)}>{view.live?'Review & publish':'Publish channel'}</button>
      </div>
    </div>
    {mutation.error&&<ErrorNotice message={mutation.error} dismiss={()=>mutation.setError('')}/>}{notice&&<p className="success" role="status">{notice}</p>}
    <div className="subtabs" role="tablist" aria-label={`${view.name} settings`}>{tabs.map(([t,label])=><button key={t} role="tab" aria-selected={tab===t} onClick={()=>setTab(t)}>{label}{t==='programs'&&<span className="count">{view.entries.length}</span>}</button>)}</div>
    <div role="tabpanel" className="source-panel">
      {tab==='programs'?<ProgramsPanel view={view} busy={mutation.busy} apply={apply} setNotice={setNotice}/>:<DetailsPanel view={view} saved={c=>{setLocal(c);setNotice('Channel details saved.');}} removed={()=>{changed();back();}}/>}
    </div>
    {publish&&<PublishDialog view={view} onClose={()=>setPublish(false)} published={(c,at)=>{setLocal(c);setPublish(false);setNotice(at>Date.now()+1000?`Published. The new list takes over at ${when(at)}, when the current program ends.`:'Published. The channel is on air.');}}/>}
  </section>;
}

type Apply=(path:string,method:string,body:Record<string,unknown>,done?:(r:unknown)=>void)=>void;
const PAGE=200;
function ProgramsPanel({view,busy,apply,setNotice}:{view:Detail;busy:boolean;apply:Apply;setNotice:(s:string)=>void}) {
  const [selected,setSelected]=useState<string[]>([]),[shown,setShown]=useState(PAGE),[picker,setPicker]=useState(false),[arranging,setArranging]=useState(false),[dragging,setDragging]=useState<number>();
  const entries=view.entries,ids=entries.map(e=>e.entryId);
  useEffect(()=>{setSelected(s=>s.filter(id=>ids.includes(id)));},[view.revision]);
  const order=(next:string[])=>apply('/draft/order','PUT',{entryIds:next});
  const remove=(drop:string[])=>{order(ids.filter(id=>!drop.includes(id)));setSelected([]);};
  const moveTo=(top:boolean)=>{const chosen=ids.filter(id=>selected.includes(id)),rest=ids.filter(id=>!selected.includes(id));order(top?[...chosen,...rest]:[...rest,...chosen]);};
  const drop=(to:number)=>{if(dragging===undefined||dragging===to)return;const next=[...ids],[moved]=next.splice(dragging,1);next.splice(to,0,moved!);setDragging(undefined);order(next);};
  const problems=entries.filter(e=>e.issue);
  return <>
    <div className="program-toolbar">
      <button className="primary" disabled={busy} onClick={()=>setPicker(true)}><Icon name="search" size={16}/>Add programs</button>
      <button disabled={busy||entries.length<2} onClick={()=>setArranging(true)}>Arrange…</button>
      <span className="muted small grow">{plural(entries.length,'program')}{entries.length>0&&` · ${duration(view.runtimeMs)} per loop`}</span>
    </div>
    {problems.length>0&&<div className="notice error" role="alert"><span>{plural(problems.length,'program')} can’t play on a channel and must be removed before publishing. {issueHelp}</span><button disabled={busy} onClick={()=>remove(problems.map(e=>e.entryId))}>Remove them</button></div>}
    {selected.length>0&&<div className="bulk-bar" role="region" aria-label="Selected programs"><strong>{selected.length} selected</strong><div className="button-row">
      <button disabled={busy} onClick={()=>moveTo(true)}>Move to top</button><button disabled={busy} onClick={()=>moveTo(false)}>Move to bottom</button>
      <button disabled={busy} onClick={()=>apply('/draft/duplicate','POST',{entryIds:selected})} title="Adds a second airing right after each">Repeat</button>
      <button disabled={busy} className="danger" onClick={()=>remove(selected)}>Remove</button><button className="text-button" onClick={()=>setSelected([])}>Clear</button></div></div>}
    {!entries.length?<Empty title="No programs yet">Add movies, whole shows, seasons or single episodes. They play in list order, then the list starts over.</Empty>:<>
      <ol className="program-list">{entries.slice(0,shown).map((e,i)=><li key={e.entryId} className={`program-row ${selected.includes(e.entryId)?'selected':''} ${dragging===i?'dragging':''}`} draggable={!busy}
        onDragStart={ev=>{setDragging(i);ev.dataTransfer.effectAllowed='move';}} onDragEnd={()=>setDragging(undefined)} onDragOver={ev=>{if(dragging!==undefined){ev.preventDefault();ev.dataTransfer.dropEffect='move';}}} onDrop={ev=>{ev.preventDefault();drop(i);}}>
        <input type="checkbox" aria-label={`Select ${e.showTitle??e.title} ${e.kind==='episode'?episodeLabel(e):''}`} checked={selected.includes(e.entryId)} onChange={ev=>{const on=ev.target.checked;setSelected(s=>on?[...s,e.entryId]:s.filter(id=>id!==e.entryId));}}/>
        <span className="program-index" aria-hidden="true">{i+1}</span>
        <Thumb src={poster(e)}/>
        <span className="program-text">{e.kind==='episode'?<><strong>{e.showTitle??'Episode'}</strong><small>{episodeLabel(e)} · {e.title}</small></>:<><strong>{e.title}</strong><small>Movie{e.year?` · ${e.year}`:''}</small></>}</span>
        {e.issue&&<span className="badge danger" title={e.issue==='incompatible'?issueHelp:undefined}>{issues[e.issue]}</span>}
        <span className="program-runtime">{duration(e.durationMs)}</span>
        <span className="sports-move"><button type="button" className="icon-button" aria-label={`Move ${e.title} up`} disabled={busy||i===0} onClick={()=>order(move(ids,i,-1))}>↑</button><button type="button" className="icon-button" aria-label={`Move ${e.title} down`} disabled={busy||i===entries.length-1} onClick={()=>order(move(ids,i,1))}>↓</button><button type="button" className="icon-button" aria-label={`Remove ${e.title}`} disabled={busy} onClick={()=>remove([e.entryId])}><Icon name="close" size={14}/></button></span>
      </li>)}</ol>
      <div className="list-footer"><span className="muted small">Showing {Math.min(shown,entries.length)} of {entries.length} · drag rows or use the arrows to reorder</span>{shown<entries.length&&<button onClick={()=>setShown(n=>n+PAGE)}>Show {Math.min(PAGE,entries.length-shown)} more</button>}</div>
    </>}
    {picker&&<ProgramPicker busy={busy} onClose={()=>setPicker(false)} add={(ids,specials)=>apply('/draft/add','POST',{ids,specials},r=>{
      const {added,skipped,specials:left,issues:bad}=r as AddResult;setPicker(false);
      setNotice([`Added ${plural(added,'program')}.`,skipped&&`${plural(skipped,'title')} already on the channel ${skipped===1?'was':'were'} skipped.`,left&&`${plural(left,'special')} left out.`,bad&&`${bad} can’t play on a channel.`].filter(Boolean).join(' '));
    })}/>}
    {arranging&&<ArrangeDialog busy={busy} onClose={()=>setArranging(false)} run={arrange=>apply('/draft/arrange','POST',{arrange},()=>{setArranging(false);setNotice('Program list rearranged. Publish to put it on air, or discard to undo.');})}/>}
  </>;
}

const tools=[
  ['shuffle','Shuffle','Puts every program in random order.'],
  ['blockShuffle','Shuffle in blocks','Shuffles runs of episodes, keeping each show in episode order.'],
  ['interleave','Interleave shows','Plays one program from each show in turn, keeping each show in episode order. Movies count as one show.'],
  ['sortShows','Sort by show','Shows A–Z, each in season and episode order, then movies A–Z.'],
  ['sortDate','Sort by release date','Oldest first. Programs without a date go last.'],
  ['removeDuplicates','Remove repeats','Keeps only the first airing of each title.'],
  ['removeSpecials','Remove specials','Removes season 0 episodes.'],
  ['replicate','Repeat the whole list','Adds copies of the list after itself, so the loop is longer.'],
] as const;
type Tool=typeof tools[number][0];
function ArrangeDialog({busy,onClose,run}:{busy:boolean;onClose:()=>void;run:(arrange:Record<string,unknown>)=>void}) {
  const [tool,setTool]=useState<Tool>('blockShuffle'),[size,setSize]=useState(2),[times,setTimes]=useState(2);
  return <Modal title="Arrange programs" onClose={()=>{if(!busy)onClose();}}>
    <h2>Arrange programs</h2>
    <p className="muted">Changes the draft only. Publish to put the new order on air, or discard changes to go back.</p>
    <form className="form-stack" onSubmit={e=>{e.preventDefault();run({tool,...(tool==='blockShuffle'?{size}:tool==='replicate'?{times}:{})});}}>
      <div className="arrange-choices" role="radiogroup" aria-label="Arrange tool">{tools.map(([value,label,help])=><label key={value} className={`arrange-choice ${tool===value?'selected':''}`}><input type="radio" name="tool" checked={tool===value} onChange={()=>setTool(value)}/><span><strong>{label}</strong><small>{help}</small></span></label>)}</div>
      {tool==='blockShuffle'&&<label>Episodes per block<input type="number" min="1" max="20" required value={size} onChange={e=>setSize(Number(e.target.value))}/></label>}
      {tool==='replicate'&&<label>Total copies of the list<input type="number" min="2" max="10" required value={times} onChange={e=>setTimes(Number(e.target.value))}/></label>}
      <div className="button-row"><button className="primary" disabled={busy}>Apply</button><button type="button" disabled={busy} onClick={onClose}>Cancel</button></div>
    </form>
  </Modal>;
}

// The Plex picker: browse or search the Movies and TV libraries, drill into shows and seasons, tick what to add.
type Crumb={id:string;title:string;type:'show'|'season'};
type Picked=Map<string,{title:string;type:CatalogItem['type']}>;
const MAX_PICK=100;
function ProgramPicker({busy,onClose,add}:{busy:boolean;onClose:()=>void;add:(ids:string[],specials:boolean)=>void}) {
  const libraries=useApi<{libraries:{key:string;title:string;type:string}[]}>('/libraries'),usable=(libraries.data?.libraries??[]).filter(l=>l.type==='movie'||l.type==='show');
  const [library,setLibrary]=useState<string>(),[search,setSearch]=useState(''),[path,setPath]=useState<Crumb[]>([]),[picked,setPicked]=useState<Picked>(new Map()),[specials,setSpecials]=useState(false);
  const q=useDebounced(search),current=library??usable[0]?.key,at=path.at(-1);
  const toggle=(item:CatalogItem)=>setPicked(old=>{const next=new Map(old);if(next.has(item.id))next.delete(item.id);else if(next.size<MAX_PICK)next.set(item.id,{title:item.type==='episode'?`${item.showTitle??''} ${episodeLabel({season:item.seasonNumber,episode:item.episodeNumber})}`.trim():item.type==='season'?`${item.parentTitle??''} · ${item.title}`:item.title,type:item.type});return next;});
  const open=(item:CatalogItem)=>{if(item.type==='show'||item.type==='season')setPath(p=>[...p,{id:item.id,title:item.title,type:item.type as 'show'|'season'}]);};
  const shows=[...picked.values()].some(p=>p.type==='show');
  return <Modal title="Add programs" onClose={()=>{if(!busy)onClose();}}>
    <div className="picker">
      <h2>Add programs</h2>
      {libraries.error?<ErrorNotice message={libraries.error.message} retry={libraries.reload}/>:!libraries.data?<Loading/>:<>
        <div className="picker-head">
          <div className="segmented" aria-label="Library">{usable.map(l=><button key={l.key} aria-pressed={current===l.key} onClick={()=>{setLibrary(l.key);setPath([]);}}>{l.title}</button>)}</div>
          {!at&&<label className="search-field"><Icon name="search" size={16}/><input aria-label="Search this library" placeholder="Search titles" value={search} maxLength={120} onChange={e=>setSearch(e.target.value)} autoFocus/></label>}
        </div>
        {path.length>0&&<nav className="picker-crumbs" aria-label="Location"><button className="link-button" onClick={()=>setPath([])}>{usable.find(l=>l.key===current)?.title??'Library'}</button>{path.map((c,i)=><span key={c.id}> › {i<path.length-1?<button className="link-button" onClick={()=>setPath(p=>p.slice(0,i+1))}>{c.title}</button>:<strong>{c.title}</strong>}</span>)}</nav>}
        <div className="picker-results">{current&&(at?<ChildResults key={at.id} parent={at} picked={picked} toggle={toggle} open={open}/>:<LibraryResults key={`${current}:${q}`} library={current} q={q} picked={picked} toggle={toggle} open={open}/>)}</div>
      </>}
      <div className="picker-foot">
        <span className="grow"><strong>{picked.size?`${picked.size} selected`:'Nothing selected'}</strong>{picked.size>=MAX_PICK&&<small className="muted"> · add these before choosing more</small>}{picked.size>0&&<button className="text-button" onClick={()=>setPicked(new Map())}>Clear</button>}</span>
        {shows&&<label className="checkbox-label"><input type="checkbox" checked={specials} onChange={e=>setSpecials(e.target.checked)}/>Include specials</label>}
        <button disabled={busy} onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy||!picked.size} onClick={()=>add([...picked.keys()],specials)}>{busy?'Adding…':'Add to channel'}</button>
      </div>
    </div>
  </Modal>;
}
type ResultProps={picked:Picked;toggle:(item:CatalogItem)=>void;open:(item:CatalogItem)=>void};
function LibraryResults({library,q,...rest}:{library:string;q:string}&ResultProps) {
  const query=new URLSearchParams({limit:'48',sort:'title',...(q?{q}:{})}).toString();
  const list=useInfinitePages<CatalogPage>(offset=>`/catalog/libraries/${library}/items?${query}&offset=${offset}`,48,`${library}:${query}`);
  return <PickList pages={list.pages} loading={list.loading} more={list.more} loadMore={list.loadMore} sentinel={list.sentinel} empty={q?'No matching titles.':'This library is empty.'} {...rest}/>;
}
function ChildResults({parent,...rest}:{parent:Crumb}&ResultProps) {
  const list=useInfinitePages<CatalogPage>(offset=>`/catalog/items/${parent.id}/children?limit=60&offset=${offset}`,60,parent.id);
  return <PickList pages={list.pages} loading={list.loading} more={list.more} loadMore={list.loadMore} sentinel={list.sentinel} empty={parent.type==='show'?'No seasons.':'No episodes.'} {...rest}/>;
}
function PickList({pages,loading,more,loadMore,sentinel,empty,picked,toggle,open}:{pages:(CatalogPage|undefined)[];loading:boolean;more:boolean;loadMore:()=>void;sentinel:ReturnType<typeof useInfinitePages>['sentinel'];empty:string}&ResultProps) {
  const items=pages.flatMap(p=>p?.items??[]);
  if(!items.length)return loading?<Loading/>:pages[0]===undefined?<ErrorNotice message="Titles could not be loaded."/>:<p className="muted">{empty}</p>;
  return <><ul className="pick-list">{items.map(item=>{const browsable=item.type==='show'||item.type==='season',on=picked.has(item.id);return <li key={item.id} className={on?'selected':''}>
    <label className="pick-main"><input type="checkbox" checked={on} disabled={!on&&picked.size>=MAX_PICK} onChange={()=>toggle(item)}/>
      <Thumb src={item.type==='episode'?item.showPosterUrl??item.posterUrl:item.posterUrl??item.showPosterUrl}/>
      <span className="program-text"><strong>{item.type==='episode'?`${item.episodeNumber??'?'}. ${item.title}`:item.title}</strong><small>{item.type==='show'?`TV show${item.year?` · ${item.year}`:''}${item.episodeCount?` · ${plural(item.episodeCount,'episode')}`:''} · select to add every episode`:item.type==='season'?`${item.episodeCount?plural(item.episodeCount,'episode'):'Season'} · select to add the season`:[item.year,duration(item.durationMs)].filter(Boolean).join(' · ')}</small></span>
    </label>
    {browsable&&<button className="pick-open" onClick={()=>open(item)} aria-label={`Browse ${item.title}`}>{item.type==='show'?'Seasons':'Episodes'}<Icon name="next" size={14}/></button>}
  </li>;})}</ul><div ref={sentinel} className="list-more">{more?<button onClick={loadMore}>Load more</button>:loading&&'Loading…'}</div></>;
}

function PublishDialog({view,onClose,published}:{view:Detail;onClose:()=>void;published:(c:Detail,effectiveAt:number)=>void}) {
  const preview=useApi<Preview>(`${base}/${view.id}/preview?revision=${view.revision}`),mutation=useMutation(changed),p=preview.data;
  return <Modal title="Publish channel" onClose={()=>{if(!mutation.busy)onClose();}}>
    <h2>{view.live?'Publish changes':'Publish channel'}</h2>
    {preview.loading&&!p?<Loading/>:preview.error?<ErrorNotice message={preview.error.message} retry={preview.reload}/>:p&&<>
      {p.current?<div className="handoff"><div><small>NOW PLAYING · KEEPS PLAYING</small><strong>{p.current.title}</strong>{p.current.subtitle&&<span>{p.current.subtitle}</span>}<span>Ends {when(p.current.end)}</span></div><Icon name="next" size={20}/><div><small>THEN, FROM THE NEW LIST</small><strong>{p.upcoming[0]!.title}</strong>{p.upcoming[0]!.subtitle&&<span>{p.upcoming[0]!.subtitle}</span>}<span>Starts {when(p.effectiveAt)}</span></div></div>
        :<p>The channel goes on air as soon as you publish, starting with <strong>{p.upcoming[0]!.title}</strong>.</p>}
      {p.reason==='FIRST_ENTRY'&&<div className="notice"><span>The program on now isn’t in the new list, so after it ends the channel starts from the top of the list.</span></div>}
      {p.replacesPending&&<div className="notice"><span>This replaces the update that is already waiting to go on air.</span></div>}
      <h3 className="small-heading">Coming up</h3>
      <ol className="upcoming-list">{p.upcoming.map((s,i)=><li key={i}><time>{when(s.start)}</time><span><strong>{s.title}</strong>{s.subtitle&&<small>{s.subtitle}</small>}</span></li>)}</ol>
      {mutation.error&&<ErrorNotice message={mutation.error}/>}
      <div className="button-row"><button className="primary" disabled={mutation.busy} onClick={()=>void mutation.run(async()=>{const r=await api<{channel:Detail;effectiveAt:number}>(`${base}/${view.id}/publish`,'POST',{expectedRevision:view.revision,expectedPublication:p.publicationRevision});published(r.channel,r.effectiveAt);})}>{mutation.busy?'Publishing…':'Publish'}</button><button disabled={mutation.busy} onClick={onClose}>Cancel</button></div>
    </>}
  </Modal>;
}

function DetailsPanel({view,saved,removed}:{view:Detail;saved:(c:Detail)=>void;removed:()=>void}) {
  const [name,setName]=useState(view.name),[number,setNumber]=useState(String(view.number??'')),[summary,setSummary]=useState(view.summary),[logo,setLogo]=useState(view.logoUrl??''),[enabled,setEnabled]=useState(view.enabled),[confirm,setConfirm]=useState(false);
  const mutation=useMutation(changed),remove=useMutation(()=>{});
  return <>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    <Card>
      <form className="form-stack narrow" onSubmit={e=>{e.preventDefault();void mutation.run(async()=>saved(await api<Detail>(`${base}/${view.id}`,'PATCH',{expectedRevision:view.revision,name,summary,enabled,logoUrl:logo.trim()||null,...(number?{number:Number(number)}:{})})));}}>
        <label>Channel name<input value={name} onChange={e=>setName(e.target.value)} required maxLength={120}/></label>
        <label>Channel number<input type="number" min="1" max="999999" required value={number} onChange={e=>setNumber(e.target.value)}/><small>Changing the number doesn’t change what’s on.</small></label>
        <label>Description<textarea value={summary} onChange={e=>setSummary(e.target.value)} maxLength={1000}/></label>
        <label>Logo image URL<input type="url" value={logo} onChange={e=>setLogo(e.target.value)} maxLength={2000} placeholder="https://…/logo.png" spellCheck={false}/><small>PNG, JPEG, WebP or GIF up to 1 MB. Fetched by the server; viewers never see the address.</small></label>
        <Switch label="Show in Live TV" description="When off, viewers don’t see the channel. Its schedule keeps running, so it resumes on time when turned back on." checked={enabled} onChange={setEnabled}/>
        <div className="button-row"><button className="primary" disabled={mutation.busy}>Save details</button></div>
      </form>
    </Card>
    <Card title="Delete channel" className="danger-zone" description="Deletes the channel, its program list, schedule and number. Viewers’ favorites of it are removed." actions={<button className="danger" onClick={()=>setConfirm(true)}>Delete channel</button>}/>
    {confirm&&<Modal title="Delete channel" onClose={()=>{if(!remove.busy)setConfirm(false);}}><h2>Delete {view.name}?</h2><p>This can’t be undone. Its {plural(view.entries.length,'program')} and schedule are deleted; nothing in Plex changes.</p>{remove.error&&<ErrorNotice message={remove.error}/>}<div className="button-row"><button className="danger" disabled={remove.busy} onClick={()=>void remove.run(async()=>{await api(`${base}/${view.id}`,'DELETE',{expectedRevision:view.revision});setConfirm(false);removed();})}>Delete channel</button><button disabled={remove.busy} onClick={()=>setConfirm(false)}>Cancel</button></div></Modal>}
  </>;
}
