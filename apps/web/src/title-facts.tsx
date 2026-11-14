import type {ReactNode} from 'react';
import type {ExploreDetails,ExploreItem} from '../../../packages/contracts/src/index.js';

export const displayName=(type:'language'|'region',code:string)=>{
  try{return new Intl.DisplayNames(undefined,{type}).of(code)??code;}catch{return code;}
};
const longDate=(iso:string)=>new Intl.DateTimeFormat(undefined,{dateStyle:'long',timeZone:'UTC'}).format(new Date(`${iso}T00:00:00Z`));

export function TitleFacts({kind,info,studio,released,genres=[]}:{
  kind:ExploreItem['kind'];info?:ExploreDetails;studio?:string;released?:string;genres?:string[];
}) {
  const studios=info?.studios??[],countries=info?.countries??[],providers=info?.providers??[];
  const date=info?.released??released;
  const rows:[string,ReactNode][]=[
    [kind==='show'&&info?.network?'Network':studios.length>1?'Studios':'Studio',
      (kind==='show'&&info?.network)||studios.join(', ')||studio],
    [kind==='movie'?'Released':'Premiered',date&&longDate(date)],
    [countries.length>1?'Countries':'Country',countries.length>0&&<span className="title-facts-countries">{countries.map(c=><span key={c.name}>
      {c.flagUrl&&<img src={c.flagUrl} alt="" className="title-facts-flag"/>}{c.code?displayName('region',c.code):c.name}
    </span>)}</span>],
    ['Language',info?.language&&displayName('language',info.language)],
    ['Genres',(info?.genres.length?info.genres:genres).join(', ')],
    ['Streaming on · JustWatch',providers.length>0&&<span className="title-facts-providers">{providers.map(p=>p.logoUrl
      ? <img key={p.name} src={p.logoUrl} alt={p.name} title={p.name}/>:<span key={p.name}>{p.name}</span>)}</span>]
  ];
  const shown=rows.filter(([,value])=>!!value);
  return shown.length>0?<dl className="detail-people title-facts">{shown.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>:null;
}
