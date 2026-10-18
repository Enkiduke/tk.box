# Media UI and discovery

Implemented October 17, 2026. The local Nevu and Nodecast snapshots informed the interaction patterns; no reference source or artwork was copied. Existing Plex authorization, credentials, source isolation and playback policy remain the service boundaries.

## Included

- Home: selectable featured titles with authenticated backdrop artwork and direct Play/Resume; horizontal shelves with scroll controls; favorites with current guide information; library/guide shortcuts.
- Movies/TV: library selection, title search, genre/year/content-rating filters, unwatched browsing, ascending/descending sorts, continuous grid/list browsing, A–Z jumps and filter reset. Choices persist per account/media type in the current browser, with explicit URL values taking precedence. Filtering occurs on Plex before pagination.
- Details: backdrop/poster, rating, genres, watched/resume state, series/season/episode hierarchy and parent navigation. Playback uses the existing original direct-VOD session API.
- Guide: the four established channel filters, channel name/number search before pagination, targeted channel links, date and two/four-hour windows, sticky station column, current-time line/progress, program and now/next dialogs, favorites and empty-state recovery. Per-account filter memory lasts for the browser session. Deep links default to All Channels so a remembered Favorites filter cannot hide a searched station.
- Sources (replaced October 18, 2026 by automatic listing; see [Channel listing](IPTV_INGESTION.md#channel-listing)): searchable review by name, provider ID, group or number; select up to 100 eligible pending rows; approve or ignore selected channels atomically. Source revision, scope, presence and identity conflicts are validated before admission. Database errors roll back admissions, number reservations, revision increments and audit entries together.
- Accessibility: mobile icon links keep accessible names; Settings remains available; dialog/keyboard behavior uses native dialogs; Ctrl+K focuses global search; Skip to content focuses the main element without triggering the hash router.

## API additions

- `GET /api/v1/catalog/libraries/:id/genres` returns only `{genres:[{id,title}]}` from an authorized library.
- Catalog item queries accept a constrained numeric `genre` and `shelf=unwatched`, preserving page limits, sorting and grant checks.
- `GET /api/v1/guide` accepts bounded `q` and an optional UUID `channel`; search/channel scope and Favorites are applied before paging, over viewer-visible stations only.
- Removed October 18, 2026, replaced by `POST /api/v1/admin/iptv/sources/:id/channels/listing`: `POST /api/v1/admin/iptv/sources/:id/channels/review` took `{expectedRevision,ids,approval}` where approval is `approved` or `ignored`, and there are 1–100 unique, eligible pending channel IDs. Viewer calls fail with 403; stale or ineligible selections make no changes.

## Verification

- 62 tests pass. Added tests cover genre grant/DTO/query handling; HTTP validation; guide filtering before pagination and hidden-channel isolation; bulk source/revision/duplicate validation; late-failure transaction and audit rollback; owner HTTP admission and viewer denial.
- Typecheck, production build and compiled smoke pass. hls.js remains a separate lazy chunk, with Vite's existing size warning.
- Real configured Plex owner: metadata checks passed for 405 movies and 228 shows, 26/33 genres, filtered/unwatched pages, search, details, artwork and episode hierarchy. This read-only check neither reads media nor writes watch history. Sanitized evidence is in ignored `.local/catalog-verification/report.json`.
- Browser fixture checks: home, genre/unwatched filters and list layout, movie detail resume controls, series/season/episode browsing, guide search/program dialogs, favorite mutation, persisted guide filters, Ctrl+K, mobile layout and bulk approval of two searched pending rows. The 390px layout has no horizontal document overflow; the guide scrolls internally.

## Reproduce the UI preview

Run `npm run build` and `npm run preview:ui`, then open `http://127.0.0.1:3011/__preview`. Stop with Ctrl+C.

This development script binds only loopback, uses an in-memory database and synthetic credentials/artwork/catalog/guide, and never loads `.env`. It is excluded from the compiled production server. No real media is playable in the fixture, and its channel edits disappear when stopped. The production sign-in and app have no fixture route or authentication bypass.

## Remaining integration work

Custom-channel playback, custom-channel authoring/publication UI, Plex track preferences and broader VOD format negotiation remain open. IPTV channels play live from the guide (see [live playback](IPTV_INGESTION.md#live-playback)); there is no DVR or time-shift control. The current original direct-VOD compatibility boundary remains unchanged. Browser fixture checks do not establish real media decoding, shared-account behavior or provider streaming acceptance.

## Preview session isolation fix

The development preview now uses `tk.box_ui_preview_local` and `tk.box_ui_preview_link`, separate from the real app’s cookies. Cookie scope does not include TCP ports; using the same name on ports 3000 and 3011 could replace the real browser session. A regression test verifies that preview login/logout preserves an existing real-app session. The real app remains the default user-facing destination at `http://127.0.0.1:3000/`; the preview must be opened explicitly for isolated testing.

The subsequent compact-library pass replaces the original heading/filter panel and browser pagination. See [compact library implementation](LIBRARY_UI.md) for windowing, caching and real-server verification.
