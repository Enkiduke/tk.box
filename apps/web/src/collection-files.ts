// Custom and seasonal collections as JSON, in the engine's own format: Export writes one with every setting and title,
// Import reads one or a list of them back (from Export, or written by hand or by an AI). Only known fields are kept;
// saving checks the rest as it does for any collection.
export type Member={rating_key?:string;tmdb_id?:number;imdb_id?:string;title?:string;year?:number};
export type Visibility={home?:boolean;shared?:boolean;recommended?:boolean};
export type Definition={name:string;library:string;type:'movie'|'tv';enabled?:boolean;schedule?:string;members?:Member[];
  rules?:{genres?:string[];year_from?:number;year_to?:number;title_contains?:string};visibility?:Visibility;
  acquire?:boolean;cleanup?:'keep'|'remove-delete'|'rotate';hide_recent?:boolean;source?:Source;exclude?:Member[]};
// Which of a list's titles a collection keeps: filtered, sorted, then cut to `limit`.
// Genres and ratings name what's left out, so one a list gains later is in; languages name what's kept.
export type ListFilter={year_from?:number;year_to?:number;min_rating?:number;max_rating?:number;languages?:string[];exclude_genres?:string[];exclude_certifications?:string[]};
export type ListSort='list'|'rating'|'oldest'|'newest'|'anniversary'|'random';
export type Source={url:string;limit?:number;refresh?:boolean;filter?:ListFilter;sort?:ListSort};
const sorts:readonly ListSort[]=['list','rating','oldest','newest','anniversary','random'];

export const exportCollection=(definition:Definition)=>JSON.stringify(definition,null,2)+'\n';

type Raw=Record<string,unknown>;
const isObject=(v:unknown):v is Raw=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const text=(v:unknown)=>typeof v==='string'&&v.trim()?v.trim():undefined;
const whole=(v:unknown)=>typeof v==='number'&&Number.isInteger(v)?v:undefined;
const flag=(v:unknown)=>typeof v==='boolean'?v:undefined;
// Drops the fields left undefined, so a title or setting the JSON didn't have stays unset.
const tidy=<T extends object>(value:T)=>Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined)) as T;

function member(v:unknown):Member|undefined {
  if(!isObject(v))return undefined;
  const m=tidy<Member>({rating_key:text(v.rating_key)??(whole(v.rating_key)?.toString()),tmdb_id:whole(v.tmdb_id),imdb_id:text(v.imdb_id),title:text(v.title),year:whole(v.year)});
  return m.rating_key||m.tmdb_id||m.imdb_id||m.title?m:undefined;
}
const members=(v:unknown)=>Array.isArray(v)?v.map(member).filter((m):m is Member=>!!m):undefined;

function definition(v:unknown,at:number):Definition {
  const where=`Collection ${at+1}`;
  if(!isObject(v))throw new Error(`${where} isn’t a collection.`);
  const name=text(v.name),library=text(v.library);
  if(!name)throw new Error(`${where} has no name.`);
  if(!library)throw new Error(`${name} has no library.`);
  if(v.type!=='movie'&&v.type!=='tv')throw new Error(`${name} isn’t movies or TV.`);
  const rules=isObject(v.rules)?tidy({genres:Array.isArray(v.rules.genres)?v.rules.genres.filter((g):g is string=>typeof g==='string'):undefined,
    year_from:whole(v.rules.year_from),year_to:whole(v.rules.year_to),title_contains:text(v.rules.title_contains)}):undefined;
  const visibility=isObject(v.visibility)?tidy<Visibility>({home:flag(v.visibility.home),shared:flag(v.visibility.shared),recommended:flag(v.visibility.recommended)}):undefined;
  const names=(x:unknown)=>Array.isArray(x)?x.filter((n):n is string=>typeof n==='string'&&!!n.trim()):undefined;
  const filter=isObject(v.source)&&isObject(v.source.filter)?tidy<ListFilter>({year_from:whole(v.source.filter.year_from),year_to:whole(v.source.filter.year_to),
    min_rating:typeof v.source.filter.min_rating==='number'?v.source.filter.min_rating:undefined,max_rating:typeof v.source.filter.max_rating==='number'?v.source.filter.max_rating:undefined,
    languages:names(v.source.filter.languages),exclude_genres:names(v.source.filter.exclude_genres),exclude_certifications:names(v.source.filter.exclude_certifications)}):undefined;
  const source=isObject(v.source)&&text(v.source.url)?tidy<Source>({url:text(v.source.url)!,limit:whole(v.source.limit),refresh:flag(v.source.refresh),
    filter:filter&&Object.keys(filter).length?filter:undefined,sort:sorts.find(x=>x===(v.source as Raw).sort&&x!=='list')}):undefined;
  const exclude=members(v.exclude);
  return tidy<Definition>({name,library,type:v.type,enabled:flag(v.enabled),schedule:text(v.schedule),
    members:members(v.members)??[],rules:rules&&Object.keys(rules).length?rules:undefined,visibility,
    acquire:flag(v.acquire),cleanup:v.cleanup==='keep'||v.cleanup==='remove-delete'||v.cleanup==='rotate'?v.cleanup:undefined,hide_recent:flag(v.hide_recent),source,exclude:exclude?.length?exclude:undefined});
}

// Reads one collection or a list of them (or {"collections": [...]}), inside a ```json fence or not, as an AI may give it.
export function readCollections(json:string):Definition[] {
  let parsed:unknown;
  try{parsed=JSON.parse(json.trim().replace(/^```[a-z]*\s*|\s*```$/gi,''));}catch{throw new Error('This isn’t valid JSON.');}
  const list=Array.isArray(parsed)?parsed:isObject(parsed)&&Array.isArray(parsed.collections)?parsed.collections:isObject(parsed)?[parsed]:undefined;
  if(!list)throw new Error('Paste one collection, or a list of them.');
  if(!list.length)throw new Error('There are no collections in this.');
  return list.map(definition);
}

// Titles known only by their Plex ID, which another Plex server won't have.
export const plexOnly=(d:Definition)=>(d.members??[]).filter(m=>m.rating_key&&!m.tmdb_id&&!m.imdb_id&&!m.title).length;
