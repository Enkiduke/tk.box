// Admin › Downloads (docs/ARR-REPLACEMENT.md, "Admin UI"): what the library, indexers and downloaders routes answer.
// Movies only so far (phases 1 and 3). Times are epoch ms; sizes are bytes, except profile sizes, which are GB.

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
// A seeding torrent: its ratio and days seeded as qBittorrent last gave them (`checkedAt`), and when the seeding rule
// will remove it (`removeAt`, the earliest certain time: the ratio already met, or the longest seeding).
export type DownloadsSeeding = DownloadsGrab & { ratio?: number; seedingDays?: number; checkedAt?: number; removeAt?: number };
export type DownloadsActivity = { open: DownloadsGrab[]; seeding: DownloadsSeeding[]; failed: DownloadsGrab[]; history: DownloadsGrab[]; jobs: DownloadsJob[] };

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
  seeders?: number; freeleech?: boolean;
  quality?: string; score: number; accepted: boolean; upgrade: boolean; reasons: string[] };
export type InteractiveSearch = { releases: InteractiveRelease[]; indexers: { indexer: string; searched: string[]; error?: string }[] };

export type IndexerView = {
  name: 'nzbgeek' | 'iptorrents'; enabled: boolean; secretSet: boolean;
  settings: { categories: { movies: number[]; tv: number[] }; hourlyCap: number; dailyCap: number; freeleechOnly: boolean };
  // IPTorrents: which parts of its secret are saved (the user agent isn't secret).
  iptorrents?: { rssSet: boolean; cookieSet: boolean; userAgent: string };
  lastOkAt: number | null; lastError: string | null; pausedUntil: number | null; today: { searches: number; grabs: number }; thisHour: number;
};
export type DownloaderView = { name: 'sabnzbd' | 'qbittorrent'; url: string; secretSet: boolean; settings: { categories: { movie: string; show: string }; priority?: number };
  qbittorrent?: { username: string; passwordSet: boolean } };
export type ConnectionTest = { ok: true; detail: string };

export type PickProfile = { qualities: { name: string; allowed: boolean }[]; cutoff: string; movieSize: [number, number]; episodeSize: [number, number] };
// `version` changes whenever the profile does; a save names the version it started from.
export type PickProfileView = { id: number; name: string; value: PickProfile; used: number; version: string };
export type ScoreRuleView = { name: string; label?: string; pattern: string; points: number; ban: boolean; applies: 'movie' | 'show' | 'both' };
export type PickRules = { profiles: PickProfileView[]; rules: ScoreRuleView[]; rulesVersion: string; ladder: string[]; earlyCopies: string[] };

export type LibrarySettingsView = {
  revision: number; roots: { movie: string; show: string };
  naming: { movieFolder: string; movieFile: string; seriesFolder: string; seasonFolder: string; episodeFile: string };
  earlyCopies: boolean; protocol: 'usenet-first' | 'torrent-first'; defaultProfile: number; fulfil: { show: 'sonarr' | 'tkbox' };
};
export type NamingPreview = { quality?: string; folder: string; file: string; path: string };
