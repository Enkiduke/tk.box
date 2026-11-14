import type {ExploreDetails,RelatedRowKind,TitleCredit,TitleCredits,TitleRelated} from '../../../../packages/contracts/src/index.js';
import {flagImage,tmdbImage} from './explore-images.js';
import {tmdbCandidate,type Candidate,type TmdbExplore} from './tmdb-explore.js';
import type {TitleKind,TmdbTitles} from './tmdb-titles.js';

type ExternalIds={tmdb?:number;imdb?:string;tvdb?:number};
type Person={id?:unknown;name?:unknown;profile_path?:string;character?:unknown;job?:string;roles?:{character?:unknown}[]};
type Credits={cast?:Person[];crew?:Person[]};
type FilmCredit=Parameters<typeof tmdbCandidate>[0]&{job?:string};
type Named={name?:string};
type Provider={provider_name?:string;logo_path?:string};
type TmdbDetail=NonNullable<Parameters<typeof tmdbCandidate>[0]>&{
  credits?:Credits;aggregate_credits?:Credits;created_by?:Person[];
  tagline?:string;status?:string;runtime?:number;number_of_episodes?:number;
  genres?:{id:number;name:string}[];production_companies?:Named[];networks?:Named[];
  production_countries?:{iso_3166_1:string;name:string}[];origin_country?:string[];
  imdb_id?:string;external_ids?:{imdb_id?:string;tvdb_id?:number};
  release_dates?:{results?:{iso_3166_1:string;release_dates?:{certification?:string}[]}[]};
  content_ratings?:{results?:{iso_3166_1:string;rating?:string}[]};
  'watch/providers'?:{results?:Record<string,{flatrate?:Provider[]}>};
};
const positiveId=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
const list=<T>(value:T[]|undefined):T[]=>Array.isArray(value)?value:[];
const text=(value:unknown)=>typeof value==='string'?value.trim():'';
const MAX_CARDS=8;

function people(raw:Person[],role:TitleCredit['role'],limit:number) {
  const found=new Map<string|number,TitleCredit>();
  for(const person of raw) {
    const name=text(person?.name);
    if(!name)continue;
    const personId=positiveId(person.id)?person.id:undefined;
    const key=personId??name.toLowerCase();
    if(found.has(key))continue;
    const character=role==='actor'?(text(person.character)||list(person.roles).map(entry=>text(entry?.character)).find(Boolean)):undefined;
    const portraitUrl=tmdbImage(typeof person.profile_path==='string'?person.profile_path:undefined,'w185');
    found.set(key,{name,role,personId,character,portraitUrl});
    if(found.size===limit)break;
  }
  return [...found.values()];
}

export class TmdbTitleDiscovery {
  constructor(private client:TmdbTitles,private explore:TmdbExplore) {}

  private async resolve(type:TitleKind,ids:ExternalIds) {
    if(ids.tmdb)return ids.tmdb;
    const field=type==='movie'?'movie_results':'tv_results';
    const externalIds=[['imdb_id',ids.imdb],['tvdb_id',type==='tv'?ids.tvdb:undefined]] as const;
    for(const [external_source,id] of externalIds) {
      if(!id)continue;
      const result=await this.client.get(`/find/${id}`,{external_source}) as Partial<Record<typeof field,{id?:number}[]>>|undefined;
      const matches=list(result?.[field]);
      const match=matches[0]?.id;
      if(matches.length===1&&positiveId(match))return match;
    }
  }

  private async readTitle(type:TitleKind,ids:ExternalIds) {
    if(!this.client.configured())return;
    const tmdbId=await this.resolve(type,ids);
    if(!tmdbId)return;
    const credits=type==='tv'?'aggregate_credits,credits,content_ratings':'credits,release_dates';
    const raw=await this.client.get(`/${type}/${tmdbId}`,{append_to_response:`${credits},external_ids,watch/providers`}) as TmdbDetail|undefined;
    if(raw&&!raw.adult)return {tmdbId,raw};
  }

  async credits(type:TitleKind,ids:ExternalIds):Promise<TitleCredits> {
    const title=await this.readTitle(type,ids);
    if(!title)return {credits:[]};
    const {tmdbId,raw}=title;
    const directors=list(raw.credits?.crew).filter(person=>person?.job==='Director');
    return {tmdbId,credits:[
      ...people([...list(raw.aggregate_credits?.cast),...list(raw.credits?.cast)],'actor',10),
      ...people(type==='movie'?directors:list(raw.created_by),type==='movie'?'director':'creator',2)
    ]};
  }

  async details(type:TitleKind,ids:ExternalIds,region:string) {
    const title=await this.readTitle(type,ids);
    if(!title)return;
    const {tmdbId,raw}=title;
    const item=tmdbCandidate({...raw,id:tmdbId,genre_ids:list(raw.genres).map(g=>g.id)},type)?.item;
    if(!item)return;
    const runtime=raw.runtime;
    if(typeof runtime==='number'&&runtime>0)item.durationMs=runtime*60000;
    if(positiveId(raw.number_of_episodes))item.episodeCount=raw.number_of_episodes;
    const imdb=raw.external_ids?.imdb_id||raw.imdb_id,tvdb=raw.external_ids?.tvdb_id;
    if(imdb&&/^tt\d{1,12}$/.test(imdb))item.ids.imdb=imdb;
    if(positiveId(tvdb))item.ids.tvdb=tvdb;
    const countries=(raw.production_countries?.length?raw.production_countries.map(c=>({code:c.iso_3166_1,name:c.name}))
      :list(raw.origin_country).map(code=>({code,name:code}))).filter(c=>c.name).map(c=>({...c,flagUrl:flagImage(c.code)}));
    const providers=list(raw['watch/providers']?.results?.[region]?.flatrate)
      .filter(p=>p.provider_name&&!/\bchannel\b/i.test(p.provider_name))
      .slice(0,8).map(p=>({name:p.provider_name!,logoUrl:tmdbImage(p.logo_path,'w92')}));
    const certificates=type==='movie'
      ?list(raw.release_dates?.results).map(value=>({region:value.iso_3166_1,rating:list(value.release_dates).find(entry=>entry.certification)?.certification}))
      :list(raw.content_ratings?.results).map(value=>({region:value.iso_3166_1,rating:value.rating}));
    const contentRating=certificates.find(c=>c.region===region&&c.rating)?.rating??certificates.find(c=>c.region==='US'&&c.rating)?.rating;
    const release=type==='movie'?raw.release_date:raw.first_air_date;
    return {
      item,genres:list(raw.genres).map(g=>g.name),cast:people([...list(raw.aggregate_credits?.cast),...list(raw.credits?.cast)],'actor',8).map(p=>p.name),
      tagline:raw.tagline||undefined,network:raw.networks?.[0]?.name,status:raw.status,contentRating,
      released:release&&/^\d{4}-\d{2}-\d{2}$/.test(release)?release:undefined,language:item.language,countries,
      studios:list(raw.production_companies).flatMap(c=>c.name??[]).slice(0,3),providers
    } satisfies Partial<ExploreDetails>;
  }

  async imdbPerson(name:string,type?:TitleKind,tmdb?:number) {
    if(!this.client.configured())return;
    const title=type&&tmdb?await this.readTitle(type,{tmdb}).catch(()=>undefined):undefined;
    const exact=(candidates:Person[])=>candidates.find(p=>positiveId(p?.id)&&text(p.name).toLowerCase()===name.toLowerCase());
    const raw=title?.raw;
    const candidates=[...list(raw?.aggregate_credits?.cast),...list(raw?.credits?.cast),...list(raw?.credits?.crew),...list(raw?.created_by)];
    const found=exact(candidates)??exact(list((await this.client.get('/search/person',{query:name}) as {results?:Person[]}|undefined)?.results));
    if(!found)return;
    const ids=await this.client.get(`/person/${found.id}/external_ids`) as {imdb_id?:string}|undefined;
    if(ids?.imdb_id&&/^nm\d{1,12}$/.test(ids.imdb_id))return ids.imdb_id;
  }

  private async filmography(person:TitleCredit|undefined,type:TitleKind,acting:boolean) {
    if(!person?.personId)return [];
    const raw=await this.client.get(`/person/${person.personId}/${type}_credits`) as {cast?:FilmCredit[];crew?:FilmCredit[]}|undefined;
    const entries=acting?list(raw?.cast):list(raw?.crew).filter(credit=>credit?.job==='Director'||
      (type==='tv'&&(credit?.job==='Creator'||credit?.job==='Executive Producer')));
    return entries.flatMap(credit=>tmdbCandidate(credit,type)??[]).sort((a,b)=>b.popularity-a.popularity);
  }

  async related(type:TitleKind,id:number):Promise<TitleRelated> {
    if(!this.client.configured())return {rows:[],failed:[]};
    const credits=this.credits(type,{tmdb:id});
    const maker=credits.then(result=>result.credits.find(person=>person.role===(type==='movie'?'director':'creator')&&person.personId));
    const actor=credits.then(result=>result.credits.find(person=>person.role==='actor'&&person.personId));
    const parent=`${type==='movie'?'movie':'show'}:tmdb:${id}`;
    const unique=(candidates:Candidate[],excluded:string[]=[])=>{
      const seen=new Set([parent,...excluded]);
      return candidates.flatMap(({item})=>{
        if(seen.has(item.key))return [];
        seen.add(item.key);
        return [item];
      }).slice(0,MAX_CARDS);
    };
    const similar=this.explore.suggestions(type,id).then(async recommendations=>{
      const items=unique(recommendations);
      return items.length?items:unique(await this.explore.suggestions(type,id,true));
    });
    const from=maker.then(async person=>({person,items:unique(await this.filmography(person,type,false))}));
    const withActor=actor.then(async person=>({person,items:await this.filmography(person,'movie',true)}));
    const [similarResult,makerResult,actorResult]=await Promise.allSettled([similar,from,withActor]);
    const rows:TitleRelated['rows']=[],failed:RelatedRowKind[]=[];
    if(similarResult.status==='rejected')failed.push('similar');
    else if(similarResult.value.length)rows.push({kind:'similar',items:similarResult.value});
    const made=makerResult.status==='fulfilled'&&makerResult.value.items.length>=4?makerResult.value:undefined;
    if(makerResult.status==='rejected')failed.push('maker');
    else if(made)rows.push({kind:'maker',...made});
    if(actorResult.status==='rejected')failed.push('actor');
    else {
      const items=unique(actorResult.value.items,made?.items.map(item=>item.key));
      if(items.length>=4)rows.push({kind:'actor',person:actorResult.value.person,items});
    }
    return {rows,failed};
  }
}
