import {useState} from 'react';
import type {LibraryBulkEdit,LibraryBulkResult,PickRules} from '../../../packages/contracts/src/downloads.js';
import {api} from './api.js';
import {Icon} from './components.js';
import {useApi} from './hooks.js';
import {toast} from './toasts.js';
import {BarGroup,SelectionBar,changed,type Selection} from './manage-ui.js';

// Quick edit on Manage › Movies and Shows: the rows picked, changed together (POST /admin/library/titles/bulk).
// Monitored off stops searches, RSS grabs and upgrades; the files stay. Resume clears a title tk.box stopped after
// repeated failed downloads (shown as Failing); there is no Pause of your own, Monitored is that switch.

const SEARCH_ASK=20;
const plural=(n:number,[one,many]:readonly [string,string])=>`${n} ${n===1?one:many}`;
// The titles left out, a few by name.
const skippedText=(skipped:LibraryBulkResult['skipped'])=>{
  const named=skipped.slice(0,4).map(s=>`${s.title}: ${s.reason}`).join(' · ');
  return skipped.length>4?`${named} · and ${skipped.length-4} more`:named;
};

// Monitor and Favorite are one button each, named for what it will do: off when every title picked is on, else on
// (a mix is turned on). Resume shows when some picked titles stopped after failed downloads.
type Picked={monitored:boolean;keep:boolean;paused:boolean};
export function QuickEdit({sel,noun,picked}:{sel:Selection;noun:readonly [string,string];picked:readonly Picked[]}) {
  const failing=picked.filter(p=>p.paused).length,monitored=picked.length>0&&picked.every(p=>p.monitored),favorite=picked.length>0&&picked.every(p=>p.keep);
  const rules=useApi<PickRules>(sel.count?'/admin/library/rules':undefined),[busy,setBusy]=useState(false);
  const run=async(changes:Omit<LibraryBulkEdit,'ids'>)=>{
    if(busy)return;
    if(changes.search&&sel.count>SEARCH_ASK&&!window.confirm(`Search now for ${plural(sel.count,noun)}?`))return;
    setBusy(true);
    try{
      const r=await api<LibraryBulkResult>('/admin/library/titles/bulk','POST',{ids:sel.ids,...changes});
      changed();
      const detail=r.skipped.length?skippedText(r.skipped):undefined;
      if(changes.search)(r.searched?toast.info:toast.warning)(r.searched?`Searching for ${plural(r.searched,noun)}`:'Nothing to search for',{...(detail?{detail}:{})});
      else toast.success(changes.resume?`Resumed ${plural(failing,noun)}`:`Updated ${plural(r.changed,noun)}`,{...(detail?{detail}:{})});
    }catch(e){toast.error('Quick edit failed',{detail:(e as Error).message});}
    finally{setBusy(false);}
  };
  return <SelectionBar count={sel.count} onClear={sel.clear}>
    <BarGroup>
      <button type="button" disabled={busy} title={monitored?'No searches or upgrades; files stay':'Search, grab and upgrade'} onClick={()=>void run({monitored:!monitored})}>{monitored?'Unmonitor':'Monitor'}</button>
    </BarGroup>
    <BarGroup>
      <select aria-label="Set profile" value="" disabled={busy||!rules.data} onChange={e=>{if(e.target.value)void run({profileId:Number(e.target.value)});}}>
        <option value="" disabled>Profile…</option>
        {rules.data?.profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </BarGroup>
    <BarGroup>
      <button type="button" disabled={busy} title={favorite?'Clean Up may remove it again':'Clean Up never removes it'} onClick={()=>void run({keep:!favorite})}>{favorite?'Unfavorite':'Favorite'}</button>
    </BarGroup>
    <BarGroup>
      <button type="button" disabled={busy} title="Search now for the monitored ones that want something" onClick={()=>void run({search:true})}><Icon name="search" size={15}/>Search</button>
      {failing>0&&<button type="button" disabled={busy} title="Clear the failures and start searching again" onClick={()=>void run({resume:true})}><Icon name="play" size={15}/>Resume {failing}</button>}
    </BarGroup>
  </SelectionBar>;
}
