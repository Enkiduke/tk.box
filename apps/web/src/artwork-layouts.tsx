import {useEffect,useMemo,useRef,useState,type CSSProperties,type InputHTMLAttributes,type ReactNode} from 'react';
import {api} from './api.js';
import {useApi} from './hooks.js';
import {Empty,ErrorNotice,Icon,Loading,Modal} from './components.js';
import {Card,remember,remembered,useMutation} from './settings-ui.js';
import {BACKGROUND_LAYER,BANNER_CATEGORIES,CARD_LAYERS,POSTER_LAYERS,isOn,layerFields,turned,type Field,type Layer,type Section,type V} from './artwork-fields.js';

// Admin › Artwork › Layouts: pick a layout and edit it in the poster studio, a large window with the layout's layers on the
// left, one of your titles drawn with the changes in the middle and the chosen layer's settings on the right. Edits are kept
// per layout until saved, also when the studio is closed; the engine's worker renders each change in memory. A season or
// episode template (tk-tv-season) is a layout of its own that extends its show layout (tk-tv): whatever it doesn't set
// itself, and the logo, come from there.
type Role='poster'|'season'|'episode';
type TemplateLayout={name:string;base:string|null;role:Role;uses:string[];media?:string[]|null;values:V;inherited?:V};
type Template={version:string;default:string;layouts:TemplateLayout[];fonts:string[];banners:Record<string,V>;glows:Record<string,string>};
type Title={id:string;cat:string;title:string;year?:number;thumb:string|null;kind?:string;service?:string};
// What a title is, as a layout's `media` names it: movies, tv, or collections:<kind> for each kind of collection.
const sortOf=(t:Title)=>t.cat==='collections'?`collections:${t.kind??'collection'}`:t.cat;
const SORTS:Record<string,string>={movies:'movie',tv:'TV show','collections:collection':'franchise or curated collection','collections:streaming':'streaming collection',
  'collections:chart':'chart collection','collections:custom':'custom collection'};
const either=(names:string[])=>names.length<2?names.join(''):`${names.slice(0,-1).join(', ')} or ${names[names.length-1]}`;
// Where the engine drew each layer in the preview: [left, top, right, bottom] in the image's w x h pixels.
type Box=[number,number,number,number];type Boxes={w:number;h:number;boxes:Record<string,Box>};
const boxesOf=(header:string|null)=>{try{return header?JSON.parse(header) as Boxes:undefined;}catch{return undefined;}};
const MADE:Record<Role,string>={poster:'Posters',season:'Season posters',episode:'Episode cards'};
const ROLE_ICON:Record<Role,string>={poster:'image',season:'collection',episode:'shows'};
const HEX=/^#[0-9a-f]{6}$/i;
const canon=(x:unknown):unknown=>Array.isArray(x)?x.map(canon):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canon((x as V)[k])])):x;
const same=(a:unknown,b:unknown)=>Array.isArray(a)&&Array.isArray(b)?[...a].sort().join()===[...b].sort().join()
  :typeof a==='string'&&typeof b==='string'&&HEX.test(a)&&HEX.test(b)?a.toLowerCase()===b.toLowerCase()
  :a&&b&&typeof a==='object'&&typeof b==='object'?JSON.stringify(canon(a))===JSON.stringify(canon(b)):a===b;
const named=(t:Title)=>t.title+(t.year?` (${t.year})`:'');
const clone=(x:unknown)=>x&&typeof x==='object'?JSON.parse(JSON.stringify(x)):x;
// Each layout followed by its season and episode templates.
const tiered=(all:TemplateLayout[])=>all.filter(l=>!l.base).flatMap(l=>[l,...(['season','episode'] as const).flatMap(r=>all.filter(c=>c.base===l.name&&c.role===r))]);
const described=(l:TemplateLayout)=>l.base?`${MADE[l.role]} for shows using ${l.base}`:l.uses.length?`Used for ${l.uses.join(', ')}`:'Not used for anything yet';
// Season posters get the poster's layers without the badges; layouts used for collections also get their Background.
const layersFor=(role:Role,collections:boolean):Layer[]=>role==='episode'?CARD_LAYERS:role==='poster'?(collections?[POSTER_LAYERS[0]!,BACKGROUND_LAYER,...POSTER_LAYERS.slice(1)]:POSTER_LAYERS)
  :POSTER_LAYERS.filter(l=>!l.posterOnly).map(l=>({...l,sections:l.sections.filter(s=>!s.posterOnly)}));
// The keys a row writes, and whether it differs between two sets of values (a badge switch only looks at its own badge).
const keysOf=(f:Field)=>f.anchor?[f.k,f.anchor.v]:[f.k];
const differs=(f:Field,a:V,b:V)=>f.badge?isOn(f,a[f.k])!==isOn(f,b[f.k]):keysOf(f).some(k=>!same(a[k],b[k]));
type Kept={name?:string;sample?:Partial<Record<Role,string>>;layer?:Partial<Record<Role,string>>;open?:Record<string,boolean>;keys?:boolean};
const remembered$=()=>{try{return JSON.parse(remembered('artworkTemplate','{}')) as Kept;}catch{return {};}};

export function LayoutEditor({engineReady,advanced}:{engineReady:boolean;advanced:()=>void}) {
  const template=useApi<Template>(engineReady?'/admin/artwork/template':undefined),titles=useApi<{titles:Title[]}>(engineReady?'/admin/artwork/titles':undefined);
  const kept=useMemo(remembered$,[]),[name,setName]=useState(kept.name??''),[editing,setEditing]=useState(false);
  const [sample,setSample]=useState<Partial<Record<Role,string>>>(kept.sample??{}),[layer,setLayer]=useState<Partial<Record<Role,string>>>(kept.layer??{});
  const [open,setOpen]=useState<Record<string,boolean>>(kept.open??{}),[keys,setKeys]=useState(!!kept.keys),[edits,setEdits]=useState<Record<string,V>>({});
  const data=template.data,layout=data?.layouts.find(l=>l.name===name)??data?.layouts.find(l=>l.name===data.default)??data?.layouts[0];
  useEffect(()=>{remember('artworkTemplate',JSON.stringify({name:layout?.name,sample,layer,open,keys}));},[layout?.name,sample,layer,open,keys]);
  if(!engineReady)return <Empty title="The artwork engine isn’t set up">Set it up (above) to edit layouts with a live preview.</Empty>;
  if(template.loading&&!data)return <Loading/>;
  if(template.error||!data||!layout)return <ErrorNotice message={template.error?.message??'No layouts.'} retry={template.reload}/>;
  const unsaved=(n:string)=>Object.keys(edits[n]??{}).length;
  return <div className="artwork-template">
    <div className="artwork-toolbar"><span className="muted small grow">Open a layout in the poster studio to change it, drawn live on one of your titles.</span><button onClick={advanced}>New, delete or JSON…</button></div>
    <ul className="artwork-layout-list">{tiered(data.layouts).map(l=><li key={l.name} className={l.base?'child':undefined}>
      <button type="button" className="artwork-layout-row" onClick={()=>{setName(l.name);setEditing(true);}}>
        <Icon name={ROLE_ICON[l.role]} size={18}/><span className="grow"><strong>{l.name}</strong><small>{described(l)}</small></span>
        {l.name===data.default&&<span className="artwork-layout-tag">Default</span>}
        {unsaved(l.name)>0&&<span className="artwork-layout-tag unsaved">{unsaved(l.name)} unsaved</span>}
        <span className="artwork-layout-edit">Edit</span></button></li>)}</ul>
    {editing&&<Modal title={`Edit ${layout.name}`} onClose={()=>setEditing(false)}>
      <Studio data={data} layout={layout} reload={template.reload} titles={titles.data?.titles??[]} edits={edits} setEdits={setEdits} setName={setName}
        sample={sample} setSample={setSample} layer={layer} setLayer={setLayer} open={open} setOpen={setOpen} keys={keys} setKeys={setKeys}/></Modal>}
  </div>;
}
type Setter<T>=(next:T|((was:T)=>T))=>void;
type StudioProps={data:Template;layout:TemplateLayout;reload:()=>void;titles:Title[];edits:Record<string,V>;setEdits:Setter<Record<string,V>>;setName:(n:string)=>void;
  sample:Partial<Record<Role,string>>;setSample:Setter<Partial<Record<Role,string>>>;layer:Partial<Record<Role,string>>;setLayer:Setter<Partial<Record<Role,string>>>;
  open:Record<string,boolean>;setOpen:Setter<Record<string,boolean>>;keys:boolean;setKeys:(on:boolean)=>void};
function Studio({data,layout,reload,titles,edits,setEdits,setName,sample,setSample,layer,setLayer,open,setOpen,keys,setKeys}:StudioProps) {
  const current=layout.role,key=layout.name,mine=edits[key]??{},savedValues=layout.values,values:V={...savedValues,...mine},inherited=layout.inherited;
  const [find,setFind]=useState(''),[banner,setBanner]=useState(''),[saved,setSaved]=useState(''),mutation=useMutation(()=>{});
  const [preview,setPreview]=useState<{url?:string;note:string;error?:boolean;busy:boolean;boxes?:Boxes}>({note:'',busy:false}),[hover,setHover]=useState<string>();
  // Preview on titles the layout is used for (any title when that isn't known); seasons and cards need a show.
  // Only titles of the kinds the layout is used for, collections by their kind; any title when that isn't known. None of
  // them having a poster yet is said, not covered up with other titles.
  const media=layout.media;
  const samples=useMemo(()=>titles.filter(t=>t.thumb&&(current==='poster'||t.cat==='tv')&&(!media||media.includes(sortOf(t)))),[titles,media,current]);
  const missing=current!=='poster'?'No TV show has a saved poster yet. Run Update to make some.':!media?'No title has a saved poster yet. Run Update to make some.'
    :`No ${either(media.map(m=>SORTS[m]??m))} has a saved poster yet. ${media.some(m=>m.startsWith('collections:'))?'Turn on Collection posters in Artwork’s settings and run Update to make them.':'Run Update to make some.'}`;
  const sampleId=samples.some(t=>t.id===sample[current])?sample[current]:samples[0]?.id;
  // One render in flight at most: changes made meanwhile are folded into the next one, so a dragged slider keeps up.
  const frame=useRef<HTMLDivElement>(null),inflight=useRef(false),again=useRef(false),latest=useRef<()=>void>(()=>{}),shown=useRef<string|undefined>(undefined);
  latest.current=()=>{
    if(!sampleId){setPreview({note:missing,busy:false});return;}
    if(inflight.current){again.current=true;return;}
    inflight.current=true;again.current=false;
    const w=Math.min(720,Math.max(240,Math.round((frame.current?.clientWidth??400)*(window.devicePixelRatio||1))));
    const slow=window.setTimeout(()=>setPreview(p=>({...p,busy:true})),120);
    void fetch('/api/v1/admin/artwork/template/preview',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({layout:layout.name,values:mine,id:sampleId,w,banner})})
      .then(async r=>{
        if(!r.ok)throw new Error(((await r.json().catch(()=>({}))) as {message?:string}).message??'The preview could not be made.');
        const note=(r.headers.get('X-Artwork-Note')??'').split(' '),url=URL.createObjectURL(await r.blob()),next=new Image();next.src=url;await next.decode().catch(()=>{});
        if(shown.current)URL.revokeObjectURL(shown.current);shown.current=url;
        setPreview({url,busy:false,boxes:boxesOf(r.headers.get('X-Artwork-Boxes')),note:[note.includes('no-still')&&'No episode still is saved for this show, so the card is drawn on its poster.',note.includes('no-logo')&&'This title has no logo saved, so none is drawn.'].filter(Boolean).join(' ')});
      })
      .catch(e=>setPreview(p=>({...p,busy:false,error:true,note:(e as Error).message})))
      .finally(()=>{window.clearTimeout(slow);inflight.current=false;if(again.current)latest.current();});
  };
  useEffect(()=>{latest.current();},[key,JSON.stringify(mine),sampleId,banner,data.version]);
  useEffect(()=>()=>{if(shown.current)URL.revokeObjectURL(shown.current);},[]);
  const set=(k:string,v:unknown)=>{setSaved('');setEdits(all=>{const next={...(all[key]??{})};if(same(v,savedValues[k]))delete next[k];else next[k]=v;return {...all,[key]:next};});};
  const layers=layersFor(current,!!media?.some(m=>m.startsWith('collections:'))),selected=layers.find(l=>l.id===layer[current])??layers[0]!;
  const pick=(id:string)=>{setLayer(all=>({...all,[current]:id}));setFind('');};
  const reset=(f:Field)=>f.badge?set(f.k,turned(f,values[f.k],isOn(f,savedValues[f.k]))):keysOf(f).forEach(k=>set(k,savedValues[k]));
  const inherit=(f:Field)=>{const ks=keysOf(f);return layout.base&&inherited&&!f.badge&&ks.every(k=>k in inherited)
    ?{from:layout.base,follows:ks.every(k=>same(values[k],inherited[k])),use:()=>ks.forEach(k=>set(k,inherited[k]))}:undefined;};
  const others=data.layouts.filter(l=>l.name!==layout.name&&l.role===current);
  // Copies every row of the chosen layer from another layout of the same kind; badge switches copy only their own badge.
  const copy=(from:string)=>{
    const src=data.layouts.find(l=>l.name===from)?.values;if(!src)return;
    const next:V={...values},fields=layerFields(selected);
    for(const f of fields){if(f.badge){if(Array.isArray(src[f.k]))next[f.k]=turned(f,next[f.k],isOn(f,src[f.k]));}else for(const k of keysOf(f))if(src[k]!==undefined)next[k]=clone(src[k]);}
    for(const k of new Set(fields.flatMap(keysOf)))set(k,next[k]);
  };
  const count=Object.keys(mine).length,children=data.layouts.filter(l=>l.base===layout.name).map(l=>l.name);
  const save=()=>void mutation.run(async()=>{await api<Template>('/admin/artwork/template/save','POST',{layout:layout.name,values:mine});
    setEdits(all=>{const rest={...all};delete rest[key];return rest;});reload();
    setSaved(`Saved. ${MADE[current]} using ${layout.name}${children.length?`, and the ${children.join(' and ')} settings that follow it,`:''} change the next time they’re made (Update changed titles, or push a title).`);});
  const row=(f:Field)=>f.glows?<Glows key={f.k} f={f} values={values} saved={savedValues} defaults={data.glows} set={set}/>
    :f.banners?<Banners key={f.k} f={f} values={values} saved={savedValues} defaults={data.banners} banner={banner} setBanner={setBanner} set={set}/>
    :f.anchor?<AnchorRow key={f.k} f={f} values={values} changed={differs(f,values,savedValues)} set={set} reset={()=>reset(f)} inherit={inherit(f)}/>
    :<FieldRow key={f.k+(f.badge??'')} f={f} value={values[f.k]} fonts={data.fonts} changed={differs(f,values,savedValues)} set={v=>set(f.k,v)} reset={()=>reset(f)} inherit={inherit(f)}/>;
  const ratio=preview.boxes?preview.boxes.w/preview.boxes.h:Number(values.width??(current==='episode'?3200:2000))/Number(values.height??(current==='episode'?1800:3000));
  // Clicking the preview opens the smallest layer drawn there; the border is wherever the poster itself isn't.
  const drawn=preview.boxes,inside=([l,t,r,b]:Box,x:number,y:number)=>x>=l&&x<=r&&y>=t&&y<=b,area=([l,t,r,b]:Box)=>(r-l)*(b-t);
  const hitAt=(e:{clientX:number;clientY:number;currentTarget:HTMLElement})=>{
    if(!drawn)return undefined;const rect=e.currentTarget.getBoundingClientRect(),x=(e.clientX-rect.left)/rect.width*drawn.w,y=(e.clientY-rect.top)/rect.height*drawn.h;
    const {artwork,border}=drawn.boxes;if(border&&artwork&&!inside(artwork,x,y)&&layers.some(l=>l.id==='border'))return 'border';
    return Object.entries(drawn.boxes).filter(([n,box])=>n!=='border'&&inside(box,x,y)&&layers.some(l=>l.id===n)).sort((a,b)=>area(a[1])-area(b[1]))[0]?.[0];
  };
  // An outline for a layer that doesn't fill the whole preview.
  const outline=(id:string|undefined,kind:string)=>{const box=id&&drawn?.boxes[id];if(!box||!drawn||area(box)>=drawn.w*drawn.h*0.95)return null;const [l,t,r,b]=box;
    return <span className={`studio-outline ${kind}`} style={{left:`${l/drawn.w*100}%`,top:`${t/drawn.h*100}%`,width:`${(r-l)/drawn.w*100}%`,height:`${(b-t)/drawn.h*100}%`}}>{kind==='hover'&&<em>{layers.find(x=>x.id===id)?.label}</em>}</span>;};
  const visible=(f:Field)=>!f.when||f.when(values),on=(l:Layer)=>!l.show||isOn(l.show,values[l.show.k]);
  // Finding a setting lists the matching rows of every layer; a layer's name opens it.
  const q=find.trim().toLowerCase(),hits=(l:Layer)=>q?l.sections.flatMap(s=>s.fields.filter(f=>visible(f)&&[f.label,f.k,s.name].some(x=>x.toLowerCase().includes(q)))):[];
  const section=(l:Layer,s:Section)=>{
    const rows=s.fields.filter(visible);if(!rows.length)return null;
    const id=`${current}/${l.id}/${s.name}`,changed=s.fields.filter(f=>differs(f,values,savedValues)).length;
    return <details key={s.name} className="studio-section" open={open[id]??!s.folded} onToggle={e=>{const now=(e.currentTarget as HTMLDetailsElement).open;setOpen(o=>({...o,[id]:now}));}}>
      <summary>{s.name}{changed>0&&<span className="count">{changed}</span>}</summary>
      {s.note&&<p className="muted small">{s.note}</p>}{rows.map(row)}</details>;
  };
  return <div className={`poster-studio${keys?' keys':''}`}>
    <header className="studio-head">
      <div className="studio-head-group grow">
      <Icon name={ROLE_ICON[current]}/>
      <select className="studio-layout" aria-label="Layout" value={layout.name} onChange={e=>setName(e.target.value)}>{tiered(data.layouts).map(l=><option key={l.name} value={l.name}>{l.base?'  ↳ ':''}{l.name}{Object.keys(edits[l.name]??{}).length?' •':''}</option>)}</select>
      <span className="muted small studio-described">{described(layout)}</span>
      </div>
      <div className="studio-head-group studio-sample">
        <span className="muted small">Preview on</span>
        <select aria-label="Preview on" disabled={!samples.length} value={sampleId??''} onChange={e=>setSample(s=>({...s,[current]:e.target.value}))}>{samples.map(t=><option key={t.id} value={t.id}>{named(t)}</option>)}</select>
        <button type="button" disabled={!samples.length} onClick={()=>setSample(s=>({...s,[current]:samples[Math.floor(Math.random()*samples.length)]!.id}))}>Shuffle</button>
      </div>
      <div className="studio-head-group grow studio-head-end">
      <input type="search" className="studio-find" placeholder="Find a setting" aria-label="Find a setting" value={find} onChange={e=>setFind(e.target.value)}/>
      {count>0&&<span className="studio-unsaved" title={Object.entries(mine).map(([k,x])=>`${k}: ${JSON.stringify(savedValues[k])} → ${JSON.stringify(x)}`).join('\n')}>{count} unsaved</span>}
      {count>0&&<button type="button" onClick={()=>setEdits(all=>{const rest={...all};delete rest[key];return rest;})}>Reset</button>}
      <button type="button" className="primary" disabled={!count||mutation.busy} onClick={save}>{mutation.busy?'Saving…':'Save'}</button>
      </div>
    </header>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    {saved&&!count&&<p className="success small" role="status">{saved}</p>}
    <div className="studio-body">
      <nav className="studio-layers" aria-label="Layers">
        <h4>Layers</h4>
        <ul>{layers.map(l=>{const changed=layerFields(l).filter(f=>differs(f,values,savedValues)).length,lit=on(l);
          return <li key={l.id} className={l.parent?'child':undefined}>
            <button type="button" className={`studio-layer${l.id===selected.id&&!q?' active':''}${lit?'':' off'}${q&&!hits(l).length?' dim':''}`} aria-current={l.id===selected.id&&!q?'true':undefined} onClick={()=>pick(l.id)}>
              <Icon name={l.icon} size={16}/><span className="grow">{l.label}</span>{l.tv&&<span className="studio-tag">TV</span>}{changed>0&&<span className="count">{changed}</span>}</button>
            {l.show&&<button type="button" className="icon-button studio-eye" aria-pressed={lit} aria-label={`${lit?'Hide':'Show'} ${l.label}`} title={lit?'Shown: click to hide':'Hidden: click to show'}
              onClick={()=>set(l.show!.k,turned(l.show!,values[l.show!.k],!lit))}><Icon name={lit?'eye':'eye-off'} size={16}/></button>}</li>;})}</ul>
        <label className="studio-keys"><input type="checkbox" role="switch" className="switch" checked={keys} onChange={e=>setKeys(e.target.checked)}/>Show field names</label>
      </nav>
      <section className="studio-canvas" aria-label="Preview">
        <div className="studio-stage"><div ref={frame} className={`artwork-template-frame${preview.busy?' busy':''}${preview.error?' error':''}`} style={{'--ratio':ratio,aspectRatio:String(ratio)} as CSSProperties}>{preview.url&&<img src={preview.url} alt="Preview"/>}
          {drawn&&<div className="studio-picker" title="Click a part of the poster to edit it" onMouseMove={e=>setHover(hitAt(e))} onMouseLeave={()=>setHover(undefined)} onClick={e=>{const id=hitAt(e);if(id)pick(id);}}>
            {!q&&outline(selected.id,'selected')}{hover!==(q?undefined:selected.id)&&outline(hover,'hover')}</div>}
          {preview.busy&&<span className="spinner"/>}</div></div>
        <p className={preview.error?'danger small':'muted small'}>{preview.note}</p>
      </section>
      <aside className="studio-inspector" aria-label={q?'Matching settings':`${selected.label} settings`}>
        {q?<>{layers.map(l=>{const found=hits(l);return found.length?<div key={l.id} className="studio-hits"><button type="button" className="link-button" onClick={()=>pick(l.id)}><Icon name={l.icon} size={14}/>{l.label}</button>{found.map(row)}</div>:null;})}
          {!layers.some(l=>hits(l).length)&&<p className="muted small">No setting matches “{find.trim()}”.</p>}</>
        :<>
          <div className="studio-inspector-head"><h3><Icon name={selected.icon} size={18}/>{selected.label}{selected.tv&&<span className="studio-tag">TV</span>}</h3>
            {others.length>0&&<select aria-label={`Copy the ${selected.label} settings from another layout`} value="" onChange={e=>{copy(e.target.value);e.target.value='';}}><option value="">Copy from…</option>{others.map(l=><option key={l.name} value={l.name}>{l.name}</option>)}</select>}</div>
          {layout.base&&<p className="muted small">Settings marked “from {layout.base}” follow {layout.base}; change one to set it here.{current==='episode'&&' Sizes in px on a 3200px card.'}</p>}
          {children.length>0&&<p className="muted small">{children.join(' and ')} follow these settings wherever they don’t set their own.</p>}
          {selected.show&&<FieldRow f={{...selected.show,label:'Visible'}} value={values[selected.show.k]} fonts={[]} changed={differs(selected.show,values,savedValues)} set={v=>set(selected.show!.k,v)} reset={()=>reset(selected.show!)} inherit={inherit(selected.show)}/>}
          {on(selected)?selected.sections.map(s=>section(selected,s)):<p className="muted small">{selected.label} is hidden. Switch it on to edit it.</p>}
          {selected.shared&&<p className="muted small studio-shared">{selected.shared.note} <button type="button" className="link-button" onClick={()=>pick(selected.shared!.to)}>Open {layers.find(l=>l.id===selected.shared!.to)?.label}</button></p>}
        </>}
      </aside>
    </div>
  </div>;
}
// A box that shows what is being typed while it has focus (so "1." isn't swapped for the saved number).
function Draft({value,commit,...rest}:{value:string;commit:(text:string)=>void}&Omit<InputHTMLAttributes<HTMLInputElement>,'value'|'onChange'>) {
  const [draft,setDraft]=useState<string|null>(null);
  return <input {...rest} value={draft??value} onChange={e=>{setDraft(e.target.value);commit(e.target.value);}} onBlur={()=>setDraft(null)}/>;
}
// In a season or episode template, `inherit` says whether the setting follows its show layout, and puts it back to that.
type Inherit={from:string;follows:boolean;use:()=>void};
function Row({id,f,changed,reset,inherit,children}:{id?:string;f:Field;changed:boolean;reset:()=>void;inherit?:Inherit;children:ReactNode}) {
  return <div className={`artwork-field${changed?' changed':''}`}><label htmlFor={id}>{f.label}<small className="artwork-key">{f.anchor?`${f.k}, ${f.anchor.v}`:f.k}</small>{inherit?.follows&&<small className="artwork-from">from {inherit.from}</small>}</label>{children}
    <span className="artwork-field-actions">{inherit&&!inherit.follows&&<button type="button" className="link-button small" title={`Follow ${inherit.from} again`} onClick={inherit.use}>Use {inherit.from}’s</button>}
      <button type="button" className="icon-button" title="Back to the saved value" aria-label={`Reset ${f.label}`} disabled={!changed} onClick={reset}><Icon name="restart" size={14}/></button></span></div>;
}
function FieldRow({f,value,fonts,changed,set,reset,inherit}:{f:Field;value:unknown;fonts:string[];changed:boolean;set:(v:unknown)=>void;reset:()=>void;inherit?:Inherit}) {
  const id=`tf-${f.k}${f.badge?`-${f.badge}`:''}`;let control;
  if(f.choices){
    control=<div className="toggle-group" role="group" aria-label={f.label}>{f.choices.map(([v,label])=><button key={v} type="button" aria-pressed={value===v} onClick={()=>set(v)}>{label}</button>)}</div>;
  } else if(f.fonts){
    const current=typeof value==='string'?value:'';
    control=<select id={id} value={current} onChange={e=>set(e.target.value)}><option value="">{f.fonts===true?'Default (plain font)':f.fonts}</option>{fonts.map(p=><option key={p} value={p}>{p.replace(/^.*\/fonts\//,'')}</option>)}{current&&!fonts.includes(current)&&<option value={current}>{current}</option>}</select>;
  } else if(f.bool||f.badge||f.flip){
    control=<input id={id} type="checkbox" role="switch" className="switch" checked={isOn(f,value)} onChange={e=>set(f.bool?e.target.checked:turned(f,value,e.target.checked))}/>;
  } else if(f.text!==undefined){
    control=<input id={id} type="text" placeholder={f.text} spellCheck={false} value={typeof value==='string'?value:''} onChange={e=>set(e.target.value)}/>;
  } else if(f.color){
    const text=typeof value==='string'?value:'';
    control=<span className="artwork-color">{f.auto&&<button type="button" aria-pressed={value==='auto'} onClick={()=>set('auto')}>Auto</button>}
      <input id={id} type="color" value={HEX.test(text)?text.toLowerCase():'#000000'} onChange={e=>set(e.target.value.toUpperCase())}/>
      <Draft className="artwork-number" maxLength={7} spellCheck={false} aria-label={`${f.label} (hex)`} value={text} commit={t=>{const v=t.trim();if(HEX.test(v))set(v.toUpperCase());else if(f.auto&&v.toLowerCase()==='auto')set('auto');}}/></span>;
  } else {
    const n=typeof value==='number'?value:Number(value??0);
    control=<span className="artwork-range"><input id={id} type="range" min={f.min} max={f.max} step={f.int?1:f.step} value={n} onChange={e=>set(Number(e.target.value))}/>
      <Draft className="artwork-number" type="number" step={f.int?1:'any'} aria-label={f.label} value={String(n)} commit={t=>{if(t!==''&&Number.isFinite(Number(t)))set(f.int?Math.round(Number(t)):Number(t));}}/></span>;
  }
  return <Row id={id} f={f} changed={changed} reset={reset} inherit={inherit}>{control}</Row>;
}
// Where something sits, as a grid of its corners, edges and center: one click sets both the across and the down field.
function AnchorRow({f,values,changed,set,reset,inherit}:{f:Field;values:V;changed:boolean;set:(k:string,v:unknown)=>void;reset:()=>void;inherit?:Inherit}) {
  const {v,across,down}=f.anchor!;
  return <Row f={f} changed={changed} reset={reset} inherit={inherit}>
    <div className="artwork-anchor" role="group" aria-label={f.label} style={{gridTemplateColumns:`repeat(${across.length},1fr)`}}>
      {down.flatMap(d=>across.map(h=>{const at=values[f.k]===h&&values[v]===d,name=d===h?d:`${d} ${h}`;
        return <button key={`${d}-${h}`} type="button" aria-pressed={at} aria-label={name} title={name[0]!.toUpperCase()+name.slice(1)} onClick={()=>{set(f.k,h);set(v,d);}}><span/></button>;}))}
    </div></Row>;
}
// Each streaming service's glow: its own color unless the layout picks another. Saved as the layout's streaming_colors
// mapping, which holds only the services whose color differs.
function Glows({f,values,saved,defaults,set}:{f:Field;values:V;saved:V;defaults:Record<string,string>;set:(k:string,v:unknown)=>void}) {
  const pick=(all:unknown,name:string)=>((all??{}) as Record<string,string>)[name]??defaults[name]!;
  const put=(name:string,v:unknown)=>{const all={...((values[f.k]??{}) as Record<string,string>)};if(same(v,defaults[name]))delete all[name];else all[name]=String(v);set(f.k,all);};
  return <div className="artwork-glows">{Object.keys(defaults).map(name=><FieldRow key={name} f={{k:`streaming_colors.${name}`,label:name,color:true}} value={pick(values[f.k],name)} fonts={[]}
    changed={!same(pick(values[f.k],name),pick(saved[f.k],name))} set={v=>put(name,v)} reset={()=>put(name,pick(saved[f.k],name))}/>)}</div>;
}
// The status banner's categories: pick one (the preview shows it too) to edit its words, colors, bar, window and priority.
// They are saved as the layout's status_banners mapping, which holds only what differs from the defaults.
function Banners({f,values,saved,defaults,banner,setBanner,set}:{f:Field;values:V;saved:V;defaults:Record<string,V>;banner:string;setBanner:(c:string)=>void;set:(k:string,v:unknown)=>void}) {
  const defs=defaults[banner]??{},mine=(all:unknown)=>((all??{}) as Record<string,V>)[banner]??{};
  const pick=(all:unknown,k:string)=>k in mine(all)?mine(all)[k]:defs[k];
  const global=values.status_banner_backdrop_opacity,kept=(k:string)=>k in mine(saved[f.k]);
  const put=(k:string,v:unknown)=>{
    const all=JSON.parse(JSON.stringify(values[f.k]??{})) as Record<string,V>,entry={...mine(all)};
    if(same(v,defs[k])&&!kept(k))delete entry[k];else entry[k]=v;
    if(Object.keys(entry).length)all[banner]=entry;else delete all[banner];set(f.k,all);
  };
  const barOn=(all:unknown)=>pick(all,'backdrop')!==false;
  const subs:{s:Omit<Field,'k'>;key:string;get:(all:unknown)=>unknown;put:(v:unknown)=>void;when?:(all:unknown)=>boolean}[]=[
    {s:{label:'Show this category',bool:true},key:'enabled',get:all=>pick(all,'enabled'),put:v=>put('enabled',v)},
    {s:{label:'Words',text:'{season} {episode} {date}'},key:'text',get:all=>pick(all,'text'),put:v=>put('text',v)},
    {s:{label:'Text color',color:true},key:'color',get:all=>pick(all,'color'),put:v=>put('color',v)},
    {s:{label:'Bar behind the words',bool:true},key:'bar',get:barOn,put:v=>put('backdrop',v?defs.backdrop||'#000000':false)},
    {s:{label:'Bar color',color:true},key:'backdrop',get:all=>pick(all,'backdrop')||'#000000',put:v=>put('backdrop',v),when:barOn},
    {s:{label:'Bar opacity',min:0,max:1,step:0.01},key:'opacity',get:all=>pick(all,'opacity')??global,put:v=>put('opacity',same(v,global)&&!kept('opacity')?null:v),when:barOn},
    {s:{label:'Window in days',min:0,max:365,int:true},key:'days',get:all=>pick(all,'days'),put:v=>put('days',v),when:()=>defs.days!=null},
    {s:{label:'Priority (heaviest wins)',min:0,max:1000,int:true},key:'weight',get:all=>pick(all,'weight'),put:v=>put('weight',v)}];
  return <div className="artwork-banners">
    <p className="muted small">Pick a category to preview and edit it.</p>
    <div className="artwork-chips" role="group" aria-label={f.label}>
      {([['','None']] as [string,string][]).concat(BANNER_CATEGORIES).map(([c,t])=><button key={c||'none'} type="button" aria-pressed={banner===c} title={c?undefined:'The show’s own banner'} onClick={()=>setBanner(c)}>{t}</button>)}</div>
    {banner&&subs.filter(s=>!s.when||s.when(values[f.k])).map(s=><FieldRow key={s.key} f={{k:`status_banners.${s.key}`,...s.s}} value={s.get(values[f.k])} fonts={[]} changed={!same(s.get(values[f.k]),s.get(saved[f.k]))} set={s.put} reset={()=>s.put(s.get(saved[f.k]))}/>)}
  </div>;
}
export type LayoutEntry={name:string;base?:string;role?:'season'|'episode'};
// New layouts (empty or a copy) and season or episode templates, deleting unused ones, and every field as JSON for what
// the editor doesn't show. `inUse` says why a layout can't be deleted yet.
export function LayoutAdvanced({layouts,inUse,changed,back}:{layouts:LayoutEntry[];inUse:(name:string)=>string|null;changed:()=>void;back:()=>void}) {
  const names=layouts.map(l=>l.name),[selected,setSelected]=useState(names[0]??''),[creating,setCreating]=useState(false);
  return <div className="form-stack">
    <button className="back-link" onClick={back}><Icon name="back" size={16}/>Layout editor</button>
    <div className="setting-line"><label className="grow">Layout<select value={selected} onChange={e=>setSelected(e.target.value)}>{names.map(name=><option key={name} value={name}>{name}{inUse(name)?' (in use)':''}</option>)}</select></label><button type="button" onClick={()=>setCreating(true)}><Icon name="plus" size={16}/>New layout</button></div>
    {selected?<JsonLayout key={selected} name={selected} inUse={inUse(selected)} changed={changed} removed={()=>{setSelected(names.find(n=>n!==selected)??'');changed();}}/>:<Empty title="No layouts">Create one to start.</Empty>}
    {creating&&<NewLayout layouts={layouts} from={selected} onClose={()=>setCreating(false)} created={name=>{setCreating(false);setSelected(name);changed();}}/>}
  </div>;
}
type Layout={name:string;revision:number;updatedAt:number;value:Record<string,unknown>};
function JsonLayout({name,inUse,changed,removed}:{name:string;inUse:string|null;changed:()=>void;removed:()=>void}) {
  const layout=useApi<Layout>(`/admin/artwork/layouts/${name}`),[text,setText]=useState(''),[done,setDone]=useState(false),mutation=useMutation(()=>{layout.reload();changed();});
  useEffect(()=>{if(layout.data)setText(JSON.stringify(layout.data.value,null,2));},[layout.data?.revision]);
  if(layout.loading&&!layout.data)return <Loading/>;
  if(layout.error)return <ErrorNotice message={layout.error.message} retry={layout.reload}/>;
  const current=layout.data!;
  let parsed:unknown,problem='';try{parsed=JSON.parse(text);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))problem='A layout is a JSON object of settings.';}catch(e){problem=(e as Error).message;}
  return <Card title={name} description="Every field, as the engine reads it."
    actions={<button type="button" className="danger" disabled={!!inUse||mutation.busy} title={inUse??undefined} onClick={()=>void mutation.run(async()=>{await api(`/admin/artwork/layouts/${name}`,'DELETE');removed();})}>Delete</button>}>
    <form className="form-stack" onSubmit={e=>{e.preventDefault();if(problem)return;setDone(false);void mutation.run(async()=>{await api(`/admin/artwork/layouts/${name}`,'PUT',{expectedRevision:current.revision,value:parsed});setDone(true);});}}>
      <textarea className="code-input" rows={24} spellCheck={false} value={text} aria-label={`${name} layout settings`} onChange={e=>{setText(e.target.value);setDone(false);}}/>
      {problem&&<p className="danger small">{problem}</p>}
      {mutation.error&&<ErrorNotice message={mutation.error}/>}
      <div className="button-row"><button className="primary" disabled={!!problem||mutation.busy}>Save layout</button>{done&&<span className="success" role="status">Saved.</span>}</div>
    </form>
  </Card>;
}
// A season or episode template starts empty: everything follows its layout until changed.
function NewLayout({layouts,from,onClose,created}:{layouts:LayoutEntry[];from:string;onClose:()=>void;created:(name:string)=>void}) {
  const names=layouts.map(l=>l.name),[name,setName]=useState(''),[copy,setCopy]=useState(layouts.some(l=>l.name===from&&!l.base)?from:''),[kind,setKind]=useState(''),mutation=useMutation(()=>{});
  const kinds=layouts.filter(l=>!l.base).flatMap(l=>(['season','episode'] as const).filter(r=>!layouts.some(c=>c.base===l.name&&c.role===r)).map(r=>[`${l.name}|${r}`,`${r==='season'?'Season':'Episode'} template for ${l.name}`]));
  const [base,role]=kind.split('|');
  const pick=(next:string)=>{setKind(next);if(next)setName(next.replace('|','-'));};
  return <Modal title="New layout" onClose={onClose}>
    <form className="form-stack" onSubmit={e=>{e.preventDefault();void mutation.run(async()=>{const value=kind?{extends:base,role}:copy?(await api<Layout>(`/admin/artwork/layouts/${copy}`)).value:{};await api(`/admin/artwork/layouts/${name}`,'PUT',{expectedRevision:0,value});created(name);});}}>
      <label>Kind<select value={kind} onChange={e=>pick(e.target.value)}><option value="">A layout of its own</option>{kinds.map(([k,label])=><option key={k} value={k}>{label}</option>)}</select></label>
      <label>Name<input required pattern="[A-Za-z0-9_\-]{1,40}" maxLength={40} value={name} onChange={e=>setName(e.target.value)}/><small>Letters, numbers, dashes or underscores.</small></label>
      {!kind&&<label>Start from<select value={copy} onChange={e=>setCopy(e.target.value)}><option value="">Engine defaults</option>{layouts.filter(l=>!l.base).map(l=><option key={l.name} value={l.name}>{l.name}</option>)}</select></label>}
      {mutation.error&&<ErrorNotice message={mutation.error}/>}
      <div className="button-row"><button className="primary" disabled={mutation.busy||names.includes(name)}>Create layout</button><button type="button" onClick={onClose}>Cancel</button></div>
    </form>
  </Modal>;
}
