import type {ExploreItem,PersonCoStars,PersonCredit,PersonDetails} from '../../../../packages/contracts/src/index.js';
import {tmdbImage} from './explore-images.js';
import {tmdbCandidate} from './tmdb-explore.js';
import type {TmdbTitles} from './tmdb-titles.js';
import type {TmdbTitleDiscovery} from './tmdb-title-discovery.js';

// A person's page from TMDB: one cached read of /person/{id} with combined credits and external IDs, shaped into
// Known for, Coming soon, In your Library and the full filmography. Co-stars are a second, lazier read.
type RawCredit=NonNullable<Parameters<typeof tmdbCandidate>[0]>&{media_type?:unknown;character?:unknown;job?:unknown};
export type RawPerson={
  id?:unknown;name?:unknown;profile_path?:unknown;known_for_department?:unknown;biography?:unknown;
  birthday?:unknown;deathday?:unknown;place_of_birth?:unknown;adult?:unknown;
  combined_credits?:{cast?:RawCredit[];crew?:RawCredit[]};external_ids?:{imdb_id?:unknown};
};
const list=<T>(value:T[]|undefined):T[]=>Array.isArray(value)?value:[];
const text=(value:unknown)=>typeof value==='string'?value.trim():'';
const day=(value:unknown)=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)?value:undefined;
// Talk, news and reality shows, and appearances as themselves, are not roles.
const UNSCRIPTED=new Set([10763,10764,10767]);
const selfRole=(character:string)=>/\b(?:self|himself|herself|themselves)\b/i.test(character);
const departments:Record<string,string>={Acting:'Actor',Directing:'Director',Writing:'Writer',Production:'Producer',Sound:'Composer',Camera:'Cinematographer',Editing:'Editor'};
const KNOWN_FOR=8,UPCOMING=8;

// `label` puts tk.box's request labels on the titles (In your Library is the titles labelled available or partial).
export type Label=(items:ExploreItem[])=>ExploreItem[];
export function personDetails(raw:RawPerson,today:string,label:Label=items=>items):PersonDetails|undefined {
  const id=raw.id,name=text(raw.name);
  if(typeof id!=='number'||!Number.isSafeInteger(id)||id<=0||!name||raw.adult===true)return;
  const credits=new Map<string,PersonCredit>();
  const add=(credit:RawCredit,role:'actor'|'director')=>{
    const type=credit?.media_type==='tv'?'tv':credit?.media_type==='movie'?'movie':undefined;
    if(!type||list(credit.genre_ids).some(g=>UNSCRIPTED.has(g)))return;
    const character=role==='actor'?text(credit.character):'';
    if(character&&selfRole(character))return;
    const candidate=tmdbCandidate(credit,type);
    if(!candidate)return;
    const found=credits.get(candidate.item.key);
    if(found){
      if(!found.roles.includes(role))found.roles.push(role);
      if(character&&!found.character)found.character=character;
      return;
    }
    credits.set(candidate.item.key,{item:candidate.item,roles:[role],...(character?{character}:{}),
      ...(role==='director'?{job:text(credit.job)}:{}),votes:candidate.votes,popularity:candidate.popularity,...(candidate.date?{date:candidate.date}:{})});
  };
  for(const credit of list(raw.combined_credits?.cast))add(credit,'actor');
  for(const credit of list(raw.combined_credits?.crew))if(credit?.job==='Director'||(credit?.media_type==='tv'&&credit?.job==='Creator'))add(credit,'director');
  const unlabelled=[...credits.values()],items=label(unlabelled.map(c=>c.item));
  const all=unlabelled.map((c,i)=>({...c,item:items[i]??c.item}));
  const released=all.filter(c=>c.date&&c.date<=today);
  // Unreleased: dated later than today, or a movie without a date yet (announced, in production).
  const upcoming=all.filter(c=>c.date?c.date>today:c.item.kind==='movie')
    .sort((a,b)=>(a.date??'9999').localeCompare(b.date??'9999')||b.popularity-a.popularity).slice(0,UPCOMING);
  const knownFor=[...released].sort((a,b)=>b.votes-a.votes||b.popularity-a.popularity).slice(0,KNOWN_FOR);
  const library=all.filter(c=>c.item.status==='available'||c.item.status==='partial').sort((a,b)=>(b.date??'').localeCompare(a.date??''));
  const years=released.map(c=>c.item.year).filter((y):y is number=>!!y);
  const department=text(raw.known_for_department),imdb=text(raw.external_ids?.imdb_id);
  const biography=text(raw.biography),birthplace=text(raw.place_of_birth);
  return {
    id,name,photoUrl:tmdbImage(typeof raw.profile_path==='string'?raw.profile_path:undefined,'w342'),
    ...(department?{department:departments[department]??department}:{}),...(years.length?{since:Math.min(...years)}:{}),
    ...(biography?{biography}:{}),...(day(raw.birthday)?{birthday:day(raw.birthday)}:{}),...(day(raw.deathday)?{deathday:day(raw.deathday)}:{}),
    ...(birthplace?{birthplace}:{}),...(/^nm\d{1,12}$/.test(imdb)?{imdb}:{}),
    movies:released.filter(c=>c.item.kind==='movie').length,shows:released.filter(c=>c.item.kind==='show').length,
    knownFor,upcoming,library,credits:all
  };
}

// Co-stars: people in at least two of the casts of the person's best-known titles, most shared first.
export function coStars(id:number,casts:{personId?:number;name:string;portraitUrl?:string;role:string}[][],limit=8):PersonCoStars {
  const seen=new Map<number,{id:number;name:string;portraitUrl?:string;shared:number;first:number}>();
  casts.forEach((cast,index)=>{
    const once=new Set<number>();
    for(const person of cast){
      if(person.role!=='actor'||!person.personId||person.personId===id||once.has(person.personId))continue;
      once.add(person.personId);
      const found=seen.get(person.personId);
      if(found)found.shared++;
      else seen.set(person.personId,{id:person.personId,name:person.name,...(person.portraitUrl?{portraitUrl:person.portraitUrl}:{}),shared:1,first:index});
    }
  });
  return {people:[...seen.values()].filter(p=>p.shared>=2).sort((a,b)=>b.shared-a.shared||a.first-b.first).slice(0,limit)
    .map(({first:_,...person})=>person)};
}

export class TmdbPeople {
  constructor(private client:TmdbTitles,private titles:TmdbTitleDiscovery,private now=Date.now) {}
  raw(id:number) {return this.client.get(`/person/${id}`,{append_to_response:'combined_credits,external_ids'}) as Promise<RawPerson|undefined>;}
  private today() {return new Date(this.now()).toISOString().slice(0,10);}
  async details(id:number,label:Label):Promise<PersonDetails|undefined> {
    const raw=await this.raw(id);
    return raw?personDetails(raw,this.today(),label):undefined;
  }
  async coStars(id:number):Promise<PersonCoStars> {
    const raw=await this.raw(id);
    const person=raw&&personDetails(raw,this.today());
    if(!person)return {people:[]};
    const top=person.knownFor.filter(c=>c.roles.includes('actor')).slice(0,8);
    const casts=await Promise.all(top.map(c=>this.titles.credits(c.item.kind==='show'?'tv':'movie',{tmdb:c.item.ids.tmdb}).then(r=>r.credits,()=>[])));
    return coStars(id,casts);
  }
}
