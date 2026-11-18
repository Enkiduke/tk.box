// Admin › Downloads › Subtitles (docs/PHASE-4.md, step 4), over /api/v1/admin/subtitles.

export type SubtitleSource = 'embedded' | 'sidecar' | 'opensubtitles' | 'whisper';
export type SubtitleJobState = 'queued' | 'claimed' | 'done' | 'failed' | 'cancelled';

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
  // Every library file: with English, checked and missing it, or not checked yet; and checks queued or running.
  accounting: { total: number; english: number; missing: number; unchecked: number };
  checking: number;
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
// A video without English: checked and missing it, with the worker's job when OpenSubtitles had nothing, or skipped
// (the finder gave up on it). `at` is when that last changed.
export type SubtitleMissing = SubtitleVideo & {
  at: number;
  job?: { state: SubtitleJobState; notBefore: number; attempts: number; error?: string };
  skipped?: string;
};
export type SubtitleLists = { missing: SubtitleMissing[] };

// A title's files in its Admin dialog (GET /api/v1/admin/subtitles/title/:id), by library file id: English and where it
// came from; checked and missing it, with the worker's job if there is one; given up on; or not checked yet.
export type TitleSubtitle =
  | { state: 'english'; source: SubtitleSource; subtitlePath?: string; hashMatch?: boolean; at: number }
  | { state: 'missing'; at?: number; job?: { state: SubtitleJobState; notBefore: number; attempts: number; error?: string } }
  | { state: 'skipped'; reason: string; at: number }
  | { state: 'unchecked' };
export type TitleSubtitles = { files: Record<number, TitleSubtitle> };

// Admin › Downloads › Subtitles › Workers (docs/PHASE-5.md): the PC workers' tokens. A new token is shown once.
export type SubtitleWorkerView = { id: number; name: string; createdAt: number; lastSeenAt?: number; revokedAt?: number; holding: number };
export type SubtitleWorkers = { workers: SubtitleWorkerView[] };
export type SubtitleWorkerCreated = { worker: SubtitleWorkerView; token: string };
