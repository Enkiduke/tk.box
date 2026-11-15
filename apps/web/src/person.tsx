import {useContext,useId,useMemo,useState} from 'react';
import {createPortal} from 'react-dom';
import type {PersonCoStars,PersonCredit,PersonDetails} from '../../../packages/contracts/src/index.js';
import {Artwork,ErrorNotice,FadeImage,Icon,Loading,MediaModalEdge,Modal,Row} from './components.js';
import {useApi} from './hooks.js';
import {statusNames} from './request-dialog.js';
import {DialogNavBar,useDialogNav,type PersonRef} from './dialog-history.js';
import {initials,useOpenTitle,type OpenRelatedTitle} from './title-discovery.js';
import './title-discovery.css';
import './explore.css';
import './person.css';

// A person's view, opened from a title's cast: who they are, what they're known for, what's coming, what this server
// has, every credit by decade, and who they often work with. Titles open in the same dialog history.
const personPath=(p:PersonRef)=>p.id?`/explore/people?id=${p.id}`
  :`/explore/people?${new URLSearchParams({name:p.name,...(p.kind&&p.tmdb?{kind:p.kind,tmdb:String(p.tmdb)}:{})})}`;
const plural=(n:number,word:string)=>`${n.toLocaleString()} ${word}${n===1?'':'s'}`;
const thisYear=new Date().getFullYear();
type Filter='all'|'actor'|'director';
type Sort='newest'|'oldest'|'popular';
const sorts:[Sort,string][]=[['newest','Newest'],['oldest','Oldest'],['popular','Popular']];
const caption=(c:PersonCredit)=>c.character??(c.roles.includes('director')?(c.job==='Creator'?'Creator':'Director'):undefined);

function TitleCard({credit,rank,busy,onOpen}:{credit:PersonCredit;rank?:number;busy:boolean;onOpen:()=>void}) {
  const {item}=credit,sub=[caption(credit),item.year].filter(Boolean).join(' · ');
  return <button type="button" className="person-title" onClick={onOpen} aria-busy={busy||undefined}
    aria-label={`${item.title}${item.year?`, ${item.year}`:''}${item.status?`, ${statusNames[item.status]}`:''}`}>
    <span className="person-title-art">
      <Artwork src={item.posterUrl} fallback={<><Icon name={item.kind==='movie'?'movies':'shows'}/><span>{item.title}</span></>}/>
      {item.status&&<span className={`explore-badge ${item.status}`}>{item.status==='available'?<Icon name="check" size={12}/>:statusNames[item.status]}</span>}
      {rank!==undefined&&<span className="person-rank" aria-hidden="true">{rank}</span>}
    </span>
    <strong title={item.title}>{item.title}</strong>
    {sub&&<span className="muted" title={sub}>{sub}</span>}
  </button>;
}

// Every credit, behind the dialog's expand button (as a title's related rows are).
function Filmography({credits,opening,onOpen}:{credits:PersonCredit[];opening?:string;onOpen:(c:PersonCredit)=>void}) {
  const edge=useContext(MediaModalEdge),region=useId(),[open,setOpen]=useState(false);
  return <>
    <div id={region} hidden={!open}>{open&&<FilmographyList credits={credits} opening={opening} onOpen={onOpen}/>}</div>
    {edge&&createPortal(<button type="button" className="icon-button title-related-toggle" aria-label={open?'Hide filmography':'Show filmography'}
      aria-expanded={open} aria-controls={region} onClick={()=>setOpen(!open)}>
      <Icon name={open?'up':'down'} size={22}/>
    </button>,edge)}
  </>;
}
function FilmographyList({credits,opening,onOpen}:{credits:PersonCredit[];opening?:string;onOpen:(c:PersonCredit)=>void}) {
  const [filter,setFilter]=useState<Filter>('all'),[sort,setSort]=useState<Sort>('newest');
  const directs=credits.some(c=>c.roles.includes('director')),acts=credits.some(c=>c.roles.includes('actor'));
  const groups=useMemo(()=>{
    const shown=credits.filter(c=>filter==='all'||c.roles.includes(filter));
    if(sort==='popular')return [{label:'',items:[...shown].sort((a,b)=>b.votes-a.votes||b.popularity-a.popularity)}];
    const sorted=[...shown].sort((a,b)=>{
      const x=a.date??'9999',y=b.date??'9999';
      return sort==='newest'?y.localeCompare(x):x.localeCompare(y);
    });
    const byDecade=new Map<string,PersonCredit[]>();
    for(const c of sorted){
      const label=c.item.year?`${Math.floor(c.item.year/10)*10}s`:'Upcoming';
      byDecade.set(label,[...byDecade.get(label)??[],c]);
    }
    return [...byDecade].map(([label,items])=>({label,items}));
  },[credits,filter,sort]);
  return <section className="person-section">
    <div className="person-section-head">
      <h2>Filmography</h2>
      <div className="person-controls">
        {directs&&acts&&<div className="toolbar-group" role="group" aria-label="Role">
          {(['all','actor','director'] as const).map(f=><button key={f} type="button" aria-pressed={filter===f} onClick={()=>setFilter(f)}>{f==='all'?'All':f==='actor'?'Actor':'Director'}</button>)}
        </div>}
        <div className="toolbar-group" role="group" aria-label="Sort">
          {sorts.map(([s,label])=><button key={s} type="button" aria-pressed={sort===s} onClick={()=>setSort(s)}>{label}</button>)}
        </div>
      </div>
    </div>
    {groups.map(group=><div key={group.label||'all'} className="person-decade">
      {group.label&&<h3>{group.label}</h3>}
      <ul className="person-credits">{group.items.map(c=><li key={c.item.key}>
        <button type="button" onClick={()=>onOpen(c)} aria-busy={opening===c.item.key||undefined}>
          <span className="person-credit-year">{c.item.year??'—'}</span>
          <span className="person-credit-title">{c.item.title}{c.item.kind==='show'&&<span className="muted"> · Series</span>}</span>
          <span className="person-credit-role muted">{caption(c)}</span>
          {c.item.status?<span className={`badge explore-status ${c.item.status}`}>{statusNames[c.item.status]}</span>:<span/>}
        </button>
      </li>)}</ul>
    </div>)}
  </section>;
}

function CoStars({id}:{id:number}) {
  const nav=useDialogNav();
  const {data}=useApi<PersonCoStars>(`/explore/people/co-stars?id=${id}`);
  if(!data?.people.length)return null;
  return <Row title="Often works with" className="title-cast-row person-costars">
    {data.people.map(p=><button key={p.id} type="button" className="title-credit" onClick={()=>nav?.openPerson({id:p.id,name:p.name,portraitUrl:p.portraitUrl})}>
      <span className="title-credit-portrait" aria-hidden="true"><Artwork src={p.portraitUrl} fallback={<strong>{initials(p.name)}</strong>}/></span>
      <strong className="title-credit-name" title={p.name}>{p.name}</strong>
      <span className="title-credit-role">{plural(p.shared,'title')}</span>
    </button>)}
  </Row>;
}

function TitleRow({title,credits,ranked,opening,onOpen}:{title:string;credits:PersonCredit[];ranked?:boolean;opening?:string;onOpen:(c:PersonCredit)=>void}) {
  if(!credits.length)return null;
  return <Row title={title} className="person-row">
    {credits.map((c,i)=><TitleCard key={c.item.key} credit={c} rank={ranked?i+1:undefined} busy={opening===c.item.key} onOpen={()=>onOpen(c)}/>)}
  </Row>;
}

export function PersonDialog({person,onClose,onOpenRelated}:{person:PersonRef;onClose:()=>void;onOpenRelated:OpenRelatedTitle}) {
  const data=useApi<PersonDetails>(personPath(person)),info=data.data;
  const {open,opening}=useOpenTitle(onOpenRelated),openCredit=(c:PersonCredit)=>void open(c.item);
  const [more,setMore]=useState(false);
  const name=info?.name??person.name,photo=info?.photoUrl??person.portraitUrl;
  const facts=info?[info.department,info.since&&`Since ${info.since}`,
    [info.movies&&plural(info.movies,'film'),info.shows&&plural(info.shows,'show')].filter(Boolean).join(', ')||undefined,
    info.deathday?`${info.birthday?.slice(0,4)??'?'}–${info.deathday.slice(0,4)}`:info.birthday&&`Age ${thisYear-Number(info.birthday.slice(0,4))}`].filter(Boolean):[];
  return <Modal title={name} onClose={onClose} variant="media">
    <DialogNavBar title={name}/>
    <header className="person-head">
      <span className="person-photo">{photo?<FadeImage src={photo} alt="" decoding="async"/>:<strong>{initials(name)}</strong>}</span>
      <div className="person-intro">
        <h1>{name}</h1>
        {facts.length>0&&<p className="detail-meta">{facts.map((f,i)=><span key={i}>{f}</span>)}</p>}
        {info?.biography&&<p className={`person-bio${more?' open':''}`}>{info.biography}</p>}
        <p className="person-links">
          {info?.biography&&info.biography.length>280&&<button type="button" className="text-button" aria-expanded={more} onClick={()=>setMore(!more)}>{more?'Less':'More'}</button>}
          {info?.imdb&&<a href={`https://www.imdb.com/name/${info.imdb}/`} target="_blank" rel="noreferrer">IMDb</a>}
          {info&&<a href={`https://www.themoviedb.org/person/${info.id}`} target="_blank" rel="noreferrer">TMDB</a>}
        </p>
      </div>
    </header>
    <div className="person-body title-discovery">
      {data.error?<ErrorNotice message={data.error.message} retry={data.reload}/>:!info?<Loading/>:<>
        <TitleRow title="Known for" credits={info.knownFor} ranked opening={opening} onOpen={openCredit}/>
        <TitleRow title="Coming soon" credits={info.upcoming} opening={opening} onOpen={openCredit}/>
        <TitleRow title="In your library" credits={info.library} opening={opening} onOpen={openCredit}/>
        <CoStars id={info.id}/>
        {info.credits.length>0&&<Filmography credits={info.credits} opening={opening} onOpen={openCredit}/>}
      </>}
    </div>
  </Modal>;
}
