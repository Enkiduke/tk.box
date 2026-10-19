import {useSyncExternalStore,type CSSProperties} from 'react';
import type {CaptionSpan} from './captions.js';
import {readPreference} from './storage.js';

// How subtitles look, chosen per browser in Settings › Playback and from the player's subtitle panel.
export const subtitleSizes=[['s','Small'],['m','Medium'],['l','Large'],['xl','Larger']] as const;
export const subtitleFonts=[['sans','Sans serif'],['serif','Serif'],['mono','Monospace'],['casual','Casual'],['smallcaps','Small caps']] as const;
export const subtitleEdges=[['none','None'],['outline','Outline'],['shadow','Drop shadow'],['raised','Raised'],['depressed','Depressed'],['glow','Glow']] as const;
export const subtitleColors=[['#ffffff','White'],['#ffe14d','Yellow'],['#4de8ff','Cyan'],['#7dff6b','Green'],['#ff7de9','Magenta'],['#ff6b6b','Red'],['#6b9bff','Blue'],['#000000','Black']] as const;
export type SubtitleSize=typeof subtitleSizes[number][0];
export type SubtitleFont=typeof subtitleFonts[number][0];
export type SubtitleEdge=typeof subtitleEdges[number][0];
export type SubtitleStyle={
  size:SubtitleSize;font:SubtitleFont;bold:boolean;color:string;textOpacity:number;
  edge:SubtitleEdge;edgeColor:string;background:string;backgroundOpacity:number;backgroundShape:'line'|'block';
  // Distance of the lowest line above the bottom of the picture, in percent of its height.
  position:number;
};
export const defaultSubtitleStyle:SubtitleStyle={size:'m',font:'sans',bold:false,color:'#ffffff',textOpacity:100,edge:'shadow',edgeColor:'#000000',background:'#000000',backgroundOpacity:60,backgroundShape:'line',position:5};
export const subtitlePresets:[string,Partial<SubtitleStyle>][]=[
  ['Default',{}],
  ['Outline',{edge:'outline',backgroundOpacity:0}],
  ['Classic yellow',{color:'#ffe14d',edge:'outline',backgroundOpacity:0}],
  ['High contrast',{bold:true,edge:'none',backgroundOpacity:100}],
  ['Cinema',{edge:'shadow',backgroundOpacity:0}],
  ['Soft box',{edge:'none',backgroundOpacity:45,backgroundShape:'block'}],
];
export const positionRange=[0,30] as const;

const hex=/^#[0-9a-f]{6}$/i;
const oneOf=<T extends string>(options:readonly (readonly [T,string])[],value:unknown,fallback:T)=>options.some(([id])=>id===value)?value as T:fallback;
const percent=(value:unknown,fallback:number,[min,max]:readonly [number,number]=[0,100])=>typeof value==='number'&&Number.isFinite(value)?Math.min(max,Math.max(min,Math.round(value))):fallback;
const color=(value:unknown,fallback:string)=>typeof value==='string'&&hex.test(value)?value.toLowerCase():fallback;
// Anything missing or invalid falls back to the default, field by field; `legacySize` is the player's older size-only preference.
export function parseSubtitleStyle(raw:string|null,legacySize?:string|null):SubtitleStyle {
  let saved:Record<string,unknown>={};
  try {const value:unknown=raw?JSON.parse(raw):{};if(value&&typeof value==='object'&&!Array.isArray(value))saved=value as Record<string,unknown>;} catch {/* keep defaults */}
  const d=defaultSubtitleStyle;
  return {
    size:oneOf(subtitleSizes,saved.size??legacySize,d.size),font:oneOf(subtitleFonts,saved.font,d.font),bold:typeof saved.bold==='boolean'?saved.bold:d.bold,
    color:color(saved.color,d.color),textOpacity:percent(saved.textOpacity,d.textOpacity,[20,100]),
    edge:oneOf(subtitleEdges,saved.edge,d.edge),edgeColor:color(saved.edgeColor,d.edgeColor),
    background:color(saved.background,d.background),backgroundOpacity:percent(saved.backgroundOpacity,d.backgroundOpacity),
    backgroundShape:saved.backgroundShape==='block'?'block':'line',position:percent(saved.position,d.position,positionRange),
  };
}

export const rgba=(value:string,opacity:number)=>`rgba(${parseInt(value.slice(1,3),16)},${parseInt(value.slice(3,5),16)},${parseInt(value.slice(5,7),16)},${+(opacity/100).toFixed(2)})`;
const fontFamily:Record<SubtitleFont,string|undefined>={sans:undefined,smallcaps:undefined,serif:'Georgia,"Times New Roman",serif',mono:'"Cascadia Mono",Consolas,"Courier New",monospace',casual:'"Comic Sans MS","Comic Neue","Segoe Print",cursive'};
// A ring of hard shadows reads as an even stroke around the glyphs without eating into them like text-stroke.
const outline=(c:string,width:number)=>Array.from({length:16},(_,i)=>{const a=i*Math.PI/8;return `${(Math.cos(a)*width).toFixed(3)}em ${(Math.sin(a)*width).toFixed(3)}em 0 ${c}`;}).join(',');
export function edgeShadow(edge:SubtitleEdge,c:string) {
  switch(edge) {
    case 'none':return undefined;
    case 'outline':return outline(c,.055);
    case 'shadow':return `.05em .06em .1em ${c},0 0 .2em ${rgba(c,50)}`;
    case 'raised':return `.025em .025em 0 ${c},.05em .05em 0 ${c}`;
    case 'depressed':return `-.035em -.035em 0 ${c},.03em .03em 0 rgba(255,255,255,.35)`;
    case 'glow':return `0 0 .1em ${c},0 0 .2em ${c},0 0 .35em ${c}`;
  }
}
// Font size as a share of the picture height, with a floor in pixels.
export const subtitleScale:Record<SubtitleSize,[number,number]>={s:[.036,14],m:[.046,16],l:[.058,19],xl:[.072,22]};

// One cue, drawn the way the viewer's style asks. The parent sets font-size.
export function CaptionCue({lines,style}:{lines:CaptionSpan[][];style:SubtitleStyle}) {
  const fill=style.backgroundOpacity?rgba(style.background,style.backgroundOpacity):'transparent',block=style.backgroundShape==='block';
  const text:CSSProperties={color:rgba(style.color,style.textOpacity),fontFamily:fontFamily[style.font],fontVariant:style.font==='smallcaps'?'small-caps':undefined,fontWeight:style.bold?700:500,textShadow:edgeShadow(style.edge,style.edgeColor)};
  return <div className="caption" style={{...text,...(block?{background:fill,padding:'.15em .5em',borderRadius:'.15em'}:{})}}>{lines.map((line,n)=><span key={n} className="caption-line" style={block?undefined:{background:fill}}>{line.map((span,m)=>
    <span key={m} style={{fontStyle:span.i?'italic':undefined,fontWeight:span.b?800:undefined,textDecoration:span.u?'underline':undefined}}>{span.text}</span>)}</span>)}</div>;
}

const key='tk.box.player.subtitleStyle',listeners=new Set<()=>void>();
let current:SubtitleStyle|undefined;
const load=()=>{try{return parseSubtitleStyle(localStorage.getItem(key),readPreference(localStorage,'tk.box.player.subtitleSize'));}catch{return defaultSubtitleStyle;}};
export const getSubtitleStyle=()=>current??=load();
export function setSubtitleStyle(next:SubtitleStyle) {
  current=next;
  try{localStorage.setItem(key,JSON.stringify(next));}catch{/* storage unavailable; applies until reload */}
  for(const listener of listeners)listener();
}
export const updateSubtitleStyle=(patch:Partial<SubtitleStyle>)=>setSubtitleStyle({...getSubtitleStyle(),...patch});
function subscribe(listener:()=>void) {
  // Another tab changing the style updates this one too.
  const onStorage=(e:StorageEvent)=>{if(e.key===key){current=undefined;listener();}};
  listeners.add(listener);window.addEventListener('storage',onStorage);
  return()=>{listeners.delete(listener);window.removeEventListener('storage',onStorage);};
}
export const useSubtitleStyle=()=>useSyncExternalStore(subscribe,getSubtitleStyle);
