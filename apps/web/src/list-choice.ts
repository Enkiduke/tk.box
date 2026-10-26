// Which of a list's titles a collection keeps, as the editor shows it while you change the filters, the sort and the
// collection size: the same rules, in the same order, as the engine's choose_titles (plex_collections.py), which is
// what each collection run actually uses.
import type {ListFilter,ListSort,Member} from './collection-files.js';

export type Details={year:number|null;rating:number|null;language:string|null;genres:string[];certification:string|null};
export type Candidate={title:string;year?:string|number;member:Member;details:Details|null};
export type LeftOut={title:string;year?:string|number;member:Member;why:string};

const same=(a:Member,b:Member)=>{const keys=Object.keys(a) as (keyof Member)[];return keys.length===Object.keys(b).length&&keys.every(k=>a[k]===b[k]);};
const fold=(names:string[])=>new Set(names.map(n=>n.trim().toLowerCase()));
const roundAnniversary=(age:number)=>age>0&&(age%10===0||age%25===0);

// The ISO year and week, as "2026-43": "random" keeps one order all week.
export function isoWeek(day:Date) {
  const t=new Date(Date.UTC(day.getFullYear(),day.getMonth(),day.getDate())),weekday=t.getUTCDay()||7;
  t.setUTCDate(t.getUTCDate()+4-weekday);
  const year=t.getUTCFullYear(),week=Math.ceil(((t.getTime()-Date.UTC(year,0,1))/86400000+1)/7);
  return `${year}-${String(week).padStart(2,'0')}`;
}
// FNV-1a of the week and a member, like the engine's week_hash.
export function weekHash(week:string,member:Member) {
  const text=week+'|'+Object.keys(member).sort().map(k=>`${k}=${member[k as keyof Member]}`).join('&');
  let value=0x811c9dc5;
  for(const byte of new TextEncoder().encode(text))value=Math.imul(value^byte,0x01000193)>>>0;
  return value;
}

function why(d:Details|null,f:ListFilter):string|undefined {
  const filtered=Object.keys(f).length>0;
  if(!d)return filtered?'no TMDb details':undefined;
  if((f.year_from!==undefined||f.year_to!==undefined)&&!d.year)return 'no release year';
  if(d.year&&d.year<(f.year_from??0))return `released before ${f.year_from}`;
  if(d.year&&d.year>(f.year_to??9999))return `released after ${f.year_to}`;
  if(f.min_rating!==undefined&&(d.rating??0)<f.min_rating)return `rated below ${f.min_rating} on TMDb`;
  if(f.max_rating!==undefined&&(d.rating??0)>f.max_rating)return `rated above ${f.max_rating} on TMDb`;
  if(f.languages?.length&&!fold(f.languages).has((d.language??'').toLowerCase()))return 'in a language left out';
  const genres=fold(d.genres);
  if([...fold(f.exclude_genres??[])].some(g=>genres.has(g)))return 'in a genre left out';
  if(fold(f.exclude_certifications??[]).has((d.certification||'NR').toLowerCase()))return `rated ${d.certification||'NR'}`;
  return undefined;
}

export function chooseTitles(rows:Candidate[],choice:{filter?:ListFilter;sort?:ListSort},limit:number,exclude:Member[]=[],today=new Date()) {
  const f=choice.filter??{},kept:Candidate[]=[],left:LeftOut[]=[];
  for(const row of rows){
    if(exclude.some(m=>same(m,row.member)))continue;
    const reason=why(row.details,f);
    if(reason)left.push({title:row.title,year:row.year,member:row.member,why:reason});else kept.push(row);
  }
  const year=(r:Candidate)=>r.details?.year??null,week=isoWeek(today);
  const keys:Partial<Record<ListSort,(r:Candidate)=>number>>={
    rating:r=>-(r.details?.rating??0),oldest:r=>year(r)||9999,newest:r=>-(year(r)||0),
    anniversary:r=>{const y=year(r);return y&&roundAnniversary(today.getFullYear()-y)?0:1;},random:r=>weekHash(week,r.member)};
  const key=choice.sort&&keys[choice.sort];
  if(key)kept.sort((a,b)=>key(a)-key(b));
  left.push(...kept.slice(limit).map(r=>({title:r.title,year:r.year,member:r.member,why:'beyond the collection size'})));
  return {kept:kept.slice(0,limit),left};
}
