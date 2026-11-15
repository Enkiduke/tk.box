import {useState} from 'react';
import type {LibrarySettingsView,PickProfile,PickProfileView,PickRules,ScoreRuleView} from '../../../packages/contracts/src/downloads.js';
import {api} from './api.js';
import {useApiAll} from './hooks.js';
import {ErrorNotice,Icon,Loading} from './components.js';
import {Card,MoveButtons,SectionHead,Switch,moveTo,plural} from './settings-ui.js';
import {toast} from './toasts.js';
import {Badge,SaveBar,Table,changed,useSave} from './manage-ui.js';

// Admin › Manage › Pick rules (docs/PHASE-3.5.md): how a release is chosen. Profiles (the ladder, cutoff and sizes),
// the score rules, and Early copies and the protocol order.

export function PickRulesPage() {
  const view=useApiAll<PickRules|LibrarySettingsView>(['/admin/library/rules','/admin/library/settings']);
  const [rules,settings]=view.data as [PickRules|undefined,LibrarySettingsView|undefined];
  const reload=()=>changed();
  return <><SectionHead title="Pick rules"/>
    {view.error&&!rules?<ErrorNotice message={(view.error as Error).message} retry={reload}/>:!rules||!settings?<Loading/>:<>
      <Choosing key={settings.revision} settings={settings} profiles={rules.profiles}/>
      <Profiles data={rules} defaultProfile={settings.defaultProfile}/>
      <ScoreRules key={rules.rulesVersion} data={rules}/>
    </>}
  </>;
}

function Choosing({settings,profiles}:{settings:LibrarySettingsView;profiles:PickProfileView[]}) {
  const start={earlyCopies:settings.earlyCopies,protocol:settings.protocol,defaultProfile:settings.defaultProfile};
  const [draft,setDraft]=useState(start),save=useSave(changed);
  const dirty=JSON.stringify(draft)!==JSON.stringify(start);
  const submit=()=>void save.run(async()=>{await api('/admin/library/settings','PUT',{expectedRevision:settings.revision,...draft});toast.success('Saved');});
  return <form onSubmit={e=>{e.preventDefault();submit();}}><Card title="Choosing">
    <Switch label="Early copies" checked={draft.earlyCopies} onChange={earlyCopies=>setDraft(d=>({...d,earlyCopies}))}/>
    <div className="form-columns">
      <label>Protocol<select value={draft.protocol} onChange={e=>setDraft(d=>({...d,protocol:e.target.value as typeof d.protocol}))}><option value="usenet-first">Usenet first</option><option value="torrent-first">Torrents first</option></select></label>
      <label>Default profile<select value={draft.defaultProfile} onChange={e=>setDraft(d=>({...d,defaultProfile:Number(e.target.value)}))}>{profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    </div>
    <SaveBar dirty={dirty} busy={save.busy} error={save.error} onCancel={()=>{setDraft(start);save.clear();}} onReload={changed}/>
  </Card></form>;
}

// ---- Profiles ----

function Profiles({data,defaultProfile}:{data:PickRules;defaultProfile:number}) {
  const [picked,setPicked]=useState<number|'new'>(defaultProfile);
  const current=picked==='new'?undefined:data.profiles.find(p=>p.id===picked)??data.profiles[0];
  const base=data.profiles.find(p=>p.id===defaultProfile)??data.profiles[0];
  return <Card title="Profiles"><div className="manage-profiles">
    <nav className="manage-profile-list" aria-label="Profiles">
      {data.profiles.map(p=><button key={p.id} type="button" aria-current={picked!=='new'&&current?.id===p.id?'true':undefined} onClick={()=>setPicked(p.id)}>
        <strong>{p.name}</strong><small>{p.id===defaultProfile?'Default · ':''}{p.value.cutoff} · {plural(p.used,'title')}</small></button>)}
      <button type="button" className={picked==='new'?'is-new':undefined} aria-current={picked==='new'?'true':undefined} onClick={()=>setPicked('new')}><Icon name="plus" size={16}/>New profile</button>
    </nav>
    {picked==='new'?<ProfileEditor key="new" ladder={data.ladder} earlyCopies={data.earlyCopies} start={{name:'',value:base!.value}} saved={setPicked} deleted={()=>setPicked(defaultProfile)}/>
      :current&&<ProfileEditor key={current.id+current.version} ladder={data.ladder} earlyCopies={data.earlyCopies} profile={current} isDefault={current.id===defaultProfile}
        start={{name:current.name,value:current.value}} saved={setPicked} deleted={()=>setPicked(defaultProfile)}/>}
  </div></Card>;
}

// The ladder by resolution, best first; the early copies and DVD together.
function ladderGroups(ladder:string[]) {
  const groups=new Map<string,string[]>();
  for(const q of [...ladder].reverse()){const res=/(\d{3,4}p)$/.exec(q)?.[1]??'SD and early';groups.set(res,[...(groups.get(res)??[]),q]);}
  return [...groups];
}
function ProfileEditor({ladder,earlyCopies,profile,isDefault,start,saved,deleted}:{ladder:string[];earlyCopies:string[];profile?:PickProfileView;isDefault?:boolean;
  start:{name:string;value:PickProfile};saved:(id:number)=>void;deleted?:()=>void}) {
  const [name,setName]=useState(start.name),[value,setValue]=useState(start.value),save=useSave(changed);
  const allowed=new Set(value.qualities.filter(q=>q.allowed).map(q=>q.name));
  const cutoffs=[...ladder].reverse().filter(q=>allowed.has(q)&&!earlyCopies.includes(q));
  const dirty=!profile||name!==start.name||JSON.stringify(value)!==JSON.stringify(start.value);
  const toggle=(q:string,on:boolean)=>setValue(v=>{
    const qualities=ladder.map(n=>({name:n,allowed:n===q?on:v.qualities.some(x=>x.name===n&&x.allowed)}));
    const still=qualities.filter(x=>x.allowed&&!earlyCopies.includes(x.name)).map(x=>x.name);
    return {...v,qualities,cutoff:still.includes(v.cutoff)?v.cutoff:still.at(-1)??v.cutoff};
  });
  const size=(key:'movieSize'|'episodeSize',i:0|1,text:string)=>setValue(v=>{const next=[...v[key]] as [number,number];next[i]=Number(text);return {...v,[key]:next};});
  const submit=()=>void save.run(async()=>{
    const result=profile?await api<PickRules>(`/admin/library/profiles/${profile.id}`,'PUT',{expectedVersion:profile.version,name:name.trim(),value})
      :await api<PickRules>('/admin/library/profiles','POST',{name:name.trim(),value});
    const id=profile?.id??result.profiles.find(p=>p.name.toLowerCase()===name.trim().toLowerCase())?.id;
    toast.success(`${name.trim()} saved`);if(id)saved(id);});
  const remove=()=>{if(!window.confirm(`Delete ${profile!.name}?`))return;void save.run(async()=>{await api(`/admin/library/profiles/${profile!.id}`,'DELETE');toast.success(`${profile!.name} deleted`);deleted?.();});};
  const range=(key:'movieSize'|'episodeSize',label:string)=><fieldset className="downloads-range"><legend>{label} (GB)</legend>
    <input type="number" aria-label={`Smallest ${label.toLowerCase()}`} min={0} max={500} step={0.1} value={value[key][0]} onChange={e=>size(key,0,e.target.value)}/>to
    <input type="number" aria-label={`Largest ${label.toLowerCase()}`} min={0} max={500} step={0.1} value={value[key][1]} onChange={e=>size(key,1,e.target.value)}/>
    {value[key][0]>=value[key][1]&&<small className="danger-text">The smallest must be under the largest</small>}</fieldset>;
  return <form className="downloads-profile" onSubmit={e=>{e.preventDefault();submit();}}>
    <div className="manage-profile-head"><label>Name<input required maxLength={40} value={name} onChange={e=>setName(e.target.value)}/></label>
      {isDefault&&<Badge tone="ok">Default</Badge>}{profile&&profile.used>0&&<span className="muted small">{plural(profile.used,'title')}</span>}</div>
    <div className="manage-ladder">{ladderGroups(ladder).map(([res,qs])=><fieldset key={res}><legend>{res}</legend>
      {qs.map(q=><Switch key={q} label={q} description={earlyCopies.includes(q)?'Early copy':undefined} checked={allowed.has(q)} onChange={on=>toggle(q,on)}/>)}</fieldset>)}</div>
    <div className="form-columns">
      <label>Cutoff<select value={value.cutoff} onChange={e=>setValue(v=>({...v,cutoff:e.target.value}))}>{cutoffs.map(q=><option key={q} value={q}>{q}</option>)}</select></label>
    </div>
    <div className="form-columns">{range('movieSize','Movie size')}{range('episodeSize','Episode size')}</div>
    <SaveBar dirty={dirty} busy={save.busy} error={save.error} label={profile?'Save':'Create'} onReload={changed}
      onCancel={()=>{if(profile){setName(start.name);setValue(start.value);save.clear();}else deleted?.();}}/>
    {profile&&!dirty&&<div className="button-row"><button type="button" className="danger" disabled={save.busy||isDefault||profile.used>0}
      title={isDefault?'The default profile':profile.used?`${plural(profile.used,'title')} use it`:undefined} onClick={remove}><Icon name="trash" size={16}/>Delete</button></div>}
  </form>;
}

// ---- Score rules ----

// The pattern's own check, as the server makes it: a field:value, or a regular expression.
const FIELDS=['codec','hdr','edition','group','language','flag','source','resolution'];
function patternError(pattern:string) {
  const p=pattern.trim();
  if(!p)return 'Required';
  const field=/^([a-z]+):(.+)$/i.exec(p);
  if(field&&FIELDS.includes(field[1]!.toLowerCase()))return undefined;
  try{new RegExp(p,'i');return undefined;}catch{return 'Not a valid pattern';}
}
const labelError=(label?:string)=>label&&!/^[A-Za-z0-9 +.-]*$/.test(label)?'Letters, digits, spaces and + . - only':undefined;
type Row=ScoreRuleView&{key:number};
let nextKey=0;
const keyed=(rules:ScoreRuleView[]):Row[]=>rules.map(r=>({...r,key:nextKey++}));
const plain=(rows:Row[])=>rows.map(({key:_,...r})=>r);

function ScoreRules({data}:{data:PickRules}) {
  const [rows,setRows]=useState(()=>keyed(data.rules)),save=useSave(changed);
  const set=(key:number,patch:Partial<ScoreRuleView>)=>setRows(list=>list.map(r=>r.key===key?{...r,...patch}:r));
  const dirty=JSON.stringify(plain(rows))!==JSON.stringify(data.rules);
  const invalid=rows.some(r=>!r.name.trim()||patternError(r.pattern)||labelError(r.label));
  const submit=()=>{if(invalid)return;void save.run(async()=>{
    await api('/admin/library/rules','PUT',{expectedVersion:data.rulesVersion,rules:plain(rows).map(({label,...r})=>({...r,name:r.name.trim(),pattern:r.pattern.trim(),...(label?.trim()?{label:label.trim()}:{})}))});
    toast.success('Score rules saved');});};
  return <form onSubmit={e=>{e.preventDefault();submit();}}><Card title="Score rules" actions={<button type="button" onClick={()=>setRows(list=>[...list,...keyed([{name:'',pattern:'',points:0,ban:false,applies:'both'}])])}><Icon name="plus" size={16}/>Add rule</button>}>
    <p className="muted small manage-hint">Pattern: <code>codec:x265</code>, <code>group:FLUX</code>, <code>hdr:DV</code>, <code>source:BluRay</code>, <code>edition:IMAX</code>, or a regular expression on the name.</p>
    <Table className="downloads-rules" columns={[{label:<span className="sr-only">Order</span>},{label:'Name'},{label:'Label'},{label:'Pattern'},{label:'Points',num:true},{label:'Ban'},{label:'Applies to'},{label:<span className="sr-only">Remove</span>}]}>
      {rows.map((r,i)=>{const pe=patternError(r.pattern),le=labelError(r.label);return <tr key={r.key} className={r.ban?'manage-ban':undefined}>
        <td><MoveButtons name={r.name||'rule'} index={i} count={rows.length} onMove={to=>setRows(list=>moveTo(list,i,to))}/></td>
        <td><input maxLength={60} aria-label="Name" aria-invalid={!r.name.trim()||undefined} value={r.name} onChange={e=>set(r.key,{name:e.target.value})}/></td>
        <td><input maxLength={20} aria-label="Label" aria-invalid={!!le||undefined} value={r.label??''} onChange={e=>set(r.key,{label:e.target.value})}/>{le&&<small className="danger-text">{le}</small>}</td>
        <td><input maxLength={200} spellCheck={false} aria-label="Pattern" aria-invalid={!!pe||undefined} className="downloads-pattern" value={r.pattern} onChange={e=>set(r.key,{pattern:e.target.value})}/>{pe&&r.pattern&&<small className="danger-text">{pe}</small>}</td>
        <td className="num"><input type="number" min={-1000} max={1000} aria-label="Points" disabled={r.ban} value={r.ban?'':r.points} onChange={e=>set(r.key,{points:Number(e.target.value)})}/></td>
        <td><input type="checkbox" role="switch" className="switch" aria-label="Ban" checked={r.ban} onChange={e=>set(r.key,{ban:e.target.checked})}/></td>
        <td><select aria-label="Applies to" value={r.applies} onChange={e=>set(r.key,{applies:e.target.value as ScoreRuleView['applies']})}><option value="both">Both</option><option value="movie">Movies</option><option value="show">Shows</option></select></td>
        <td><button type="button" className="icon-button" aria-label={`Delete ${r.name||'rule'}`} onClick={()=>setRows(list=>list.filter(x=>x.key!==r.key))}><Icon name="trash" size={16}/></button></td>
      </tr>;})}
    </Table>
    {dirty&&invalid&&<p className="danger-text small">Fix the marked rules to save.</p>}
    <SaveBar dirty={dirty} busy={save.busy} error={save.error} onCancel={()=>{setRows(keyed(data.rules));save.clear();}} onReload={changed}/>
  </Card></form>;
}
