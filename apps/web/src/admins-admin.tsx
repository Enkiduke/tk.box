import {useMemo,useState} from 'react';
import {api} from './api.js';
import {useApi,invalidate} from './hooks.js';
import {ErrorNotice,Loading} from './components.js';
import {Card,SectionHead,Switch,date,useMutation} from './settings-ui.js';

// Admin › Server › Admins (the Plex server owner only): make Plex friends and Plex Home members admins of tk.box.
// They get every Admin section but this one, and act on Plex with the owner's saved Plex admin token.
type Extra={accountId:string;name:string;addedBy:string;addedAt:number};
type User={accountId:string;name:string;username?:string;home:boolean};
type View={admins:Extra[];users:User[];ownerTokenSaved:boolean;ownerId:string};
const PATH='/admin/admins';
const initials=(name:string)=>name.split(/\s+/).filter(Boolean).slice(0,2).map(w=>w[0]!.toUpperCase()).join('')||'?';

export function AdminsAdmin() {
  const view=useApi<View>(PATH),[query,setQuery]=useState('');
  const mutation=useMutation(()=>invalidate(PATH));
  const set=(user:{accountId:string;name:string},admin:boolean)=>void mutation.run(()=>api(PATH,'POST',{accountId:user.accountId,name:user.name,admin}));
  // Every Plex user, with admins who are no longer friends or in Plex Home still listed so they can be removed.
  const people=useMemo(()=>{
    const data=view.data;if(!data)return [];
    const known=new Map<string,User>(data.users.map(u=>[u.accountId,u]));
    for(const a of data.admins)if(!known.has(a.accountId))known.set(a.accountId,{accountId:a.accountId,name:a.name,home:false});
    return [...known.values()].filter(u=>u.accountId!==data.ownerId).sort((a,b)=>a.name.localeCompare(b.name));
  },[view.data]);
  const head=<SectionHead title="Admins" description="Let other people with access to your Plex server manage tk.box. Only you, the server owner, can change this list."/>;
  if(view.loading&&!view.data)return <>{head}<Loading/></>;
  if(view.error&&!view.data)return <>{head}<ErrorNotice message={view.error.message} retry={view.reload}/></>;
  const data=view.data!,admins=new Map(data.admins.map(a=>[a.accountId,a]));
  const q=query.trim().toLowerCase(),shown=people.filter(u=>!q||u.name.toLowerCase().includes(q)||u.username?.toLowerCase().includes(q));
  return <>{head}
    {!data.ownerTokenSaved&&data.admins.length>0&&<div className="notice"><span>Save your Plex admin token in <a href="#admin?section=connections">Admin › Connections</a>. Other admins run Clean Up, Artwork and Collections with it, since their own Plex access can’t change the server.</span></div>}
    {mutation.error&&<ErrorNotice message={mutation.error} dismiss={()=>mutation.setError('')}/>}
    <Card title="Plex users" description={`${data.admins.length} other ${data.admins.length===1?'admin':'admins'}. Admins see every Admin section except this one; they sign in with their own Plex account.`}>
      {people.length>8&&<input type="search" className="admins-search" placeholder="Find a Plex user" aria-label="Find a Plex user" value={query} onChange={e=>setQuery(e.target.value)}/>}
      {!people.length?<p className="muted small">No Plex friends or Plex Home members found. Share your server with someone in Plex first.</p>
        :<ul className="admins-list">{shown.map(u=>{const admin=admins.get(u.accountId);return <li key={u.accountId}>
          <span className="admins-avatar" aria-hidden="true">{initials(u.name)}</span>
          <Switch label={u.name} description={[u.username&&u.username!==u.name?u.username:'',u.home?'Plex Home':'',admin?`Admin since ${date(admin.addedAt)}`:''].filter(Boolean).join(' · ')||undefined}
            checked={!!admin} disabled={mutation.busy} onChange={on=>set(u,on)}/>
        </li>;})}</ul>}
    </Card>
  </>;
}
