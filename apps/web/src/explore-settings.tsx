import {useEffect,useState} from 'react';
import type {ExploreLayout,ExploreRowInfo,ExploreSeerrAccount,ExploreSource,ExploreSources} from '../../../packages/contracts/src/index.js';
import {api} from './api.js';
import {useApi,invalidate} from './hooks.js';
import {ErrorNotice,Loading} from './components.js';
import {Card,MoveButtons,SectionHead,moveTo,useDragOrder,useMutation} from './settings-ui.js';
import {rowKey,setExplorePrefs,defaultExplorePrefs,showExploreRows,showExploreSource,useExplorePrefs} from './explore-prefs.js';
import './explore.css';

type Settings={revision:number;seerrUrl:string;seerrKeySet:boolean};
type LayoutView={layout:ExploreLayout&{revision:number};sources:{source:ExploreSource;configured:boolean;rows:ExploreRowInfo[];error?:string}[]};
const sourceNames:Record<ExploreSource,string>={plex:'Plex',seerr:'Seerr'};

// Explore's catalog sources: the administrator orders them and picks the rows on offer in Admin › Explore, and connects
// Seerr in Admin › Connections; each viewer switches off what they don't want from those here.
export function ExploreSettings({admin}:{admin:boolean}) {
  const sources=useApi<ExploreSources>('/explore/sources');
  return <><SectionHead title="Explore"/>
    {sources.loading&&!sources.data?<Loading/>:sources.error?<ErrorNotice message={sources.error.message} retry={sources.reload}/>:sources.data&&<>
      <ExploreRowPrefs sources={sources.data}/>
      <SeerrAccount sources={sources.data} admin={admin}/>
    </>}
  </>;
}
// The sources and rows the administrator offers, each on until the viewer switches it off.
function ExploreRowPrefs({sources}:{sources:ExploreSources}) {
  const prefs=useExplorePrefs(),offered=sources.order.filter(s=>s==='plex'?sources.plex:sources[s].configured);
  return <Card title="Sources and rows"
    actions={<button type="button" disabled={!prefs.hidden.length&&!prefs.hiddenRows.length} onClick={()=>setExplorePrefs(defaultExplorePrefs)}>Show everything</button>}>
    {offered.length?<ol className="sports-order">{offered.map(s=><SourcePrefs key={s} source={s}/>)}</ol>:<p className="muted small">Explore has no sources right now.</p>}
  </Card>;
}
function SourcePrefs({source}:{source:ExploreSource}) {
  const prefs=useExplorePrefs(),rows=useApi<{rows:ExploreRowInfo[]}>(`/explore/${source}/rows`),[open,setOpen]=useState(false);
  const list=rows.data?.rows??[],on=!prefs.hidden.includes(source),expanded=open&&list.length>0;
  const shown=list.filter(r=>!prefs.hiddenRows.includes(rowKey(source,r.id))).length;
  return <li className="sports-sport">
    <div className="sports-row sports-sport-head">
      <button type="button" className="sports-expand" aria-expanded={expanded} disabled={!list.length} onClick={()=>setOpen(o=>!o)}><strong>{sourceNames[source]}</strong>
        <small className="muted">{rows.error?rows.error.message:!rows.data?'Loading rows…':on?`${shown} of ${list.length} rows shown`:'Off'}</small></button>
      <input type="checkbox" role="switch" className="switch" aria-label={`Show ${sourceNames[source]} on Explore`} checked={on} onChange={e=>showExploreSource(source,e.target.checked)}/>
    </div>
    {expanded&&<ol className="sports-leagues">
      <li className="sports-row sports-bulk"><button type="button" disabled={!on||shown===list.length} onClick={()=>showExploreRows(list.map(r=>rowKey(source,r.id)),true)}>Show all</button><button type="button" disabled={!on||!shown} onClick={()=>showExploreRows(list.map(r=>rowKey(source,r.id)),false)}>Hide all</button></li>
      {list.map(r=>{const key=rowKey(source,r.id);return <li key={key} className="sports-row">
        <label className="checkbox-label grow"><input type="checkbox" disabled={!on} checked={!prefs.hiddenRows.includes(key)} onChange={e=>showExploreRows([key],e.target.checked)}/>{r.title}</label>
      </li>;})}
    </ol>}
  </li>;
}
// Seerr access is checked as the card opens, which signs the viewer in to Seerr as requesting would.
function SeerrAccount({sources,admin}:{sources:ExploreSources;admin:boolean}) {
  const account=useApi<ExploreSeerrAccount>(sources.seerr.configured?'/explore/seerr/account':undefined),a=account.data;
  const can=!!a&&(a.canRequest.movie||a.canRequest.show);
  const status=!sources.seerr.configured?<span className="dot-label">{admin?<a href="#admin?section=connections">Not set up</a>:'Not set up'}</span>
    :account.error?<span className="dot-label danger" title={account.error.message}>Not connected</span>
    :!a?<span className="dot-label">Checking…</span>
    :<span className={`dot-label ${can?'ok':'danger'}`}>{can?a.user??'Connected':'Can’t request'}</span>;
  return <Card title="Seerr" actions={status}/>;
}
// Admin › Explore: what Explore shows and in what order. Seerr is connected in Admin › Connections.
export function ExploreAdmin() {
  return <><SectionHead title="Explore" description={<>What Explore offers every viewer, in order. Seerr is connected in <a href="#admin?section=connections">Admin › Connections</a>.</>}/><ExploreLayoutSettings/></>;
}
// The order sources are listed in on Explore, sources switched off, and single rows hidden.
function ExploreLayoutSettings() {
  const view=useApi<LayoutView>('/admin/explore/layout'),[draft,setDraft]=useState<ExploreLayout>(),[saved,setSaved]=useState(false),[open,setOpen]=useState<ExploreSource[]>([]);
  const mutation=useMutation(view.reload),drag=useDragOrder();
  useEffect(()=>{if(view.data){const {revision:_,...value}=view.data.layout;setDraft(value);}},[view.data?.layout.revision]);
  if(view.loading&&!view.data)return <Loading/>;
  if(view.error)return <ErrorNotice message={view.error.message} retry={view.reload}/>;
  if(!view.data||!draft)return null;
  const data=view.data;
  const set=(patch:Partial<ExploreLayout>)=>{setSaved(false);setDraft(d=>d&&{...d,...patch});};
  const move=(from:number,to:number)=>set({order:moveTo(draft.order,from,to)});
  const showSource=(s:ExploreSource,on:boolean)=>set({hidden:on?draft.hidden.filter(h=>h!==s):[...draft.hidden,s]});
  const showRow=(key:string,on:boolean)=>set({hiddenRows:on?draft.hiddenRows.filter(r=>r!==key):[...draft.hiddenRows,key]});
  const toggle=(s:ExploreSource)=>setOpen(o=>o.includes(s)?o.filter(x=>x!==s):[...o,s]);
  return <Card title="Order and rows" description="Sources are listed on Explore top to bottom in this order. A source switched off is left out of Explore’s rows and search; open one to hide single rows.">
    <form className="form-stack" onSubmit={e=>{e.preventDefault();void mutation.run(async()=>{await api('/admin/explore/layout','PUT',{expectedRevision:data.layout.revision,...draft});invalidate('/explore/');setSaved(true);});}}>
      <ol className="sports-order">{draft.order.map((s,i)=>{
        const info=data.sources.find(x=>x.source===s),rows=info?.rows??[],on=!draft.hidden.includes(s),expanded=open.includes(s)&&rows.length>0;
        const shown=rows.filter(r=>!draft.hiddenRows.includes(`${s}:${r.id}`)).length;
        return <li key={s} className="sports-sport" {...drag('explore',i,move)}>
          <div className="sports-row sports-sport-head"><span className="sports-rank">{i+1}</span>
            <button type="button" className="sports-expand" aria-expanded={expanded} disabled={!rows.length} onClick={()=>toggle(s)}><strong>{sourceNames[s]}</strong>
              <small className="muted">{!info?.configured?'Not set up':info.error??(on?`${shown} of ${rows.length} rows shown`:'Off')}</small></button>
            <input type="checkbox" role="switch" className="switch" aria-label={`Show ${sourceNames[s]} on Explore`} checked={on} onChange={e=>showSource(s,e.target.checked)}/>
            <MoveButtons name={sourceNames[s]} index={i} count={draft.order.length} onMove={to=>move(i,to)}/></div>
          {expanded&&<ol className="sports-leagues">{rows.map(r=>{const key=`${s}:${r.id}`;return <li key={key} className="sports-row">
            <label className="checkbox-label grow"><input type="checkbox" disabled={!on} checked={!draft.hiddenRows.includes(key)} onChange={e=>showRow(key,e.target.checked)}/>{r.title}</label>
            {r.personal&&<small className="muted">Each viewer’s own</small>}
          </li>;})}</ol>}
        </li>;})}</ol>
      {data.sources.some(x=>x.source==='plex'&&x.rows.length)&&<p className="muted small">Plex rows are the Discover shelves your Plex account sees; a shelf Plex adds later shows until you hide it.</p>}
      {mutation.error&&<ErrorNotice message={mutation.error}/>}
      <div className="button-row"><button className="primary" disabled={mutation.busy}>Save order and rows</button>{saved&&<span className="success" role="status">Saved.</span>}</div>
    </form>
  </Card>;
}
// Seerr, in Admin › Connections.
export function ServerExploreSettings() {
  const data=useApi<Settings>('/admin/explore/settings'),[seerrUrl,setSeerrUrl]=useState(''),[seerrKey,setSeerrKey]=useState(''),[saved,setSaved]=useState(false);
  const mutation=useMutation(data.reload);
  useEffect(()=>{if(data.data){setSeerrUrl(data.data.seerrUrl);setSeerrKey('');}},[data.data?.revision]);
  if(data.loading&&!data.data)return <Loading/>;
  if(data.error)return <ErrorNotice message={data.error.message} retry={data.reload}/>;
  if(!data.data)return null;
  const current=data.data;
  return <Card title="Seerr" description="Requests on Explore.">
    <form className="form-stack narrow" onSubmit={e=>{e.preventDefault();setSaved(false);void mutation.run(async()=>{
      await api('/admin/explore/settings','PUT',{expectedRevision:current.revision,seerrUrl:seerrUrl.trim(),...(seerrKey.trim()||!seerrUrl.trim()?{seerrApiKey:seerrUrl.trim()?seerrKey.trim():''}:{})});
      invalidate('/explore/');setSaved(true);
    });}}>
      <label>Seerr address<input type="url" placeholder="https://requests.example.com" value={seerrUrl} maxLength={300} onChange={e=>{setSeerrUrl(e.target.value);setSaved(false);}}/><small>Empty turns requests off.</small></label>
      <label>Seerr API key<input type="password" autoComplete="off" value={seerrKey} maxLength={200} placeholder={current.seerrKeySet?'Saved — enter a new one to replace it':''} onChange={e=>{setSeerrKey(e.target.value);setSaved(false);}}/><small>Seerr › Settings › General</small></label>
      {mutation.error&&<ErrorNotice message={mutation.error}/>}
      <div className="button-row"><button className="primary" disabled={mutation.busy}>Save Seerr</button>{saved&&<span className="success" role="status">Saved.</span>}</div>
    </form>
  </Card>;
}
