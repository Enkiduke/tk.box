import {lazy,Suspense,useCallback,useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {ExploreItem,Principal} from '../../../packages/contracts/src/index.js';
import {api} from './api.js';
import {useApi,useRoute,link,invalidate} from './hooks.js';
import {ActionNotice,Empty,ErrorNotice,Icon,Loading} from './components.js';
import {PlexSignIn} from './sign-in.js';
import {requestsChanged} from './my-requests.js';
import {RequestsPage} from './requests-page.js';
import type {OpenRelatedTitle} from './title-discovery.js';
import {DialogNavContext,useDialogHistory} from './dialog-history.js';
import './style.css';
// Request status badges are styled with Explore's.
import './explore.css';

// The Requests site (Admin › Requests): Explore, Calendar and the viewer's requests, nothing else. The server only
// serves this site the routes these pages use, so nothing here plays or administers anything.
const Explore=lazy(()=>import('./explore.js').then(m=>({default:m.Explore})));
const ExploreDialog=lazy(()=>import('./explore.js').then(m=>({default:m.ExploreDialog})));
const PersonDialog=lazy(()=>import('./person.js').then(m=>({default:m.PersonDialog})));
const Calendar=lazy(()=>import('./calendar.js').then(m=>({default:m.Calendar})));
window.addEventListener('vite:preloadError',event=>{
  let last=0;
  try{last=Number(sessionStorage.getItem('tkbox-reloaded-at'))||0;sessionStorage.setItem('tkbox-reloaded-at',String(Date.now()));}catch{}
  if(Date.now()-last<10_000)return;
  event.preventDefault();window.location.reload();
});
const navigation=[['explore','Explore','explore'],['calendar','Calendar','calendar'],['requests','Requests','download']] as const;

function Portal() {
  const route=useRoute(),identity=useApi<Principal>('/me'),setup=useApi<{plexConfigured:boolean}>('/setup');
  const me=identity.error?.status===401?undefined:identity.data,signedIn=me?.accountId;
  // The open title or person dialog and the steps behind it; this site has no library titles to open.
  const dialogs=useDialogHistory(),dialog=dialogs.current,[error,setError]=useState('');
  const page=route.page==='home'?'explore':route.page;
  useEffect(()=>{dialogs.close();},[page,signedIn]);
  const select=useCallback((item:ExploreItem)=>dialogs.start({type:'title',item}),[]);
  const openRelated:OpenRelatedTitle=useCallback(({item})=>dialogs.push({type:'title',item}),[]);
  // A request changing (available, failed) reloads Explore's labels and the list, and says so.
  useEffect(()=>{
    if(!signedIn||!('EventSource' in window))return;
    const events=new EventSource('/api/v1/events');
    events.addEventListener('requests',()=>{void requestsChanged();});
    events.addEventListener('library',()=>invalidate('/calendar'));
    return()=>events.close();
  },[signedIn]);
  const logout=()=>void api('/auth/logout','POST').then(()=>{invalidate();identity.reload();window.location.hash='explore';},e=>setError((e as Error).message));
  const fallback=<div className="page"><Loading/></div>;
  const content=!me?<section className="sign-in">{setup.error?<div className="sign-in-card"><ErrorNotice message={setup.error.message} retry={setup.reload}/></div>
      :!setup.data?<div className="sign-in-card"><Loading/></div>
      :!setup.data.plexConfigured?<div className="sign-in-card"><span className="brand large">tk.box</span><p className="muted">This server isn’t set up yet.</p></div>
      :<PlexSignIn onSignedIn={identity.reload}><span className="brand large">tk.box</span><h1>Request movies and shows.</h1><p className="muted">Sign in with the Plex account this server is shared with.</p></PlexSignIn>}</section>
    :page==='explore'?<div key={me.accountId}><Suspense fallback={fallback}><Explore params={route.params} admin={false} onSelect={select} requestsButton={false}/></Suspense></div>
    :page==='calendar'?<Suspense fallback={fallback}><Calendar key={me.accountId} accountId={me.accountId} params={route.params} onSelect={select}/></Suspense>
    :page==='requests'?<RequestsPage key={me.accountId} params={route.params} onSelect={select}/>
    :<div className="page"><Empty title="Page not found"><a href="#explore">Go to Explore</a></Empty></div>;
  return <div className={`app page-${page}`}>
    <header className="nav solid">
      <a href="#explore" className="brand" aria-label="tk.box Explore">tk.box</a>
      {me&&<nav className="nav-links" aria-label="Main navigation">{navigation.map(([id,label,icon])=><a key={id} href={link(id)} aria-current={page===id?'page':undefined}><Icon name={icon} size={16}/><span>{label}</span></a>)}</nav>}
      {me&&<div className="nav-actions"><button className="text-button" onClick={logout}>Sign out</button></div>}
    </header>
    <main id="main-content" tabIndex={-1}>
      <ActionNotice/>
      {error&&<div className="toast"><ErrorNotice message={error} dismiss={()=>setError('')}/></div>}
      {identity.loading&&!me?fallback:content}
    </main>
    {me&&dialog&&dialog.type!=='library'&&<DialogNavContext.Provider value={dialogs.nav}><Suspense fallback={null}>{dialog.type==='title'
      ?<ExploreDialog key={dialog.item.key} item={dialog.item} admin={me.role==='admin'} onClose={dialogs.close} onOpenRelated={openRelated}/>
      :<PersonDialog key={dialog.person.id??dialog.person.name} person={dialog.person} onClose={dialogs.close} onOpenRelated={openRelated}/>}</Suspense></DialogNavContext.Provider>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<Portal/>);
