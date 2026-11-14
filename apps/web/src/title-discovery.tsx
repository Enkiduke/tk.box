import {useContext,useEffect,useId,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {ExploreDetails,ExploreItem,RelatedRowKind,TitleCredit,TitleCredits,TitleRelated} from '../../../packages/contracts/src/index.js';
import {Artwork,ErrorNotice,Icon,MediaModalEdge,personHref,Row} from './components.js';
import {fetchCached,useApi} from './hooks.js';
import {useExplorePrefs} from './explore-prefs.js';
import './title-discovery.css';

type Kind=ExploreItem['kind'];
type Ids=ExploreItem['ids'];
type TitleSelection={item:ExploreItem;libraryId?:string};
export type OpenRelatedTitle=(selection:TitleSelection)=>void;

function titleParams(kind:Kind,ids:Ids) {
  const q=new URLSearchParams({kind});
  for(const key of ['tmdb','imdb','tvdb','plex'] as const) {
    const value=ids[key];
    if(value)q.set(key,String(value));
  }
  return q;
}

export function detailsPath(item:Pick<ExploreItem,'kind'|'ids'|'title'|'year'>,region:string,library=false) {
  const q=titleParams(item.kind,item.ids);
  q.set('title',item.title);
  if(item.year)q.set('year',String(item.year));
  q.set('region',region);
  if(library)q.set('library','true');
  return `/explore/details?${q}`;
}

function CastMember({person,kind,tmdb}:{person:TitleCredit;kind:Kind;tmdb?:number}) {
  const initials=person.name.split(/\s+/u).slice(0,2).map(part=>Array.from(part)[0]).join('').toLocaleUpperCase();
  const caption=person.character??(person.role==='director'?'Director':person.role==='creator'?'Creator':undefined);
  return <a className="title-credit" href={personHref(person.name,kind,tmdb)} target="_blank" rel="noreferrer">
    <span className="title-credit-portrait" aria-hidden="true">
      <Artwork key={person.portraitUrl} src={person.portraitUrl} fallback={<strong>{initials}</strong>}/>
    </span>
    <strong className="title-credit-name" title={person.name}>{person.name}</strong>
    {caption&&<span className="title-credit-role" title={caption}>{caption}</span>}
  </a>;
}

const rowNames:Record<RelatedRowKind,string>={similar:'More like this',maker:'More from the director or creator',actor:'More with the lead actor'};

function RelatedTitles({kind,tmdb,onOpen}:{kind:Kind;tmdb:number;onOpen:OpenRelatedTitle}) {
  const edge=useContext(MediaModalEdge);
  const {region:streamingRegion}=useExplorePrefs();
  const [open,setOpen]=useState(false),[requested,setRequested]=useState(false);
  const related=useApi<TitleRelated>(requested?`/explore/title-related?kind=${kind}&tmdb=${tmdb}`:undefined);
  const region=useId();
  const [opening,setOpening]=useState<string>(),activePick=useRef<symbol|undefined>(undefined);
  useEffect(()=>()=>{activePick.current=undefined;},[]);

  async function pick(item:ExploreItem) {
    if(activePick.current)return;
    const token=Symbol();
    activePick.current=token;
    setOpening(item.key);
    const details=await fetchCached<ExploreDetails>(detailsPath(item,streamingRegion)).catch(()=>undefined);
    if(activePick.current!==token)return;
    activePick.current=undefined;
    setOpening(undefined);
    onOpen({item,libraryId:details?.matchedLibraryId});
  }

  return <>
    <div id={region} className="title-related-rows" hidden={!open}>
      {open&&<>
        {related.data?.rows.map(row=>{
          const title=row.kind==='maker'&&row.person?`More from ${row.person.name}`
            :row.kind==='actor'&&row.person?`More with ${row.person.name}`:rowNames[row.kind];
          return <Row key={row.kind} className="title-related-row" title={title}>
            {row.items.map(item=><button type="button" className="title-related-card" key={item.key}
              onClick={()=>void pick(item)} aria-disabled={!!opening} aria-busy={opening===item.key||undefined}>
              <span className="title-related-art">
                <Artwork src={item.backdropUrl??item.posterUrl} fallback={<Icon name={item.kind==='movie'?'movies':'shows'}/>}/>
              </span>
              <strong title={item.title}>{item.title}</strong>
              <span className="muted">{item.kind==='movie'?'Movie':'Series'}{item.year?` · ${item.year}`:''}</span>
            </button>)}
          </Row>;
        })}
        {opening&&<p className="sr-only" role="status">Opening title…</p>}
        {related.loading&&<p role="status" className="muted small">Loading related titles…</p>}
        {!related.loading&&(related.error||!!related.data?.failed.length)&&<ErrorNotice
          message={related.error?'Related titles could not be loaded.':`Could not load ${related.data!.failed.map(row=>rowNames[row].toLowerCase()).join(', ')}.`}
          retry={related.reload}/>}
        {!related.loading&&!related.error&&related.data&&!related.data.rows.length&&!related.data.failed.length&&
          <p className="muted small">No related titles found.</p>}
      </>}
    </div>
    {edge&&createPortal(<button type="button" className="icon-button title-related-toggle" aria-label={open?'Hide related titles':'Show related titles'}
      aria-expanded={open} aria-controls={region}
      onClick={()=>{setOpen(!open);setRequested(true);}}>
      <Icon name={open?'up':'down'} size={22}/>
    </button>,edge)}
  </>;
}

export function TitleDiscovery({kind,ids,cast,directors,onOpen}:{kind:Kind;ids:Ids;cast?:string[];directors?:string[];onOpen:OpenRelatedTitle}) {
  const {tmdb,imdb,tvdb}=ids;
  const q=titleParams(kind,{tmdb,imdb,tvdb});
  const {data}=useApi<TitleCredits>(tmdb||imdb||tvdb?`/explore/title-credits?${q}`:undefined);
  const actors=data?.credits.filter(person=>person.role==='actor')??[];
  const makers=data?.credits.filter(person=>person.role!=='actor')??[];
  const known=new Set(actors.map(person=>person.name.toLowerCase()));
  const extraCast=[...new Set(cast)].filter(name=>!known.has(name.toLowerCase()));
  const credits:TitleCredit[]=[
    ...actors,
    ...extraCast.slice(0,10-actors.length).map(name=>({name,role:'actor' as const})),
    ...(makers.length?makers:[...new Set(directors)].slice(0,2).map(name=>({name,role:'director' as const})))
  ];
  if(!credits.length&&!data?.tmdbId)return null;
  return <section className="title-discovery">
    {!!credits.length&&<Row title="Cast and crew" className="title-cast-row">
      {credits.map(person=><CastMember key={`${person.role}:${person.personId??person.name}`} person={person} kind={kind} tmdb={data?.tmdbId??tmdb}/>)}
    </Row>}
    {data?.tmdbId&&<RelatedTitles key={`${kind}:${data.tmdbId}`} kind={kind} tmdb={data.tmdbId} onOpen={onOpen}/>}
  </section>;
}
