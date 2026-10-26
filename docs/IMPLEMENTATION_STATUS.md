# tk.box implementation status

Updated October 17, 2026. **Milestone 0 foundations implemented; integration acceptance remains OPEN.** Live remote Plex owner setup is verified; production deployment and real media/provider streaming acceptance remain open.

## Latest pass: custom channels, phase 4 (automatic new episodes)

- Each show or season on a custom channel can automatically add new episodes (off by default, toggled per selection in the Shows tab). New episodes take their place in season and episode order, or follow the show's last entry if the list was rearranged. Removed episodes never come back. Each addition goes on air at the end of the current program and merges with any publish already waiting. Episodes with no runtime or that can't be played are held back. Checks run hourly and on demand, reading Plex with the Plex admin token from Admin › Connections.

## Previous pass: custom channels, phase 3 (Pause, Resume, Go Live)

- On custom channels the player's Pause button pins that viewer's position, and Play continues from there, behind live, showing how far behind. Go Live jumps back to what's on now. Other viewers and the schedule aren't affected. Segments are shared and kept by broadcast time only while someone needs them, up to the pause retention setting (default 30 minutes), the per-channel disk cap and a free-space floor. Past that, the viewer sees "Buffer expired" with Go Live. Settings → Playback shows buffer use and warns before retention is lowered. IPTV stays strictly live.

## Previous pass: custom channels, phase 2 (playout)

- Custom channels can be watched (October 18, 2026). The first viewer starts a shared station that joins the airing program at its clock position, and each following program starts on schedule behind an HLS discontinuity. The station stops when the last viewer leaves. H.264 is copied; other video at 1080p or below is encoded within the shared encoder budget. Media is read from disk in same-host mode, otherwise through a loopback-only proxy, so the Plex token stays out of FFmpeg's arguments. No Plex timeline or watch state is ever written. Details and limits: [Custom channels](CUSTOM_CHANNELS.md#build-phases).

## Previous pass: custom channels, phase 1

- Settings → Channels (October 18, 2026): create, number, order, disable and delete custom channels. A Plex picker adds movies, whole shows, seasons or episodes. The program list supports drag or arrow reordering, repeats, removal and arrange tools (shuffle, block shuffle, interleave, sort by show or date, remove repeats or specials, repeat the list). Drafts are separate from what's on air, and a publish preview shows the handoff. Publishing takes effect when the airing program ends. Design and phases: [Custom channels](CUSTOM_CHANNELS.md).
- Published channels appear in the Live TV guide (all, Plex Channels and Favorites filters), with exact program times. They can be favorited but not yet watched; playout is phase 2.
- Programs that would need a forbidden encode (above 1080p and not H.264), or that have no file or runtime, are flagged when added and block publishing.

## Previous pass: automatic channel listing and settings redesign

- Removed channel approval (October 18, 2026). Channels list themselves by per-source rules: regular channels while they pass channel checks (optionally only after a first passing check, on by default) and, if the source asks for it, only while the guide has a program on now or within a look-ahead (default 2 hours), with always-on keyword (`24/7`) and per-category exceptions. Event categories list while their event is live or starting soon. Administrators can still hide a channel or always list it. Details: [Channel listing](IPTV_INGESTION.md#channel-listing).
- Sports events now apply per playlist category, so one playlist can mix event categories with regular stations; Auto Add and bulk approval are gone.
- Redesigned Settings: a section sidebar (IPTV sources, Live Events, Playback, Account), a source list, and per-source tabs (Overview with why channels are not listed, Channels with bulk listing overrides, Listing rules and categories, Guide, Checks, Sports, Connection).
- **129 tests pass** and typecheck and the web build pass. Browser checks used the isolated `ui-preview` fixture at desktop and narrow widths. Not yet verified against a real provider playlist or EPG.

## Previous pass: compact library and fast browsing

- Replaced the library heading, descriptive text, toolbar panel and status tabs with one compact sticky search/control row. Genre, watch status, release year and content rating live in a Filters popover; Sort provides field/direction. Choices persist per account and media type in this browser. Removed app-added score overlays from posters.
- Movies/Shows now use continuous windowed browsing with 60-item requests, nearby-page prefetch, bounded metadata retention, stale-query cancellation and a right-side alphabet rail driven by Plex's native first-character counts. Verified real Movies/TV totals, filtered counts and descending order. No Previous/Next controls remain in those libraries.
- Startup reuses authorized libraries in the identity response, avoiding an extra authorization request. Independent Plex checks run concurrently. Catalog pages omit unneeded media/cast payloads. Bounded image reuse and conditional image responses still authorize the viewer and resolve current item metadata before every delivery/304.
- Current checks: **62 tests pass**, typecheck, build and compiled smoke pass. Real-server browser checks cover continuous browsing through the final title, A–Z jumps, live search, saved filters/layout, keyboard controls, and normal/390px/wide desktop layouts. Implementation and limits: [compact library UI](LIBRARY_UI.md).

## Previous pass: media UI and discovery

- Built the featured home page, horizontal media shelves, favorite-channel cards, grid/list browsing, server-side genre and unwatched queries, artwork-backed details, series/season navigation and Ctrl+K search. Mobile navigation retains accessible labels and Settings; the skip link focuses content without changing routes.
- Expanded the unified guide with search before pagination, channel deep links, dates, two/four-hour windows, program/now-next dialogs, current-time markers, progress and per-account filter memory for the browser session. The guide remains listings-only while streaming transport integration is open.
- Added administrator search and bulk review for up to 100 pending channels. Source/revision validation, approval, number allocation and audit changes commit atomically; conflicting, missing, cross-source and stale selections are rejected.
- **57 tests pass**, along with typecheck, production build and compiled smoke. Read-only owner verification passed against the configured Plex server for both Movies and TV: genres, genre filtering, unwatched pages, search, artwork, details, seasons and episodes. Browser checks used isolated synthetic fixtures at normal and 390px widths. Details and reproducible preview: [UI progress](UI_PROGRESS.md).

## Previous pass: remote Plex setup

- The remote HTTPS endpoint in `.env` is reachable. Live Plex PIN sign-in verified account ownership, unique server resource/identity and normal administrator authorization. One Movies and one TV library were discovered; verified numeric owner/server/library identifiers were written to `.env` without altering unrelated settings or saving an account token.
- Added `npm run setup:plex -- start / finish`, `services/plex-setup.ts` and adapter discovery methods. Encrypted expiring challenges, content-checked atomic configuration replacement, numeric-owner replacement refusal and sanitized reports. Local setup can repair a nonnumeric owner value only after verified ownership; ordinary application config stays strict. Empty optional fields now count as unset. Evidence: ignored `.local/plex-setup/report.json`; instructions: `docs/LIVE_PLEX_CHECKS.md`.
- **48 tests**, typecheck, build and compiled smoke pass. Live diagnostics now report `plexConfigured: true`. The compiled app was started with this configuration at loopback port 3000 for the workbench; no production service was installed. Main browser login is separate from CLI setup. No media was read, timeline reported or encoder started in this setup pass.

## Resume here

- Source of truth: `UNIFIED_MEDIA_PLATFORM_SPEC_v30.md`; all 1,438 lines were read before implementation. The requested unversioned filename was absent. Confirmed decisions remain unchanged.
- Initially only the specification and four reference snapshots existed; no Git repository. References remain read-only, excluded from builds and runtime, with no copied source. Architecture/licensing findings: `docs/REFERENCE_REVIEW.md` (dizqueTV zlib; Nevu/Nodecast GPL; plexjs MIT).
- Single-process Node/TypeScript/Fastify backend, React/Vite/TypeScript workbench, shared Zod contracts, SQLite/better-sqlite3 and external CPU-only FFmpeg/ffprobe. Configurable native listener and systemd draft, existing external HTTPS proxy; no Docker or GPU.
- Local development/configuration: `README.md`, `.env.example`; deployment and secrets/backups: `docs/DEPLOYMENT.md`, `deploy/tk.box.service`. Remote Plex identifiers are configured; no verification token files or IPTV credentials are supplied. Generated reports/media are ignored under `.local`; application state is ignored under `data`.

## Implemented foundations

- **Plex/security:** PIN linking, browser-bound challenges, hashed opaque HttpOnly cookies, encrypted tokens, configured owner bootstrap, current shared-server/library/item authorization, CSRF and sanitized errors/logging. Direct original VOD APIs/workbench, resume offset and VOD-only progress reporting. Stored playback mode is immutable; linear progress writes and cross-session access fail closed. Open VOD responses abort on Stop/logout and periodically revalidate access.
- **IPTV ingestion (latest pass):** `providers/source-fetch.ts`, `persistence/iptv-store.ts`, `services/source-refresh.ts`, `iptv-api.ts`. Schema 2 stores encrypted endpoints/snapshots/provider metadata, channels, global number reservations, favorites, source/feed bindings and mapping intent. Restricted metadata fetch pins validated public DNS addresses, permits only same-origin redirects, bounds HTTP/gzip/UTF-8 input and rejects incomplete responses. No dependency added.
- **IPTV publication:** transactional reconciliation, automatic listing by per-source rules (no approval), hidden/always-listed overrides, retained IDs/numbers/positions/favorites/name overrides, immediate missing-state visibility and unambiguous restoration honoring hidden state. Listing is separate from identity conflict. Feeds have separate internal identities; shared guide IDs and identical names can identify multiple feeds. Exact repeats deduplicate, stable labels/URIs preserve saved feeds across refreshes, and uncertain matches get an explicit candidate review. Cached legacy playlists upgrade automatically at startup without losing curation or refresh timestamps. Country, language, regional and time-shift variants stay distinct in station grouping. Majority disappearances are held for administrator review of an exact digest/revision; last-good state remains active.
- **Refresh/EPG:** independent persisted 12h M3U/6h XMLTV defaults, 1–168 whole-hour validation, static uploads, scheduled/manual single-flight, four concurrent metadata fetches, provider backoff, interval-edit race protection and shutdown cancellation. Explicit feed binding; unique exact-ID automatic mapping, inactive suggestions and revision-checked manual approval. Cached authentic program windows survive fetch failures, with null-program gaps. API exercise and limitations: `docs/IPTV_INGESTION.md`. Original pure/cache prototypes remain isolated tests, not application storage.
- **Clock/policy:** durable immutable schedule revisions, deterministic server-clock joins/looping and safe-boundary successor/fallback publication. CPU eligibility and FFmpeg guards reject all above-1080p/unknown-dimension video encodes, including 4K HEVC. Default-two encoder admission has no queue/capacity retry. Shared compatible upstream/refcount/provider-limit and finite recovery controllers exist; actual provider transport is not attached.
- **Continuous generated-media experiment:** atomic disk segments/deletion, byte/free-space limits, independent authorized viewer cursors/leases, Pause/Resume/Go Live/expiry and discontinuous HLS delivery. Real 17-second FFmpeg/clock experiment decoded 400 expected frames without packet warnings, used three shared program preparations for two viewers and released all cache bytes/encoder permits on Stop. Browser tests confirmed independent playback and delayed Resume/Go Live/expiry through repeated boundaries. This separate fixture server uses temporary fixture authentication, not production Plex grants. Evidence: `docs/CONTINUOUS_SPIKE.md` and `docs/PLAYBACK_SPIKE.md`.
- **Live Plex verification CLI:** `npm run verify:plex` checks owner/shared/unauthorized accounts and before/after history after bounded original-part EOF reads without timeline writes. It correctly returned `SETUP_REQUIRED` here. Protected-file setup and remaining natural-completion tests: `docs/LIVE_PLEX_CHECKS.md`.

## Current checks

| Check | Observed result |
| --- | --- |
| `npm test` | **62 passed**, including catalog/genre queries, guide search, atomic bulk review, access control, durable IPTV, local HTTP, scheduler, policy and Plex fixtures |
| `npm run typecheck` | Passed |
| `npm run build` | Passed; app about 298 KiB and lazy hls.js about 595 KiB; existing hls.js chunk-size warning |
| `npm run smoke:built` | Passed: compiled listener/frontend, protected Plex/IPTV APIs, shutdown and explicit port collision failure |
| `npm run db:migrate` | Passed; SQLite schema **2** |
| Prior media/browser checks | Recorded in playback/continuous-spike documents; not rerun for metadata-only changes |

Native HTTP socket tests and compiled smoke ran outside this Windows sandbox because its loopback connections return EACCES. No real Plex/provider compatibility follows from fixture tests. Initial dependency audit reported zero advisories; this pass changed no dependencies and did not rerun that audit.

## Risks and next tasks, in order

1. **Remaining real Plex acceptance:** remote owner PIN/resource/identity/admin checks and server/library configuration now pass. Shared/unauthorized test credentials and a designated media item remain unavailable. Verify normal browser cookies, shared-account grants/revocation, VOD seek/resume/completion/preferences and natural-completion custom-read history safety before enabling custom streaming.
2. **Real media/Linux acceptance:** carry the controlled clock/browser experiment to maintained Linux FFmpeg and permitted Plex media. General TS seek still showed about 443 ms A/V mismatch; CPU fMP4 on the old build failed validation and remains explicitly refused. Validate arbitrary GOPs/tracks/resolutions, long-file temporary-space caps, drift, CPU/disk/egress and the external proxy/browser matrix. No actual 4K HEVC direct/copy experiment occurred.
3. **Next independently implementable work:** equivalent restrictions for nested HLS playlists, media segments and keys, then authorized shared HLS/MPEG-TS relay/recovery with bounded cache and process cleanup. Obtain permitted M3U/XMLTV/media samples, required headers and provider sharing/concurrency terms to validate real behavior. Ambiguous signed-URL identity changes and provider completeness contracts remain open validation concerns. Majority-drop review cannot detect every logically incomplete export.
4. **Attach validated services:** connect real sources to shared upstream/recovery, encoder admission and disk cache; enforce per-viewer grants on every delivery, stop/revocation/handoff and crash recovery. Keep healthy streams independent of metadata refresh. One process only; no clustered admission or managed Plex encoder lifecycle.
5. **Later milestones:** track selection/preferences, persistent live shell and strict stop-live-before-VOD handoff, unified guide/channel editor, numbered custom-channel admission through `lineup_numbers`, episode synchronization and remaining admin curation. Production custom/IPTV streaming endpoints remain disabled; the media UI exposes real Plex catalog/VOD and IPTV metadata administration; live delivery remains disabled.
