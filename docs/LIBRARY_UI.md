# Compact library UI

Implemented October 17, 2026 against the configured real Plex server.

## Experience

Movies and TV Shows use one compact sticky row: live title search, Filters, Sort, grid/list toggle and a small result count. Removed the redundant heading, collection eyebrow, descriptive sentence, boxed form, separate watch-status tabs and poster score overlay. The top app bar supplies the page title. A visually hidden heading remains available to screen readers.

Filters include genre, unwatched status, release year and content rating. Sort includes title, date added, year, rating and duration, each ascending or descending. Active filters appear as removable chips. Library selection appears only when more than one library of that type is available. Preferences are stored by account and media type in localStorage; URL values override saved choices. Search uses a 250ms debounce and replaces the current history entry while typing. Ctrl+K focuses this search on library pages.

## Continuous browsing

- `catalog-browser.tsx` renders visible rows plus three rows of overscan, with a full-height spacer representing the library. Both grid and list work without Previous/Next controls.
- `catalog-feed.ts` fetches 60-item pages covering the current window and nearby content, deduplicates requests, permits at most four concurrent page requests, retains at most twelve metadata pages and cancels obsolete generations on query changes/unmount. Errors have an explicit retry path.
- A right-side rail uses `/api/v1/catalog/libraries/:id/index`. The adapter calls Plex's `/library/sections/:id/firstCharacter`, returning only labels, counts and cumulative offsets. Clicking a letter fetches its target page directly; it does not walk all earlier pages. The rail follows the native sort direction and is available for title sorting.
- Catalog and alphabet queries share the same library/type, text, genre, unwatched, year and content-rating filters. The real server's older `/unwatched` shelf gave different TV counts from its filtered index; both now use the same `all?unwatched=1` semantics, producing matching counts. The server rejects alphabetical indexing of other shelves/sort fields.

The singular first-character path is used by [Python PlexAPI's implementation](https://python-plexapi.readthedocs.io/en/stable/_modules/plexapi/library.html#LibrarySection.firstCharacter). The plural path in the supplied SDK snapshot was unavailable on the configured server. No reference source was copied.

## Loading work removed

The `/me` response includes its already-authorized media libraries, removing the former subsequent `/libraries` startup request. Account/resources and identity/library checks run in independent parallel pairs. There is no successful-grant TTL: later protected requests still recheck Plex.

Catalog requests exclude unneeded Media/cast/production elements while retaining fields used by cards. Artwork has a viewer-token/account/path-version scoped memory cache (32 MiB, 256 entries, five-minute byte retention), coalesced image requests, asynchronous browser decoding and private ETag revalidation. Every image request, including a 304, authenticates the session and resolves current item metadata before cache reuse. Removed, revoked or changed-path artwork does not bypass those checks.

## Verification

- 62 tests pass; typecheck, production build and compiled smoke pass.
- Tests cover absolute window/page ranges for 100,000 entries and direct jumps; shared advanced filters and index offsets; library scope; image cache expiry/eviction/byte bounds; fresh metadata checks and account isolation on cache hits; and authorization before conditional 304 responses.
- Read-only real Plex checks: 405 movies/228 shows. Native index totals match all/unwatched lists (405/305 movies, 228/206 shows), descending order, year 2024 (11 movies/14 shows) and content-rating filtering. Neither media playback nor watch-history writes is used for these checks.
- Real-app browser checks cover M/Z jumps, the final title and end state, zero library pagination controls, live search, year filtering, grid/list preference persistence across navigation, sorting, keyboard dismissal, Ctrl+K and zero app-added poster score overlays. About 32–49 cards were rendered at desktop widths and 14 at 390px, with no horizontal document overflow.
- Normal, 390px and 1600px layouts were inspected. Temporary viewport overrides were reset. The real app is left running on port 3000; no sample-data server was started for this pass.

Scores already printed inside a Plex poster image remain part of that source artwork; the separate tk.box score overlay has been removed. Full-size title details continue to show metadata ratings.
