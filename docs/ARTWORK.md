# Artwork (Admin › Artwork)

Custom posters, season posters and episode title cards. They're sent to Plex, so tk.box and every Plex app show them; tk.box's own artwork route needs no changes (a new upload gets a new Plex image path).

## How it fits together

- **Engine:** `apps/artwork/artwork_engine.py` with its bundled `resources/` (fonts, badges, streaming logos). It is the renderer and Plex/TMDb/Fanart.tv/TVDB code. Jobs run in one long-lived `artwork_engine.py <config> --batch` process (`services/artwork-batch.ts`), one after another, so a push or a newly-added check that queues a job per title loads Python once instead of once per title. It lowers its own CPU priority (`nice 10`), so ffmpeg and the server come first.
- **Collections engine:** `apps/server/src/services/collections` (TypeScript, in the server) makes and keeps Plex's collections: franchise, streaming and chart collections, custom and seasonal ones, acquiring (tk.box adds the movies they want), and Discover. It needs no Python: it only talks to Plex (`PlexAdapter.serverRead` / `serverSend`, with the job's token), TMDb (the shared `ctx.tmdb`), MDBList (its service key) and the public list sites (`sources.ts`: only each provider's own hosts, redirects kept to them). `rules.ts` holds the checks, schedules and list filters; `engine.ts` the runs, word for word the old script's log lines; `presets.ts` the seasonal presets. Its jobs keep the old commands (`all`, `custom [--date]`, `added`, `index build/added`) and share Artwork's queue, run in the server instead of a process (`CollectionsRunner`). A run over every title queues `all apply` first when franchise collections are kept in sync and results go to Plex, so new collections get their posters in the same pass; a collection a run makes queues its poster straight away. Newly added titles join their custom collections on the collections' own schedule. Collection definitions are checked in TypeScript before saving; `artwork_engine.py`'s check covers only its own part.
- **Settings and layouts live in tk.box's database** (`artwork_settings`, `artwork_layouts`; migration 17). There is no YAML: before each run tk.box writes the engine's JSON config to `DATA_DIR/artwork/config.json` (`artworkConfig` in `services/artwork-engine.ts`). The first start seeds the layouts from `apps/artwork/defaults.json`: six tk-* layouts (tk-movies, tk-tv, tk-custom, tk-collections, tk-streaming, tk-charts), used by kind of title until a library is given its own. A database seeded with the earlier set (the engine's example layouts) has those replaced once, and settings that named them move to the tk-* ones. The engine tests keep the example layouts in `apps/artwork/tests/example_layouts.json`.
- **Credentials:** provider keys are sealed in the database. The Plex token is that of the administrator who started the job; scheduled jobs use the Plex admin token. Both are passed to the engine in its environment for that run only, and are redacted from the job output.
- **Files:** asset folders and rendered results are kept in `DATA_DIR/artwork/assets`, and downloads in `CACHE_DIR/artwork`.
- **Jobs** run one at a time, in order. Their output streams to the Jobs tab, and the last 2000 lines are kept with each job. A restart marks unfinished jobs as canceled.
  - The batch process reads each job as a JSON line (`{"args": [...]}`, the job's options on the same `config.json`, written again before each job) and ends its output with a `DONE {"code": N}` line. Warnings go to stdout with the rest, so they stay in order.
  - It starts with the first job and starts again when the Plex token or keys change. It stops after 2 minutes with nothing to run or after 200 jobs, so memory a big run took is handed back. Canceling a job ends the process; the next job starts a new one.
  - Between jobs it keeps its connections to Plex and the providers open (one shared connection pool per process) and the last 4 renderers it made (`kept_renderer`; making one costs 0.07–0.2 s), keyed by the layout's settings and the font files they open. Badge art and fonts are read again for each job.
  - It is separate from the worker, so a long job never holds up the Titles and Layouts pages.
  - Each title's output has a `TIME` line (`TIME Title (year): 0.89s (plex …, lookups …, downloads …, render …, save …, upload …)`) and each run a `TIMES` line: Python's start-up (first job of a process only), setup (finding the titles), and the titles' wall time and summed time by kind. Kinds under 5 ms are left out; Plex label checks during an upload count as upload.
- **Worker:** the interactive pages (Titles, Layouts) talk to one long-lived `artwork_engine.py --worker` process (`services/artwork-worker.ts`). It speaks JSON lines on stdin/stdout, with images base64-encoded, and lowers its own priority (`nice 5`).
  - It starts when those pages are opened and stops after 10 minutes unused.
  - It restarts when the Plex token or keys change.
  - It reads the same `config.json`, which tk.box writes again whenever settings, layouts or collections are saved.
  - The worker's methods (`Worker` in the engine) are only what needs the renderer; tk.box itself lists titles, keeps picks and asks the providers.
- **Images** reach the page only through the admin routes, because tk.box's CSP allows images from itself alone:
  - asset files and previews come from the worker;
  - Plex's own copies come through the worker, with the token;
  - provider pictures are proxied by `/image`, limited to the TMDb, Fanart.tv and TVDB image hosts.
- **Pushes:** a push queues one job per title (all run in the batch process). When a job succeeds, its "not pushed" mark is cleared.
- **Collections** live in `artwork_collections` (migration 18): custom and seasonal definitions, and franchise/streaming/chart options. Franchise collections (movies) and streaming collections (TV) each have their own switch; turning one off stops tk.box keeping them but leaves them in Plex. What the collections engine keeps between runs is in tables (artwork migration `collections-tables`, `persistence/collections-store.ts`): `artwork_kept_collections` (what the last full apply kept; the Collections page lists it, Clean Up's collection rule reads it), `artwork_collection_downloads` (the journal: each movie collections downloaded and the collections that wanted it; Admin › Manage's Source column and Recently added's hiding read it), and in `artwork_state` the rotating lists' sizes and the downloads waiting for the library (`collections:acquire`, taken after the job and sent as `collections.acquire`). Files an older tk.box kept these in (`kept_collections.json`, `collections-tkbox.json`, `discover-index.json`) are imported at startup and then deleted; a journal that can't be read is left in place and refuses acquisition until it is restored. The older `collections-state.json` is still read for the Source column. Discover answers in the server and uses the TMDb and MDBList keys.
- **Discover index:** Discover's Partly owned and Universes tabs read the index tables (`artwork_discover_movies`, `artwork_discover_collections`, `artwork_discover_universes`) instead of asking TMDb and the lists while you wait. They hold each movie's TMDb collection (trusted for 30 days), those collections' parts and each universe's list (7 days); what you own is matched with Plex when the tab opens. The nightly full collections run builds it (`index build` when results don't go to Plex), newly added movies join it in one `index added` job every 15 minutes, and Discover's Refresh builds it on demand. The nightly full run waits while anyone is streaming, in tk.box or any Plex app, for up to four hours past its time.
- **Schedules** (`services/artwork-schedule.ts`) replace the old cron entries and the hook that ran on new titles. Artwork's are kept with its settings (Artwork › Schedules) and the collections' with the collections (Admin › Collections › Schedules); collection schedules saved with the artwork settings before then move over once, at startup.
  - scheduled tasks, each on its own schedule in server local time (every N minutes/hours/days, set times on chosen weekdays, or a cron expression; `packages/contracts/src/schedule.ts`), a missed time run up to two hours late: artwork's changed titles; the custom and seasonal collections; every collection;
  - two newly-added checks, each with its own watermark in `artwork_state`: artwork's reads the chosen libraries and queues `--added` artwork jobs; the collections' reads the libraries that enabled custom collections use and queues `added <key>` collections jobs. A check reads each library's recently added list back to its watermark, queues up to 50 titles oldest first, and moves the watermark only past what it queued; if Plex doesn't answer for a library, it moves nothing.
  - the checks run as soon as Plex finishes adding a title. With a saved Plex owner credential, tk.box shares one Plex Media Server notification connection between these checks and external playback history (`services/plex-notifications.ts`). When a movie, show, season or episode in a watched library finishes processing, or a library scan ends, enabled checks run once things have been quiet for 30 seconds (at most 3 minutes after the first). Each connection also runs enabled checks once on opening, for anything missed while it was down. It reconnects after a drop. Their own schedule is a backstop.

  The schedules and the notification feed read Plex with the Plex admin token (Admin › Connections, see `services/plex-background.ts`), so they run whether or not anyone is signed in; without a working token they wait. Plex never connects to tk.box, so no webhook or Plex Pass is needed.
- **Isolation:** the routes are `/api/v1/admin/artwork/*` (administrators only). The Admin console is its own lazy-loaded bundle. No playback, live or catalog code path calls into artwork. A title's details show **Edit artwork** only to administrators; it opens `#admin?section=artwork&title=<rating key>`.

## Setup

```sh
cd /opt/tk.box
python3 -m venv artwork-venv
artwork-venv/bin/pip install -r apps/artwork/requirements.txt
```

Set `PYTHON_PATH=/opt/tk.box/artwork-venv/bin/python` in the service environment and restart. Then add the provider keys, choose the libraries in Admin › Artwork › Settings, and run **Update changed titles**. Sending results to Plex stays off until you turn it on. Python is only for posters and title cards; Admin › Collections works without it.

## Engine tests

```sh
py -3 -m unittest discover -s apps/artwork/tests      # Windows
python3 -m unittest discover -s apps/artwork/tests    # Linux
```

Two parity tests are skipped.

## Speed

Measured on the Plex preview (read-only, so uploads are skipped and only their label checks count), 20 titles (16 movies, 4 shows with seasons and title cards: 54 images), 2 workers:

| | one process per job | batch process |
|---|---|---|
| push, all redrawn | 58.1 s | 30.8 s |
| push, all unchanged (`--changed-only`) | 23.7 s | 4.2 s |

Where a job's time went before: about 0.55 s loading Python and the engine, 0.4 s for the first Plex request (a new TLS connection to the server each time), then drawing: about 0.4 s for a 2000×3000 poster (0.07 s more to make its renderer) and 0.6 s for a 3200×1800 title card. Provider lookups and downloads were cached for these titles. The batch process removes the start-up, reuses the Plex connection (setup 0.45 → ~0.12 s) and the renderers.

Drawing must stay the same to the bit (render signatures stay valid and nothing is sent to Plex again). `dither_shade` now works a few rows at a time on the 8-bit picture instead of a full float32 copy (the same operations on every value, so the same result; about 10% faster for a poster, and 72 MB less memory). The rest of a render is Pillow's LANCZOS resizes and blurs, which can't change without changing pixels; Pillow-SIMD was left out for that reason (its resampling differs).

To check pixels after a drawing change, render every saved layout (the engine's `config.json`) and those in `defaults.json` over fixed pictures with the old and new engine and compare the pixels, and compare `render_signature` for the same layouts and a spread of titles; the changes above and below matched in all 650 pixel cases and 292 signatures.

## Retired settings

Settings no layout used were removed on 2026-11-18 (`RETIRED` in the engine, with the defaults they had): poster zoom and sideways shift, matte opacity and color, the radial vignette and vignette color, grain, the border, "center short logos", custom text position across, outline and shadow, the flow badge layout, badge gap, shrink-to-fit and art size, renamed badge labels, audience score tiers, the bottom gradient (and `gradients`), the show status badge, the streaming logo badge and all its settings, the status banner's border, letter spacing, outline and shadow, and per-service glow colors.

- Saved layouts that still hold them load as before: `make_style` sets them aside (and drops the retired badges), and `render_signature` puts them back into the recipe at the layout's own saved values (`Style.old`), so `0` stays `0` and every recorded signature stays valid. `defaults.json` keeps them for the same reason: the database was seeded from it.
- The Layout editor no longer shows them.

The engine's command line is only what tk.box runs: `--item`, `--changed-only`, `--remake`, `--refresh`, `--with-seasons`, `--with-episodes`, `--added`, `--worker` and `--batch`. `--title`/`--type`/`--year`, `--limit`, `--refetch`, `--season`/`--episode`, `--check`, `--poster`/`--logo` and `--import-posters` are gone, and with the last one PyYAML. Provider keys come only from the environment (the config's `api` is gone). The config's `items` and `overrides` stay: tk.box never writes them, but the engine tests feed titles and their artwork through them. The collections engine's tests are TypeScript: `npx tsx --test tests/collections.test.ts`.
