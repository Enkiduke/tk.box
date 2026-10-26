import {useSyncExternalStore,type CSSProperties} from 'react';
import type {CaptionSpan} from './captions.js';
import {readPreference} from './storage.js';

// How subtitles look, chosen per browser in Settings › Playback (and its subtitle studio) and from the player's subtitle panel.
export const subtitleSizes=[['s','Small'],['m','Medium'],['l','Large'],['xl','Larger']] as const;
export const subtitleFonts=[['sans','Sans serif'],['serif','Serif'],['mono','Monospace'],['casual','Casual'],['smallcaps','Small caps'],['condensed','Condensed']] as const;
export const subtitleColors=[['#ffffff','White'],['#ffe14d','Yellow'],['#4de8ff','Cyan'],['#7dff6b','Green'],['#ff7de9','Magenta'],['#ff6b6b','Red'],['#6b9bff','Blue'],['#000000','Black']] as const;
// Every effect is always there, on or off, and they draw in this order with the first on top. A stroke is a real
// outline of the glyphs; the others are text shadows.
export const effectKinds=[['outline','Outline'],['stroke','Stroke'],['emboss','Emboss'],['shadow','Drop shadow'],['extrude','3D extrude'],['glow','Glow']] as const;
export type SubtitleSize=typeof subtitleSizes[number][0];
export type SubtitleFont=typeof subtitleFonts[number][0];
export type EffectKind=typeof effectKinds[number][0];
// Lengths are hundredths of an em, so they grow with the text; opacity is percent; the angle is in degrees.
export type SubtitleEffect={kind:EffectKind;on:boolean;color:string;opacity:number;size:number;blur:number;distance:number;angle:number;strength:number;depressed:boolean};
export type SubtitleEffects=Record<EffectKind,SubtitleEffect>;
export type SubtitleStyle={
  // Text. `customFont` is any font installed on the device and wins over `font` when set; spacing is in hundredths of an em.
  font:SubtitleFont;customFont:string;size:SubtitleSize;sizeScale:number;weight:number;italics:'auto'|'always'|'never';color:string;textOpacity:number;
  textCase:'none'|'upper'|'lower';letterSpacing:number;wordSpacing:number;lineHeight:number;lineGap:number;
  effects:SubtitleEffects;
  // The box behind each line or around the whole cue, made of a background, a border and a frosted blur, each on or off.
  // Padding, rounding and border width are hundredths of an em; blur is in pixels.
  backgroundOn:boolean;background:string;backgroundOpacity:number;backgroundShape:'line'|'block';paddingX:number;paddingY:number;cornerRadius:number;
  borderOn:boolean;borderWidth:number;borderColor:string;borderOpacity:number;
  frostedOn:boolean;backgroundBlur:number;
  // Distance of the nearest line from the anchored edge, in percent of the picture height; width and offset in percent of its width.
  anchor:'bottom'|'top';position:number;offsetX:number;align:'left'|'center'|'right';width:number;forcedTop:boolean;
};
type NumberKey={[K in keyof SubtitleStyle]:SubtitleStyle[K] extends number?K:never}[keyof SubtitleStyle];
type EffectNumber='opacity'|'size'|'blur'|'distance'|'angle'|'strength';
// Valid range and step of each number, also its slider's.
export const subtitleRanges:Record<NumberKey,readonly [number,number,number]>={
  sizeScale:[50,200,1],weight:[100,900,100],textOpacity:[10,100,1],letterSpacing:[-10,30,.5],wordSpacing:[-20,60,1],lineHeight:[90,200,1],lineGap:[0,40,1],
  backgroundOpacity:[5,100,1],paddingX:[0,120,1],paddingY:[0,60,1],cornerRadius:[0,60,1],borderWidth:[.5,20,.5],borderOpacity:[5,100,1],backgroundBlur:[1,30,1],
  position:[0,45,.5],offsetX:[-40,40,.5],width:[30,100,1],
};
export const effectRanges:Record<EffectNumber,readonly [number,number,number]>={opacity:[0,100,1],size:[0,60,.5],blur:[0,40,.5],distance:[0,40,.5],angle:[0,359,1],strength:[1,6,1]};
export const positionRange=subtitleRanges.position;

// A drop shadow's `size` is the soft halo around the letters (0 for none).
const kindDefaults:Record<EffectKind,Partial<SubtitleEffect>>={outline:{size:5.5},stroke:{size:8},emboss:{size:5,angle:45},shadow:{size:20,distance:8,blur:10},extrude:{size:10,angle:45},glow:{size:20,strength:3}};
export const effect=(kind:EffectKind,patch:Partial<SubtitleEffect>={}):SubtitleEffect=>({kind,on:false,color:'#000000',opacity:100,size:5.5,blur:0,distance:8,angle:50,strength:3,depressed:false,...kindDefaults[kind],...patch});
// All effects, those named turned on with their changes.
export const effects=(on:Partial<Record<EffectKind,Partial<SubtitleEffect>>>={}):SubtitleEffects=>
  Object.fromEntries(effectKinds.map(([k])=>[k,effect(k,on[k]?{on:true,...on[k]}:{})])) as SubtitleEffects;
const effectKeys=Object.keys(effect('outline')) as (keyof SubtitleEffect)[];
export const sameEffect=(a:SubtitleEffect,b:SubtitleEffect)=>effectKeys.every(k=>a[k]===b[k]);

export const defaultSubtitleStyle:SubtitleStyle={
  font:'sans',customFont:'',size:'m',sizeScale:100,weight:500,italics:'auto',color:'#ffffff',textOpacity:100,textCase:'none',letterSpacing:0,wordSpacing:0,lineHeight:130,lineGap:0,
  effects:effects({shadow:{}}),
  backgroundOn:true,background:'#000000',backgroundOpacity:60,backgroundShape:'line',paddingX:35,paddingY:4,cornerRadius:12,
  borderOn:false,borderWidth:2,borderColor:'#ffffff',borderOpacity:40,frostedOn:false,backgroundBlur:10,
  anchor:'bottom',position:5,offsetX:0,align:'center',width:90,forcedTop:false,
};
// Where subtitles sit, which a preset leaves as it is; everything else is the look a preset sets.
export const layoutFields=['size','sizeScale','anchor','position','offsetX','align','width','forcedTop'] as const satisfies readonly (keyof SubtitleStyle)[];
export type SubtitleLook=Omit<SubtitleStyle,typeof layoutFields[number]>;
export const lookOf=(style:SubtitleStyle):SubtitleLook=>{const look:Record<string,unknown>={...style};for(const field of layoutFields)delete look[field];return look as SubtitleLook;};
export const withLook=(style:SubtitleStyle,look:Partial<SubtitleLook>):SubtitleStyle=>({...defaultSubtitleStyle,...look,...Object.fromEntries(layoutFields.map(f=>[f,style[f]]))});
export const sameValue=(k:keyof SubtitleStyle,a:SubtitleStyle,b:SubtitleStyle)=>k==='effects'?effectKinds.every(([e])=>sameEffect(a.effects[e],b.effects[e])):a[k]===b[k];
export const hasLook=(style:SubtitleStyle,look:Partial<SubtitleLook>)=>{const wanted=withLook(style,look);return (Object.keys(wanted) as (keyof SubtitleStyle)[]).every(k=>sameValue(k,style,wanted));};
const bare={backgroundOn:false};
export const subtitlePresets:[string,Partial<SubtitleLook>][]=[
  ['Default',{}],
  ['Outline',{...bare,effects:effects({outline:{}})}],
  ['Classic yellow',{...bare,color:'#ffe14d',effects:effects({outline:{}})}],
  ['Bold outline',{...bare,weight:700,effects:effects({outline:{size:9}})}],
  ['Outline and shadow',{...bare,effects:effects({outline:{size:4},shadow:{distance:10,blur:6,size:0}})}],
  ['High contrast',{weight:700,effects:effects(),backgroundOpacity:100}],
  ['Cinema',{...bare,effects:effects({shadow:{}})}],
  ['Soft box',{effects:effects(),backgroundOpacity:45,backgroundShape:'block',paddingX:45,paddingY:14,cornerRadius:9}],
  ['Frosted',{effects:effects(),backgroundOpacity:30,backgroundShape:'block',paddingX:45,paddingY:14,cornerRadius:30,frostedOn:true}],
  ['Outlined box',{effects:effects(),backgroundOpacity:70,backgroundShape:'block',paddingX:45,paddingY:12,cornerRadius:8,borderOn:true,borderWidth:2.5,borderOpacity:70}],
  ['Neon',{...bare,effects:effects({stroke:{color:'#ff3cc7',size:3},glow:{color:'#ff3cc7',size:30,strength:4}})}],
  ['Retro 3D',{...bare,color:'#ffe14d',weight:800,effects:effects({stroke:{size:6},extrude:{color:'#c0392b',size:12}})}],
];

const hex=/^#[0-9a-f]{6}$/i;
const oneOf=<T extends string>(options:readonly (readonly [T,string])[],value:unknown,fallback:T)=>options.some(([id])=>id===value)?value as T:fallback;
const number=(value:unknown,fallback:number,[min,max,step]:readonly [number,number,number])=>typeof value==='number'&&Number.isFinite(value)?Math.min(max,Math.max(min,+(Math.round(value/step)*step).toFixed(2))):fallback;
const color=(value:unknown,fallback:string)=>typeof value==='string'&&hex.test(value)?value.toLowerCase():fallback;
const flag=(value:unknown,fallback:boolean)=>typeof value==='boolean'?value:fallback;
const word=<T extends string>(options:readonly T[],value:unknown,fallback:T)=>options.includes(value as T)?value as T:fallback;
const record=(value:unknown)=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
const object=(raw:string|null):Record<string,unknown>=>{try{return record(raw?JSON.parse(raw):{})??{};}catch{return {};}};
function parseEffect(kind:EffectKind,raw:unknown,on:boolean):SubtitleEffect {
  const e=record(raw)??{},d=effect(kind),n=(k:EffectNumber)=>number(e[k],d[k],effectRanges[k]);
  return effect(kind,{on:flag(e.on,on),color:color(e.color,d.color),opacity:n('opacity'),size:n('size'),blur:n('blur'),distance:n('distance'),angle:n('angle'),strength:n('strength'),depressed:flag(e.depressed,false)});
}
// Styles saved before had one edge style, scaled by a thickness and softness in percent, or a list of effects.
function legacyEffects(saved:Record<string,unknown>):SubtitleEffects {
  if(Array.isArray(saved.effects)){const list=saved.effects.map(record);return Object.fromEntries(effectKinds.map(([k])=>{const found=list.find(e=>e?.kind===k);return [k,parseEffect(k,found,!!found)];})) as SubtitleEffects;}
  const base={color:color(saved.edgeColor,'#000000'),opacity:number(saved.edgeOpacity,100,effectRanges.opacity)};
  const w=number(saved.edgeWidth,100,[25,300,1])/100,s=number(saved.edgeSoftness,100,[0,200,1])/100,angle=number(saved.shadowAngle,50,effectRanges.angle);
  switch(saved.edge) {
    case 'outline':return effects({outline:{...base,size:5.5*w}});
    case 'shadow':return effects({shadow:{...base,distance:8*w,blur:10*s,size:20*s,angle}});
    case 'raised':return effects({emboss:{...base,size:5*w,angle}});
    case 'depressed':return effects({emboss:{...base,size:5*w,angle,depressed:true}});
    case 'glow':return effects({glow:{...base,size:35*w*(.5+s/2),strength:3}});
    case 'none':return effects();
    default:return defaultSubtitleStyle.effects;
  }
}
// Anything missing or invalid falls back to the default, field by field. `legacySize` is the player's older size-only
// preference; older styles' bold switch, edge style, frosted switch, padding percent and zero opacity for "no background" carry over.
export function parseSubtitleStyle(raw:string|null|Record<string,unknown>,legacySize?:string|null):SubtitleStyle {
  const saved=typeof raw==='string'||raw===null?object(raw):raw,d=defaultSubtitleStyle,r=subtitleRanges;
  const n=(field:NumberKey,fallback:number=d[field])=>number(saved[field],fallback,r[field]);
  const shape=word(['line','block'],saved.backgroundShape,d.backgroundShape),pad=typeof saved.backgroundPadding==='number'?saved.backgroundPadding/100:undefined;
  const fx=record(saved.effects),opacity=saved.backgroundOpacity,width=saved.borderWidth,blur=saved.backgroundBlur;
  return {
    font:oneOf(subtitleFonts,saved.font,d.font),customFont:typeof saved.customFont==='string'?saved.customFont.replace(/["';{}<>\\]/g,'').trim().slice(0,60):'',
    size:oneOf(subtitleSizes,saved.size??legacySize,d.size),sizeScale:n('sizeScale'),weight:n('weight',saved.bold===true?700:d.weight),
    italics:word(['auto','always','never'],saved.italics,d.italics),color:color(saved.color,d.color),textOpacity:n('textOpacity'),
    textCase:word(['none','upper','lower'],saved.textCase,saved.uppercase===true?'upper':d.textCase),
    letterSpacing:n('letterSpacing'),wordSpacing:n('wordSpacing'),lineHeight:n('lineHeight'),lineGap:n('lineGap'),
    effects:fx?Object.fromEntries(effectKinds.map(([k])=>[k,parseEffect(k,fx[k],d.effects[k].on)])) as SubtitleEffects:legacyEffects(saved),
    backgroundOn:flag(saved.backgroundOn,opacity!==0),background:color(saved.background,d.background),backgroundOpacity:opacity===0?d.backgroundOpacity:n('backgroundOpacity'),backgroundShape:shape,
    paddingX:n('paddingX',pad===undefined?d.paddingX:(shape==='block'?50:35)*pad),paddingY:n('paddingY',pad===undefined?d.paddingY:(shape==='block'?15:4)*pad),
    cornerRadius:n('cornerRadius',typeof saved.backgroundRadius==='number'?saved.backgroundRadius*.6:d.cornerRadius),
    borderOn:flag(saved.borderOn,typeof width==='number'&&width>0),borderWidth:width===0?d.borderWidth:n('borderWidth'),borderColor:color(saved.borderColor,d.borderColor),borderOpacity:n('borderOpacity'),
    frostedOn:flag(saved.frostedOn,saved.frosted===true||typeof blur==='number'&&blur>0),backgroundBlur:blur===0?d.backgroundBlur:n('backgroundBlur'),
    anchor:word(['bottom','top'],saved.anchor,d.anchor),position:n('position'),offsetX:n('offsetX'),align:word(['left','center','right'],saved.align,d.align),width:n('width'),forcedTop:flag(saved.forcedTop,d.forcedTop),
  };
}

export const rgba=(value:string,opacity:number)=>`rgba(${parseInt(value.slice(1,3),16)},${parseInt(value.slice(3,5),16)},${parseInt(value.slice(5,7),16)},${+(opacity/100).toFixed(2)})`;
const fontFamily:Record<SubtitleFont,string|undefined>={sans:undefined,smallcaps:undefined,serif:'Georgia,"Times New Roman",serif',mono:'"Cascadia Mono",Consolas,"Courier New",monospace',casual:'"Comic Sans MS","Comic Neue","Segoe Print",cursive',condensed:'"Arial Narrow","Roboto Condensed","Helvetica Neue",sans-serif'};
const em=(hundredths:number)=>`${+(hundredths/100).toFixed(4)}em`;
const shadow=(x:number,y:number,blur:number,c:string)=>`${em(x)} ${em(y)} ${em(blur)} ${c}`;
// The text shadows one effect adds; a stroke adds none (it is drawn with text-stroke instead).
export function effectShadows(e:SubtitleEffect):string[] {
  const c=rgba(e.color,e.opacity),a=e.angle*Math.PI/180,x=Math.cos(a),y=Math.sin(a);
  switch(e.kind) {
    // A ring of hard shadows reads as an even stroke around the glyphs without eating into them like text-stroke.
    case 'outline':return Array.from({length:16},(_,i)=>{const t=i*Math.PI/8;return shadow(Math.cos(t)*e.size,Math.sin(t)*e.size,e.blur,c);});
    case 'stroke':return [];
    case 'shadow':return [shadow(e.distance*x,e.distance*y,e.blur,c),...(e.size?[shadow(0,0,e.size,rgba(e.color,e.opacity/2))]:[])];
    case 'glow':return Array.from({length:e.strength},(_,i)=>shadow(0,0,e.size*(i+1)/e.strength,c));
    case 'emboss':return e.depressed?[shadow(-e.size*x,-e.size*y,0,c),shadow(e.size*.85*x,e.size*.85*y,0,rgba('#ffffff',e.opacity*.35))]:[shadow(e.size*.5*x,e.size*.5*y,0,c),shadow(e.size*x,e.size*y,0,c)];
    case 'extrude':return Array.from({length:Math.max(1,Math.round(e.size))},(_,i)=>shadow((i+1)*x,(i+1)*y,0,c));
  }
}
export const textShadow=(all:SubtitleEffects)=>effectKinds.map(([k])=>all[k]).filter(e=>e.on).flatMap(effectShadows).join(',')||undefined;
// Font size as a share of the picture height, with a floor in pixels.
export const subtitleScale:Record<SubtitleSize,[number,number]>={s:[.036,14],m:[.046,16],l:[.058,19],xl:[.072,22]};
export const subtitleFontSize=(style:SubtitleStyle,pictureHeight:number)=>{const [scale,minimum]=subtitleScale[style.size];return Math.max(minimum,pictureHeight*scale)*style.sizeScale/100;};
const alignItems=(style:SubtitleStyle)=>style.align==='left'?'flex-start':style.align==='right'?'flex-end':'center';
// The box the cues stack in: as wide as the style allows, moved sideways by the offset but kept on the picture.
export const captionBox=(style:SubtitleStyle):CSSProperties=>{
  const room=100-style.width,left=Math.min(room,Math.max(0,room/2+style.offsetX));
  return {left:`${left}%`,right:`${room-left}%`,alignItems:alignItems(style),textAlign:style.align};
};
const family=(style:SubtitleStyle)=>style.customFont?`"${style.customFont}",${fontFamily[style.font]??'system-ui,sans-serif'}`:fontFamily[style.font];

// One cue, drawn the way the viewer's style asks. The parent sets font-size.
export function CaptionCue({lines,style}:{lines:CaptionSpan[][];style:SubtitleStyle}) {
  const block=style.backgroundShape==='block',stroke=style.effects.stroke;
  const box:CSSProperties={background:style.backgroundOn?rgba(style.background,style.backgroundOpacity):'transparent',borderRadius:em(style.cornerRadius),padding:`${em(style.paddingY)} ${em(style.paddingX)}`,
    backdropFilter:style.frostedOn?`blur(${style.backgroundBlur}px) saturate(1.2)`:undefined,
    border:style.borderOn?`${em(style.borderWidth)} solid ${rgba(style.borderColor,style.borderOpacity)}`:undefined};
  const text:CSSProperties={color:rgba(style.color,style.textOpacity),fontFamily:family(style),fontVariant:style.font==='smallcaps'?'small-caps':undefined,fontStretch:style.font==='condensed'?'condensed':undefined,
    fontWeight:style.weight,letterSpacing:style.letterSpacing?em(style.letterSpacing):undefined,wordSpacing:style.wordSpacing?em(style.wordSpacing):undefined,lineHeight:style.lineHeight/100,
    textTransform:style.textCase==='upper'?'uppercase':style.textCase==='lower'?'lowercase':undefined,textShadow:textShadow(style.effects),
    ...(stroke.on?{WebkitTextStroke:`${em(stroke.size)} ${rgba(stroke.color,stroke.opacity)}`,paintOrder:'stroke fill'}:{})};
  const italic=(span:CaptionSpan)=>style.italics==='always'||style.italics==='auto'&&span.i;
  return <div className="caption" style={{...text,alignItems:alignItems(style),gap:em(style.lineGap),...(block?box:{})}}>{lines.map((line,n)=><span key={n} className="caption-line" style={block?{padding:0}:box}>{line.map((span,m)=>
    <span key={m} style={{fontStyle:italic(span)?'italic':undefined,fontWeight:span.b?Math.min(900,style.weight+300):undefined,textDecoration:span.u?'underline':undefined}}>{span.text}</span>)}</span>)}</div>;
}

// A value kept per browser that every open view (and other tabs) follows.
function browserStore<T>(key:string,load:(raw:string|null)=>T) {
  const listeners=new Set<()=>void>();
  let current:T|undefined;
  const get=()=>current??=(()=>{try{return load(localStorage.getItem(key));}catch{return load(null);}})();
  const set=(next:T)=>{
    current=next;
    try{localStorage.setItem(key,JSON.stringify(next));}catch{/* storage unavailable; applies until reload */}
    for(const listener of listeners)listener();
  };
  const subscribe=(listener:()=>void)=>{
    // Another tab changing the value updates this one too.
    const onStorage=(e:StorageEvent)=>{if(e.key===key){current=undefined;listener();}};
    listeners.add(listener);window.addEventListener('storage',onStorage);
    return()=>{listeners.delete(listener);window.removeEventListener('storage',onStorage);};
  };
  return {get,set,use:()=>useSyncExternalStore(subscribe,get)};
}

const legacySize=()=>{try{return readPreference(localStorage,'tk.box.player.subtitleSize');}catch{return null;}};
const styleStore=browserStore('tk.box.player.subtitleStyle',raw=>parseSubtitleStyle(raw,legacySize()));
export const getSubtitleStyle=styleStore.get,setSubtitleStyle=styleStore.set,useSubtitleStyle=styleStore.use;
export const updateSubtitleStyle=(patch:Partial<SubtitleStyle>)=>setSubtitleStyle({...getSubtitleStyle(),...patch});

// The viewer's own presets, saved from the subtitle studio. Like the built-in ones, each is a look only.
export type CustomPreset={name:string;look:SubtitleLook};
export const maxCustomPresets=12;
export function parseCustomPresets(raw:string|null):CustomPreset[] {
  let saved:unknown=[];try{saved=raw?JSON.parse(raw):[];}catch{/* none */}
  if(!Array.isArray(saved))return [];
  const presets:CustomPreset[]=[];
  for(const entry of saved as {name?:unknown;look?:unknown}[]) {
    const name=typeof entry?.name==='string'?entry.name.trim().slice(0,40):'',look=record(entry?.look);
    if(!name||presets.some(p=>p.name===name)||!look)continue;
    presets.push({name,look:lookOf(parseSubtitleStyle(look))});
  }
  return presets.slice(0,maxCustomPresets);
}
const presetStore=browserStore('tk.box.player.subtitlePresets',parseCustomPresets);
export const useCustomPresets=presetStore.use;
// Saving under a name already used replaces that preset in place; past the limit the oldest goes.
export function saveCustomPreset(name:string,style:SubtitleStyle) {
  const list=presetStore.get(),preset={name:name.trim().slice(0,40),look:lookOf(style)},at=list.findIndex(p=>p.name===preset.name);
  if(!preset.name)return;
  presetStore.set(at<0?[...list,preset].slice(-maxCustomPresets):list.map((p,i)=>i===at?preset:p));
}
export const deleteCustomPreset=(name:string)=>presetStore.set(presetStore.get().filter(p=>p.name!==name));
