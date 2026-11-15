// Admin › Downloads (docs/ARR-REPLACEMENT.md, "Admin UI"): what the library, indexers and downloaders routes answer.
// Movies only in phase 1. Times are epoch ms; sizes are bytes, except profile sizes, which are GB.

export type GrabState = 'sending' | 'downloading' | 'unpacking' | 'importing' | 'imported' | 'seeding' | 'done' | 'failed' | 'cancelled';
export type DownloadsGrab = {
  id: number; titleId: number; title: string; year?: number; releaseName: string; indexer: string; protocol: 'usenet' | 'torrent';
  size?: number; quality: string; score: number; upgrade: boolean; state: GrabState; progress?: number; error?: string;
  sentAt?: number; finishedAt?: number; importedAt?: number;
};
export type DownloadsJobState = 'queued' | 'running' | 'failed';
// A queue item: `subject` names the title it is for, when it is for one.
export type DownloadsJob = { id: number; kind: string; label: string; subject?: string; titleId?: number; state: DownloadsJobState; runAt: number;
  attempts: number; maxAttempts: number; lastError?: string; updatedAt: number };
export type DownloadsActivity = { open: DownloadsGrab[]; failed: DownloadsGrab[]; history: DownloadsGrab[]; jobs: DownloadsJob[] };

export type WantedItem = { id: number; title: string; year?: number; why: 'missing' | 'cutoff'; quality?: string; paused: boolean; pausedReason?: string;
  nextAt?: number; lastAt?: number; misses: number; grab?: GrabState };
export type WantedList = { items: WantedItem[] };

export type LibraryFileView = { id: number; path: string; size: number; quality: string; proper: boolean; score: number; releaseName?: string; releaseGroup?: string;
  importedAt: number; media: { durationSec?: number; videoCodec?: string; dynamicRange?: string; audioCodec?: string; audioChannels?: string; copied?: boolean } };
export type LibraryTitleView = {
  id: number; tmdbId: number; imdbId?: string; title: string; year?: number; profileId: number; keep: boolean; monitored: boolean;
  paused: boolean; pausedReason?: string; wanted: { wanted: boolean; why: string };
  released: { theatrical?: string; digital?: string; physical?: string };
  nextAt?: number; lastAt?: number; misses: number;
  files: LibraryFileView[]; grabs: DownloadsGrab[]; profiles: { id: number; name: string }[];
};
export type InteractiveRelease = { guid: string; name: string; indexer: string; protocol: 'usenet' | 'torrent'; size?: number; publishedAt?: number; grabs?: number;
  quality?: string; score: number; accepted: boolean; upgrade: boolean; reasons: string[] };
export type InteractiveSearch = { releases: InteractiveRelease[]; indexers: { indexer: string; searched: string[]; error?: string }[] };

export type IndexerView = {
  name: 'nzbgeek' | 'iptorrents'; enabled: boolean; secretSet: boolean;
  settings: { categories: { movies: number[]; tv: number[] }; hourlyCap: number; dailyCap: number };
  lastOkAt: number | null; lastError: string | null; pausedUntil: number | null; today: { searches: number; grabs: number }; thisHour: number;
};
export type DownloaderView = { name: 'sabnzbd' | 'qbittorrent'; url: string; secretSet: boolean; settings: { categories: { movie: string; show: string }; priority?: number } };
export type ConnectionTest = { ok: true; detail: string };

export type PickProfile = { qualities: { name: string; allowed: boolean }[]; cutoff: string; movieSize: [number, number]; episodeSize: [number, number] };
// `version` changes whenever the profile does; a save names the version it started from.
export type PickProfileView = { id: number; name: string; value: PickProfile; used: number; version: string };
export type ScoreRuleView = { name: string; label?: string; pattern: string; points: number; ban: boolean; applies: 'movie' | 'show' | 'both' };
export type PickRules = { profiles: PickProfileView[]; rules: ScoreRuleView[]; rulesVersion: string; ladder: string[]; earlyCopies: string[] };

export type LibrarySettingsView = {
  revision: number; roots: { movie: string; show: string };
  naming: { movieFolder: string; movieFile: string; seriesFolder: string; seasonFolder: string; episodeFile: string };
  earlyCopies: boolean; protocol: 'usenet-first' | 'torrent-first'; defaultProfile: number; fulfil: { movie: 'radarr' | 'tkbox'; show: 'sonarr' | 'tkbox' };
};
export type NamingPreview = { quality?: string; folder: string; file: string; path: string };

// Admin › Downloads › Cutover (docs/ARR-REPLACEMENT.md, Phase 1 › Cutover). A blocking problem (Radarr's naming differs
// from tk.box's) stops the import; the rest are titles or files left out.
export type CutoverProblem = { kind: 'naming' | 'no-tmdb' | 'outside-root' | 'quality' | 'duplicate'; blocking: boolean; title?: string; detail: string };
export type CutoverPlan = {
  summary: { movies: number; importable: number; monitored: number; files: number; keep: number; problems: number; added?: number; updated?: number };
  problems: CutoverProblem[]; namingOk: boolean;
};
export type CutoverView = { fulfil: 'radarr' | 'tkbox'; imported: number; importedAt?: number; summary?: Record<string, number>; switchedAt?: number; switchedBackAt?: number;
  requests?: { moved: number; resent: number; cleared: number } };
