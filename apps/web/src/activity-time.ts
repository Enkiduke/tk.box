import {useEffect,useState} from 'react';

export const ACTIVITY_REFRESH_MS=5000;

export type ActivityTiming={state:'playing'|'paused'|'buffering';positionMs?:number;durationMs?:number};

export function useActivityClock(active:boolean) {
  const [now,setNow]=useState(Date.now);
  useEffect(()=>{
    if(!active)return;
    const tick=()=>setNow(Date.now());
    tick();
    const timer=window.setInterval(tick,1000);
    return()=>window.clearInterval(timer);
  },[active]);
  return now;
}

// Estimate up to the next expected refresh. If polling fails, stale playback stops advancing.
export function activityElapsed(now:number,receivedAt:number) {
  return Math.max(0,Math.min(ACTIVITY_REFRESH_MS,now-receivedAt));
}

export function activityPosition({positionMs,durationMs,state}:ActivityTiming,elapsedMs:number) {
  if(positionMs===undefined||!durationMs)return;
  const position=Math.max(0,Math.min(durationMs,positionMs+(state==='playing'?elapsedMs:0)));
  return {progress:position/durationMs,time:`${formatActivityTime(position)} / ${formatActivityTime(durationMs)}`};
}

export function formatActivityTime(ms:number) {
  const seconds=Math.max(0,Math.floor(ms/1000)),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds/60)%60;
  const remainder=String(seconds%60).padStart(2,'0');
  return hours?`${hours}:${String(minutes).padStart(2,'0')}:${remainder}`:`${minutes}:${remainder}`;
}
