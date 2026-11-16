import {Fragment,useEffect,useState,type ReactNode} from 'react';
import type {InteractiveRelease,InteractiveSearch} from '../../../packages/contracts/src/downloads.js';
import {api} from './api.js';
import {ErrorNotice,Icon} from './components.js';
import {useMutation} from './settings-ui.js';
import {toast} from './toasts.js';
import {Dash,Pill,Segmented,Table,changed,gb,qualityRank,useSorted} from './manage-ui.js';

// Interactive search (docs/UI.md): every release the indexers found for a movie, how the pick rules scored it, why
// a rejected one was turned down, and which one an automatic search would grab. A release can be grabbed by hand.
// Shown as a movie's Interactive search tab, opened from any list (the row's search icon) or the movie itself.

const views=[['accepted','Accepted'],['all','All']] as const;
const protocols=[['any','Both'],['usenet','Usenet'],['torrent','Torrents']] as const;
type SearchRow=InteractiveRelease|NonNullable<InteractiveSearch['have']>;
// Score descending by default, with ties in pick order and the library file inserted for comparison.
const releaseSorts={release:(r:SearchRow)=>r.name,quality:(r:SearchRow)=>qualityRank(r.quality),size:(r:SearchRow)=>r.size,
  peers:(r:SearchRow)=>peers(r),age:(r:SearchRow)=>'current' in r?undefined:r.publishedAt,score:(r:SearchRow)=>r.score,
  decision:(r:SearchRow)=>'current' in r?2:r.best?0:r.accepted?1:3};
const peers=(r:SearchRow)=>'current' in r?undefined:r.protocol==='torrent'?r.seeders:r.grabs;
const signed=(n:number)=>n>0?`+${n}`:String(n);
// A rejection in a word or two for the pill; the full reason is in the tooltip and the opened row.
const SHORT:[RegExp,string][]=[[/blocklist/,'Blocklisted'],[/quality unknown/,'Unknown quality'],[/early copy/,'Early copy'],[/isn't allowed/,'Quality not allowed'],
  [/multi-season|not a movie/,'Not a movie'],[/^title /,'Wrong title'],[/^year /,'Wrong year'],[/IMDb id/,'Wrong IMDb id'],[/ over \d/,'Too big'],[/ under \d/,'Too small'],
  [/no seeders/,'No seeders'],[/already meets the cutoff|no better than/,'Not an upgrade'],[/PROPER|REPACK/,'Not a valid PROPER']];
function short(reason:string) {
  const banned=/^banned by (.+)/.exec(reason);
  if(banned)return `Banned: ${banned[1]}`;
  return SHORT.find(([re])=>re.test(reason))?.[1]??reason[0]!.toUpperCase()+reason.slice(1);
}
// Age as "5 h", "12 d", "8 mo", "2 y".
function age(at:number,now:number) {
  const h=(now-at)/3600000;
  return h<1?`${Math.max(1,Math.round(h*60))} min`:h<48?`${Math.round(h)} h`:h<24*60?`${Math.round(h/24)} d`:h<24*730?`${Math.round(h/24/30.4)} mo`:`${Math.round(h/24/365)} y`;
}

// The search itself, shown as a movie's Interactive search tab (movie-dialog.tsx). It searches when first shown.
// A show's search is for one season (S02, packs and its episodes) or one episode (S02E05); `controls` (its season and
// episode pickers) sit first in the bar.
export function InteractiveSearchPanel({titleId,scope,controls}:{titleId:number;scope?:string;controls?:ReactNode}) {
  const path=`/admin/library/titles/${titleId}`;
  const [result,setResult]=useState<InteractiveSearch>(),[view,setView]=useState<'accepted'|'all'>('accepted'),[protocol,setProtocol]=useState<'any'|'usenet'|'torrent'>('any');
  const [open,setOpen]=useState<string>(),[grabbed,setGrabbed]=useState('');
  const search=useMutation(()=>{}),grab=useMutation(changed);
  const run=()=>void search.run(async()=>{
    setGrabbed('');setOpen(undefined);
    const found=await api<InteractiveSearch>(`${path}/interactive`,'POST',scope?{scope}:undefined);
    setResult(found);
    // Nothing accepted: show everything, so the reasons are in view.
    setView(found.releases.some(r=>r.accepted)?'accepted':'all');
  });
  useEffect(()=>{setResult(undefined);run();},[titleId,scope]);
  const take=(r:InteractiveRelease)=>void grab.run(async()=>{await api(`${path}/grab`,'POST',{guid:r.guid,...(scope?{scope}:{})});setGrabbed(r.guid);toast.success(`Grabbed ${r.name}`);});
  const all=result?.releases??[],accepted=all.filter(r=>r.accepted).length;
  const visible=(r:InteractiveRelease)=>(view==='all'||r.accepted)&&(protocol==='any'||r.protocol===protocol);
  const rows:SearchRow[]=all.filter(visible);
  const current=result?.have;
  if(current)rows.splice(all.slice(0,current.position).filter(visible).length,0,current);
  const empty=rows.length>(current?1:0)?undefined:!all.length
    ?current?'No other releases found':'The indexers found nothing'
    :view==='accepted'&&protocol==='any'?'Nothing accepted. Show all to see why each was turned down.':'No releases match these filters';
  const {rows:sorted,sort,onSort}=useSorted(rows,releaseSorts,{key:'score',dir:-1});
  const now=Date.now();
  return <div className="ui-search-dialog">
      <div className="ui-bar">
        {controls}
        <Segmented label="Releases" value={view} onChange={setView} options={views.map(([v,l])=>[v,`${l} (${v==='all'?all.length:accepted})`] as const)}/>
        <Segmented label="Protocol" value={protocol} options={protocols} onChange={setProtocol}/>
        <span className="ui-count">{result?<>Profile <strong>{result.profile.name}</strong> · cutoff <strong>{result.profile.cutoff}</strong> · {rows.length} shown</>:''}</span>
        <button type="button" disabled={search.busy} onClick={run}><Icon name="restart" size={15}/>{search.busy?'Searching…':'Search again'}</button>
      </div>
      {search.error&&<ErrorNotice message={search.error}/>}
      {grab.error&&<ErrorNotice message={grab.error} dismiss={()=>grab.setError('')}/>}
      {result?.indexers.filter(i=>i.error).map(i=><div key={i.indexer} className="notice"><span>{i.indexer}: {i.error}</span></div>)}
      <div className="ui-panel">
        {!result?<div className="ui-empty">{search.busy?'Asking the indexers…':'No results'}</div>:
        <Table sort={sort} onSort={onSort} empty={empty}
          columns={[{label:'Release',sort:'release'},{label:'Quality',width:130,sort:'quality',desc:true},{label:'Size',width:90,num:true,sort:'size',desc:true},
            {label:'Peers',width:80,num:true,sort:'peers',desc:true},{label:'Age',width:80,num:true,sort:'age',desc:true},
            {label:'Score',width:80,num:true,sort:'score',desc:true},{label:'Decision',width:220,sort:'decision'},{label:<span className="sr-only">Grab</span>,width:88}]}>
          {sorted.map(r=>{const current='current' in r,key=current?'current':`${r.indexer}:${r.guid}`,expanded=open===key;return <Fragment key={key}>
            <tr className={`ui-release ${current?'is-current':r.accepted?'':'is-off'} ${expanded?'is-open':''}`} onClick={()=>setOpen(expanded?undefined:key)}>
              <td><div className="ui-release-name"><Icon name={expanded?'down':'next'} size={14}/><div>
                <span title={r.name}>{r.name}</span>
                <small>{current?'Library file':<>{r.protocol==='usenet'?'Usenet':'Torrent'} · {r.indexer}{r.freeleech?' · Freeleech':''}{r.upgrade?' · Upgrade':''}</>}</small></div></div></td>
              <td>{r.quality??<span className="danger-text">Unknown</span>}</td>
              <td className="num">{gb(r.size)??<Dash/>}</td>
              <td className="num" title={current?undefined:r.protocol==='torrent'?'Seeders':'Grabs'}>{peers(r)??<Dash/>}</td>
              <td className="num" title={!current&&r.publishedAt?new Date(r.publishedAt).toLocaleString():undefined}>{!current&&r.publishedAt?age(r.publishedAt,now):<Dash/>}</td>
              <td className="num">{r.score===undefined?<Dash/>:<span className={`ui-score ${r.score>0?'up':r.score<0?'down':''}`} title={r.scoreParts.map(p=>p.ban?`${p.name}: banned`:`${p.name}: ${signed(p.points)}`).join('\n')||'No score rules match'}>{signed(r.score)}</span>}</td>
              <td>{current?<Pill tone="active">Current version</Pill>:r.best?<Pill tone="ok" title="An automatic search would grab this one">Would grab</Pill>:r.accepted?<Pill tone="ok">Accepted</Pill>
                :<span className="ui-decision"><Pill tone="bad" title={r.rejections.join('\n')}>{r.rejections[0]?short(r.rejections[0]):'Rejected'}</Pill>{r.rejections.length>1&&<span className="ui-more-count">+{r.rejections.length-1}</span>}</span>}</td>
              <td className="num" onClick={e=>e.stopPropagation()}>{current?null:grabbed===r.guid?<Pill tone="active">Grabbed</Pill>:<button type="button" className={`ui-grab ${r.best?'primary':''}`}
                disabled={grab.busy||!r.quality||!!grabbed} title={r.accepted?undefined:'Grab it anyway'} aria-label={`Grab ${r.name}`} onClick={()=>take(r)}>Grab</button>}</td>
            </tr>
            {expanded&&<tr className="ui-release-detail"><td colSpan={8}><Detail r={r}/></td></tr>}
          </Fragment>;})}
        </Table>}
      </div>
    </div>;
}

// A release opened up: what its name says, its score rule by rule, and the decision with every reason.
function Detail({r}:{r:SearchRow}) {
  const p=r.parsed;
  const facts=[p.resolution,p.remux?'Remux':p.source,p.codec,...p.hdr,p.audio,...p.editions,...p.languages,p.proper?'PROPER':'',p.repack?'REPACK':'',p.hardcodedSubs?'Hardcoded subs':''].filter(Boolean) as string[];
  return <div className="ui-detail">
    <section><h4>Read from the name</h4>
      <div className="ui-facts-chips">{facts.length?facts.map(f=><span key={f} className="ui-tag">{f}</span>):<span className="ui-dash">Nothing recognised</span>}</div>
      {p.group&&<p>Group <strong>{p.group}</strong></p>}</section>
    <section><h4>Score</h4>
      {r.score===undefined?<p className="ui-dash">Original release name unavailable</p>:r.scoreParts.length?<ul className="ui-score-list">{r.scoreParts.map(s=><li key={s.name}><span>{s.name}</span>{s.ban?<Pill tone="bad">Banned</Pill>:<strong className={s.points>0?'up':s.points<0?'down':''}>{signed(s.points)}</strong>}</li>)}
        <li className="total"><span>Total</span><strong>{signed(r.score)}</strong></li></ul>:<p className="ui-dash">No score rules match</p>}</section>
    <section><h4>Decision</h4>
      {'current' in r?<Pill tone="active">Current version</Pill>:r.accepted?<ul className="ui-reasons ok"><li>{r.best?'Accepted, and the best match: an automatic search would grab it':'Accepted'}</li>{r.upgradeReason&&<li>{r.upgradeReason[0]!.toUpperCase()+r.upgradeReason.slice(1)}</li>}</ul>
        :<ul className="ui-reasons bad">{r.rejections.map(x=><li key={x}>{x[0]!.toUpperCase()+x.slice(1)}</li>)}</ul>}</section>
  </div>;
}
