import {useState} from 'react';
import type {Principal} from '../../../packages/contracts/src/index.js';
import {Icon} from './components.js';
import {Card,SectionHead,remember,remembered} from './settings-ui.js';
import {SubtitleSettings} from './subtitle-settings.js';
import {HomePageSettings} from './home-page-settings.js';
import {ExploreSettings} from './explore-settings.js';

// Each viewer's own settings. Server-wide settings live in the Admin console (admin.tsx).
function PlaybackSettings() {
  return <><SectionHead title="Playback" description="How subtitles look for you."/><SubtitleSettings/></>;
}
function AccountSettings({me,onLogout}:{me:Principal;onLogout:()=>void}) {
  const admin=me.role==='admin';
  return <><SectionHead title="Account"/>
    <Card><div className="account-row"><span className="account-avatar" aria-hidden="true">{me.accountId.slice(0,1).toUpperCase()}</span><div className="grow"><strong>Plex account {me.accountId}</strong><p className="muted small">{admin?'Administrator · manages sources and shared settings':'Viewer'}</p></div><button onClick={onLogout}>Sign out</button></div></Card>
    {admin&&<Card title="Admin console" description="Channels, IPTV, live sports, artwork, connections and server playback settings." actions={<button onClick={()=>{window.location.hash='admin';}}>Open Admin</button>}/>}
  </>;
}
const sections=[['home','Home','home'],['playback','Playback','speed'],['explore','Explore','explore'],['account','Account','info']] as const;
export function Settings({me,onLogout}:{me:Principal;onLogout:()=>void}) {
  const admin=me.role==='admin',[section,setSectionState]=useState(()=>remembered('personal','home'));
  const setSection=(s:string)=>{setSectionState(s);remember('personal',s);};
  const current=sections.some(s=>s[0]===section)?section:'home';
  return <div className="settings">
    <div className="settings-title"><h1>Settings</h1><p className="muted">Your Home page, subtitle style, Explore accounts and sign-in.{admin&&<> Server settings are in the <a href="#admin">Admin console</a>.</>}</p></div>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">{sections.map(([id,label,icon])=><button key={id} aria-current={current===id?'page':undefined} onClick={()=>setSection(id)}><Icon name={icon} size={18}/>{label}</button>)}
        {admin&&<a className="settings-nav-link" href="#admin"><Icon name="shield" size={18}/>Admin console</a>}</nav>
      <div className="settings-main">{current==='home'?<HomePageSettings/>:current==='playback'?<PlaybackSettings/>:current==='explore'?<ExploreSettings admin={admin}/>:<AccountSettings me={me} onLogout={onLogout}/>}</div>
    </div>
  </div>;
}
