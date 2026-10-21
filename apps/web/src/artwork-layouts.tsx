import {useEffect,useMemo,useRef,useState,type InputHTMLAttributes} from 'react';
import {api} from './api.js';
import {useApi} from './hooks.js';
import {Empty,ErrorNotice,Icon,Loading,Modal} from './components.js';
import {Card,remember,remembered,useMutation} from './settings-ui.js';
import {BADGE_NAMES,BANNER_CATEGORIES,CARD_GROUPS,TPL_GROUPS,type Field,type Group,type V} from './artwork-fields.js';

// Admin › Artwork › Layouts: change a layout's settings and watch one of your titles follow, then save them. Edits are
// kept per layout and per Poster, Season or Episode card until saved; the engine's worker renders each change in memory.
type Mode='poster'|'season'|'episode';
type TemplateLayout={name:string;uses:string[];media?:string[]|null;seasons:boolean;cards:boolean;poster:V;season:V;episode:V|null};
type Template={version:string;default:string;layouts:TemplateLayout[];fonts:string[];banners:Record<string,V>};
type Title={id:string;cat:string;title:string;year?:number;thumb:string|null};
const MODES:[Mode,string][]=[['poster','Poster'],['season','Season'],['episode','Episode card']];
const HEX=/^#[0-9a-f]{6}$/i;
const canon=(x:unknown):unknown=>Array.isArray(x)?x.map(canon):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canon((x as V)[k])])):x;
const same=(a:unknown,b:unknown)=>Array.isArray(a)&&Array.isArray(b)?[...a].sort().join()===[...b].sort().join()
  :typeof a==='string'&&typeof b==='string'&&HEX.test(a)&&HEX.test(b)?a.toLowerCase()===b.toLowerCase()
  :a&&b&&typeof a==='object'&&typeof b==='object'?JSON.stringify(canon(a))===JSON.stringify(canon(b)):a===b;
const named=(t:Title)=>t.title+(t.year?` (${t.year})`:'');
const modesFor=(l:TemplateLayout)=>MODES.filter(([m])=>m==='poster'||(m==='season'?l.seasons:l.cards));
const remembered$=()=>{try{return JSON.parse(remembered('artworkTemplate','{}')) as {name?:string;mode?:Mode;sample?:Partial<Record<Mode,string>>;closed?:Record<string,boolean>};}catch{return {};}};

export function LayoutEditor({engineReady,advanced}:{engineReady:boolean;advanced:()=>void}) {
  const template=useApi<Template>(engineReady?'/admin/artwork/template':undefined),titles=useApi<{titles:Title[]}>(engineReady?'/admin/artwork/titles':undefined);
  const kept=useMemo(remembered$,[]),[name,setName]=useState(kept.name??''),[mode,setMode]=useState<Mode>(kept.mode??'poster'),[sample,setSample]=useState<Partial<Record<Mode,string>>>(kept.sample??{});
  const [closed,setClosed]=useState<Record<string,boolean>>(kept.closed??{}),[edits,setEdits]=useState<Record<string,V>>({}),[find,setFind]=useState(''),[banner,setBanner]=useState('');
  const [preview,setPreview]=useState<{url?:string;note:string;error?:boolean;busy:boolean}>({note:'',busy:false}),[saved,setSaved]=useState(''),mutation=useMutation(()=>{});
  const data=template.data,layout=data?.layouts.find(l=>l.name===name)??data?.layouts.find(l=>l.name===data.default)??data?.layouts[0];
  const current:Mode=layout&&modesFor(layout).some(([m])=>m===mode)?mode:'poster',key=`${layout?.name}|${current}`,mine=edits[key]??{};
  const savedValues:V=layout?(layout[current]??layout.poster):{},values:V={...savedValues,...mine};
  // Preview on titles the layout is used for (any title when that isn't known); seasons and cards need a show.
  const samples=useMemo(()=>{const fit=(titles.data?.titles??[]).filter(t=>t.thumb&&(current==='poster'||t.cat==='tv')),media=layout?.media;const like=media?fit.filter(t=>media.includes(t.cat)):fit;return like.length?like:fit;},[titles.data,layout,current]);
  const sampleId=samples.some(t=>t.id===sample[current])?sample[current]:samples[0]?.id;
  useEffect(()=>{remember('artworkTemplate',JSON.stringify({name:layout?.name,mode:current,sample,closed}));},[layout?.name,current,sample,closed]);
  // One render in flight at most: changes made meanwhile are folded into the next one, so a dragged slider keeps up.
  const frame=useRef<HTMLDivElement>(null),inflight=useRef(false),again=useRef(false),latest=useRef<()=>void>(()=>{}),shown=useRef<string|undefined>(undefined);
  latest.current=()=>{
    if(!layout||!sampleId){setPreview(p=>({...p,note:!sampleId?(current==='poster'?'No title has a saved poster yet. Run a job first.':'No TV show has a saved poster yet.'):'',error:!sampleId}));return;}
    if(inflight.current){again.current=true;return;}
    inflight.current=true;again.current=false;
    const w=Math.min(720,Math.max(240,Math.round((frame.current?.clientWidth??400)*(window.devicePixelRatio||1))));
    const slow=window.setTimeout(()=>setPreview(p=>({...p,busy:true})),120);
    void fetch('/api/v1/admin/artwork/template/preview',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({layout:layout.name,mode:current,values:mine,id:sampleId,w,banner})})
      .then(async r=>{
        if(!r.ok)throw new Error(((await r.json().catch(()=>({}))) as {message?:string}).message??'The preview could not be made.');
        const note=(r.headers.get('X-Artwork-Note')??'').split(' '),url=URL.createObjectURL(await r.blob()),next=new Image();next.src=url;await next.decode().catch(()=>{});
        if(shown.current)URL.revokeObjectURL(shown.current);shown.current=url;
        setPreview({url,busy:false,note:[note.includes('no-still')&&'No episode still is saved for this show, so the card is drawn on its poster.',note.includes('no-logo')&&'This title has no logo saved, so none is drawn.'].filter(Boolean).join(' ')});
      })
      .catch(e=>setPreview(p=>({...p,busy:false,error:true,note:(e as Error).message})))
      .finally(()=>{window.clearTimeout(slow);inflight.current=false;if(again.current)latest.current();});
  };
  useEffect(()=>{latest.current();},[key,JSON.stringify(mine),sampleId,banner,data?.version]);
  useEffect(()=>()=>{if(shown.current)URL.revokeObjectURL(shown.current);},[]);
  if(!engineReady)return <Empty title="The artwork engine isn’t set up">Set it up (above) to edit layouts with a live preview.</Empty>;
  if(template.loading&&!data)return <Loading/>;
  if(template.error||!data||!layout)return <ErrorNotice message={template.error?.message??'No layouts.'} retry={template.reload}/>;
  const set=(k:string,v:unknown)=>{setSaved('');setEdits(all=>{const next={...(all[key]??{})};if(same(v,savedValues[k]))delete next[k];else next[k]=v;return {...all,[key]:next};});};
  const groups:Group[]=current==='episode'?CARD_GROUPS:TPL_GROUPS.filter(g=>!(g[2]&&current==='season'));
  const q=find.trim().toLowerCase(),match=(f:Field,group:string)=>!q||[f.label,f.k,group].some(s=>s.toLowerCase().includes(q));
  const others=data.layouts.filter(l=>l.name!==layout.name&&(current==='poster'||(current==='season'?l.seasons:l.cards)));
  const copy=(list:Field[],from:string)=>{const src=data.layouts.find(l=>l.name===from)?.[current];if(!src)return;for(const {k} of list)if(src[k]!==undefined)set(k,src[k]&&typeof src[k]==='object'?JSON.parse(JSON.stringify(src[k])):src[k]);};
  const count=Object.keys(mine).length,unsaved=(n:string)=>MODES.some(([m])=>Object.keys(edits[`${n}|${m}`]??{}).length>0);
  const save=()=>void mutation.run(async()=>{await api<Template>('/admin/artwork/template/save','POST',{layout:layout.name,mode:current,values:mine});
    setEdits(all=>{const rest={...all};delete rest[key];return rest;});template.reload();setSaved(`Saved. ${current==='episode'?'Episode cards':'Posters'} using ${layout.name} change the next time they’re made (Update changed titles, or push a title).`);});
  return <div className="artwork-template">
    <div className="artwork-toolbar">
      <select aria-label="Layout" value={layout.name} onChange={e=>setName(e.target.value)}>{data.layouts.map(l=><option key={l.name} value={l.name}>{l.name}{unsaved(l.name)?' •':''}</option>)}</select>
      {modesFor(layout).length>1&&<div className="toggle-group" role="radiogroup" aria-label="Poster, season or episode card">{modesFor(layout).map(([m,label])=><button key={m} type="button" role="radio" aria-checked={m===current} onClick={()=>setMode(m)}>{label}{Object.keys(edits[`${layout.name}|${m}`]??{}).length?' •':''}</button>)}</div>}
      <span className="muted small grow">{layout.uses.length?`Used for ${layout.uses.join(', ')}`:'Not used for anything yet'}</span>
      <label className="artwork-inline">Preview on<select value={sampleId??''} onChange={e=>setSample(s=>({...s,[current]:e.target.value}))}>{samples.map(t=><option key={t.id} value={t.id}>{named(t)}</option>)}</select></label>
      <button disabled={!samples.length} onClick={()=>setSample(s=>({...s,[current]:samples[Math.floor(Math.random()*samples.length)]!.id}))}>Shuffle</button>
      <button onClick={advanced}>New, delete or JSON…</button>
    </div>
    <div className="artwork-template-layout">
      <figure className="artwork-template-shot">
        <div ref={frame} className={`artwork-template-frame${preview.busy?' busy':''}${preview.error?' error':''}`} style={{aspectRatio:`${values.width??2000} / ${values.height??3000}`}}>{preview.url&&<img src={preview.url} alt="Preview"/>}{preview.busy&&<span className="spinner"/>}</div>
        <figcaption className={preview.error?'danger small':'muted small'}>{preview.note}</figcaption>
      </figure>
      <div className="artwork-template-controls">
        <div className="setting-line"><input type="search" className="grow" placeholder="Find a setting (name or field)" aria-label="Find a setting" value={find} onChange={e=>setFind(e.target.value)}/>
          {!q&&<><button onClick={()=>setClosed(Object.fromEntries(groups.map(([n])=>[n,true])))}>Collapse all</button><button onClick={()=>setClosed({})}>Expand all</button></>}</div>
        {current==='season'&&<p className="muted small">Saved as the layout’s season options.</p>}
        {current==='episode'&&<p className="muted small">Saved as the layout’s episode options · sizes in px on a 3200px card.</p>}
        {groups.map(([group,list])=>{
          const rows=list.filter(f=>(!f.when||f.when(values))&&match(f,group)),changed=list.filter(f=>f.k in mine).length;
          if(!rows.length)return null;
          return <details key={group} className="artwork-group" open={!!q||!closed[group]} onToggle={e=>{if(!q){const open=(e.currentTarget as HTMLDetailsElement).open;setClosed(c=>({...c,[group]:!open}));}}}>
            <summary><span className="grow">{group}{changed>0&&<span className="count">{changed}</span>}</span>
              {others.length>0&&<select aria-label={`Copy the ${group} settings from another layout`} value="" onClick={e=>e.stopPropagation()} onChange={e=>{copy(list,e.target.value);e.target.value='';}}><option value="">Copy from…</option>{others.map(l=><option key={l.name} value={l.name}>{l.name}</option>)}</select>}</summary>
            {rows.map(f=>f.banners?<Banners key={f.k} f={f} values={values} saved={savedValues} defaults={data.banners} banner={banner} setBanner={setBanner} set={set}/>
              :<FieldRow key={f.k} f={f} value={values[f.k]} fonts={data.fonts} changed={f.k in mine} set={v=>set(f.k,v)} reset={()=>set(f.k,savedValues[f.k])}/>)}
          </details>;})}
      </div>
    </div>
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    {(count>0||saved)&&<div className="button-row sticky-actions">{count>0&&<><span title={Object.entries(mine).map(([k,x])=>`${k}: ${JSON.stringify(savedValues[k])} → ${JSON.stringify(x)}`).join('\n')}>{count} unsaved change{count===1?'':'s'}</span>
      <button onClick={()=>setEdits(all=>{const rest={...all};delete rest[key];return rest;})}>Reset</button><button className="primary" disabled={mutation.busy} onClick={save}>{mutation.busy?'Saving…':`Save ${layout.name}`}</button></>}
      {saved&&!count&&<span className="success" role="status">{saved}</span>}</div>}
  </div>;
}
// A box that shows what is being typed while it has focus (so "1." isn't swapped for the saved number).
function Draft({value,commit,...rest}:{value:string;commit:(text:string)=>void}&Omit<InputHTMLAttributes<HTMLInputElement>,'value'|'onChange'>) {
  const [draft,setDraft]=useState<string|null>(null);
  return <input {...rest} value={draft??value} onChange={e=>{setDraft(e.target.value);commit(e.target.value);}} onBlur={()=>setDraft(null)}/>;
}
function FieldRow({f,value,fonts,changed,set,reset}:{f:Field;value:unknown;fonts:string[];changed:boolean;set:(v:unknown)=>void;reset:()=>void}) {
  const id=`tf-${f.k}`;let control;
  if(f.choices||f.badges){
    const options=f.choices??BADGE_NAMES,list=Array.isArray(value)?value as string[]:[],on=(v:string)=>f.badges?list.includes(v):value===v;
    control=<div className={f.badges?'artwork-chips':'toggle-group'} role="group" aria-label={f.label}>{options.map(([v,label])=><button key={v} type="button" aria-pressed={on(v)} onClick={()=>set(f.badges?BADGE_NAMES.map(b=>b[0]).filter(b=>b===v?!on(v):on(b)):v)}>{label}</button>)}</div>;
  } else if(f.fonts){
    const current=typeof value==='string'?value:'';
    control=<select id={id} value={current} onChange={e=>set(e.target.value)}><option value="">{f.fonts===true?'Default (plain font)':f.fonts}</option>{fonts.map(p=><option key={p} value={p}>{p.replace(/^.*\/fonts\//,'')}</option>)}{current&&!fonts.includes(current)&&<option value={current}>{current}</option>}</select>;
  } else if(f.bool){
    control=<input id={id} type="checkbox" role="switch" className="switch" checked={!!value} onChange={e=>set(e.target.checked)}/>;
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
  return <div className={`artwork-field${changed?' changed':''}`}><label htmlFor={id}>{f.label}<small>{f.k}</small></label>{control}
    <button type="button" className="icon-button" title="Back to the saved value" aria-label={`Reset ${f.label}`} disabled={!changed} onClick={reset}><Icon name="restart" size={14}/></button></div>;
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
  return <div>
    <div className="artwork-field"><label htmlFor="tf-banner">{f.label}<small>preview and edit</small></label>
      <select id="tf-banner" value={banner} onChange={e=>setBanner(e.target.value)}><option value="">None: the show’s own banner</option>{BANNER_CATEGORIES.map(([c,t])=><option key={c} value={c}>{t}</option>)}</select><span/></div>
    {!banner&&<p className="muted small">Pick a category to edit it.</p>}
    {banner&&subs.filter(s=>!s.when||s.when(values[f.k])).map(s=><FieldRow key={s.key} f={{k:`status_banners.${s.key}`,...s.s}} value={s.get(values[f.k])} fonts={[]} changed={!same(s.get(values[f.k]),s.get(saved[f.k]))} set={s.put} reset={()=>s.put(s.get(saved[f.k]))}/>)}
  </div>;
}
// New layouts (empty or a copy), deleting unused ones, and every field as JSON for what the editor doesn't show.
export function LayoutAdvanced({names,inUse,changed,back}:{names:string[];inUse:(name:string)=>boolean;changed:()=>void;back:()=>void}) {
  const [selected,setSelected]=useState(names[0]??''),[creating,setCreating]=useState(false);
  return <div className="form-stack">
    <button className="back-link" onClick={back}><Icon name="back" size={16}/>Layout editor</button>
    <div className="setting-line"><label className="grow">Layout<select value={selected} onChange={e=>setSelected(e.target.value)}>{names.map(name=><option key={name} value={name}>{name}{inUse(name)?' (in use)':''}</option>)}</select></label><button type="button" onClick={()=>setCreating(true)}><Icon name="plus" size={16}/>New layout</button></div>
    {selected?<JsonLayout key={selected} name={selected} inUse={inUse(selected)} changed={changed} removed={()=>{setSelected(names.find(n=>n!==selected)??'');changed();}}/>:<Empty title="No layouts">Create one to start.</Empty>}
    {creating&&<NewLayout names={names} from={selected} onClose={()=>setCreating(false)} created={name=>{setCreating(false);setSelected(name);changed();}}/>}
  </div>;
}
type Layout={name:string;revision:number;updatedAt:number;value:Record<string,unknown>};
function JsonLayout({name,inUse,changed,removed}:{name:string;inUse:boolean;changed:()=>void;removed:()=>void}) {
  const layout=useApi<Layout>(`/admin/artwork/layouts/${name}`),[text,setText]=useState(''),[done,setDone]=useState(false),mutation=useMutation(()=>{layout.reload();changed();});
  useEffect(()=>{if(layout.data)setText(JSON.stringify(layout.data.value,null,2));},[layout.data?.revision]);
  if(layout.loading&&!layout.data)return <Loading/>;
  if(layout.error)return <ErrorNotice message={layout.error.message} retry={layout.reload}/>;
  const current=layout.data!;
  let parsed:unknown,problem='';try{parsed=JSON.parse(text);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))problem='A layout is a JSON object of settings.';}catch(e){problem=(e as Error).message;}
  return <Card title={name} description="Every field, as the engine reads it."
    actions={<button type="button" className="danger" disabled={inUse||mutation.busy} title={inUse?'Choose another layout where this one is used first':undefined} onClick={()=>void mutation.run(async()=>{await api(`/admin/artwork/layouts/${name}`,'DELETE');removed();})}>Delete</button>}>
    <form className="form-stack" onSubmit={e=>{e.preventDefault();if(problem)return;setDone(false);void mutation.run(async()=>{await api(`/admin/artwork/layouts/${name}`,'PUT',{expectedRevision:current.revision,value:parsed});setDone(true);});}}>
      <textarea className="code-input" rows={24} spellCheck={false} value={text} aria-label={`${name} layout settings`} onChange={e=>{setText(e.target.value);setDone(false);}}/>
      {problem&&<p className="danger small">{problem}</p>}
      {mutation.error&&<ErrorNotice message={mutation.error}/>}
      <div className="button-row"><button className="primary" disabled={!!problem||mutation.busy}>Save layout</button>{done&&<span className="success" role="status">Saved.</span>}</div>
    </form>
  </Card>;
}
function NewLayout({names,from,onClose,created}:{names:string[];from:string;onClose:()=>void;created:(name:string)=>void}) {
  const [name,setName]=useState(''),[copy,setCopy]=useState(from),mutation=useMutation(()=>{});
  return <Modal title="New layout" onClose={onClose}>
    <form className="form-stack" onSubmit={e=>{e.preventDefault();void mutation.run(async()=>{const value=copy?(await api<Layout>(`/admin/artwork/layouts/${copy}`)).value:{};await api(`/admin/artwork/layouts/${name}`,'PUT',{expectedRevision:0,value});created(name);});}}>
      <label>Name<input required pattern="[A-Za-z0-9_\-]{1,40}" maxLength={40} value={name} onChange={e=>setName(e.target.value)}/><small>Letters, numbers, dashes or underscores.</small></label>
      <label>Start from<select value={copy} onChange={e=>setCopy(e.target.value)}><option value="">Engine defaults</option>{names.map(n=><option key={n} value={n}>{n}</option>)}</select></label>
      {mutation.error&&<ErrorNotice message={mutation.error}/>}
      <div className="button-row"><button className="primary" disabled={mutation.busy||names.includes(name)}>Create layout</button><button type="button" onClick={onClose}>Cancel</button></div>
    </form>
  </Modal>;
}
