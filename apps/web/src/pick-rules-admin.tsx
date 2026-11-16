import {useEffect,useRef,useState,type ReactNode} from 'react';
import type {FormatCondition,FormatInput,FormatView,LibrarySettingsView,PickProfile,PickProfileView,PickRules,ProfileTier,TryRelease} from '../../../packages/contracts/src/downloads.js';
import {api} from './api.js';
import {useApiAll} from './hooks.js';
import {ErrorNotice,Icon,Loading} from './components.js';
import {SectionHead,Switch,plural,useDragOrder,moveTo} from './settings-ui.js';
import {toast} from './toasts.js';
import {ACTIONS,Dash,Field,FieldError,IconAction,Panel,Pill,RowActions,SaveBar,Segmented,Table,Tabs,Tag,changed,matches,useSave,useSorted} from './manage-ui.js';

// Admin › Manage › Quality (docs/PROFILES.md, "The page"; docs/UI.md): the profiles (tiers, scores, upgrades, sizes),
// the formats they score, and Try a release. Early copies, the protocol order and the default profile sit with the
// profiles.

type Tab='profiles'|'formats'|'try';
const MB=1024**2,GB=1024**3;
// What a tier's MB/min comes to for a two-hour movie.
const twoHours=(size?:[number,number])=>size?`${(size[0]*MB*120/GB).toFixed(1)}–${(size[1]*MB*120/GB).toFixed(1)} GB`:undefined;
const preferredText=(p:PickProfile)=>p.tiers.slice(0,p.preferred).flatMap(t=>t.qualities).join(', ');

export function PickRulesPage() {
  const view=useApiAll<PickRules|LibrarySettingsView>(['/admin/library/rules','/admin/library/settings']);
  const [rules,settings]=view.data as [PickRules|undefined,LibrarySettingsView|undefined];
  const [tab,setTab]=useState<Tab>('profiles'),[open,setOpen]=useState<number|'new'>();
  return <><SectionHead title="Quality"/>
    {view.error&&!rules?<ErrorNotice message={(view.error as Error).message} retry={changed}/>:!rules||!settings?<Loading/>:<>
      <Tabs label="Quality" value={tab} onChange={t=>{setTab(t);setOpen(undefined);}} tabs={[{id:'profiles',label:'Profiles',count:rules.profiles.length},
        {id:'formats',label:'Formats',count:rules.formats.length},{id:'try',label:'Try a release'}]}/>
      {tab==='profiles'?open!==undefined?<ProfileEditor key={open==='new'?'new':`${open}:${rules.profiles.find(p=>p.id===open)?.version}`} rules={rules}
          profile={open==='new'?undefined:rules.profiles.find(p=>p.id===open)} isDefault={open===settings.defaultProfile} close={()=>setOpen(undefined)} saved={setOpen}/>
        :<><ProfileList rules={rules} defaultProfile={settings.defaultProfile} open={setOpen}/><Choosing key={settings.revision} settings={settings} profiles={rules.profiles}/></>
      :tab==='formats'?<Formats key={rules.formatsVersion} rules={rules}/>:<TryPanel/>}
    </>}
  </>;
}

// ---- Profiles ----

function ProfileList({rules,defaultProfile,open}:{rules:PickRules;defaultProfile:number;open:(id:number|'new')=>void}) {
  const save=useSave(changed);
  const duplicate=(p:PickProfileView)=>void save.run(async()=>{
    let name=`${p.name} copy`;for(let i=2;rules.profiles.some(x=>x.name.toLowerCase()===name.toLowerCase());i++)name=`${p.name} copy ${i}`;
    const result=await api<PickRules>('/admin/library/profiles','POST',{name,value:p.value});
    toast.success(`${name} made`);const made=result.profiles.find(x=>x.name===name);if(made)open(made.id);});
  const reset=(p:PickProfileView)=>{if(!window.confirm(`Put ${p.name} back as it shipped?`))return;
    void save.run(async()=>{await api(`/admin/library/profiles/${p.id}/reset`,'POST',{expectedVersion:p.version});toast.success(`${p.name} reset`);});};
  const remove=(p:PickProfileView)=>{if(!window.confirm(`Delete ${p.name}?`))return;
    void save.run(async()=>{await api(`/admin/library/profiles/${p.id}`,'DELETE');toast.success(`${p.name} deleted`);});};
  return <Panel flush title="Profiles" actions={<button type="button" onClick={()=>open('new')}><Icon name="plus" size={15}/>New profile</button>}
    footer={save.error?<SaveBar dirty={false} busy={false} error={save.error} onCancel={save.clear}/>:undefined}>
    <Table columns={[{label:'Profile'},{label:'Size, 2 h',width:150,num:true},{label:'Upgrade until',width:120,num:true},{label:'Titles',width:80,num:true},ACTIONS]}>
      {rules.profiles.map(p=><tr key={p.id}>
        <td><div className="ui-title"><div>
          <button type="button" className="ui-title-name ui-link" onClick={()=>open(p.id)}>{p.name}</button>
          {p.id===defaultProfile&&<span className="ui-title-tags"><Pill tone="ok">Default</Pill></span>}
          <small title={preferredText(p.value)}>{preferredText(p.value)}</small></div></div></td>
        <td className="num">{twoHours(p.value.tiers[0]?.size)??<Dash/>}</td>
        <td className="num">{p.value.upgradeUntil??<Dash/>}</td>
        <td className="num">{p.used}</td>
        <td><RowActions>
          <IconAction icon="text" label={`Edit ${p.name}`} onClick={()=>open(p.id)}/>
          <IconAction icon="plus" label={`Duplicate ${p.name}`} disabled={save.busy} onClick={()=>duplicate(p)}/>
          {p.builtIn&&<IconAction icon="restart" label={`Reset ${p.name}`} disabled={save.busy} onClick={()=>reset(p)}/>}
          <IconAction icon="trash" label={p.id===defaultProfile?'The default profile can’t be deleted':p.used?`${plural(p.used,'title')} use it`:`Delete ${p.name}`}
            disabled={save.busy||p.id===defaultProfile||p.used>0} onClick={()=>remove(p)}/>
        </RowActions></td>
      </tr>)}
    </Table>
  </Panel>;
}

function Choosing({settings,profiles}:{settings:LibrarySettingsView;profiles:PickProfileView[]}) {
  const start={earlyCopies:settings.earlyCopies,protocol:settings.protocol,defaultProfile:settings.defaultProfile};
  const [draft,setDraft]=useState(start),save=useSave(changed);
  const dirty=JSON.stringify(draft)!==JSON.stringify(start);
  const submit=()=>void save.run(async()=>{await api('/admin/library/settings','PUT',{expectedRevision:settings.revision,...draft});toast.success('Saved');});
  return <form onSubmit={e=>{e.preventDefault();submit();}}><Panel flush title="Choosing"
    footer={<SaveBar dirty={dirty} busy={save.busy} error={save.error} onCancel={()=>{setDraft(start);save.clear();}} onReload={changed}/>}>
    <Field label="Default profile" hint="New requests and titles"><select value={draft.defaultProfile} onChange={e=>setDraft(d=>({...d,defaultProfile:Number(e.target.value)}))}>{profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
    <Field label="Protocol" hint="Asked first"><Segmented label="Protocol" value={draft.protocol} onChange={protocol=>setDraft(d=>({...d,protocol}))}
      options={[['usenet-first','Usenet first'],['torrent-first','Torrents first']] as const}/></Field>
    <Field label="Early copies" hint="Before the home release"><Switch label="" ariaLabel="Early copies" checked={draft.earlyCopies} onChange={earlyCopies=>setDraft(d=>({...d,earlyCopies}))}/></Field>
  </Panel></form>;
}

const BLANK:PickProfile={tiers:[{qualities:['WEBDL-1080p'],size:[15,130]}],preferred:1,scores:{},upgradeUntil:40,upgradeStep:15};
const intText=(n?:number)=>n===undefined?'':String(n);
const intOf=(text:string)=>text.trim()===''?undefined:Math.trunc(Number(text));

function ProfileEditor({rules,profile,isDefault,close,saved}:{rules:PickRules;profile?:PickProfileView;isDefault:boolean;close:()=>void;saved:(id:number)=>void}) {
  const start={name:profile?.name??'',value:profile?.value??BLANK};
  const [name,setName]=useState(start.name),[value,setValue]=useState<PickProfile>(start.value),save=useSave(changed),drag=useDragOrder();
  const [shown,setShown]=useState<'scored'|'all'>(profile?'scored':'all');
  const set=(patch:Partial<PickProfile>)=>setValue(v=>({...v,...patch}));
  const setTier=(i:number,patch:Partial<ProfileTier>)=>setValue(v=>({...v,tiers:v.tiers.map((t,j)=>j===i?{...t,...patch}:t)}));
  const used=new Set(value.tiers.flatMap(t=>t.qualities)),free=rules.ladder.filter(q=>!used.has(q)).reverse();
  const sizeError=(s?:[number,number])=>!s?undefined:!(s[0]>=0&&s[1]<=1000)?'0 to 1000':s[0]>=s[1]?'Smallest first':undefined;
  const errors={name:!name.trim()?'Required':undefined,
    preferred:value.preferred<1||value.preferred>value.tiers.length?`1 to ${value.tiers.length}`:!value.tiers.slice(0,value.preferred).some(t=>t.qualities.some(q=>!rules.earlyCopies.includes(q)))?'Needs a quality besides the early copies':undefined,
    tiers:value.tiers.some(t=>!t.qualities.length)?'A tier needs a quality':value.tiers.some(t=>sizeError(t.size))?'Fix the sizes':undefined,
    scores:value.minScore!==undefined&&value.upgradeUntil!==undefined&&value.minScore>value.upgradeUntil?'Minimum over upgrade-until':undefined,
    step:!(value.upgradeStep>=1&&value.upgradeStep<=1000)?'1 to 1000':undefined};
  const invalid=Object.values(errors).some(Boolean),dirty=!profile||name!==start.name||JSON.stringify(value)!==JSON.stringify(start.value);
  const submit=()=>{if(invalid)return;void save.run(async()=>{
    const result=profile?await api<PickRules>(`/admin/library/profiles/${profile.id}`,'PUT',{expectedVersion:profile.version,name:name.trim(),value})
      :await api<PickRules>('/admin/library/profiles','POST',{name:name.trim(),value});
    toast.success(`${name.trim()} saved`);
    const id=profile?.id??result.profiles.find(p=>p.name.toLowerCase()===name.trim().toLowerCase())?.id;if(id)saved(id);});};
  const setScore=(format:string,points:number|'ban'|undefined)=>setValue(v=>{const scores={...v.scores};if(points===undefined||points===0)delete scores[format];else scores[format]=points;return {...v,scores};});
  const formats=rules.formats.filter(f=>shown==='all'||value.scores[f.name]!==undefined);
  const footer=<SaveBar dirty={dirty} busy={save.busy} error={save.error} invalid={invalid} label={profile?'Save':'Create'} onReload={changed}
    onCancel={()=>{if(profile){setName(start.name);setValue(start.value);save.clear();}else close();}}/>;
  return <form onSubmit={e=>{e.preventDefault();submit();}}>
    <Panel title={<><button type="button" className="icon-button" aria-label="Back to profiles" title="Back to profiles" onClick={close}><Icon name="back" size={16}/></button>{profile?profile.name:'New profile'}
      {isDefault&&<Pill tone="ok">Default</Pill>}</>}>
      <Field label="Name" hint={profile?plural(profile.used,'title'):undefined}>
        <input required maxLength={40} aria-invalid={!!errors.name} value={name} onChange={e=>setName(e.target.value)}/><FieldError>{errors.name}</FieldError></Field>
      <Field label="Preferred tiers" hint="Meet the cutoff">
        <input type="number" min={1} max={value.tiers.length} aria-invalid={!!errors.preferred} value={value.preferred} onChange={e=>set({preferred:Number(e.target.value)})}/><FieldError>{errors.preferred}</FieldError></Field>
      <Field label="Minimum score"><input type="number" placeholder="None" value={intText(value.minScore)} onChange={e=>setValue(v=>{const {minScore:_,...rest}=v,n=intOf(e.target.value);return n===undefined?rest:{...rest,minScore:n};})}/>
        <FieldError>{errors.scores}</FieldError></Field>
      <Field label="Upgrade until" hint="Score upgrades stop here"><input type="number" placeholder="No score upgrades" value={intText(value.upgradeUntil)}
        onChange={e=>setValue(v=>{const {upgradeUntil:_,...rest}=v,n=intOf(e.target.value);return n===undefined?rest:{...rest,upgradeUntil:n};})}/></Field>
      <Field label="Upgrade step" hint="Smallest rise worth a download"><input type="number" min={1} max={1000} aria-invalid={!!errors.step} value={value.upgradeStep} onChange={e=>set({upgradeStep:Number(e.target.value)})}/>
        <FieldError>{errors.step}</FieldError></Field>
    </Panel>
    <Panel flush title="Tiers" actions={<button type="button" disabled={value.tiers.length>=20} onClick={()=>set({tiers:[...value.tiers,{qualities:[]}]})}><Icon name="plus" size={15}/>Add tier</button>}>
      {errors.tiers&&<p className="ui-hint danger-text">{errors.tiers}</p>}
      <Table columns={[{label:<span className="sr-only">Order</span>,width:40},{label:'Qualities'},{label:'',width:110},{label:'MB a minute',width:220},{label:'2 h',width:110,num:true},ACTIONS]}>
        {value.tiers.map((t,i)=><tr key={i} {...drag('tiers',i,(from,to)=>set({tiers:moveTo(value.tiers,from,to)}))}>
          <td><span className="ui-grip" title="Drag to reorder"><Icon name="grip" size={16}/></span></td>
          <td><div className="ui-chips">{t.qualities.map(q=><button type="button" key={q} className="ui-chip on" title={`Remove ${q}`} onClick={()=>setTier(i,{qualities:t.qualities.filter(x=>x!==q)})}>{q}<Icon name="close" size={12}/></button>)}
            {free.length>0&&<select className="ui-chip-add" aria-label="Add a quality" value="" onChange={e=>{if(e.target.value)setTier(i,{qualities:[...t.qualities,e.target.value]});}}>
              <option value="">Add…</option>{free.map(q=><option key={q} value={q}>{q}</option>)}</select>}</div></td>
          <td>{i<value.preferred?<Pill tone="ok">Preferred</Pill>:<Pill tone="wait">Fallback</Pill>}</td>
          <td>{t.size?<div className="ui-inline-pair">
              <input type="number" aria-label="Smallest MB a minute" min={0} max={1000} aria-invalid={!!sizeError(t.size)} value={t.size[0]} onChange={e=>setTier(i,{size:[Number(e.target.value),t.size![1]]})}/>
              <input type="number" aria-label="Largest MB a minute" min={0} max={1000} aria-invalid={!!sizeError(t.size)} value={t.size[1]} onChange={e=>setTier(i,{size:[t.size![0],Number(e.target.value)]})}/>
              <IconAction icon="close" label="No size limits" onClick={()=>setValue(v=>({...v,tiers:v.tiers.map((x,j)=>j===i?{qualities:x.qualities}:x)}))}/></div>
            :<button type="button" onClick={()=>setTier(i,{size:[10,100]})}>Limit sizes</button>}</td>
          <td className="num">{twoHours(t.size)??<Dash/>}</td>
          <td><RowActions><IconAction icon="trash" label="Remove tier" disabled={value.tiers.length<=1}
            onClick={()=>setValue(v=>({...v,tiers:v.tiers.filter((_,j)=>j!==i),preferred:Math.max(1,Math.min(v.preferred-(i<v.preferred?1:0),v.tiers.length-1))}))}/></RowActions></td>
        </tr>)}
      </Table>
    </Panel>
    <Panel flush title="Scores" actions={<Segmented label="Formats shown" value={shown} onChange={setShown} options={[['scored','Scored'],['all','All']] as const}/>} footer={footer}>
      <Table columns={[{label:'Format'},{label:'Category',width:130},{label:'Points',width:240}]} empty={formats.length?undefined:'No scored formats'}>
        {formats.map(f=>{const points=value.scores[f.name];return <tr key={f.name} className={points===undefined?'is-off':undefined}>
          <td><span className="ui-title-name">{f.name}</span>{f.label&&<span className="ui-title-tags"><Tag>{f.label}</Tag></span>}<small>{conditionsText(f.conditions)}</small></td>
          <td>{f.category}</td>
          <td><div className="ui-inline-pair">
            <input type="number" aria-label={`Points for ${f.name}`} min={-1000} max={1000} disabled={points==='ban'} placeholder="0"
              value={points==='ban'||points===undefined?'':points} onChange={e=>setScore(f.name,intOf(e.target.value))}/>
            <label className="ui-check"><input type="checkbox" checked={points==='ban'} onChange={e=>setScore(f.name,e.target.checked?'ban':undefined)}/>Ban</label></div></td>
        </tr>;})}
      </Table>
    </Panel>
  </form>;
}

// ---- Formats ----

const FIELD_NAMES:Record<string,string>={quality:'Quality',resolution:'Resolution',source:'Source',remux:'Remux',codec:'Codec',hdr:'HDR',audio:'Audio',atmos:'Atmos',
  service:'Service',group:'Group',edition:'Edition',language:'Language',flag:'Flag',title:'Name matches'};
const BOOLEAN=new Set(['remux','atmos']);
function conditionsText(conditions:FormatCondition[]) {
  return conditions.map(c=>{const what=BOOLEAN.has(c.field)?FIELD_NAMES[c.field]:`${FIELD_NAMES[c.field]??c.field} ${c.values.length>3?`${c.values.slice(0,3).join(', ')} +${c.values.length-3}`:c.values.join(' or ')}`;
    return `${c.negate?'not ':''}${what}${c.required?'':' (any)'}`;}).join(' · ');
}
type Row=FormatInput&{key:number};
let nextKey=0;
const rowsOf=(formats:FormatView[]):Row[]=>formats.map(f=>({...f,from:f.name,key:nextKey++}));
const formatErrors=(f:Row,all:Row[])=>{
  const name=!f.name.trim()?'Required':all.some(o=>o.key!==f.key&&o.name.trim().toLowerCase()===f.name.trim().toLowerCase())?'Another format has this name':undefined;
  const label=f.label&&!/^[A-Za-z0-9 +.-]*$/.test(f.label)?'Letters, digits, spaces and + . - only':undefined;
  const conditions=!f.conditions.length?'Add a condition':f.conditions.some(c=>!BOOLEAN.has(c.field)&&!c.values.length)?'A condition needs a value'
    :f.conditions.some(c=>c.field==='title'&&c.values.some(v=>{try{new RegExp(v,'i');return false;}catch{return true;}}))?'Not a valid pattern':undefined;
  return {name,label,conditions};
};

function Formats({rules}:{rules:PickRules}) {
  const [rows,setRows]=useState(()=>rowsOf(rules.formats)),[editing,setEditing]=useState<number>(),save=useSave(changed);
  const [query,setQuery]=useState('');
  const plain=(list:Row[])=>list.map(({key:_,from,...f})=>({...f,...(from?{from}:{})}));
  const dirty=JSON.stringify(plain(rows).map(({from:_,...f})=>f))!==JSON.stringify(rules.formats)||rows.some(r=>r.from&&r.from!==r.name);
  const invalid=rows.some(r=>Object.values(formatErrors(r,rows)).some(Boolean));
  const scoredBy=(name?:string)=>name?rules.profiles.filter(p=>p.value.scores[name]!==undefined).length:0;
  const set=(key:number,patch:Partial<Row>)=>setRows(list=>list.map(r=>r.key===key?{...r,...patch}:r));
  const add=()=>{const row:Row={name:'New format',category:'Other',conditions:[{field:'group',values:[],required:true}],key:nextKey++};setRows(list=>[...list,row]);setEditing(row.key);setQuery('');};
  const submit=()=>{if(invalid)return;void save.run(async()=>{
    await api('/admin/library/formats','PUT',{expectedVersion:rules.formatsVersion,formats:plain(rows).map(f=>({...f,name:f.name.trim(),...(f.label?.trim()?{label:f.label.trim()}:{label:undefined})}))});
    setEditing(undefined);toast.success('Formats saved');});};
  const found=rows.filter(r=>matches(query,r.name,r.label,r.category,...r.conditions.flatMap(c=>c.values)));
  const {rows:shown,sort,onSort}=useSorted(found,{name:r=>r.name,category:r=>r.category,profiles:r=>scoredBy(r.from)});
  const open=rows.find(r=>r.key===editing);
  return <form onSubmit={e=>{e.preventDefault();submit();}}>
    {open&&<FormatEditor key={open.key} row={open} rows={rows} rules={rules} set={patch=>set(open.key,patch)} done={()=>setEditing(undefined)}/>}
    <Panel flush title="Formats" actions={<>
      <label className="ui-search"><Icon name="search" size={15}/><input type="search" placeholder="Search formats" aria-label="Search formats" value={query} onChange={e=>setQuery(e.target.value)}/></label>
      <button type="button" onClick={add}><Icon name="plus" size={15}/>Add format</button></>}
      footer={<SaveBar dirty={dirty} busy={save.busy} error={save.error} invalid={invalid} onCancel={()=>{setRows(rowsOf(rules.formats));setEditing(undefined);save.clear();}} onReload={changed}/>}>
      <Table columns={[{label:'Format',sort:'name'},{label:'Category',width:130,sort:'category'},{label:'Used',width:80,num:true,sort:'profiles',desc:true},ACTIONS]}
        sort={sort} onSort={onSort} empty={shown.length?undefined:'No formats'}>
        {shown.map(r=>{const bad=Object.values(formatErrors(r,rows)).some(Boolean);return <tr key={r.key} className={editing===r.key?'ui-editing':undefined}>
          <td><button type="button" className={`ui-title-name ui-link ${bad?'danger-text':''}`} onClick={()=>setEditing(r.key)}>{r.name||'Untitled format'}</button>
            {r.label&&<span className="ui-title-tags"><Tag>{r.label}</Tag></span>}<small title={conditionsText(r.conditions)}>{conditionsText(r.conditions)}</small></td>
          <td>{r.category}</td>
          <td className="num">{scoredBy(r.from)||<Dash/>}</td>
          <td><RowActions><IconAction icon="text" label={`Edit ${r.name}`} onClick={()=>setEditing(r.key)}/>
            <IconAction icon="trash" label={scoredBy(r.from)?`Delete ${r.name} (${plural(scoredBy(r.from),'profile')} score it)`:`Delete ${r.name}`}
              onClick={()=>{setRows(list=>list.filter(x=>x.key!==r.key));if(editing===r.key)setEditing(undefined);}}/></RowActions></td>
        </tr>;})}
      </Table>
    </Panel>
  </form>;
}

function FormatEditor({row,rows,rules,set,done}:{row:Row;rows:Row[];rules:PickRules;set:(patch:Partial<Row>)=>void;done:()=>void}) {
  const e=formatErrors(row,rows),here=useRef<HTMLDivElement>(null);
  useEffect(()=>{here.current?.scrollIntoView({block:'start',behavior:'smooth'});},[]);
  const setCondition=(i:number,patch:Partial<FormatCondition>)=>set({conditions:row.conditions.map((c,j)=>j===i?{...c,...patch}:c)});
  const values=(c:FormatCondition)=>c.field==='title'?c.values.join('\n'):c.values.join(', ');
  const parse=(c:FormatCondition,text:string)=>(c.field==='title'?text.split('\n'):text.split(',')).map(v=>v.trim()).filter(Boolean);
  return <div ref={here} className="ui-scroll-target"><Panel title={row.from?`Edit ${row.from}`:'New format'} actions={<button type="button" onClick={done}><Icon name="check" size={15}/>Done</button>}>
    <Field label="Name"><input maxLength={60} aria-invalid={!!e.name} value={row.name} onChange={x=>set({name:x.target.value})}/><FieldError>{e.name}</FieldError></Field>
    <Field label="Label" hint="In file names"><input maxLength={20} placeholder="None" aria-invalid={!!e.label} value={row.label??''} onChange={x=>set({label:x.target.value})}/><FieldError>{e.label}</FieldError></Field>
    <Field label="Category"><select value={row.category} onChange={x=>set({category:x.target.value})}>{rules.categories.map(c=><option key={c}>{c}</option>)}</select></Field>
    <Field label="Conditions" hint="All required, and any one other">
      <div className="ui-conditions">
        {row.conditions.map((c,i)=><div key={i} className="ui-condition">
          <select aria-label="Field" value={c.field} onChange={x=>setCondition(i,{field:x.target.value,values:[]})}>{rules.fields.map(f=><option key={f} value={f}>{FIELD_NAMES[f]??f}</option>)}</select>
          {BOOLEAN.has(c.field)?<span className="ui-dash">Yes</span>:c.field==='flag'
            ?<select aria-label="Flag" value={c.values[0]??''} onChange={x=>setCondition(i,{values:x.target.value?[x.target.value]:[]})}><option value="">Choose…</option>{rules.flags.map(f=><option key={f}>{f}</option>)}</select>
            :c.field==='quality'?<select aria-label="Quality" value={c.values[0]??''} onChange={x=>setCondition(i,{values:x.target.value?[x.target.value]:[]})}><option value="">Choose…</option>{[...rules.ladder].reverse().map(q=><option key={q}>{q}</option>)}</select>
            :c.field==='title'||c.values.length>6?<textarea aria-label="Values" className="ui-mono" spellCheck={false} rows={Math.min(6,Math.max(2,c.values.length/8))}
              placeholder={c.field==='title'?'One pattern a line':'Comma-separated'} defaultValue={values(c)} onBlur={x=>setCondition(i,{values:parse(c,x.target.value)})}/>
            :<input aria-label="Values" placeholder="Comma-separated" defaultValue={values(c)} onBlur={x=>setCondition(i,{values:parse(c,x.target.value)})}/>}
          <label className="ui-check"><input type="checkbox" checked={!!c.required} onChange={x=>setCondition(i,{required:x.target.checked})}/>Required</label>
          <label className="ui-check"><input type="checkbox" checked={!!c.negate} onChange={x=>setCondition(i,{negate:x.target.checked})}/>Not</label>
          <IconAction icon="trash" label="Remove condition" onClick={()=>set({conditions:row.conditions.filter((_,j)=>j!==i)})}/>
        </div>)}
        <div><button type="button" disabled={row.conditions.length>=20} onClick={()=>set({conditions:[...row.conditions,{field:'group',values:[]}]})}><Icon name="plus" size={15}/>Add condition</button></div>
        <FieldError>{e.conditions}</FieldError>
      </div></Field>
  </Panel></div>;
}

// ---- Try a release ----

function TryPanel() {
  const [release,setRelease]=useState(''),[runtime,setRuntime]=useState(''),[size,setSize]=useState('');
  const [result,setResult]=useState<TryRelease>(),save=useSave(()=>{});
  const submit=()=>{if(!release.trim())return;void save.run(async()=>{
    setResult(await api<TryRelease>('/admin/library/try','POST',{release:release.trim(),...(intOf(runtime)?{runtime:intOf(runtime)}:{}),...(Number(size)>0?{size:Math.round(Number(size)*GB)}:{})}));});};
  const p=result?.parsed;
  const facts:ReactNode[]=p?[p.resolution,p.source,p.remux&&'Remux',p.codec,...p.hdr,p.audio,p.service,p.group&&`-${p.group}`,...p.editions,...p.languages,p.proper&&'PROPER',p.repack&&'REPACK',p.hardcodedSubs&&'Hardcoded subs']
    .filter(Boolean).map((f,i)=><Tag key={i}>{f}</Tag>):[];
  return <form onSubmit={e=>{e.preventDefault();submit();}}>
    <Panel title="Try a release" footer={save.error?<SaveBar dirty={false} busy={false} error={save.error} onCancel={save.clear}/>:undefined}>
      <Field label="Release name"><input className="wide ui-mono" spellCheck={false} maxLength={300} placeholder="Movie.2024.1080p.AMZN.WEB-DL.DDP5.1.H.264-GROUP" value={release} onChange={e=>setRelease(e.target.value)}/></Field>
      <Field label="Runtime" hint="Minutes"><input type="number" min={1} max={1000} placeholder="110" value={runtime} onChange={e=>setRuntime(e.target.value)}/></Field>
      <Field label="Size" hint="GB"><input type="number" min={0} step={0.1} placeholder="Any" value={size} onChange={e=>setSize(e.target.value)}/></Field>
      <Field label=""><button className="primary" disabled={save.busy||!release.trim()}>{save.busy?'Trying…':'Try'}</button></Field>
    </Panel>
    {result&&<Panel flush title="Every profile">
      <div className="ui-hint ui-facts-chips">{facts.length?facts:'Nothing read from the name'}{result.formats.length>0&&<> · Formats: {result.formats.join(', ')}</>}</div>
      <Table columns={[{label:'Profile'},{label:'Quality',width:130},{label:'Tier',width:110},{label:'Score',width:80,num:true},{label:'Status',width:130}]}>
        {result.profiles.map(r=><tr key={r.id}>
          <td><span className="ui-title-name">{r.name}</span>
            <small className={r.accepted?undefined:'bad'} title={r.accepted?r.scoreParts.map(s=>`${s.name} ${s.ban?'ban':s.points>0?`+${s.points}`:s.points}`).join(', '):r.rejections.join('; ')}>
              {r.accepted?r.scoreParts.map(s=>`${s.name} ${s.points>0?`+${s.points}`:s.points}`).join(', ')||'No formats scored':r.rejections.join('; ')}</small></td>
          <td>{r.quality??<Dash/>}</td>
          <td>{r.tier===undefined?<Dash/>:`${r.tier+1} · ${r.preferred?'Preferred':'Fallback'}`}</td>
          <td className="num">{r.score}</td>
          <td>{r.accepted?<Pill tone="ok">Accepted</Pill>:<Pill tone="bad">Rejected</Pill>}</td>
        </tr>)}
      </Table>
    </Panel>}
  </form>;
}
