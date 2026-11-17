import { AppError } from '../errors.js';
import type { RequestRelease } from '../../../../packages/contracts/src/index.js';

// How a request reaches tk.box's library (LibraryFulfiller): the calls requests make, by kind.
export type FulfilKind = 'movie' | 'show';
export type FulfilTarget = { kind: FulfilKind; tmdbId: number; tvdbId?: number; title: string; seasons: number[]; monitorFuture: boolean;
  profileId?: number; rootFolder?: string; tags: number[]; search: boolean; seasonFolders?: boolean;
  // The requester's account id (the library records who added a title).
  requestedBy?: string };
// What is downloading: the library's movie ids, and its shows with their seasons (`undefined` when a grab names none).
export type QueueState = { movies: Set<number>; series: Map<number, Set<number | undefined>> };
export type FulfilOptions = { connected: boolean; tkbox?: boolean; profiles: { id: number; name: string }[]; rootFolders: { path: string; freeSpace?: number }[]; tags: { id: number; label: string }[] };
export type FulfilProgress = { at?: number; release?: RequestRelease };
export interface Fulfiller {
  // Adds the title, or monitors and searches it when it's already there. Returns its id there.
  add(target: FulfilTarget): Promise<number>;
  queue(): Promise<QueueState>;
  // Its id there, if it has the title (for requests imported from Seerr, which tk.box never sent).
  find(kind: FulfilKind, tmdbId: number, tvdbId?: number): Promise<number | undefined>;
  // false once the title has been deleted there.
  exists(kind: FulfilKind, arrId: number): Promise<boolean>;
  progress(kind: FulfilKind, arrId: number, seasons: number[], now: number): Promise<FulfilProgress>;
  // Stops watching the movie, or these seasons of the show.
  unmonitor(kind: FulfilKind, arrId: number, seasons: number[]): Promise<void>;
  options(kind: FulfilKind): Promise<FulfilOptions>;
  // The tag that marks a request's Favorite ('Keep') or a movie's Early copies ('Early copies').
  tagId?(kind: FulfilKind, label: string): Promise<number>;
}

// `permanent`: trying again won't help (it was refused). Otherwise the sweep retries later.
export class FulfilError extends AppError {
  constructor(message: string, readonly permanent: boolean) { super('REQUEST_SEND_FAILED', message, 502); }
}

