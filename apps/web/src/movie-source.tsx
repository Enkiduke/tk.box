import type {MovieSource} from '../../../packages/contracts/src/downloads.js';
import {Icon} from './components.js';
import {Panel,Pill,Table,When,type Tone} from './manage-ui.js';

// Why a movie or show is in the library (docs/UI.md): who requested it, which collections downloaded it, or the
// cutover from Radarr or Sonarr. One look everywhere: an icon and a word, with the who or which under it.

const kinds:Record<MovieSource['kind'],{label:string;icon:string}>={request:{label:'Requested',icon:'users'},collection:{label:'Collection',icon:'collection'},
  radarr:{label:'From Radarr',icon:'download'},sonarr:{label:'From Sonarr',icon:'download'},other:{label:'Added',icon:'plus'}};
export const sourceLabel=(s:MovieSource)=>kinds[s.kind].label;
const names=(list:string[],shown=1)=>list.length<=shown?list.join(', '):`${list.slice(0,shown).join(', ')} +${list.length-shown}`;
function detail(s:MovieSource) {
  return s.kind==='request'?names(s.requests.map(r=>r.name)):s.kind==='collection'?(s.collections.length?names(s.collections):'Collections'):s.kind==='radarr'||s.kind==='sonarr'?'No request on record':s.by;
}
const full=(s:MovieSource)=>s.kind==='request'?s.requests.map(r=>`${r.name}, ${new Date(r.at).toLocaleDateString()}`).join('\n'):s.kind==='collection'?s.collections.join('\n'):undefined;

// The table cell.
export function SourceCell({source}:{source:MovieSource}) {
  const k=kinds[source.kind];
  return <div className={`ui-source ${source.kind}`} title={full(source)}><Icon name={k.icon} size={15}/><div><span>{k.label}</span><small>{detail(source)}</small></div></div>;
}

// The dialog's line under the title: the source in a sentence. A collection's line has no date: for a movie the
// cutover imported, the library's added date is the cutover's, not when the collection grabbed it.
export function SourceLine({source,addedAt}:{source:MovieSource;addedAt:number}) {
  const k=kinds[source.kind],first=source.kind==='request'?source.requests[0]:undefined;
  return <span className={`ui-source ${source.kind}`}><Icon name={k.icon} size={15}/>
    {source.kind==='request'?<>Requested by <strong>{first!.name}</strong>{source.requests.length>1?` and ${source.requests.length-1} more`:''} · <When at={first!.at}/></>
    :source.kind==='collection'?<>Downloaded for {source.collections.length?<strong>{names(source.collections,2)}</strong>:'a collection'}</>
    :source.kind==='radarr'?<>Imported from Radarr, with no request on record</>:source.kind==='sonarr'?<>Imported from Sonarr, with no request on record</>:<>Added by {source.by} · <When at={addedAt}/></>}
  </span>;
}

const requestTone:Record<string,Tone>={available:'ok',partial:'wait',requested:'wait',queued:'wait',downloading:'active',failed:'bad'};
const requestName:Record<string,string>={available:'Available',partial:'Partial',requested:'Requested',queued:'Queued',downloading:'Downloading',failed:'Failed'};

// The dialog's Source panel: every request with its status, or each collection.
export function SourcePanel({source}:{source:MovieSource}) {
  if(source.kind==='request')return <Panel flush title="Requests">
    <Table columns={[{label:'Requested by'},{label:'When',width:140},{label:'Status',width:140}]}>
      {source.requests.map((r,i)=><tr key={i}><td><span className="ui-title-name">{r.name}</span></td><td><When at={r.at}/></td>
        <td><Pill tone={requestTone[r.status]??'off'}>{requestName[r.status]??r.status}</Pill></td></tr>)}
    </Table></Panel>;
  if(source.kind==='collection'&&source.collections.length)return <Panel flush title="Collections">
    <Table columns={[{label:'Downloaded for'}]}>{source.collections.map(c=><tr key={c}><td><span className="ui-title-name">{c}</span></td></tr>)}</Table></Panel>;
  return null;
}
