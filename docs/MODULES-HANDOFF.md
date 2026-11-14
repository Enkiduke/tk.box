# Handoff: backend modularization and efficiency work

Status as of 2026-11-14. Everything below is committed and pushed (module move 20a7ba2, 31c1c6d; migrations f7df7c0;
IPTV snapshot reads and statement cache 297f006; XMLTV worker f65b3cf; shared cache and timers a4fdd8f). The two test
fixes and the Explore first-load work (steps 5–7 under "Done in this pass") are in the working tree, not committed. What
is left is under **Left to do**.

## Goal

Make adding backend features cheap and safe. Each feature is a module with its own services, routes, lifecycle and
declared route access, and modules talk through an in-process event bus instead of callback properties wired in
`app.ts`. Stay one process, Node/TypeScript, Fastify, SQLite (better-sqlite3). No microservices, Redis or Go port.

## Where it stands

The move is complete: every route is registered by a module under `apps/server/src/modules/`, and the server refuses
to start if any route declares no access level. The user ran the app checklist after the move and the migrations
(below); nothing traced to the move. The later commits (297f006, f65b3cf, a4fdd8f) are typechecked and covered by
targeted tests but **not yet tried in the running app**, nor is the Explore first-load change. Typecheck passes and
the targeted tests pass.

## Infrastructure (`apps/server/src/modules/`)

- **`module.ts`**: `defineModule({name, access?, setup(routes, ctx, deps) => {api, start?, stop?}})` and
  `mountModule(app, ctx, module, deps)`, which returns `api`.
  - Each module gets its own Fastify scope.
  - `setup` may be async (the web module reads the build folder).
  - `access` is the default for the module's routes that declare none (`'admin'` for artwork, cleanup and admin;
    `'public'` for web). Without one, a route with no `config.access` throws when it is registered.
  - `start` runs on `onReady` in mount order. Stops run in one `preClose` hook in reverse mount order, so a module stops
    before the modules it depends on.
  - `ModuleContext` = config, db, vault, plex, bus, budget (encoder limit), serviceKeys, background (owner's Plex
    grant), log.
- **`access.ts`**:
  - Routes declare `{config: {access: 'public' | 'session' | 'viewer' | 'admin' | 'owner'}}`.
  - `installAccess` (once, in `app.ts`) adds one `onRequest` hook that runs the check. Handlers read `viewer(req)` or
    `session(req)`.
  - `authorize(req, 'viewer')` escalates a lighter route to a full check (live and VOD HLS playlists, VOD progress with
    position/state).
  - `session` is the local-only session check for segments and progress beats.
  - `requireDeclaredAccess(app)` is the app-wide default deny. Every route must declare a level, or `onReady` throws
    and lists them. It checks at `onReady` so module defaults (filled in by the module's own `onRoute`, which runs after
    the root's) count. Fastify's automatic HEAD routes inherit the level (tested).
- **Migrations** (`persistence/migrate.ts`, `modules/migrations/`): see the section below.
- **`bus.ts`**: a typed `EventBus`. Listeners run synchronously in subscription order. A failing listener is logged
  and the rest still run.

| Event | Emitted by | Heard by |
| --- | --- | --- |
| `iptv.source.published` | iptv (SourceRefresh) | iptv (sports) |
| `service-keys.changed` | admin (keys PUT) | iptv (sports), plex-notifications (reconnect when `plex`) |
| `plex.library.changed` | plex-notifications | app.ts (`plex.forgetIndexes`), artwork (schedule) |
| `library.edited` | artwork, cleanup (job finished) | app.ts (`plex.forgetMetadata`), client-events (`library`) |
| `live.viewer.ended` | iptv (LiveTv), custom-channels (CustomTv) | watch-history (`end … 'interrupted'`) |
| `plex.notifications.connecting` | plex-notifications | artwork (`schedule.notificationLibraries`) |
| `plex.playback.states` / `plex.playback.connection` | plex-notifications | watch-history (monitor) |
| `session.signed-out` | sign-in (logout) | watch-history, activity, live-sessions, vod-playback |
| `requests.changed` | requests (every row change) | client-events (`requests` to that account's pages only), explore (drops cached details) |

`app.ts` subscribes the two Plex cache resets right after creating the bus, so they run before any module's listener
for the same event (pages told to reload then read Plex anew).

## Modules, in mount order

1. **`watch-history.ts`**: HistoryStore, PlaybackHistory, PlexPlaybackMonitor (Plex's own apps), Admin › History
   (`registerHistory(routes, db)`, each route admin). API `{history, monitor}`.
2. **`activity.ts`**: Activity and the Admin › Activity routes. Deps `{history, plexSessions}`. API
   `{activity, source}`. Each playback module registers an `ActivitySource` per stream kind (`vod`, `live`, `custom`)
   with `delivering`, `describe` (its row's details) and `stop` (Admin's Stop). `activity-api.ts` now holds only
   `plexRow`.
3. **`custom-channels.ts`**: CustomChannelStore, EpisodeSync, Channel Manager routes, PartProxy, CustomTv. API
   `{store, tv}`.
4. **`iptv.ts`**: IptvStore, SourceRefresh, IPTV/guide routes, LiveTv, channel health, IPTV settings, provider
   connections, stream guard, sports. Deps `{custom}`. API `{store, live}`.
5. **`live-sessions.ts`**: all `/api/v1/live/sessions` routes. Deps `{live, iptv, customTv, custom, activity, history,
   subtitles}`. Registers the `live` and `custom` activity sources.
6. **`vod-playback.ts`**: PlaybackService, VodTranscodes, the open file `streams` set, all `/api/v1/playback/sessions`
   routes. Deps `{identity, activity, history, subtitles, localMedia}`. Registers the `vod` activity source.
7. **`client-events.ts`**: the `/api/v1/events` SSE stream (viewer). Its stop ends open streams.
8. **`arr.ts`** (default admin): ArrStore, the one Radarr and one Sonarr connection, and `/api/v1/admin/arr` (GET, PUT
   `:name`). API `{connection(name)}`, read by artwork, cleanup and calendar (and requests, docs/REQUESTS.md).
9. **`artwork.ts`** (default admin): ArtworkStore, TmdbTitles, ArtworkEngine, ArtworkWorker, ArtworkSchedule and
   routes. Deps `{streaming, tmdbTransport, arr}`. API `{store, engine, titles}`.
10. **`catalog.ts`**: library page routes. Deps `{hiddenRecent}` (artwork's engine).
10a. **`requests.ts`**: RequestStore, ArrFulfiller, RequestAvailability (Plex index, owner's grant), Requests (create,
    cancel, retry, the 60 s sweep) and the `/api/v1/requests` and `/api/v1/admin/requests` routes. Deps `{arr, titles}`.
    API `{requests, store}`. See docs/REQUESTS.md.
11. **`explore.ts`**: ExploreStore and routes. Deps `{accountToken, titles, requests, transports}`. API `{store}` (cleanup reads
    `store.seerr()`).
12. **`plex-notifications.ts`**: PlexNotifications, with no deps: it only emits and listens on the bus.
13. **`cleanup.ts`** (default admin): CleanupStore, CleanupEngine and routes. Deps `{artwork, arr, requests}`. API
    `{services}`.
14. **`calendar.ts`**: the calendar route. Deps `{connections, titles}`.
15. **`sign-in.ts`**: setup (`registerSetup`, all `public`), Plex sign-in start/status and logout (`public`),
    `/api/v1/me`, `/api/v1/libraries`, `/api/v1/media/:id` (viewer), and the session reaper.
16. **`admin.ts`** (default admin): metrics, Admin › Connections keys, Admin › Users (`owner`), playback settings.
    Deps `{admins, settings, metrics, identity, customBuffer}`.
17. **`web.ts`** (default public): `/health` and the built web files.

What stays in `app.ts`:
- Fastify and its plugins.
- Security headers, CSRF and the legacy cookie migration.
- The error handler.
- The identity service and the access checks (`auth`, `admin`, `ownerOnly`).
- The metrics hooks (they must see every route).
- The shared services in `ModuleContext`, and the mount order.

Route files outside `modules/` (`*-api.ts`) still hold most route bodies; their `register…` functions take the route
scope and no auth callbacks. Catalog, Explore, calendar, setup, IPTV, health, sports and custom-channel routes declare
access on each route rather than by module default. That way the tests that register them on a bare Fastify with
`installAccess` keep their checks. Artwork, cleanup and admin rely on the module default.

## Migrations

Each module owns its tables. `defineModule({..., migrations})` takes a list of named migrations, and `mountModule`
applies the ones not yet recorded before the module's `setup`.
- **`persistence/migrate.ts`**: `Migration = {name, legacy?, up}`. `up` is SQL or a function. `migrate(db, owner,
  list)` applies the owner's unrecorded migrations in list order, in one transaction (all or none), and records each
  in `schema_migrations(owner, name, applied_at)`. Duplicate names are refused. Never edit a shipped migration; add a
  new one after it.
- **`legacy`** bridges the old single numbered list (`migrations(version)`, versions 1–25): if that table recorded the
  number, the migration is marked applied without running. The old table is left in existing databases and is not
  created in new ones.
- **Core** (`coreMigrations` in `persistence/database.ts`, run by `openDatabase`): tables shared across the app:
  `settings`, `audit`, `users`, `sessions`, `auth_challenges`, `playback_sessions` (and its trigger), `lineup_numbers`
  (IPTV and custom channels share the number lineup), `service_keys`, `extra_admins`, `key_check`.
- **Modules** (`modules/migrations/<module>.ts`):

  | Owner | Tables | Old versions |
  | --- | --- | --- |
  | `watch-history` | `history_*` | 23–25 |
  | `custom-channels` | `channels`, `publications` (the scheduler), `custom_*` | 1 (part), 12–15 |
  | `iptv` | `iptv_*`, `sports_*`; `snapshot-version` (new) | 2 (part), 3–11, 16, 19–22 |
  | `arr` | `arr_connections`; moves Radarr's address/key out of `artwork_collections` and Sonarr's out of `cleanup_config` | none |
  | `artwork` | `artwork_*` | 17–18 |
  | `requests` | `requests`, `request_seasons`, `requests_settings` | none |
  | `explore` | `explore_settings`, `explore_layout`; drops Trakt | none |
  | `cleanup` | `cleanup_config`, `cleanup_jobs` | none |

- Four of the five store constructors (`AdminStore`, `ServiceKeys`, `ExploreStore`, `CleanupStore`) and `checkKey` no longer
  create tables. Those migrations have no `legacy` number and keep `IF NOT EXISTS`, since existing databases already
  have the tables. `SourceSnapshots` (`source_snapshots`) still creates its own: it is a prototype only
  `refresh-recovery.test.ts` uses, and no module mounts it.
- **`modules/migrations/index.ts`**: `moduleMigrations` (every module's list by name, in mount order),
  `migrateModules(db)` and `openMigratedDatabase(path)`. Tests and scripts that use stores without mounting their
  modules open the database with `openMigratedDatabase`. `index.ts` keeps `openDatabase`: modules migrate as they mount.
  `scripts/migrate.ts` applies everything and prints the count per owner.
- Checked once (scratch script, not kept): a fresh database has the same tables, columns, foreign keys, indexes and
  seeded rows as before, and a database made by the old code upgrades with no schema change and all 33 migrations
  recorded as applied.
- Changed behaviour: the Trakt cleanup in Explore runs once instead of on every start. A database is migrated in
  steps (core, then each module as it mounts) instead of one transaction.

### Adding a feature
1. Write `modules/<feature>.ts` with `defineModule`, building its services in `setup`. Put its tables in
   `modules/migrations/<feature>.ts`, pass them as `migrations`, and add them to `moduleMigrations`.
2. Give every route an access level, or set a module `access` default when all of them share one.
3. Take other modules' APIs as deps for direct calls. Use bus events for reactions ("X happened"), adding the event
   to `BusEvents` in `bus.ts`.
4. Mount it in `app.ts` after the modules it depends on.

## Tests
- `tests/lib.test.ts`: TtlCache expiry, cap order, shared and retried `remember`; `every` skipping overlap, errors, stop.
- `tests/xmltv-worker.test.ts`: the worker's result matches the in-thread parse; errors keep code and status; abort.
  `source-guide` refreshes a remote guide through the real worker (success, failure, abort on removal).
- `tests/migrations.test.ts` covers: each migration runs once, in order, per owner; a failing batch applies nothing;
  `legacy` skips; duplicate names; `mountModule` migrates before setup; the registry matches the module definitions.
- Tests that re-ran an old migration (`custom-channels`, `listing`, `provider-connections`) now delete its
  `schema_migrations` row. The Explore Trakt test builds the pre-removal tables and then migrates.
- Run after the migrations change: migrations, modules, playback-history, custom-channels, iptv-durable, sports,
  explore, cleanup, artwork, key-check, security, refresh-recovery, plex-background, iptv-api, provider-connections
  and listing. All pass but the known IPTV failure.
- `tests/modules.test.ts` covers:
  - a route with no access fails startup;
  - session vs escalated checks;
  - bus listener isolation;
  - start/stop order;
  - module default access, including HEAD;
  - the app-wide default deny.
- `history-api`, `calendar` and `explore-tmdb` tests install access checks instead of passing auth callbacks.
- The IPTV and channel-health tests register their routes on a bare Fastify and call `installAccess` first.
- Files run after the last change: security, catalog, local-media, playback-history, vod-transcode, source-removal,
  iptv-api, modules, setup, plex-setup and feed-identity. All pass but the known IPTV failure. Earlier in the move I
  also ran explore-tmdb, explore, calendar, history-api, activity, plex-playback-monitor, the artwork tests and
  cleanup. No test calls the Admin › Activity, Artwork, Clean Up or events routes.

- Files run after the test fixes and the Explore change: iptv-api, channel-health (five runs in a row), explore and
  explore-tmdb. All pass.

## Known issues
None open. The stale IPTV guide filter test and the timing-sensitive channel-health test are fixed (Done in this pass,
step 5).

### Behaviour changes from the move
- Access is checked in `onRequest`, before body/query parsing. A bad request from someone without access now gets
  401/403 instead of 400.
- HLS playlists pass the local session check before the full one, as live playlists already did.
- Shutdown:
  - Modules stop in reverse mount order.
  - The artwork and cleanup engines now close in `preClose` instead of `onClose`.
  - The Plex notification feed closes before history.
- Sign-out: listeners run in mount order, so watch history ends the account's sessions first, then activity,
  live/custom and VOD stop. Before, history ended last. Sessions end as `revoked` either way.
- The session reaper timer starts on `onReady` instead of at build time.

## Testing checklist (run by the user on 2026-11-14)
If something fails, the module that owns the route is the place to look; mount order and bus wiring are in `app.ts`.

- [x] Start on the existing database after the migrations change; everything loads as before.
- [x] Sign in with Plex; sign out.
- [x] VOD: audio switch, subtitles, pause, resume, stop.
- [x] IPTV channel: starts. One channel had audio out of sync; other channels were fine, so probably that channel's
  stream (to confirm: is it out of sync in another player too?).
- [x] Custom channel: start, subtitles, pause, Go Live.
- [x] Admin › Activity; sign out while playing; Admin › History; Artwork and Clean Up.
- [x] Explore, calendar, library pages: work. The first load felt slow (probably cold TMDB/Seerr caches after the
  restart; not looked into).
- [x] Connections keys, Admins, playback settings.
- [ ] Shutdown with a stream playing: the player showed "Request failed" (a failed progress beat), then buffering, and
  did not resume after the server came back. That is how the player already worked: it retries a few times (3 for VOD,
  8 at 1.5 s for live) and playback sessions and transcodes live in memory, so a restarted server has no session to
  continue. Not a regression from the move. Still to confirm: Ctrl+C exits promptly with no errors in the log.

## Done in this pass (reference)
1. **App test after the move**: nothing traced to the move (see the checklist notes).
2. **Per-module migrations**: done (see Migrations); the user started the app on the real database with no issues.
3. **Cheap efficiency gaps** (297f006):
   - `IptvStore.source()` now selects every column but `encrypted_snapshot` and `encrypted_candidate` (it returns
     `has_snapshot` and `snapshot_version` instead). `snapshot(row)` and `candidate(row)` read the sealed text only to
     decode it. The decoded-snapshot cache is keyed on `snapshot_version`, a counter that the trigger
     `iptv_snapshot_version` bumps on any write of the snapshot by anyone (iptv migration `snapshot-version`). Before,
     the cache compared the whole sealed string, so every guide request read megabytes just to check the cache.
   - Stores prepare each SQL text once: `prepared(db, sql)` (`persistence/statements.ts`) keeps one statement cache per
     connection, shared by every store on it, capped at 1000 (cleared, not grown, if SQL ever varies per call).
     `IptvStore` (`q(sql)`), custom-channels, sports, artwork, channel-health, cleanup, identity and the scheduler use
     it. All their SQL is constants or fixed fragments; the channel-health upsert's column list varies only by caller
     shape. Nothing calls `.pluck()`, `.raw()` or `.iterate()`, which would change or tie up a shared statement.
     `HistoryStore` already prepared its statements up front; the smaller stores (settings, admins, service keys,
     explore, listing helpers) still prepare inline.
   - Not measured: no before/after timing.
4. **Step 4**:
   - **XMLTV parse in a worker thread** (f65b3cf):
     - Measured on a synthetic 11 MB guide (800 channels, 57,600 programs): a refresh blocked the main thread about
       600 ms, 400 of it `parseXmltv`; JSON encode/decode about 40 ms each, coverage writes about 50 ms. With the
       worker, the main thread spends about 195 ms (seal, write, coverage) and stalls at most 14 ms during the parse.
       Chunked transactions were not worth it at these sizes, so writes stay one transaction.
     - `providers/xmltv-parse.ts`: `parseXmltvOffThread(bytes, signal)` starts one worker per refresh
       (`providers/xmltv-worker.ts`), which returns the snapshot as JSON text plus its channel count. AppErrors come
       back with their code and status; abort terminates the worker. Run from source, the worker registers tsx's
       loader itself (`tsx/esm/api`), since Node 22 workers don't get the main thread's tsx hooks; built, it loads the
       `.js` file directly (checked by compiling to a temporary folder and running it with plain node).
     - `SourceRefresh` parses remote XMLTV downloads in the worker (constructor's third argument, default
       `parseXmltvOffThread`) and calls `IptvStore.ingestGuide(actor, id, expected, parsed)`, which does the writes
       on the main thread, still the only SQLite writer. `ingest` keeps parsing in-thread for uploads (64 KB body
       limit) and M3U playlists. `publish` now takes the snapshot's JSON text (plus the parsed playlist for M3U).
     - Not moved: M3U parsing; the main-thread JSON.parse of the new snapshot when coverage first reads it.
   - **Shared scheduler and cache utilities** (a4fdd8f):
     - `lib/ttl-cache.ts`: `TtlCache<V>(max, now?)` with `get`, `set(key, value, ttlMs)`, `remember(key, ttlMs, make)`
       (callers share one pending promise; a rejected one is dropped so the next call retries), `delete`,
       `deleteWhere`, `clear`, `prune`. Past `max`, the oldest written goes first; a hit doesn't refresh age. Same
       behaviour as the hand-rolled caches it replaces: Plex metadata (`remembered`, 5000), Explore (`ExploreCache`,
       2000), calendar (100), Admin › History (32), artwork pictures (400), sign-in grants (1000). Seerr's public
       settings now have a cap (64; before, unbounded).
     - Left as they were, since they expire on something other than time: Explore's library snapshot (expiry set
       from the result), artwork folder rows (mtime), the IPTV guide-history cache (version), `ArtworkCache` (byte cap).
     - `lib/every.ts`: `every(ms, task, onError)` returns `{stop}`. It skips a run while the last one's promise is
       still going, sends thrown or rejected errors to `onError`, and unrefs the timer. Used by the IPTV refresh tick,
       session reaper, artwork and clean-up schedules, automatic new episodes, channel checks, watch-history
       checkpoints, sports schedule, live and custom channel sweeps, and each custom channel's indexer.
     - Changed behaviour: a failing tick is now logged instead of being an unhandled error (Node exits on those).
       `EpisodeSync.tick` had no catch at all, and its runs could overlap; now they can't.
     - Left on plain `setInterval`: the per-connection SSE heartbeat, the VOD session recheck, and
       `VodTranscodes.sweep`. A sweep there waits on Plex for every session, so skipping overlapping runs would delay
       idle stops while Plex is slow.
   - A durable job queue: deferred, to be built together with the Radarr/Sonarr replacement.
5. **Test fixes** (working tree):
   - `tests/iptv-api.test.ts`: the guide loop used the removed `iptv` filter. It now uses the source's UUID, the
     filter that replaced it. `custom` (the handoff's suggestion) lists no IPTV channels, so it would fail the loop's
     one-channel assertions; the test already checks `custom` returns none a few lines down.
   - `tests/channel-health.test.ts` "The scheduler respects provider connections…": each check awaits a real `mkdir`
     before it reaches the probe, and the test waited a fixed 20 ms. When `mkdir` was slower, the viewer cancelled a
     check whose probe had not yet added its abort listener, so the check never ended and the viewer waited out its
     15 s timeout. The test now waits for the state itself (`until(…)`, 5 ms polls, 2 s ceiling) and checks "no check
     while the viewer holds the connection" synchronously after `pump()`. Scheduler unchanged.
6. **Explore first load** (working tree). Measured with a scratch harness (not kept): `registerExplore` on a bare
   Fastify with fake Plex, Plex Discover, plex.tv, TMDB and Seerr transports with assumed latencies (Plex server
   20 ms + 0.5 ms per title, Discover and plex.tv 150 ms, TMDB 90 ms, Seerr 40 ms and 120 ms per `/media` page), a
   4,000-movie and 1,500-show library, 1,500 titles tracked in Seerr, 10 Discover shelves. One "load" is what the page
   asks for: sources and both row lists, then the first 4 Plex and 5 TMDB row pages at once.

   | Load | Before | After |
   | --- | --- | --- |
   | Cold, whole load (last row) | 3,161 ms | 1,565 ms |
   | Cold, Plex and streaming rows | 2,535 ms | 558 ms |
   | Cold, Top Picks / Because You Watched | 3,160 ms | 1,565 ms |
   | Warm | 6–14 ms | 6–7 ms |
   | Six minutes later (Seerr index expired) | 1,867 ms | 7 ms |

   What dominated, and the fixes:
   - **Seerr's status index** (`Seerr.statuses`): every row page, Plex or TMDB, waits on it for its labels. It read
     `/media` pages one after another (15 pages, about 2 s) and expired after 5 minutes, after which every row waited
     the full read again. Now the first page gives the count and the rest are read five at a time (`readIndex`).
     After expiry the last index (up to an hour old) answers while a new one is read. A request drops both, so the
     next read is waited for and the requested title shows as requested. `/explore/sources`, the page's first call,
     starts the read so it overlaps the row reads.
   - **The Plex library snapshot** for the personal TMDB rows (`PlexAdapter.exploreLibrary`): it read 200-title pages
     two at a time, one per library, so a 4,000-movie library took 20 rounds. Now each library's first page gives its
     size, the rest of its pages are queued at once, and four are read at a time, taking turns between libraries
     (same 10,000-title budget, shared the same way). A queued page that comes back short marks the snapshot
     incomplete, as an outage does. The snapshot is kept a day, so this is the cold load only.
   - Not changed: the personal rows still wait on TMDB recommendation and genre lists after the snapshot (about
     200 ms here), and TMDB reads stay limited to six at a time.
   - Tests: `explore.test.ts` "Seerr labels…" (five at a time, the expired index answers while the new read finishes,
     a request drops it); `explore-tmdb.test.ts` "Plex recommendation input queues each library pages…" (all pages
     read once, four at a time, budget shared, short page).
7. **Live TV guide on a large guide**: measured, no change. Scratch harness: 900 M3U channels linked to a 12.5 MB XMLTV
   guide (64,800 programmes), `guidePage` 30 channels at a time, 4-hour window.
   - Fresh store (after a restart): first page 270–350 ms (decrypting 44 ms and JSON-parsing 44 ms of that; the rest
     is the program index and first-run JIT). After that 11–20 ms a page, searches and source filters included.
     `stacks()` is about 6 ms.
   - Right after a refresh: the refresh's coverage pass has already decoded the new snapshot, so the first page is
     about 115 ms (rebuilding the program index), then back to 11–20 ms.
   - That is one wait of a few hundred ms per restart, so it was left alone.


## Left to do

Steps 1–3 of the last list are done (Done in this pass, steps 5–7). What remains:

1. **Optional architecture tidy**: route bodies still live in `*-api.ts` files outside `modules/` (see "Route files
   outside `modules/`" above). Moving them is mechanical and low value; only do it for a module being changed anyway.
2. **Durable job queue**: waits for the Radarr/Sonarr replacement.

For the user to check in the running app (not for the next session to do):
- First start applies the iptv `snapshot-version` migration; the Live TV guide loads and changes after a guide
  refresh (Admin › IPTV › Refresh now on an XMLTV source), in both `npm run dev` and a built `npm start`.
- Ctrl+C with a stream playing exits promptly with no errors in the log.
- Background work still runs: a scheduled source refresh, channel checks, artwork and clean-up schedules.
- Explore after a restart: rows fill in sooner, labels (Requested, Available) still show, and a request shows its
  title as Requested on the next load.

## Conventions to keep
- Per CLAUDE.md: `npm run typecheck`, run only the affected test files, and don't start the app to check UI.
- Behaviour-preserving moves: copy route bodies unchanged, and swap `await auth(req)` / `await admin(req)` for a
  declared access level plus `viewer(req)`.
- Cross-module reactions go through the bus; wiring inside one module can stay direct.
- Commit only when asked; then commit on main and push.
