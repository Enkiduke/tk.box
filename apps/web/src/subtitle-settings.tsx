import {useState} from 'react';
import {Icon,Modal} from './components.js';
import {Card} from './settings-ui.js';
import {captionLine} from './captions.js';
import {SubtitlePreview} from './subtitle-preview.js';
import {SubtitleStudio,unsavedCount} from './subtitle-studio.js';
import {CaptionCue,defaultSubtitleStyle,deleteCustomPreset,hasLook,parseSubtitleStyle,setSubtitleStyle,subtitleColors,subtitleRanges,subtitleSizes,subtitlePresets,updateSubtitleStyle,useCustomPresets,useSubtitleStyle,withLook,type SubtitleLook,type SubtitleStyle} from './subtitle-style.js';

function Swatches({label,value,onChange}:{label:string;value:string;onChange:(value:string)=>void}) {
  const custom=!subtitleColors.some(([c])=>c===value);
  return <div className="subtitle-field"><span>{label}</span><div className="swatches" role="radiogroup" aria-label={label}>
    {subtitleColors.map(([c,name])=><button key={c} type="button" role="radio" aria-checked={value===c} aria-label={name} title={name} className="swatch" style={{background:c}} onClick={()=>onChange(c)}/>)}
    <label className={`swatch swatch-custom ${custom?'selected':''}`} title="Custom color" style={custom?{background:value}:undefined}><input type="color" aria-label={`Custom ${label.toLowerCase()}`} value={value} onChange={e=>onChange(e.target.value)}/></label>
  </div></div>;
}
export function Options<T extends string>({label,options,value,onChange}:{label:string;options:readonly (readonly [T,string])[];value:T|undefined;onChange:(value:T)=>void}) {
  return <div className="subtitle-field"><span>{label}</span><div className="toggle-group" role="radiogroup" aria-label={label}>
    {options.map(([id,name])=><button key={id} type="button" role="radio" aria-checked={value===id} onClick={()=>onChange(id)}>{name}</button>)}</div></div>;
}

function PresetTile({name,look,style,onDelete}:{name:string;look:Partial<SubtitleLook>;style:SubtitleStyle;onDelete?:()=>void}) {
  const shown=withLook(defaultSubtitleStyle,look);
  return <div className="preset-tile">
    <button type="button" aria-pressed={hasLook(style,look)} onClick={()=>setSubtitleStyle(withLook(style,look))}>
      <span className="preset-sample" aria-hidden="true"><CaptionCue lines={[captionLine('Subtitles')]} style={shown}/></span>
      <span className="preset-name">{name}</span>
    </button>
    {onDelete&&<button type="button" className="icon-button preset-delete" aria-label={`Delete ${name}`} title="Delete preset" onClick={onDelete}><Icon name="close" size={14}/></button>}
  </div>;
}
const background=(style:SubtitleStyle)=>!style.backgroundOn?'off':style.backgroundShape;

// Per browser, so every viewer (not only administrators) sets their own. The studio's changes are a draft until saved,
// kept while it is closed.
export function SubtitleSettings() {
  const style=useSubtitleStyle(),custom=useCustomPresets(),set=updateSubtitleStyle,[studio,setStudio]=useState(false),[draft,setDraft]=useState<SubtitleStyle>();
  const unsaved=draft?unsavedCount(draft,style):0,[min,max,step]=subtitleRanges.position;
  return <Card title="Subtitles" actions={<>
    <button type="button" onClick={()=>{if(!draft)setDraft(style);setStudio(true);}}><Icon name="settings" size={16}/>Advanced{unsaved>0&&<span className="sub-unsaved">{unsaved} unsaved</span>}</button>
    <button type="button" onClick={()=>setSubtitleStyle(withLook(style,{}))}>Reset</button></>}>
    <div className="subtitle-settings">
      <SubtitlePreview style={style}/>
      <div className="subtitle-controls">
        <Options label="Size" options={subtitleSizes} value={style.size} onChange={size=>set({size,sizeScale:100})}/>
        <Swatches label="Text color" value={style.color} onChange={color=>set({color})}/>
        <Options label="Background" options={[['off','Off'],['line','Behind lines'],['block','One box']] as const} value={background(style)} onChange={b=>set(b==='off'?{backgroundOn:false}:{backgroundOn:true,backgroundShape:b})}/>
        <label className="subtitle-field"><span>{style.anchor==='top'?'Distance from top':'Distance from bottom'}<output>{style.position}%</output></span>
          <input type="range" min={min} max={max} step={step} value={style.position} onChange={e=>set({position:Number(e.target.value)})}/></label>
      </div>
    </div>
    <div className="subtitle-field subtitle-presets"><span>Presets</span><div className="preset-tiles">
      {subtitlePresets.map(([name,look])=><PresetTile key={name} name={name} look={look} style={style}/>)}
      {custom.map(p=><PresetTile key={`custom:${p.name}`} name={p.name} look={p.look} style={style} onDelete={()=>deleteCustomPreset(p.name)}/>)}
    </div></div>
    {studio&&draft&&<Modal title="Subtitle studio" onClose={()=>{setStudio(false);if(!unsavedCount(draft,style))setDraft(undefined);}}>
      <SubtitleStudio saved={style} draft={draft} setDraft={setDraft} save={()=>{const next=parseSubtitleStyle(draft as unknown as Record<string,unknown>);setSubtitleStyle(next);setDraft(next);}}/>
    </Modal>}
  </Card>;
}
