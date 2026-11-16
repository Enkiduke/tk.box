// Admin › Downloads (docs/ARR-REPLACEMENT.md, "Admin UI"): what the library, indexers and downloaders routes answer.
// Movies only so far (phases 1 and 3). Times are epoch ms; sizes are bytes, except profile sizes, which are GB.

export type GrabState = 'sending' | 'downloading' | 'unpacking' | 'importing' | 'imported' | 'seeding' | 'done' | 'failed' | 'cancelled';
export type DownloadsGrab = {
  id: number; titleId: number; title: string; year?: number; releaseName: string; indexer: string; protocol: 'usenet' | 'torrent';
  size?: number; quality: string; score: number; upgrade: boolean; state: GrabState; progress?: number; error?: string;
  sentAt?: number; finishedAt?: number; importedAt?: number;
};
// Admin › Downloads › History: one step of one grab, newest first. `kind` is the state it moved to, or grabbed / retried;
// `note` says more (the error, where it was imported, why it was removed, "By hand").
export type GrabEventKind = GrabState | 'grabbed' | 'retried';
export type DownloadsEvent = { id: number; at: number; kind: GrabEventKind; note?: string; grab: DownloadsGrab };
export type DownloadsHistory = { events: DownloadsEvent[] };
export type DownloadsJobState = 'queued' | 'running' | 'failed';
// A queue item: `subject` names the title it is for, when it is for one.
export type DownloadsJob = { id: number; kind: string; label: string; subject?: string; titleId?: number; state: DownloadsJobState; runAt: number;
  attempts: number; maxAttempts: number; lastError?: string; updatedAt: number };
// A seeding torrent: its ratio and days seeded as qBittorrent last gave them (`checkedAt`), and when the seeding rule
// will remove it (`removeAt`, the earliest certain time: the ratio already met, or the longest seeding).
export type DownloadsSeeding = DownloadsGrab & { ratio?: number; seedingDays?: number; checkedAt?: number; removeAt?: number };
export type DownloadsActivity = { open: DownloadsGrab[]; seeding: DownloadsSeeding[]; failed: DownloadsGrab[]; history: DownloadsGrab[]; jobs: DownloadsJob[] };

// Admin › Downloads › Queue, live: everything the downloaders hold (not only tk.box's), as they say it. `state` is
// tk.box's word for the client's state, `detail` the client's own when it says more ("Fetching metadata", "Verifying").
// Speeds are bytes/s, `eta` seconds, times epoch ms. `mine`: in a tk.box category (or tagged tk.box). `grab`: the
// tk.box grab it is, when it is one; a grab with nothing in a downloader (sending, importing) comes as an item of its
// own with `id` empty.
export type ClientState = 'queued' | 'paused' | 'downloading' | 'stalled' | 'checking' | 'moving' | 'unpacking' | 'importing' | 'seeding' | 'completed' | 'failed';
export type ClientItem = {
  downloader: 'sabnzbd' | 'qbittorrent'; id: string; name: string; protocol: 'usenet' | 'torrent'; state: ClientState; detail?: string;
  progress: number; size?: number; left?: number; down?: number; up?: number; eta?: number; position?: number;
  seeds?: number; seedsTotal?: number; peers?: number; peersTotal?: number; ratio?: number; seedingSeconds?: number; tracker?: string;
  category?: string; addedAt?: number; finishedAt?: number; error?: string; mine: boolean;
};
export type DownloadItem = ClientItem & {
  key: string;
  grab?: { id: number; titleId: number; title: string; year?: number; quality: string; state: GrabState; upgrade: boolean; indexer: string; removeAt?: number };
  requestedBy?: string;
};
// A downloader's own figures: speeds, free space where it saves (bytes), whether it is paused as a whole.
export type ClientSummary = { name: 'sabnzbd' | 'qbittorrent'; down: number; up: number; free?: number; paused?: boolean };
export type DownloaderLive = ClientSummary & { error?: string };
export type DownloadsLive = { clients: DownloaderLive[]; items: DownloadItem[] };

export type WantedItem = { id: number; tmdbId: number; title: string; year?: number; why: 'missing' | 'cutoff'; quality?: string; paused: boolean; pausedReason?: string;
  nextAt?: number; lastAt?: number; misses: number; grab?: GrabState; addedAt: number };
export type WantedList = { items: WantedItem[] };

// Admin › Manage › Movies: every movie in the library. `quality`/`size` are its file's; `belowCutoff` only with a file;
// `grab` is the last grab's state.
export type MovieRow = { id: number; tmdbId: number; title: string; year?: number; quality?: string; size?: number; profileId: number; profile: string;
  keep: boolean; paused: boolean; monitored: boolean; belowCutoff: boolean; grab?: GrabState; addedAt: number; source: MovieSource };
// Why a movie is in the library. A request wins (requesting a movie hands it to the requester); then the collections
// that downloaded it; then Radarr, for movies the cutover imported with no request or collection behind them.
export type MovieSource =
  | { kind: 'request'; requests: { name: string; at: number; status: string }[] }
  | { kind: 'collection'; collections: string[] }
  | { kind: 'radarr' }
  | { kind: 'other'; by: string };
export type MovieList = { items: MovieRow[] };

export type LibraryFileView = { id: number; path: string; size: number; quality: string; proper: boolean; score: number; releaseName?: string; releaseGroup?: string;
  importedAt: number; media: { durationSec?: number; videoCodec?: string; dynamicRange?: string; audioCodec?: string; audioChannels?: string; copied?: boolean } };
export type LibraryTitleView = {
  id: number; tmdbId: number; imdbId?: string; title: string; year?: number; profileId: number; keep: boolean; monitored: boolean;
  paused: boolean; pausedReason?: string; wanted: { wanted: boolean; why: string };
  released: { theatrical?: string; digital?: string; physical?: string };
  nextAt?: number; lastAt?: number; misses: number;
  files: LibraryFileView[]; grabs: DownloadsGrab[]; profiles: { id: number; name: string }[];
  source: MovieSource; addedAt: number;
};
export type InteractiveRelease = { guid: string; name: string; indexer: string; protocol: 'usenet' | 'torrent'; size?: number; publishedAt?: number; grabs?: number;
  seeders?: number; freeleech?: boolean;
  quality?: string; score: number; accepted: boolean; upgrade: boolean; reasons: string[];
  // Why: each matching score rule with its points (a ban adds none), every reason it's rejected, what makes it an upgrade,
  // and what was read from its name. `best`: the one an automatic search would grab now.
  scoreParts: { name: string; points: number; ban: boolean }[]; rejections: string[]; upgradeReason?: string; best?: boolean;
  parsed: { resolution?: string; source?: string; remux: boolean; codec?: string; hdr: string[]; audio?: string; service?: string; group?: string; editions: string[];
    languages: string[]; proper: boolean; repack: boolean; hardcodedSubs: boolean } };
export type InteractiveCurrentRelease = Pick<InteractiveRelease, 'name' | 'scoreParts' | 'parsed'> & {
  current: true; quality: string; size: number; score?: number; position: number;
};
// `have`: the library's file and where it falls in the default result order.
export type InteractiveSearch = { releases: InteractiveRelease[]; indexers: { indexer: string; searched: string[]; error?: string }[];
  profile: { name: string; cutoff: string }; have?: InteractiveCurrentRelease };

export type IndexerView = {
  name: 'nzbgeek' | 'iptorrents'; enabled: boolean; secretSet: boolean;
  settings: { categories: { movies: number[]; tv: number[] }; hourlyCap: number; dailyCap: number; freeleechOnly: boolean };
  // IPTorrents: which parts of its secret are saved (the user agent isn't secret).
  iptorrents?: { rssSet: boolean; cookieSet: boolean; userAgent: string };
  lastOkAt: number | null; lastError: string | null; pausedUntil: number | null; today: { searches: number; grabs: number }; thisHour: number;
};
export type DownloaderView = { name: 'sabnzbd' | 'qbittorrent'; url: string; secretSet: boolean; settings: { categories: { movie: string; show: string }; priority?: number } };
export type ConnectionTest = { ok: true; detail: string };

// Quality profiles v2 (docs/PROFILES.md). A condition holds when the release has any of `values` (ignored for remux
// and atmos); a format matches when every required condition holds and at least one of the others, if any.
export type FormatCondition = { field: string; values: string[]; required?: boolean; negate?: boolean };
export type FormatView = { name: string; label?: string; category: string; conditions: FormatCondition[] };
// On save, `from` names the format this one was (a rename keeps the profiles' points for it).
export type FormatInput = FormatView & { from?: string };
// Tiers best first; the first `preferred` meet the cutoff. Sizes are MB a minute of runtime.
export type ProfileTier = { qualities: string[]; size?: [number, number] };
export type PickProfile = { tiers: ProfileTier[]; preferred: number; scores: Record<string, number | 'ban'>; minScore?: number; upgradeUntil?: number; upgradeStep: number };
// `version` changes whenever the profile does; a save names the version it started from. `builtIn`: the built-in it
// started as, which Reset puts back.
export type PickProfileView = { id: number; name: string; value: PickProfile; builtIn?: string; used: number; version: string };
// Also the vocabulary for editors: the ladder (lowest first), the early-copy rungs, the condition fields and flags,
// and the format categories.
export type PickRules = { profiles: PickProfileView[]; formats: FormatView[]; formatsVersion: string; ladder: string[]; earlyCopies: string[];
  fields: string[]; flags: string[]; categories: string[] };
// Try a release: what the name says, every format it matches, and each profile's decision.
export type TryRelease = {
  parsed: InteractiveRelease['parsed']; formats: string[];
  profiles: { id: number; name: string; quality?: string; tier?: number; preferred: boolean; score: number; accepted: boolean;
    scoreParts: { name: string; points: number; ban: boolean }[]; rejections: string[] }[];
};

export type LibrarySettingsView = {
  revision: number; roots: { movie: string; show: string };
  naming: { movieFolder: string; movieFile: string; seriesFolder: string; seasonFolder: string; episodeFile: string };
  earlyCopies: boolean; protocol: 'usenet-first' | 'torrent-first'; defaultProfile: number; fulfil: { show: 'sonarr' | 'tkbox' };
  // When a seeding torrent is removed; `seedingFloor` is IPTorrents' minimum, which the settings can't go below.
  seeding: { ratio: number; minDays: number; maxDays: number }; seedingFloor: { ratio: number; days: number };
};
export type NamingPreview = { quality?: string; folder: string; file: string; path: string };
