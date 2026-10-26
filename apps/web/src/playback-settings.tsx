import type {ReactNode} from 'react';
import {preferredLanguages,qualityTiers,type Quality} from '../../../packages/contracts/src/index.js';
import {Card} from './settings-ui.js';
import {countdownChoices,defaultPlayerPreferences,subtitleModes,updatePlayerPreferences,usePlayerPreferences,type PlayerPreferences} from './player-preferences.js';

const qualities:[Quality,string][]=[['auto','Auto'],['original','Original'],...qualityTiers.map(t=>[t.id,`${t.height}p · ${t.bitrateKbps/1000} Mbps`] as [Quality,string])];
const subtitleHelp={plex:'Uses the subtitle Plex has selected for the title.',always:'Turns on a full subtitle track in your language.',forced:'Only subtitles for foreign-language dialogue and signs.',off:'Subtitles stay off until you turn them on.'};

// One setting across the card: what it does on the left, its control on the right. `nested` rows refine the row above.
function Pref({label,description,nested,switchRow,children}:{label:string;description?:ReactNode;nested?:boolean;switchRow?:boolean;children:ReactNode}) {
  const content=<><span className="pref-text"><strong>{label}</strong>{description&&<small>{description}</small>}</span><span className="pref-control">{children}</span></>;
  const className=`pref-row${nested?' nested':''}`;
  return switchRow?<label className={className}>{content}</label>:<div className={className}>{content}</div>;
}
function Segmented<T extends string>({label,options,value,onChange}:{label:string;options:readonly (readonly [T,string])[];value:T;onChange:(value:T)=>void}) {
  return <div className="toggle-group" role="radiogroup" aria-label={label}>{options.map(([id,name])=><button key={id} type="button" role="radio" aria-checked={value===id} onClick={()=>onChange(id)}>{name}</button>)}</div>;
}
// A saved code outside the list (picked from a track in the player) still shows as itself.
function LanguageSelect({label,value,none,onChange}:{label:string;value:string|null;none:string;onChange:(value:string|null)=>void}) {
  const listed=!value||preferredLanguages.some(([code])=>code===value);
  return <select aria-label={label} value={value??''} onChange={e=>onChange(e.target.value||null)}>
    <option value="">{none}</option>
    {!listed&&<option value={value}>{value.toUpperCase()}</option>}
    {preferredLanguages.map(([code,name])=><option key={code} value={code}>{name}</option>)}
  </select>;
}
const Toggle=({checked,onChange}:{checked:boolean;onChange:(value:boolean)=>void})=><input type="checkbox" role="switch" className="switch" checked={checked} onChange={e=>onChange(e.target.checked)}/>;

// Per browser, like subtitle styling; the player changes some of these too (Autoplay, auto-skip, the subtitle picked).
export function PlaybackPreferences() {
  const prefs=usePlayerPreferences(),set=(patch:Partial<PlayerPreferences>)=>updatePlayerPreferences(patch);
  return <>
    <Card title="Starting a title" description="Applies to the next title you play in this browser." actions={<button type="button" onClick={()=>set({startFrom:defaultPlayerPreferences.startFrom,quality:defaultPlayerPreferences.quality,audioLanguage:null})}>Reset to default</button>}>
      <div className="pref-list">
        <Pref label="Partly watched titles" description="What a plain Play does. Resume and Start over buttons still do what they say.">
          <Segmented label="Partly watched titles" options={[['resume','Resume'],['beginning','From the beginning']] as const} value={prefs.startFrom} onChange={startFrom=>set({startFrom})}/>
        </Pref>
        <Pref label="Default quality" description="A lower quality converts the video and needs a free encoder. A title that can’t play at this quality starts on Auto. You can still change it from the player.">
          <select aria-label="Default quality" value={prefs.quality} onChange={e=>set({quality:e.target.value as Quality})}>{qualities.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select>
        </Pref>
        <Pref label="Audio language" description="Titles with a track in this language start on it. A track other than the file’s default plays through Plex instead of Direct Play.">
          <LanguageSelect label="Audio language" value={prefs.audioLanguage} none="Plex default" onChange={audioLanguage=>set({audioLanguage})}/>
        </Pref>
      </div>
    </Card>
    <Card title="Subtitle tracks" description="Which subtitles turn on when a title starts. Picking a track in the player updates this.">
      <div className="pref-list">
        <Pref label="Subtitles" description={subtitleHelp[prefs.subtitleMode]}>
          <Segmented label="Subtitles" options={subtitleModes} value={prefs.subtitleMode} onChange={subtitleMode=>set({subtitleMode})}/>
        </Pref>
        {(prefs.subtitleMode==='always'||prefs.subtitleMode==='forced')&&<Pref nested label="Subtitle language" description="A title with no track in this language starts without subtitles.">
          <LanguageSelect label="Subtitle language" value={prefs.subtitleLanguage} none="Any language" onChange={subtitleLanguage=>set({subtitleLanguage})}/>
        </Pref>}
      </div>
    </Card>
    <Card title="Up next" description="What happens around the end of a title.">
      <div className="pref-list">
        <Pref switchRow label="Autoplay the next title" description="In a show or collection, the next title plays after a countdown."><Toggle checked={prefs.autoplay} onChange={autoplay=>set({autoplay})}/></Pref>
        {prefs.autoplay&&<Pref nested label="Countdown">
          <Segmented label="Countdown" options={countdownChoices.map(c=>[String(c),`${c}s`] as const)} value={String(prefs.countdownSeconds)} onChange={c=>set({countdownSeconds:Number(c)})}/>
        </Pref>}
        <Pref switchRow label="Skip intros automatically" description="Jumps past intros Plex has detected. Seeking back into one plays it."><Toggle checked={prefs.skipIntros} onChange={skipIntros=>set({skipIntros})}/></Pref>
        <Pref switchRow label="Skip credits automatically" description="Jumps past credits, which can skip a scene during or after them."><Toggle checked={prefs.skipCredits} onChange={skipCredits=>set({skipCredits})}/></Pref>
      </div>
    </Card>
  </>;
}
