import {lazy,Suspense,useCallback,useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {Principal,Library,CatalogItem,CatalogPage,Quality,QualityOption} from '../../../packages/contracts/src/index.js';
import {api,ApiClientError} from './api.js';
import {useApi,useRoute,useScrolled,link,replaceRoute,invalidate} from './hooks.js';
import {PersistentPlayer,browserCapabilities,type PlayerHandle,type Delivery,type Timeshift,type TimeshiftState,type MediaTracks,type SourceInfo,type LiveProgram,type SkipMarker} from './player.js';
import {Icon,ErrorNotice,Loading,Empty,ActionNotice,setArtworkEditor,setHoldMenu} from './components.js';
import {leavingEntries,loadLeaving} from './cleanup-holds.js';
import {refreshCatalog} from './media-actions.js';
import {LiveFailover,type LiveSession} from './live-failover.js';
import {Home,LibraryView,Search,Details,playableOf} from './library.js';
import {HeaderSearch} from './header-search.js';
import {HeaderStreams} from './header-streams.js';
import {openPlexPopup} from './plex-popup.js';
import {FirstRun} from './first-run.js';
import {showEpisodes,collectionItems,type PlayQueue} from './play-queue.js';
import {getPlayerPreferences} from './player-preferences.js';
// Settings and the Admin console are rarely visited, so they load on demand; the Admin console is its own bundle.
const Settings=lazy(()=>import('./settings.js').then(m=>({default:m.Settings})));
const Admin=lazy(()=>import('./admin.js').then(m=>({default:m.Admin})));
const TitleArtwork=lazy(()=>import('./artwork-titles.js').then(m=>({default:m.TitleArtwork})));
const Explore=lazy(()=>import('./explore.js').then(m=>({default:m.Explore})));
// A deploy replaces the hashed bundles, so a tab opened before it asks for files that are gone. Reload once to pick up
// the new build; the timestamp stops a loop if the file is still missing after the reload.
window.addEventListener('vite:preloadError',event=>{
  let last=0;
  try{last=Number(sessionStorage.getItem('tkbox-reloaded-at'))||0;sessionStorage.setItem('tkbox-reloaded-at',String(Date.now()));}catch{}
  if(Date.now()-last<10_000)return;
  event.preventDefault();
  window.location.reload();
});
import {Live,ChannelPanel,rememberFeed,tuneTarget,hasFeed,stationName,type WatchChannel,type StationFeed} from './live.js';
import './style.css';

type VodSession={kind:'vod';id:string;streamUrl:string;delivery:Delivery;startOffsetMs:number;tracks?:MediaTracks;markers?:SkipMarker[];source?:SourceInfo;quality?:Quality;qualityOptions?:QualityOption[];audioStreamId?:string;item:CatalogItem};
type Session=VodSession|LiveSession;
const fetchPage=(path:string)=>api<CatalogPage>(path);
const navigation=[['home','Home'],['movies','Movies'],['shows','TV Shows'],['explore','Explore'],['live','Live TV']] as const;
function App() {
  const route=useRoute(),identity=useApi<Principal&{libraries?:Library[]}>('/me'),setup=useApi<{plexConfigured:boolean;plexUrl?:string}>('/setup'),scrolled=useScrolled();
  // Only a 401 means signed out. A 403 is Plex refusing a check, which the server has already retried; the viewer stays
  // signed in with what they're watching, and the next check tries again.
  const me=identity.error?.status===401?undefined:identity.data;
  // Edit artwork, offered on every title's menu to admins, opens the title editor over the current page.
  const [artwork,setArtwork]=useState<string>(),admin=me?.role==='admin';
  useEffect(()=>{setArtworkEditor(admin?setArtwork:undefined);return()=>setArtworkEditor(undefined);},[admin]);
  // Leaving Soon titles offer Keep longer on their menus to admins, from the last clean up run.
  useEffect(()=>{if(!admin)return;setHoldMenu(leavingEntries);void loadLeaving();return()=>setHoldMenu(undefined);},[admin]);
  // When an artwork or cleanup job finishes, the server says so and every view on screen reloads its titles; changed
  // art has a new address, so only those posters load again. After a dropped stream it reloads once, for what it missed.
  const signedIn=me?.accountId;
  useEffect(()=>{
    if(!signedIn||!('EventSource' in window))return;
    const events=new EventSource('/api/v1/events');let dropped=false;
    events.addEventListener('library',()=>{invalidate('/catalog');if(admin){invalidate('/admin/cleanup/titles');void loadLeaving();}});
    events.addEventListener('open',()=>{if(dropped)invalidate('/catalog');dropped=false;});
    events.addEventListener('error',()=>{dropped=true;});
    return()=>events.close();
  },[signedIn,admin]);
  const catalog=useApi<{libraries:Library[]}>(me&&!identity.data?.libraries?'/libraries':undefined),libraries=(identity.data?.libraries??catalog.data?.libraries??[]).filter(l=>['movie','show'].includes(l.type));
  const [session,setSession]=useState<Session>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[switching,setSwitching]=useState<'audio'|'quality'>(),[authUrl,setAuthUrl]=useState('');
  const plexPopup=useRef<Window|null>(null);
  const failover=useRef(new LiveFailover()),[switchingLive,setSwitchingLive]=useState(false);
  // The channel being tuned: the player opens on it with a spinner before the server has a stream.
  const [tuning,setTuning]=useState<{name:string;program?:string}>(),tuningRef=useRef<object>(undefined);
  const player=useRef<PlayerHandle>(null),sessionRef=useRef(session),returnTo=useRef('#home'),locking=useRef(false),routeRef=useRef(route);sessionRef.current=session;routeRef.current=route;
  const libraryPage=route.page==='movies'||route.page==='shows',watching=route.page==='watch';
  const itemId=route.params.get('item');
  const searchReturnTo=useRef('#home');
  const routeHash=link(route.page,Object.fromEntries(route.params));
  useEffect(()=>{if(['home','movies','shows','explore','live','settings','admin'].includes(route.page))searchReturnTo.current=routeHash;},[route.page,routeHash]);
  const changeSearch=useCallback((value:string)=>{
    const {page,params}=routeRef.current;
    if(!value.trim()){if(page==='search')replaceRoute(searchReturnTo.current);return;}
    const next=link('search',{q:value});
    if(page==='search')replaceRoute(next);
    else {searchReturnTo.current=['home','movies','shows','explore','live','settings','admin'].includes(page)?link(page,Object.fromEntries(params)):'#home';window.location.hash=next;}
  },[]);
  useEffect(()=>{const shortcut=(event:KeyboardEvent)=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();const banner=document.querySelector<HTMLButtonElement>('.nav-search-toggle');if(banner?.getClientRects().length){banner.click();return;}const input=document.querySelector<HTMLInputElement>('.browse-search input,.search-box input');if(input)input.focus();else window.location.hash='search';}};window.addEventListener('keydown',shortcut);return()=>window.removeEventListener('keydown',shortcut);},[]);
  useEffect(()=>{if(!itemId)window.scrollTo({top:0,behavior:'instant'});},[route.page]);
  // Stable callbacks keep memoized cards from re-rendering on unrelated shell updates.
  const openItem=useCallback((id:string)=>{setError('');const {page,params}=routeRef.current,next=new URLSearchParams(params);next.set('item',id);window.location.hash=`${page==='watch'?'home':page}?${next}`;},[]);
  const closeItem=()=>{const params=new URLSearchParams(route.params);params.delete('item');window.location.hash=`${route.page}${params.size?'?'+params:''}`;};
  async function checkAuth() {
    const result=await api<{status:string}>('/auth/plex/status','POST');if(result.status==='authenticated'){setAuthUrl('');plexPopup.current?.close();plexPopup.current=null;identity.reload();catalog.reload();}
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
  // Moving on to a queued item keeps Back pointing where the queue was started.
  // A title starts in the viewer's preferred audio language and default quality; a default quality
  // this title or browser cannot use, or that needs an encoder none is free for, falls back to Auto.
  async function start(item:CatalogItem,from:'resume'|'beginning',keepReturn=false) {
    await stop();
    if(!keepReturn){const {page,params}=routeRef.current,old=new URLSearchParams(params);old.delete('item');returnTo.current=link(page==='watch'?'home':page,Object.fromEntries(old));}
    const {quality,audioLanguage}=getPlayerPreferences(),create=(quality:Quality)=>api<Omit<VodSession,'item'|'kind'>>('/playback/sessions','POST',{mode:'plex_vod',ratingKey:item.id,capabilities:browserCapabilities(),startFrom:from,quality,...(audioLanguage?{audioLanguage}:{})});
    let created:Omit<VodSession,'item'|'kind'>;
    try {created=await create(quality);}
    catch(e) {if(quality==='auto'||!(e instanceof ApiClientError&&['SOURCE_INCOMPATIBLE','QUALITY_NOT_PERMITTED','TRANSCODE_CAPACITY_REACHED'].includes(e.code)))throw e;created=await create('auto');}
    // A queued title plays wherever the player is, so a mini player stays docked.
    setSession({...created,kind:'vod',item});if(!keepReturn)window.location.hash='watch';
  }
  // The play queue: a show's episodes across all its seasons, or a whole collection. The current title's
  // place in it is found by id, so audio and quality restarts keep it.
  const [queue,setQueue]=useState<PlayQueue>(),queueToken=useRef<object>(undefined);
  const clearQueue=()=>{queueToken.current=undefined;setQueue(undefined);};
  const play=useCallback((media:CatalogItem,from:'resume'|'beginning'=getPlayerPreferences().startFrom)=>void action(async()=>{
    clearQueue();const item=await playableOf(media);if(!item)throw new Error('Nothing to play yet.');
    await start(item,from);
    // Playback never waits for the queue; an episode's show is listed while it starts.
    const show=item.type==='episode'?item.showId:undefined;if(!show)return;
    const token={};queueToken.current=token;
    void showEpisodes(fetchPage,show,item).then(items=>{if(queueToken.current===token&&items.length>1)setQueue({title:item.showTitle??'Episodes',items});},()=>{});
  }),[]);
  // A collection's Play queues its titles in page order; shows in it queue all their episodes.
  const playAll=useCallback((path:string,title:string)=>void action(async()=>{
    clearQueue();const items=await collectionItems(fetchPage,path);if(!items.length)throw new Error('Nothing to play yet.');
    await start(items[0]!,'beginning');if(items.length>1)setQueue({title,items});
  }),[]);
  // Next, Previous and the end-of-title countdown start from the beginning; a pick from the list resumes.
  // The player stays open on a spinner while the next title starts.
  const [loadingNext,setLoadingNext]=useState<CatalogItem>();
  const playQueued=(index:number,from:'resume'|'beginning')=>{
    const next=queue?.items[index];if(!next||locking.current)return;setLoadingNext(next);
    void action(async()=>{try{await start(next,from,true);}finally{setLoadingNext(undefined);}});
  };
  // The server answers once the channel's relay has its first segment, so playback starts promptly.
  const watchChannel=useCallback<WatchChannel>((channel,program)=>void action(async()=>{
    // Back returns to where the channel was picked (Live TV or Home); switching from the player keeps that place.
    const {page,params}=routeRef.current;if(page!=='watch')returnTo.current=link(page,Object.fromEntries(params));
    clearQueue();const token={};tuningRef.current=token;setTuning({name:channel.name,...(program?{program}:{})});window.location.hash='watch';
    try {
      await stop();if(tuningRef.current!==token)return;
      const recovery=failover.current=new LiveFailover();
      // A feed that cannot be started (offline, or a 4K source this server will not convert) moves on to the station's next feed.
      // The session keeps the station's feed list so the player can switch feeds without a guide lookup.
      const next=await recovery.tune(channel,program,()=>failover.current===recovery&&tuningRef.current===token);if(!next)return;
      sessionRef.current=next;setSession(next);
    } catch(e) {
      if(tuningRef.current===token&&routeRef.current.page==='watch')window.location.hash=returnTo.current;
      throw e;
    } finally {if(tuningRef.current===token){tuningRef.current=undefined;setTuning(undefined);}}
  }),[]);
  // Closing the player while a channel tunes abandons it; a session that arrives late is released.
  const cancelTuning=()=>{tuningRef.current=undefined;failover.current.cancel();setTuning(undefined);};
  // Pause, Resume and Go Live for the current custom-channel session.
  const timeshift=useCallback<Timeshift>((step,displayedUtc)=>{
    const current=sessionRef.current;if(current?.kind!=='live')return Promise.reject(new Error('Nothing is playing.'));
    return step==='state'?api<TimeshiftState>(`/live/sessions/${current.id}/state`):api<TimeshiftState>(`/live/sessions/${current.id}/${step}`,'POST',step==='pause'?{displayedUtc:Math.round(displayedUtc??Date.now())}:{});
  },[]);
  // What each custom-channel program aired with, so the player can offer its subtitles. Refreshed as programs change.
  const [programs,setPrograms]=useState<LiveProgram[]>();
  const customId=session?.kind==='live'&&session.timeshift?session.id:undefined;
  useEffect(()=>{
    setPrograms(undefined);if(!customId)return;let active=true;
    const load=()=>void api<{programs:LiveProgram[]}>(`/live/sessions/${customId}/programs`).then(r=>{if(active)setPrograms(r.programs);},()=>{});
    load();const timer=window.setInterval(load,15000);return()=>{active=false;clearInterval(timer);};
  },[customId]);
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
  // Another audio track or quality, or a seek Plex never delivered, needs a new playback session resumed at that position;
  // each change keeps the other choice.
  const restart=(change:{audioStreamId?:string;quality?:Quality},timeMs:number)=>void action(async()=>{
    const current=sessionRef.current;if(current?.kind!=='vod')return;
    const audioStreamId=change.audioStreamId??current.audioStreamId,quality=change.quality??current.quality??'auto',{audioLanguage}=getPlayerPreferences();
    const body={mode:'plex_vod',ratingKey:current.item.id,capabilities:browserCapabilities(),startAtMs:Math.round(Math.min(timeMs,current.item.durationMs??timeMs)),quality,...(audioStreamId?{audioStreamId}:audioLanguage?{audioLanguage}:{})};
    const release=()=>api(`/playback/sessions/${current.id}`,'DELETE').catch(()=>{});let released=false;
    // A stalled seek recovers quietly behind the player's own buffering spinner.
    if(change.quality||change.audioStreamId)setSwitching(change.quality?'quality':'audio');
    try {
      let created:Omit<VodSession,'item'|'kind'>;
      // The current stream keeps playing until its replacement is ready, unless it holds the only encoder slot.
      try {created=await api<Omit<VodSession,'item'|'kind'>>('/playback/sessions','POST',body);}
      catch(e) {
        if(!(e instanceof ApiClientError&&e.code==='TRANSCODE_CAPACITY_REACHED')||current.delivery!=='transcode')throw e;
        await release();released=true;
        try {created=await api<Omit<VodSession,'item'|'kind'>>('/playback/sessions','POST',body);}
        catch(retry) {if(sessionRef.current===current){player.current?.stop();sessionRef.current=undefined;setSession(undefined);}throw retry;}
      }
      if(sessionRef.current!==current){await api(`/playback/sessions/${created.id}`,'DELETE').catch(()=>{});return;}
      const next:VodSession={...created,kind:'vod',item:current.item,...(audioStreamId?{audioStreamId}:{})};sessionRef.current=next;setSession(next);
      if(!released)void release();
    } finally {setSwitching(undefined);}
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
  useEffect(()=>{if(identity.error?.status===401){cancelTuning();player.current?.stop();sessionRef.current=undefined;setSession(undefined);setSwitchingLive(false);}},[identity.error]);
  const progress=(timeMs:number,state:'playing'|'paused'|'stopped')=>{const current=session;if(current?.kind!=='vod')return;void api(`/playback/sessions/${current.id}/progress`,'PATCH',{timeMs:Math.round(Math.min(timeMs,current.item.durationMs??timeMs)),state}).catch(e=>setError(e.message));};
  const vod=session?.kind==='vod'?session:undefined,channel=session?.kind==='live'?session:undefined,item=vod?.item??loadingNext;
  const queueIndex=item&&queue?queue.items.findIndex(i=>i.id===item.id):-1;
  const subtitle=channel?channel.program:item?.type==='episode'?`${item.showTitle??''} · S${item.seasonNumber??'?'}:E${item.episodeNumber??'?'}`:item?.year?String(item.year):undefined;
  const signIn=setup.data&&!setup.data.plexConfigured?<section className="sign-in"><FirstRun plexUrl={setup.data.plexUrl} onDone={()=>{setup.reload();identity.reload();catalog.reload();}}/></section>
    :<section className="sign-in"><div className="sign-in-card"><span className="brand large">tk.box</span><h1>Your movies, shows and channels.</h1><p className="muted">Everything from your Plex server, in one place.</p>
    {setup.error?<ErrorNotice message={setup.error.message} retry={setup.reload}/>:setup.data?.plexConfigured?<><button className="primary large" disabled={busy} onClick={()=>{if(locking.current)return;const popup=openPlexPopup();plexPopup.current=popup;void action(async()=>{try{const result=await api<{authUrl:string}>('/auth/plex/start','POST');setAuthUrl(result.authUrl);if(popup&&!popup.closed)popup.location.href=result.authUrl;else plexPopup.current=openPlexPopup(result.authUrl)??(window.open(result.authUrl,'_blank','noopener,noreferrer'),null);}catch(e){popup?.close();throw e;}});}}>Sign in with Plex</button>
      {authUrl&&<div className="linking"><span className="spinner"/><p>Finish signing in in the Plex window. tk.box connects automatically.</p><a href={authUrl} target="_blank" rel="noreferrer" onClick={event=>{const popup=openPlexPopup(authUrl);if(popup){event.preventDefault();plexPopup.current=popup;}}}>Reopen Plex sign-in</a><button className="text-button" disabled={busy} onClick={()=>void action(checkAuth)}>I've signed in</button></div>}</>
    :<Loading/>}<small className="muted">Your Plex password stays with Plex.</small></div></section>;
  const content=!me?signIn:route.page==='home'?<Home libraries={libraries} onOpen={openItem} onPlay={play} onWatch={watchChannel} busy={busy}/>
    :libraryPage?<LibraryView key={`${me.accountId}-${route.page}`} accountId={me.accountId} type={route.page==='movies'?'movie':'show'} libraries={libraries} params={route.params} onOpen={openItem} onPlay={play} onPlayAll={playAll}/>
    :route.page==='search'?<Search libraries={libraries} params={route.params} onOpen={openItem} onPlay={play} onSearchChange={changeSearch}/>
    :route.page==='explore'?<div key={me.accountId}><Suspense fallback={<div className="page"><Loading/></div>}><Explore params={route.params} admin={me.role==='admin'} onOpen={openItem}/></Suspense></div>
    :route.page==='live'?<Live key={me.accountId} admin={me.role==='admin'} params={route.params} accountId={me.accountId} onWatch={watchChannel} busy={busy} playing={session?.kind==='live'?session.channel.id:undefined}/>
    :route.page==='settings'?<div className="page"><Suspense fallback={<Loading/>}><Settings me={me} onLogout={logout}/></Suspense></div>
    :route.page==='admin'?<div className="page"><Suspense fallback={<Loading/>}><Admin me={me} params={route.params}/></Suspense></div>
    :watching?(!session&&!tuning&&<div className="page"><Empty title="Nothing is playing"><a href="#home">Find something to watch</a></Empty></div>)
    :<div className="page"><Empty title="Page not found"><a href="#home">Return home</a></Empty></div>;
  return <div className={`app page-${route.page}`}>
    <a className="skip-link" href="#main-content" onClick={e=>{e.preventDefault();document.getElementById('main-content')?.focus();}}>Skip to content</a>
    {!watching&&<header className={`nav ${scrolled||route.page!=='home'||!me?'solid':''}`}>
      <a href="#home" className="brand" aria-label="tk.box home">tk.box</a>
      {me&&<nav className="nav-links" aria-label="Main navigation">{navigation.map(([page,label])=><a key={page} href={link(page)} aria-current={route.page===page?'page':undefined}>{label}</a>)}</nav>}
      {me&&<div className="nav-actions"><HeaderSearch page={route.page} query={route.page==='search'?route.params.get('q')??'':''} onChange={changeSearch}/>{me.role==='admin'&&<HeaderStreams/>}{me.role==='admin'&&<a href="#admin" className="nav-admin" aria-label="Admin console" title="Admin console" aria-current={route.page==='admin'?'page':undefined}><Icon name="shield" size={20}/></a>}<a href="#settings" className="avatar" aria-label={`Settings · ${me.role==='admin'?'Administrator':'Viewer'}`} aria-current={route.page==='settings'?'page':undefined}><Icon name="settings" size={20}/></a></div>}
    </header>}
    <main id="main-content" tabIndex={-1}>
      <ActionNotice/>
      {error&&<div className="toast"><ErrorNotice message={error} dismiss={()=>setError('')}/></div>}
      {identity.loading&&!me?<div className="page"><Loading/></div>:<>{catalog.error&&<div className="page"><ErrorNotice message={catalog.error.message} retry={catalog.reload}/></div>}{content}</>}
    </main>
    {me&&!watching&&<nav className="tabbar" aria-label="Mobile navigation">{[...navigation,['search','Search'] as const].map(([page,label])=><a key={page} href={link(page)} aria-current={route.page===page?'page':undefined}><Icon name={page} size={22}/><span>{label.replace(' TV','').replace('TV ','')}</span></a>)}</nav>}
    <PersistentPlayer key="persistent-player" ref={player} url={session?.streamUrl} live={!!channel||!!tuning} tuning={!!tuning&&!session} loading={!!loadingNext&&!session} onChannel={channel&&(lineup.data?.channels.length??0)>1?stepChannel:undefined} channels={channel&&<ChannelPanel playing={channel.channel.id} busy={busy} onWatch={watchChannel}/>} feeds={channel?.channel.feeds?.map(f=>({id:f.id,label:stationName(f.name).label,...(f.quality?{quality:f.quality}:{})}))} feed={channel?.channel.id} onFeed={channel&&switchFeed}delivery={session?.delivery} startOffsetMs={vod?.startOffsetMs} tracks={vod?.tracks} markers={vod?.markers} programs={customId?programs??[]:undefined} source={session?.source} subtitleBase={vod?`/api/v1/playback/sessions/${vod.id}/subtitles/`:customId&&`/api/v1/live/sessions/${customId}/subtitles/`} switching={switching} liveSwitching={switchingLive} timeshift={channel?.timeshift?timeshift:undefined} onAudioChange={vod&&((id:string,timeMs:number)=>restart({audioStreamId:id},timeMs))} onStall={vod&&((timeMs:number)=>restart({},timeMs))} quality={vod?.quality} qualityOptions={vod?.qualityOptions} onQualityChange={vod&&((quality:Quality,timeMs:number)=>restart({quality},timeMs))} title={channel?channel.channel.name:tuning?tuning.name:item?.title} subtitle={tuning&&!session?tuning.program:subtitle} docked={!watching} onStop={()=>{if(tuning&&!session){cancelTuning();if(watching)window.location.hash=returnTo.current;return;}void action(async()=>{const back=watching;clearQueue();await stop();if(back)window.location.hash=returnTo.current;});}} onRestore={()=>{window.location.hash='watch';}} onBack={()=>{window.location.hash=returnTo.current;}} onProgress={progress} queue={queueIndex>=0?{...queue!,index:queueIndex}:undefined} onQueuePick={playQueued} onError={playbackError}/>
    {me&&itemId&&/^\d+$/.test(itemId)&&<Details id={itemId} onClose={closeItem} onOpen={openItem} onPlay={play} busy={busy} error={error} admin={me.role==='admin'}/>}
    {artwork&&<Suspense fallback={null}><TitleArtwork key={artwork} ratingKey={artwork} onClose={()=>setArtwork(undefined)}/></Suspense>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
