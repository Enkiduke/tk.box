import {lazy,Suspense,useCallback,useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {Principal,Library,CatalogItem} from '../../../packages/contracts/src/index.js';
import {api,ApiClientError} from './api.js';
import {useApi,useRoute,useScrolled,link,invalidate} from './hooks.js';
import {PersistentPlayer,browserCapabilities,type PlayerHandle,type Delivery,type MediaTracks,type SourceInfo} from './player.js';
import {Icon,ErrorNotice,Loading,Empty,ActionNotice} from './components.js';
import {refreshCatalog} from './media-actions.js';
import {LiveFailover,type LiveSession} from './live-failover.js';
import {Home,LibraryView,Search,Details,playableOf} from './library.js';
// Administration is rarely visited, so it loads on demand.
const Settings=lazy(()=>import('./settings.js').then(m=>({default:m.Settings})));
import {Live,ChannelPanel,rememberFeed,tuneTarget,hasFeed,stationName,type WatchChannel,type StationFeed} from './live.js';
import './style.css';

type VodSession={kind:'vod';id:string;streamUrl:string;delivery:Delivery;startOffsetMs:number;tracks?:MediaTracks;source?:SourceInfo;item:CatalogItem};
type Session=VodSession|LiveSession;
const navigation=[['home','Home'],['movies','Movies'],['shows','TV Shows'],['live','Live TV']] as const;
function App() {
  const route=useRoute(),identity=useApi<Principal&{libraries?:Library[]}>('/me'),setup=useApi<{plexConfigured:boolean}>('/setup'),scrolled=useScrolled();
  const me=identity.error&&[401,403].includes(identity.error.status)?undefined:identity.data;
  const catalog=useApi<{libraries:Library[]}>(me&&!identity.data?.libraries?'/libraries':undefined),libraries=(identity.data?.libraries??catalog.data?.libraries??[]).filter(l=>['movie','show'].includes(l.type));
  const [session,setSession]=useState<Session>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[switchingAudio,setSwitchingAudio]=useState(false),[authUrl,setAuthUrl]=useState('');
  const failover=useRef(new LiveFailover()),[switchingLive,setSwitchingLive]=useState(false);
  const player=useRef<PlayerHandle>(null),sessionRef=useRef(session),returnTo=useRef('#home'),locking=useRef(false),routeRef=useRef(route);sessionRef.current=session;routeRef.current=route;
  const libraryPage=route.page==='movies'||route.page==='shows',watching=route.page==='watch';
  const itemId=route.params.get('item');
  useEffect(()=>{const shortcut=(event:KeyboardEvent)=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();const input=document.querySelector<HTMLInputElement>('.browse-search input,.search-box input');if(input)input.focus();else window.location.hash='search';}};window.addEventListener('keydown',shortcut);return()=>window.removeEventListener('keydown',shortcut);},[]);
  useEffect(()=>{if(!itemId)window.scrollTo({top:0,behavior:'instant'});},[route.page]);
  // Stable callbacks keep memoized cards from re-rendering on unrelated shell updates.
  const openItem=useCallback((id:string)=>{setError('');const {page,params}=routeRef.current,next=new URLSearchParams(params);next.set('item',id);window.location.hash=`${page==='watch'?'home':page}?${next}`;},[]);
  const closeItem=()=>{const params=new URLSearchParams(route.params);params.delete('item');window.location.hash=`${route.page}${params.size?'?'+params:''}`;};
  async function checkAuth() {
    const result=await api<{status:string}>('/auth/plex/status','POST');if(result.status==='authenticated'){setAuthUrl('');identity.reload();catalog.reload();}
  }
  useEffect(()=>{if(!authUrl)return;let running=false;const timer=setInterval(()=>{if(running)return;running=true;void checkAuth().catch(e=>{if(e instanceof ApiClientError&&['AUTH_EXPIRED','PLEX_ACCESS_DENIED'].includes(e.code)){setAuthUrl('');setError(e.message);}}).finally(()=>{running=false;});},3000);return()=>clearInterval(timer);},[authUrl]);
  async function action(fn:()=>Promise<void>) {if(locking.current)return;locking.current=true;setBusy(true);setError('');try{await fn();}catch(e){setError((e as Error).message);}finally{locking.current=false;setBusy(false);}}
  async function stop() {
    failover.current.cancel();setSwitchingLive(false);
    const active=sessionRef.current,position=player.current?.stop();sessionRef.current=undefined;setSession(undefined);
    if(!active)return;
    if(active.kind==='live'){await api(`/live/sessions/${active.id}`,'DELETE');return;}
    // Detach local output first. Only an actually started VOD reports progress;
    // preparing/canceling a title never resets its existing resume position.
    try {if(position?.started)await api(`/playback/sessions/${active.id}/progress`,'PATCH',{timeMs:Math.round(Math.min(position.timeMs,active.item.durationMs??position.timeMs)),state:'stopped'});}
    finally {refreshCatalog();await api(`/playback/sessions/${active.id}`,'DELETE');}
  }
  const play=useCallback((media:CatalogItem,from:'resume'|'beginning'='resume')=>void action(async()=>{
    const item=await playableOf(media);if(!item)throw new Error('Nothing to play yet.');
    await stop();const {page,params}=routeRef.current,old=new URLSearchParams(params);old.delete('item');returnTo.current=link(page==='watch'?'home':page,Object.fromEntries(old));
    const created=await api<Omit<VodSession,'item'|'kind'>>('/playback/sessions','POST',{mode:'plex_vod',ratingKey:item.id,capabilities:browserCapabilities(),startFrom:from});
    setSession({...created,kind:'vod',item});window.location.hash='watch';
  }),[]);
  // The server answers once the channel's relay has its first segment, so playback starts promptly.
  const watchChannel=useCallback<WatchChannel>((channel,program)=>void action(async()=>{
    await stop();returnTo.current=link('live',Object.fromEntries(routeRef.current.params));
    failover.current=new LiveFailover();
    const created=await api<Omit<LiveSession,'kind'|'program'>>('/live/sessions','POST',{channelId:channel.id});
    // Keep the station's feed list so the player can switch feeds without a guide lookup.
    const next:LiveSession={...created,kind:'live',program,channel:{...created.channel,stack:channel.stack,feeds:channel.feeds}};sessionRef.current=next;setSession(next);window.location.hash='watch';
  }),[]);
  const playbackError=(message:string)=>{
    const current=sessionRef.current;
    if(current?.kind!=='live'||!current.channel.stack){setError(message);return;}
    const recovery=failover.current,isCurrent=()=>sessionRef.current===current&&failover.current===recovery;
    player.current?.stop();setSwitchingLive(true);setError('');
    void recovery.recover(current,isCurrent).then(next=>{
      if(!isCurrent())return;
      if(next){sessionRef.current=next;setSession(next);invalidate('/guide');invalidate('/iptv/channels');}
      else setError(`${message} No available backup feed could be started.`);
    }).catch(e=>{if(isCurrent())setError((e as Error).message);})
      .finally(()=>{if(failover.current===recovery)setSwitchingLive(false);});
  };
  // Another audio track needs a new playback session (Plex HLS) resumed at the current position.
  const changeAudio=(audioStreamId:string,timeMs:number)=>void action(async()=>{
    const current=sessionRef.current;if(current?.kind!=='vod')return;
    const body={mode:'plex_vod',ratingKey:current.item.id,capabilities:browserCapabilities(),startAtMs:Math.round(Math.min(timeMs,current.item.durationMs??timeMs)),audioStreamId};
    const release=()=>api(`/playback/sessions/${current.id}`,'DELETE').catch(()=>{});let released=false;
    setSwitchingAudio(true);
    try {
      let created:Omit<VodSession,'item'|'kind'>;
      // The current stream keeps playing until its replacement is ready, unless it holds the only encoder slot.
      try {created=await api<Omit<VodSession,'item'|'kind'>>('/playback/sessions','POST',body);}
      catch(e) {
        if(!(e instanceof ApiClientError&&e.code==='TRANSCODE_CAPACITY_REACHED'))throw e;
        await release();released=true;
        try {created=await api<Omit<VodSession,'item'|'kind'>>('/playback/sessions','POST',body);}
        catch(retry) {if(sessionRef.current===current){player.current?.stop();sessionRef.current=undefined;setSession(undefined);}throw retry;}
      }
      if(sessionRef.current!==current){await api(`/playback/sessions/${created.id}`,'DELETE').catch(()=>{});return;}
      const next:VodSession={...created,kind:'vod',item:current.item};sessionRef.current=next;setSession(next);
      if(!released)void release();
    } finally {setSwitchingAudio(false);}
  });
  // Channel up/down follows the viewer's lineup order and wraps around.
  const lineup=useApi<{channels:{id:string;name:string;number:number;stack?:string;feeds?:StationFeed[]}[]}>(session?.kind==='live'?'/iptv/channels':undefined);
  const stepChannel=(step:1|-1)=>{
    const current=sessionRef.current,list=lineup.data?.channels??[];if(current?.kind!=='live'||busy||!list.length)return;
    const index=list.findIndex(c=>hasFeed(c,current.channel.id));watchChannel(tuneTarget(list[(index+step+list.length)%list.length]!));
  };
  const switchFeed=(id:string)=>{
    const current=sessionRef.current;if(current?.kind!=='live'||busy)return;
    rememberFeed(current.channel.stack,id);watchChannel(tuneTarget(current.channel,id),current.program);
  };
  const logout=()=>void action(async()=>{try{await stop();}finally{await api('/auth/logout','POST');invalidate();setAuthUrl('');identity.reload();window.location.hash='home';}});
  useEffect(()=>{if(identity.error&&[401,403].includes(identity.error.status)){failover.current.cancel();player.current?.stop();sessionRef.current=undefined;setSession(undefined);setSwitchingLive(false);}},[identity.error]);
  const progress=(timeMs:number,state:'playing'|'paused'|'stopped')=>{const current=session;if(current?.kind!=='vod')return;void api(`/playback/sessions/${current.id}/progress`,'PATCH',{timeMs:Math.round(Math.min(timeMs,current.item.durationMs??timeMs)),state}).catch(e=>setError(e.message));};
  const vod=session?.kind==='vod'?session:undefined,channel=session?.kind==='live'?session:undefined,item=vod?.item;
  const subtitle=channel?[`CH ${channel.channel.number}`,channel.program].filter(Boolean).join(' · '):item?.type==='episode'?`${item.showTitle??''} · S${item.seasonNumber??'?'}:E${item.episodeNumber??'?'}`:item?.year?String(item.year):undefined;
  const signIn=<section className="sign-in"><div className="sign-in-card"><span className="brand large">tk.box</span><h1>Your movies, shows and channels.</h1><p className="muted">Everything from your Plex server, in one place.</p>
    {setup.error?<ErrorNotice message={setup.error.message} retry={setup.reload}/>:setup.data?.plexConfigured?<><button className="primary large" disabled={busy} onClick={()=>void action(async()=>{const result=await api<{authUrl:string}>('/auth/plex/start','POST');setAuthUrl(result.authUrl);window.open(result.authUrl,'_blank','noopener,noreferrer');})}>Sign in with Plex</button>
      {authUrl&&<div className="linking"><span className="spinner"/><p>Finish signing in on the Plex tab. tk.box connects automatically.</p><a href={authUrl} target="_blank" rel="noreferrer">Reopen Plex sign-in</a><button className="text-button" disabled={busy} onClick={()=>void action(checkAuth)}>I've signed in</button></div>}</>
    :<p>Set up your Plex server in the local configuration to enable sign-in.</p>}<small className="muted">Your Plex password stays with Plex.</small></div></section>;
  const content=!me?signIn:route.page==='home'?<Home libraries={libraries} onOpen={openItem} onPlay={play} busy={busy}/>
    :libraryPage?<LibraryView key={`${me.accountId}-${route.page}`} accountId={me.accountId} type={route.page==='movies'?'movie':'show'} libraries={libraries} params={route.params} onOpen={openItem} onPlay={play}/>
    :route.page==='search'?<Search libraries={libraries} params={route.params} onOpen={openItem} onPlay={play}/>
    :route.page==='live'?<Live key={me.accountId} admin={me.role==='admin'} params={route.params} accountId={me.accountId} onWatch={watchChannel} busy={busy} playing={session?.kind==='live'?session.channel.id:undefined}/>
    :route.page==='settings'?<div className="page"><Suspense fallback={<Loading/>}><Settings me={me} onLogout={logout}/></Suspense></div>
    :watching?(!session&&<div className="page"><Empty title="Nothing is playing"><a href="#home">Find something to watch</a></Empty></div>)
    :<div className="page"><Empty title="Page not found"><a href="#home">Return home</a></Empty></div>;
  return <div className={`app page-${route.page}`}>
    <a className="skip-link" href="#main-content" onClick={e=>{e.preventDefault();document.getElementById('main-content')?.focus();}}>Skip to content</a>
    {!watching&&<header className={`nav ${scrolled||route.page!=='home'||!me?'solid':''}`}>
      <a href="#home" className="brand" aria-label="tk.box home">tk.box</a>
      {me&&<nav className="nav-links" aria-label="Main navigation">{navigation.map(([page,label])=><a key={page} href={link(page)} aria-current={route.page===page?'page':undefined}>{label}</a>)}</nav>}
      {me&&<div className="nav-actions"><a href="#search" className="icon-button" aria-label="Search (Ctrl K)" aria-current={route.page==='search'?'page':undefined}><Icon name="search" size={22}/></a><a href="#settings" className="avatar" aria-label={`Settings · ${me.role==='admin'?'Administrator':'Viewer'}`} aria-current={route.page==='settings'?'page':undefined}><Icon name="settings" size={20}/></a></div>}
    </header>}
    <main id="main-content" tabIndex={-1}>
      <ActionNotice/>
      {error&&<div className="toast"><ErrorNotice message={error} dismiss={()=>setError('')}/></div>}
      {identity.loading&&!me?<div className="page"><Loading/></div>:<>{catalog.error&&<div className="page"><ErrorNotice message={catalog.error.message} retry={catalog.reload}/></div>}{content}</>}
    </main>
    {me&&!watching&&<nav className="tabbar" aria-label="Mobile navigation">{[...navigation,['search','Search'] as const].map(([page,label])=><a key={page} href={link(page)} aria-current={route.page===page?'page':undefined}><Icon name={page} size={22}/><span>{label.replace(' TV','').replace('TV ','')}</span></a>)}</nav>}
    <PersistentPlayer key="persistent-player" ref={player} url={session?.streamUrl} live={!!channel} onChannel={channel&&(lineup.data?.channels.length??0)>1?stepChannel:undefined} channels={channel&&<ChannelPanel playing={channel.channel.id} busy={busy} onWatch={watchChannel}/>} feeds={channel?.channel.feeds?.map(f=>({id:f.id,label:stationName(f.name).label,...(f.quality?{quality:f.quality}:{})}))} feed={channel?.channel.id} onFeed={channel&&switchFeed}delivery={session?.delivery} startOffsetMs={vod?.startOffsetMs} tracks={vod?.tracks} source={session?.source} subtitleBase={vod&&`/api/v1/playback/sessions/${vod.id}/subtitles/`} audioSwitching={switchingAudio} liveSwitching={switchingLive} onAudioChange={vod&&changeAudio} title={channel?channel.channel.name:item?.title} subtitle={subtitle} docked={!watching} onStop={()=>void action(async()=>{const back=watching;await stop();if(back)window.location.hash=returnTo.current;})} onRestore={()=>{window.location.hash='watch';}} onBack={()=>{window.location.hash=returnTo.current;}} onProgress={progress} onError={playbackError}/>
    {me&&itemId&&/^\d+$/.test(itemId)&&<Details key={itemId} id={itemId} onClose={closeItem} onOpen={openItem} onPlay={play} busy={busy} error={error}/>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
