// Admin › Downloads › Subtitles (docs/PHASE-4.md, step 4), over /api/v1/admin/subtitles.

export type SubtitleSource = 'embedded' | 'sidecar' | 'opensubtitles' | 'whisper';
export type SubtitleJobState = 'waiting' | 'queued' | 'claimed' | 'done' | 'failed' | 'cancelled';

export type SubtitlesView = {
  revision: number;
  enabled: boolean;
  dailyCap: number;
  preferHearingImpaired: boolean;
  // Which parts of the OpenSubtitles login are saved; the username is shown, the key and password never are.
  login: { apiKey: boolean; username?: string; password: boolean };
  today: number;
  // Why the finder is stopped (no login, or OpenSubtitles refused it).
  blocked?: string;
  // The library's files, and how many the finder hasn't dealt with yet.
  progress: { total: number; left: number };
  sources: Record<SubtitleSource, number>;
  jobs: Record<SubtitleJobState, number>;
  skipped: number;
};

export type SubtitlesInput = {
  expectedRevision: number;
  enabled?: boolean;
  dailyCap?: number;
  preferHearingImpaired?: boolean;
};
// Admin › Connections › OpenSubtitles. Each is saved when given; an empty string clears it.
export type SubtitlesLoginInput = {
  expectedRevision: number;
  apiKey?: string;
  username?: string;
  password?: string;
};

export type SubtitlesTest = { ok: true; vip: boolean; level?: string; allowedDownloads?: number; remaining?: number };

// A video in one of the lists, with the library title it belongs to when the library still has it.
export type SubtitleVideo = {
  path: string;
  titleId?: number; title?: string; year?: number; kind?: 'movie' | 'show';
  // A show's file: the episodes it holds (S01E02, S01E02–E03).
  episodes?: string;
};
export type SubtitleFound = SubtitleVideo & { source: SubtitleSource; at: number; subtitlePath?: string; hashMatch?: boolean };
export type SubtitleJob = SubtitleVideo & { state: SubtitleJobState; notBefore: number; attempts: number; error?: string; createdAt: number };
export type SubtitleSkip = SubtitleVideo & { reason: string; at: number };
export type SubtitleLists = { found: SubtitleFound[]; jobs: SubtitleJob[]; skipped: SubtitleSkip[] };
