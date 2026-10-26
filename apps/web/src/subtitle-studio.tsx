import {useState,type InputHTMLAttributes,type ReactNode} from 'react';
import {Icon} from './components.js';
import {SubtitlePreview} from './subtitle-preview.js';
import {defaultSubtitleStyle,effectKinds,effectRanges,maxCustomPresets,parseSubtitleStyle,saveCustomPreset,sameEffect,sameValue,subtitleFonts,subtitlePresets,subtitleRanges,subtitleSizes,useCustomPresets,withLook,
  type EffectKind,type SubtitleEffect,type SubtitleStyle} from './subtitle-style.js';
import './subtitle-studio.css';

// Settings › Playback › Subtitles › Advanced: the subtitle studio, after the poster studio in Admin › Artwork › Layouts. Every part
// of a subtitle is listed on the left, each shown or hidden with its eye; the preview is in the middle and the chosen part's
// settings on the right. Changes are a draft until saved, kept while the studio is closed.
type Style=SubtitleStyle;type Key=keyof Style;type EKey=keyof SubtitleEffect;
type Choice=readonly (readonly [string,string])[];
// One row: a number (lengths in percent of the text size), color, choice, select, switch or text box.
type Field<K extends string>={k:K;label:string;unit?:string;choices?:Choice;select?:Choice;color?:true;bool?:true;text?:string};
type Section<K extends string>={name:string;fields:Field<K>[]};
const pct='%',len='% of text';
type Part={id:string;label:string;icon:string;toggle?:Key;sections:Section<Key>[]};
const TEXT:Part={id:'text',label:'Text',icon:'text',sections:[
  {name:'Font',fields:[{k:'font',label:'Font',select:subtitleFonts},{k:'customFont',label:'Installed font',text:'Any font on this device'},{k:'weight',label:'Weight'},
    {k:'italics',label:'Italics',choices:[['auto','As written'],['always','Always'],['never','Never']]},{k:'textCase',label:'Case',choices:[['none','As written'],['upper','UPPER'],['lower','lower']]}]},
  {name:'Size',fields:[{k:'size',label:'Size',choices:subtitleSizes},{k:'sizeScale',label:'Fine size',unit:pct}]},
  {name:'Color',fields:[{k:'color',label:'Color',color:true},{k:'textOpacity',label:'Opacity',unit:pct}]},
  {name:'Spacing',fields:[{k:'letterSpacing',label:'Letters',unit:len},{k:'wordSpacing',label:'Words',unit:len},{k:'lineHeight',label:'Line height',unit:pct},{k:'lineGap',label:'Between lines',unit:len}]},
]};
// The box's shape is shared by its background, border and blur, so it sits with whichever of them is open.
const BOX:Section<Key>={name:'Box',fields:[{k:'backgroundShape',label:'Shape',choices:[['line','Behind lines'],['block','One box']]},{k:'paddingX',label:'Padding sides',unit:len},{k:'paddingY',label:'Padding top & bottom',unit:len},{k:'cornerRadius',label:'Corner radius',unit:len}]};
const BOX_PARTS:Part[]=[
  {id:'background',label:'Background',icon:'image',toggle:'backgroundOn',sections:[{name:'Fill',fields:[{k:'background',label:'Color',color:true},{k:'backgroundOpacity',label:'Opacity',unit:pct}]},BOX]},
  {id:'border',label:'Border',icon:'matte',toggle:'borderOn',sections:[{name:'Line',fields:[{k:'borderColor',label:'Color',color:true},{k:'borderWidth',label:'Width',unit:len},{k:'borderOpacity',label:'Opacity',unit:pct}]},BOX]},
  {id:'frosted',label:'Frosted blur',icon:'sparkle',toggle:'frostedOn',sections:[{name:'Blur',fields:[{k:'backgroundBlur',label:'Strength',unit:'px'}]},BOX]},
];
const LAYOUT:Part={id:'layout',label:'Position',icon:'grid',sections:[
  {name:'Position',fields:[{k:'anchor',label:'Anchor',choices:[['bottom','Bottom'],['top','Top']]},{k:'position',label:'From the edge',unit:'% of height'},{k:'offsetX',label:'Sideways',unit:'% of width'},{k:'forcedTop',label:'Forced subtitles at top',bool:true}]},
  {name:'Width',fields:[{k:'width',label:'Maximum width',unit:'% of width'},{k:'align',label:'Alignment',choices:[['left','Left'],['center','Center'],['right','Right']]}]},
]};
const effectFields:Record<EffectKind,Field<EKey>[]>={
  outline:[{k:'size',label:'Thickness',unit:len},{k:'blur',label:'Softness',unit:len}],
  stroke:[{k:'size',label:'Thickness',unit:len}],
  emboss:[{k:'size',label:'Depth',unit:len},{k:'angle',label:'Light from',unit:'°'},{k:'depressed',label:'Pressed in',bool:true}],
  shadow:[{k:'distance',label:'Distance',unit:len},{k:'angle',label:'Angle',unit:'°'},{k:'blur',label:'Blur',unit:len},{k:'size',label:'Halo',unit:len}],
  extrude:[{k:'size',label:'Depth',unit:len},{k:'angle',label:'Angle',unit:'°'}],
  glow:[{k:'size',label:'Radius',unit:len},{k:'strength',label:'Intensity'}],
};
const rangeOf=(k:string)=>(subtitleRanges as Record<string,readonly [number,number,number]>)[k]??(effectRanges as Record<string,readonly [number,number,number]>)[k]!;
const hex=/^#[0-9a-f]{6}$/i;
const effectKeys=(e:SubtitleEffect)=>Object.keys(e) as EKey[];
export const unsavedCount=(draft:Style,saved:Style)=>(Object.keys(defaultSubtitleStyle) as Key[]).filter(k=>k!=='effects'&&!sameValue(k,draft,saved)).length
  +effectKinds.reduce((n,[k])=>n+effectKeys(draft.effects[k]).filter(f=>draft.effects[k][f]!==saved.effects[k][f]).length,0);

// A box that shows what is being typed while it has focus (so "1." isn't swapped for the number).
function Draft({value,commit,...rest}:{value:string;commit:(text:string)=>void}&Omit<InputHTMLAttributes<HTMLInputElement>,'value'|'onChange'>) {
  const [draft,setDraft]=useState<string|null>(null);
  return <input {...rest} value={draft??value} onChange={e=>{setDraft(e.target.value);commit(e.target.value);}} onBlur={()=>setDraft(null)}/>;
}
function FieldRow<K extends string>({f,value,saved,set}:{f:Field<K>;value:unknown;saved:unknown;set:(v:unknown)=>void}) {
  const id=`sf-${f.k}`,changed=value!==saved;let control:ReactNode;
  if(f.choices)control=<div className="toggle-group" role="radiogroup" aria-label={f.label}>{f.choices.map(([v,label])=><button key={v} type="button" role="radio" aria-checked={value===v} onClick={()=>set(v)}>{label}</button>)}</div>;
  else if(f.select)control=<select id={id} value={String(value)} onChange={e=>set(e.target.value)}>{f.select.map(([v,label])=><option key={v} value={v}>{label}</option>)}</select>;
  else if(f.bool)control=<input id={id} type="checkbox" role="switch" className="switch" checked={!!value} onChange={e=>set(e.target.checked)}/>;
  else if(f.text!==undefined)control=<input id={id} type="text" placeholder={f.text} spellCheck={false} maxLength={60} value={String(value)} onChange={e=>set(e.target.value)}/>;
  else if(f.color){const text=String(value);control=<span className="sub-color"><input id={id} type="color" value={hex.test(text)?text:'#000000'} onChange={e=>set(e.target.value.toLowerCase())}/>
    <Draft className="sub-number" maxLength={7} spellCheck={false} aria-label={`${f.label} (hex)`} value={text} commit={t=>{const v=t.trim();if(hex.test(v))set(v.toLowerCase());}}/></span>;}
  else {
    const [min,max,step]=rangeOf(f.k),n=Number(value),clamp=(x:number)=>Math.min(max,Math.max(min,Math.round(x/step)*step));
    control=<span className="sub-range"><input id={id} type="range" min={min} max={max} step={step} value={n} onChange={e=>set(Number(e.target.value))}/>
      <Draft className="sub-number" type="number" min={min} max={max} step={step} aria-label={f.label} value={String(n)} commit={t=>{if(t!==''&&Number.isFinite(Number(t)))set(clamp(Number(t)));}}/>{f.unit&&<small className="sub-unit">{f.unit}</small>}</span>;
  }
  return <div className={`sub-field${changed?' changed':''}`}><label htmlFor={id}>{f.label}</label>{control}
    <button type="button" className="icon-button" title="Back to the saved value" aria-label={`Reset ${f.label}`} disabled={!changed} onClick={()=>set(saved)}><Icon name="restart" size={14}/></button></div>;
}
function Sections<K extends string>({sections,value,saved,set,open,setOpen,prefix}:{sections:Section<K>[];value:Record<string,unknown>;saved:Record<string,unknown>;set:(k:K,v:unknown)=>void;open:Record<string,boolean>;setOpen:(id:string,on:boolean)=>void;prefix:string}) {
  return <>{sections.map(s=>{
    const id=`${prefix}/${s.name}`,changed=s.fields.filter(f=>value[f.k]!==saved[f.k]).length;
    return <details key={s.name} className="sub-section" open={open[id]??true} onToggle={e=>setOpen(id,(e.currentTarget as HTMLDetailsElement).open)}>
      <summary>{s.name}{changed>0&&<span className="count">{changed}</span>}</summary>
      {s.fields.map(f=><FieldRow key={f.k} f={f} value={value[f.k]} saved={saved[f.k]} set={v=>set(f.k,v)}/>)}
    </details>;})}</>;
}
// One row of the parts list: its name (dimmed while hidden), how many of its settings changed, and its eye.
function PartRow({label,icon,active,shown,changed,onPick,onToggle}:{label:string;icon:ReactNode;active:boolean;shown?:boolean;changed:number;onPick:()=>void;onToggle?:()=>void}) {
  return <li><button type="button" className={`sub-layer${active?' active':''}${shown===false?' off':''}`} aria-current={active?'true':undefined} onClick={onPick}>{icon}<span className="grow">{label}</span>{changed>0&&<span className="count">{changed}</span>}</button>
    {onToggle&&<button type="button" className="icon-button sub-eye" aria-pressed={shown} aria-label={`${shown?'Hide':'Show'} ${label}`} title={shown?'Shown: click to hide':'Hidden: click to show'} onClick={onToggle}><Icon name={shown?'eye':'eye-off'} size={16}/></button>}</li>;
}

export function SubtitleStudio({saved,draft,setDraft,save}:{saved:Style;draft:Style;setDraft:(next:Style)=>void;save:()=>void}) {
  const [part,setPart]=useState('text'),[open,setOpenState]=useState<Record<string,boolean>>({}),[sample,setSample]=useState(''),[name,setName]=useState(''),[note,setNote]=useState('');
  const custom=useCustomPresets(),count=unsavedCount(draft,saved);
  const setOpen=(id:string,on:boolean)=>setOpenState(o=>({...o,[id]:on}));
  const change=(patch:Partial<Style>)=>{setNote('');setDraft({...draft,...patch});};
  const changeEffect=(kind:EffectKind,patch:Partial<SubtitleEffect>)=>change({effects:{...draft.effects,[kind]:{...draft.effects[kind],...patch}}});
  const parts=[TEXT,...BOX_PARTS,LAYOUT],selected=parts.find(p=>p.id===part),kind=effectKinds.find(([k])=>`effect:${k}`===part);
  const changed=(p:Part)=>[...new Set([p.toggle,...p.sections.flatMap(s=>s.fields.map(f=>f.k))])].filter((k):k is Key=>!!k&&!sameValue(k,draft,saved)).length;
  const effectChanged=(k:EffectKind)=>sameEffect(draft.effects[k],saved.effects[k])?0:effectKeys(draft.effects[k]).filter(f=>draft.effects[k][f]!==saved.effects[k][f]).length;
  const row=(p:Part)=><PartRow key={p.id} label={p.label} icon={<Icon name={p.icon} size={16}/>} active={part===p.id} changed={changed(p)} onPick={()=>setPart(p.id)}
    {...(p.toggle?{shown:!!draft[p.toggle],onToggle:()=>change({[p.toggle!]:!draft[p.toggle!]})}:{})}/>;
  const presets=[...subtitlePresets.map(([n,look])=>({name:n,look})),...custom];
  const as=(x:object)=>x as Record<string,unknown>;
  const hidden=(shown:boolean,label:string)=>!shown&&<p className="muted small">{label} is hidden. Turn it on to see it.</p>;
  return <div className="subtitle-studio">
    <header className="sub-head">
      <div className="sub-head-group grow"><Icon name="captions"/><h3>Subtitle studio</h3></div>
      <div className="sub-head-group">
        <select aria-label="Start from a preset" value="" onChange={e=>{const p=presets.find(x=>x.name===e.target.value);if(p)change(withLook(draft,p.look));}}>
          <option value="">Start from a preset…</option>{presets.map(p=><option key={p.name} value={p.name}>{p.name}</option>)}</select>
        <button type="button" onClick={()=>change(defaultSubtitleStyle)}>Defaults</button>
      </div>
      <div className="sub-head-group grow sub-head-end">
        {count>0&&<span className="sub-unsaved">{count} unsaved</span>}
        {count>0&&<button type="button" onClick={()=>{setDraft(saved);setNote('');}}>Reset</button>}
        <button type="button" className="primary" disabled={!count} onClick={()=>{save();setNote('Saved.');}}>Save</button>
      </div>
    </header>
    <div className="sub-body">
      <nav className="sub-layers" aria-label="Parts">
        <h4>Text</h4><ul>{row(TEXT)}</ul>
        <h4>Box</h4><ul>{BOX_PARTS.map(row)}</ul>
        <h4>Effects</h4><ul>{effectKinds.map(([k,label])=>{const e=draft.effects[k];return <PartRow key={k} label={label} icon={<span className="sub-dot" style={{background:e.color}}/>} active={part===`effect:${k}`}
          shown={e.on} changed={effectChanged(k)} onPick={()=>setPart(`effect:${k}`)} onToggle={()=>changeEffect(k,{on:!e.on})}/>;})}</ul>
        <h4>Placement</h4><ul>{row(LAYOUT)}</ul>
        <form className="sub-save" onSubmit={e=>{e.preventDefault();if(!name.trim())return;saveCustomPreset(name,parseSubtitleStyle(as(draft)));setNote(`Saved preset “${name.trim()}”.`);setName('');}}>
          <h4>Save as preset</h4>
          <div className="sub-save-row"><input value={name} maxLength={40} placeholder="Preset name" aria-label="Preset name" onChange={e=>setName(e.target.value)}/>
            <button type="submit" disabled={!name.trim()}>{custom.some(p=>p.name===name.trim())?'Replace':'Save'}</button></div>
          {custom.length>=maxCustomPresets&&!custom.some(p=>p.name===name.trim())&&name.trim()&&<small className="muted">Replaces your oldest preset.</small>}
        </form>
      </nav>
      <section className="sub-canvas" aria-label="Preview">
        <div className="sub-stage"><SubtitlePreview style={draft} sample={sample} className="studio"/></div>
        <label className="sub-sample"><span className="muted small">Sample text</span>
          <textarea rows={2} value={sample} placeholder="Your own lines instead of the scenes’. <i>Italics</i> work." onChange={e=>setSample(e.target.value)}/></label>
        {note&&<p className="success small" role="status">{note}</p>}
      </section>
      <aside className="sub-inspector" aria-label="Settings">
        {kind?<>
          <div className="sub-inspector-head"><h3><span className="sub-dot" style={{background:draft.effects[kind[0]].color}}/>{kind[1]}</h3></div>
          {hidden(draft.effects[kind[0]].on,kind[1])}
          <Sections<EKey> prefix={`effect/${kind[0]}`} open={open} setOpen={setOpen} value={as(draft.effects[kind[0]])} saved={as(saved.effects[kind[0]])} set={(k,v)=>changeEffect(kind[0],{[k]:v})}
            sections={[{name:'Effect',fields:[{k:'on',label:'Shown',bool:true},{k:'color',label:'Color',color:true},{k:'opacity',label:'Opacity',unit:pct}]},{name:'Shape',fields:effectFields[kind[0]]}]}/>
        </>:selected&&<>
          <div className="sub-inspector-head"><h3><Icon name={selected.icon} size={18}/>{selected.label}</h3></div>
          {selected.toggle&&hidden(!!draft[selected.toggle],selected.label)}
          <Sections<Key> prefix={selected.id} open={open} setOpen={setOpen} value={as(draft)} saved={as(saved)} set={(k,v)=>change({[k]:v})}
            sections={selected.toggle?[{name:'Shown',fields:[{k:selected.toggle,label:'Shown',bool:true}]},...selected.sections]:selected.sections}/>
        </>}
      </aside>
    </div>
  </div>;
}
