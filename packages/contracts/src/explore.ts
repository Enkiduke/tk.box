// A third-party score from the item's Plex agent, on Plex's 0–10 scale. `fresh` is Rotten Tomatoes' fresh/upright state.
export type ExternalRating = {source: 'imdb' | 'tomatometer' | 'popcornmeter' | 'tmdb'; score: number; fresh?: boolean};
// Keep the preferred score when multiple providers report the same meter.
export function mergeRatings(preferred: ExternalRating[] = [], extra: ExternalRating[] = []) {
  return [...preferred, ...extra.filter(rating => !preferred.some(first => first.source === rating.source))];
}

// Explore: titles from catalog sources outside the Plex server (Plex Discover, TMDB).
export const exploreSources = ['plex', 'tmdb'] as const;
export type ExploreSource = typeof exploreSources[number];
export const exploreBrowseSources = ['plex', 'tmdb'] as const;
export type ExploreBrowseSource = typeof exploreBrowseSources[number];
export const streamingRows = ['popular-streaming', 'recent-streaming'] as const;
export type StreamingRow = typeof streamingRows[number];
// TMDB's rows in their default order. The `top-` and `because-` rows are each viewer's own suggestions.
export const tmdbExploreRows = ['popular-movies', 'popular-shows', 'top-movies', 'top-shows', 'trending', 'because-movie', 'popular-streaming',
  'because-show', 'recent-streaming', 'acclaimed', 'upcoming-movies', 'upcoming-shows'] as const;
export type TmdbExploreRow = typeof tmdbExploreRows[number];
// The genres Explore filters on: TMDB's movie and TV genres and Plex's, merged into one list.
export const exploreGenres = ['Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Kids',
  'Music', 'Mystery', 'Reality', 'Romance', 'Sci-Fi', 'Thriller', 'War', 'Western'] as const;
export type ExploreGenre = typeof exploreGenres[number];
