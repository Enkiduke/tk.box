import {useSyncExternalStore} from 'react';

// How the Home page looks in this browser. Per browser, like the subtitle style, so every viewer sets their own.
type Speed='slow'|'normal'|'fast';
export type HomeSettings={liveRow:boolean;liveCount:number;liveShuffle:boolean;liveScroll:boolean;liveSpeed:Speed;
  collectionRows:boolean;collectionShuffle:boolean;collectionScroll:boolean;collectionSpeed:Speed};
export const defaultHomeSettings:HomeSettings={liveRow:true,liveCount:24,liveShuffle:true,liveScroll:true,liveSpeed:'slow',
  collectionRows:true,collectionShuffle:true,collectionScroll:true,collectionSpeed:'normal'};
// The guide serves at most 60 channels a page.
export const liveCounts=[12,24,36,48,60] as const;
export const liveSpeeds=[['slow','Slow'],['normal','Normal'],['fast','Fast']] as const;
// Pixels per second a drifting Home row moves at.
export const liveSpeedPx:Record<Speed,number>={slow:18,normal:32,fast:55};

export function parseHomeSettings(raw:string|null):HomeSettings {
  let value:Partial<Record<keyof HomeSettings,unknown>>={};
  try{const parsed=raw?JSON.parse(raw):{};if(parsed&&typeof parsed==='object')value=parsed;}catch{/* fall back to defaults */}
  const flag=(k:'liveRow'|'liveShuffle'|'liveScroll'|'collectionRows'|'collectionShuffle'|'collectionScroll')=>typeof value[k]==='boolean'?value[k] as boolean:defaultHomeSettings[k];
  const speed=(k:'liveSpeed'|'collectionSpeed')=>liveSpeeds.some(([id])=>id===value[k])?value[k] as Speed:defaultHomeSettings[k];
  return {liveRow:flag('liveRow'),liveShuffle:flag('liveShuffle'),liveScroll:flag('liveScroll'),
    liveCount:liveCounts.includes(value.liveCount as never)?value.liveCount as number:defaultHomeSettings.liveCount,liveSpeed:speed('liveSpeed'),
    collectionRows:flag('collectionRows'),collectionShuffle:flag('collectionShuffle'),collectionScroll:flag('collectionScroll'),collectionSpeed:speed('collectionSpeed')};
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
