import {useEffect,useRef,useState} from 'react';
import type {ExploreSeerrAccount,ExploreSources} from '../../../packages/contracts/src/index.js';
import {api} from './api.js';
import {useApi,invalidate} from './hooks.js';
import {ErrorNotice,Loading} from './components.js';
import {Card,SectionHead,useMutation} from './settings-ui.js';
import './explore.css';

type Settings={revision:number;seerrUrl:string;seerrKeySet:boolean;traktClientId:string;traktSecretSet:boolean};
type Link={userCode:string;verificationUrl:string;interval:number;expiresIn:number};

// Explore's catalog sources: the administrator connects Seerr and registers a Trakt app; each viewer links their own Trakt.
export function ExploreSettings({admin}:{admin:boolean}) {
  const sources=useApi<ExploreSources>('/explore/sources');
  return <><SectionHead title="Explore" description="Plex Discover, Seerr and Trakt rows on the Explore page, and requesting titles through Seerr."/>
    {admin&&<ServerExploreSettings changed={sources.reload}/>}
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
    {!sources.seerr.configured?<p className="muted small">{admin?'Add your Seerr address above to turn on requests.':'Seerr is not set up on this server.'}</p>
      :account?<p className="small">Signed in{account.user?<> as <strong>{account.user}</strong></>:''}. {can?.length?`You can request ${can.join(' and ')}${account.fourK.movie||account.fourK.show?', including 4K':''}.`:'Your Seerr account can’t make requests.'}</p>
      :<div className="button-row"><button disabled={mutation.busy} onClick={()=>void mutation.run(async()=>setAccount(await api<ExploreSeerrAccount>('/explore/seerr/account')))}>Check my Seerr access</button></div>}
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
  </Card>;
}
function ServerExploreSettings({changed}:{changed:()=>void}) {
  const data=useApi<Settings>('/admin/explore/settings'),[seerrUrl,setSeerrUrl]=useState(''),[seerrKey,setSeerrKey]=useState(''),[clientId,setClientId]=useState(''),[secret,setSecret]=useState(''),[saved,setSaved]=useState(false);
  const mutation=useMutation(()=>{data.reload();changed();});
  useEffect(()=>{if(data.data){setSeerrUrl(data.data.seerrUrl);setSeerrKey('');setClientId(data.data.traktClientId);setSecret('');}},[data.data?.revision]);
  if(data.loading&&!data.data)return <Loading/>;
  if(data.error)return <ErrorNotice message={data.error.message} retry={data.reload}/>;
  if(!data.data)return null;
  const current=data.data;
  return <Card title="Connections" description="Server-wide. Every viewer uses this Seerr and this Trakt app.">
    <form className="form-stack narrow" onSubmit={e=>{e.preventDefault();setSaved(false);void mutation.run(async()=>{
      await api('/admin/explore/settings','PUT',{expectedRevision:current.revision,seerrUrl:seerrUrl.trim(),...(seerrKey.trim()||!seerrUrl.trim()?{seerrApiKey:seerrUrl.trim()?seerrKey.trim():''}:{}),traktClientId:clientId.trim(),...(secret.trim()||!clientId.trim()?{traktClientSecret:clientId.trim()?secret.trim():''}:{})});
      invalidate('/explore/');setSaved(true);
    });}}>
      <label>Seerr address<input type="url" placeholder="https://requests.example.com" value={seerrUrl} maxLength={300} onChange={e=>{setSeerrUrl(e.target.value);setSaved(false);}}/><small>Overseerr, Jellyseerr or Seerr, reachable from this server, using Plex sign-in. Viewers need a Seerr account (import them in Seerr or allow new Plex sign-ins there). Leave empty to turn requests off.</small></label>
      <label>Seerr API key<input type="password" autoComplete="off" value={seerrKey} maxLength={200} placeholder={current.seerrKeySet?'Saved — enter a new one to replace it':''} onChange={e=>{setSeerrKey(e.target.value);setSaved(false);}}/><small>From Seerr’s Settings › General. With it, browsing Seerr needs no sign-in and Plex and Trakt titles show whether they are available or requested. Viewers are signed in to Seerr only when they request.</small></label>
      <label>Trakt client ID<input value={clientId} maxLength={100} spellCheck={false} onChange={e=>{setClientId(e.target.value);setSaved(false);}}/></label>
      <label>Trakt client secret<input type="password" autoComplete="off" value={secret} maxLength={100} placeholder={current.traktSecretSet?'Saved — enter a new one to replace it':''} onChange={e=>{setSecret(e.target.value);setSaved(false);}}/>
        <small>Create an app at <a href="https://trakt.tv/oauth/applications/new" target="_blank" rel="noreferrer">trakt.tv/oauth/applications</a> with the redirect URI <code>urn:ietf:wg:oauth:2.0:oob</code>. Changing the client ID unlinks every viewer’s Trakt account.</small></label>
      {mutation.error&&<ErrorNotice message={mutation.error}/>}
      <div className="button-row"><button className="primary" disabled={mutation.busy}>Save connections</button>{saved&&<span className="success" role="status">Saved.</span>}</div>
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
