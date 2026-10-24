import {useEffect,useRef,useState} from 'react';
import type {ExploreLayout,ExploreRowInfo,ExploreSeerrAccount,ExploreSource,ExploreSources} from '../../../packages/contracts/src/index.js';
import {api} from './api.js';
import {useApi,invalidate} from './hooks.js';
import {ErrorNotice,Loading} from './components.js';
import {Card,MoveButtons,SectionHead,moveTo,useDragOrder,useMutation} from './settings-ui.js';
import './explore.css';

type Settings={revision:number;seerrUrl:string;seerrKeySet:boolean;traktClientId:string;traktSecretSet:boolean};
type Link={userCode:string;verificationUrl:string;interval:number;expiresIn:number};
type LayoutView={layout:ExploreLayout&{revision:number};sources:{source:ExploreSource;configured:boolean;rows:ExploreRowInfo[];error?:string}[]};
const sourceNames:Record<ExploreSource,string>={plex:'Plex',seerr:'Seerr',trakt:'Trakt'};

// Explore's catalog sources: the administrator orders them in Admin › Explore and connects Seerr and Trakt in Admin › Connections;
// each viewer links their own Trakt here.
export function ExploreSettings({admin}:{admin:boolean}) {
  const sources=useApi<ExploreSources>('/explore/sources');
  return <><SectionHead title="Explore" description="Your Seerr access and Trakt account for the Explore page."/>
    {sources.loading&&!sources.data?<Loading/>:sources.error?<ErrorNotice message={sources.error.message} retry={sources.reload}/>:sources.data&&<>
      <SeerrAccount sources={sources.data} admin={admin}/>
      <TraktLink sources={sources.data} changed={()=>{sources.reload();invalidate('/explore/trakt');}}/>
    </>}
  </>;
}
// Checking signs the viewer in to Seerr, as requesting would; nothing signs them in just by opening this page.
function SeerrAccount({sources,admin}:{sources:ExploreSources;admin:boolean}) {
  const [account,setAccount]=useState<ExploreSeerrAccount>(),mutation=useMutation(()=>{});
  const can=account&&[account.canRequest.movie&&'movies',account.canRequest.show&&'shows'].filter(Boolean);
  return <Card title="Seerr" description="When you first request a title you are signed in to Seerr with your Plex account, so requests are made as your Seerr user.">
    {!sources.seerr.configured?<p className="muted small">{admin?<>Add your Seerr address in <a href="#admin?section=connections">Admin › Connections</a> to turn on requests.</>:'Seerr is not set up on this server.'}</p>
      :account?<p className="small">Signed in{account.user?<> as <strong>{account.user}</strong></>:''}. {can?.length?`You can request ${can.join(' and ')}${account.fourK.movie||account.fourK.show?', including 4K':''}.`:'Your Seerr account can’t make requests.'}</p>
      :<div className="button-row"><button disabled={mutation.busy} onClick={()=>void mutation.run(async()=>setAccount(await api<ExploreSeerrAccount>('/explore/seerr/account')))}>Check my Seerr access</button></div>}
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
  </Card>;
}
// Admin › Explore: what Explore shows and in what order. Seerr and Trakt are connected in Admin › Connections.
export function ExploreAdmin() {
  return <><SectionHead title="Explore" description={<>Server-wide: every viewer sees Explore this way. Seerr and Trakt are connected in <a href="#admin?section=connections">Admin › Connections</a>.</>}/><ExploreLayoutSettings/></>;
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
// Seerr and Trakt, in Admin › Connections.
export function ServerExploreSettings() {
  const data=useApi<Settings>('/admin/explore/settings'),[seerrUrl,setSeerrUrl]=useState(''),[seerrKey,setSeerrKey]=useState(''),[clientId,setClientId]=useState(''),[secret,setSecret]=useState(''),[saved,setSaved]=useState(false);
  const mutation=useMutation(data.reload);
  useEffect(()=>{if(data.data){setSeerrUrl(data.data.seerrUrl);setSeerrKey('');setClientId(data.data.traktClientId);setSecret('');}},[data.data?.revision]);
  if(data.loading&&!data.data)return <Loading/>;
  if(data.error)return <ErrorNotice message={data.error.message} retry={data.reload}/>;
  if(!data.data)return null;
  const current=data.data;
  return <Card title="Seerr and Trakt" description="Requests and Trakt on Explore.">
    <form className="form-stack narrow" onSubmit={e=>{e.preventDefault();setSaved(false);void mutation.run(async()=>{
      await api('/admin/explore/settings','PUT',{expectedRevision:current.revision,seerrUrl:seerrUrl.trim(),...(seerrKey.trim()||!seerrUrl.trim()?{seerrApiKey:seerrUrl.trim()?seerrKey.trim():''}:{}),traktClientId:clientId.trim(),...(secret.trim()||!clientId.trim()?{traktClientSecret:clientId.trim()?secret.trim():''}:{})});
      invalidate('/explore/');setSaved(true);
    });}}>
      <label>Seerr address<input type="url" placeholder="https://requests.example.com" value={seerrUrl} maxLength={300} onChange={e=>{setSeerrUrl(e.target.value);setSaved(false);}}/><small>Empty turns requests off.</small></label>
      <label>Seerr API key<input type="password" autoComplete="off" value={seerrKey} maxLength={200} placeholder={current.seerrKeySet?'Saved — enter a new one to replace it':''} onChange={e=>{setSeerrKey(e.target.value);setSaved(false);}}/><small>Seerr › Settings › General</small></label>
      <label>Trakt client ID<input value={clientId} maxLength={100} spellCheck={false} onChange={e=>{setClientId(e.target.value);setSaved(false);}}/></label>
      <label>Trakt client secret<input type="password" autoComplete="off" value={secret} maxLength={100} placeholder={current.traktSecretSet?'Saved — enter a new one to replace it':''} onChange={e=>{setSecret(e.target.value);setSaved(false);}}/>
        <small><a href="https://trakt.tv/oauth/applications/new" target="_blank" rel="noreferrer">Create a Trakt app</a> with redirect <code>urn:ietf:wg:oauth:2.0:oob</code>. Changing the ID unlinks all viewers.</small></label>
      {mutation.error&&<ErrorNotice message={mutation.error}/>}
      <div className="button-row"><button className="primary" disabled={mutation.busy}>Save Seerr and Trakt</button>{saved&&<span className="success" role="status">Saved.</span>}</div>
    </form>
  </Card>;
}
function TraktLink({sources,changed}:{sources:ExploreSources;changed:()=>void}) {
  const [link,setLink]=useState<Link>(),[message,setMessage]=useState(''),mutation=useMutation(()=>{}),polling=useRef(false);
  // Polls Trakt at the interval it asked for while the code is shown.
  useEffect(()=>{
    if(!link)return;let active=true;
    const timer=window.setInterval(()=>{
      if(polling.current)return;polling.current=true;
      void api<{status:string;user?:string}>('/explore/trakt/link/poll','POST').then(r=>{
        if(!active)return;
        if(r.status==='linked'){setLink(undefined);setMessage(`Connected${r.user?` as ${r.user}`:''}.`);changed();}
        else if(r.status!=='pending'){setLink(undefined);setMessage(r.status==='denied'?'Trakt sign-in was declined.':'The code expired. Start again.');}
      },e=>{if(active){setLink(undefined);setMessage((e as Error).message);}}).finally(()=>{polling.current=false;});
    },Math.max(2,link.interval)*1000);
    return()=>{active=false;clearInterval(timer);};
  },[link]);
  if(!sources.trakt.configured)return <Card title="Trakt"><p className="muted small">Trakt is not set up on this server.</p></Card>;
  return <Card title="Trakt" description="Link your Trakt account for your Trakt watchlist and recommendations on Explore.">
    {sources.trakt.linked?<div className="button-row"><span className="small grow">Connected as <strong>{sources.trakt.user}</strong>.</span><button disabled={mutation.busy} onClick={()=>void mutation.run(async()=>{await api('/explore/trakt/link','DELETE');setMessage('');changed();})}>Disconnect</button></div>
      :link?<div className="form-stack"><p className="small">Go to <a href={link.verificationUrl} target="_blank" rel="noreferrer">{link.verificationUrl}</a> and enter this code:</p><p className="trakt-code"><strong>{link.userCode}</strong></p><div className="button-row"><span className="spinner small-spinner" aria-hidden="true"/><span className="muted small">Waiting for Trakt…</span><button type="button" onClick={()=>setLink(undefined)}>Cancel</button></div></div>
      :<div className="button-row"><button className="primary" disabled={mutation.busy} onClick={()=>void mutation.run(async()=>{setMessage('');setLink(await api<Link>('/explore/trakt/link','POST'));})}>Connect Trakt</button></div>}
    {message&&<p className="small" role="status">{message}</p>}
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
  </Card>;
}
