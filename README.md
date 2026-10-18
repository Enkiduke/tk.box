# tk.box

Independent Node/TypeScript modular monolith and React/TypeScript media application built on the Milestone 0 integration foundations. **Milestone 0 remains open. This is not a completed or production-approved media platform.**

The supplied source of truth is [UNIFIED_MEDIA_PLATFORM_SPEC_v30.md](UNIFIED_MEDIA_PLATFORM_SPEC_v30.md). Its workspace references use the tk.box name; the requirements are unchanged. Reference snapshots are read-only, are not runtime dependencies, and are excluded from compilation.

## Development

Use a maintained Node 22 LTS or 24 LTS patch release, npm, and system FFmpeg/ffprobe with software `libx264`, AAC, MPEG-TS and HLS support. Verified here with Node 22.11.0 on Windows; Linux installation is still an explicit validation gate. No Docker or GPU setup.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run smoke:built
npm run spike:media
npm run spike:serve
```

The final command serves only generated test patterns on loopback at port 8766. Open the printed URL to test the two real HLS manifests in a browser. It is a finite retained-media experiment, not a simulated video player and not a continuous Plex/IPTV broadcast. The command remains running until Ctrl+C. Never publish this fixture server through the production proxy.

The next-stage clock/buffer experiment runs real on-demand FFmpeg work for fixed eight-second generated programs and publishes completed segments against the server clock:

```sh
npm run spike:live:prepare
npm run spike:live:check
npm run spike:live:serve
```

Open its printed loopback URL (default port 8767). Tune both experimental viewers, pause one through a program boundary, resume behind live, and Go Live. The harness uses temporary fixture cookies and **30 seconds** of accelerated test retention; production settings remain **30 minutes**. Preparation must run while the fixture server is stopped. Stop both viewers before terminating the server. It is separate from the production app and must not be published externally. See [continuous playback evidence](docs/CONTINUOUS_SPIKE.md).

`npm run verify:plex` now provides a bounded, read-only real-Plex verification command. It requires protected token files and configured server identifiers; see [live Plex checks](docs/LIVE_PLEX_CHECKS.md). It never guesses credentials or sends VOD timeline writes.

The application also provides protected IPTV metadata APIs: restricted remote fetching, encrypted source configuration, transactional channel admission/restoration, independent scheduled/manual refresh, source-bound XMLTV matching and viewer-local favorites. See [IPTV ingestion and API exercise](docs/IPTV_INGESTION.md). Fixture uploads can exercise these paths without provider credentials after owner sign-in. Approved channels play live through an FFmpeg relay; see [live IPTV playback](docs/IPTV_INGESTION.md#live-playback).

```sh
cp .env.example .env
# Edit .env; no account password or owner streaming token belongs here.
node --env-file=.env --import tsx scripts/migrate.ts
node --env-file=.env --import tsx scripts/doctor.ts
npm run build
node --env-file=.env dist/apps/server/src/index.js
```

Open the configured app listener. Without Plex IDs, health and the setup workbench run, while login stays disabled. With IDs configured, tk.box supports Plex PIN sign-in, a featured home page, library browsing by genre/title/watch status, continuous grid and list browsing with an A–Z rail, compact advanced filters and saved sort/layout choices, rich movie/series/season/episode details and VOD with resume: Direct Play for browser-compatible files, otherwise Plex's own transcoder as a backend-proxied HLS stream (Direct Stream with copied video, or an eligible 1080p-or-lower CPU transcode that counts against the shared encoder limit). The unified guide includes channel search, date/time navigation, program details and viewer favorites. Administrators can import sources, search pending channels and approve or ignore up to 100 together. Live TV channels play from the guide. Track preferences remain integration work. See [UI progress](docs/UI_PROGRESS.md).

If only `PLEX_URL` is known, discover the missing IDs locally:

```sh
npm run setup:plex -- start
# Complete owner sign-in at the printed official Plex link.
npm run setup:plex -- finish
```

This command loads `.env`, verifies ownership of that exact server and requires accessible Movies and TV libraries before writing the numeric owner ID, machine ID and library IDs. It preserves unrelated settings and refuses concurrent configuration edits or replacement of an existing numeric owner. A nonnumeric owner field can be repaired only by this verified local setup flow; the application's normal configuration remains strict. The token is used in memory and is not saved to `.env` or the setup report. Restart tk.box after configuration changes, then use its normal Sign in with Plex flow to establish a browser session. See [live Plex checks](docs/LIVE_PLEX_CHECKS.md).

For a self-contained UI preview with original abstract artwork and synthetic media, run `npm run build` followed by `npm run preview:ui`, then open `http://127.0.0.1:3011/__preview`. This loopback-only development harness uses an in-memory database, does not read `.env`, and has no real playback. Its fixture login route exists only in that script; it is excluded from the production build.

Optional separate frontend development: `npm run dev` and `npm run dev:web`. `DEV_API_ORIGIN` selects the backend origin for Vite's development proxy (default matches the default local backend). Set backend `APP_PORT` and the dev proxy target consistently. Production browser URLs are relative and share one listener.

## Boundaries and structure

| Directory | Responsibility |
| --- | --- |
| `apps/server/src/providers` | Independent Plex HTTP adapter; restricted source fetcher, M3U/XMLTV parsers and mapping rules |
| `apps/server/src/services` | Identity, immutable VOD session history boundary, clock scheduler, single-flight source refresh |
| `apps/server/src/persistence` | SQLite migrations/settings/audit, schedule publications, encrypted sources, transactional channels/number reservations, favorites and guide intent |
| `apps/server/src/security` | AES-256-GCM credentials; hashed opaque session/challenge identifiers |
| `apps/server/src/streaming` | CPU policy, encoder budget, shared upstream registry, finite recovery, retained segment index/cursors, local FFmpeg worker |
| `apps/web` | React media UI, unified guide, source review and shell-owned real video/HLS component |
| `packages/contracts` | Shared validated types and settings contract |
| `tests` | Service/HTTP fixture tests; synthetic playlist/guide inputs |
| `scripts` | Real media spike, loopback fixture browser harness, doctor, migrations |
| `deploy` | Native systemd example |
| `docs` | Investigation evidence, deployment, live verification gates and resume status |

See [implementation status](docs/IMPLEMENTATION_STATUS.md), [reference review](docs/REFERENCE_REVIEW.md), [playback investigation](docs/PLAYBACK_SPIKE.md) and [native deployment](docs/DEPLOYMENT.md). No upstream source has been copied. No project distribution license is selected by this private initial pass; dependency licenses remain their own.
