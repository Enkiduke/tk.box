import {Card,SectionHead,Switch} from './settings-ui.js';
import {Options} from './subtitle-settings.js';
import {defaultHomeSettings,liveCounts,liveSpeeds,setHomeSettings,updateHomeSettings,useHomeSettings} from './home-settings.js';

const counts=liveCounts.map(n=>[String(n),String(n)] as const);
// Per browser, so every viewer (not only administrators) sets their own.
export function HomePageSettings() {
  const settings=useHomeSettings(),set=updateHomeSettings;
  return <><SectionHead title="Home" description="What the Home page shows in this browser. Changes apply right away."/>
    <Card title="Live TV row" description="The row of channels on now: your favorites, or the start of the lineup when you have none." actions={<button type="button" onClick={()=>setHomeSettings(defaultHomeSettings)}>Reset to default</button>}>
      <div className="home-settings">
        <Switch label="Show Live TV on Home" checked={settings.liveRow} onChange={liveRow=>set({liveRow})}/>
        {settings.liveRow&&<>
          <Options label="Channels" options={counts} value={String(settings.liveCount)} onChange={n=>set({liveCount:Number(n)})}/>
          <Switch label="Shuffle channels" description="A new order each time you open Home, picked from the first 60 channels." checked={settings.liveShuffle} onChange={liveShuffle=>set({liveShuffle})}/>
          <Switch label="Scroll endlessly" description="The row drifts sideways and wraps around. It holds still while your mouse is over it." checked={settings.liveScroll} onChange={liveScroll=>set({liveScroll})}/>
          {settings.liveScroll&&<Options label="Scroll speed" options={liveSpeeds} value={settings.liveSpeed} onChange={liveSpeed=>set({liveSpeed})}/>}
        </>}
      </div>
    </Card>
  </>;
}
