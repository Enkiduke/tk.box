// Admin › Downloads (docs/ARR-REPLACEMENT.md, "Admin UI"): what the library, indexers and downloaders routes answer.
// Movies only so far (phases 1 and 3). Times are epoch ms; sizes are bytes, except profile sizes, which are GB.

export type GrabState = 'sending' | 'downloading' | 'unpacking' | 'importing' | 'imported' | 'seeding' | 'done' | 'failed' | 'cancelled';
// `episodes`: a show's grab in a word (S02 for a whole season, S02E05, S02E05–E06).
export type DownloadsGrab = {
  id: number; titleId: number; title: string; year?: number; episodes?: string; releaseName: string; indexer: string; protocol: 'usenet' | 'torrent';
  size?: number; quality: string; score: number; upgrade: boolean; state: GrabState; progress?: number; error?: string;
  sentAt?: number; finishedAt?: number; importedAt?: number;
};
// Admin › Downloads › History: one row per grab, newest activity first, opening to its steps (oldest first). A step's
// `kind` is the state it moved to, or grabbed / retried; `note` says more (the error, where it was imported, why it
// was removed, "By hand"). `outcome`: where the grab ended up; `replaced` is a failed or cancelled grab that a later
// grab of the same title (and episodes) took over (`replacedBy`), so it needs no Retry. `swappedFrom`: the slow grab
// this one was swapped in for. `endedAt`: when it was imported, or failed or was cancelled.
export type GrabEventKind = GrabState | 'grabbed' | 'retried' | 'only-source';
export type DownloadsStep = { id: number; at: number; kind: GrabEventKind; note?: string };
export type GrabOutcome = 'active' | 'imported' | 'failed' | 'replaced' | 'cancelled';
export type GrabLink = { id: number; releaseName: string };
export type DownloadsHistoryGrab = DownloadsGrab & { outcome: GrabOutcome; startedAt: number; lastAt: number; endedAt?: number;
  swappedFrom?: GrabLink; replacedBy?: GrabLink; steps: DownloadsStep[] };
export type DownloadsHistory = { grabs: DownloadsHistoryGrab[] };
// Downloads › History › Stats, for the grabs started in the period. `failed`: the download failed (whether or not a
// later grab took over); `bytes`: the size of the grabs imported. Days are UTC (YYYY-MM-DD), by when the grab started.
export type DownloadStatsCount = { grabs: number; imported: number; failed: number; bytes: number };
// `avgMs`: sent to the downloader until it finished, for the finished ones; `avgSpeed` bytes/s over the same.
export type DownloadStats = {
  totals: DownloadStatsCount & { cancelled: number; active: number; upgrades: number };
  days: ({ day: string } & DownloadStatsCount)[];
  indexers: ({ name: string } & DownloadStatsCount)[];
  downloaders: ({ name: string; avgMs?: number; avgSpeed?: number } & DownloadStatsCount)[];
  qualities: { name: string; grabs: number; bytes: number }[];
};
// Each indexer's searches and grabs a day (from the daily caps' counts) and how its searches went: `queries` sent,
// `failed`, the average time (`avgMs`) and results. The search log starts at `loggedSince` and keeps 90 days.
export type IndexerStatsRow = { name: string; searches: number; grabs: number; queries: number; failed: number; avgMs?: number; avgResults?: number;
  days: { day: string; searches: number; grabs: number }[] };
export type IndexerStats = { indexers: IndexerStatsRow[]; loggedSince?: number };
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
  grab?: { id: number; titleId: number; title: string; year?: number; episodes?: string; quality: string; state: GrabState; upgrade: boolean; indexer: string; removeAt?: number;
    // Download health (docs/STALLS.md): its strikes; Only source (nothing faster yet) with the next look for one; and
    // swapped in for a slow download in the last few minutes.
    strikes?: number; onlySource?: boolean; nextCheckAt?: number; swapped?: boolean };
  requestedBy?: string;
};
// A downloader's own figures: speeds, free space where it saves (bytes), whether it is paused as a whole.
export type ClientSummary = { name: 'sabnzbd' | 'qbittorrent'; down: number; up: number; free?: number; paused?: boolean };
export type DownloaderLive = ClientSummary & { error?: string };
export type DownloadsLive = { clients: DownloaderLive[]; items: DownloadItem[] };

// A wanted movie, or a show's search scope: a season searched as a pack (`scope` S02, `episodes` its wanted count) or
// one episode (S02E05, with its name and when it aired). Pausing pauses the whole show.
export type WantedItem = { kind: 'movie' | 'show'; id: number; tmdbId: number; title: string; year?: number; scope?: string; episodes?: number; episodeName?: string;
  airedAt?: number; why: 'missing' | 'cutoff'; quality?: string; paused: boolean; pausedReason?: string;
  nextAt?: number; lastAt?: number; misses: number; grab?: GrabState; addedAt: number };
export type WantedList = { items: WantedItem[] };

// Admin › Manage › Movies: every movie in the library. `quality`/`size` are its file's; `belowCutoff` only with a file;
// `grab` is the last grab's state.
export type MovieRow = { id: number; tmdbId: number; title: string; year?: number; quality?: string; size?: number; profileId: number; profile: string;
  keep: boolean; paused: boolean; monitored: boolean; belowCutoff: boolean; grab?: GrabState; addedAt: number; source: MovieSource;
  // The movie's next release still to come (in cinemas, digital, physical), so unreleased ones show when they land.
  release?: { kind: 'theatrical' | 'digital' | 'physical'; day: string } };
// Why a movie is in the library. A request wins (requesting a movie hands it to the requester); then the collections
// that downloaded it; then the one-time import, for titles it brought in with no request or collection behind them.
export type MovieSource =
  | { kind: 'request'; requests: { name: string; at: number; status: string }[] }
  | { kind: 'collection'; collections: string[] }
  | { kind: 'imported' }
  | { kind: 'other'; by: string };
export type MovieList = { items: MovieRow[] };
// Admin › Manage › Shows: every show in the library. `have` episodes with a file of `total` (aired and monitored, or
// with a file); `missing` and `cutoff` count wanted episodes as if unpaused; `size` the files'; `status` TMDB's;
// `nextAir` the next episode to air: its day and which it is; `grabbing` a download under way. Its source is a request or the import.
export type ShowRow = { id: number; tmdbId: number; tvdbId?: number; title: string; year?: number; status?: string; seasons: number; have: number; total: number;
  missing: number; cutoff: number; size: number; profileId: number; profile: string; keep: boolean; paused: boolean; monitored: boolean; grabbing: boolean;
  nextAir?: { day: string; season: number; episode: number }; addedAt: number; source: MovieSource };
export type ShowList = { items: ShowRow[] };
// Quick edit on Manage's Movies and Shows tables: the changes given, to every title in `ids`, then a search for each
// when `search`. `resume` clears the titles stopped after failed downloads (Failing). `skipped` names what was left out and why (gone, or a search it can't take).
export type LibraryBulkEdit = { ids: number[]; monitored?: boolean; resume?: true; profileId?: number; keep?: boolean; search?: boolean };
export type LibraryBulkResult = { changed: number; searched: number; skipped: { id: number; title: string; reason: string }[] };

// `episodes`: a show's file in a word (S02E05, S02E05–E06).
export type LibraryFileView = { id: number; episodes?: string; path: string; size: number; quality: string; proper: boolean; score: number; releaseName?: string; releaseGroup?: string;
  importedAt: number; media: { durationSec?: number; videoCodec?: string; dynamicRange?: string; audioCodec?: string; audioChannels?: string; copied?: boolean } };
// A title's dialog's Requests tab: every request for it, newest first, failed and removed ones too. `seasons` a
// show request's chosen seasons; `removedBy` who took it back; `error` the last failed attempt's.
export type TitleRequest = { id: number; name: string; at: number; status: string; statusAt: number; seasons?: number[]; availableAt?: number;
  removedAt?: number; removedBy?: 'requester' | 'admin' | 'cleanup' | 'library'; error?: string };
export type LibraryTitleView = {
  kind: 'movie'; id: number; tmdbId: number; imdbId?: string; title: string; year?: number; profileId: number; keep: boolean; earlyCopies: boolean; monitored: boolean;
  paused: boolean; pausedReason?: string; wanted: { wanted: boolean; why: string };
  released: { theatrical?: string; digital?: string; physical?: string };
  nextAt?: number; lastAt?: number; misses: number;
  files: LibraryFileView[]; grabs: DownloadsGrab[]; profiles: { id: number; name: string }[];
  source: MovieSource; addedAt: number; requests: TitleRequest[]; plex?: PlexKey;
};
// Where a title is on Plex (the server's machine id and its rating key), for its watch history.
export type PlexKey = { server: string; key: string };
// A show's episode in its dialog: `monitored` with its season; `wanted` as if unpaused; `grab` one under way; the
// times are its own search's (S02E05).
export type ShowEpisodeView = { episode: number; name?: string; airDate?: string; aired: boolean; monitored: boolean;
  // `plex`: no tk.box file, but Plex holds it (it counts as had and isn't searched).
  file?: { id: number; quality: string; size: number }; plex?: true; wanted?: 'missing' | 'cutoff'; grab?: GrabState; nextAt?: number; lastAt?: number };
// A season: its switch, its pack search's times (S02), its episodes.
// `have` of `total`, and `size`: counted as for the whole show (ShowTitleView).
export type ShowSeasonView = { season: number; monitored: boolean; nextAt?: number; lastAt?: number; have: number; total: number; size: number; episodes: ShowEpisodeView[] };
export type ShowTitleView = {
  kind: 'show'; id: number; tmdbId: number; tvdbId?: number; title: string; year?: number; status?: string; profileId: number; keep: boolean;
  monitor: string; monitored: boolean; paused: boolean; pausedReason?: string; wanted: { missing: number; cutoff: number };
  // As Admin › Shows counts them (ShowRow): episodes had of those that count, the files' size, the next to air.
  have: number; total: number; size: number; nextAir?: { day: string; season: number; episode: number };
  seasons: ShowSeasonView[]; files: LibraryFileView[]; grabs: DownloadsGrab[]; profiles: { id: number; name: string }[]; source: MovieSource; addedAt: number;
  requests: TitleRequest[]; plex?: PlexKey;
};
// What /admin/library/titles/:id answers: a movie or a show.
export type TitleView = LibraryTitleView | ShowTitleView;
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
  protocol: 'usenet-first' | 'torrent-first'; defaultProfile: number;
  // How often the indexers' new-release feeds are read, in minutes (5 to 1440).
  rssMinutes: number;
  // When a seeding torrent is removed; `seedingFloor` is IPTorrents' minimum, which the settings can't go below.
  seeding: { ratio: number; minDays: number; maxDays: number }; seedingFloor: { ratio: number; days: number };
  // The download budget: the projected minutes left before a download counts as slow (a season pack: 3 episodes).
  budget: { movie: number; episode: number };
};
export type NamingPreview = { quality?: string; folder: string; file: string; path: string };


// The Match dialog (Admin › Requests, a show's dialog): the TVDB series a show is filed under, and, when TVDB counts it
// as seasons of another series, which series season each TMDB season is (`seasons`, only when they differ).
export type MatchSeason = { season: number; episodes: number; firstAired?: string };
export type ShowMatchView = { tmdbId: number; title: string; year?: number; tvdbKey: boolean; seasons: MatchSeason[];
  match?: { tvdbId: number; series: { title: string; year?: number }; seasons?: Record<string, number>; at: number } };
export type TvdbSeriesHit = { tvdbId: number; name: string; year?: number; image?: string; network?: string };
export type TvdbSeriesView = { series: TvdbSeriesHit; seasons: MatchSeason[]; suggested: Record<string, number> };
export type ShowMatchInput = { tvdbId: number; seasons: Record<string, number> };
