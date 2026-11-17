import {useState,type ReactNode} from 'react';
import type {SubtitleMissing,SubtitleJobState,SubtitleLists,SubtitleSource,SubtitleVideo,SubtitlesView} from '../../../packages/contracts/src/subtitles.js';
import {api} from './api.js';
import {invalidate,link,useApi} from './hooks.js';
import {ErrorNotice} from './components.js';
import {SectionHead,useMutation} from './settings-ui.js';
import {toast} from './toasts.js';
import {ACTIONS,Field,FieldError,IconAction,Loaded,Panel,Pill,RowActions,SaveBar,Table,Tabs,Tag,TitleCell,When,usePaged,useRefresh,useSave,useSorted,type Tone} from './manage-ui.js';

// Admin › Downloads › Subtitles (docs/PHASE-4.md, step 4): switching it on, the cap, and what the finder has
// done, one list at a time.

const changed=()=>invalidate('/admin/subtitles');
type View='settings'|'missing';
const sourceNames:Record<SubtitleSource,string>={opensubtitles:'OpenSubtitles',whisper:'Whisper',embedded:'Embedded',sidecar:'Sidecar'};
const jobNames:Record<SubtitleJobState,[string,Tone]>={waiting:['Waiting','wait'],queued:['Queued','wait'],claimed:['Running','active'],done:['Done','ok'],failed:['Failed','bad'],cancelled:['Cancelled','off']};
const count=(n:number)=>n.toLocaleString();

export function SubtitlesPage() {
  const view=useApi<SubtitlesView>('/admin/subtitles'),lists=useApi<SubtitleLists>('/admin/subtitles/videos');
  useRefresh(()=>{view.reload();lists.reload();},view.data?.checking?5000:30000);
  const [tab,setTab]=useState<View>('settings');
  const s=view.data,l=lists.data;
  const tabs=<Tabs label="Subtitles" value={tab} onChange={setTab} tabs={[{id:'settings',label:'Settings'},
    {id:'missing',label:'Missing',...(l?{count:l.missing.length,...(l.missing.some(r=>r.skipped||r.job?.state==='failed')?{tone:'bad' as const}:{})}:{})}]}/>;
  return <><SectionHead title="Subtitles"/>{tabs}
    {tab==='settings'?<Loaded view={view}>{v=><><Status view={v}/><Settings key={`s${v.revision}`} view={v}/></>}</Loaded>
      :<Loaded view={lists}>{d=><Missing rows={d.missing}/>}</Loaded>}
  </>;
}

function Status({view}:{view:SubtitlesView}) {
  const a=view.accounting,s=view.sources,mutation=useMutation(changed);
  const check=()=>void mutation.run(async()=>{const r=await api<{queued:number}>('/admin/subtitles/check','POST');toast.info(r.queued?`Checking ${count(r.queued)} files`:'Every file is already checked');});
  return <>{mutation.error&&<ErrorNotice message={mutation.error} dismiss={()=>mutation.setError('')}/>}
  <Panel flush title="Status" actions={<button type="button" disabled={mutation.busy||view.checking>0} onClick={check}>{view.checking?`Checking… ${count(view.checking)} left`:'Check library'}</button>}>
    {view.blocked&&<Field label="Stopped"><span className="danger-text">{view.blocked}</span></Field>}
    <Field label="Today">{count(view.today)} of {count(view.dailyCap)} downloads</Field>
    <Field label="Library">{count(a.total)} files · {count(a.english)} subtitled · {a.missing?<span className="danger-text">{count(a.missing)} missing</span>:'0 missing'}{a.unchecked?` · ${count(a.unchecked)} not checked`:''}</Field>
    <Field label="Sources">{(Object.keys(sourceNames) as SubtitleSource[]).map(k=>`${sourceNames[k]} ${count(s[k])}`).join(' · ')}</Field>
  </Panel></>;
}

type Draft={enabled:boolean;dailyCap:string;preferHearingImpaired:boolean};
const draftOf=(v:SubtitlesView):Draft=>({enabled:v.enabled,dailyCap:String(v.dailyCap),preferHearingImpaired:v.preferHearingImpaired});
const CONNECTION=link('admin',{section:'connections',category:'indexers'});

// The login lives in Admin › Connections › Indexers & downloaders, with the other services' keys.
function Settings({view}:{view:SubtitlesView}) {
  const start=draftOf(view),[draft,setDraft]=useState(start),save=useSave(changed);
  const set=(patch:Partial<Draft>)=>setDraft(d=>({...d,...patch}));
  const cap=Number(draft.dailyCap),capError=!(Number.isInteger(cap)&&cap>=0&&cap<=5000)?'0 to 5000':undefined;
  const loginComplete=view.login.apiKey&&!!view.login.username&&view.login.password;
  const dirty=JSON.stringify(draft)!==JSON.stringify(start),invalid=!!capError||(draft.enabled&&!loginComplete);
  const submit=()=>{if(invalid)return;void save.run(async()=>{
    await api('/admin/subtitles','PUT',{expectedRevision:view.revision,
      ...(draft.enabled!==view.enabled?{enabled:draft.enabled}:{}),...(cap!==view.dailyCap?{dailyCap:cap}:{}),
      ...(draft.preferHearingImpaired!==view.preferHearingImpaired?{preferHearingImpaired:draft.preferHearingImpaired}:{})});
    toast.success('Saved');});};
  return <form onSubmit={e=>{e.preventDefault();submit();}}>
    <Panel flush title="Settings"
      footer={<SaveBar dirty={dirty} busy={save.busy} error={save.error} invalid={invalid} onCancel={()=>{setDraft(start);save.clear();}} onReload={changed}/>}>
      <Field label="Find subtitles" hint="English, for new files and the library">
        <input type="checkbox" role="switch" className="switch" aria-label="Find subtitles" checked={draft.enabled} onChange={e=>set({enabled:e.target.checked})}/>
        {!loginComplete&&<FieldError>Set up <a href={CONNECTION}>OpenSubtitles in Connections</a> first</FieldError>}</Field>
      <Field label="Daily cap" hint="VIP allows 1000"><div className="ui-range"><input type="number" step={1} aria-invalid={!!capError} value={draft.dailyCap}
        onChange={e=>set({dailyCap:e.target.value})}/>a day</div><FieldError>{capError}</FieldError></Field>
      <Field label="Hearing impaired" hint="Prefer SDH subtitles">
        <input type="checkbox" role="switch" className="switch" aria-label="Prefer hearing-impaired subtitles" checked={draft.preferHearingImpaired} onChange={e=>set({preferHearingImpaired:e.target.checked})}/></Field>
    </Panel>
  </form>;
}

// A video's title from the library, with its episodes; one the library no longer has shows its file name.
function VideoCell({video,sub}:{video:SubtitleVideo;sub?:ReactNode}) {
  const file=video.path.split(/[\\/]/).pop()??video.path;
  if(video.titleId===undefined||!video.title)return <div className="ui-title"><div><span className="ui-title-name" title={video.path}>{file}</span>{sub&&<small>{sub}</small>}</div></div>;
  return <TitleCell id={video.titleId} title={video.title} year={video.year} tags={video.episodes&&<Tag>{video.episodes}</Tag>} sub={sub??<span title={video.path}>{file}</span>}/>;
}

// What's happening to a video without English: skipped (given up on), the worker's job, or only checked.
const jobRank:Record<SubtitleJobState,number>={failed:1,claimed:2,queued:3,waiting:4,done:5,cancelled:5};
function statusOf(r:SubtitleMissing):[string,Tone,number] {
  if(r.skipped!==undefined)return ['Skipped','bad',0];
  if(r.job){const [word,tone]=jobNames[r.job.state];return [word,tone,jobRank[r.job.state]];}
  return ['Missing','wait',6];
}
const missingSorts={title:(r:SubtitleMissing)=>r.title??r.path,status:(r:SubtitleMissing)=>statusOf(r)[2],at:(r:SubtitleMissing)=>r.at};
function Missing({rows:all}:{rows:SubtitleMissing[]}) {
  const mutation=useMutation(()=>{changed();});
  const {rows:sorted,sort,onSort}=useSorted(all,missingSorts),{rows,more}=usePaged(sorted,`${sort?.key}|${sort?.dir}`),now=Date.now();
  const retry=(r:SubtitleMissing)=>void mutation.run(async()=>{await api('/admin/subtitles/retry','POST',{path:r.path});toast.info(`Looking again for ${r.title??'that file'}`);});
  return <>{mutation.error&&<ErrorNotice message={mutation.error} dismiss={()=>mutation.setError('')}/>}
    <Panel flush><Table posters more={more} sort={sort} onSort={onSort} empty={!all.length?'Nothing missing':undefined}
      columns={[{label:'Title',sort:'title'},{label:'Since',width:110,sort:'at',desc:true},{label:'Status',width:130,sort:'status'},ACTIONS]}>
      {rows.map(r=>{const [word,tone]=statusOf(r),error=r.skipped??r.job?.error;return <tr key={r.path}>
        <td><VideoCell video={r} sub={error?<span className="danger-text" title={error}>{error}</span>
          :r.job?.state==='waiting'?<>Again <When at={r.job.notBefore} now={now} due="now"/></>:r.job?'For the worker':undefined}/></td>
        <td><When at={r.at} now={now}/></td>
        <td><Pill tone={tone}>{word}</Pill></td>
        <td><RowActions>{r.skipped!==undefined&&<IconAction icon="search" label={`Look again for ${r.title??r.path}`} disabled={mutation.busy||r.titleId===undefined} onClick={()=>retry(r)}/>}</RowActions></td>
      </tr>;})}
    </Table></Panel></>;
}

