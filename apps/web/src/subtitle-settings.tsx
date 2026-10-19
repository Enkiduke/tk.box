import {useEffect,useRef,useState} from 'react';
import {Card,Switch,remember,remembered} from './settings-ui.js';
import {captionLine} from './captions.js';
import {CaptionCue,defaultSubtitleStyle,positionRange,setSubtitleStyle,subtitleColors,subtitleEdges,subtitleFonts,subtitlePresets,subtitleScale,subtitleSizes,updateSubtitleStyle,useSubtitleStyle,type SubtitleStyle} from './subtitle-style.js';

const sample=['I told you we’d make it before sunrise.','<i>Nobody ever listens to me.</i>'].map(captionLine);
const scenes=[['night','Dark scene'],['day','Bright scene'],['busy','Busy scene']] as const;
type Scene=typeof scenes[number][0];
const matches=(style:SubtitleStyle,preset:Partial<SubtitleStyle>)=>Object.entries({...defaultSubtitleStyle,...preset,size:style.size,position:style.position}).every(([k,v])=>style[k as keyof SubtitleStyle]===v);

function Swatches({label,value,onChange}:{label:string;value:string;onChange:(value:string)=>void}) {
  const custom=!subtitleColors.some(([c])=>c===value);
  return <div className="subtitle-field"><span>{label}</span><div className="swatches" role="radiogroup" aria-label={label}>
    {subtitleColors.map(([c,name])=><button key={c} type="button" role="radio" aria-checked={value===c} aria-label={name} title={name} className="swatch" style={{background:c}} onClick={()=>onChange(c)}/>)}
    <label className={`swatch swatch-custom ${custom?'selected':''}`} title="Custom color" style={custom?{background:value}:undefined}><input type="color" aria-label={`Custom ${label.toLowerCase()}`} value={value} onChange={e=>onChange(e.target.value)}/></label>
  </div></div>;
}
function Options<T extends string>({label,options,value,onChange}:{label:string;options:readonly (readonly [T,string])[];value:T;onChange:(value:T)=>void}) {
  return <div className="subtitle-field"><span>{label}</span><div className="toggle-group" role="radiogroup" aria-label={label}>
    {options.map(([id,name])=><button key={id} type="button" role="radio" aria-checked={value===id} onClick={()=>onChange(id)}>{name}</button>)}</div></div>;
}
function Slider({label,value,min,max,step=5,unit='%',onChange}:{label:string;value:number;min:number;max:number;step?:number;unit?:string;onChange:(value:number)=>void}) {
  return <label className="subtitle-field"><span>{label}<output>{value}{unit}</output></span><input type="range" min={min} max={max} step={step} value={value} onChange={e=>onChange(Number(e.target.value))}/></label>;
}
// Stands in for the picture: same proportions and font scaling as the player.
function Preview({style}:{style:SubtitleStyle}) {
  const ref=useRef<HTMLDivElement>(null),[height,setHeight]=useState(0),[scene,setSceneState]=useState<Scene>(()=>remembered('subtitleScene','night') as Scene);
  const setScene=(s:Scene)=>{setSceneState(s);remember('subtitleScene',s);};
  useEffect(()=>{const element=ref.current;if(!element)return;const observer=new ResizeObserver(()=>setHeight(element.clientHeight));observer.observe(element);return()=>observer.disconnect();},[]);
  const [scale,minimum]=subtitleScale[style.size];
  return <div className="subtitle-preview-wrap">
    <div ref={ref} className={`subtitle-preview scene-${scene}`} aria-label="Subtitle preview" role="img">
      <div className="player-captions" style={{bottom:height*style.position/100,fontSize:Math.max(minimum,height*scale)}}><CaptionCue lines={sample} style={style}/></div>
    </div>
    <div className="segmented subtitle-scenes" role="group" aria-label="Preview background">{scenes.map(([id,name])=><button key={id} type="button" aria-pressed={scene===id} onClick={()=>setScene(id)}>{name}</button>)}</div>
  </div>;
}
// Per browser, so every viewer (not only administrators) sets their own.
export function SubtitleSettings() {
  const style=useSubtitleStyle(),set=updateSubtitleStyle;
  return <Card title="Subtitles" description="How subtitles look in this browser. Changes apply right away, including to anything playing now." actions={<button type="button" onClick={()=>setSubtitleStyle({...defaultSubtitleStyle,size:style.size})}>Reset to default</button>}>
    <div className="subtitle-settings">
      <div className="subtitle-preview-col">
        <Preview style={style}/>
        <div className="subtitle-field"><span>Presets</span><div className="preset-row">{subtitlePresets.map(([name,preset])=><button key={name} type="button" aria-pressed={matches(style,preset)} onClick={()=>setSubtitleStyle({...defaultSubtitleStyle,...preset,size:style.size,position:style.position})}>{name}</button>)}</div></div>
      </div>
      <div className="subtitle-controls">
        <h4>Text</h4>
        <Options label="Size" options={subtitleSizes} value={style.size} onChange={size=>set({size})}/>
        <label className="subtitle-field"><span>Font</span><select value={style.font} onChange={e=>set({font:e.target.value as SubtitleStyle['font']})}>{subtitleFonts.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>
        <Switch label="Bold text" checked={style.bold} onChange={bold=>set({bold})}/>
        <Swatches label="Text color" value={style.color} onChange={color=>set({color})}/>
        <Slider label="Text opacity" value={style.textOpacity} min={20} max={100} onChange={textOpacity=>set({textOpacity})}/>
        <h4>Edge</h4>
        <label className="subtitle-field"><span>Edge style</span><select value={style.edge} onChange={e=>set({edge:e.target.value as SubtitleStyle['edge']})}>{subtitleEdges.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>
        {style.edge!=='none'&&<Swatches label="Edge color" value={style.edgeColor} onChange={edgeColor=>set({edgeColor})}/>}
        <h4>Background</h4>
        <Slider label="Background opacity" value={style.backgroundOpacity} min={0} max={100} onChange={backgroundOpacity=>set({backgroundOpacity})}/>
        {style.backgroundOpacity>0&&<>
          <Swatches label="Background color" value={style.background} onChange={background=>set({background})}/>
          <Options label="Shape" options={[['line','Behind each line'],['block','One box']] as const} value={style.backgroundShape} onChange={backgroundShape=>set({backgroundShape})}/>
        </>}
        <h4>Position</h4>
        <Slider label="Distance from bottom" value={style.position} min={positionRange[0]} max={positionRange[1]} step={1} onChange={position=>set({position})}/>
        <small className="muted">Subtitles still move up while the player controls are showing.</small>
      </div>
    </div>
  </Card>;
}
