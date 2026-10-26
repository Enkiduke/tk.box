import {useEffect,useRef,useState} from 'react';
import {api,ApiClientError} from './api.js';
import {Icon,ErrorNotice} from './components.js';
import {openPlexPopup} from './plex-popup.js';

type Library={key:string;title:string;type:string};
type SignedIn={status:'signed_in';libraries:Library[];selected:string[]};
type Tool={path:string;version:string|null};
type Tools={ffmpeg:Tool;ffprobe:Tool;python:Tool};
type Step='find'|'signin'|'libraries'|'tools'|'restart';
const steps:[Step,string][]=[['find','Plex server'],['signin','Sign in'],['libraries','Libraries'],['tools','Tools']];
const toolInfo:[keyof Tools,string,string][]=[
  ['ffmpeg','FFmpeg','Live TV, custom channels and subtitles.'],
  ['ffprobe','FFprobe','Checks live streams before they play.'],
  ['python','Python','Artwork and cleanup. Use a virtual environment with their requirements installed.']
];

// First run, before Plex is set up: finds the Plex server, signs in its owner, picks the libraries and checks the
// tools, then saves everything to .env and signs the owner in.
export function FirstRun({plexUrl,onDone}:{plexUrl?:string;onDone:()=>void}) {
  const [step,setStep]=useState<Step>('find'),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [found,setFound]=useState<string>(),[address,setAddress]=useState(''),[looking,setLooking]=useState(true);
  const [authUrl,setAuthUrl]=useState(''),popup=useRef<Window|null>(null);
  const [libraries,setLibraries]=useState<Library[]>([]),[chosen,setChosen]=useState<string[]>([]);
  const [tools,setTools]=useState<Tools>(),[paths,setPaths]=useState<Record<keyof Tools,string>>({ffmpeg:'',ffprobe:'',python:''});
  async function run(fn:()=>Promise<void>) {if(busy)return;setBusy(true);setError('');try{await fn();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function find(url?:string) {
    setLooking(true);
    try {
      const result=await api<{found:boolean;plexUrl:string}>('/setup/plex/find','POST',url===undefined?{}:{url});
      if(result.found){setFound(result.plexUrl);setStep('signin');}
      else{setAddress(current=>current||result.plexUrl);if(url!==undefined)setError(`No Plex server answered at ${result.plexUrl}.`);}
    } finally {setLooking(false);}
  }
  // Plex usually runs on this computer, so look there before asking.
  useEffect(()=>{void find().catch(e=>setError((e as Error).message));},[]);
  useEffect(()=>{
    if(!authUrl)return;let running=false;
    const timer=setInterval(()=>{
      if(running)return;running=true;
      void api<SignedIn|{status:'pending'}>('/setup/plex/status','POST').then(result=>{
        if(result.status!=='signed_in')return;
        setAuthUrl('');popup.current?.close();popup.current=null;
        setLibraries(result.libraries);setChosen(result.selected);setStep('libraries');
      }).catch(e=>{if(e instanceof ApiClientError&&e.code!=='POLL_TOO_FAST'){setAuthUrl('');setError(e.message);}}).finally(()=>{running=false;});
    },3000);
    return()=>clearInterval(timer);
  },[authUrl]);
  const signIn=()=>{const window_=openPlexPopup();popup.current=window_;void run(async()=>{
    try{const result=await api<{authUrl:string}>('/setup/plex/start','POST');setAuthUrl(result.authUrl);if(window_&&!window_.closed)window_.location.href=result.authUrl;else popup.current=openPlexPopup(result.authUrl);}
    catch(e){window_?.close();throw e;}
  });};
  const checkTools=()=>run(async()=>{
    const body=Object.fromEntries(Object.entries(paths).filter(([,value])=>value.trim()));
    const result=await api<Tools>('/setup/tools','POST',body);setTools(result);
    // A found tool keeps the path it was found at; a missing one keeps what was typed for it.
    setPaths(current=>({ffmpeg:result.ffmpeg.version?result.ffmpeg.path:current.ffmpeg,ffprobe:result.ffprobe.version?result.ffprobe.path:current.ffprobe,python:result.python.version?result.python.path:current.python}));
  });
  const finish=()=>run(async()=>{
    const result=await api<{restartNeeded:boolean}>('/setup/finish','POST',{libraries:chosen,ffmpeg:paths.ffmpeg||undefined,ffprobe:paths.ffprobe||undefined,python:paths.python||undefined});
    if(result.restartNeeded)setStep('restart');else onDone();
  });
  const movies=libraries.filter(l=>l.type==='movie'),shows=libraries.filter(l=>l.type==='show');
  const enough=chosen.some(key=>movies.some(l=>l.key===key))&&chosen.some(key=>shows.some(l=>l.key===key));
  const toggle=(key:string)=>setChosen(current=>current.includes(key)?current.filter(k=>k!==key):[...current,key]);
  const position=steps.findIndex(([id])=>id===step);

  return <div className="first-run">
    <span className="brand large">tk.box</span>
    <h1>Let's set up tk.box</h1>
    <p className="muted">Connect your Plex server. It takes about a minute, and you only do it once.</p>
    {step!=='restart'&&<ol className="first-run-steps">{steps.map(([id,label],i)=><li key={id} className={i<position?'done':i===position?'current':''}>
      <span className="first-run-dot">{i<position?<Icon name="check" size={14}/>:i+1}</span>{label}</li>)}</ol>}
    {error&&<ErrorNotice message={error} dismiss={()=>setError('')}/>}

    {step==='find'&&<section className="first-run-panel">
      <h2>Find your Plex server</h2>
      {looking&&!address?<div className="first-run-status"><span className="spinner"/><p>Looking for Plex at {plexUrl??'this computer'}…</p></div>
      :<form onSubmit={event=>{event.preventDefault();void run(()=>find(address));}}>
        <p className="muted">Plex didn't answer on this computer. Enter the address of the computer Plex runs on.</p>
        <label>Plex server address<input value={address} onChange={event=>setAddress(event.target.value)} placeholder="192.168.1.20" autoFocus/>
          <small>An IP address or name works. Port 32400 is used unless you add one.</small></label>
        <div className="button-row"><button className="primary" disabled={busy||!address.trim()}>{busy?'Connecting…':'Connect'}</button></div>
      </form>}
    </section>}

    {step==='signin'&&<section className="first-run-panel">
      <h2>Sign in with Plex</h2>
      <p className="first-run-found"><Icon name="check" size={16}/>Found Plex at {found}</p>
      <p className="muted">Sign in with the Plex account that owns this server. That account becomes tk.box's owner.</p>
      <button className="primary large" disabled={busy||!!authUrl} onClick={signIn}>Sign in with Plex</button>
      {authUrl&&<div className="linking"><span className="spinner"/><p>Finish signing in in the Plex window. tk.box continues on its own.</p>
        <a href={authUrl} target="_blank" rel="noreferrer" onClick={event=>{const window_=openPlexPopup(authUrl);if(window_){event.preventDefault();popup.current=window_;}}}>Reopen Plex sign-in</a></div>}
      <button className="text-button" disabled={busy} onClick={()=>{setAuthUrl('');setFound(undefined);setAddress(found??'');setStep('find');}}>Use a different Plex server</button>
    </section>}

    {step==='libraries'&&<section className="first-run-panel">
      <h2>Choose your libraries</h2>
      <p className="muted">tk.box shows the libraries you pick. Choose at least one Movies and one TV library.</p>
      <div className="first-run-libraries">
        {[['Movies',movies],['TV',shows]].map(([title,list])=><fieldset key={title as string}><legend>{title as string}</legend>
          {(list as Library[]).map(l=><label key={l.key} className="checkbox-label"><input type="checkbox" checked={chosen.includes(l.key)} onChange={()=>toggle(l.key)}/>{l.title}</label>)}
        </fieldset>)}
      </div>
      <div className="button-row"><button className="primary" disabled={!enough} onClick={()=>{setStep('tools');void checkTools();}}>Continue</button></div>
    </section>}

    {step==='tools'&&<section className="first-run-panel">
      <h2>Check your tools</h2>
      <p className="muted">tk.box uses these programs. Each one is looked for on this computer's PATH unless you give its full path.</p>
      {!tools?<div className="first-run-status"><span className="spinner"/><p>Checking…</p></div>
      :<div className="first-run-tools">{toolInfo.map(([key,name,use])=>{const tool=tools[key];return <div key={key} className={`first-run-tool ${tool.version?'ok':'missing'}`}>
        <div className="first-run-tool-head"><Icon name={tool.version?'check':'close'} size={16}/><strong>{name}</strong><span className="muted">{tool.version??'Not found'}</span></div>
        <small>{use}</small>
        {!tool.version&&<input value={paths[key]} onChange={event=>setPaths(current=>({...current,[key]:event.target.value}))} aria-label={`${name} path`} placeholder={key==='python'?'C:\\tk.box\\.venv\\Scripts\\python.exe':`C:\\ffmpeg\\bin\\${key}.exe`}/>}
      </div>;})}</div>}
      {tools&&<div className="button-row">
        <button className="primary" disabled={busy} onClick={()=>void finish()}>{busy?'Saving…':'Finish setup'}</button>
        {Object.values(tools).some(tool=>!tool.version)&&<button disabled={busy} onClick={()=>void checkTools()}>Check again</button>}
      </div>}
      {tools&&Object.values(tools).some(tool=>!tool.version)&&<small className="muted first-run-note">You can finish now and add missing tools later in .env. Features that need them won't work until then.</small>}
    </section>}

    {step==='restart'&&<section className="first-run-panel">
      <h2>tk.box is set up</h2>
      <p className="muted">Plex is connected and you're signed in. Restart tk.box once so it uses the tool paths you entered.</p>
      <div className="button-row"><button className="primary" onClick={onDone}>Go to tk.box</button></div>
    </section>}
  </div>;
}
