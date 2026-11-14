# Handoff: backend modularization and efficiency work

Status as of 2026-11-14. Nothing below is committed yet. It sits in the working tree alongside other uncommitted work
from earlier sessions, so a commit must be split into honest per-work commits.

## Goal

Make adding backend features cheap and safe. Each feature is a module with its own services, routes, lifecycle and
declared route access, and modules talk through an in-process event bus instead of callback properties wired in
`app.ts`. Stay one process, Node/TypeScript, Fastify, SQLite (better-sqlite3). No microservices, Redis or Go port.

## Where it stands

The move is complete: every route is registered by a module under `apps/server/src/modules/`, and the server refuses
to start if any route declares no access level. Typecheck passes and the targeted tests pass, except the IPTV guide
filter test listed under Known issues. **None of it has been tried in the running app since the VOD move.** The user
is testing it now (see the checklist below).

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
8. **`artwork.ts`** (default admin): ArtworkStore, TmdbTitles, ArtworkEngine, ArtworkWorker, ArtworkSchedule and
   routes. Deps `{streaming, tmdbTransport}`. API `{store, engine, titles}`.
9. **`catalog.ts`**: library page routes. Deps `{hiddenRecent}` (artwork's engine).
10. **`explore.ts`**: ExploreStore and routes. Deps `{accountToken, titles, transports}`. API `{store}` (cleanup reads
    `store.seerr()`).
11. **`plex-notifications.ts`**: PlexNotifications, with no deps: it only emits and listens on the bus.
12. **`cleanup.ts`** (default admin): CleanupStore, CleanupEngine and routes. Deps `{artwork, seerr}`. API
    `{services}`.
13. **`calendar.ts`**: the calendar route. Deps `{connections, titles}`.
14. **`sign-in.ts`**: setup (`registerSetup`, all `public`), Plex sign-in start/status and logout (`public`),
    `/api/v1/me`, `/api/v1/libraries`, `/api/v1/media/:id` (viewer), and the session reaper.
15. **`admin.ts`** (default admin): metrics, Admin › Connections keys, Admin › Admins (`owner`), playback settings.
    Deps `{admins, settings, metrics, identity, customBuffer}`.
16. **`web.ts`** (default public): `/health` and the built web files.

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

### Adding a feature
1. Write `modules/<feature>.ts` with `defineModule`, building its services in `setup`.
2. Give every route an access level, or set a module `access` default when all of them share one.
3. Take other modules' APIs as deps for direct calls. Use bus events for reactions ("X happened"), adding the event
   to `BusEvents` in `bus.ts`.
4. Mount it in `app.ts` after the modules it depends on.

## Tests
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

## Known issues
- `tests/iptv-api.test.ts` "IPTV HTTP boundaries…" fails. It calls `/api/v1/guide?filter=iptv`, which the route schema
  rejects with a 400. It failed before this work too. Decide whether the test or the filter schema is wrong.
- `tests/channel-health.test.ts` "The scheduler respects provider connections…" failed once, then passed on reruns:
  it is timing-sensitive.

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

## Testing checklist (the user is running this)
If something fails, the module that owns the route is the place to look; mount order and bus wiring are in `app.ts`.

- [ ] Sign in with Plex; sign out; first-run setup (if practical).
- [ ] VOD: direct play, a transcoded title, switching audio track or quality, subtitles, resume, stop.
- [ ] IPTV channel: start, play a while, stop. Custom channel: start, pause, resume, Go Live, subtitles.
- [ ] Admin › Activity: tk.box streams and Plex app streams listed; Stop on a VOD, an IPTV and a custom stream.
- [ ] Sign out while something is playing: playback stops and the history session ends.
- [ ] Admin › History: summary, users, media, sessions, session detail.
- [ ] Admin › Artwork: titles, previews, a job; Clean Up: settings, a preview job; library pages reload after a job.
- [ ] Explore rows, details, a Seerr request; calendar; library pages and collections.
- [ ] Admin › Connections keys save (Plex token reconnects the notification feed); Admin › Admins; playback settings.
- [ ] Server shuts down cleanly (Ctrl+C) with a stream playing.

## Next steps, in order
1. **Fix what the app test turns up.**
2. **Per-module migrations**: tables are still created in `persistence/database.ts` (and in five store constructors).
   Give each module named migrations run by `mountModule`.
3. **Cheap efficiency gaps found but not fixed**:
   - `IptvStore.source()` is `SELECT *` and reads the multi-megabyte `encrypted_snapshot` even for `.name` or
     `.revision` (e.g. `guidePage` category names). Add narrow metadata queries.
   - Stores call `db.prepare(...)` inline on every call (112 in `iptv-store.ts`). Prepare once per store.
4. **Later**:
   - XMLTV parse in a worker thread, with the main thread staying the only SQLite writer (chunked transactions; a second
     writer connection would block on `busy_timeout`).
   - Shared scheduler and cache utilities.
   - A durable job queue together with the Radarr/Sonarr replacement.

## Conventions to keep
- Per CLAUDE.md: `npm run typecheck`, run only the affected test files, and don't start the app to check UI.
- Behaviour-preserving moves: copy route bodies unchanged, and swap `await auth(req)` / `await admin(req)` for a
  declared access level plus `viewer(req)`.
- Cross-module reactions go through the bus; wiring inside one module can stay direct.
- Commit only when asked; then commit on main and push.
