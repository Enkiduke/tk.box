import {useEffect,useMemo,useState,type ReactNode} from 'react';
import type {ExploreItem} from '../../../packages/contracts/src/index.js';
import {exploreGenres} from '../../../packages/contracts/src/explore.js';
import {exploreLanguages,exploreParamBounds,exploreSignal,exploreSignalsFor,normalizeRowDef,sameRowDef,setSignal,signalLevel,signalUse,sourceLabel,withLevel,
  type ExploreAdminRow,type ExploreAdminRows,type ExploreParam,type ExploreParamValue,type ExploreRowDef,type ExploreRowSource,
  type ExploreSignalId,type ExploreSignalKind,type ExploreSignalUse} from '../../../packages/contracts/src/explore-rows.js';
import {api} from './api.js';
import {useApi,invalidate,replaceRoute,useDebounced} from './hooks.js';
import {ErrorNotice,Icon,Loading,Modal} from './components.js';
import {SectionHead,moveTo,useDragOrder,useMutation} from './settings-ui.js';
import {ACTIONS,Field,IconAction,Panel,Pill,RowActions,Segmented,Table,Toolbar,matches,useSave,type Tone} from './manage-ui.js';
import {useStreamingCatalog} from './explore-streaming.js';
import {displayName} from './title-facts.js';
import {toast} from './toasts.js';

type Filter='all'|'tmdb'|'plex'|'personal';
const kindNames={movie:'Movies',show:'Shows',both:'Both'} as const;
const status=(r:ExploreAdminRow):[Tone,string]|undefined=>r.missing?['off','Missing']:r.unavailable?['off','Not set up']
  :r.customized?['wait','Changed']:!r.builtIn?['wait','Custom']:r.personal?['active','Personal']:undefined;
const rowHref=(key?:string)=>`#admin?section=explore${key?`&row=${encodeURIComponent(key)}`:''}`;

// Admin › Explore: every row in Explore's order. A row's title opens its dialog (`&row=<key>`, `new` for a new row).
export function ExploreAdmin({params}:{params:URLSearchParams}) {
  const view=useApi<ExploreAdminRows>('/admin/explore/rows'),[filter,setFilter]=useState<Filter>('all'),[query,setQuery]=useState('');
  const [order,setOrder]=useState<string[]>(),mutation=useMutation(()=>{invalidate('/admin/explore/');invalidate('/explore/');}),drag=useDragOrder();
  useEffect(()=>setOrder(undefined),[view.data]);
  const data=view.data,opened=params.get('row')??undefined;
  const rows=useMemo(()=>{
    const list=data?.rows??[];
    return order?order.flatMap(key=>list.find(r=>r.key===key)??[]):list;
  },[data,order]);
  if(view.error&&!data)return <><SectionHead title="Explore"/><ErrorNotice message={view.error.message} retry={view.reload}/></>;
  if(!data)return <><SectionHead title="Explore"/><Loading/></>;
  const visible=rows.filter(r=>(filter==='all'||(filter==='personal'?r.personal:r.source===filter))&&matches(query,r.title));
  const ordering=filter==='all'&&!query.trim();
  const move=(from:number,to:number)=>{
    if(to<0||to>=rows.length||to===from)return;
    const next=moveTo(rows.map(r=>r.key),from,to);
    setOrder(next);
    void mutation.run(()=>api('/admin/explore/rows/order','PUT',{keys:next}));
  };
  const show=(r:ExploreAdminRow,shown:boolean)=>void mutation.run(async()=>{await api(`/admin/explore/rows/${encodeURIComponent(r.key)}`,'PUT',{shown});});
  const duplicate=(r:ExploreAdminRow)=>replaceRoute(`${rowHref('new')}&from=${encodeURIComponent(r.key)}`);
  const current=opened==='new'?undefined:rows.find(r=>r.key===opened);
  const template=opened==='new'?rows.find(r=>r.key===params.get('from')):undefined;
  return <>
    <SectionHead title="Explore">{data.tmdbConfigured&&<button type="button" className="primary" onClick={()=>replaceRoute(rowHref('new'))}><Icon name="plus" size={16}/>New row</button>}</SectionHead>
    <Toolbar query={query} setQuery={setQuery} placeholder="Search rows" count={`${rows.filter(r=>r.shown).length} of ${rows.length} shown`}>
      <Segmented label="Rows" value={filter} onChange={setFilter} options={[['all','All'],['tmdb','TMDB'],['plex','Plex'],['personal','Personal']]}/>
    </Toolbar>
    {!data.tmdbConfigured&&<p className="explore-admin-note muted small">TMDB rows need a TMDB key: <a href="#admin?section=connections&category=metadata">Connections › Metadata &amp; artwork</a>.</p>}
    {data.plexError&&<ErrorNotice message={data.plexError} retry={view.reload}/>}
    {mutation.error&&<ErrorNotice message={mutation.error} dismiss={()=>mutation.setError('')}/>}
    <Panel flush>
      <Table columns={[{label:<span className="sr-only">Order</span>,width:40},{label:'Row'},{label:'Type',width:110},{label:'Status',width:130},{label:'Shown',width:80},ACTIONS]}
        empty={visible.length?undefined:'No rows match.'}>
        {visible.map(r=>{
          const index=rows.indexOf(r),pill=status(r),open=r.source==='tmdb';
          return <tr key={r.key} className={r.shown?undefined:'is-off'} {...drag('explore-rows',index,move,ordering)}>
            <td>{ordering&&<span className="ui-grip" title="Drag to reorder"><Icon name="grip" size={16}/></span>}</td>
            <td><div className="ui-title"><div>
              {open?<a className="ui-title-name" href={rowHref(r.key)} onClick={e=>{e.preventDefault();replaceRoute(rowHref(r.key));}}>{r.title}</a>:<span className="ui-title-name">{r.title}</span>}
              <small>{r.definition?sourceLabel(r.definition.source):'Plex · Discover shelf'}</small>
            </div></div></td>
            <td>{r.definition?kindNames[r.definition.source.kind]:<span className="ui-dash">—</span>}</td>
            <td>{pill?<Pill tone={pill[0]}>{pill[1]}</Pill>:<span className="ui-dash">—</span>}</td>
            <td><input type="checkbox" role="switch" className="switch" aria-label={`Show ${r.title}`} checked={r.shown} disabled={mutation.busy} onChange={e=>show(r,e.target.checked)}/></td>
            <td><RowActions>
              <IconAction icon="up" label={`Move ${r.title} up`} disabled={!ordering||index===0||mutation.busy} onClick={()=>move(index,index-1)}/>
              <IconAction icon="down" label={`Move ${r.title} down`} disabled={!ordering||index===rows.length-1||mutation.busy} onClick={()=>move(index,index+1)}/>
              {open&&r.definition?.source.type!=='recommendations'&&<IconAction icon="copy" label={`Duplicate ${r.title}`} disabled={!data.tmdbConfigured} onClick={()=>duplicate(r)}/>}
            </RowActions></td>
          </tr>;
        })}
      </Table>
    </Panel>
    {(current?.definition||opened==='new')&&<RowDialog key={opened} row={current} template={template} configured={data.tmdbConfigured}
      onClose={()=>replaceRoute(rowHref())} onOpen={key=>replaceRoute(rowHref(key))}/>}
  </>;
}

const blank:ExploreRowDef={title:'New row',source:{type:'tmdb-discover',kind:'both',sort:'popularity'},signals:[]};
const groups:[ExploreSignalKind,string][]=[['filter','Filters'],['boost','Boosts'],['order','Ordering']];

// One TMDB row: what it draws from, its filters, boosts and ordering, and a preview of its first titles.
function RowDialog({row,template,configured,onClose,onOpen}:{row?:ExploreAdminRow;template?:ExploreAdminRow;configured:boolean;onClose:()=>void;onOpen:(key:string)=>void}) {
  const fresh=!row,base=row?.definition??(template?.definition?{...template.definition,title:`${template.definition.title} copy`}:blank);
  const [draft,setDraft]=useState<ExploreRowDef>(base),[invalid,setInvalid]=useState<Record<string,boolean>>({});
  const save=useSave(()=>{invalidate('/admin/explore/');invalidate('/explore/');});
  const dirty=fresh||!sameRowDef(draft,base),bad=Object.values(invalid).some(Boolean)||!draft.title.trim();
  const builtIn=!!row?.builtIn,path=row?`/admin/explore/rows/${encodeURIComponent(row.key)}`:'';
  const mark=(id:string)=>(v:boolean)=>setInvalid(m=>m[id]===v?m:{...m,[id]:v});
  const submit=()=>void save.run(async()=>{
    if(fresh){
      const {key}=await api<{key:string}>('/admin/explore/rows','POST',{definition:normalizeRowDef(draft),...(template&&{after:template.key})});
      toast.success(`${draft.title} added`);onOpen(key);
    }else{
      await api(path,'PUT',{expectedRevision:row!.revision,definition:normalizeRowDef(draft)});
      toast.success(`${draft.title} saved`);
    }
  });
  const reset=()=>void save.run(async()=>{await api(path,'PUT',{expectedRevision:row!.revision,definition:null});setDraft(row!.defaults!);toast.success(`${row!.defaults!.title} reset`);});
  const remove=()=>{if(!confirm(`Delete ${base.title}?`))return;void save.run(async()=>{await api(path,'DELETE');toast.success(`${base.title} deleted`);onClose();});};
  const available=exploreSignalsFor(draft.source);
  return <Modal title={draft.title||'Row'} variant="wide" onClose={()=>{if(!save.busy)onClose();}}>
    <form className="explore-row-dialog" onSubmit={e=>{e.preventDefault();if(!bad)submit();}}>
      <header className="explore-row-head"><h2>{draft.title||'Untitled row'}</h2><span className="muted">{sourceLabel(draft.source)}</span></header>
      <div className="explore-row-columns">
        <div className="explore-row-settings">
          <Panel title="Row">
            <Field label="Title"><input className="wide" required maxLength={80} value={draft.title} onChange={e=>setDraft(d=>({...d,title:e.target.value}))}/></Field>
            <SourceFields source={draft.source} locked={builtIn} onChange={source=>setDraft(d=>({...d,source,signals:d.signals.filter(s=>exploreSignal(s.id).applies(source))}))}/>
          </Panel>
          {groups.map(([kind,title])=>{
            const ids=available.filter(id=>exploreSignal(id).kind===kind);
            return ids.length?<Panel key={kind} title={title}>{ids.map(id=><SignalField key={id} use={signalUse(draft,id)} shows={draft.source.kind!=='movie'} onInvalid={mark(id)}
              onChange={use=>setDraft(d=>setSignal(d,use))}/>)}</Panel>:null;
          })}
        </div>
        <Preview rowKey={row?.key??'tmdb:new'} draft={draft} personal={draft.source.type==='recommendations'} configured={configured} invalid={bad}/>
      </div>
      {(row?.customized||row&&!row.builtIn||dirty||bad||!!save.error)&&<div className="ui-panel-foot explore-row-foot">
        {row?.customized&&<button type="button" disabled={save.busy} onClick={reset}>Reset to default</button>}
        {row&&!row.builtIn&&<button type="button" className="danger" disabled={save.busy} onClick={remove}><Icon name="trash" size={15}/>Delete row</button>}
        <span className="ui-foot-note">{save.error?<span className="danger-text">{(save.error as Error).message}</span>:bad?'Fix the marked fields to save.':dirty&&!fresh?'Unsaved changes':''}</span>
        {dirty&&!fresh&&<button type="button" disabled={save.busy} onClick={()=>{setDraft(base);setInvalid({});save.clear();}}>Cancel</button>}
        {dirty&&<button className="primary" disabled={save.busy||bad}>{save.busy?'Saving…':fresh?'Add row':'Save'}</button>}
      </div>}
    </form>
  </Modal>;
}

// Where a row's titles come from: fixed for a built-in row (a trending row's window can change), chosen for a new one.
type SourceChoice='popularity'|'rating'|'newest'|'trending'|'upcoming';
function SourceFields({source,locked,onChange}:{source:ExploreRowSource;locked:boolean;onChange:(source:ExploreRowSource)=>void}) {
  if(source.type==='recommendations')return <Field label="Source"><span className="muted">{sourceLabel(source)}</span></Field>;
  const choice:SourceChoice=source.type==='tmdb-discover'?source.sort:source.type==='tmdb-trending'?'trending':'upcoming';
  const kind=source.kind;
  const choose=(next:SourceChoice)=>onChange(next==='trending'?{type:'tmdb-trending',kind,window:'week'}
    :next==='upcoming'?{type:'tmdb-upcoming',kind:kind==='both'?'movie':kind}
    :{type:'tmdb-discover',kind,sort:next,...(source.type==='tmdb-discover'&&source.streaming&&{streaming:true})});
  return <>
    {locked?<Field label="Source"><span className="muted">{sourceLabel(source)}</span></Field>:<>
      <Field label="Source"><Segmented label="Source" value={choice} onChange={choose}
        options={[['popularity','Popular'],['rating','Top rated'],['newest','Newest'],['trending','Trending'],['upcoming','Upcoming']]}/></Field>
      <Field label="Type"><Segmented label="Type" value={kind} onChange={k=>onChange({...source,kind:k} as ExploreRowSource)}
        options={source.type==='tmdb-upcoming'?[['movie','Movies'],['show','Shows']]:[['movie','Movies'],['show','Shows'],['both','Both']]}/></Field>
      {source.type==='tmdb-discover'&&<Field label="Streaming" hint="Only the viewer’s streaming services, with a service picker">
        <input type="checkbox" role="switch" className="switch" aria-label="Streaming" checked={!!source.streaming}
          onChange={e=>{const {streaming:_,...rest}=source;onChange(e.target.checked?{...rest,streaming:true}:rest);}}/></Field>}
    </>}
    {source.type==='tmdb-trending'&&<Field label="Chart"><Segmented label="Chart" value={source.window} onChange={window=>onChange({...source,window})}
      options={[['day','Today'],['week','This week']]}/></Field>}
  </>;
}

const levelOptions=[['off','Off'],['low','Low'],['medium','Medium'],['high','High']] as const;
// One signal as a settings row: a filter's switch and values, a boost's Off / Low / Medium / High (⚙ for the numbers),
// an ordering pass's switch.
function SignalField({use,shows,onChange,onInvalid}:{use:ExploreSignalUse;shows:boolean;onChange:(use:ExploreSignalUse)=>void;onInvalid:(bad:boolean)=>void}) {
  const meta=exploreSignal(use.id),level=signalLevel(use),[open,setOpen]=useState(level==='custom');
  useEffect(()=>{if(!use.on)onInvalid(false);},[use.on]);
  // A switch off is left out, so a row without it stays equal to its default.
  const set=(id:string,value:ExploreParamValue|undefined)=>{const {[id]:_,...rest}=use.params;onChange({...use,on:true,params:value===undefined?rest:{...rest,[id]:value}});};
  const params=meta.params.filter(p=>!('shows' in p&&p.shows)||shows);
  const inputs=params.length>0&&<ParamInputs id={use.id} params={params} values={use.params} disabled={!use.on} onChange={set} onInvalid={onInvalid}/>;
  const toggle=<input type="checkbox" role="switch" className="switch" aria-label={meta.label} checked={use.on} onChange={e=>onChange({...use,on:e.target.checked})}/>;
  if(meta.levels){
    const options=level==='custom'?[...levelOptions,['custom','Custom'] as const]:levelOptions;
    return <div className="explore-signal">
      <Field label={meta.label} hint={meta.hint}>
        <Segmented label={meta.label} value={level} options={options} onChange={v=>{if(v!=='custom')onChange(withLevel(use,v));}}/>
        <button type="button" className={`icon-button explore-signal-more${open?' on':''}`} aria-expanded={open} aria-label={`${meta.label} values`} title="Exact values"
          onClick={()=>setOpen(o=>!o)}><Icon name="settings" size={16}/></button>
      </Field>
      {open&&<div className="explore-signal-detail">{inputs}</div>}
    </div>;
  }
  // Off, a filter is just its switch; its values show once it is on.
  return <Field label={meta.label} hint={meta.hint}>{toggle}{use.on&&inputs}</Field>;
}
function ParamInputs({id,params,values,disabled,onChange,onInvalid}:{id:ExploreSignalId;params:ExploreParam[];values:Record<string,ExploreParamValue>;disabled:boolean;
  onChange:(param:string,value:ExploreParamValue|undefined)=>void;onInvalid:(bad:boolean)=>void}) {
  const [bad,setBad]=useState<Record<string,boolean>>({});
  useEffect(()=>onInvalid(!disabled&&Object.values(bad).some(Boolean)),[bad,disabled]);
  const numbers=params.filter(p=>'min' in p).length;
  return <>{params.map(param=>'toggle' in param
    ?<label key={param.id} className="explore-param toggle"><input type="checkbox" role="switch" className="switch" disabled={disabled} checked={values[param.id]===1}
      onChange={e=>onChange(param.id,e.target.checked?1:undefined)}/><span>{param.label}</span></label>
    :'list' in param
    ?<Chips key={param.id} label={param.label} options={param.list==='genres'?exploreGenres:exploreLanguages} name={param.list==='genres'?(g:string)=>g:languageName}
      chosen={Array.isArray(values[param.id])?values[param.id] as string[]:[]} disabled={disabled} onChange={next=>onChange(param.id,next)}/>
    :<NumberInput key={`${id}-${param.id}`} param={param} values={values} disabled={disabled} bare={numbers===1} onChange={v=>onChange(param.id,v)}
      onInvalid={b=>setBad(m=>m[param.id]===b?m:{...m,[param.id]:b})}/>)}</>;
}
const languageName=(code:string)=>code==='cn'?'Cantonese':displayName('language',code);
const units:Record<string,string>={'%':'%','±%':'±%',days:'days',votes:'votes','/10':'/ 10',positions:'positions',titles:'titles',year:''};
function NumberInput({param,values,disabled,bare,onChange,onInvalid}:{param:Extract<ExploreParam,{min:number}>;values:Record<string,ExploreParamValue>;disabled:boolean;
  bare:boolean;onChange:(value:number)=>void;onInvalid:(bad:boolean)=>void}) {
  const value=values[param.id],[text,setText]=useState(String(value)),[error,setError]=useState('');
  useEffect(()=>{setText(String(value));setError('');onInvalid(false);},[value]);
  return <label className="explore-param">{bare?<span className="sr-only">{param.label}</span>:<span>{param.label}</span>}
    <span className="ui-range"><input type="number" required disabled={disabled} {...exploreParamBounds(param,values)} value={text} aria-invalid={!!error} title={error||undefined} onChange={e=>{
      const input=e.currentTarget;setText(input.value);setError(input.validationMessage);onInvalid(!input.validity.valid);
      if(input.validity.valid)onChange(input.valueAsNumber);
    }}/>{units[param.unit??'']}</span>
  </label>;
}
function Chips({label,options,name,chosen,disabled,onChange}:{label:string;options:readonly string[];name:(o:string)=>string;chosen:string[];disabled:boolean;onChange:(next:string[])=>void}) {
  return <div className="explore-chips" role="group" aria-label={label}>{options.map(o=><label key={o} className={`ui-chip${chosen.includes(o)?' on':''}`}>
    <input type="checkbox" disabled={disabled} checked={chosen.includes(o)} onChange={e=>onChange(options.filter(x=>x===o?e.target.checked:chosen.includes(x)))}/>{name(o)}</label>)}</div>;
}

// The first 20 titles as saved and as drafted, each with how far it moved. Streaming rows use the default services.
function Preview({rowKey,draft,personal,configured,invalid}:{rowKey:string;draft:ExploreRowDef;personal:boolean;configured:boolean;invalid:boolean}) {
  const streaming=draft.source.type==='tmdb-discover'&&!!draft.source.streaming,catalog=useStreamingCatalog(configured&&streaming);
  const settled=useDebounced(JSON.stringify(normalizeRowDef(draft)),500);
  const query=streaming&&catalog.services.length?`?region=${catalog.region}&providers=${catalog.services.map(s=>s.id).sort((a,b)=>a-b).join(',')}`:'';
  const [result,setResult]=useState<{key:string;saved:ExploreItem[];draft:ExploreItem[]}>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const key=settled+query;
  useEffect(()=>{
    if(!configured||invalid||streaming&&!query)return;
    let live=true;setBusy(true);setError('');
    api<{saved:ExploreItem[];draft:ExploreItem[]}>(`/admin/explore/rows/${encodeURIComponent(rowKey)}/preview${query}`,'POST',{definition:JSON.parse(settled)})
      .then(r=>{if(live)setResult({key,...r});},e=>{if(live)setError((e as Error).message);}).finally(()=>{if(live)setBusy(false);});
    return()=>{live=false;};
  },[key,configured,invalid]);
  const before=new Map(result?.saved.map((item,i)=>[item.key,i]));
  let body:ReactNode;
  if(!configured)body=<p className="muted small">Needs a TMDB key.</p>;
  else if(error)body=<ErrorNotice message={error}/>;
  else if(!result)body=<Loading/>;
  else if(!result.draft.length)body=<p className="muted small">No titles.</p>;
  else body=<ol className="explore-preview-list">{result.draft.map((item,i)=>{
    const was=before.get(item.key),moved=was===undefined?undefined:was-i;
    return <li key={item.key}><span className="explore-preview-rank">{i+1}</span>
      <span className="explore-preview-title">{item.title}{item.year&&<small> {item.year}</small>}</span>
      {rowKey!=='tmdb:new'&&(was===undefined?<span className="explore-move new">New</span>:moved?<span className={`explore-move ${moved>0?'up':'down'}`}>{moved>0?`↑${moved}`:`↓${-moved}`}</span>:null)}
    </li>;})}</ol>;
  return <aside className="explore-row-preview"><Panel title={<>Preview{busy&&result&&<span className="muted small"> · updating</span>}</>}
    actions={personal?<span className="muted small">Your history</span>:streaming?<span className="muted small">Your services</span>:undefined}>{body}</Panel></aside>;
}
