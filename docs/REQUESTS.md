# Requests: replacing Seerr

Status: approved 2026-11-14. Steps 1–5 are built (arr, requests, Admin › Requests, Explore, Clean Up). The Seerr import was run on 2026-11-14 and then removed. Steps 6–7 are not done.

## Decisions (from the interview)

| Topic | Decision |
| --- | --- |
| Home | TypeScript tk.box, as a `defineModule` module. The Go port is dropped. |
| Fulfilment | tk.box adds titles to Radarr / Sonarr itself (v3 API), behind a `Fulfiller` interface a later downloader replacement can implement. |
| Durability | Request rows are their own outbox: a periodic sweep sends unsent rows and refreshes statuses. No general job queue yet. |
| Who | Every allowed viewer may request. Everything is auto-approved. No quotas (the route rate limit stays). |
| What | Movies; shows by season (All / First / Last / Manual). Specials are never requested. "All" also monitors future seasons. |
| Quality | One Radarr and one Sonarr. 4K is just a profile there. Profile, root folder and tags come from admin defaults; only admins can override them, in the dialog's Advanced section. |
| Status | Available / partial come from the Plex library (every title). Downloading comes from the Radarr/Sonarr queue. Failed means tk.box couldn't add the title. |
| Notify | In-app only: a toast and an unseen marker for the requester; failures listed in Admin › Requests. |
| Screens | Explore › My requests (viewer) and Admin › Requests (admin). No requesting on someone's behalf. |
| Clean Up | tk.box writes the request records into the purge script's run config. The script no longer calls any request service. |
| Import | One-time Seerr import from Admin › Requests. Safe to run twice. |
| Cutover | Straight swap, no feature flag. |
| Dropped | Approvals, declines, 4K instances, request-as, language profiles, quotas, watchlist auto-request, issues, blocklist, the Seerr sign-in, and the unused Seerr search, ratings and person code. |

## Out of scope
- Replacing Radarr/Sonarr, and the general durable job queue (both still deferred).
- Email, Discord, webhooks or other push outside tk.box.
- Deleting files when a request is cancelled or removed (that is Clean Up's job).
- Requests for titles TMDB doesn't know.

## Prerequisite: one place for the Radarr and Sonarr connections

Today Radarr's URL and key live in Collections' config (artwork) and Sonarr's in Clean Up's config. Requests needs both, Clean Up needs requests, and Explore needs requests, so leaving them where they are creates a mount cycle.

- **New module `arr`**, mounted before `artwork`. It owns `arr_connections(name PRIMARY KEY CHECK(name IN ('radarr','sonarr')), url TEXT NOT NULL, sealed_key TEXT)`.
  - Migration `connections` copies the URL and key from `collectionsConfig().radarr` and from `cleanup_config` (Sonarr), then strips those fields from both.
  - API `{connection(name), set(name, url, key)}`.
- Collections keeps its own seasonal-download `rootFolder` / `qualityProfileId`.
- Artwork, Clean Up, the calendar and `arr-tags.ts` read connections from `arr`.
- Admin › Connections saves Radarr and Sonarr through `arr`'s routes (`/api/v1/admin/arr/:name`, admin). The cards look the same.

## Data model (module `requests`, `modules/migrations/requests.ts`)

Migration `requests`:

```sql
CREATE TABLE requests(
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('movie','show')),
  tmdb_id INTEGER NOT NULL, tvdb_id INTEGER, title TEXT NOT NULL, year INTEGER,
  account_id TEXT,                 -- Plex account id of the requester (NULL: imported Seerr user with no Plex id)
  account_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','requested','downloading','partial','available','failed','removed')),
  status_at INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 1,  -- seen=0: requester not yet shown the change
  profile_id INTEGER, root_folder TEXT, tags TEXT NOT NULL DEFAULT '[]',  -- settings (or an admin's choice) at request time; NULL: Radarr's/Sonarr's first
  monitor_future INTEGER NOT NULL DEFAULT 0,
  arr_id INTEGER,                  -- Radarr movie id / Sonarr series id once sent
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER, last_error TEXT,
  available_at INTEGER,            -- Plex addedAt of the copy (movie or whole show); Clean Up's anchor
  removed_at INTEGER, removed_by TEXT,  -- account id, 'cleanup' or 'arr'
  seerr_id INTEGER UNIQUE          -- set only by the import
);
CREATE INDEX requests_title ON requests(kind, tmdb_id);
CREATE INDEX requests_account ON requests(account_id, created_at);
CREATE INDEX requests_open ON requests(status) WHERE status IN ('queued','requested','downloading','partial');
CREATE TABLE request_seasons(
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  season INTEGER NOT NULL CHECK(season > 0),
  available_at INTEGER,
  PRIMARY KEY(request_id, season)
);
CREATE TABLE requests_settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL);
```

- **Settings value:** `{movie: {profileId, rootFolder, tags[]}, show: {profileId, rootFolder, tags[], seasonFolders: true}, searchOnAdd: true}`. Saved with `expectedRevision`, like the other settings.
- **Several rows per title** are allowed: different people, or different seasons. A title, or a season, that already has an open request (not failed or removed), or is in Plex, can't be requested again.
- **A movie, or a show with no seasons left to fill, counts as done** once it is `available`. The sweep stops watching it.

## Fulfilment and the sweep (`services/requests-*.ts`)

- **`Fulfiller` interface:** `add(request) → {arrId}`, `queue() → Map<key, progress>`, `exists(arrId)`, `unmonitor(request, seasons?)`. `ArrFulfiller` implements it over Radarr and Sonarr.
- **Movie:**
  1. Look up `movie?tmdbId=`.
  2. If Radarr already has it, set it monitored and search if it has no file.
  3. If not, `movie/lookup/tmdb` then `POST movie`, with `monitored`, `minimumAvailability: released`, the profile, folder and tags, and `addOptions.searchForMovie`.
- **Show:**
  1. The TVDB id comes from TMDB's external ids. No TVDB id means `failed` ("TMDB has no TVDB id").
  2. Look up the series by TVDB id.
  3. If Sonarr already has it, monitor the chosen seasons (leaving the others as they are), set `monitorNewItems: all` when `monitor_future`, then `SeasonSearch` for each chosen season.
  4. If not, `POST series` with season 0 unmonitored, the chosen seasons monitored, `monitorNewItems` and `addOptions.searchForMissingEpisodes`. On Sonarr v3 the first language profile is sent too (v4 ignores it).
- **The request route** inserts the row as `queued` and tries to send it straight away. On success it becomes `requested`.
- **Sweep** (`every(60s)`, only while open rows exist):
  1. Send `queued` rows that are due. Backoff is 1 min, 5 min, 30 min, 2 h, 6 h. After 5 failures, or at once on a 4xx that isn't "already exists", the row becomes `failed` with `last_error`.
  2. Read the Radarr and Sonarr `/queue` once. Rows found there become `downloading`; rows that left it go back to `requested`.
  3. Apply availability (below).
  4. If the item has gone from Radarr or Sonarr and isn't available, mark the row `removed` with `removed_by='arr'`. Each sent row is checked at most once an hour.
- **Read-only mode** (`requireWritable`): nothing is sent, and rows stay `queued`.

## Status

- **Availability index:** built from the owner's background grant over every movie and show library.
  - It maps `movie:tmdb:N` / `show:tmdb:N` (and TVDB for shows) to `{ratingKey, addedAt, seasons: Map<n, addedAt>}`.
  - It is rebuilt on `plex.library.changed` (debounced 30 s) and every 6 h. It is kept in memory, and the last good index is kept if a rebuild fails.
- **Per row:**
  - A movie is `available` once it is in Plex.
  - A show is `available` once every requested season is in Plex, and `partial` once some are.
  - Otherwise the status comes from the sweep: `queued`, `requested`, `downloading` or `failed`.
  - `available_at` / the season's `available_at` take Plex's `addedAt` when the row first becomes available.
- **Title label** (Explore rows, the details dialog and the hide filter):
  - In Plex: `available`, or `partial` if an open request still lacks a season.
  - Otherwise the most advanced open request: `downloading`, then `requested` (which covers `queued`).
  - Failed and removed rows give no label.
- **Seasons in the dialog:** TMDB's regular seasons, each marked `available` (in Plex), `downloading`, `requested` or open. A show in Plex that is missing aired seasons shows as `partial` in the dialog only.
- **Contracts:** `ExploreStatus` becomes `'available' | 'partial' | 'downloading' | 'requested'`.

## Routes (all `/api/v1`)

| Route | Access | Does |
| --- | --- | --- |
| `GET explore/details` | viewer | (existing) `seerr` becomes `request: {requestable, status?, seasons[]}`; absent when Radarr (movie) or Sonarr (show) isn't connected |
| `POST requests` | viewer | `{kind, tmdb, seasons?}`; admins may add `{profileId, rootFolder, tags}` (403 for others). Returns the row. Rate limit 20/min |
| `GET requests/mine` | viewer | The caller's rows, newest first, with seasons and an `unseen` count |
| `POST requests/mine/seen` | viewer | Marks the caller's changed rows as seen |
| `DELETE requests/:id` | viewer | Own row, while `queued`/`requested`/`failed`: becomes `removed`. Unmonitors the movie, or the seasons no other open row needs |
| `GET admin/requests` | admin | Every row; filters `status`, `kind`, `account`, `q`; paged |
| `DELETE admin/requests/:id` | admin | Same as cancel, for any row in any status |
| `POST admin/requests/:id/retry` | admin | `failed` → `queued`, attempts reset |
| `GET admin/requests/options?kind=` | admin | Profiles, root folders (free space) and tags from Radarr/Sonarr, plus the saved defaults; used by settings and Advanced |
| `GET/PUT admin/requests/settings` | admin | Defaults (with `expectedRevision`) |
| `POST admin/requests/import-seerr` | admin | `{url, apiKey}` (not stored). Imports, then returns counts |

Removed: `explore/seerr/account`, `explore/seerr/options`, `explore/seerr/users` and `explore/request` (replaced by `POST requests`). Seerr fields leave `admin/explore/settings`; that route keeps only what's left (nothing, so it goes; the layout routes stay). `explore/sources`'s `seerr: {configured, statuses}` becomes `requests: {movie: bool, show: bool}` (connected).

## Bus events

| Event | Emitted by | Heard by |
| --- | --- | --- |
| `requests.changed` `{kind, tmdb, id, accountId?, status}` | requests (create, cancel, every status change) | explore (drops cached pages for labels), client-events (sends `requests` to that account's streams) |
| `plex.library.changed` (existing) | plex-notifications | requests (rebuilds the availability index) |
| `library.edited` `{by:'cleanup'}` (existing) | cleanup | requests (rebuilds the index, so removed titles lose `available`) |

`ClientEvent` gains `'requests'`. `client-events` needs to send to one account's streams (today it broadcasts `library` to everyone). The web app reloads My requests and shows a toast for each unseen `available`, `partial` or `failed`.

## Explore

- `labelled()` reads `requests.labels()` (sync, from the index plus open rows). No API key is needed, and the 5-minute / 1-hour Seerr index and its pre-read in `explore/sources` go.
- In `details()`:
  - Remove the Seerr call and the 4K settings.
  - The `libraryId` fallback uses the availability index's `ratingKey` instead of Seerr's.
  - Seasons come from TMDB TV details (check whether `TmdbTitles` already returns them; add them if not).
- **Request dialog:**
  - Remove the sign-in, 4K, approval notices, language profile and Request As.
  - Keep the season modes and the Manual table.
  - Admins get Advanced: a profile (this is where 4K is picked), a root folder and tags, defaulting to the settings.
  - Copy becomes "Requested <title> · Seasons 1–3."
- **Explore › My requests:** a list with poster, title, seasons, status, date and Cancel. It is opened from a button in the Explore header that shows the unseen count.
- The explore-settings Seerr card goes. In Admin › Connections the Seerr card goes and the Radarr/Sonarr cards gain "Requests" in their descriptions.

## Clean Up

- **The engine writes `requests` into the run config:**
  - **What's included:** every row with status `available` or `partial` in the chosen libraries' kind.
  - **Each record:** `{id, kind:'movie'|'tv', tmdb, tvdb, title, year, requester_plex_id, available_at, seasons}`. `requester_plex_id` is `account_id` as an integer, or null.
- **`purge_requests.py`:**
  - `SeerrClient` goes.
  - `group_requests` / `parse_requests` read the config list.
  - `media_title_and_year` uses the record, not Seerr details.
  - A missing `available_at` still falls back to Tautulli's added date.
  - A null requester is treated as non-exempt, with no watches of their own.
- **"Remove from Seerr"** (`deleteFromSeerr`) goes. After a real (non-dry) run, tk.box reads the status file and marks the rows of every whole title the script deleted as `removed` with `removed_by='cleanup'`. Rows for season deletions stay, as they do today.
- **Seerr is no longer required.** Clean Up's `missing` list loses the Seerr line, and the card text becomes "Only available requests in these Plex libraries are checked."
- **Settings:** the store accepts and drops an old `deleteFromSeerr` key. There's a cleanup migration `drop-seerr` that strips it from `cleanup_config`.

## Seerr import

- **Reads** `/api/v1/request?take=100&filter=all` and pages through it (stopping on a repeat or a short page, as `available_requests` does today).
- **For each request:**
  - Skip declined ones (request status 3).
  - 4K requests come in as normal requests.
  - `requestedBy.plexId` → `account_id`; `displayName` → `account_name`.
  - `media.tmdbId` / `tvdbId`, the seasons, `createdAt` and `media.mediaAddedAt` → `available_at`.
  - The title and year come from TMDB (cached), falling back to "TMDB <id>".
  - Status: Seerr media status 5 → `available`, 4 → `partial`, otherwise `requested`. The next sweep corrects it from Plex and Radarr/Sonarr.
- **Nothing is sent to Radarr/Sonarr**, except requests Seerr still held for approval (request status 1): with everyone auto-approved they come in `queued` and are sent. Other imported rows get `arr_id` from a lookup on the first sweep (`Fulfiller.find`).
- **Idempotent** on `seerr_id`, so a second run only adds new requests.
- **Returns** `{imported, skipped, declined, withoutPlexId}`.

## Cutover and Seerr removal, in order

Each step is a commit that typechecks, with its targeted tests.

1. **`arr` module:**
   - The `connections` migration, with artwork, Clean Up, calendar and `arr-tags` reading from it, and the Admin › Connections Radarr/Sonarr cards using its routes.
   - Tests: migrations (the copy and the strip), calendar, and Clean Up's connection reads.
2. **`requests` module:**
   - Migrations, store, `ArrFulfiller`, availability index, sweep, the viewer and admin routes, bus events, and `client-events` per-account sends. Mounted after `arr` and `catalog`, before `explore`.
   - Tests: the add and adopt paths with a fake transport, retry and backoff, status derivation (movie and show, partial), cancel unmonitoring only unneeded seasons, title labels.
3. **Seerr import route** (`services/seerr-import.ts`, self-contained) and the **Admin › Requests** page (list, retry, remove, defaults, import). Test: the import mapping and running it twice.
4. **Explore switch:**
   - `labelled`, `details`, sources and the contracts move to `requests`.
   - The new dialog and My requests.
   - The `explore/seerr/*` and `explore/request` routes are deleted.
   - Tests: `explore.test.ts` and `explore-tmdb.test.ts`, with the Seerr cases replaced.
5. **Clean Up switch:**
   - The config carries the requests; the Python `SeerrClient` and `delete_from_seerr` go; rows are marked removed after a job; the `drop-seerr` migration; copy.
   - Tests: `cleanup.test.ts` and the Python purge tests.
6. **You:** run the import in Admin › Requests, check Explore labels, a movie and a show request, My requests, and a Clean Up dry run.
7. **Remove Seerr and Tautulli:**
   - Code and settings:
     - `providers/seerr.ts` (`services/seerr-import.ts` and its route are already gone).
     - The Seerr fields in `explore-store.ts` and its settings routes, plus an explore migration `drop-seerr` that deletes the `explore_settings` row.
     - `SEERR_*` errors, `ExploreSeerr*` contract types, `transports.seerr` in `buildApp`/`app.ts`.
     - Seerr in the read-only messages (`index.ts`, `errors.ts`) and `remote-json.ts`.
   - Tooling and docs:
     - The fixtures in `scripts/preview-ui.ts`.
     - The README, `docs/CLEANUP.md`, MODULES-HANDOFF (module list, bus table) and the comments (`explore.css`, `plex-discover.ts`, `identity.ts`).
   - Check: `grep -ri seerr` matches nothing except "Overseerr" in `library.tsx`'s logo credit and this doc.
   - **Tautulli** (added 2026-11-14; reviewed in `docs/TAUTULLI-REVIEW.md`, whose section 3 is the order to follow:
     import Tautulli's history once while it's connected, then give the purge script watches in its run config,
     switch the Python reader, a dry run by you, remove the connection, then comments and docs). Clean Up reads watch history from tk.box's
     own watch history (Activity / `history_*` tables, which `purge_support/native_history.py` already compares
     against in dry runs) instead of Tautulli, and the Tautulli connection goes.
     - Clean Up: `purge_support/history.py` (TautulliClient, including its added-date fallback), the
       `TAUTULLI_API_KEY` secret, `tautulliUrl`/`tautulliKey` in `cleanup-store.ts`, the Tautulli line in
       `cleanupMissing`, and `exempt_user_ids` (Plex account ids, as Tautulli showed them).
     - Other users of Tautulli to check: `activity-api.ts` / `modules/activity.ts`, `plex-notifications.ts`,
       `connection-health.ts`, `artwork-schedule.ts`, `artwork-store.ts`, `apps/artwork/engine_common.py` and
       `artwork_engine.py`, Admin › Connections' card, `cleanup-admin.tsx`.
     - Risk: tk.box's history only covers watches since it started recording (and Plex's own apps through the playback
       monitor). Rules anchored on "last watched" may delete sooner for titles last watched before that.
   - Check: `grep -ri tautulli` matches nothing outside this doc.

## Open risks
- **Matching on Plex account ids.** `account_id` is assumed to be the plex.tv numeric id that Seerr calls `plexId` and Clean Up's `exempt_user_ids` use. Check this on the real database before the import.
- **Seerr's `available` filter.** It is assumed to include partly available titles. If it doesn't, step 5 changes which shows Clean Up looks at. Check this against the current Clean Up output in a dry run before and after.
- **Cost of the availability index.** Season-level data means reading show seasons across libraries (Plex `type=3` lists). This needs measuring on the real library. The fallback is to read seasons only for shows that have open requests.
- **Sonarr series lookup** needs TMDB → TVDB. A few shows have no TVDB id and will fail with a clear message.
- **Adopting existing Radarr/Sonarr items** keeps their current profile and folder. An admin override applies only when tk.box adds the title.
- **Imported Seerr users without a Plex id** (local Seerr accounts) lose requester-based rules in Clean Up and fall under Rule 2.
- **No notifications while offline.** A viewer who is away gets nothing until they next open tk.box (they see the unseen marker then).
- **Moving the connections** touches the artwork and Clean Up configs. The migration must run before either module's setup reads them, which mount order and per-module migrations already guarantee.
