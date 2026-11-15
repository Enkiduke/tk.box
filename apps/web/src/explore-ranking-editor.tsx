import {useEffect,useState} from 'react';
import type {ExploreItem,TmdbExploreRow} from '../../../packages/contracts/src/index.js';
import {exploreRankingBounds,exploreRankingFor,exploreSignal,exploreSignalIsActive,exploreSignalsFor,
  type ExploreRankingField,type ExploreRankingOptions,type ExploreRowRanking,type ExploreSignalId} from '../../../packages/contracts/src/explore-ranking.js';
import {api} from './api.js';
import {ErrorNotice,Icon} from './components.js';
import {useMutation} from './settings-ui.js';
import {useStreamingSelection} from './explore-streaming.js';

const fieldLabels:Record<ExploreRankingField,string> = {
  releaseBoost:'Maximum boost (%)', releaseBoostDays:'Fade over (days)', releaseDays:'Days since release',
  seasonBoost:'Maximum boost (%)', seasonDays:'Fade over (days)', popularityBoost:'Strength (%)',
  audienceRating:'Strength (%)', ratingPriorVotes:'Votes for half confidence', minimumRating:'Rating out of 10', minimumVotes:'Votes',
  nearPopularity:'Near-term multiplier (%)', nearDays:'Near term ends (days ahead)',
  midPopularity:'Mid-term multiplier (%)', midDays:'Mid term ends (days ahead)', futureDays:'Days ahead',
  trendingDays:'Chart window', freshness:'Maximum boost (%)', freshnessFullDays:'Full boost for (days)', freshnessEndDays:'Fade to zero by (days)',
  genreAffinity:'Maximum boost (%)', eraAffinity:'Strength (%)', shuffle:'Maximum variation (%)',
  recommendationDecay:'Positions to half weight', watchRankRetention:'Weight retained per position (%)',
  watchHalfLife:'Days to half weight', watchFrequency:'Maximum boost (%)', variety:'Enabled', seedDiversity:'Enabled'
};

function signalValue(id:ExploreSignalId, values:ExploreRowRanking) {
  if (id==='trending') return values.trendingDays===1?'Daily':'Weekly';
  if (id==='upcoming') return `${values.nearPopularity}% / ${values.midPopularity}%`;
  if (id==='variety'||id==='seedDiversity') return '';
  const first=exploreSignal(id).fields[0]!;
  const suffix=fieldLabels[first].includes('(%)')?'%':id==='releaseWindow'||id==='upcomingWindow'||id==='watchRecency'?' days':'';
  return `${values[first]}${suffix}`;
}

function RankingInput({field,values,onChange}:{field:ExploreRankingField;values:ExploreRowRanking;onChange:(value:number)=>void}) {
  const value=values[field]!;
  const [text,setText]=useState(String(value)), [error,setError]=useState('');
  useEffect(()=>{setText(String(value));setError('');},[value]);
  return <label>{fieldLabels[field]}
    {field==='trendingDays'?<select value={value} onChange={e=>onChange(Number(e.target.value))}>
      <option value={1}>Daily</option><option value={7}>Weekly</option>
    </select>:<input type="number" required {...exploreRankingBounds(field,values)} value={text} aria-invalid={!!error} onChange={e=>{
      const input=e.currentTarget;
      setText(input.value);
      setError(input.validationMessage);
      if(input.validity.valid)onChange(input.valueAsNumber);
    }}/>}
    {error&&<small>{error}</small>}
  </label>;
}

export function ExploreRankingEditor({row,configured,revision,options,onChange}:{row:TmdbExploreRow;configured:boolean;revision:number;
  options?:ExploreRankingOptions;onChange:(options?:ExploreRankingOptions)=>void}) {
  const [editing,setEditing]=useState<ExploreSignalId>();
  const [preview,setPreview]=useState<{key:string;saved:ExploreItem[];preview:ExploreItem[]}>();
  const mutation=useMutation(()=>{});
  const values:ExploreRowRanking=exploreRankingFor(row,options?{[row]:options}:undefined);
  const available=exploreSignalsFor(row);
  const active=available.filter(id=>exploreSignalIsActive(id,options,values));
  const inactive=available.filter(id=>!active.includes(id));
  const streaming=row==='popular-streaming'||row==='recent-streaming';
  const selection=useStreamingSelection(configured&&streaming?row:undefined);
  const previewKey=JSON.stringify([revision,options,selection.query]);
  const comparison=preview?.key===previewKey?preview:undefined;
  const orderChanged=comparison&&comparison.saved.slice(0,8).map(item=>item.key).join()!==comparison.preview.slice(0,8).map(item=>item.key).join();
  const toggle=(id:ExploreSignalId, enabled:boolean)=>{
    onChange({...options,signals:{...options?.signals,[id]:enabled}});
    if (enabled) setEditing(id);
    else if (editing===id) setEditing(undefined);
  };
  return <div className="explore-ranking-panel">
    <div className="explore-ranking-toolbar">
      <strong>Ranking signals</strong>
      <div className="button-row">
        {options&&<button type="button" className="explore-ranking-link" onClick={()=>{onChange(undefined);setEditing(undefined);}}>Reset defaults</button>}
        <button type="button" className="explore-ranking-link" disabled={!configured||mutation.busy||streaming&&!selection.query} onClick={e=>{
          if(e.currentTarget.form?.reportValidity()===false)return;
          void mutation.run(async()=>{
            const path=`/admin/explore/ranking/preview${selection.query.replace(/^&/,'?')}`;
            const result=await api<{saved:ExploreItem[];preview:ExploreItem[]}>(path,'POST',{row,settings:options??{}});
            setPreview({key:previewKey,...result});
          });
        }}>{mutation.busy?'Loading…':'Preview'}</button>
        {inactive.length>0&&<select aria-label="Add signal" value="" onChange={e=>{if(e.target.value)toggle(e.target.value as ExploreSignalId,true);}}>
          <option value="">+ Add signal</option>
          {inactive.map(id=><option key={id} value={id}>{exploreSignal(id).label}</option>)}
        </select>}
      </div>
    </div>
    {active.length===0?<p className="muted small">No active signals.</p>:<ul className="explore-ranking-list">
      {active.map(id=>{
        const signal=exploreSignal(id), expanded=id===editing, panelId=`explore-${row}-${id}`;
        return <li key={id}>
          <div className="explore-ranking-signal">
            <button type="button" className="explore-ranking-link" aria-expanded={expanded} aria-controls={panelId}
              onClick={()=>setEditing(expanded?undefined:id)}><Icon name={expanded?'up':'down'} size={13}/>{signal.label}</button>
            <span className="muted small">{signalValue(id,values)}</span>
            <button type="button" className="explore-ranking-link" aria-label={`Remove ${signal.label}`} title={`Remove ${signal.label}`}
              onClick={()=>toggle(id,false)}><Icon name="close" size={14}/></button>
          </div>
          <div id={panelId} hidden={!expanded}>
            {expanded&&<div className="explore-ranking-edit">
              <p className="muted small">{signal.description}</p>
              {id!=='variety'&&id!=='seedDiversity'&&<div className="explore-ranking-fields">
                {signal.fields.map(field=><RankingInput key={field} field={field} values={values}
                  onChange={value=>onChange({...options,[field]:value,signals:{...options?.signals,[id]:true}})}/>)}
              </div>}
            </div>}
          </div>
        </li>;
      })}
    </ul>}
    {mutation.error&&<ErrorNotice message={mutation.error}/>}
    {comparison&&!orderChanged&&<p className="muted small">{comparison.saved.length?'The first titles keep their saved order.':'No titles available to preview.'}</p>}
    {comparison&&orderChanged&&<div className="explore-ranking-fields explore-ranking-preview">
      {([['Saved order',comparison.saved],['Draft order',comparison.preview]] as const).map(([title,items])=><section key={title}>
        <h3>{title}</h3>
        {items.length?<ol>{items.slice(0,8).map(item=><li key={item.key}>{item.title}{item.year&&<small className="muted"> ({item.year})</small>}</li>)}</ol>:<p className="muted small">No titles found.</p>}
      </section>)}
    </div>}
  </div>;
}
