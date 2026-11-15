import {exploreGenres,type ExploreGenre} from '../../../../packages/contracts/src/index.js';

// Sources name genres their own way: TMDB's TV genres pair two ("Sci-Fi & Fantasy"), Plex says "Science Fiction".
// Each name becomes Explore's genres; names Explore doesn't filter on (News, Talk, TV Movie) are dropped.
const aliases:Record<string,ExploreGenre>={'science fiction':'Sci-Fi','sci-fi':'Sci-Fi',children:'Kids',musical:'Music',anime:'Animation',suspense:'Thriller'};
const known=new Map<string,ExploreGenre>(exploreGenres.map(g=>[g.toLowerCase(),g]));
export function exploreGenresOf(names:(string|undefined)[]):ExploreGenre[] {
  const found=new Set<ExploreGenre>();
  for(const name of names)for(const part of (name??'').split(/&|\band\b/)){const key=part.trim().toLowerCase(),genre=aliases[key]??known.get(key);if(genre)found.add(genre);}
  return exploreGenres.filter(g=>found.has(g));
}
// TMDB's genre ids, movies' and TV's (the two lists share ids only where the names match).
const tmdbNames:Record<number,string>={28:'Action',12:'Adventure',16:'Animation',35:'Comedy',80:'Crime',99:'Documentary',18:'Drama',10751:'Family',14:'Fantasy',
  36:'History',27:'Horror',10402:'Music',9648:'Mystery',10749:'Romance',878:'Science Fiction',53:'Thriller',10752:'War',37:'Western',
  10759:'Action & Adventure',10762:'Kids',10764:'Reality',10765:'Sci-Fi & Fantasy',10768:'War & Politics'};
export const tmdbGenres=(ids:number[])=>exploreGenresOf(ids.map(id=>tmdbNames[id]));
