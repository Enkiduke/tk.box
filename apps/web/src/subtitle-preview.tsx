import {useEffect,useRef,useState} from 'react';
import {Icon} from './components.js';
import {captionLine} from './captions.js';
import {CaptionCue,captionBox,subtitleFontSize,type SubtitleStyle} from './subtitle-style.js';

// The preview rotates through scenes that each test the style differently: dark, bright, snow-white, busy and colourful.
const scenes=[
  ['night','Night',['I told you we’d make it before sunrise.','<i>Nobody ever listens to me.</i>']],
  ['day','Daylight',['Not a cloud anywhere.','Perfect day for it.']],
  ['snow','Snow',['<i>It’s colder than they said.</i>','Keep walking. Don’t look back.']],
  ['busy','Crowd',['Stay close. It gets busy past the market.']],
  ['sunset','Sunset',['We should head back.','Not yet. Just a little longer.']],
  ['neon','Neon',['[distant sirens]','You hear that? They found us.']],
] as const;
const sceneLines=scenes.map(([,,lines])=>lines.map(captionLine));
const reducedMotion=()=>typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;

// Stands in for the picture: same proportions and font scaling as the player, cycling through scenes on its own.
// `sample` replaces the scenes' lines (one cue line per text line, with <i>, <b> and <u> tags).
export function SubtitlePreview({style,sample,className}:{style:SubtitleStyle;sample?:string;className?:string}) {
  const ref=useRef<HTMLDivElement>(null),[height,setHeight]=useState(0),[scene,setScene]=useState(0),[playing,setPlaying]=useState(()=>!reducedMotion());
  useEffect(()=>{const element=ref.current;if(!element)return;const observer=new ResizeObserver(()=>setHeight(element.clientHeight));observer.observe(element);return()=>observer.disconnect();},[]);
  useEffect(()=>{if(!playing)return;const timer=setInterval(()=>setScene(s=>(s+1)%scenes.length),4500);return()=>clearInterval(timer);},[playing]);
  const offset=height*style.position/100,custom=sample?.split('\n').filter(l=>l.trim()).map(captionLine);
  return <div className={`subtitle-preview-wrap ${className??''}`}>
    <div ref={ref} className="subtitle-preview" aria-label={`Subtitle preview, ${scenes[scene]![1]} scene`} role="img">
      {scenes.map(([id],i)=><div key={id} className={`subtitle-scene scene-${id} ${i===scene?'active':''}`}/>)}
      <div className="player-captions" style={{...captionBox(style),...(style.anchor==='top'?{top:offset}:{bottom:offset}),fontSize:subtitleFontSize(style,height)}}><CaptionCue key={custom?'custom':scene} lines={custom?.length?custom:sceneLines[scene]!} style={style}/></div>
    </div>
    <div className="subtitle-scenes">
      <button type="button" className="icon-button" aria-label={playing?'Pause scenes':'Play scenes'} title={playing?'Pause':'Play'} onClick={()=>setPlaying(p=>!p)}><Icon name={playing?'pause':'play'} size={16}/></button>
      {scenes.map(([id,name],i)=><button key={id} type="button" className="scene-dot" aria-pressed={i===scene} aria-label={name} title={name} onClick={()=>{setScene(i);setPlaying(false);}}/>)}
      <span className="muted small">{scenes[scene]![1]}</span>
    </div>
  </div>;
}
