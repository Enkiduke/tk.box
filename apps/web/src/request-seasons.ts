import type {ExploreSeason} from '../../../packages/contracts/src/index.js';

// Which seasons a series request asks Seerr for. Modes follow Sonarr's monitor options, but Seerr requests whole
// seasons, so each becomes a season list. Seasons already on the server or requested are never asked for again.
export type SeasonMode='all'|'first'|'last'|'manual';
export const seasonModes:[SeasonMode,string][]=[['all','All Seasons'],['first','First Season'],['last','Last Season'],['manual','Manual']];

export function seasonsFor(mode:SeasonMode,seasons:ExploreSeason[],options:{picked?:number[]}={}) {
  const sorted=[...seasons].sort((a,b)=>a.number-b.number);
  const take=(list:(ExploreSeason|undefined)[])=>list.filter((s):s is ExploreSeason=>!!s&&!s.status).map(s=>s.number).sort((a,b)=>a-b);
  if(mode==='all')return take(sorted);
  if(mode==='first')return take([sorted[0]]);
  if(mode==='last')return take([sorted.at(-1)]);
  return take(seasons.filter(s=>options.picked?.includes(s.number)));
}
// "Season 3", "Seasons 1–4" or "Seasons 1, 3 and 5".
export function seasonList(numbers:number[]) {
  if(!numbers.length)return 'No seasons';
  if(numbers.length===1)return `Season ${numbers[0]}`;
  if(numbers.every((n,i)=>!i||n===numbers[i-1]!+1))return `Seasons ${numbers[0]}–${numbers.at(-1)}`;
  return `Seasons ${numbers.slice(0,-1).join(', ')} and ${numbers.at(-1)}`;
}
