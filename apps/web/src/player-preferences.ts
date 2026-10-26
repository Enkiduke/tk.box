import {useSyncExternalStore} from 'react';
import {languageKey,quality as qualitySchema,type Quality} from '../../../packages/contracts/src/index.js';
import {readPreference} from './storage.js';

// How titles start and what plays next, chosen per browser in Settings › Playback and from the player.
export type SubtitleMode='plex'|'always'|'forced'|'off';
export type StartFrom='resume'|'beginning';
export type PlayerPreferences={
  autoplay:boolean;countdownSeconds:number;skipIntros:boolean;skipCredits:boolean;
  // `subtitleLanguage` and `audioLanguage` are `languageKey` codes; null leaves the choice to Plex.
  subtitleMode:SubtitleMode;subtitleLanguage:string|null;audioLanguage:string|null;
  quality:Quality;startFrom:StartFrom;
};
export const countdownChoices=[5,10,15,30] as const;
export const subtitleModes=[['plex','Plex default'],['always','Always on'],['forced','Forced only'],['off','Off']] as const;
export const defaultPlayerPreferences:PlayerPreferences={autoplay:true,countdownSeconds:10,skipIntros:false,skipCredits:false,subtitleMode:'plex',subtitleLanguage:null,audioLanguage:null,quality:'auto',startFrom:'resume'};
// What the player saved before these settings existed, each under its own key.
export type LegacyPreferences={autoplay?:string|null;autoskip?:string|null;subtitles?:string|null};

const language=(value:unknown)=>typeof value==='string'&&/^[a-z]{2,3}$/i.test(value.trim())?languageKey(value):null;
function legacy({autoplay,autoskip,subtitles}:LegacyPreferences):Partial<PlayerPreferences> {
  // The old subtitle preference was the last picked track's language, 'off', or '' for a track with no language.
  const subtitleLanguage=language(subtitles);
  return {autoplay:autoplay!=='off',skipIntros:autoskip==='on',skipCredits:autoskip==='on',
    ...(subtitles==='off'?{subtitleMode:'off'}:subtitleLanguage?{subtitleMode:'always',subtitleLanguage}:{})};
}
// Anything missing or invalid falls back to the default, field by field. The legacy keys apply only before the first save.
export function parsePlayerPreferences(raw:string|null,old:LegacyPreferences={}):PlayerPreferences {
  let saved:Record<string,unknown>={};
  if(raw===null)saved=legacy(old);
  else try {const value:unknown=JSON.parse(raw);if(value&&typeof value==='object'&&!Array.isArray(value))saved=value as Record<string,unknown>;} catch {/* keep defaults */}
  const d=defaultPlayerPreferences,bool=(value:unknown,fallback:boolean)=>typeof value==='boolean'?value:fallback;
  return {
    autoplay:bool(saved.autoplay,d.autoplay),countdownSeconds:countdownChoices.find(c=>c===saved.countdownSeconds)??d.countdownSeconds,
    skipIntros:bool(saved.skipIntros,d.skipIntros),skipCredits:bool(saved.skipCredits,d.skipCredits),
    subtitleMode:subtitleModes.find(([id])=>id===saved.subtitleMode)?.[0]??d.subtitleMode,subtitleLanguage:language(saved.subtitleLanguage),audioLanguage:language(saved.audioLanguage),
    quality:qualitySchema.safeParse(saved.quality).data??d.quality,startFrom:saved.startFrom==='beginning'?'beginning':'resume',
  };
}

type Track={id:string;language?:string;forced:boolean;selected:boolean;supported:boolean};
// The subtitle a title starts with. A preferred language with no matching track starts with none,
// except that Forced only also takes a forced track with no language tag.
export function pickSubtitle(tracks:Track[],prefs:Pick<PlayerPreferences,'subtitleMode'|'subtitleLanguage'>):string|null {
  const usable=tracks.filter(t=>t.supported),wanted=prefs.subtitleLanguage,same=(t:Track)=>!!wanted&&languageKey(t.language)===wanted;
  const pick=(()=>{switch(prefs.subtitleMode) {
    case 'off':return undefined;
    case 'plex':return usable.find(t=>t.selected);
    case 'always':return wanted?usable.find(t=>same(t)&&!t.forced)??usable.find(same):usable.find(t=>t.selected&&!t.forced)??usable.find(t=>!t.forced);
    case 'forced':{const forced=usable.filter(t=>t.forced);return wanted?forced.find(same)??forced.find(t=>!t.language):forced.find(t=>t.selected)??forced[0];}
  }})();
  return pick?.id??null;
}
// Picking a subtitle in the player becomes the preference for the next title, as it always has.
export const subtitleChoice=(track?:{language?:string;forced:boolean}):Partial<PlayerPreferences>=>
  track?{subtitleMode:track.forced?'forced':'always',subtitleLanguage:language(track.language)}:{subtitleMode:'off'};

const key='tk.box.player.preferences',listeners=new Set<()=>void>();
let current:PlayerPreferences|undefined;
const load=()=>{try{
  const old=(name:string)=>readPreference(localStorage,`tk.box.player.${name}`);
  return parsePlayerPreferences(localStorage.getItem(key),{autoplay:old('autoplay'),autoskip:old('autoskip'),subtitles:old('subtitles')});
}catch{return defaultPlayerPreferences;}};
export const getPlayerPreferences=()=>current??=load();
export function updatePlayerPreferences(patch:Partial<PlayerPreferences>) {
  current={...getPlayerPreferences(),...patch};
  try{localStorage.setItem(key,JSON.stringify(current));}catch{/* storage unavailable; applies until reload */}
  for(const listener of listeners)listener();
}
function subscribe(listener:()=>void) {
  // Another tab changing a preference updates this one too.
  const onStorage=(e:StorageEvent)=>{if(e.key===key){current=undefined;listener();}};
  listeners.add(listener);window.addEventListener('storage',onStorage);
  return()=>{listeners.delete(listener);window.removeEventListener('storage',onStorage);};
}
export const usePlayerPreferences=()=>useSyncExternalStore(subscribe,getPlayerPreferences);
