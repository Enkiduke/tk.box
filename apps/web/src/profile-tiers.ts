import type {PickProfile,ProfileTier} from '../../../packages/contracts/src/downloads.js';

// A profile's tiers as the editor shows them: the rest (preferred first) and the early copies, one tier of their own at
// the end. `join` puts them back; `normalized` moves early copies kept anywhere else into their tier, dropping a tier
// that leaves empty.
export type Split={tiers:ProfileTier[];preferred:number;early:string[]};
export const split=(p:PickProfile,early:readonly string[]):Split=>{
  const isEarly=(q:string)=>early.includes(q),rest=p.tiers.map(t=>({...t,qualities:t.qualities.filter(q=>!isEarly(q))}));
  const kept=rest.map((t,i)=>({t,i,was:p.tiers[i]!.qualities.length})).filter(x=>x.t.qualities.length||!x.was);
  return {tiers:kept.map(x=>x.t),preferred:kept.filter(x=>x.i<p.preferred).length,
    early:p.tiers.flatMap(t=>t.qualities.filter(isEarly))};
};
export const join=(p:PickProfile,{tiers,preferred,early}:Split):PickProfile=>({...p,tiers:early.length?[...tiers,{qualities:early}]:tiers,preferred});
export const normalized=(p:PickProfile,early:readonly string[])=>join(p,split(p,early));
// What is dragged (a tier, or one quality out of it), and where it is dropped: a tier, or the head of the Preferred or
// Fallback section.
export type DragItem={tier:number;quality?:string};
export type DropTarget=number|'preferred'|'fallback';
// A drop. A tier dropped on a tier takes its place (and its section); a quality dropped on a tier joins it. Either,
// dropped on a section's head, starts that section (a quality as a tier of its own). A tier a quality leaves empty goes.
export function dropped(s:Split,item:DragItem,target:DropTarget):Split {
  const tiers=[...s.tiers],source=tiers[item.tier];
  if(!source||target===item.tier)return s;
  let preferred=s.preferred,moving:ProfileTier;
  if(item.quality){
    const quality=item.quality,left=source.qualities.filter(q=>q!==quality);
    if(typeof target==='number'){const into=tiers[target];if(!into)return s;tiers[target]={...into,qualities:[...into.qualities,quality]};}
    tiers[item.tier]={...source,qualities:left};
    if(!left.length){tiers.splice(item.tier,1);if(item.tier<preferred)preferred--;}
    if(typeof target==='number')return {...s,tiers,preferred};
    moving={qualities:[quality],...(source.size?{size:source.size}:{})};
  } else if(typeof target==='number'){
    // moveTo's order; the tier joins its target's section.
    const [tier]=tiers.splice(item.tier,1);tiers.splice(target,0,tier!);
    return {...s,tiers,preferred:preferred-(item.tier<preferred?1:0)+(target<preferred?1:0)};
  } else {[moving]=tiers.splice(item.tier,1) as [ProfileTier];if(item.tier<preferred)preferred--;}
  if(target==='preferred'){tiers.unshift(moving);preferred++;}
  else tiers.splice(preferred,0,moving);
  return {...s,tiers,preferred};
}
