import {forwardRef,useEffect,useImperativeHandle,useMemo,useRef,useState,type CSSProperties,type ReactNode,type RefObject} from 'react';
import type Hls from 'hls.js';
import {Icon} from './components.js';
import {duration,timecode} from './hooks.js';
import {activeCaptions,parseVtt,timelineShift,type Caption} from './captions.js';
import {CaptionCue,captionBox,subtitleFontSize,subtitleSizes,updateSubtitleStyle,useSubtitleStyle,type SubtitleStyle} from './subtitle-style.js';
import {LivePlaybackWatchdog} from './live-failover.js';
import {StallMeter} from './stall-meter.js';
import {pickSubtitle,subtitleChoice,updatePlayerPreferences,usePlayerPreferences} from './player-preferences.js';
import {qualityTiers,type CatalogItem,type Quality,type QualityOption} from '../../../packages/contracts/src/index.js';
export type PlayerHandle={stop:()=>{timeMs:number;started:boolean}};
// Custom channels only: the viewer's own position behind the shared broadcast (IPTV stays strictly live).
export type TimeshiftState={state:'LIVE'|'PAUSED'|'PLAYING_DELAYED'|'EXPIRED'|'STOPPED';behindLiveMs:number;viewerCursorUtc:number;broadcastNowUtc:number};
export type Timeshift=(action:'pause'|'resume'|'go-live'|'state',displayedUtc?:number)=>Promise<TimeshiftState>;
export type Delivery='direct'|'remux'|'transcode';
export type SubtitleTrack={id:string;label:string;language?:string;forced:boolean;selected:boolean;supported:boolean};
export type AudioTrack={id:string;label:string;language?:string;selected:boolean};
export type MediaTracks={subtitles:SubtitleTrack[];audio:AudioTrack[]};
// A custom-channel program as it aired: from broadcast time `start` the picture shows media position `mediaStartMs` onward.
export type LiveProgram={id:string;start:number;mediaStartMs:number;subtitles:SubtitleTrack[]};
// A Plex intro or credits section in media milliseconds; `final` marks the closing credits.
export type SkipMarker={type:'intro'|'credits';startMs:number;endMs:number;final:boolean};
export type SourceInfo={videoCodec?:string;audioCodec?:string;width?:number;height?:number;container?:string;bitrateKbps?:number};
const deliveryLabel:Record<Delivery,string>={direct:'Direct Play',remux:'Direct Stream',transcode:'Transcode'};
const deliveryDetail:Record<Delivery,string>={direct:'Playing the original file.',remux:'Original video, repackaged for this browser.',transcode:'Converted by Plex for this browser.'};
const liveDetail:Partial<Record<Delivery,string>>={remux:'Channel video, repackaged for this browser.',transcode:'Channel video, converted by tk.box for this browser.'};
const tierOf=(q:Quality)=>qualityTiers.find(t=>t.id===q),mbps=(kbps:number)=>`${+(kbps/1000).toFixed(1)} Mbps`;
const qualityLabel=(q:Quality)=>q==='auto'?'Auto':q==='original'?'Original':tierOf(q)!.label;
const qualityShort=(q:Quality)=>{const t=tierOf(q);return t?`${t.height}p · ${mbps(t.bitrateKbps)}`:qualityLabel(q);};
const routeDetail=(o:QualityOption)=>o.route==='cpu'?'Converted for this browser':o.route==='remux'?'Original video, repackaged':'Original file';
// The buffering suggestion: a real step down, to about half the current bitrate or the lightest
// conversion left. Only conversions that actually lower the stream count.
const lighter=(current:Quality,options:QualityOption[]|undefined,sourceKbps?:number)=>{
  const now=tierOf(current)?.bitrateKbps??sourceKbps;
  const open=qualityTiers.filter(t=>(now===undefined||t.bitrateKbps<now)&&options?.some(o=>o.quality===t.id&&o.available&&o.route==='cpu'));
  return (open.find(t=>t.bitrateKbps<=(now===undefined?8000:now*.6))??open.at(-1))?.id;
};
const speeds=[.5,.75,1,1.25,1.5,2];
type Panel='subtitles'|'settings'|'channels'|'queue';
const resolution=(source?:SourceInfo)=>{const h=source?.height,w=source?.width;if(!h)return undefined;return w&&w>=3200||h>=2000?'4K':h>=1000?'1080p':h>=700?'720p':`${h}p`;};
const codec=(name?:string)=>name?({h264:'H.264',hevc:'HEVC',h265:'HEVC',av1:'AV1',vp9:'VP9',aac:'AAC',ac3:'Dolby Digital',eac3:'Dolby Digital+',truehd:'TrueHD',dca:'DTS',dts:'DTS',flac:'FLAC',opus:'Opus',mp3:'MP3'}[name.toLowerCase()]??name.toUpperCase()):undefined;
export type Feed={id:string;label:string;quality?:string};
export type QueueState={title:string;items:CatalogItem[];index:number};
const queueArt=(item:CatalogItem)=>item.type==='episode'?item.posterUrl??item.backdropUrl:item.posterUrl;
const queueLabel=(item:CatalogItem)=>item.type==='episode'?`S${item.seasonNumber??'?'}:E${item.episodeNumber??'?'} · ${item.title}`:item.title;
const queueDetail=(item:CatalogItem)=>item.type==='episode'?item.showTitle:item.year?String(item.year):undefined;
type Props={url?:string;queue?:QueueState;onQueuePick?:(index:number,from:'resume'|'beginning')=>void;loading?:boolean;live?:boolean;onChannel?:(step:1|-1)=>void;channels?:ReactNode;feeds?:Feed[];feed?:string;onFeed?:(id:string)=>void;delivery?:Delivery;startOffsetMs?:number;tracks?:MediaTracks;markers?:SkipMarker[];programs?:LiveProgram[];source?:SourceInfo;subtitleBase?:string;switching?:'audio'|'quality';quality?:Quality;qualityOptions?:QualityOption[];onQualityChange?:(quality:Quality,timeMs:number)=>void;liveSwitching?:boolean;tuning?:boolean;timeshift?:Timeshift;onAudioChange?:(id:string,timeMs:number)=>void;onStall?:(timeMs:number)=>void;docked:boolean;title?:string;subtitle?:string;onStop:()=>void;onRestore:()=>void;onBack:()=>void;onProgress:(timeMs:number,state:'playing'|'paused'|'stopped')=>void;onError:(message:string)=>void};
export const PersistentPlayer=forwardRef<PlayerHandle,Props>(function PersistentPlayer({url,queue,onQueuePick,loading,live=false,onChannel,channels,feeds,feed,onFeed,delivery='direct',startOffsetMs=0,tracks,markers,programs,source,subtitleBase,switching,quality='auto',qualityOptions,onQualityChange,liveSwitching,tuning,timeshift,onAudioChange,onStall,docked,title,subtitle,onStop,onRestore,onBack,onProgress,onError},handle) {
  const ref=useRef<HTMLVideoElement>(null),shell=useRef<HTMLElement>(null),bottomRef=useRef<HTMLDivElement>(null),topRef=useRef<HTMLDivElement>(null),state=useRef({active:false,started:false});
  const [view,setView]=useState({playing:false,waiting:false,time:0,duration:NaN,buffered:0,volume:1,muted:false}),[idle,setIdle]=useState(false),[fullscreen,setFullscreen]=useState(false),[scrub,setScrub]=useState<number>();
  const [panel,setPanel]=useState<Panel>(),[rate,setRate]=useState(1),subtitleStyle=useSubtitleStyle(),[remaining,setRemaining]=useState(false);
  const [subtitleId,setSubtitleId]=useState<string|null>(null),[subtitleStatus,setSubtitleStatus]=useState<'loading'|'ready'|'failed'>(),[captions,setCaptions]=useState<Caption[]>(),[shift,setShift]=useState(0),lastSubtitle=useRef<string|null>(null);
  const [hover,setHover]=useState<{x:number;time:number}>(),[flash,setFlash]=useState<{icon:string;label?:string;key:number}>();
  // Go Live reloads the stream at the live edge; `generation` restarts the player effect without a new URL.
  const [shifted,setShifted]=useState<TimeshiftState>(),[generationKey,setGenerationKey]=useState(0),hlsRef=useRef<Hls|undefined>(undefined),timeshiftRef=useRef(timeshift);timeshiftRef.current=timeshift;
  const stallRef=useRef(onStall);stallRef.current=onStall;
  // While a stalled seek recovers, the controls keep showing the seek target and a buffering spinner, as for any slow seek.
  const hold=useRef<{time:number;duration:number;playing:boolean}|undefined>(undefined);
  useEffect(()=>{setShifted(undefined);},[url]);
  // At the end of a title the next one in the queue comes up, and plays after a countdown while Autoplay is on.
  const next=queue?.items[queue.index+1],previous=queue&&queue.index>0?queue.items[queue.index-1]:undefined,prefs=usePlayerPreferences(),{autoplay,countdownSeconds}=prefs;
  const [ended,setEnded]=useState(false),[countdown,setCountdown]=useState<number>();
  const endedRef=useRef(()=>{});endedRef.current=()=>setEnded(true);
  const pickQueued=(index:number,from:'resume'|'beginning')=>{setEnded(false);setCountdown(undefined);onQueuePick?.(index,from);};
  const pickRef=useRef(pickQueued);pickRef.current=pickQueued;
  const chooseAutoplay=(on:boolean)=>{updatePlayerPreferences({autoplay:on});if(!on)setCountdown(undefined);};
  useEffect(()=>{setEnded(false);setCountdown(undefined);},[url]);
  useEffect(()=>{if(ended&&next&&autoplay)setCountdown(countdownSeconds);},[ended,!!next]);
  useEffect(()=>{
    if(countdown===undefined||!queue)return;
    if(countdown<=0){pickRef.current(queue.index+1,'beginning');return;}
    const timer=window.setTimeout(()=>setCountdown(c=>c===undefined?c:c-1),1000);return()=>clearTimeout(timer);
  },[countdown]);
  // Frequent mid-playback buffering suggests a lighter quality, once per stream unless dismissed.
  const suggestion=live?undefined:lighter(quality,qualityOptions,source?.bitrateKbps),suggestionRef=useRef(suggestion);suggestionRef.current=onQualityChange?suggestion:undefined;
  const [nudge,setNudge]=useState(false),nudgeDismissed=useRef(false);
  useEffect(()=>{setNudge(false);nudgeDismissed.current=false;},[url]);
  const clear=()=>{hold.current=undefined;const video=ref.current!,result={timeMs:video.currentTime*1000,started:state.current.started};state.current.active=false;video.pause();video.removeAttribute('src');video.load();return result;};
  useImperativeHandle(handle,()=>({stop:clear}),[]);
  useEffect(()=>{
    const video=ref.current!,generation={active:!!url,started:false};state.current=generation;setShift(0);
    // Only the session that replaces a stalled seek resumes at the held position; anything else starts fresh.
    if(hold.current&&Math.abs(startOffsetMs/1000-hold.current.time)>1)hold.current=undefined;
    let hls:Hls|undefined,last=0,seekOnLoad=true,failureReported=false,resumeAt:number|undefined;
    const fail=(message:string)=>{
      if(!generation.active||failureReported)return;failureReported=true;hold.current=undefined;hls?.stopLoad();
      // A delayed custom-channel viewer whose buffer ran out gets the expiry notice and Go Live, not an error.
      const shift=timeshiftRef.current;if(!shift){onError(message);return;}
      void shift('state').then(s=>{if(!generation.active)return;if(s.state==='EXPIRED')setShifted(s);else onError(message);},()=>{if(generation.active)onError(message);});
    };
    const progress=(kind:'playing'|'paused'|'stopped')=>{if(generation.active&&generation.started&&video.readyState>0&&Number.isFinite(video.currentTime))onProgress(video.currentTime*1000,kind);};
    const sync=()=>setView({playing:hold.current?.playing??!video.paused,waiting:!!hold.current||!video.paused&&video.readyState<3,time:hold.current?.time??video.currentTime,duration:hold.current?.duration??video.duration,buffered:video.buffered.length?video.buffered.end(video.buffered.length-1):0,volume:video.volume,muted:video.muted});
    const loaded=()=>{const at=resumeAt??startOffsetMs/1000;resumeAt=undefined;if(generation.active&&seekOnLoad&&at>0&&Number.isFinite(video.duration))video.currentTime=Math.min(at,Math.max(0,video.duration-.1));sync();};
    const playing=()=>{generation.started=true;setEnded(false);setCountdown(undefined);progress('playing');sync();};
    const time=()=>{sync();if(!video.paused&&Date.now()-last>10000){last=Date.now();progress('playing');}};
    const pause=()=>{progress('paused');sync();},ended=()=>{if(live)fail('The live stream ended unexpectedly.');else {progress('stopped');if(generation.active)endedRef.current?.();}sync();},error=()=>{if(video.error?.code!==1)fail('Playback could not continue. The source may be unavailable or incompatible with this browser.');};
    const stalls=new StallMeter();
    const waiting=()=>{if(generation.started&&!video.seeking&&!video.paused)stalls.start(performance.now());sync();};
    const resumed=()=>{hold.current=undefined;stalls.end(performance.now());sync();};
    // A seek that never lands. Direct play reopens the file at the target; Plex HLS gets a new session starting there,
    // since Plex may never deliver a segment from before where its transcoder started.
    let pendingSeek:{at:number;time:number}|undefined,reloads=0,restarting=false;
    const seeking=()=>{if(hold.current&&Math.abs(video.currentTime-hold.current.time)>1)hold.current=undefined;if(generation.started)pendingSeek={at:performance.now(),time:video.currentTime};};
    const events={seeking,loadedmetadata:loaded,play:playing,timeupdate:time,pause:()=>{stalls.end(performance.now());pause();},ended,error,waiting,playing:resumed,volumechange:sync,progress:sync,seeked:resumed} as const;
    for(const [name,listener] of Object.entries(events))video.addEventListener(name,listener);
    if(url) {
      // Recent Chromium answers "maybe" for native HLS, but hls.js over MSE is the tested path; native HLS is the fallback without MSE.
      const mse='MediaSource' in window||'ManagedMediaSource' in window;
      if(url.endsWith('.m3u8')&&(mse||!video.canPlayType('application/vnd.apple.mpegurl')))void import('hls.js').then(({default:Controller})=>{
        if(!generation.active)return;if(!Controller.isSupported()){fail('This browser cannot play this stream.');return;}
        // hls.js starts at the resume point itself, so it never fetches segments from the beginning first.
        // Subtitles come from tk.box's own WebVTT track, so embedded 608 captions would only duplicate them.
        // Live channels join at the live edge and ride out short relay restarts.
        seekOnLoad=false;const controller=new Controller(live?{liveDurationInfinity:true,enableCEA708Captions:false}:{startPosition:startOffsetMs/1000,enableCEA708Captions:false});hls=controller;hlsRef.current=controller;let networkRetries=0,mediaRecovered=false;
        controller.on(Controller.Events.ERROR,(_event,data)=>{
          if(!data.fatal||!generation.active||failureReported)return;
          if(data.type===Controller.ErrorTypes.NETWORK_ERROR&&networkRetries++<(live?8:3)){window.setTimeout(()=>{if(generation.active&&!failureReported)controller.startLoad();},live?1500:0);return;}
          if(data.type===Controller.ErrorTypes.MEDIA_ERROR&&(!mediaRecovered||live)){mediaRecovered=true;controller.recoverMediaError();return;}
          fail('Playback could not continue. The stream stopped responding or is incompatible with this browser.');controller.destroy();
        });
        controller.on(Controller.Events.FRAG_LOADED,()=>{networkRetries=0;});
        controller.on(Controller.Events.INIT_PTS_FOUND,(_event,data)=>{if(generation.active&&data.id==='main')setShift(timelineShift(data.initPTS,data.timescale));});
        controller.loadSource(url);controller.attachMedia(video);void video.play().catch(()=>{});
      }).catch(()=>{fail('The streaming player could not be loaded.');});
      else {video.src=url;void video.play().catch(()=>{});}
    }
    // Paused sessions keep the server-side stream alive and the Plex position current.
    const heartbeat=window.setInterval(()=>{if(video.paused&&!video.ended)progress('paused');},60000);
    const watchdog=new LivePlaybackWatchdog(),stallCheck=live&&url&&feeds?window.setInterval(()=>{
      if(generation.active&&!failureReported&&watchdog.check(performance.now(),video.currentTime,video.paused||video.seeking))fail('The live stream stopped advancing.');
    },2000):undefined;
    const seekCheck=!live&&url?window.setInterval(()=>{
      if(!pendingSeek||!generation.active||failureReported||restarting)return;
      if(!video.seeking&&(video.paused||video.readyState>=3)){pendingSeek=undefined;reloads=0;return;}
      if(performance.now()-pendingSeek.at<6000)return;
      const {time}=pendingSeek;pendingSeek=undefined;hold.current={time,duration:video.duration,playing:!video.paused};
      if(hls){if(stallRef.current){restarting=true;stallRef.current(time*1000);sync();}else fail('Playback stopped responding after seeking.');return;}
      if(++reloads>2){fail('Playback stopped responding after seeking.');return;}
      const resume=!video.paused,speed=video.playbackRate;resumeAt=time;seekOnLoad=true;video.src=url;video.playbackRate=speed;if(resume)void video.play().catch(()=>{});
    },2000):undefined;
    const bufferingCheck=window.setInterval(()=>{if(generation.active&&suggestionRef.current&&!nudgeDismissed.current&&stalls.heavy(performance.now()))setNudge(true);},2000);
    return()=>{generation.active=false;clearInterval(heartbeat);clearInterval(stallCheck);clearInterval(seekCheck);clearInterval(bufferingCheck);for(const [name,listener] of Object.entries(events))video.removeEventListener(name,listener);video.pause();hls?.destroy();hlsRef.current=undefined;video.removeAttribute('src');video.load();};
  },[url,generationKey]);
  // The broadcast time on screen (the stream's program date-time), for custom-channel subtitles.
  const displayedUtc=()=>{
    const playing=hlsRef.current?.playingDate?.getTime();if(playing)return playing;
    const video=ref.current as (HTMLVideoElement&{getStartDate?:()=>Date})|null,start=video?.getStartDate?.().getTime();
    return video&&start&&Number.isFinite(start)?start+video.currentTime*1000:undefined;
  };
  // On a custom channel, subtitles belong to whichever program is on screen, which changes as the channel plays.
  const [programId,setProgramId]=useState<string>();
  useEffect(()=>{
    setProgramId(undefined);if(!url||!programs)return;
    const update=()=>{const at=displayedUtc();setProgramId(at===undefined?undefined:[...programs].reverse().find(p=>p.start<=at)?.id);};
    update();const timer=window.setInterval(update,500);return()=>clearInterval(timer);
  },[url,generationKey,programs]);
  const program=programs?.find(p=>p.id===programId),subtitleTracks=programs?program?.subtitles??[]:tracks?.subtitles??[];
  const trackBase=programs?program&&subtitleBase&&`${subtitleBase}${program.id}/`:subtitleBase;
  // Each title starts from the viewer's subtitle preference, then Plex's selection. Plex stream IDs
  // are unique per server, so a restart of the same title (an audio switch) keeps the current subtitles.
  useEffect(()=>{
    const keep=subtitleId!==null&&subtitleTracks.some(t=>t.id===subtitleId);
    const id=!url?null:keep?subtitleId:pickSubtitle(subtitleTracks,prefs);setSubtitleId(id);if(!keep)lastSubtitle.current=id;
  },[url,program?.id]);
  useEffect(()=>setPanel(undefined),[url]);
  useEffect(()=>{if(ref.current)ref.current.playbackRate=rate;},[rate,url]);
  // Subtitles may take a while to prepare on the server; playback never waits for them.
  useEffect(()=>{
    setCaptions(undefined);
    if(!url||!subtitleId||!trackBase){setSubtitleStatus(undefined);return;}
    const abort=new AbortController();setSubtitleStatus('loading');
    fetch(`${trackBase}${subtitleId}`,{signal:abort.signal}).then(r=>r.ok?r.text():Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(text=>{const cues=parseVtt(text);if(!text.startsWith('WEBVTT'))throw new Error('not WebVTT');setCaptions(cues);setSubtitleStatus('ready');})
      .catch(()=>{if(!abort.signal.aborted)setSubtitleStatus('failed');});
    return()=>abort.abort();
  },[url,subtitleId,trackBase]);
  const audio=tracks?.audio.find(t=>t.selected)??tracks?.audio[0];
  const chooseSubtitle=(id:string|null)=>{
    setSubtitleId(id);if(id)lastSubtitle.current=id;
    updatePlayerPreferences(subtitleChoice(subtitleTracks.find(t=>t.id===id)));
  };
  const chooseAudio=(id:string)=>{
    if(id===audio?.id||switching||!onAudioChange)return;
    onAudioChange(id,(ref.current?.currentTime??0)*1000);setPanel(undefined);
  };
  const chooseQuality=(next:Quality)=>{
    setNudge(false);if(next===quality||switching||!onQualityChange)return;
    onQualityChange(next,(ref.current?.currentTime??0)*1000);setPanel(undefined);
  };
  const toggleSubtitles=()=>{
    if(subtitleId){chooseSubtitle(null);showFlash('captions','Subtitles off');return;}
    const next=(subtitleTracks.some(t=>t.id===lastSubtitle.current)?lastSubtitle.current:null)??subtitleTracks.find(t=>t.supported&&!t.forced)?.id??null;
    if(next){chooseSubtitle(next);showFlash('captions',subtitleTracks.find(t=>t.id===next)?.label);}
  };
  const flashKey=useRef(0);
  const showFlash=(icon:string,label?:string)=>setFlash({icon,label,key:++flashKey.current});
  // On a custom channel, Pause pins this viewer at the broadcast time on screen (the stream's program date-time)
  // and Play resumes from there, behind live, until Go Live.
  const [shiftBusy,setShiftBusy]=useState(false);
  const shiftAction=(action:'pause'|'resume'|'go-live',displayedUtc?:number)=>{
    if(!timeshift)return Promise.resolve(undefined);setShiftBusy(true);
    return timeshift(action,displayedUtc).then(s=>{setShifted(s);return s;},e=>{if((e as {code?:string}).code==='BUFFER_EXPIRED')return timeshift('state').then(s=>{setShifted(s);return s;});onError((e as Error).message);return undefined;}).finally(()=>setShiftBusy(false));
  };
  const goLive=()=>void shiftAction('go-live').then(s=>{if(s?.state==='LIVE')setGenerationKey(k=>k+1);});
  const toggle=()=>{
    const video=ref.current!;
    if(live&&timeshift){
      if(shiftBusy||shifted?.state==='EXPIRED')return;
      if(!video.paused){video.pause();showFlash('pause');const at=hlsRef.current?.playingDate?.getTime();void shiftAction('pause',at??Date.now()-10000);}
      else void shiftAction('resume').then(s=>{if(s&&s.state!=='EXPIRED'){void video.play().catch(()=>{});showFlash('play');}});
      return;
    }
    if(video.paused){void video.play().catch(()=>{});showFlash('play');}else{video.pause();showFlash('pause');}
  };
  // While behind live the gap keeps growing, and the buffer can expire; refresh what the server says.
  useEffect(()=>{
    if(!timeshift||!shifted||shifted.state==='LIVE'||shifted.state==='EXPIRED')return;
    const timer=window.setInterval(()=>void timeshift('state').then(setShifted,()=>{}),5000);return()=>clearInterval(timer);
  },[timeshift,shifted?.state]);
  const behind=!!shifted&&shifted.state!=='LIVE';
  const seek=(delta:number)=>{const video=ref.current!;video.currentTime=Math.max(0,Math.min(Number.isFinite(video.duration)?video.duration:Infinity,video.currentTime+delta));showFlash(delta<0?'rewind':'forward',`${delta<0?'−':'+'}${Math.abs(delta)}s`);};
  const changeRate=(next:number)=>{setRate(next);showFlash('speed',`${next}×`);};
  // Plex's intro and credits markers, in media time: a Skip button while one plays, and with auto-skip on for its kind,
  // a jump past each marker once per title, so seeking back into one leaves it playing.
  const autoSkipped=useRef(new Set<string>()),autoSkip=(m:SkipMarker)=>m.type==='intro'?prefs.skipIntros:prefs.skipCredits;
  useEffect(()=>{autoSkipped.current.clear();},[url]);
  const mediaMs=(view.time+shift)*1000,marker=live?undefined:markers?.find(m=>mediaMs>=m.startMs&&mediaMs<m.endMs-1000);
  const skipMarker=(m:SkipMarker)=>{
    const video=ref.current!;video.currentTime=Math.min(m.endMs/1000-shift,Number.isFinite(video.duration)?video.duration:Infinity);
    showFlash('skip-next',m.type==='intro'?'Skipped intro':'Skipped credits');
  };
  useEffect(()=>{
    if(!marker||!autoSkip(marker)||!view.playing)return;const key=`${marker.type}:${marker.startMs}`;
    if(!autoSkipped.current.has(key)){autoSkipped.current.add(key);skipMarker(marker);}
  },[marker?.startMs,prefs.skipIntros,prefs.skipCredits,view.playing]);
  const toggleFullscreen=()=>{if(document.fullscreenElement)void document.exitFullscreen();else void shell.current?.requestFullscreen?.().catch(()=>{});};
  useEffect(()=>{const changed=()=>setFullscreen(!!document.fullscreenElement);document.addEventListener('fullscreenchange',changed);return()=>document.removeEventListener('fullscreenchange',changed);},[]);
  useEffect(()=>{if(docked){setPanel(undefined);if(document.fullscreenElement)void document.exitFullscreen();}},[docked]);
  // Controls fade after a few idle seconds while playing, like a TV player.
  const timer=useRef(0);
  const wake=()=>{setIdle(false);clearTimeout(timer.current);timer.current=window.setTimeout(()=>setIdle(true),3000);};
  useEffect(()=>()=>clearTimeout(timer.current),[]);
  useEffect(()=>{
    if(docked||!url)return;
    const keys=(event:KeyboardEvent)=>{
      const target=event.target as HTMLElement;if(event.ctrlKey||event.metaKey||event.altKey||target.closest('input:not([type=range]),select,textarea,dialog'))return;
      if(event.key==='Escape'&&panel){event.preventDefault();setPanel(undefined);return;}
      const video=ref.current!,step=(direction:number)=>{const index=speeds.indexOf(rate);changeRate(speeds[Math.max(0,Math.min(speeds.length-1,(index<0?2:index)+direction))]!);};
      const actions:Record<string,()=>void>={' ':toggle,k:toggle,f:toggleFullscreen,...(live?{...(onChannel?{PageUp:()=>onChannel(1),PageDown:()=>onChannel(-1),ChannelUp:()=>onChannel(1),ChannelDown:()=>onChannel(-1)}:{}),...(channels?{g:()=>setPanel(p=>p==='channels'?undefined:'channels')}:{}),...(programs?{c:toggleSubtitles}:{})}:{ArrowLeft:()=>seek(-10),ArrowRight:()=>seek(10),j:()=>seek(-10),l:()=>seek(10),c:toggleSubtitles,'>':()=>step(1),'<':()=>step(-1),...(next?{N:()=>pickQueued(queue!.index+1,'beginning')}:{}),...(previous?{P:()=>pickQueued(queue!.index-1,'beginning')}:{})}),
        m:()=>{video.muted=!video.muted;showFlash(video.muted?'mute':'volume');},ArrowUp:()=>{video.volume=Math.min(1,video.volume+.1);video.muted=false;showFlash('volume',`${Math.round(video.volume*100)}%`);},ArrowDown:()=>{video.volume=Math.max(0,video.volume-.1);showFlash(video.volume?'volume':'mute',`${Math.round(video.volume*100)}%`);}};
      const action=actions[event.key.length===1?(event.shiftKey&&/^[np]$/i.test(event.key)?event.key.toUpperCase():event.key.toLowerCase()):event.key];
      if(action){if(event.key===' '&&target.closest('button'))return;if(target.matches('input[type=range]')&&event.key.startsWith('Arrow'))return;event.preventDefault();action();wake();}
    };
    window.addEventListener('keydown',keys);return()=>window.removeEventListener('keydown',keys);
  },[docked,url,live,onChannel,channels,panel,rate,subtitleId,tracks,programs,program?.id,queue]);
  const shown=!idle||!view.playing||!!panel,position=scrub??view.time,known=!live&&Number.isFinite(view.duration)&&view.duration>0;
  const activeTrack=subtitleTracks.find(t=>t.id===subtitleId);
  // Caption clock in media seconds: the player's own time for titles, broadcast time mapped into the program for channels.
  const captionTime=useMemo(()=>programs?()=>{const at=displayedUtc();return program&&at!==undefined?(program.mediaStartMs+at-program.start)/1000:NaN;}:()=>(ref.current?.currentTime??0)+shift,[programs,program?.id,program?.start,program?.mediaStartMs,shift]);
  const commit=()=>{if(scrub!==undefined){ref.current!.currentTime=scrub;setScrub(undefined);}};
  const hoverAt=(clientX:number,element:HTMLElement)=>{const box=element.getBoundingClientRect(),fraction=Math.max(0,Math.min(1,(clientX-box.left)/box.width));setHover({x:fraction*box.width,time:fraction*view.duration});};
  const videoInfo=[resolution(source),codec(source?.videoCodec)].filter(Boolean).join(' · ');
  return <aside ref={shell} className={`player ${docked?'docked':'immersive'} ${shown?'':'idle'}`} hidden={!url&&!tuning&&!loading} aria-label="Media player" onPointerMove={wake} onPointerDown={wake}>
    <video ref={ref} playsInline onClick={docked?onRestore:()=>{if(panel)setPanel(undefined);else toggle();}} onDoubleClick={docked?undefined:toggleFullscreen}/>
    {url&&subtitleId&&captions&&<Captions video={ref} cues={captions} time={captionTime} subtitleStyle={subtitleStyle} docked={docked} controls={shown&&!docked?{bottom:bottomRef,top:topRef}:undefined} forced={!!activeTrack?.forced} language={activeTrack?.language}/>}
    {(view.waiting||liveSwitching||tuning||loading)&&<span className="player-spinner spinner" role="status" aria-label={liveSwitching?'Switching to a backup feed':tuning?'Tuning channel':loading?'Starting':'Buffering'}/>}
    {docked?<>
      <div className="mini-controls">
        <button className="icon-button" onClick={toggle} aria-label={view.playing?'Pause':'Play'}><Icon name={view.playing?'pause':'play'} size={18}/></button>
        <button className="mini-title" onClick={onRestore}><strong>{title??'Now playing'}</strong>{subtitle&&<span>{subtitle}</span>}</button>
        <button className="icon-button" onClick={onRestore} aria-label="Expand player"><Icon name="expand" size={18}/></button>
        {known&&<span className="mini-progress"><span style={{width:`${view.time/view.duration*100}%`}}/></span>}
      </div>
      <button className="icon-button mini-close" onClick={onStop} aria-label="Stop playback" title="Stop playback"><Icon name="close" size={16}/></button>
    </>:<>
      <div className="player-top" ref={topRef}>
        <button className="player-round" onClick={onBack} aria-label="Back to browsing" title="Keep playing in a mini player"><Icon name="back" size={22}/></button>
        <div className="player-heading"><strong>{title??'Now playing'}</strong>{subtitle&&<span>{subtitle}</span>}</div>
        <button className="player-round" onClick={onStop} aria-label="Stop playback" title="Stop playback"><Icon name="close" size={20}/></button>
      </div>
      {flash&&<div key={flash.key} className="player-flash" aria-hidden="true"><span><Icon name={flash.icon} size={34}/></span>{flash.label&&<em>{flash.label}</em>}</div>}
      {ended&&next&&<UpNext item={next} countdown={countdown} countdownSeconds={countdownSeconds} onPlay={()=>pickQueued(queue!.index+1,'beginning')} onCancel={()=>setCountdown(undefined)}/>}
      {marker&&!(ended&&next)&&!panel&&<button key={`${marker.type}:${marker.startMs}`} className="player-skip" onClick={()=>skipMarker(marker)}>{marker.type==='intro'?'Skip Intro':'Skip Credits'}<Icon name="skip-next" size={18}/></button>}
      {!view.playing&&!view.waiting&&!liveSwitching&&!tuning&&!loading&&!(ended&&next)&&shifted?.state!=='EXPIRED'&&<button className="player-center" onClick={toggle} aria-label="Play"><Icon name="play" size={40}/></button>}
      {subtitleId&&subtitleStatus==='loading'&&<div className="player-status" role="status"><span className="spinner"/>Preparing subtitles…</div>}
      {switching&&<div className="player-status" role="status"><span className="spinner"/>{switching==='audio'?'Switching audio…':'Switching quality…'}</div>}
      {liveSwitching&&<div className="player-status" role="status"><span className="spinner"/>Switching to a backup feed…</div>}
      {nudge&&suggestion&&!switching&&<div className="player-status player-nudge" role="status">Buffering a lot? A lighter stream may play more smoothly.
        <button className="primary" onClick={()=>chooseQuality(suggestion)}>Switch to {qualityShort(suggestion)}</button>
        <button className="secondary" onClick={()=>{nudgeDismissed.current=true;setNudge(false);}}>Not now</button></div>}
      {shifted?.state==='EXPIRED'&&<div className="player-expired" role="alert"><strong>Buffer expired</strong><span>You were paused longer than this channel keeps, so that part is gone.</span><button className="primary" disabled={shiftBusy} onClick={goLive}>Go Live</button></div>}
      {subtitleId&&subtitleStatus==='failed'&&<div className="player-status warning" role="status">Subtitles couldn't be loaded for this track.</div>}
      {panel&&<div className={`player-panel ${panel}`} role="dialog" aria-label={panel==='subtitles'?'Subtitles':panel==='channels'?'Channels':panel==='queue'?'Playlist':'Playback settings'} onPointerDown={e=>e.stopPropagation()}>
        {panel==='queue'?queue&&<QueuePanel queue={queue} autoplay={autoplay} onAutoplay={chooseAutoplay} onPick={index=>{setPanel(undefined);pickQueued(index,prefs.startFrom);}}/>:panel==='channels'?channels:panel==='subtitles'?<>
          <PanelSection title="Subtitles"><div role="radiogroup" aria-label="Subtitle track" className="choices">
            <Choice selected={!subtitleId} onSelect={()=>chooseSubtitle(null)}>Off</Choice>
            {subtitleTracks.map(t=><Choice key={t.id} selected={t.id===subtitleId} disabled={!t.supported} onSelect={()=>chooseSubtitle(t.id)}
              detail={!t.supported?'Image-based, not supported yet':t.forced?'Forced':undefined}>{t.label}</Choice>)}
            {!subtitleTracks.length&&<p className="panel-empty">{programs?'This program has no subtitles.':'This title has no subtitles.'}</p>}
          </div></PanelSection>
          {!!subtitleTracks.length&&<PanelSection title="Size"><div className="segmented">{subtitleSizes.map(([value,label])=><button key={value} aria-pressed={subtitleStyle.size===value} onClick={()=>updateSubtitleStyle({size:value})}>{label}</button>)}</div><p className="panel-note">Font, colors, outline and position are in Settings › Playback.</p></PanelSection>}
        </>:<>
          {tracks&&tracks.audio.length>1&&onAudioChange&&<PanelSection title="Audio"><div role="radiogroup" aria-label="Audio track" className="choices">
            {tracks.audio.map(t=><Choice key={t.id} selected={t.id===audio?.id} disabled={!!switching} onSelect={()=>chooseAudio(t.id)}>{t.label}</Choice>)}
          </div></PanelSection>}
          {!live&&onQualityChange&&qualityOptions&&<PanelSection title="Quality"><QualityChoices options={qualityOptions} selected={quality} source={source} disabled={!!switching} onSelect={chooseQuality}/></PanelSection>}
          {live&&onFeed&&feeds&&feeds.length>1&&<PanelSection title="Feed"><div role="radiogroup" aria-label="Channel feed" className="choices">
            {feeds.map(f=><Choice key={f.id} selected={f.id===feed} detail={f.quality} onSelect={()=>{if(f.id!==feed)onFeed(f.id);}}>{f.label}</Choice>)}
          </div></PanelSection>}
          {!live&&<PanelSection title="Playback speed"><div className="segmented">{speeds.map(value=><button key={value} aria-pressed={rate===value} onClick={()=>setRate(value)}>{value===1?'Normal':`${value}×`}</button>)}</div></PanelSection>}
          {!live&&<section className="panel-section">
            <label className="panel-switch">Skip intros automatically<input type="checkbox" role="switch" checked={prefs.skipIntros} onChange={e=>updatePlayerPreferences({skipIntros:e.target.checked})}/></label>
            <label className="panel-switch">Skip credits automatically<input type="checkbox" role="switch" checked={prefs.skipCredits} onChange={e=>updatePlayerPreferences({skipCredits:e.target.checked})}/></label>
          </section>}
          <PanelSection title="Stream">
            <dl className="stream-info">
              <div><dt>Mode</dt><dd>{deliveryLabel[delivery]}<small>{(live&&liveDetail[delivery])||deliveryDetail[delivery]}</small></dd></div>
              {videoInfo&&<div><dt>Video</dt><dd>{videoInfo}</dd></div>}
              {!live&&quality!=='auto'&&<div><dt>Quality</dt><dd>{qualityLabel(quality)}{tierOf(quality)&&<small>Converted, up to {mbps(tierOf(quality)!.bitrateKbps)}</small>}</dd></div>}
              {audio&&<div><dt>Audio</dt><dd>{audio.label}</dd></div>}
            </dl>
          </PanelSection>
        </>}
      </div>}
      <div className="player-bottom" ref={bottomRef}>
        {known&&<div className="scrubber" style={{'--played':`${position/view.duration*100}%`,'--buffered':`${view.buffered/view.duration*100}%`} as CSSProperties}
          onPointerMove={e=>hoverAt(e.clientX,e.currentTarget)} onPointerLeave={()=>setHover(undefined)}>
          {(hover||scrub!==undefined)&&<span className="scrub-tip" style={{left:scrub!==undefined?`${scrub/view.duration*100}%`:hover!.x}}>{timecode(scrub??hover!.time)}</span>}
          <input type="range" aria-label="Seek" min={0} max={view.duration} step={1} value={position} aria-valuetext={`${timecode(position)} of ${timecode(view.duration)}`}
            onChange={e=>setScrub(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit}/>
        </div>}
        <div className="player-bar">
          <button className="icon-button play-button" onClick={toggle} aria-label={view.playing?'Pause':'Play'} title={view.playing?'Pause (k)':'Play (k)'}><Icon name={view.playing?'pause':'play'} size={28}/></button>
          {queue&&<><button className="icon-button" disabled={!previous} onClick={()=>pickQueued(queue.index-1,'beginning')} aria-label="Previous" title={previous?`Previous: ${queueLabel(previous)} (Shift+P)`:'Previous'}><Icon name="skip-back" size={24}/></button>
          <button className="icon-button" disabled={!next} onClick={()=>pickQueued(queue.index+1,'beginning')} aria-label="Next" title={next?`Next: ${queueLabel(next)} (Shift+N)`:'Next'}><Icon name="skip-next" size={24}/></button></>}
          {live&&onChannel&&<><button className="icon-button" onClick={()=>onChannel(-1)} aria-label="Previous channel" title="Previous channel (Page Down)"><Icon name="back" size={24}/></button>
          <button className="icon-button channel-next" onClick={()=>onChannel(1)} aria-label="Next channel" title="Next channel (Page Up)"><Icon name="back" size={24}/></button></>}
          {!live&&<><button className="icon-button" onClick={()=>seek(-10)} aria-label="Back 10 seconds" title="Back 10 seconds (j)"><Icon name="rewind" size={26}/></button>
          <button className="icon-button" onClick={()=>seek(10)} aria-label="Forward 10 seconds" title="Forward 10 seconds (l)"><Icon name="forward" size={26}/></button></>}
          <div className="volume"><button className="icon-button" onClick={()=>{ref.current!.muted=!view.muted;}} aria-label={view.muted?'Unmute':'Mute'} title={view.muted?'Unmute (m)':'Mute (m)'}><Icon name={view.muted||view.volume===0?'mute':'volume'} size={24}/></button>
            <input type="range" aria-label="Volume" min={0} max={1} step={.05} value={view.muted?0:view.volume} style={{'--level':`${(view.muted?0:view.volume)*100}%`} as CSSProperties} onChange={e=>{const video=ref.current!;video.volume=Number(e.target.value);video.muted=video.volume===0;}}/></div>
          {live&&behind?<button className="player-live behind" onClick={goLive} disabled={shiftBusy||shifted.state==='EXPIRED'} title="Jump to what's on now">{shifted.state==='PAUSED'?'Paused':'Behind'} · −{timecode(shifted.behindLiveMs/1000)}<strong>Go Live</strong></button>:live?<span className="player-live"><i aria-hidden="true"/>LIVE</span>:<button className="player-time" onClick={()=>setRemaining(r=>!r)} title="Show elapsed or remaining time">
            {remaining&&known?`−${timecode(view.duration-position)}`:timecode(position)}{known&&<span> / {timecode(view.duration)}</span>}
          </button>}
          <span className="grow"/>
          {live&&onFeed&&feeds&&feeds.length>1&&<button className="player-chip" onClick={()=>setPanel(p=>p==='settings'?undefined:'settings')} aria-label={`Change feed · ${feeds.length} available`} title="Change feed">{feeds.find(f=>f.id===feed)?.quality??'Feed'} · {feeds.length}</button>}
          {!live&&quality!=='auto'&&<button className="player-chip" onClick={()=>setPanel(p=>p==='settings'?undefined:'settings')} aria-label={`Quality · ${qualityShort(quality)}`}>{qualityShort(quality)}</button>}
          {rate!==1&&<button className="player-chip" onClick={()=>setPanel(p=>p==='settings'?undefined:'settings')}>{rate}×</button>}
          {live&&channels&&<button className="icon-button" onClick={()=>setPanel(p=>p==='channels'?undefined:'channels')} aria-label="Browse channels" aria-expanded={panel==='channels'} title="Browse channels (g)"><Icon name="grid" size={24}/></button>}
          {queue&&<button className="icon-button" onClick={()=>setPanel(p=>p==='queue'?undefined:'queue')} aria-label="Playlist" aria-expanded={panel==='queue'} title="Playlist"><Icon name="queue" size={24}/></button>}
          {(!live||programs)&&<button className={`icon-button ${subtitleId?'active':''}`} onClick={()=>setPanel(p=>p==='subtitles'?undefined:'subtitles')} aria-label="Subtitles" aria-expanded={panel==='subtitles'} title="Subtitles (c)"><Icon name="captions" size={24}/></button>}
          <button className="icon-button" onClick={()=>setPanel(p=>p==='settings'?undefined:'settings')} aria-label="Playback settings" aria-expanded={panel==='settings'} title="Settings"><Icon name="gear" size={24}/></button>
          <button className="icon-button" onClick={toggleFullscreen} aria-label={fullscreen?'Exit full screen':'Full screen'} title={fullscreen?'Exit full screen (f)':'Full screen (f)'}><Icon name={fullscreen?'minimize':'fullscreen'} size={24}/></button>
        </div>
      </div>
    </>}
  </aside>;
});
// Draws the cues active at the media time (from `time`) over the picture, above the controls while they show.
function Captions({video,cues,time,subtitleStyle,docked,controls,forced,language}:{video:RefObject<HTMLVideoElement|null>;cues:Caption[];time:()=>number;subtitleStyle:SubtitleStyle;docked:boolean;controls?:{bottom:RefObject<HTMLDivElement|null>;top:RefObject<HTMLDivElement|null>};forced:boolean;language?:string}) {
  const [active,setActive]=useState<number[]>([]),[box,setBox]=useState({height:0,inset:0});
  useEffect(()=>{
    const element=video.current;if(!element)return;let frame=0,key='';
    const update=()=>{const next=activeCaptions(cues,time()),nextKey=next.join(',');if(nextKey!==key){key=nextKey;setActive(next);}};
    const loop=()=>{update();frame=requestAnimationFrame(loop);};
    const measure=()=>{
      const {clientWidth:w,clientHeight:h,videoWidth:vw,videoHeight:vh}=element;
      const picture=vw&&vh?Math.min(h,w*vh/vw):h;setBox({height:picture,inset:Math.max(0,(h-picture)/2)});
    };
    const observer=new ResizeObserver(measure);observer.observe(element);
    const events=['seeked','timeupdate','loadedmetadata','resize'] as const;
    for(const name of events)element.addEventListener(name,name==='loadedmetadata'||name==='resize'?measure:update);
    measure();update();loop();
    return()=>{cancelAnimationFrame(frame);observer.disconnect();for(const name of events)element.removeEventListener(name,name==='loadedmetadata'||name==='resize'?measure:update);};
  },[video,cues,time]);
  // The mini player keeps a fixed small size at the bottom; elsewhere cues clear whichever controls are on their side.
  const fontSize=docked?Math.max(11,box.height*.05):subtitleFontSize(subtitleStyle,box.height);
  const top=!docked&&(subtitleStyle.anchor==='top'||forced&&subtitleStyle.forcedTop),bar=controls&&(top?controls.top:controls.bottom).current;
  const offset=Math.max(box.inset+box.height*(docked?5:subtitleStyle.position)/100,bar?bar.offsetHeight+8:0);
  return <div className="player-captions" lang={language} style={{...captionBox(subtitleStyle),...(top?{top:offset}:{bottom:offset}),fontSize}} aria-hidden="true">
    {active.map(i=><CaptionCue key={i} lines={cues[i]!.lines} style={subtitleStyle}/>)}
  </div>;
}
// Conversions the source already fits within would only replay the original, so they are left out;
// when no conversion is possible for one reason, that reason shows once instead of on every row.
function QualityChoices({options,selected,source,disabled,onSelect}:{options:QualityOption[];selected:Quality;source?:SourceInfo;disabled:boolean;onSelect:(q:Quality)=>void}) {
  const fixed=options.filter(o=>!tierOf(o.quality)),tiers=options.filter(o=>tierOf(o.quality)&&(!o.available||o.route==='cpu'));
  const blocked=tiers.length>0&&tiers.every(o=>!o.available&&o.reason===tiers[0]!.reason)?tiers[0]!.reason:undefined;
  const original=[source?.bitrateKbps&&mbps(source.bitrateKbps),resolution(source)].filter(Boolean).join(' · ');
  return <div role="radiogroup" aria-label="Quality" className="choices">
    {fixed.map(o=><Choice key={o.quality} selected={o.quality===selected} disabled={!o.available||disabled} onSelect={()=>onSelect(o.quality)}
      detail={!o.available?o.reason:o.quality==='original'?original||routeDetail(o):routeDetail(o)}>{o.quality==='original'?'Play original quality':'Auto'}</Choice>)}
    {blocked?<p className="panel-empty">Converting: {blocked}</p>:tiers.map(o=><Choice key={o.quality} selected={o.quality===selected} disabled={!o.available||disabled} onSelect={()=>onSelect(o.quality)}
      detail={o.available?mbps(tierOf(o.quality)!.bitrateKbps):o.reason}>Convert to {qualityLabel(o.quality)}</Choice>)}
  </div>;
}
// The queue as a list, with the playing title marked and scrolled into view, and the Autoplay switch.
function QueuePanel({queue,autoplay,onAutoplay,onPick}:{queue:QueueState;autoplay:boolean;onAutoplay:(on:boolean)=>void;onPick:(index:number)=>void}) {
  const current=useRef<HTMLButtonElement>(null);
  // The show's name only helps when the queue spans several shows or movies.
  const mixed=new Set(queue.items.map(i=>i.type==='episode'?i.showId:i.id)).size>1;
  useEffect(()=>{current.current?.scrollIntoView({block:'center'});},[]);
  return <>
    <div className="queue-head"><div><h4>Playlist</h4><strong>{queue.title}</strong><small>{queue.index+1} of {queue.items.length}</small></div>
      <label className="queue-autoplay"><span>Autoplay</span><input type="checkbox" role="switch" checked={autoplay} onChange={e=>onAutoplay(e.target.checked)}/></label></div>
    <ol className="queue-list">{queue.items.map((item,i)=>{const art=queueArt(item),detail=[mixed?queueDetail(item):undefined,item.durationMs?duration(item.durationMs):undefined,item.watched&&i!==queue.index?'Watched':undefined].filter(Boolean).join(' · ');
      return <li key={`${item.id}-${i}`}><button ref={i===queue.index?current:undefined} className={`queue-item${item.type==='episode'?' wide':''}`} aria-current={i===queue.index?'true':undefined} onClick={()=>{if(i!==queue.index)onPick(i);}}>
        <span className="queue-art">{art&&<img src={art} alt="" loading="lazy" decoding="async" onError={e=>{e.currentTarget.hidden=true;}}/>}{i===queue.index&&<span className="queue-playing"><Icon name="play" size={16}/></span>}</span>
        <span className="queue-text"><strong>{queueLabel(item)}</strong>{detail&&<small>{detail}</small>}</span>
      </button></li>;})}</ol>
  </>;
}
// The next title's art when one ends, with the Autoplay countdown on Play Now.
function UpNext({item,countdown,countdownSeconds,onPlay,onCancel}:{item:CatalogItem;countdown?:number;countdownSeconds:number;onPlay:()=>void;onCancel:()=>void}) {
  const art=queueArt(item),detail=queueDetail(item);
  return <div className={`up-next${item.type==='episode'?' wide':''}`} role="dialog" aria-label="Up next" onClick={e=>e.stopPropagation()} onPointerDown={e=>e.stopPropagation()}>
    <span className="up-next-art">{art&&<img src={art} alt="" decoding="async" onError={e=>{e.currentTarget.hidden=true;}}/>}</span>
    <div className="up-next-text">
      <span className="up-next-eyebrow">Up next</span>
      <strong>{queueLabel(item)}</strong>{detail&&<span>{detail}</span>}
      <div className="up-next-actions">
        <button className={`primary up-next-play${countdown!==undefined?' counting':''}`} style={{'--countdown':`${countdownSeconds}s`} as CSSProperties} onClick={onPlay} autoFocus><Icon name="play" size={18}/>{countdown!==undefined?`Playing in ${countdown}`:'Play now'}</button>
        {countdown!==undefined&&<button className="secondary" onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  </div>;
}
const PanelSection=({title,children}:{title:string;children:ReactNode})=><section className="panel-section"><h4>{title}</h4>{children}</section>;
const Choice=({selected,disabled,detail,onSelect,children}:{selected:boolean;disabled?:boolean;detail?:string;onSelect:()=>void;children:ReactNode})=>
  <button className="choice" role="radio" aria-checked={selected} disabled={disabled} onClick={onSelect}><span className="choice-check">{selected&&<Icon name="check" size={16}/>}</span><span className="choice-label">{children}{detail&&<small>{detail}</small>}</span></button>;
export function browserCapabilities() {
  const video=document.createElement('video');
  const videoCodecs=[['h264:8','video/mp4; codecs="avc1.640028"'],['hevc:8','video/mp4; codecs="hvc1.1.6.L120.B0"'],['hevc:10','video/mp4; codecs="hvc1.2.4.L153.B0"']].filter(([,mime])=>!!video.canPlayType(mime!)).map(([codec])=>codec!);
  const audioCodecs=[['aac','audio/mp4; codecs="mp4a.40.2"'],['mp3','audio/mpeg']].filter(([,mime])=>!!video.canPlayType(mime!)).map(([codec])=>codec!);
  return {videoCodecs,audioCodecs,containers:['mp4',...(!!window.MediaSource||video.canPlayType('application/vnd.apple.mpegurl')?['hls']:[])]};
}
