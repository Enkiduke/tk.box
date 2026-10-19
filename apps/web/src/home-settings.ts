import {useSyncExternalStore} from 'react';

// How the Home page looks in this browser. Per browser, like the subtitle style, so every viewer sets their own.
export type HomeSettings={liveRow:boolean;liveCount:number;liveShuffle:boolean;liveScroll:boolean;liveSpeed:'slow'|'normal'|'fast'};
export const defaultHomeSettings:HomeSettings={liveRow:true,liveCount:24,liveShuffle:true,liveScroll:true,liveSpeed:'slow'};
// The guide serves at most 60 channels a page.
export const liveCounts=[12,24,36,48,60] as const;
export const liveSpeeds=[['slow','Slow'],['normal','Normal'],['fast','Fast']] as const;
// Pixels per second the Live TV row drifts at.
export const liveSpeedPx:Record<HomeSettings['liveSpeed'],number>={slow:18,normal:32,fast:55};

export function parseHomeSettings(raw:string|null):HomeSettings {
  let value:Partial<Record<keyof HomeSettings,unknown>>={};
  try{const parsed=raw?JSON.parse(raw):{};if(parsed&&typeof parsed==='object')value=parsed;}catch{/* fall back to defaults */}
  const flag=(k:'liveRow'|'liveShuffle'|'liveScroll')=>typeof value[k]==='boolean'?value[k] as boolean:defaultHomeSettings[k];
  return {liveRow:flag('liveRow'),liveShuffle:flag('liveShuffle'),liveScroll:flag('liveScroll'),
    liveCount:liveCounts.includes(value.liveCount as never)?value.liveCount as number:defaultHomeSettings.liveCount,
    liveSpeed:liveSpeeds.some(([id])=>id===value.liveSpeed)?value.liveSpeed as HomeSettings['liveSpeed']:defaultHomeSettings.liveSpeed};
}

const key='tk.box.home',listeners=new Set<()=>void>();
let current:HomeSettings|undefined;
const load=()=>{try{return parseHomeSettings(localStorage.getItem(key));}catch{return defaultHomeSettings;}};
export const getHomeSettings=()=>current??=load();
export function setHomeSettings(next:HomeSettings) {
  current=next;
  try{localStorage.setItem(key,JSON.stringify(next));}catch{/* storage unavailable; applies until reload */}
  for(const listener of listeners)listener();
}
export const updateHomeSettings=(patch:Partial<HomeSettings>)=>setHomeSettings({...getHomeSettings(),...patch});
function subscribe(listener:()=>void) {
  const onStorage=(e:StorageEvent)=>{if(e.key===key){current=undefined;listener();}};
  listeners.add(listener);window.addEventListener('storage',onStorage);
  return()=>{listeners.delete(listener);window.removeEventListener('storage',onStorage);};
}
export const useHomeSettings=()=>useSyncExternalStore(subscribe,getHomeSettings);
