import type {MovieSource,TitleRequest} from '../../../packages/contracts/src/downloads.js';
import {Icon} from './components.js';
import {Dash,Pill,Table,When,useSorted,type Tone} from './manage-ui.js';

// Why a movie or show is in the library (docs/UI.md): who requested it, which collections downloaded it, or the
// one-time import. One look everywhere: an icon and a word, with the who or which under it.

const kinds:Record<MovieSource['kind'],{label:string;icon:string}>={request:{label:'Requested',icon:'users'},collection:{label:'Collection',icon:'collection'},
  imported:{label:'Imported',icon:'download'},other:{label:'Added',icon:'plus'}};
export const sourceLabel=(s:MovieSource)=>kinds[s.kind].label;
const names=(list:string[],shown=1)=>list.length<=shown?list.join(', '):`${list.slice(0,shown).join(', ')} +${list.length-shown}`;
function detail(s:MovieSource) {
  return s.kind==='request'?names(s.requests.map(r=>r.name)):s.kind==='collection'?(s.collections.length?names(s.collections):'Collections'):s.kind==='imported'?'No request on record':s.by;
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
  return <span className={`ui-source ${source.kind}`} title={source.kind==='collection'?full(source):undefined}><Icon name={k.icon} size={15}/>
    {source.kind==='request'?<>Requested by <strong>{first!.name}</strong>{source.requests.length>1?` and ${source.requests.length-1} more`:''} · <When at={first!.at}/></>
    :source.kind==='collection'?<>Downloaded for {source.collections.length?<strong>{names(source.collections,2)}</strong>:'a collection'}</>
    :source.kind==='imported'?<>Imported, with no request on record</>:<>Added by {source.by} · <When at={addedAt}/></>}
  </span>;
}

const requestTone:Record<string,Tone>={available:'ok',partial:'wait',requested:'wait',queued:'wait',downloading:'active',failed:'bad',removed:'off'};
const requestName:Record<string,string>={available:'Available',partial:'Partial',requested:'Requested',queued:'Queued',downloading:'Downloading',failed:'Failed',removed:'Removed'};
const removedName:Record<NonNullable<TitleRequest['removedBy']>,string>={requester:'Cancelled by the requester',admin:'Removed by an admin',cleanup:'Removed by Clean Up',library:'Gone from the library'};
const seasonList=(seasons:number[])=>seasons.length===1?`Season ${seasons[0]}`:`Seasons ${seasons.join(', ')}`;

// The dialog's Requests tab: every request for the title, newest first, cancelled and failed ones too.
export function RequestsTable({requests,show}:{requests:TitleRequest[];show?:boolean}) {
  const now=Date.now();
  const {rows,sort,onSort}=useSorted(requests,{name:r=>r.name.toLowerCase(),at:r=>r.at,status:r=>r.status,changed:r=>r.statusAt});
  return <Table sort={sort} onSort={onSort} empty={requests.length?undefined:'Never requested'} columns={[{label:'Requested by',sort:'name'},...(show?[{label:'Seasons',width:160}]:[]),
    {label:'Requested',width:110,sort:'at',desc:true},{label:'Status',width:130,sort:'status'},{label:'Since',width:110,sort:'changed',desc:true}]}>
    {rows.map(r=>{const note=r.error??(r.removedBy?removedName[r.removedBy]:undefined);
      return <tr key={r.id} className={r.status==='removed'?'is-off':undefined}><td><span className="ui-title-name">{r.name}</span>{note&&<small className={r.error?'bad':undefined} title={note}>{note}</small>}</td>
        {show&&<td>{r.seasons?.length?seasonList(r.seasons):<Dash/>}</td>}
        <td><When at={r.at} now={now}/></td>
        <td><Pill tone={requestTone[r.status]??'off'}>{r.status==='removed'&&r.removedBy==='requester'?'Cancelled':requestName[r.status]??r.status}</Pill></td>
        <td><When at={r.status==='removed'?r.removedAt??r.statusAt:r.status==='available'?r.availableAt??r.statusAt:r.statusAt} now={now}/></td></tr>;})}
  </Table>;
}
