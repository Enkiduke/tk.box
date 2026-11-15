import {useEffect,useRef,useState,type ReactNode} from 'react';
import {api,ApiClientError} from './api.js';
import {ErrorNotice} from './components.js';
import {openPlexPopup} from './plex-popup.js';

// Sign in with Plex: opens Plex's sign-in window and checks every few seconds until it finishes. Used by the main app
// and the Requests site; `children` is the card's heading.
export function PlexSignIn({onSignedIn,children}:{onSignedIn:()=>void;children:ReactNode}) {
  const [authUrl,setAuthUrl]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const popup=useRef<Window|null>(null),locking=useRef(false);
  async function check() {
    const result=await api<{status:string}>('/auth/plex/status','POST');
    if(result.status==='authenticated'){setAuthUrl('');popup.current?.close();popup.current=null;onSignedIn();}
  }
  async function action(fn:()=>Promise<void>) {if(locking.current)return;locking.current=true;setBusy(true);setError('');try{await fn();}catch(e){setError((e as Error).message);}finally{locking.current=false;setBusy(false);}}
  useEffect(()=>{if(!authUrl)return;let running=false;const timer=setInterval(()=>{if(running)return;running=true;void check().catch(e=>{if(e instanceof ApiClientError&&['AUTH_EXPIRED','PLEX_ACCESS_DENIED'].includes(e.code)){setAuthUrl('');setError(e.message);}}).finally(()=>{running=false;});},3000);return()=>clearInterval(timer);},[authUrl]);
  const start=()=>{
    if(locking.current)return;const opened=openPlexPopup();popup.current=opened;
    void action(async()=>{try{const result=await api<{authUrl:string}>('/auth/plex/start','POST');setAuthUrl(result.authUrl);if(opened&&!opened.closed)opened.location.href=result.authUrl;else popup.current=openPlexPopup(result.authUrl)??(window.open(result.authUrl,'_blank','noopener,noreferrer'),null);}catch(e){opened?.close();throw e;}});
  };
  return <div className="sign-in-card">{children}
    {error&&<ErrorNotice message={error} dismiss={()=>setError('')}/>}
    <button className="primary large" disabled={busy} onClick={start}>Sign in with Plex</button>
    {authUrl&&<div className="linking"><span className="spinner"/><p>Finish signing in in the Plex window. tk.box connects automatically.</p><a href={authUrl} target="_blank" rel="noreferrer" onClick={event=>{const opened=openPlexPopup(authUrl);if(opened){event.preventDefault();popup.current=opened;}}}>Reopen Plex sign-in</a><button className="text-button" disabled={busy} onClick={()=>void action(check)}>I've signed in</button></div>}
    <small className="muted">Your Plex password stays with Plex.</small></div>;
}
