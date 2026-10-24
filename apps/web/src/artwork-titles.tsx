import {useEffect,useMemo,useRef,useState,type DragEvent,type PointerEvent} from 'react';
import {api} from './api.js';
import {useApi,invalidate} from './hooks.js';
import {Empty,ErrorNotice,Icon,Loading,Modal} from './components.js';
import {useMutation} from './settings-ui.js';
// The editor also opens from the library (Edit artwork), where the Admin page's styles aren't loaded yet.
import './admin.css';
import {openConsole,type Job} from './admin-console.js';

// Admin › Artwork › Titles: every title's asset folder, as the engine keeps it. Pick a poster or logo (a saved file, one
// the providers offer, a crop of a backdrop, or your own), compare the preview with what was last made, then push.
// Every image comes through tk.box's admin routes, and the engine's worker does the work.
type Title={id:string;cat:'movies'|'tv'|'collections';title:string;year?:number;thumb:string|null};
type Pending={title:string};
type TitlesView={titles:Title[];upload:boolean;pending:Record<string,Pending>};
type File={name:string;thumb:string;full:string;kb:number;kept:boolean;size?:string;hash?:string;source?:string|null};
type Section={id:string;label:string|null;pv:string;rendered:File|null;poster:File|null;logo:File|null;posters:File[];logos:File[]};
// generated: a streaming, chart, custom or curated collection's drawn background, kept as one file however often it's recoloured.
type Generated={color:string;default:string;name:string;hash:string;thumb:string;full:string};
type Detail={id:string;title:string;year?:number;key?:string;tv:boolean;no_logo:boolean;generated?:Generated|null;sections:Section[]};
type Live={known:false}|{known:true;poster?:string|null;logo?:string|null};
type RemoteItem={provider:string;url:string|null;plex:string|null;view:string;thumb:string;language?:string|null;text?:boolean|null;width:number;height:number};
type Remote={items:RemoteItem[];notes:string[];target:[number,number]|null};
type Kind='poster'|'logo';
const ROOT='/api/v1/admin/artwork';
const named=(title:string,year?:number)=>title+(year&&!title.includes(`(${year})`)?` (${year})`:'');
const seasonName=(label:string)=>label.replace(/^Season 0*(\d+)$/,(_,n:string)=>n==='0'?'Specials':`Season ${n}`);
const categories=[['','All'],['movies','Movies'],['tv','TV'],['collections','Collections'],['pending','Not pushed']] as const;
const kb=(n:number)=>n>1023?`${(n/1024).toFixed(1)} MB`:`${n} KB`;
const fileData=(file:Blob)=>new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).replace(/^data:[^,]*,/,''));reader.onerror=()=>reject(new Error('That file could not be read.'));reader.readAsDataURL(file);});

export function ArtworkTitles({ratingKey,engineReady,upload}:{ratingKey?:string;engineReady:boolean;upload:boolean}) {
  const titles=useApi<TitlesView>(engineReady?'/admin/artwork/titles':undefined),[open,setOpen]=useState<string>(),[query,setQuery]=useState(''),[category,setCategory]=useState('');
  const [missing,setMissing]=useState<string>(),push=useMutation(()=>{titles.reload();invalidate('/admin/artwork/jobs');}),[pushed,setPushed]=useState('');
  // Opened from a title's details (Edit artwork): its folder by Plex ID, or an offer to make it.
  useEffect(()=>{if(!ratingKey||!engineReady)return;void api<{id:string|null}>(`/admin/artwork/titles/find?ratingKey=${ratingKey}`).then(r=>{if(r.id)setOpen(r.id);else setMissing(ratingKey);},()=>{});},[ratingKey,engineReady]);
  const list=useMemo(()=>{
    const q=query.trim().toLowerCase(),all=titles.data?.titles??[];
    return all.filter(t=>(!category||(category==='pending'?!!titles.data?.pending[t.id]:t.cat===category))&&(!q||`${t.title} ${t.year??''}`.toLowerCase().includes(q)));
  },[titles.data,query,category]);
  if(!engineReady)return <Empty title="The artwork engine isn’t set up">Set it up (above) to browse titles.</Empty>;
  // The editor opens over the titles, which stay where they were.
  const close=()=>{setOpen(undefined);titles.reload();};
  const editor=open&&<Modal key={open} title="Title artwork" onClose={close} variant="wide"><TitleEditor id={open} upload={upload}/></Modal>;
  if(titles.loading&&!titles.data)return <>{editor}<Loading cards/></>;
  if(titles.error)return <ErrorNotice message={titles.error.message} retry={titles.reload}/>;
  const data=titles.data!,pending=Object.keys(data.pending).length,verb=data.upload?'Push':'Render';
  return <div className="form-stack">
    {editor}
    {missing&&<MakeFirst ratingKey={missing} dismiss={()=>setMissing(undefined)}/>}
    <div className="artwork-toolbar">
      <input type="search" className="grow" placeholder="Find a title" aria-label="Find a title" value={query} onChange={e=>setQuery(e.target.value)}/>
      <div className="toggle-group" role="radiogroup" aria-label="Show">{categories.map(([id,label])=><button key={id} type="button" role="radio" aria-checked={category===id} onClick={()=>setCategory(id)}>{label}{id==='pending'&&pending?` (${pending})`:''}</button>)}</div>
      <button className="primary" disabled={!pending||push.busy} onClick={()=>void push.run(async()=>{const r=await api<{jobs:Job[]}>('/admin/artwork/push','POST',{});setPushed(`${r.jobs.length} ${r.jobs.length===1?'job':'jobs'} queued.`);openConsole(r.jobs[0]);})}>{verb} {pending||''} changed</button>
    </div>
    {pushed&&<p className="success small" role="status">{pushed}</p>}{push.error&&<ErrorNotice message={push.error}/>}
    {!data.titles.length?<Empty title="No titles yet">Titles appear here once a job has made their artwork. Run “Update changed titles” (top right).</Empty>
      :!list.length?<Empty title="Nothing matches">Try another search or filter.</Empty>
      :<div className="artwork-title-grid">{list.map(t=><button key={t.id} className="artwork-title" onClick={()=>setOpen(t.id)}>
        <span className="artwork-title-art">{t.thumb?<img src={t.thumb} alt="" loading="lazy" decoding="async"/>:<Icon name="image" size={28}/>}{data.pending[t.id]&&<span className="badge warning">Not {data.upload?'pushed':'rendered'}</span>}</span>
        <span className="artwork-title-name">{named(t.title,t.year)}</span><small className="muted">{t.cat==='tv'?'TV show':t.cat==='movies'?'Movie':'Collection'}</small></button>)}</div>}
  </div>;
}
// Opened from a title's menu or details (Edit artwork): the same editor over the page it was opened on, found by Plex ID.
export function TitleArtwork({ratingKey,onClose}:{ratingKey:string;onClose:()=>void}) {
  const [found,setFound]=useState<{id:string|null}>(),[error,setError]=useState<string>(),[attempt,setAttempt]=useState(0);
  useEffect(()=>{let live=true;setError(undefined);void api<{id:string|null}>(`/admin/artwork/titles/find?ratingKey=${ratingKey}`).then(r=>{if(live)setFound(r);},(e:Error)=>{if(live)setError(e.message);});return()=>{live=false;};},[ratingKey,attempt]);
  return <Modal title="Title artwork" onClose={onClose} variant="wide">
    {error?<ErrorNotice message={error} retry={()=>setAttempt(n=>n+1)}/>:!found?<Loading/>:found.id?<TitleEditor id={found.id} upload={false}/>:<MakeFirst ratingKey={ratingKey} dismiss={onClose}/>}
  </Modal>;
}
// A title the engine hasn't made yet has no folder: one job makes it (and its seasons), then it can be edited here.
function MakeFirst({ratingKey,dismiss}:{ratingKey:string;dismiss:()=>void}) {
  const mutation=useMutation(()=>invalidate('/admin/artwork/jobs')),[queued,setQueued]=useState(false);
  return <div className="notice"><span>{queued?'Queued. When the job is done, open Edit artwork for this title again.':'This title has no artwork folder yet. Make its artwork once, then pick posters and logos here.'}</span>
    {!queued&&<button disabled={mutation.busy} onClick={()=>void mutation.run(async()=>{openConsole(await api<Job>('/admin/artwork/jobs','POST',{kind:'item',ratingKey,seasons:true,episodes:false,remake:false}));setQueued(true);})}>Make its artwork</button>}
    <button className="icon-button" aria-label="Dismiss" onClick={dismiss}><Icon name="close" size={16}/></button>{mutation.error&&<span className="danger small">{mutation.error}</span>}</div>;
}

type Candidate={type:'file';f:File;cur?:boolean;x?:RemoteItem}|{type:'remote';x:RemoteItem}|{type:'backdrop';x:RemoteItem};
function TitleEditor({id,upload}:{id:string;upload:boolean}) {
  const detail=useApi<Detail>(`/admin/artwork/title?id=${encodeURIComponent(id)}`),state=useApi<{upload:boolean;pending:Record<string,Pending>}>('/admin/artwork/state');
  const [scope,setScope]=useState(0),[tab,setTab]=useState<Kind>('poster'),[source,setSource]=useState<'all'|'posters'|'backdrops'>('all'),[text,setText]=useState<'all'|'textless'|'text'>('all');
  const [busy,setBusy]=useState<string>(),[message,setMessage]=useState(''),[error,setError]=useState(''),[crop,setCrop]=useState<{x:RemoteItem;target:[number,number]}>(),[zoom,setZoom]=useState<{src:string;label:string}>(),[adding,setAdding]=useState(false),[tint,setTint]=useState<{x:number;y:number}>();
  const d=detail.data,section=d?.sections[Math.min(scope,d.sections.length-1)];
  const live=useApi<Live>(section?`/admin/artwork/title/live?id=${encodeURIComponent(section.id)}`:undefined);
  const seriesLive=useApi<Live>(d&&scope>0?`/admin/artwork/title/live?id=${encodeURIComponent(d.sections[0]!.id)}`:undefined);
  const remoteKind=(kind:'poster'|'logo'|'backdrop')=>section&&(kind!=='logo'||scope===0)?`/admin/artwork/title/remote?id=${encodeURIComponent(kind==='logo'?d!.sections[0]!.id:section.id)}&kind=${kind}`:undefined;
  const remote=useApi<Remote>(remoteKind(tab)),backdrops=useApi<Remote>(tab==='poster'?remoteKind('backdrop'):undefined);
  // Leaving a title lets the worker forget its previews.
  useEffect(()=>()=>{void api('/admin/artwork/title/clear','POST',{}).catch(()=>{});},[]);
  const reload=()=>{detail.reload();state.reload();live.reload();seriesLive.reload();};
  const act=async(label:string,work:()=>Promise<{warning?:string|null}|unknown>,done:string)=>{
    if(busy)return;setBusy(label);setError('');setMessage('');
    try{const r=await work() as {warning?:string|null}|undefined;setMessage(r?.warning??done);}catch(e){setError((e as Error).message);}finally{setBusy(undefined);reload();}
  };
  const upload$=async(file:Blob)=>{if(file.size>25*1024*1024){setError('That file is larger than 25 MB.');return;}
    await act('add',async()=>api('/admin/artwork/title/upload','POST',{id:target().id,kind:target().kind,data:await fileData(file),use:true}),`Added. It’s the selected ${tab} now.`);};
  const target=()=>({id:tab==='logo'?d!.sections[0]!.id:section!.id,kind:tab});
  // Paste an image anywhere while a title is open.
  useEffect(()=>{const paste=(e:ClipboardEvent)=>{const file=Array.from(e.clipboardData?.files??[]).find(f=>f.type.startsWith('image/'));if(file&&!crop&&!adding){e.preventDefault();void upload$(file);}};window.addEventListener('paste',paste);return()=>window.removeEventListener('paste',paste);});
  if(detail.loading&&!d)return <Loading/>;
  if(detail.error||!d||!section)return <ErrorNotice message={detail.error?.message??'Title not found.'} retry={detail.reload}/>;
  const pushedState=state.data??{upload,pending:{}},changed=!!pushedState.pending[d.id],linked=!!d.key&&/^\d+$/.test(String(d.key)),verb=pushedState.upload?'Push':'Render';
  // A pick is staged while the folder's file differs from the one the last push used; then there is something to preview.
  const staged=(kind:Kind,which:Section,info?:Live)=>!info||!info.known?changed:kind in info&&(which[kind]?.hash??null)!==info[kind];
  const next=staged('poster',section,live.data)||staged('logo',d.sections[0]!,scope>0?seriesLive.data:live.data);
  const liveHash=live.data?.known?live.data[tab]:undefined;
  const g=tab==='poster'&&scope===0?d.generated:undefined;
  // The generated background has its own tile, so its copy in use as the poster isn't listed again.
  const files:File[]=[...(section[tab]?[section[tab]!]:[]),...section[`${tab}s` as 'posters'|'logos']].filter(f=>!g||f.hash!==g.hash);
  const rows=(remote.data?.items??[]).filter(x=>tab!=='poster'||text==='all'||(x.text!==null&&x.text===(text==='text')));
  const sourceOf=(x:RemoteItem)=>x.plex??x.url??'';
  // A file downloaded from an online picture is shown in that picture's place; the rest of the saved files come first.
  const placed=new Map(files.filter(f=>f.source&&rows.some(x=>sourceOf(x)===f.source)).map(f=>[f.source!,f]));
  const front:Candidate[]=files.filter(f=>!f.source||!placed.has(f.source)).map(f=>({type:'file',f,cur:f===section[tab]}));
  const online:Candidate[]=rows.map(x=>{const f=placed.get(sourceOf(x));return f?{type:'file',f,cur:f===section[tab],x}:{type:'remote',x};});
  const wide:Candidate[]=(backdrops.data?.items??[]).map(x=>({type:'backdrop',x}));
  const shown=source==='backdrops'?[]:[...front,...online];
  const noLogo=tab==='logo'&&d.no_logo;
  const tag=(c:Candidate)=>{
    if(c.type!=='file')return undefined;
    if(c.cur&&!noLogo)return staged(tab,section,live.data)?['Selected','ok']:[liveHash===c.f.hash?'Live':'In use','live'];
    return liveHash===c.f.hash?['Live','live']:undefined;
  };
  const choose=(c:Candidate)=>{
    const u=target();
    if(c.type==='backdrop'){const t=backdrops.data?.target;if(t)setCrop({x:c.x,target:t});return;}
    if(c.type==='file'){if(c.cur){setZoom({src:c.f.full,label:c.f.name});return;}void act(`f:${c.f.name}`,()=>api('/admin/artwork/title/select','POST',{id:u.id,kind:u.kind,name:c.f.name}),`${tab==='logo'?'Logo':'Poster'} updated.`);return;}
    void act(`r:${sourceOf(c.x)}`,()=>api('/admin/artwork/title/import','POST',{id:u.id,kind:u.kind,...(c.x.plex?{plex:c.x.plex}:{url:c.x.url}),use:true}),`${tab==='logo'?'Logo':'Poster'} updated.`);
  };
  const keyOf=(c:Candidate)=>c.type==='file'?`f:${c.f.name}`:`r:${sourceOf(c.x)}`;
  const tile=(c:Candidate)=>{const [label,tone]=tag(c)??[];const x=c.type==='file'?c.x:c.x,f=c.type==='file'?c.f:undefined;
    const size=f?kb(f.kb):x?.width?(c.type==='backdrop'&&x.height?`${x.width}×${x.height}`:`${x.width}px`):'';
    return <figure key={keyOf(c)} className={`artwork-tile ${c.type==='backdrop'?'backdrop':tab}${tone==='ok'?' selected':tone==='live'?' live':''}`}>
      <button className="artwork-tile-pick" disabled={!!busy} aria-label={c.type==='file'&&c.cur?`View ${f!.name} larger`:c.type==='backdrop'?'Crop a poster from this backdrop':`Use this ${tab}`} onClick={()=>choose(c)}>
        <img src={f&&!x?f.thumb:x!.thumb} alt="" loading="lazy" decoding="async" onError={e=>{if(x&&e.currentTarget.src!==new URL(x.view,location.href).href)e.currentTarget.src=x.view;}}/>
        {label&&<span className={`badge ${tone}`}>{label}</span>}{busy===keyOf(c)&&<span className="artwork-tile-wait"><span className="spinner"/></span>}</button>
      <figcaption><span>{x?x.provider:f!.size??f!.name}</span><span>{[c.type==='remote'&&tab==='poster'&&x?.text===false&&'no text',x?.language,size].filter(Boolean).join(' · ')}</span>
        <span className="artwork-tile-tools"><button className="icon-button" aria-label="View larger" onClick={()=>setZoom({src:f&&!x?f.full:x!.view,label:x?x.provider:f!.name})}><Icon name="expand" size={14}/></button>
          {f&&!(c.type==='file'&&c.cur)&&<button className="icon-button" aria-label={`Delete ${f.name}`} disabled={!!busy} onClick={()=>void act(`f:${f.name}`,()=>api('/admin/artwork/title/remove','POST',{id:target().id,kind:tab,name:f.name}),'Deleted.')}><Icon name="close" size={14}/></button>}</span></figcaption>
    </figure>;};
  const generatedTag=g&&(section.poster?.hash===g.hash?staged('poster',section,live.data)?['Selected','ok']:[liveHash===g.hash?'Live':'In use','live']:liveHash===g.hash?['Live','live']:undefined);
  const recolor=(color:string|null)=>{setTint(undefined);void act('generated',()=>api('/admin/artwork/title/background-color','POST',{id:d.id,color}),color?'Background recoloured. It’s the selected poster now.':'Background back to its default colour. It’s the selected poster now.');};
  const generatedTile=g&&<figure key="generated" className={`artwork-tile poster${generatedTag?.[1]==='ok'?' selected':generatedTag?.[1]==='live'?' live':''}`}
    onContextMenu={e=>{e.preventDefault();if(!busy)setTint({x:e.clientX,y:e.clientY});}}>
    <button className="artwork-tile-pick" disabled={!!busy} aria-label={section.poster?.hash===g.hash?'View the generated background larger':'Use the generated background'} title="Right-click to change its colour"
      onClick={()=>{if(section.poster?.hash===g.hash)setZoom({src:g.full,label:'Generated background'});else void act('generated',()=>api('/admin/artwork/title/generated','POST',{id:d.id}),'Poster updated.');}}>
      <img src={g.thumb} alt="" loading="lazy" decoding="async"/>{generatedTag&&<span className={`badge ${generatedTag[1]}`}>{generatedTag[0]}</span>}{busy==='generated'&&<span className="artwork-tile-wait"><span className="spinner"/></span>}</button>
    <figcaption><span>Generated</span><span>{g.color.toUpperCase()}{g.color!==g.default?' · custom':''}</span>
      <span className="artwork-tile-tools"><button className="icon-button" aria-label="Change its colour" disabled={!!busy} onClick={e=>{const r=e.currentTarget.getBoundingClientRect();setTint({x:r.left,y:r.bottom+4});}}><Icon name="more" size={14}/></button></span></figcaption>
  </figure>;
  const drop=(e:DragEvent)=>{const file=Array.from(e.dataTransfer.files).find(f=>f.type.startsWith('image/'));if(file){e.preventDefault();void upload$(file);}};
  const remoteState=source==='backdrops'?backdrops:remote;
  return <section className="artwork-editor" onDragOver={e=>{if(Array.from(e.dataTransfer.items).some(i=>i.kind==='file'))e.preventDefault();}} onDrop={drop}>
    <div className="source-head">
      <div><h2>{named(d.title,d.year)}</h2><p className="muted small">{d.tv?'TV show':d.id.startsWith('collections/')?'Collection':'Movie'}{linked?` · Plex ID ${d.key}`:''} · <span className={`badge ${!linked?'':changed?'warning':'ok'}`}>{!linked?'Not linked to Plex':changed?`Not ${pushedState.upload?'pushed':'rendered'}`:'Up to date'}</span></p></div>
      <div className="button-row">
        {changed&&<button disabled={!!busy} onClick={()=>void act('discard',()=>api('/admin/artwork/title/discard','POST',{id:d.id}),`Changes discarded. Back to what was last ${pushedState.upload?'pushed':'rendered'}.`)}>Discard changes</button>}
        <button className={changed?'primary':''} disabled={!linked||!!busy} title={!linked?'Make this title’s artwork once (Update changed titles, or One title in the ⋯ menu) so it knows its Plex ID':undefined}
          onClick={()=>void act('push',()=>api('/admin/artwork/push','POST',{ids:[d.id]}),`Queued. Follow it in the Console; ${pushedState.upload?'Plex':'this page'} shows the result when it’s done.`)}>{changed||!linked?verb:`${verb} again`}</button>
      </div>
    </div>
    {error&&<ErrorNotice message={error} dismiss={()=>setError('')}/>}{message&&<p className="success small" role="status">{message}</p>}
    <div className="artwork-editor-layout">
      <aside className="artwork-shots">
        <figure><figcaption>Current<small>{pushedState.upload?'Last pushed':'Last render'}</small></figcaption>{section.rendered?<img src={section.rendered.thumb} alt="Current artwork"/>:<div className="artwork-blank">Not {pushedState.upload?'pushed':'rendered'} yet</div>}</figure>
        <figure className={next?'next':''}><figcaption>Preview<small>{next?`After the next ${verb.toLowerCase()}`:'No changes'}</small></figcaption>
          {next?<img key={`${section.id}-${section.pv}`} src={`${ROOT}/preview?id=${encodeURIComponent(section.id)}&w=520&v=${section.pv}`} alt="Preview of the next artwork" onError={e=>{e.currentTarget.hidden=true;}}/>:<div className="artwork-blank">Pick a poster or logo to see how it would look.</div>}</figure>
      </aside>
      <div className="artwork-picker">
        <div className="artwork-toolbar">
          <div className="subtabs" role="tablist" aria-label="Poster or logo">{(['poster','logo'] as const).map(k=><button key={k} role="tab" aria-selected={tab===k} disabled={k==='logo'&&scope>0} title={k==='logo'&&scope>0?'Seasons use the series logo':undefined} onClick={()=>{setTab(k);if(k==='logo')setSource('all');}}>{k==='poster'?'Poster':'Logo'}</button>)}</div>
          {d.sections.length>1&&<select aria-label="Series or season" value={scope} onChange={e=>{const i=Number(e.target.value);setScope(i);if(i>0)setTab('poster');}}>{d.sections.map((s,i)=><option key={s.id} value={i}>{s.label?seasonName(s.label):'Series'}</option>)}</select>}
          {tab==='poster'&&<div className="toggle-group" role="radiogroup" aria-label="Show">{([['all','All'],['posters','Posters'],['backdrops','Backdrops']] as const).map(([k,label])=><button key={k} type="button" role="radio" aria-checked={source===k} onClick={()=>setSource(k)}>{label}</button>)}</div>}
          {tab==='poster'&&source!=='backdrops'&&<select aria-label="Posters with or without text" value={text} onChange={e=>setText(e.target.value as typeof text)}><option value="all">With or without text</option><option value="textless">Without text</option><option value="text">With text</option></select>}
        </div>
        <p className="muted small">{source==='backdrops'?'Pick a wide image and crop a poster out of it.':`Click a ${tab} to try it and compare Current with Preview. Drop or paste your own image anywhere here.`}</p>
        {source!=='backdrops'&&<div className={`artwork-gallery ${tab}s`} aria-busy={!!busy}>
          <button className="artwork-add" disabled={!!busy} onClick={()=>setAdding(true)}><b>+</b><span>Add your own</span><small>Upload, link or drop</small></button>
          {generatedTile}
          {tab==='poster'&&(backdrops.loading||wide.length>0)&&<button className="artwork-add" onClick={()=>setSource('backdrops')}><Icon name="grid" size={26}/><span>Crop from a backdrop</span><small>{backdrops.loading?'Looking…':`${wide.length} to choose from`}</small></button>}
          {tab==='logo'&&scope===0&&<button className={`artwork-add${d.no_logo?' selected':''}`} aria-pressed={d.no_logo} disabled={!!busy} onClick={()=>void act('nologo',()=>api('/admin/artwork/title/no-logo','POST',{id:d.id,on:!d.no_logo}),d.no_logo?'Logos are back on for this title.':'This title’s artwork will be made without a logo.')}><b>⊘</b><span>No logo</span><small>{d.no_logo?'Selected':'Artwork without a logo'}</small></button>}
          {shown.map(tile)}
          {remote.loading&&Array.from({length:6},(_,i)=><div key={i} className="skeleton artwork-skeleton"/>)}
        </div>}
        {(source!=='posters'&&tab==='poster')&&wide.length>0&&<>{source==='all'&&<h3 className="small">Backdrops ({wide.length}) · click one to crop a poster from it</h3>}<div className="artwork-gallery backdrops">{wide.map(tile)}</div></>}
        {remoteState.error&&<ErrorNotice message={`Couldn’t search online: ${remoteState.error.message}`} retry={remoteState.reload}/>}
        {!remoteState.loading&&!remoteState.error&&remoteState.data&&!remoteState.data.items.length&&<p className="muted small">{source==='backdrops'?'No backdrops found.':'Nothing found online for this one.'}</p>}
        {!!remote.data?.notes.length&&<p className="muted small">Some sources didn’t answer: {remote.data.notes.join(' · ')}</p>}
      </div>
    </div>
    {adding&&<AddOwn kind={tab} onClose={()=>setAdding(false)} file={file=>{setAdding(false);void upload$(file);}} link={url=>{setAdding(false);void act('add',()=>api('/admin/artwork/title/import','POST',{...target(),url,use:true}),`Added. It’s the selected ${tab} now.`);}}/>}
    {crop&&<Crop item={crop.x} target={crop.target} onClose={()=>setCrop(undefined)} use={box=>{const x=crop.x;setCrop(undefined);void act(`r:${sourceOf(x)}`,()=>api('/admin/artwork/title/import','POST',{id:section.id,kind:'poster',...(x.plex?{plex:x.plex}:{url:x.url}),use:true,crop:box}),'Cropped. It’s the selected poster now.');}}/>}
    {zoom&&<Modal title={zoom.label} onClose={()=>setZoom(undefined)}><img className="artwork-zoom" src={zoom.src} alt=""/></Modal>}
    {tint&&g&&<BackgroundColor at={tint} color={g.color} fallback={g.default} onUse={recolor} onClose={()=>setTint(undefined)}/>}
  </section>;
}
// Right-click on the Generated tile: draw the background again in another colour, or its default. It replaces the one
// before rather than adding a tile, and becomes the poster. Rendered in the top layer, like the library's menus.
function BackgroundColor({at,color,fallback,onUse,onClose}:{at:{x:number;y:number};color:string;fallback:string;onUse:(color:string|null)=>void;onClose:()=>void}) {
  const ref=useRef<HTMLDivElement>(null),[value,setValue]=useState(color);
  useEffect(()=>{
    const pop=ref.current!;pop.showPopover();
    const {width,height}=pop.getBoundingClientRect(),margin=8;
    pop.style.left=`${Math.min(Math.max(margin,at.x),innerWidth-width-margin)}px`;pop.style.top=`${Math.min(Math.max(margin,at.y),innerHeight-height-margin)}px`;
    pop.querySelector<HTMLInputElement>('input')?.focus({preventScroll:true});
  },[]);
  return <div ref={ref} popover="auto" className="artwork-color-pop" role="dialog" aria-label="Background colour" onContextMenu={e=>e.preventDefault()}
    onToggle={e=>{if((e.nativeEvent as ToggleEvent).newState==='closed')onClose();}}>
    <strong>Background colour</strong>
    <div className="setting-line"><input type="color" aria-label="Colour" value={value} onChange={e=>setValue(e.target.value)}/><code>{value.toUpperCase()}</code></div>
    <div className="button-row"><button className="primary" disabled={value===color} onClick={()=>onUse(value)}>Use colour</button>
      <button disabled={color===fallback} title={`Default: ${fallback.toUpperCase()}`} onClick={()=>onUse(null)}>Reset to default</button></div>
  </div>;
}
function AddOwn({kind,onClose,file,link}:{kind:Kind;onClose:()=>void;file:(file:Blob)=>void;link:(url:string)=>void}) {
  const [url,setUrl]=useState(''),input=useRef<HTMLInputElement>(null);
  return <Modal title={`Add your own ${kind}`} onClose={onClose}>
    <div className="form-stack">
      <p className="muted small">{kind==='poster'?'Textless posters work best: the layout adds the logo.':'Transparent PNG logos work best.'} Up to 25 MB.</p>
      <div className="button-row"><button className="primary" onClick={()=>input.current?.click()}>Choose a file</button><input ref={input} type="file" accept="image/*" hidden onChange={e=>{const f=e.target.files?.[0];if(f)file(f);}}/></div>
      <form className="setting-line" onSubmit={e=>{e.preventDefault();if(url.trim())link(url.trim());}}><input className="grow" type="url" placeholder="Or paste an image address (https://…)" value={url} onChange={e=>setUrl(e.target.value)}/><button disabled={!url.trim()}>Add</button></form>
    </div>
  </Modal>;
}
// A poster-shaped frame over a backdrop: drag it, or click to move it there; zoom in to use a smaller part.
function Crop({item,target,onClose,use}:{item:RemoteItem;target:[number,number];onClose:()=>void;use:(box:{x:number;y:number;w:number;h:number})=>void}) {
  const image=useRef<HTMLImageElement>(null),[ratio,setRatio]=useState<number>(),[zoom,setZoom]=useState(1),[at,setAt]=useState<{x:number;y:number}>(),[failed,setFailed]=useState(false),drag=useRef<{x:number;y:number;fx:number;fy:number}|undefined>(undefined);
  const aspect=target[0]/target[1],W=ratio?Math.min(1,aspect/ratio)*zoom:1,H=ratio?Math.min(1,ratio/aspect)*zoom:1;
  const clamp=(p:{x:number;y:number})=>({x:Math.min(Math.max(p.x,0),1-W),y:Math.min(Math.max(p.y,0),1-H)});
  const pos=clamp(at??{x:(1-W)/2,y:(1-H)/2});
  const down=(e:PointerEvent<HTMLDivElement>)=>{
    const b=image.current!.getBoundingClientRect();let start=pos;
    if(!(e.target as HTMLElement).classList.contains('artwork-crop-frame')){start=clamp({x:(e.clientX-b.left)/b.width-W/2,y:(e.clientY-b.top)/b.height-H/2});setAt(start);}
    e.currentTarget.setPointerCapture(e.pointerId);drag.current={x:e.clientX,y:e.clientY,fx:start.x,fy:start.y};
  };
  const move=(e:PointerEvent<HTMLDivElement>)=>{const d=drag.current,b=image.current?.getBoundingClientRect();if(!d||!b)return;setAt(clamp({x:d.fx+(e.clientX-d.x)/b.width,y:d.fy+(e.clientY-d.y)/b.height}));};
  const px=Math.round(W*(item.width||image.current?.naturalWidth||0)),py=Math.round(H*(item.height||image.current?.naturalHeight||0)),up=px?target[0]/px:1;
  return <Modal title="Crop a poster from this backdrop" onClose={onClose}>
    <div className="form-stack">
      <p className="muted small">Drag the frame, or click the picture to move it there. Zoom in to use a smaller part.</p>
      <div className="artwork-crop" onPointerDown={down} onPointerMove={move} onPointerUp={()=>{drag.current=undefined;}} onPointerCancel={()=>{drag.current=undefined;}}>
        <img ref={image} src={item.view} alt="" draggable={false} onLoad={e=>setRatio(e.currentTarget.naturalWidth/e.currentTarget.naturalHeight)} onError={()=>setFailed(true)}/>
        {ratio&&<div className="artwork-crop-frame" style={{left:`${pos.x*100}%`,top:`${pos.y*100}%`,width:`${W*100}%`,height:`${H*100}%`}}/>}
      </div>
      <div className="setting-line"><label className="grow">Zoom<input type="range" min="25" max="100" value={125-zoom*100} onChange={e=>{const z=(125-Number(e.target.value))/100,cx=pos.x+W/2,cy=pos.y+H/2;setZoom(z);setAt({x:cx-W/zoom*z/2,y:cy-H/zoom*z/2});}}/></label>
        <small className={up>2.5?'danger':'muted'}>{failed?'This backdrop could not be loaded.':ratio?`${px} × ${py} px, scaled to ${target[0]} × ${target[1]}${up>1.05?` (${up.toFixed(1)}× enlarged${up>2.5?', may look soft':''})`:''}`:'Loading…'}</small></div>
      <div className="button-row"><button className="primary" disabled={!ratio} onClick={()=>use({x:pos.x,y:pos.y,w:W,h:H})}>Use this crop</button><button onClick={onClose}>Cancel</button></div>
    </div>
  </Modal>;
}
