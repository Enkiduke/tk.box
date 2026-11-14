import {useState} from 'react';
import type {PlexUsersView,PlexUserSettings} from '../../../packages/contracts/src/index.js';
import {api} from './api.js';
import {useApi,invalidate} from './hooks.js';
import {Empty,ErrorNotice,Loading,Modal} from './components.js';
import {Card,SectionHead,Switch,date,plural,useMutation} from './settings-ui.js';

const PATH='/admin/users';
const initials=(name:string)=>name.trim().split(/\s+/).slice(0,2).map(word=>word.charAt(0).toUpperCase()).join('')||'?';
const accessLabel={granted:'Plex access',pending:'Invitation pending',none:'No server access'};
const revokeLabel=(user:PlexUserSettings)=>user.access==='pending'?'Cancel invitation':'Revoke Plex access';

export function UsersAdmin() {
  const view=useApi<PlexUsersView>(PATH);
  const [query,setQuery]=useState('');
  const [removing,setRemoving]=useState<PlexUserSettings>();
  const [notice,setNotice]=useState('');
  const mutation=useMutation(()=>invalidate(PATH));
  const head=<SectionHead title="Users" description="Manage Plex access to this server and choose who can administer tk.box.">
    <button type="button" onClick={view.reload} disabled={view.loading||mutation.busy}>Refresh</button>
  </SectionHead>;
  if(!view.data)return <>{head}{view.error?<ErrorNotice message={view.error.message} retry={view.reload}/>:<Loading/>}</>;

  const data=view.data;
  const admins=new Map(data.admins.map(admin=>[admin.accountId,admin]));
  const people=new Map(data.users.map(user=>[user.key,user]));
  const owner=people.get(data.ownerId);
  people.set(data.ownerId,{key:data.ownerId,accountId:data.ownerId,name:data.ownerName||owner?.name||'Plex server owner',
    username:owner?.username,home:owner?.home??false,managed:false,access:'granted',canAdmin:false});
  for(const admin of data.admins)if(!people.has(admin.accountId))people.set(admin.accountId,{
    key:admin.accountId,accountId:admin.accountId,name:admin.name,home:false,managed:false,access:'none',canAdmin:false,
  });
  const q=query.trim().toLowerCase();
  const shown=[...people.values()]
    .filter(user=>!q||user.name.toLowerCase().includes(q)||user.username?.toLowerCase().includes(q))
    .sort((a,b)=>Number(b.key===data.ownerId)-Number(a.key===data.ownerId)||a.name.localeCompare(b.name));
  const busy=mutation.busy||view.loading;

  function revoke(user:PlexUserSettings) {
    void mutation.run(async()=>{
      await api(`${PATH}/${user.key}/plex-access`,'DELETE');
      setRemoving(undefined);
      setNotice(user.access==='pending'?`Cancelled the Plex invitation for ${user.name}.`:`Revoked Plex access for ${user.name}.`);
    });
  }

  return <>{head}
    {view.error&&<ErrorNotice message={view.error.message} retry={view.reload}/>}
    {data.directoryIncomplete&&<div className="notice" role="status">Plex couldn’t load the full Friends and Home lists. Server shares are shown below.</div>}
    {!data.canRevoke&&<div className="notice" role="status">Plex access changes are disabled in read-only mode.</div>}
    {!data.ownerTokenSaved&&data.admins.length>0&&<div className="notice"><span>Save your Plex admin token in <a href="#admin?section=connections">Admin › Connections</a> to let other admins run Clean Up, Artwork and Collections.</span></div>}
    {notice&&<div className="notice" role="status">{notice}</div>}
    {!removing&&mutation.error&&<ErrorNotice message={mutation.error} dismiss={()=>mutation.setError('')}/>}
    <Card title="Plex users" description={`${plural(people.size,'account')} · ${data.admins.length} delegated ${data.admins.length===1?'admin':'admins'}`}>
      <input type="search" className="users-search" placeholder="Find a Plex user" aria-label="Find a Plex user" value={query} onChange={e=>setQuery(e.target.value)}/>
      {!shown.length?<Empty title="No matching Plex users"/>:
        <ul className="users-list">{shown.map(user=>{
          const isOwner=user.key===data.ownerId;
          const admin=user.accountId?admins.get(user.accountId):undefined;
          return <li key={user.key}>
            <span className="users-avatar" aria-hidden="true">{initials(user.name)}</span>
            <div className="users-profile">
              <strong>{user.name}</strong>
              <div className="users-details">
                {user.username&&user.username!==user.name&&<small className="muted">{user.username}</small>}
                <span className={`badge ${isOwner||user.access==='granted'?'ok':user.access==='pending'?'warning':''}`}>{isOwner?'Server owner':accessLabel[user.access]}</span>
                {user.home&&<span className="badge">{user.managed?'Plex Home · Managed':'Plex Home'}</span>}
              </div>
            </div>
            <div className="users-actions">
              {isOwner?<span className="muted small">tk.box admin</span>:user.accountId&&(user.canAdmin||admin)&&
                <Switch label="tk.box admin" ariaLabel={`tk.box admin for ${user.name}`} description={admin?`Since ${date(admin.addedAt)}`:undefined}
                  checked={!!admin} disabled={busy} onChange={on=>{
                    setNotice('');
                    void mutation.run(()=>api(PATH,'POST',{accountId:user.accountId,admin:on}));
                  }}/>}
              {!isOwner&&user.access!=='none'&&<button type="button" className="danger" disabled={busy||!data.canRevoke||!!view.error}
                aria-label={`${revokeLabel(user)} for ${user.name}`} onClick={()=>{setNotice('');mutation.setError('');setRemoving(user);}}>{revokeLabel(user)}</button>}
            </div>
          </li>;
        })}</ul>}
    </Card>
    {removing&&<Modal title={revokeLabel(removing)} onClose={()=>{if(!mutation.busy)setRemoving(undefined);}}>
      <h2>{removing.access==='pending'?`Cancel the invitation for ${removing.name}?`:`Revoke Plex access for ${removing.name}?`}</h2>
      <p>{removing.access==='pending'?'This cancels their outstanding invitation to this Plex server.':'This removes their shares on this Plex server, signs them out of tk.box, and clears any tk.box admin role.'}</p>
      {removing.home&&<p>They’ll remain a member of Plex Home.</p>}
      {mutation.error&&<ErrorNotice message={mutation.error}/>}
      <div className="button-row">
        <button type="button" disabled={mutation.busy} autoFocus onClick={()=>{setRemoving(undefined);mutation.setError('');}}>Back</button>
        <button type="button" className="danger" disabled={busy} onClick={()=>revoke(removing)}>{mutation.busy?'Removing…':revokeLabel(removing)}</button>
      </div>
    </Modal>}
  </>;
}
