import {useEffect} from 'react';
import type {Principal} from '../../../packages/contracts/src/index.js';
import {Empty,Icon} from './components.js';
import {link,replaceRoute} from './hooks.js';
import {Tabs} from './manage-ui.js';
import {SectionHead,remember,remembered} from './settings-ui.js';
import {CustomChannelSettings} from './channels.js';
import {LiveSportsSettings,ServerPlaybackSettings,SourceSettings} from './admin-settings.js';
import {ConnectionsSettings} from './admin-connections.js';
import {ExploreAdmin} from './explore-admin.js';
import {ArtworkAdmin,CollectionsAdmin} from './artwork-admin.js';
import {CleanupAdmin} from './cleanup-admin.js';
import {RequestsAdmin} from './requests-admin.js';
import {ActivityAdmin} from './activity-admin.js';
import {HistoryAdmin} from './history-admin.js';
import {AdminConsole} from './admin-console.js';
import {UsersAdmin} from './users-admin.js';
import {ScheduleAdmin} from './schedule-admin.js';
import {DownloadHistoryPage,DownloadsPage,WantedPage} from './downloads-admin.js';
import {MoviesPage} from './movies-admin.js';
import {MovieDialog} from './movie-dialog.js';
import {ShowsPage} from './shows-admin.js';
import type {TitlePane} from './manage-ui.js';
import {PickRulesPage} from './pick-rules-admin.js';
import {LibrarySettingsPage} from './library-settings-admin.js';
import {SubtitlesPage} from './subtitles-admin.js';
import './admin.css';

export {ConnectionsRecovery} from './admin-connections.js';

// The Admin console: server-wide settings and media management tools, apart from each viewer's own Settings.
// It is its own bundle, loaded only when an administrator opens it, so none of it reaches viewers or the player.
// Manage: what's on the server and how it looks in Plex. Downloads: getting new things in, from a request to an
// imported file. Application: what viewers get in tk.box. Server: who uses it, what it connects to, and its jobs.
const groups=[
  ['Manage',[['movies','Movies','movies'],['shows','Shows','shows'],['channels','Channels','shows'],['iptv','IPTV','live'],['collections','Collections','collection'],['artwork','Artwork','image'],['cleanup','Clean Up','trash']]],
  ['Downloads',[['requests','Requests','download'],['wanted','Wanted','search'],['queue','Queue','queue'],['download-history','History','history'],['rules','Quality','filter'],['subtitles','Subtitles','captions'],['download-settings','Settings','gear']]],
  ['Application',[['explore','Explore','explore'],['playback','Playback','speed']]],
  ['Server',[['activity','Activity','play'],['users','Users','users'],['connections','Connections','key'],['schedule','Schedule','clock']]]
] as const;
// The address with a title's dialog open on a tab (and a show's search on a season or episode), or closed.
const panes=new Set<string>(['files','grabs','requests','history','search']);
function withMovie(params:URLSearchParams,title?:string,pane?:TitlePane,scope?:string) {
  const query=new URLSearchParams(params);
  query.delete('title');query.delete('pane');query.delete('scope');
  if(title){query.set('title',title);if(pane&&panes.has(pane))query.set('pane',pane);if(pane==='search'&&scope)query.set('scope',scope);}
  return `#admin?${query}`;
}
// Pages that moved or were renamed, by their old id.
const renamed:Record<string,string>={keys:'connections',history:'activity',admins:'users','library-settings':'download-settings',sports:'iptv'};
// IPTV: its sources, and Live Events, whose schedules come from them.
function IptvPage({params}:{params:URLSearchParams}) {
  const events=params.get('view')==='events';
  const tabs=<Tabs label="IPTV" value={events?'events':'sources'} onChange={v=>replaceRoute(link('admin',{section:'iptv',...(v==='events'?{view:'events'}:{})}))}
    tabs={[{id:'sources',label:'Sources'},{id:'events',label:'Live Events'}]}/>;
  return events?<LiveSportsSettings tabs={tabs}/>:<SourceSettings tabs={tabs}/>;
}
type Section=typeof groups[number][1][number][0];
const ownerOnly=new Set<string>(['users']);
function PlaybackSection() {
  return <><SectionHead title="Playback"/><ServerPlaybackSettings/></>;
}
export function Admin({me,params}:{me:Principal;params:URLSearchParams}) {
  const sectionIds=groups.flatMap(([,items])=>items.map(([id])=>id as string)).filter(id=>me.owner||!ownerOnly.has(id));
  const section=params.get('section');
  const requested=section??remembered('admin','movies');
  // Old Downloads links: its tabs are pages of their own now, and a title opens under Movies.
  const tab=params.get('tab'),title=params.get('title');
  const downloadsPage=title?'movies':tab==='wanted'?'wanted':tab==='rules'?'rules':tab==='library'?'download-settings':'queue';
  // Queue's Jobs tab (once Queue's Queue tab) lives in Schedule now.
  const oldJobs=requested==='queue'&&(params.get('view')==='jobs'||params.get('view')==='queue');
  const asked=oldJobs?'schedule':requested==='downloads'?downloadsPage:renamed[requested]??requested;
  const current=(sectionIds.includes(asked)?asked:'movies') as Section;
  const open=(id:string)=>{remember('admin',id);const next=new URLSearchParams();next.set('section',id);window.location.hash=`admin?${next}`;};
  // The open section is always in the address, so a reload or a shared link lands on it. History keeps its filters,
  // and Movies the title it opens.
  const query=section==='history'?new URLSearchParams(params):new URLSearchParams();
  query.set('section',current);
  // A movie's dialog stays open over whichever page it was opened on.
  if(title){query.set('title',title);const pane=params.get('pane'),scope=params.get('scope');if(pane)query.set('pane',pane);if(scope)query.set('scope',scope);}
  // Views inside a page: Queue's status filter, and IPTV's Live Events (the old Live Events page).
  const view=section==='sports'?'events':params.get('view');
  if(view&&(current==='queue'||current==='iptv'))query.set('view',view);
  const canonicalRoute=section===current?undefined:`#admin?${query}`;
  useEffect(()=>{if(canonicalRoute)replaceRoute(canonicalRoute);},[canonicalRoute]);
  if(me.role!=='admin')return <Empty title="Administrator access required"><a href="#settings">Open your settings</a></Empty>;
  return <div className="settings admin">
    <div className="settings-title admin-title"><h1>Admin</h1></div>
    <div className="settings-layout">
      <nav className="settings-nav admin-nav" aria-label="Admin sections">{groups.map(([group,items])=><div key={group} className="admin-nav-group"><span className="admin-nav-heading">{group}</span>
        <div className="admin-nav-items">{items.filter(([id])=>me.owner||!ownerOnly.has(id)).map(([id,label,icon])=><button key={id} aria-current={current===id?'page':undefined} onClick={()=>open(id)}><Icon name={icon} size={18}/>{label}</button>)}</div></div>)}</nav>
      <div className="settings-main">{current==='channels'?<CustomChannelSettings/>:current==='iptv'?<IptvPage params={params}/>
        :current==='collections'?<CollectionsAdmin/>:current==='artwork'?<ArtworkAdmin params={params}/>:current==='connections'?<ConnectionsSettings params={params}/>:current==='explore'?<ExploreAdmin params={params}/>:current==='requests'?<RequestsAdmin/>:current==='queue'?<DownloadsPage params={params}/>:current==='download-history'?<DownloadHistoryPage/>:current==='wanted'?<WantedPage/>:current==='movies'?<MoviesPage/>:current==='shows'?<ShowsPage/>:current==='rules'?<PickRulesPage/>:current==='download-settings'?<LibrarySettingsPage/>:current==='subtitles'?<SubtitlesPage/>:current==='cleanup'?<CleanupAdmin/>:current==='activity'?<><ActivityAdmin/><HistoryAdmin params={params}/></>:current==='users'?<UsersAdmin/>:current==='schedule'?<ScheduleAdmin/>:<PlaybackSection/>}</div>
    </div>
    {Number(title)>0&&<MovieDialog key={title} id={Number(title)} pane={(panes.has(params.get('pane')??'')?params.get('pane'):'overview') as TitlePane}
      scope={params.get('scope')??undefined} setPane={(pane,scope)=>replaceRoute(withMovie(params,title!,pane,scope))}
      onClose={()=>replaceRoute(withMovie(params))}/>}
    <AdminConsole/>
  </div>;
}
