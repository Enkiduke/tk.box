import {useEffect} from 'react';
import type {Principal} from '../../../packages/contracts/src/index.js';
import {Empty,Icon} from './components.js';
import {replaceRoute} from './hooks.js';
import {SectionHead,remember,remembered} from './settings-ui.js';
import {CustomChannelSettings} from './channels.js';
import {LiveSportsSettings,ServerPlaybackSettings,SourceSettings} from './admin-settings.js';
import {ConnectionsSettings} from './admin-connections.js';
import {ExploreAdmin} from './explore-settings.js';
import {ArtworkAdmin,CollectionsAdmin} from './artwork-admin.js';
import {CleanupAdmin} from './cleanup-admin.js';
import {ActivityAdmin} from './activity-admin.js';
import {AdminConsole} from './admin-console.js';
import {AdminsAdmin} from './admins-admin.js';
import './admin.css';

// The Admin console: server-wide settings and media management tools, apart from each viewer's own Settings.
// It is its own bundle, loaded only when an administrator opens it, so none of it reaches viewers or the player.
const groups=[
  ['Live TV',[['channels','Channels','shows'],['iptv','IPTV','live'],['sports','Live Events','star']]],
  ['Library',[['collections','Collections','collection'],['artwork','Artwork','image'],['explore','Explore','explore']]],
  ['Server',[['activity','Activity','play'],['admins','Admins','shield'],['connections','Connections','key'],['playback','Playback','speed'],['cleanup','Clean Up','trash']]]
] as const;
type Section=typeof groups[number][1][number][0];
// Admins is the server owner's alone.
const ownerOnly=new Set<string>(['admins']);
function PlaybackSection() {
  return <><SectionHead title="Playback"/><ServerPlaybackSettings/></>;
}
export function Admin({me,params}:{me:Principal;params:URLSearchParams}) {
  const sectionIds=groups.flatMap(([,items])=>items.map(([id])=>id as string)).filter(id=>me.owner||!ownerOnly.has(id));
  const asked=(s=>s==='keys'?'connections':s)(params.get('section')??remembered('admin','iptv')),current=(sectionIds.includes(asked)?asked:'iptv') as Section;
  const open=(id:string)=>{remember('admin',id);const next=new URLSearchParams();next.set('section',id);window.location.hash=`admin?${next}`;};
  // The open section is always in the address, so a reload or a shared link lands on it.
  useEffect(()=>{if(params.get('section')!==current)replaceRoute(`#admin?section=${current}`);},[current]);
  if(me.role!=='admin')return <Empty title="Administrator access required"><a href="#settings">Open your settings</a></Empty>;
  return <div className="settings admin">
    <div className="settings-title admin-title"><h1>Admin</h1><a href="#settings" className="small">Your settings</a></div>
    <div className="settings-layout">
      <nav className="settings-nav admin-nav" aria-label="Admin sections">{groups.map(([group,items])=><div key={group} className="admin-nav-group"><span className="admin-nav-heading">{group}</span>
        {items.filter(([id])=>me.owner||!ownerOnly.has(id)).map(([id,label,icon])=><button key={id} aria-current={current===id?'page':undefined} onClick={()=>open(id)}><Icon name={icon} size={18}/>{label}</button>)}</div>)}</nav>
      <div className="settings-main">{current==='channels'?<CustomChannelSettings/>:current==='iptv'?<SourceSettings/>:current==='sports'?<LiveSportsSettings/>
        :current==='collections'?<CollectionsAdmin/>:current==='artwork'?<ArtworkAdmin params={params}/>:current==='connections'?<ConnectionsSettings/>:current==='explore'?<ExploreAdmin/>:current==='cleanup'?<CleanupAdmin/>:current==='activity'?<ActivityAdmin/>:current==='admins'?<AdminsAdmin/>:<PlaybackSection/>}</div>
    </div>
    <AdminConsole/>
  </div>;
}
